// components/tesla_ble/include/tesla_ble/tlb_ble.h
// 设备层：NimBLE central 传输 + NVS 持久化 + mbedTLS P-256 + 命令编排。
//
// 权威依据：探针 src/infra/ble/{ble-transport,mtu-manager,device-matcher,gatt}.js、
// src/store/{credential-store,v3-session-store,bind-profile}.js、
// src/domain/{connection-service,auto-reconnect}.js、src/infra/crypto/p256.js。
//
// 分工：协议与判读文案全在 tesla_core（主机金标准锁死）；本层只负责
//   1) 把探针那些「只有真机才有」的动作（扫描/连接/订阅/协商 MTU/分包写入）做出来，
//      日志文案逐字照抄 ble-transport.js —— 现场就是靠这些行定位的；
//   2) 给 core 提供 tlb_dispatch_ops_t（收发、时间、休眠、连接态、会话持久化）；
//   3) 单 worker 任务串行消费命令，对应探针的单线程 JS：
//      写天然串行，同一时刻最多一个 waiter，不需要 core 之外的额外排队语义。
//
// 已知偏离（都是「平台根本没有这个东西」，不是行为差异）：
//   · deviceId：Android 是 MAC、iOS 是系统 UUID，设备侧只有对端 GAP 地址，
//     统一用 12 位大写冒号 MAC 字符串充当（探针只用它做等值比较和截断显示）。
//   · 报文控制台（connection.raw 环形）不移植：设备侧没有那个页面。
//   · uni 专有的错误文案（「当前运行环境没有蓝牙扫描能力」「setBLEMTU 不可用」里的
//     平台分支）换成设备侧等价说法，句式保留。
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#include "tesla_core/tlb_dispatch.h"
#include "tesla_core/tlb_identity.h"
#include "tesla_core/tlb_store.h"
#include "tesla_core/tlb_types.h"

// ---------------------------------------------------------------- 日志出口
//
// 探针的 log(kind, msg) 里 kind 只有 info/ok/warn/error 四类，TX/RX 是 ble-transport
// 自己发的收发流水（kind 仍走 info/ok），这里拆成六类只为了让设备侧能按颜色/前缀区分。
// core 的 tlb_log_fn 没有 kind，一律按 INFO 出（见 tlb_app.c 的适配函数）。
typedef enum {
    TLB_LOG_INFO = 0,
    TLB_LOG_OK,
    TLB_LOG_WARN,
    TLB_LOG_ERROR,
    TLB_LOG_TX,
    TLB_LOG_RX
} tlb_log_kind_t;

// 默认出口是 printf（USB-CDC console）。UI 要接管的话在 tlb_app_init 之前装自己的 sink。
typedef void (*tlb_ble_log_fn)(tlb_log_kind_t kind, const char *text, void *ud);
void tlb_ble_set_log_sink(tlb_ble_log_fn fn, void *ud);
void tlb_ble_log(tlb_log_kind_t kind, const char *text);

// ---------------------------------------------------------------- 蓝牙栈
// 起 NimBLE host（幂等，内部等 host sync，最多 5 秒）。扫描/连接都要求它先返回 ESP_OK。
esp_err_t tlb_ble_stack_start(void);

// ---------------------------------------------------------------- 设备与扫描
// 对应探针 discover()/scan() 返回的那条设备记录（{deviceId, name, rssi, tesla, hit, mode}）。
#define TLB_BLE_ID_MAX 20 // "AA:BB:CC:DD:EE:FF" + 结尾
typedef struct {
    bool valid;
    char id[TLB_BLE_ID_MAX]; // deviceId
    char name[TLB_ADV_NAME_MAX]; // 空串 = 无名广播
    uint8_t addr[6]; // NimBLE peer address（小端原始字节，连接时按 ble_addr_t 用）
    uint8_t addr_type;
    int8_t rssi;
    bool tesla; // 广播里带了 0211 服务
    char hit[TLB_ADV_NAME_MAX]; // 命中的规则原文（探针 d.hit），空串 = 没命中
    char mode[16]; // exact / prefix / loose / loose-prefix（探针 d.mode）
} tlb_ble_dev_t;

