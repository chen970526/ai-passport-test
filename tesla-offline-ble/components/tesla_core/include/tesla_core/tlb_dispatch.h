// components/tesla_core/include/tesla_core/tlb_dispatch.h
// 调度层：单帧判读 + 协议/应用终态 + session_info 握手 + 发一条 V3 请求的重发循环。
// 权威依据：探针 src/domain/{command-dispatcher,handshake-service}.js
//（其上游是官方 internal/dispatcher/{dispatcher,receiver}.go 与 pkg/vehicle/{vcsec,vehicle}.go）。
//
// 本文件里所有「返回给用户看的字符串」必须与探针逐字一致：现场是靠这些文案定位的。
// 只有纯日志行允许简化（见各函数注释里标了「偏离」的地方）。
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "tesla_core/tlb_msg.h"
#include "tesla_core/tlb_types.h"
#include "tesla_core/tlb_v3.h"

// vehicle.go DefaultFlags：只要「加密响应」这一位
#define TLB_REQUEST_FLAGS TLB_FLAGS_ENCRYPT_RESPONSE
// ble.go maxLatency：响应搭车的 session_info 只在这个窗口内才被采用
#define TLB_MAX_LATENCY_MS 4000LL
#define TLB_MAX_ATTEMPTS 3
#define TLB_DEFAULT_MAX_MS 20000LL
#define TLB_WHITELIST_MAX_MS 60000LL
#define TLB_FIRST_RESPONSE_MS 8000LL

// 文案缓冲：握手拒绝文案要整段带上 TAP_HINT（UTF-8 下约 370 字节），留足余量
#define TLB_TEXT_MAX 768
#define TLB_RESULT_TEXT_MAX 1536
#define TLB_FRAME_TEXT_MAX 384
#define TLB_DISPATCH_FRAME_MAX (TLB_FRAME_MAX + 2)
#define TLB_DISPATCH_TRACE_MAX 12

// 应用层摘要的种类（探针 summarizeVcsec 的 kind，'none' 在 C 里用不到的分支省略）
typedef enum {
    TLB_APP_EMPTY = 0,   // 空响应（车辆已受理，应用层没有任何字段）
    TLB_APP_REFUSED,     // 车辆拒绝返回响应体（协议层错误帧）
    TLB_APP_WHITELIST,   // commandStatus.whitelistOperationStatus
    TLB_APP_SIGNED,      // commandStatus.signedMessageStatus
    TLB_APP_COMMAND,     // commandStatus（只有 operationStatus）
    TLB_APP_ERROR,       // nominalError
    TLB_APP_STATUS,      // vehicleStatus
    TLB_APP_OTHER        // 未识别
} tlb_app_kind_t;

typedef enum {
    TLB_ACTION_PASS = 0,
    TLB_ACTION_BUSY,
    TLB_ACTION_RESYNC,
    TLB_ACTION_FAIL
} tlb_action_t;

// 这一帧为什么被判为「看不懂、丢掉继续等」（对齐官方 dispatcher.go:302-308）
typedef enum {
    TLB_SKIP_NONE = 0,
    TLB_SKIP_ADDR,    // 路由地址不是本次请求
    TLB_SKIP_UUID,    // request_uuid 不是本次请求
    TLB_SKIP_DOMAIN,  // 来自别的域
    TLB_SKIP_DECRYPT, // 响应解密失败
    TLB_SKIP_PARSE    // 应用层解析失败
} tlb_skip_t;

typedef enum {
    TLB_DONE_ALWAYS = 0, // 第一帧就算完（不传 done 的语义）
    TLB_DONE_COMMAND,    // RKE：没有 commandStatus 才算完
    TLB_DONE_WHITELIST   // 白名单操作：必须带 whitelistOperationStatus
} tlb_done_t;

// 协议层摘要的种类
typedef enum {
    TLB_PROTO_NONE = 0,
    TLB_PROTO_HS,     // 带 session_info
    TLB_PROTO_MESSAGE,
    TLB_PROTO_FAULT
} tlb_proto_kind_t;

