// components/tesla_core/include/tesla_core/tlb_store.h
// 密钥与会话的持久化抽象。
//
// 权威依据：探针 src/store/{credential-store,v3-session-store}.js —— 落盘哪些字段、
// 恢复时怎么判空，全按那两个文件来；本头文件里的 blob 布局是 C 侧自己的事（探针走
// uni storage 的 JSON，格式对不上也没法对上），但**字段集合与语义必须逐字一致**：
//   1) 共享密钥 K 永不落盘（v3-session-store.js:44「不落盘」），恢复出来的会话
//      一定 has_key == false，靠下一次握手现算；
//   2) counter 每个域各存一份、只增不减；键名/槽位一旦上线永不改名
//      （config/index.js:3-4：回退 counter = 当场制造 IV 洞 = 只能重新绑钥匙）；
//   3) 恢复时 ready 还要 && epoch 非空（v3-session-store.js:86）；
//   4) 只有 VCSEC=2 / INFOTAINMENT=3 建会话，BROADCAST 不建
//      （v3-session-store.js:31-35 的 storeKeyOf 对其它域抛错）。
//
// 本模块不碰 NVS / 文件系统 / FreeRTOS：所有读写都经调用方注入的
// tlb_store_backend_t，设备层用 nvs_flash 实现，主机测试用内存数组实现。
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "tesla_core/tlb_types.h"
#include "tesla_core/tlb_v3.h"

// blob 自描述版本号：改布局必须递增，且 decode 只认当前版本（旧档按损坏处理）。
#define TLB_STORE_VERSION 1u

// 槽位。会话槽位直接取 domain 值，密钥另占 1（BROADCAST=0 / VCSEC=2 / INFOTAINMENT=3
// 都跟它不撞），所以槽位名等同于「存储键名」，同样永不改名。
enum {
    TLB_STORE_SLOT_KEY = 1,
    TLB_STORE_SLOT_VCSEC = TLB_DOMAIN_VCSEC,
    TLB_STORE_SLOT_INFOTAINMENT = TLB_DOMAIN_INFOTAINMENT
};

// 单个槽位 blob 的上界（含 2 字节头 + 4 字节校验）。给后端缓冲用，别硬编码数字。
#define TLB_STORE_BLOB_MAX 160

typedef struct {
    void *ud;
    // 读出槽位内容：>0 实际长度，0 = 没有存档，<0 = 后端失败。
    // 长度大于 cap 时必须返回 <0（宁可判失败，也不能悄悄截断成一份坏档）。
    int (*read)(void *ud, uint32_t slot, uint8_t *out, size_t cap);
    // 整块写入：0 = 成功，其它 = 失败。
    int (*write)(void *ud, uint32_t slot, const uint8_t *blob, size_t len);
    int (*erase)(void *ud, uint32_t slot);
} tlb_store_backend_t;

// 对应探针 tesla_probe_key_v1 的 {priv, pub, vin}。
typedef struct {
    uint8_t priv[TLB_PRIV_LEN];
    uint8_t pub[TLB_PUB_LEN];
    bool has_pub; // 对应 raw.pub 为空串：能加载出私钥，但 hasKey() 仍为 false
    char vin[TLB_VIN_MAX]; // 必须在这 24 字节内有结尾；塞满算超长，encode 会拒
} tlb_store_key_t;

// 对应探针 v3ToDisk() 的字段集（setAt 只用于界面打点，本结构不带）。
// has_* 表达 JS 里的 null / undefined，语义见 tlb_v3_session_t 的同名字段。
typedef struct {
    uint32_t counter;
    uint8_t epoch[TLB_EPOCH_LEN];
    bool has_epoch;
    uint8_t vehicle_pub[TLB_PUB_LEN];
    bool has_pub;
    uint32_t clock_time;
    bool has_set_time;
    uint32_t set_time;
    bool has_anchor;
    int64_t anchor;
    bool ready;
} tlb_store_session_t;

typedef enum {
    TLB_STORE_OK = 0,        // 存档有效
    TLB_STORE_NONE = 1,      // 没有存档（首次运行 / 已被清除）
    TLB_STORE_CORRUPT = 2,   // 有存档但版本、长度、槽位或校验不符
    TLB_STORE_ERROR = 3,     // 后端读写失败
    TLB_STORE_BAD_SLOT = 4,  // 只有 VCSEC=2 / INFOTAINMENT=3 建会话
    TLB_STORE_INVALID = 5    // 记录本身不可持久化（例如 VIN 超长）：没有写盘
} tlb_store_status_t;

// ---------------------------------------------------------------- 编解码
// encode 返回写入的字节数，0 表示参数不合法或容量不足（绝不写出半截 blob）。
// decode 只在整块校验通过时才落笔，失败保持 *out 原样（探针靠 try/catch 兜住
// fromHex 抛错，这里用「长度 + 版本 + 槽位 + 校验和」四道判据替代）。
size_t tlb_store_encode_key(const tlb_store_key_t *k, uint8_t *blob, size_t cap);
bool tlb_store_decode_key(tlb_store_key_t *k, const uint8_t *blob, size_t len);
// 会话 blob 里带着 domain，两个域的档不能互相顶包（counter 各走各的，串了就回退）。
size_t tlb_store_encode_session(uint32_t domain, const tlb_store_session_t *r, uint8_t *blob,
                                size_t cap);
bool tlb_store_decode_session(uint32_t domain, tlb_store_session_t *r, const uint8_t *blob,
                              size_t len);

// ---------------------------------------------------------------- 会话记录 <-> 运行态
// 抽取要落盘的字段（等价 v3ToDisk 的输入侧）。
void tlb_store_from_v3(tlb_store_session_t *r, const tlb_v3_session_t *s);
// 把存档灌回运行态（等价 v3Session() 的读盘分支）：先整体复位，再叠加字段，
// 因此共享密钥一定为空、domain 由调用方自己管；ready 还要 && has_epoch。
void tlb_store_to_v3(const tlb_store_session_t *r, tlb_v3_session_t *s);

// ---------------------------------------------------------------- 后端读写
// 成功时 *out 是完整记录；其它返回值下 *out 内容不保证（调用方应自行复位）。
tlb_store_status_t tlb_store_load_key(const tlb_store_backend_t *b, tlb_store_key_t *k);
tlb_store_status_t tlb_store_save_key(const tlb_store_backend_t *b, const tlb_store_key_t *k);
tlb_store_status_t tlb_store_load_session(const tlb_store_backend_t *b, uint32_t domain,
                                          tlb_store_session_t *r);
tlb_store_status_t tlb_store_save_session(const tlb_store_backend_t *b, uint32_t domain,
                                          const tlb_store_session_t *r);
// 抹掉一个槽位；domain 走会话槽位校验。
tlb_store_status_t tlb_store_clear(const tlb_store_backend_t *b, uint32_t slot);