// 按 VIN 匹配扫描：命中第一条即返回（返回 1），超时未找到返回 0，链路/权限失败返回 -1
// 并写 err（探针在这条路径上只会 reject('当前运行环境没有蓝牙扫描能力')，这里对应栈未起）。
int tlb_ble_scan(const tlb_ble_names_t *names, int64_t timeout_ms, tlb_ble_dev_t *out, char *err,
                 size_t err_cap);

// 「全部广播」列表：返回条数（<=cap），names 可为 NULL（只做标记不过滤）。
// 排序照抄 device-matcher.js:sortAdv —— core 没有移植这一段，由本层自带。
int tlb_ble_discover(int64_t timeout_ms, const tlb_ble_names_t *names, tlb_ble_dev_t *list,
                     size_t cap, char *err, size_t err_cap);

// 按 MAC 直扫：形状与 tlb_ble_scan 一致（命中返回 1，超时返回 0，链路失败返回 -1），
// 但匹配判据换成「对端地址等于 mac」。mac 用与 deviceId 同一表示的冒号串
// （"AA:BB:CC:DD:EE:FF"，大小写不限），这样档案里的 deviceId 能直接传进来。
// 偏离：探针没有这条路（Android 的 deviceId 直连由系统负责扫描），设备侧必须自己
// 先把对端广播收进来才允许发起连接，所以这条是设备侧专有的一条匹配规则。
// addr_type 传 TLB_BLE_ADDR_TYPE_ANY 表示「地址类型不限」，命中后连接用的是广播里
// 实际收到的类型（车辆可能同时出现过公共/随机两种广播，写死一种会漏）。
#define TLB_BLE_ADDR_TYPE_ANY 0xFFu
int tlb_ble_scan_mac(const char *mac, uint8_t addr_type, int64_t timeout_ms, tlb_ble_dev_t *out,
                     char *err, size_t err_cap);

// 只有 deviceId、没有原始地址字节时用它构造设备记录（addr_type 由调用方给）。
// mac 非法（长度/字符不对）返回 false。
bool tlb_ble_dev_from_id(const char *device_id, uint8_t addr_type, tlb_ble_dev_t *out);

// ---------------------------------------------------------------- 连接生命周期
// connect() 全流程：连接 → 停扫 → delay(600) → 发现服务 → 订阅 0213 → 协商 MTU。
// 顺序是硬约束（规则 C「先订阅再谈 MTU」），任何重排都会让首帧响应丢掉。
bool tlb_ble_connect(const tlb_ble_dev_t *dev, char *err, size_t err_cap);
void tlb_ble_disconnect(void);
bool tlb_ble_connected(void);
int tlb_ble_mtu(void); // 当前生效 MTU（未连接 = 23）
void tlb_ble_current(tlb_ble_dev_t *out); // 当前/最后一次连上的设备
const char *tlb_ble_state(void); // idle / connecting / connected / disconnected

// 读 0214 协议版本（探针 readVersion）
bool tlb_ble_read_version(uint8_t *out, size_t cap, size_t *len, char *err, size_t err_cap);

// 帧体（不含 2 字节长度前缀）收发 —— core 的 exchange/receive 钩子最终落到这两个函数。
// 前缀由本层补，所以 TX 日志里的「发送 N 字节」含前缀，RX 日志里的「响应 N 字节」不含。
int tlb_ble_send(const uint8_t *frame, size_t len, int64_t timeout_ms, bool keep_queue,
                 uint8_t *out, size_t cap);
int tlb_ble_receive(uint8_t *out, size_t cap, int64_t timeout_ms);

// 连上之后共享密钥必须重算（K 只在本次连接有效）；core 的 session_cleared 走这里。
void tlb_ble_reset_rx(void);

// ---------------------------------------------------------------- 平台钩子
// mbedTLS P-256：对应探针 p256.js 的 newKeyPair（生成私钥 + 公钥）。
// 失败（随机数恰好是 n 的倍数、点乘出无穷远点）返回 false。
bool tlb_port_keygen(uint8_t priv[TLB_PRIV_LEN], uint8_t pub[TLB_PUB_LEN]);