typedef struct {
    tlb_app_kind_t kind;
    uint32_t status;
    uint32_t counter;
    bool has_counter;
    char text[TLB_TEXT_MAX];
} tlb_app_t;

// 设备层钩子：时间、休眠、收发、会话持久化都由外面给，核心不碰 FreeRTOS / NimBLE。
typedef struct {
    void *ud;
    int64_t (*now_ms)(void *ud);
    void (*sleep_ms)(void *ud, int64_t ms);
    bool (*connected)(void *ud); // false → 探针在这里抛「还没连上车辆，先按「扫描并连接」」
    bool (*has_key)(void *ud);   // 对应探针 hasKey()：本机是否已经有密钥对
    // 发一帧并等第一片响应：>0 收到帧体长度，0 超时无响应，<0 链路错误（探针 send 抛异常）
    // frame/out 都是「不含 2 字节长度前缀的帧体」，前缀由端口与 tlb_frame.c 负责
    int (*exchange)(void *ud, const uint8_t *frame, size_t frame_len, int64_t timeout_ms,
                    bool keep_queue, uint8_t *out, size_t cap);
    // 只收不发（同样是不带前缀的帧体）
    int (*receive)(void *ud, uint8_t *out, size_t cap, int64_t timeout_ms);
    // 会话落盘 / 作废通知（结构体本身由本模块就地改，这两个只负责持久化）
    void (*session_stored)(void *ud, uint32_t domain);
    void (*session_cleared)(void *ud, uint32_t domain);
    const uint8_t *signer_priv;      // 32 字节
    const uint8_t *signer_pub;       // 65 字节未压缩点
    size_t signer_pub_len;
    const char *(*mtu_note)(void *ud); // 可为 NULL；对应 mtuNote()
    tlb_log_fn log;                  // 可为 NULL
} tlb_dispatch_ops_t;

// 收发暂存：调用方持有（约 4KB），避免 8KB 任务栈上叠加局部大数组
typedef struct {
    uint8_t tx[TLB_DISPATCH_FRAME_MAX];
    uint8_t rx[TLB_DISPATCH_FRAME_MAX];
    uint8_t last_tx[TLB_DISPATCH_FRAME_MAX]; // 上一次上线的字节，用于核对「重发是否复用同一份」
    uint8_t clear[TLB_FRAME_MAX];            // 解密后的明文
} tlb_dispatch_scratch_t;

// 时间行为轨迹：金标准用它断言重试节奏（随机数不可桩化，只能断关系量）
typedef struct {
    int n_sleeps;
    int64_t sleeps[TLB_DISPATCH_TRACE_MAX];
    int n_receives;
    int64_t receives[TLB_DISPATCH_TRACE_MAX];
    int n_handshakes;
} tlb_trace_t;

typedef struct {
    const char *name;
    uint32_t domain;
    const char *vin;
    tlb_v3_session_t *session;
    const uint8_t *routing_address;
    const uint8_t *uuid;
    const uint8_t *request_id;
    size_t request_id_len;
    int64_t sent_at_ms;
    const tlb_dispatch_ops_t *ops;
} tlb_frame_ctx_t;

typedef struct {
    bool skipped;
    tlb_skip_t skip;
    bool refused;
    uint32_t fault;
    uint32_t op_status;
    tlb_vcsec_t obj;
    tlb_app_t app;
    char text[TLB_FRAME_TEXT_MAX]; // 应用层 inspect 文本（探针 r.text）
} tlb_frame_out_t;

typedef struct {
    bool ok;
    bool fatal;           // 确定性拒绝，重试没有意义
    bool not_whitelisted; // 钥匙不在白名单
    bool reused;
    char text[TLB_TEXT_MAX];
} tlb_handshake_result_t;

typedef struct {
    const char *name; // NULL = 'V3 请求'
    uint32_t domain;  // TLB_DOMAIN_VCSEC / TLB_DOMAIN_INFOTAINMENT
    const char *vin;
    bool plain;       // 明文请求（不需要会话）
    const uint8_t *payload;
    size_t payload_len;
    int64_t max_ms; // <=0 = TLB_DEFAULT_MAX_MS
    tlb_done_t done;
} tlb_request_t;

typedef struct {
    bool ok;
    bool timeout;
    uint32_t fault;
    int attempts;
    tlb_vcsec_t obj;
    tlb_app_t app;
    char text[TLB_RESULT_TEXT_MAX];
    char raw[TLB_FRAME_TEXT_MAX];
    // 关系量轨迹（金标准比对用）
    int n_sends;
    uint32_t send_counters[TLB_DISPATCH_TRACE_MAX];
    bool send_reuse[TLB_DISPATCH_TRACE_MAX]; // 本次上线字节与上一次完全相同
    int n_frames;
    int n_dropped;
    tlb_trace_t trace;
} tlb_request_result_t;

// ---------------------------------------------------------------- 文案渲染

// pb.js:inspect(V3_SPEC,'FromVCSECMessage',obj) —— 只覆盖 C 结构里留了字段的分支
//（vehicleStatus / whitelistInfo / whitelistEntryInfo 的内层字段本核心不解析，渲染成空对象）
void tlb_inspect_vcsec(const tlb_vcsec_t *obj, char *out, size_t cap);
// summary.js:summarize(rm)（协议层）
tlb_proto_kind_t tlb_summarize_rm(const tlb_rm_t *rm, char *out, size_t cap);
// summary.js:summarizeVcsec(obj)（应用层）
void tlb_summarize_vcsec(const tlb_vcsec_t *obj, tlb_app_t *out);

// ---------------------------------------------------------------- 单帧判读

// 探针 decodeFrame：三道路由闸门 → 协议层错误帧 → 解密 / 解析 → 应用层摘要。
// 副作用：命中 session_info 且满足官方三道闸时，顺手刷新会话（applyPiggyback）。
void tlb_decode_frame(const uint8_t *body, size_t body_len, const tlb_frame_ctx_t *ctx,
                      tlb_dispatch_scratch_t *sc, tlb_frame_out_t *out);

tlb_action_t tlb_proto_outcome(uint32_t fault, uint32_t op_status, char *text, size_t cap);
tlb_action_t tlb_app_outcome(const tlb_vcsec_t *obj, uint32_t domain, char *text, size_t cap);
bool tlb_done_check(tlb_done_t kind, const tlb_vcsec_t *obj);
// 车端 GenericError → 下一步提示（探针 genericErrorHint）
void tlb_generic_error_hint_text(const char *text, char *out, size_t cap);

// ---------------------------------------------------------------- 握手 / 发送

tlb_err_t tlb_handshake(bool force, uint32_t domain, const char *vin, tlb_v3_session_t *session,
                        const tlb_dispatch_ops_t *ops, tlb_dispatch_scratch_t *sc,
                        tlb_trace_t *trace, tlb_handshake_result_t *res);

// handshake-service.js:handshakeOnce —— 单次握手，不带 tlb_handshake 的「重试 + who 握手成功」包装。
// 探针的 probeOnce 直接调 handshakeOnce，文案里没有前缀，所以绑定层必须用这个入口。
// 成功：msg = 探针 applied.text；失败：msg = 探针那句 error 原文。
tlb_err_t tlb_handshake_once(const char *vin, tlb_v3_session_t *s, uint32_t domain,
                             const tlb_dispatch_ops_t *ops, tlb_dispatch_scratch_t *sc,
                             bool *fatal, bool *not_whitelisted, char *msg, size_t cap);

tlb_err_t tlb_send_request(const tlb_request_t *req, tlb_v3_session_t *session,
                           const tlb_dispatch_ops_t *ops, tlb_dispatch_scratch_t *sc,
                           tlb_request_result_t *res);