// ---------------------------------------------------------------- NVS
esp_err_t tlb_nvs_init(void);
void tlb_nvs_backend(tlb_store_backend_t *out);

// 绑定档案（bind-profile.js）：deviceId/name/vin/keyId/boundAt/connectedAt
typedef struct {
    bool valid;
    char id[TLB_BLE_ID_MAX];
    char name[TLB_ADV_NAME_MAX];
    char vin[TLB_VIN_MAX];
    char key_id[48]; // 完整 40 位小写 hex（state.keyId = toHex(sha1(pub))），不是截断版
    int64_t bound_at;
    int64_t connected_at;
} tlb_profile_t;

bool tlb_nvs_profile_load(tlb_profile_t *out);
bool tlb_nvs_profile_save(const tlb_profile_t *p);
void tlb_nvs_profile_clear(void);
// 手输的 VIN 单独一格（config/index.js:VIN_STORE）：换车、清档案都不该把它弄丢。
bool tlb_nvs_vin_load(char *out, size_t cap);
bool tlb_nvs_vin_save(const char *vin);
void tlb_nvs_vin_clear(void);
// describeBind()：无档案时「无绑定档案」；hasBind = deviceId 或 keyId 至少有一个。
void tlb_nvs_profile_describe(const tlb_profile_t *p, char *out, size_t cap);

// ---------------------------------------------------------------- 应用编排
// 单 worker 任务 + 命令队列。tlb_app_init 之前不要求 BLE 栈已起（内部会等 host sync）。
esp_err_t tlb_app_init(void);
const tlb_dispatch_ops_t *tlb_app_ops(void);

// 状态行（describeAutoLoop + describeKey + describeBind 的设备侧合并版），给 UI 直接显示。
void tlb_app_status(char *out, size_t cap);
// 自动重连那一行（auto-reconnect.js:describeAutoLoop）
void tlb_app_auto_state(char *out, size_t cap);

// UI 快照：屏幕层（key_ui.c）每个心跳读一次，字段全是原子量，不加锁不阻塞。
// 引导列表一节例外（多字段结构体）：发布与拷贝两侧都进临界区，见 tlb_app.c。

// 首次绑定引导：扫描列表的一行。全量列出附近设备（改名车/怪名车也能手动选），
// 按探针 sortAdv 的档位排序：疑似特斯拉 → 有名 → 无名，同级 RSSI 强者优先。
typedef struct {
    char name[TLB_ADV_NAME_MAX]; // "Tesla ABC123" / "S…"哈希名 / 车主自定义名 / 空串=无名
    char id[TLB_BLE_ID_MAX];     // deviceId（无名广播时屏幕显示它的尾部）
    int8_t rssi;                 // 信号强度，越接近 0 越强
    bool tesla;                  // 疑似特斯拉（带 VCSEC 服务 UUID 或名字形状命中）→ 青色高亮
} tlb_onb_item_t;

#define TLB_ONB_LIST_MAX 5 // 引导页一屏最多 5 行（320px 高度预算，见 key_ui.c）
#define TLB_ONB_NOTE_MAX 64

// 引导阶段（tlb_app.c 状态机 → key_ui.c 渲染的映射）
typedef enum {
    TLB_ONB_SCAN = 0,    // 正在扫描（10 秒一轮）
    TLB_ONB_LIST,        // 列表就绪，等用户选车
    TLB_ONB_NOFOUND,     // 一轮没扫到车（2 秒后自动重扫）
    TLB_ONB_CONNECTING,  // 正在连接所选车辆
    TLB_ONB_PAIRING,     // 已发加钥匙请求，等车主刷 NFC 卡授权
    TLB_ONB_DONE,        // 绑定成功（停留约 2 秒后自动回首页）
    TLB_ONB_FAIL,        // 连接/绑定失败（onb_note 带原因，可重选/重扫）
} tlb_onb_stage_t;

typedef struct {
    bool connected;      // BLE 当前已连上车
    bool trying;         // 链路任务正在跑一轮扫描/连接
    int tries;           // 本轮前台生命周期内的尝试计数
    bool ever_connected; // 开机以来连上过没有（决定还显不显示开机动画）
    int32_t rke_action;  // 最近一次 RKE 动作号（-1 = 开机后没发过）
    bool rke_pending;    // 最近一次 RKE 还在等回执（区分「正在上锁…」与「发送失败」）
    bool rke_ok;         // 最近一次 RKE 是否被车端受理
    int64_t rke_at;      // 最近一次 RKE 状态置位时刻（UI 用它做回执停留窗口）
    bool has_status;     // 已拿到过 vehicleStatus（closure/lock 数据可用）
    uint8_t closure[8];  // ClosureState_E：前左 前右 后左 后右 后备箱 前备箱 充电口 卷盖板
    uint8_t lock_state;  // VehicleLockState_E：0=解锁 1=上锁
    // —— 首次绑定引导（无密钥或无绑定档案时自动进入，见 tlb_app.c）——
    bool onb_active;                        // 引导模式进行中（屏幕切到引导页）
    uint8_t onb_stage;                      // tlb_onb_stage_t
    uint8_t onb_count;                      // 本页行数（<=TLB_ONB_LIST_MAX）
    uint8_t onb_cursor;                     // 本页内光标行（翻页由 tlb_app_onb_move 负责）
    uint8_t onb_total;                      // 全部设备条数（可能大于一屏）
    uint8_t onb_page;                       // 当前页（0 起）
    uint8_t onb_pages;                      // 总页数
    int64_t onb_at;                         // 当前阶段置位时刻
    char onb_note[TLB_ONB_NOTE_MAX];        // 阶段附注（正在连接的名字 / 失败原因）
    tlb_onb_item_t onb_list[TLB_ONB_LIST_MAX];
    bool fac_reset;                         // 组合键出厂重置进行中（屏幕显示重置提示直到重启）
} tlb_app_ui_t;
void tlb_app_ui_snapshot(tlb_app_ui_t *out);

typedef enum {
    TLB_CMD_SCAN_LIST = 0, // 「全部广播」列表 + 逐条打印
    TLB_CMD_CONNECT_VIN,   // 按 VIN 匹配扫描并连接
    TLB_CMD_CONNECT_AUTO,  // 自动重连一轮（档案 deviceId 直连 → 扫描挑一条）
    TLB_CMD_LOOP_START,    // 启动轮询循环（车钥匙形态：固定约 2 秒一轮）
    TLB_CMD_LOOP_STOP,     // 停止轮询循环（不暂停）
    TLB_CMD_RESUME,        // 取消「用户主动断开」的暂停标记
    TLB_CMD_DISCONNECT,    // 主动断开 + 暂停自动重连
    TLB_CMD_HANDSHAKE,     // 两个域各握手一次
    TLB_CMD_RKE,           // 上锁（payload 由参数给 action）
    TLB_CMD_LID,           // 开后备箱（arg：0=前备箱 1=后备箱，closureMoveRequest）
    TLB_CMD_STATUS_QUERY,  // 查询车辆状态（InformationRequest GET_STATUS → vehicleStatus 快照）
    TLB_CMD_BIND,          // 刷卡配对（裸 PRESENT_KEY + 探针交替）
    TLB_CMD_PROBE,         // 只做会话探针确认
    TLB_CMD_VERSION,       // 读 0214
    TLB_CMD_STATUS,        // 打印状态
    TLB_CMD_FORGET,        // 清除本机密钥 / 会话 / 档案
    TLB_CMD_ONB_SELECT,    // 引导模式：连接光标所指车辆并自动发起绑定
    TLB_CMD_ONB_RESCAN,    // 引导模式：立刻重扫一轮
    TLB_CMD_FACTORY_RESET  // 组合键出厂重置：清密钥/会话/档案/VIN 后重启进引导
} tlb_cmd_t;

// 按键与控制台都走这一个入口：只入队，绝不在回调里做 BLE 动作。
void tlb_app_post(tlb_cmd_t cmd, int32_t arg);
void tlb_app_post_vin(const char *vin);
// 首次绑定引导：模式开关查询（app_main 按键分流用）与列表光标移动（任意任务可调）。
bool tlb_app_onboarding(void);
void tlb_app_onb_move(int delta);
