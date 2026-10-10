// application/main/tlb_app.c
// 探针 store/domain 层的设备端移植：单 worker 任务 + 命令队列 + 自动重连链路任务。
//
// 权威依据（tesla-ble-probe）：
//   src/store/{credential-store,v3-session-store,bind-profile}.js
//   src/domain/{connection-service,auto-reconnect,session-status}.js
//   src/domain/{handshake-service,enrollment-service}.js、src/services/{credential-service,vcsec/rke}.js
// 中文日志文案逐字复现；确有偏离的地方都在对应行注释里标了「偏离」。
//
// 分工：协议判读全在 tesla_core（tlb_dispatch / tlb_bind），本层只负责
//   1) 把 core 的返回文本按探针「调用方侧」的日志形状打出来
//      （V3 会话已就绪：/ 结果 OK·ERROR 行 / 自动重连那一整套）；
//   2) 密钥、会话、绑定档案的落盘与恢复（探针 store 层的等价物）；
//   3) 自动重连轮询循环 —— 车钥匙形态下固定 2 秒一轮（电量优先，不再退避升档），
//      对应 auto-reconnect.js 定时器群的等价物。
//
// 已知偏离（都是设备形态差异，不是行为差异）：
//   · 无绑定档案时按内置目标车辆播种（MAC/VIN 硬编码）—— 裸机没有手输 VIN 的界面。
//   · 「命令队列已满」提示为设备侧专有（JS 单线程不存在这个状态）。
//   · 存储损坏文案后半句用「存档版本或校验不符」替代 JS 异常 message。
//   · forgetBindProfile 的 clearVehicle 不移植（没有 vehicle-store 这一层）；
//     设备版清除档案时顺带清两个域的会话槽位。
//   · 探针 permission / adapter 两个 skip 分支不移植（设备侧没有那两个概念）。

#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/queue.h"

#include "esp_err.h"
#include "esp_system.h" // esp_restart（出厂重置）

#include "tesla_ble/tlb_ble.h"
#include "vin_cfg.h" // 无 VIN 时的「接入点 + 内网网页」配网通道

#include "tesla_core/tlb_bind.h"
#include "tesla_core/tlb_dispatch.h"
#include "tesla_core/tlb_identity.h"
#include "tesla_core/tlb_msg.h"
#include "tesla_core/tlb_sha.h"
#include "tesla_core/tlb_store.h"
#include "tesla_core/tlb_text.h"
#include "tesla_core/tlb_types.h"
#include "tesla_core/tlb_v3.h"

// ---------------------------------------------------------------- 节奏
// 不再内置「目标车辆」常量：真机验证过的车与早期写死的 MAC/地址类型都不符，
// 按常量播种档案会把别辆车的身份写进 NVS。身份一律来自 NVS（档案 + 手输 VIN）。
#define TLB_SCAN_TIMEOUT_MS 20000LL // config/index.js:SCAN_TIMEOUT_MS（手动 scan 命令仍用长窗口）
// 车钥匙形态：轮询节奏由用户定为「约 2 秒一次」。扫描窗口跟着缩到 2 秒 ——
// 保持 10 秒窗口的话一轮尝试就要 20 秒，2 秒重试间隔形同虚设，且休眠期蓝牙几乎常开更费电。
// 实车实测开机 0.3 秒就按 MAC 命中广播，2 秒窗口足够。
#define TLB_AUTO_SCAN_MS 2000LL     // 自动轮询每轮的两个扫描窗口（定向 + 全量）
#define TLB_RETRY_DELAY_MS 2000LL   // 一轮没连上之后固定再等 2 秒（替代退避升档）
#define TLB_APP_ADV_MAX 24          // 一轮扫描最多记 24 条（notfound 文案只用前 8 条）
#define TLB_APP_CMD_Q_LEN 16

// ---------------------------------------------------------------- 字符串拼接器
// 探针里全是 JS 的 + 拼接；C 侧用这个保证「句式逐字一致」而不用手写一串 strcat。
typedef struct {
    char *b;
    size_t cap;
    size_t n;
} tlb_sb_t;

static void sb_init(tlb_sb_t *sb, char *buf, size_t cap)
{
    sb->b = buf;
    sb->cap = cap;
    sb->n = 0;
    if (cap > 0) {
        buf[0] = '\0';
    }
}

static void sb_puts(tlb_sb_t *sb, const char *s)
{
    if (!s || sb->cap == 0) {
        return;
    }
    size_t room = (sb->n + 1 < sb->cap) ? sb->cap - sb->n - 1 : 0;
    size_t len = strlen(s);
    size_t take = (len < room) ? len : room;
    memcpy(sb->b + sb->n, s, take);
    sb->n += take;
    sb->b[sb->n] = '\0';
}

static void sb_printf(tlb_sb_t *sb, const char *fmt, ...)
{
    char tmp[256];
    va_list ap;
    va_start(ap, fmt);
    int w = vsnprintf(tmp, sizeof(tmp), fmt, ap);
    va_end(ap);
    if (w > 0) {
        sb_puts(sb, tmp);
    }
}

static void sb_log(tlb_log_kind_t kind, const tlb_sb_t *sb) { tlb_ble_log(kind, sb->b); }

// ---------------------------------------------------------------- 状态
static tlb_store_backend_t s_backend;
static tlb_store_key_t s_key;         // 对应 state.privateKey/publicKey（hex 解码后的字节形）
static bool s_have_key;               // 对应 state.keyId 是否可算：加载出来 ≠ hasKey（还看 has_pub）
static tlb_v3_session_t s_sess[2];    // [0]=VCSEC(2) [1]=INFOTAINMENT(3) —— 对应 state.v3 的两份
static tlb_dispatch_ops_t s_ops;      // 注入给 core 的设备钩子
static tlb_dispatch_scratch_t s_scratch; // 约 4KB，绝不上任务栈
static char s_vin[TLB_VIN_MAX];       // 对应 state.vin（手输 / 档案回灌）
static bool s_cfg_mode;               // 纯配网模式：蓝牙栈/worker/link 全没起，只有热点
static tlb_profile_t s_profile;       // 对应 bind-profile.js 的 bind 对象
static SemaphoreHandle_t s_state_mtx;

// —— 首次绑定引导（社区版自助开箱：全程不输 VIN）——
// 无密钥或无绑定档案时自动进入：10 秒一轮全量扫描（带 0211 服务或广播名以
// "Tesla " 开头即收）→ 屏幕 5 行列表手选 → 连接（新固件车广播名 "Tesla XXXXXX"
// 直接得到 VIN 后 6 位；哈希名/改名车用占位 VIN 过绑定守卫，VCSEC 会话按公钥
// 走不受影响，档案 VIN 留空、回连按 MAC）→ 自动发加钥匙请求 → 车主刷 NFC 卡
// 授权 → 落盘档案回首页。屏幕渲染在 key_ui.c，数据走 tlb_app_ui_snapshot。
#define TLB_ONB_SCAN_MS 10000LL // 引导扫描单轮窗口（坐车内 10 秒足够收齐周边广播）
static portMUX_TYPE s_onb_mux = portMUX_INITIALIZER_UNLOCKED;
static struct {
    uint8_t stage; // tlb_onb_stage_t
    uint8_t count; // 本页行数
    uint8_t cursor; // 本页内光标行
    uint8_t total;  // 全部条数
    uint8_t page;   // 当前页（0 起）
    uint8_t pages;  // 总页数
    int64_t at;
    char note[TLB_ONB_NOTE_MAX];
    tlb_onb_item_t list[TLB_ONB_LIST_MAX];
} s_onb_pub;                      // worker 写 / LVGL 读，整块拷贝时进临界区
static bool s_onb_active;         // 引导模式总开关（绑定成功后 worker 延时关闭）
static volatile bool s_onb_confirm; // 引导页 PAIRING 中右三「我已确认」，绑定循环消费
static volatile int s_onb_cursor; // 光标真值（按键任务写，worker 读）
static tlb_ble_dev_t s_onb_raw[TLB_APP_ADV_MAX]; // 引导扫描原始记录仓（worker 专用，
                                                 // SELECT 连接时要用原始地址字节）
static tlb_onb_item_t s_onb_items[TLB_APP_ADV_MAX]; // 排序后的全量条目（worker 读写；
                                                 // 按键任务只动 s_onb_cursor 这个 int）
static int s_onb_raw_idx[TLB_APP_ADV_MAX];       // 条目 m ← 原始记录 s_onb_raw[idx[m]]
static int s_onb_n;                              // 条目总数（一屏装不下靠翻页）
// 重扫确认弹窗（右一长按，防误触）：worker 单任务读写，无需加锁；
// 取消时按 s_ask_prev/s_ask_prev_note 恢复原阶段（FAIL 的失败原因不能丢——
// onb_publish 传 NULL 会把快照 note 清空）。
static bool s_rescan_ask;
static uint8_t s_ask_prev;
static char s_ask_prev_note[TLB_ONB_NOTE_MAX];

// core 调用的结果对象：worker 串行使用，静态分配防栈溢出
static tlb_handshake_result_t s_hr;
static tlb_request_result_t s_rr;
static tlb_bind_result_t s_br;

// ---------------------------------------------------------------- 并发原语
typedef struct {
    tlb_cmd_t cmd;
    int32_t arg;
    char vin[TLB_VIN_MAX]; // 入队时快照 state.vin，对应 JS 闭包捕获
} cmd_msg_t;

static QueueHandle_t s_cmd_q;
static SemaphoreHandle_t s_link_wake; // 计数信号量：唤醒链路任务立刻跑一轮

// 自动重连循环状态 —— auto-reconnect.js 的 loopWanted/loopTimer/loopNextAt/loopRun/
// loopTries 与 autoSuspended。C 里 loopTimer 退化成「next_at 是否非零」。
// loopStep（退避档位）在车钥匙形态下没有意义：间隔恒为 TLB_RETRY_DELAY_MS，已删。
static volatile bool s_loop_wanted;
static volatile bool s_auto_suspended;
static volatile int s_loop_tries;
static volatile int64_t s_loop_next_at;
static volatile bool s_link_run; // 单飞：同一时刻最多一轮尝试
static volatile bool s_link_due; // 「立刻试一次」的请求位

// UI 快照（key_ui.c 每个心跳轮询）：屏幕只读这几个量，不碰任何 BLE 状态机。
static volatile bool s_ever_connected;   // 开机以来是否连上过（决定还显不显开机动画）
static volatile int32_t s_rke_action = -1; // 最近一次 RKE 动作号，-1 = 开机后没发过
static volatile bool s_rke_pending;      // 发出后还没拿到回执
static volatile bool s_rke_ok;           // 最近一次 RKE 是否被车端受理
static volatile int64_t s_rke_at;        // 最近一次 RKE 置位时刻（UI 用它做 3 秒回执窗口）
static volatile bool s_has_status;       // 收到过 vehicleStatus（屏幕画车态的前提）
static volatile uint8_t s_closure[8];    // ClosureState_E ×8（前左…卷盖板）
static volatile uint8_t s_lock_state;    // VehicleLockState_E：0=解锁 1=上锁
static volatile bool s_fac_reset;        // 出厂重置进行中（UI 显示重置提示直到重启）

// 把一帧 FromVCSECMessage 里的 vehicleStatus 刷进 UI 快照。
// 只有 closureStatuses 在才算「状态可用」；vehicleLockState 缺失按解锁（proto3 省略 0）。
static void apply_vehicle_status(const tlb_vcsec_t *v)
{
    if (!v->has_vehicle_status || !v->has_closure_status) {
        return;
    }
    for (int i = 0; i < 8; i++) {
        s_closure[i] = v->closure_state[i];
    }
    s_lock_state = v->has_vehicle_lock_state ? (uint8_t)v->vehicle_lock_state : 0;
    s_has_status = true;
}

static void lock_state(void) { xSemaphoreTake(s_state_mtx, portMAX_DELAY); }
static void unlock_state(void) { xSemaphoreGive(s_state_mtx); }

static int sess_idx(uint32_t domain)
{
    if (domain == TLB_DOMAIN_VCSEC) {
        return 0;
    }
    if (domain == TLB_DOMAIN_INFOTAINMENT) {
        return 1;
    }
    return -1;
}

// v3-session-store.js:domainLabel —— 注意不是 tlb_domain_text()
static const char *domain_label(uint32_t domain)
{
    return domain == TLB_DOMAIN_INFOTAINMENT ? "车机" : "VCSEC";
}

// credential-store.js:hasKey() —— 私钥和公钥都在才算
static bool op_has_key(void *ud);
// 探针 state.vin 的回退链：手输优先，其次档案
static const char *active_vin(void) { return s_vin[0] ? s_vin : s_profile.vin; }

// ---------------------------------------------------------------- 设备钩子（core 用）
static int64_t op_now_ms(void *ud)
{
    (void)ud;
    return tlb_port_now_ms();
}

static void op_sleep_ms(void *ud, int64_t ms)
{
    (void)ud;
    if (ms <= 0) {
        return;
    }
    vTaskDelay(xTaskCatchUpTicks(pdMS_TO_TICKS((uint32_t)ms)));
}

static bool op_connected(void *ud)
{
    (void)ud;
    return tlb_ble_connected();
}

static bool op_has_key(void *ud)
{
    (void)ud;
    return s_have_key && s_key.has_pub;
}

static int op_exchange(void *ud, const uint8_t *frame, size_t frame_len, int64_t timeout_ms,
                       bool keep_queue, uint8_t *out, size_t cap)
{
    (void)ud;
    return tlb_ble_send(frame, frame_len, timeout_ms, keep_queue, out, cap);
}

static int op_receive(void *ud, uint8_t *out, size_t cap, int64_t timeout_ms)
{
    (void)ud;
    return tlb_ble_receive(out, cap, timeout_ms);
}

static void store_session(uint32_t domain);
static void invalidate_one(uint32_t domain, const char *why);

// v3-session-store.js:storeV3Session —— 静默落盘，探针没有日志
static void op_session_stored(void *ud, uint32_t domain)
{
    (void)ud;
    store_session(domain);
}

// core 在作废共享密钥后回调。此刻 has_key 已被 core 置 false，
// invalidate_one 天然不会重复打「共享密钥已作废」行。
static void op_session_cleared(void *ud, uint32_t domain)
{
    (void)ud;
    invalidate_one(domain, NULL);
}

// response-hints.js:mtuNote —— 「（当前 MTU=xxx）」，拿不到就空串。
// 只有 worker 任务经 core 路径取用，静态缓冲安全。
static const char *op_mtu_note(void *ud)
{
    (void)ud;
    static char buf[48];
    int mtu = tlb_ble_mtu();
    if (mtu <= 0) {
        buf[0] = '\0';
    } else {
        snprintf(buf, sizeof(buf), "（当前 MTU=%d）", mtu);
    }
    return buf;
}

static void op_log(void *ud, const char *text)
{
    (void)ud;
    tlb_ble_log(TLB_LOG_INFO, text);
}

// 有可用密钥时才把签名材料挂进 ops，防 tlb_tesla_key_id 打出假的 00:00:00:00
static void sync_signer_ops(void)
{
    if (s_have_key && s_key.has_pub) {
        s_ops.signer_priv = s_key.priv;
        s_ops.signer_pub = s_key.pub;
        s_ops.signer_pub_len = TLB_PUB_LEN;
    } else {
        s_ops.signer_priv = NULL;
        s_ops.signer_pub = NULL;
        s_ops.signer_pub_len = 0;
    }
}

// ---------------------------------------------------------------- 会话 / 密钥 / 档案
// v3-session-store.js:storeV3Session
static void store_session(uint32_t domain)
{
    int idx = sess_idx(domain);
    if (idx < 0) {
        return;
    }
    lock_state();
    tlb_store_session_t rec;
    tlb_store_from_v3(&rec, &s_sess[idx]);
    tlb_store_save_session(&s_backend, domain, &rec);
    unlock_state();
}

// v3-session-store.js:invalidateV3Session —— 只有原本有共享密钥才打这一行
static void invalidate_one(uint32_t domain, const char *why)
{
    int idx = sess_idx(domain);
    if (idx < 0) {
        return;
    }
    lock_state();
    if (s_sess[idx].has_key) {
        char msg[TLB_TEXT_MAX + 64];
        tlb_sb_t sb;
        sb_init(&sb, msg, sizeof(msg));
        sb_puts(&sb, domain_label(domain));
        sb_puts(&sb, " 共享密钥已作废");
        if (why && why[0]) {
            sb_puts(&sb, "（");
            sb_puts(&sb, why);
            sb_puts(&sb, "）");
        }
        sb_log(TLB_LOG_INFO, &sb);
    }
    s_sess[idx].has_key = false; // tlb_v3_session_t 用 has_key 表达 JS 的 s.key
    s_sess[idx].ready = false;
    unlock_state();
}

static void invalidate_all(const char *why)
{
    invalidate_one(TLB_DOMAIN_VCSEC, why);
    invalidate_one(TLB_DOMAIN_INFOTAINMENT, why);
}

// credential-store.js:state.keyId = toHex(sha1(pub)) —— 40 位小写
static void my_key_id(char *out, size_t cap)
{
    out[0] = '\0';
    if (!(s_have_key && s_key.has_pub)) {
        return;
    }
    uint8_t h[20];
    tlb_sha1(s_key.pub, TLB_PUB_LEN, h);
    for (size_t i = 0; i < 20 && 2 * i + 3 <= cap; i++) {
        snprintf(out + 2 * i, 3, "%02x", h[i]);
    }
}

// credential-store.js:ensureKey —— 返回是否「这次新建」（调用方决定要不要补那行 info）
static bool ensure_key(const char *vin)
{
    if (op_has_key(NULL)) {
        return false;
    }
    uint8_t priv[TLB_PRIV_LEN], pub[TLB_PUB_LEN];
    if (!tlb_port_keygen(priv, pub)) {
        // 偏离：探针这里抛的是 JS 异常文本，设备侧换成 mbedTLS 语境
        tlb_ble_log(TLB_LOG_ERROR, "P-256 密钥对生成失败（随机源或 mbedTLS 异常）");
        return false;
    }
    lock_state();
    memset(&s_key, 0, sizeof(s_key));
    memcpy(s_key.priv, priv, sizeof(priv));
    memcpy(s_key.pub, pub, sizeof(pub));
    s_key.has_pub = true;
    if (vin) {
        snprintf(s_key.vin, sizeof(s_key.vin), "%s", vin);
    }
    s_have_key = true;
    tlb_store_save_key(&s_backend, &s_key);
    unlock_state();
    sync_signer_ops();

    char id[48];
    my_key_id(id, sizeof(id));
    char msg[128];
    tlb_sb_t sb;
    sb_init(&sb, msg, sizeof(msg));
    sb_puts(&sb, "私钥已保存到本机存储（明文沙箱，仅限探针） keyId=");
    sb_puts(&sb, id);
    sb_log(TLB_LOG_OK, &sb);
    return true;
}

// credential-store.js:loadKey
static void load_key(void)
{
    tlb_store_status_t st = tlb_store_load_key(&s_backend, &s_key);
    if (st == TLB_STORE_OK) {
        s_have_key = true;
        char id[48];
        my_key_id(id, sizeof(id));
        char msg[128];
        tlb_sb_t sb;
        sb_init(&sb, msg, sizeof(msg));
        sb_puts(&sb, "已加载本机密钥 keyId=");
        sb_puts(&sb, s_key.has_pub ? id : ""); // 探针：pub 缺失时 keyId 为空串
        sb_log(TLB_LOG_INFO, &sb);
        return;
    }
    memset(&s_key, 0, sizeof(s_key));
    s_have_key = false;
    if (st == TLB_STORE_CORRUPT) {
        // 偏离：' 会话存储损坏: ' 的 message 部分换成设备侧判据
        tlb_ble_log(TLB_LOG_ERROR, "密钥存储损坏: 存档版本或校验不符");
    }
    // NONE / ERROR：首次运行或后端故障，探针同样静默
}

// v3-session-store.js:v3Session 的读盘分支（探针是懒加载，设备侧开机一次灌满）
static void load_sessions(void)
{
    static const uint32_t doms[2] = {TLB_DOMAIN_VCSEC, TLB_DOMAIN_INFOTAINMENT};
    for (size_t i = 0; i < 2; i++) {
        uint32_t d = doms[i];
        int idx = sess_idx(d);
        tlb_store_session_t rec;
        tlb_store_status_t st = tlb_store_load_session(&s_backend, d, &rec);
        if (st == TLB_STORE_OK) {
            tlb_store_to_v3(&rec, &s_sess[idx]); // 内部已 ready && has_epoch
            if (rec.counter > 0) {
                char msg[192];
                tlb_sb_t sb;
                sb_init(&sb, msg, sizeof(msg));
                sb_printf(&sb, "已恢复 %s 会话 counter=%u", domain_label(d), (unsigned)rec.counter);
                sb_puts(&sb, s_sess[idx].ready ? "（可复用，握手失败时再刷新）" : "（尚未握手）");
                sb_log(TLB_LOG_INFO, &sb);
            }
        } else {
            tlb_v3_session_reset(&s_sess[idx]);
            if (st == TLB_STORE_CORRUPT) {
                char msg[192];
                tlb_sb_t sb;
                sb_init(&sb, msg, sizeof(msg));
                sb_printf(&sb, "%s 会话存储损坏: 存档版本或校验不符", domain_label(d));
                sb_log(TLB_LOG_ERROR, &sb);
            }
        }
    }
}

// bind-profile.js:hasBind
static bool has_bind(void) { return s_profile.id[0] != '\0' || s_profile.key_id[0] != '\0'; }

// bind-profile.js:saveBind —— patch 语义（空字段保留原值）由 tlb_nvs_store.c 的 copy_patch 保证
static void save_bind(const tlb_profile_t *patch)
{
    lock_state();
    tlb_nvs_profile_save(patch);
    tlb_nvs_profile_load(&s_profile); // 回灌，保持内存与落盘一致
    unlock_state();
}

// bind-profile.js:markBound
static void mark_bound(void)
{
    char id[48];
    my_key_id(id, sizeof(id));
    tlb_profile_t patch;
    memset(&patch, 0, sizeof(patch));
    snprintf(patch.key_id, sizeof(patch.key_id), "%s", id);
    const char *vin = active_vin();
    if (vin) {
        snprintf(patch.vin, sizeof(patch.vin), "%s", vin);
    }
    patch.bound_at = tlb_port_now_ms();
    save_bind(&patch);
    char msg[128];
    tlb_sb_t sb;
    sb_init(&sb, msg, sizeof(msg));
    sb_puts(&sb, "绑定档案已更新：这台车已登记本机钥匙 keyId=");
    sb_puts(&sb, id); // 完整 40 位（探针 markBound 用的就是全量 state.keyId）
    sb_log(TLB_LOG_OK, &sb);
}

// bind-profile.js:describeBind
static void describe_bind(tlb_sb_t *sb)
{
    char buf[512];
    tlb_nvs_profile_describe(&s_profile, buf, sizeof(buf));
    sb_puts(sb, buf);
}

// bind-profile.js:loadBind + 设备侧播种
static void load_profile(void)
{
    memset(&s_profile, 0, sizeof(s_profile));
    bool loaded = tlb_nvs_profile_load(&s_profile);
    if (loaded && has_bind()) {
        if (!s_vin[0] && s_profile.vin[0]) {
            snprintf(s_vin, sizeof(s_vin), "%s", s_profile.vin); // 探针：bind.vin 回灌 state.vin
        }
        char msg[640];
        tlb_sb_t sb;
        sb_init(&sb, msg, sizeof(msg));
        sb_puts(&sb, "已加载绑定档案：");
        describe_bind(&sb);
        sb_log(TLB_LOG_INFO, &sb);
        return;
    }
    // 没有档案：只把 NVS 里手输过的 VIN 灌回内存，绝不播种一份「内置目标车」的假身份
    // （旧做法会把别辆车的 MAC/VIN 写进 NVS，污染 active_vin() 与广播名匹配）。
    if (!s_vin[0]) {
        tlb_nvs_vin_load(s_vin, sizeof(s_vin));
    }
    char msg[640];
    tlb_sb_t sb;
    sb_init(&sb, msg, sizeof(msg));
    sb_puts(&sb, "未找到绑定档案");
    if (s_vin[0]) {
        sb_puts(&sb, "，本机记录的 VIN=");
        sb_puts(&sb, s_vin);
        sb_puts(&sb, "；在引导页选车即可绑定");
    } else {
        sb_puts(&sb, "，本机还没有 VIN；连热点 AI-PASSPORT-TSL，在配网页输入 VIN");
    }
    sb_log(TLB_LOG_INFO, &sb);
}

// ---------------------------------------------------------------- 连接编排
// connection-service.js:connectTo 的「连上之后」部分：
// invalidateAll → onConnected 钩子 → saveBind（不带 keyId/boundAt，那是 markBound 的活）
static bool connect_and_record(const char *vin, const tlb_ble_dev_t *dev, char *err, size_t err_cap)
{
    if (!tlb_ble_connect(dev, err, err_cap)) {
        return false;
    }
    invalidate_all("换了连接，共享密钥随本次会话失效");
    // hooks.onConnected：连上 = 用户就在车边，暂停标记与尝试计数一起清零
    s_auto_suspended = false;
    s_loop_tries = 0;
    s_ever_connected = true; // UI：开机动画到此结束

    tlb_profile_t patch;
    memset(&patch, 0, sizeof(patch));
    const char *v = (vin && vin[0]) ? vin : active_vin(); // vin || state.vin || bind.vin || ''
    if (v) {
        snprintf(patch.vin, sizeof(patch.vin), "%s", v);
    }
    snprintf(patch.id, sizeof(patch.id), "%s", dev->id);
    snprintf(patch.name, sizeof(patch.name), "%s", dev->name);
    patch.connected_at = tlb_port_now_ms();
    save_bind(&patch);
    // 连上 = 连接边沿：排一条状态查询，屏幕的俯视车形尽早拿到第一帧 vehicleStatus
    tlb_app_post(TLB_CMD_STATUS_QUERY, 0);
    return true;
}

// ---------------------------------------------------------------- 自动重连一轮
typedef struct {
    bool ok;
    char skipped[12];
    char text[768];
} auto_res_t;

static void auto_skip(auto_res_t *res, const char *reason, const char *text)
{
    res->ok = false;
    snprintf(res->skipped, sizeof(res->skipped), "%s", reason);
    snprintf(res->text, sizeof(res->text), "%s", text);
}

// auto-reconnect.js:doAutoReconnect —— 文案逐字
static void auto_once(auto_res_t *res)
{
    memset(res, 0, sizeof(*res));
    if (s_onb_active) {
        auto_skip(res, "onb", "首次绑定引导进行中，自动重连挂起");
        return;
    }
    if (!op_has_key(NULL)) {
        auto_skip(res, "nokey", "本机还没有密钥，先走「③ 绑定（刷钥匙卡）」");
        return;
    }
    if (!has_bind()) {
        auto_skip(res, "nobind", "还没有绑定档案，先「② 扫描并连接（手选）」连一次");
        return;
    }
    if (s_auto_suspended) {
        auto_skip(res, "suspended", "你刚才主动断开过，已暂停自动重连（点「恢复自动重连」或手动连接一次即可恢复）");
        return;
    }
    if (tlb_ble_connected()) {
        auto_skip(res, "already", "已经连在车上了");
        return;
    }

    char msg[768];
    tlb_sb_t sb;
    sb_init(&sb, msg, sizeof(msg));
    sb_puts(&sb, "自动重连：");
    describe_bind(&sb);
    sb_log(TLB_LOG_INFO, &sb);

    // 探针：const vin = bind.vin || state.vin
    const char *vin = s_profile.vin[0] ? s_profile.vin : s_vin;
    char err[160];

    // 1. 先按档案里的 deviceId 直连（设备侧 = 先扫该 MAC 再连）
    // 地址类型不能写死：真机实测本车广播用的是公共地址（type=0），
    // 早期固定按 type=1 过滤导致这条定向扫描永不命中，每轮都白等一次再退回全量扫描。
    if (s_profile.id[0]) {
        tlb_ble_dev_t dev;
        int rc = tlb_ble_scan_mac(s_profile.id, TLB_BLE_ADDR_TYPE_ANY, TLB_AUTO_SCAN_MS, &dev, err,
                                  sizeof(err));
        bool connected = false;
        bool failed = false;
        if (rc == 1) {
            connected = connect_and_record(vin, &dev, err, sizeof(err));
            failed = !connected;
        } else if (rc == -1) {
            failed = true;
        }
        if (connected) {
            // 探针 L97：这条成功路径不打 ok 行，只把 text 交回去
            res->ok = true;
            sb_init(&sb, res->text, sizeof(res->text));
            sb_puts(&sb, "自动连接成功（deviceId 直连）：");
            sb_puts(&sb, s_profile.name[0] ? s_profile.name : s_profile.id);
            sb_puts(&sb, "（车辆已休眠或不在范围内时会失败，稍后重试）");
            return;
        }
        if (failed) { // rc==0（没扫到）静默，与探针「超时算失败」的差异在设备侧必须区分
            sb_init(&sb, msg, sizeof(msg));
            sb_puts(&sb, "deviceId 直连失败（");
            sb_puts(&sb, err);
            sb_puts(&sb, "），改为一轮扫描");
            sb_log(TLB_LOG_WARN, &sb);
        }
    }

    // 2. 扫描一轮再挑
    static tlb_ble_dev_t auto_list[TLB_APP_ADV_MAX]; // 链路任务专用，与 worker 的列表分仓
    tlb_ble_names_t names;
    tlb_ble_names_for_vin(vin, &names);
    int n = tlb_ble_discover(TLB_AUTO_SCAN_MS, &names, auto_list, TLB_APP_ADV_MAX, err,
                             sizeof(err));
    if (n < 0) {
        sb_init(&sb, msg, sizeof(msg));
        sb_puts(&sb, "扫描失败：");
        sb_puts(&sb, err);
        auto_skip(res, "scan", msg);
        return;
    }

    // pickFromList：顺序四档，一条都不能换
    int pick = -1;
    char why[128];
    why[0] = '\0';
    if (pick < 0 && s_profile.id[0]) {
        for (int i = 0; i < n; i++) {
            if (strcmp(auto_list[i].id, s_profile.id) == 0) {
                pick = i;
                snprintf(why, sizeof(why), "%s", "档案里的 deviceId");
                break;
            }
        }
    }
    if (pick < 0) {
        for (int i = 0; i < n; i++) {
            if (auto_list[i].hit[0]) {
                pick = i;
                snprintf(why, sizeof(why), "命中 VIN 广播名 %s", auto_list[i].hit);
                break;
            }
        }
    }
    if (pick < 0 && s_profile.name[0]) {
        char a[TLB_ADV_NAME_MAX], b[TLB_ADV_NAME_MAX];
        tlb_norm_name(s_profile.name, b, sizeof(b));
        for (int i = 0; i < n; i++) {
            if (!auto_list[i].name[0]) {
                continue;
            }
            tlb_norm_name(auto_list[i].name, a, sizeof(a));
            if (strcmp(a, b) == 0) {
                pick = i;
                snprintf(why, sizeof(why), "命中档案里的名字 %s", auto_list[i].name);
                break;
            }
        }
    }
    if (pick < 0) {
        for (int i = 0; i < n; i++) {
            if (auto_list[i].tesla) {
                pick = i;
                snprintf(why, sizeof(why), "%s", "广播了 0211（特斯拉 VCSEC 服务）");
                break;
            }
        }
    }

    if (pick < 0) {
        // 「扫到 N 个广播」+ 前 8 条有名/带 0211 的（半角 (无名)，[0211] 后缀、顿号连接）
        char seen[384];
        tlb_sb_t ss;
        sb_init(&ss, seen, sizeof(seen));
        int cnt = 0;
        for (int i = 0; i < n && cnt < 8; i++) {
            if (!auto_list[i].name[0] && !auto_list[i].tesla) {
                continue;
            }
            if (cnt > 0) {
                sb_puts(&ss, "、");
            }
            sb_puts(&ss, auto_list[i].name[0] ? auto_list[i].name : "(无名)");
            if (auto_list[i].tesla) {
                sb_puts(&ss, "[0211]");
            }
            cnt++;
        }
        sb_init(&sb, res->text, sizeof(res->text));
        sb_puts(&sb, "没扫到绑定过的车（车可能休眠 / 距离太远 / 换过蓝牙名）。扫到 ");
        sb_printf(&sb, "%d", n);
        sb_puts(&sb, " 个广播");
        if (seen[0]) {
            sb_puts(&sb, "：");
            sb_puts(&sb, seen);
        }
        sb_puts(&sb, " —— 踩刹车唤醒车辆后再试，或用「② 扫描并连接（手选）」");
        res->ok = false;
        snprintf(res->skipped, sizeof(res->skipped), "%s", "notfound");
        return;
    }

    if (connect_and_record(vin, &auto_list[pick], err, sizeof(err))) {
        sb_init(&sb, msg, sizeof(msg));
        sb_puts(&sb, "自动连接成功（");
        sb_puts(&sb, why);
        sb_puts(&sb, "）：");
        sb_puts(&sb, auto_list[pick].name[0] ? auto_list[pick].name : auto_list[pick].id);
        sb_log(TLB_LOG_OK, &sb);
        res->ok = true;
        snprintf(res->text, sizeof(res->text), "%s", msg);
    } else {
        sb_init(&sb, msg, sizeof(msg));
        sb_puts(&sb, "扫到了但连接失败：");
        sb_puts(&sb, err);
        auto_skip(res, "connect", msg);
    }
}

// ---------------------------------------------------------------- 轮询排期
// 车钥匙形态：不再照搬 auto-reconnect.js 的退避升档，间隔恒为 2 秒。
static int64_t arm_retry(void)
{
    s_loop_next_at = tlb_port_now_ms() + TLB_RETRY_DELAY_MS;
    return TLB_RETRY_DELAY_MS;
}

// auto-reconnect.js:stopAutoReconnectLoop —— 幂等门槛逐字对齐；
// 不碰 s_link_run（那是链路任务自己的单飞位）
static void stop_loop(const char *why)
{
    if (!s_loop_wanted && !s_link_run && s_loop_next_at == 0) {
        return;
    }
    s_loop_wanted = false;
    s_loop_next_at = 0;
    char msg[256];
    tlb_sb_t sb;
    sb_init(&sb, msg, sizeof(msg));
    sb_puts(&sb, "自动重连已停止");
    if (why && why[0]) {
        sb_puts(&sb, "（");
        sb_puts(&sb, why);
        sb_puts(&sb, "）");
    }
    sb_puts(&sb, "；回到前台或点「立即自动连接」会重新启动");
    sb_log(TLB_LOG_INFO, &sb);
}

// auto-reconnect.js:runLoopOnce —— 链路任务里跑（对应 JS 的 loopRun 单飞）
static void run_once(void)
{
    s_loop_next_at = 0; // clearLoopTimer
    s_loop_tries++;
    auto_res_t r;
    auto_once(&r);
    if (!s_loop_wanted) { // 探针 L165：这一轮跑完期间被停了就不再排期
        return;
    }
    if (r.ok || strcmp(r.skipped, "already") == 0) {
        return;
    }
    if (strcmp(r.skipped, "nokey") == 0 || strcmp(r.skipped, "nobind") == 0) {
        stop_loop("本机还没有密钥或绑定档案");
        return;
    }
    if (strcmp(r.skipped, "suspended") == 0) {
        s_loop_wanted = false;
        s_loop_next_at = 0;
        return;
    }
    int64_t delay = arm_retry();
    char msg[1024];
    tlb_sb_t sb;
    sb_init(&sb, msg, sizeof(msg));
    sb_printf(&sb, "自动重连第 %d 次没成功（", s_loop_tries);
    sb_puts(&sb, r.text[0] ? r.text : r.skipped);
    sb_printf(&sb, "），%lld 秒后继续重试 —— 走到车边会自己连上，不必重开 App",
              (long long)(delay / 1000)); // Math.round(delay/1000)，档位都是整秒
    sb_log(TLB_LOG_WARN, &sb);
}

static void run_attempt(void)
{
    if (s_link_run) {
        return;
    }
    s_link_run = true;
    s_link_due = false;
    run_once();
    s_link_run = false;
}

// 链路任务：退避排期 + 「disconnected 下降沿 = 立刻重新武装」+ 2 秒心跳兜底。
// 探针靠 state 回调驱动 onLinkLost；设备侧没有事件循环，用状态字符串轮询等价实现。
// 主动 close 走 idle，不算断线（与探针 L33-34 同一判据）。
static void link_task(void *arg)
{
    (void)arg;
    char prev[16];
    snprintf(prev, sizeof(prev), "%s", tlb_ble_state());
    for (;;) {
        int64_t wait_ms;
        if (s_link_due) {
            wait_ms = 0;
        } else if (s_loop_wanted && s_loop_next_at > 0) {
            wait_ms = s_loop_next_at - tlb_port_now_ms();
            if (wait_ms < 1) {
                wait_ms = 1;
            }
        } else {
            wait_ms = 2000;
        }
        xSemaphoreTake(s_link_wake, pdMS_TO_TICKS((uint32_t)wait_ms));

        const char *st = tlb_ble_state();
        bool now_disc = strcmp(st, "disconnected") == 0;
        bool was_disc = strcmp(prev, "disconnected") == 0;
        snprintf(prev, sizeof(prev), "%s", st);
        if (now_disc && !was_disc) { // hooks.onLinkLost
            if (s_loop_wanted && !s_auto_suspended) {
                s_loop_tries = 0;
                run_attempt();
            }
        }
        if (!s_link_run &&
            (s_link_due ||
             (s_loop_wanted && s_loop_next_at != 0 && tlb_port_now_ms() >= s_loop_next_at))) {
            run_attempt();
        }
    }
}

// ---------------------------------------------------------------- 命令处理
// startAutoReconnectLoop：重复调用不叠加、跑着的时候不清计数
static void start_loop(void)
{
    s_loop_wanted = true;
    if (!s_link_run) {
        s_loop_tries = 0;
    }
    s_link_due = true;
    xSemaphoreGive(s_link_wake);
}

static void handle_scan_list(const char *vin)
{
    static tlb_ble_dev_t list[TLB_APP_ADV_MAX]; // worker 专用仓
    tlb_ble_names_t names;
    tlb_ble_names_for_vin(vin, &names);
    char err[160];
    int n = tlb_ble_discover(TLB_SCAN_TIMEOUT_MS, &names, list, TLB_APP_ADV_MAX, err, sizeof(err));
    if (n < 0) {
        tlb_ble_log(TLB_LOG_ERROR, err); // 失败只以文本呈现，绝不出现数字错误码
    }
    // 逐条广播的打印在设备层（tlb_ble_discover 内部），与探针列表页等价
}

static void handle_connect_vin(const char *vin)
{
    tlb_ble_names_t names;
    tlb_ble_names_for_vin(vin, &names);
    if (!names.exact[0] && !names.prefix[0]) {
        tlb_ble_log(TLB_LOG_ERROR, "请先填写 VIN（需要后 6 位才能匹配广播名），或在扫描列表里手选设备");
        return;
    }
    tlb_ble_dev_t dev;
    char err[160];
    int rc = tlb_ble_scan(&names, TLB_SCAN_TIMEOUT_MS, &dev, err, sizeof(err));
    if (rc == 1) {
        if (!connect_and_record(vin, &dev, err, sizeof(err))) {
            tlb_ble_log(TLB_LOG_ERROR, err);
        }
    } else if (rc == -1) {
        tlb_ble_log(TLB_LOG_ERROR, err);
    }
    // rc==0：探针 scan 返回 null → connectTo 静默返回 null
}

// handshake-service.js:requestEphemeralKey —— 按钮路径是 handshake(true)，强制重做
static void handle_handshake(const char *vin)
{
    static const uint32_t doms[2] = {TLB_DOMAIN_VCSEC, TLB_DOMAIN_INFOTAINMENT};
    for (size_t i = 0; i < 2; i++) {
        if (tlb_handshake(true, doms[i], vin, &s_sess[i], &s_ops, &s_scratch, NULL, &s_hr) ==
                TLB_OK &&
            s_hr.ok) {
            char msg[TLB_TEXT_MAX + 64];
            tlb_sb_t sb;
            sb_init(&sb, msg, sizeof(msg));
            sb_puts(&sb, "V3 会话已就绪：");
            sb_puts(&sb, s_hr.text);
            sb_log(TLB_LOG_INFO, &sb);
        } else {
            tlb_ble_log(TLB_LOG_ERROR, s_hr.text);
        }
    }
}

static void handle_rke(int32_t action, const char *vin)
{
    char lbl[64];
    tlb_label(TLB_EN_RKE, (uint32_t)action, lbl, sizeof(lbl));
    // 白名单闸门（rke.js:KNOWN_RKE = [0,1,20,29,30]）：表外的动作号一律不下发。
    // 真机曾因「把 20 当成上锁」误发过一条 REMOTE_DRIVE，只 WARN 不拦是错的。
    if (!tlb_rke_action_known(action)) {
        char msg[256];
        tlb_sb_t sb;
        sb_init(&sb, msg, sizeof(msg));
        sb_puts(&sb, lbl);
        sb_puts(&sb, "：不在官方现行 RKEAction_E 白名单（0/1/20/29/30）内，已拒绝下发");
        sb_log(TLB_LOG_ERROR, &sb);
        return;
    }
    uint8_t payload[16];
    size_t pn = tlb_msg_encode_rke((uint32_t)action, payload, sizeof(payload));
    // UI：先置「发送中」，回执到了再翻 ok/fail —— 屏幕靠这几个量画回执文案
    s_rke_action = action;
    s_rke_pending = true;
    s_rke_ok = false;
    s_rke_at = tlb_port_now_ms();
    // 审计行：把「即将下发的动作名 + 明文帧字节」显式打出来，便于事后逐条核对
    char msg[256];
    tlb_sb_t sb;
    sb_init(&sb, msg, sizeof(msg));
    sb_puts(&sb, "即将下发 ");
    sb_puts(&sb, lbl);
    sb_puts(&sb, " 明文=");
    for (size_t i = 0; i < pn; i++) {
        sb_printf(&sb, "%02x", payload[i]);
    }
    sb_log(TLB_LOG_INFO, &sb);
    tlb_request_t req;
    memset(&req, 0, sizeof(req));
    memset(&s_rr, 0, sizeof(s_rr));
    req.name = lbl;
    req.domain = TLB_DOMAIN_VCSEC;
    req.vin = vin;
    req.payload = payload;
    req.payload_len = pn;
    req.max_ms = 0; // <=0 → core 用 TLB_DEFAULT_MAX_MS
    req.done = TLB_DONE_COMMAND;
    tlb_send_request(&req, &s_sess[0], &s_ops, &s_scratch, &s_rr);
    s_rke_pending = false;
    s_rke_ok = s_rr.ok;
    s_rke_at = tlb_port_now_ms();
    sb_log(s_rr.ok ? TLB_LOG_OK : TLB_LOG_ERROR, &(tlb_sb_t){s_rr.text, strlen(s_rr.text) + 1, 0});
    // done=TLB_DONE_COMMAND 下 RKE 的终止帧就是 vehicleStatus（没有 commandStatus 的那帧），
    // 直接从终帧取车态入快照；再补排一条查询兜底（车辆只回 commandStatus 时快照也能刷新）。
    apply_vehicle_status(&s_rr.obj);
    tlb_app_post(TLB_CMD_STATUS_QUERY, 0);
}

// 开后备箱：UnsignedMessage{closureMoveRequest}，与 handle_rke 同形状走 VCSEC 域。
// lid 0=前备箱 1=后备箱；不过 RKE 白名单闸门（那是动作号的事），屏幕用 100/101 两个私有号段。
static void handle_lid(int32_t lid, const char *vin)
{
    const char *lbl = (lid == 0) ? "前备箱开启" : "后备箱开启";
    uint8_t payload[16];
    size_t pn = tlb_msg_encode_closure(lid, payload, sizeof(payload));
    // UI：先置「发送中」，回执到了再翻 ok/fail —— 屏幕靠这几个量画回执文案
    s_rke_action = (lid == 0) ? 100 : 101;
    s_rke_pending = true;
    s_rke_ok = false;
    s_rke_at = tlb_port_now_ms();
    // 审计行：与 handle_rke 同款，把「即将下发的动作名 + 明文帧字节」显式打出来
    char msg[256];
    tlb_sb_t sb;
    sb_init(&sb, msg, sizeof(msg));
    sb_puts(&sb, "即将下发 ");
    sb_puts(&sb, lbl);
    sb_puts(&sb, " 明文=");
    for (size_t i = 0; i < pn; i++) {
        sb_printf(&sb, "%02x", payload[i]);
    }
    sb_log(TLB_LOG_INFO, &sb);
    tlb_request_t req;
    memset(&req, 0, sizeof(req));
    memset(&s_rr, 0, sizeof(s_rr));
    req.name = lbl;
    req.domain = TLB_DOMAIN_VCSEC;
    req.vin = vin;
    req.payload = payload;
    req.payload_len = pn;
    req.max_ms = 0; // <=0 → core 用 TLB_DEFAULT_MAX_MS
    req.done = TLB_DONE_COMMAND;
    tlb_send_request(&req, &s_sess[0], &s_ops, &s_scratch, &s_rr);
    s_rke_pending = false;
    s_rke_ok = s_rr.ok;
    s_rke_at = tlb_port_now_ms();
    sb_log(s_rr.ok ? TLB_LOG_OK : TLB_LOG_ERROR, &(tlb_sb_t){s_rr.text, strlen(s_rr.text) + 1, 0});
    apply_vehicle_status(&s_rr.obj);
    tlb_app_post(TLB_CMD_STATUS_QUERY, 0);
}

// 查询车辆状态：InformationRequest(GET_STATUS) 明文 oneof，车辆回一条 vehicleStatus。
// 纯后台刷新，没有回执文案；未连接直接跳过（轮询背景不该刷屏报错）。
static void handle_status_query(const char *vin)
{
    if (!tlb_ble_connected()) {
        return;
    }
    uint8_t payload[16];
    size_t pn = tlb_msg_encode_status_query(payload, sizeof(payload));
    tlb_request_t req;
    memset(&req, 0, sizeof(req));
    memset(&s_rr, 0, sizeof(s_rr));
    req.name = "查询车辆状态";
    req.domain = TLB_DOMAIN_VCSEC;
    req.vin = vin;
    req.payload = payload;
    req.payload_len = pn;
    req.max_ms = 0;
    req.done = TLB_DONE_COMMAND;
    tlb_send_request(&req, &s_sess[0], &s_ops, &s_scratch, &s_rr);
    apply_vehicle_status(&s_rr.obj);
    sb_log(s_rr.ok ? TLB_LOG_INFO : TLB_LOG_ERROR,
           &(tlb_sb_t){s_rr.text, strlen(s_rr.text) + 1, 0});
}

// enrollment-service.js:bindKey —— 探针的 mustConnect() 在 ensureKey 之前，
// 未连接时绝不白白生成并保存密钥（core 的检查只作兜底）
static void handle_bind(const char *vin)
{
    if (!tlb_ble_connected()) {
        tlb_ble_log(TLB_LOG_ERROR, "还没连上车辆，先按「扫描并连接」");
        return;
    }
    char vin_up[TLB_VIN_MAX];
    size_t j = 0;
    for (const char *p = vin; *p && j + 1 < sizeof(vin_up); p++) {
        if (*p == ' ') {
            continue;
        }
        vin_up[j++] = (*p >= 'a' && *p <= 'z') ? (char)(*p - 32) : *p;
    }
    vin_up[j] = '\0';

    if (ensure_key(vin_up)) {
        tlb_ble_log(TLB_LOG_INFO, "已生成本机密钥对，接着把公钥交给车辆");
    }
    memset(&s_br, 0, sizeof(s_br));
    tlb_bind_key(vin_up, NULL, &s_sess[0], &s_ops, &s_scratch, &s_br);
    tlb_ble_log(s_br.ok ? TLB_LOG_OK : TLB_LOG_ERROR, s_br.text);
    if (s_br.ok && s_br.paired) {
        mark_bound();
    }
}

// ---------------------------------------------------------------- 首次绑定引导
// 阶段/附注发布器：worker 调用。note 先在栈上定稿再进临界区，拷贝用定长 memcpy。
static void onb_publish(uint8_t stage, const char *note)
{
    char buf[TLB_ONB_NOTE_MAX];
    buf[0] = '\0';
    if (note != NULL) {
        snprintf(buf, sizeof(buf), "%s", note);
    }
    portENTER_CRITICAL(&s_onb_mux);
    s_onb_pub.stage = stage;
    s_onb_pub.at = tlb_port_now_ms();
    memcpy(s_onb_pub.note, buf, sizeof(s_onb_pub.note));
    s_onb_pub.cursor = (uint8_t)(s_onb_cursor % TLB_ONB_LIST_MAX);
    portEXIT_CRITICAL(&s_onb_mux);
}

// 发布当前页窗口：s_onb_items[page*5 .. +5) → 快照。总数/页码一并带上，
// 一屏装不下的设备靠右一/右二跨页移动光标自动翻页。
static void onb_publish_window(void)
{
    int n = s_onb_n;
    int c = s_onb_cursor;
    if (c < 0) {
        c = 0;
    }
    if (c > n - 1) {
        c = n > 0 ? n - 1 : 0;
    }
    int page = c / TLB_ONB_LIST_MAX;
    int start = page * TLB_ONB_LIST_MAX;
    int rows = n - start;
    if (rows > TLB_ONB_LIST_MAX) {
        rows = TLB_ONB_LIST_MAX;
    }
    portENTER_CRITICAL(&s_onb_mux);
    s_onb_pub.count = (uint8_t)(rows > 0 ? rows : 0);
    s_onb_pub.total = (uint8_t)(n > 255 ? 255 : n);
    s_onb_pub.page = (uint8_t)page;
    s_onb_pub.pages = (uint8_t)((n + TLB_ONB_LIST_MAX - 1) / TLB_ONB_LIST_MAX);
    s_onb_pub.cursor = (uint8_t)(c - start);
    for (int i = 0; i < TLB_ONB_LIST_MAX; i++) {
        s_onb_pub.list[i] = (i < rows) ? s_onb_items[start + i] : (tlb_onb_item_t){0};
    }
    portEXIT_CRITICAL(&s_onb_mux);
}

static uint8_t onb_stage(void)
{
    portENTER_CRITICAL(&s_onb_mux);
    uint8_t st = s_onb_pub.stage;
    portEXIT_CRITICAL(&s_onb_mux);
    return st;
}

// 连接/绑定进行中不接受重扫与重复选择，避免打断加钥匙的时序窗口
static bool onb_busy(void)
{
    uint8_t st = onb_stage();
    return st == TLB_ONB_CONNECTING || st == TLB_ONB_PAIRING;
}

// 引导扫描一轮。全量列出附近设备（改名车/怪名车也能被用户认出来手动选），
// 排序照抄探针 sortAdv：疑似特斯拉 → 有名 → 无名，同级 RSSI 强者优先。
// 疑似判据（rec->tesla，设备层置位）：广播带 VCSEC 服务 UUID，或名字形状命中
// tlb_name_looks_like_tesla（老款哈希名 / 新款 Tesla+尾号）。屏幕青色高亮它。
static int onb_rank(const tlb_ble_dev_t *d)
{
    if (d->tesla) {
        return 0;
    }
    return d->name[0] != '\0' ? 1 : 2;
}

static void handle_onb_rescan(void)
{
    s_rescan_ask = false; // 任何重扫入口（弹窗确认/右三双击/自动重扫）都顺手收掉弹窗
    if (!s_onb_active) {
        return;
    }
    if (onb_busy()) {
        tlb_ble_log(TLB_LOG_WARN, "引导：正在连接或等待刷卡，忽略重扫");
        return;
    }
    if (active_vin()[0] == '\0') {
        // 正常模式不可能无 VIN（无 VIN 开机即进配网模式，蓝牙栈根本不会起）。
        // 真走到这里说明状态异常：绝不能带着蓝牙开热点（内存必炸），只提示重启。
        tlb_ble_log(TLB_LOG_WARN, "引导：无VIN，忽略扫描（重启可进配网模式补填）");
        return;
    }
    onb_publish(TLB_ONB_SCAN, NULL);
    char err[160];
    int n = tlb_ble_discover(TLB_ONB_SCAN_MS, NULL, s_onb_raw, TLB_APP_ADV_MAX, err, sizeof(err));
    if (!s_onb_active) {
        return; // 扫描期间引导被关闭（绑定完成/清档案），别把旧列表发出去
    }
    int m = 0;
    for (int i = 0; i < n && m < TLB_APP_ADV_MAX; i++) {
        if (!s_onb_raw[i].valid) {
            continue;
        }
        snprintf(s_onb_items[m].name, sizeof(s_onb_items[m].name), "%s", s_onb_raw[i].name);
        snprintf(s_onb_items[m].id, sizeof(s_onb_items[m].id), "%s", s_onb_raw[i].id);
        s_onb_items[m].rssi = s_onb_raw[i].rssi;
        s_onb_items[m].tesla = s_onb_raw[i].tesla;
        s_onb_raw_idx[m] = i;
        m++;
    }
    // 插入排序（档位升序、同级 RSSI 降序）：m<=24，O(m^2) 无所谓，稳排保 RSSI 同值稳定
    for (int i = 1; i < m; i++) {
        tlb_onb_item_t it = s_onb_items[i];
        int ri = s_onb_raw_idx[i];
        int rank_i = onb_rank(&s_onb_raw[ri]);
        int j = i - 1;
        while (j >= 0) {
            int rj = onb_rank(&s_onb_raw[s_onb_raw_idx[j]]);
            bool after = rj > rank_i || (rj == rank_i && s_onb_items[j].rssi < it.rssi);
            if (!after) {
                break;
            }
            s_onb_items[j + 1] = s_onb_items[j];
            s_onb_raw_idx[j + 1] = s_onb_raw_idx[j];
            j--;
        }
        s_onb_items[j + 1] = it;
        s_onb_raw_idx[j + 1] = ri;
    }
    s_onb_n = m;
    s_onb_cursor = 0; // 新一轮列表光标回到第一行（最可能是车的那台）
    onb_publish_window();
    if (m > 0) {
        int nt = 0;
        for (int i = 0; i < m; i++) {
            if (s_onb_items[i].tesla) {
                nt++;
            }
        }
        char msg[96];
        tlb_sb_t sb;
        sb_init(&sb, msg, sizeof(msg));
        sb_printf(&sb, "引导：列出 %d 台设备（%d 台疑似特斯拉），等用户选车", m, nt);
        sb_log(TLB_LOG_INFO, &sb);
        onb_publish(TLB_ONB_LIST, NULL);
        return;
    }
    onb_publish(TLB_ONB_NOFOUND, NULL);
    tlb_ble_log(TLB_LOG_WARN, "引导：没扫到任何设备，2 秒后自动重扫（坐进车内唤醒车机再试）");
    tlb_app_post(TLB_CMD_ONB_RESCAN, 0); // worker 出列再排下一轮，选车命令能插进来
}

// 右一长按：只在「列表就绪/失败」两阶段弹确认框（SCAN 无意义、CONNECTING/PAIRING
// 会被 onb_busy 拦住）。原 stage 和 note 先抄一份，取消时原样恢复。
static void handle_onb_rescan_ask(void)
{
    if (!s_onb_active || s_rescan_ask) {
        return;
    }
    uint8_t st = onb_stage();
    if (st != TLB_ONB_LIST && st != TLB_ONB_FAIL) {
        return;
    }
    portENTER_CRITICAL(&s_onb_mux);
    s_ask_prev = st;
    memcpy(s_ask_prev_note, s_onb_pub.note, sizeof(s_ask_prev_note));
    portEXIT_CRITICAL(&s_onb_mux);
    s_rescan_ask = true;
    onb_publish(TLB_ONB_RESCAN_ASK, NULL);
}

// 弹窗内右一/右二 = 取消：回到弹窗前的阶段，FAIL 要连失败原因一起带回。
static void handle_onb_rescan_cancel(void)
{
    if (!s_rescan_ask) {
        return;
    }
    s_rescan_ask = false;
    if (!s_onb_active || onb_stage() != TLB_ONB_RESCAN_ASK) {
        return; // 弹窗期间状态已被别的路径切走（如绑定完成），不越权恢复
    }
    onb_publish(s_ask_prev, s_ask_prev_note);
}

// 从广播名提取 VIN 后 6 位（实测：新固件车广播名固定 "Tesla " + VIN 后 6 位）
static bool onb_vin6_of(const char *name, char *out6)
{
    size_t n = strlen(name);
    if (n >= 12 && strncmp(name, "Tesla ", 6) == 0) {
        memcpy(out6, name + 6, 6);
        out6[6] = '\0';
        return true;
    }
    return false;
}

// 消费一次「我已确认」标志（传给 tesla_core 绑定循环，每个时间片检查一次）
static bool onb_user_confirm(void)
{
    bool v = s_onb_confirm;
    s_onb_confirm = false;
    return v;
}
static const tlb_bind_opts_t s_onb_bind_opts = { .user_confirm = onb_user_confirm };

// 引导选车：连接 raw 列表光标所指车辆 → 自动发加钥匙请求 → 等车主刷 NFC 卡。
// 复用 connect_and_record（连接+落盘档案）与 handle_bind 同款绑定链路。
static void handle_onb_select(void)
{
    if (!s_onb_active) {
        return;
    }
    if (onb_busy()) {
        // PAIRING 中右三 =「我已确认，立即验证」：置标志，绑定循环下个时间片（≤2.5s）
        // 立刻打一针 —— 通过马上进成功收尾；没通过立刻报可读失败，不再空等 150 秒。
        if (onb_stage() == TLB_ONB_PAIRING) {
            s_onb_confirm = true;
            tlb_ble_log(TLB_LOG_INFO, "引导：用户已确认，立即验证绑定结果");
        } else {
            tlb_ble_log(TLB_LOG_WARN, "引导：正在连接，忽略重复选择");
        }
        return;
    }
    if (s_onb_n <= 0) {
        onb_publish(TLB_ONB_FAIL, "没有可连接的车辆，请重扫");
        return;
    }
    // 全局光标（跨页）：条目与原始记录都按全局序号取，worker 内读写无并发问题
    int sel = s_onb_cursor;
    if (sel < 0 || sel >= s_onb_n) {
        sel = 0;
    }
    tlb_onb_item_t it = s_onb_items[sel];

    char note[TLB_ONB_NOTE_MAX];
    snprintf(note, sizeof(note), "%s", it.name[0] ? it.name : it.id);
    char vin6[8];
    bool has_vin = onb_vin6_of(it.name, vin6);
    // 会话握手 HMAC 的 personalization 用**全量 VIN**（tlb_v3_session_info_hmac），
    // 哈希广播名（新固件改名车）拿不到 VIN 时必须用配网页/串口存下的那条，
    // 否则 session_info tag 永远校验不过（表现：车端能加钥匙，但探针/解锁全失败）。
    const char *stored_vin = active_vin();
    size_t sv_len = strlen(stored_vin);
    const char *bind_vin = NULL;
    if (has_vin) {
        // 广播名带后 6 位：与存档 VIN 尾号一致就用全量，不一致说明选了另一台车
        bind_vin = (sv_len >= 6 && strcmp(stored_vin + sv_len - 6, vin6) == 0) ? stored_vin : vin6;
    } else if (sv_len > 0) {
        bind_vin = stored_vin;
    }
    if (bind_vin == NULL) {
        onb_publish(TLB_ONB_FAIL, "无VIN：先连接入点配置");
        return;
    }
    // 还没连上车（首次选择/上次连接失败）才发起连接；绑定失败重选时车还连着，
    // 直接重发加钥匙请求，不做无谓的断连重连。
    if (!tlb_ble_connected()) {
        onb_publish(TLB_ONB_CONNECTING, note);
        char err[160];
        if (!connect_and_record(bind_vin, &s_onb_raw[s_onb_raw_idx[sel]], err, sizeof(err))) {
            onb_publish(TLB_ONB_FAIL, err[0] ? err : "连接失败，请重试");
            return;
        }
    }

    char msg[96];
    tlb_sb_t sb;
    sb_init(&sb, msg, sizeof(msg));
    sb_puts(&sb, "引导：已连接 ");
    sb_puts(&sb, note);
    sb_puts(&sb, "，发送加钥匙请求，请刷 NFC 卡授权");
    sb_log(TLB_LOG_INFO, &sb);
    onb_publish(TLB_ONB_PAIRING, note);

    if (ensure_key(bind_vin)) {
        tlb_ble_log(TLB_LOG_INFO, "已生成本机密钥对，接着把公钥交给车辆");
    }
    memset(&s_br, 0, sizeof(s_br));
    s_onb_confirm = false; // 丢弃上一轮可能残留的确认标志
    tlb_bind_key(bind_vin, &s_onb_bind_opts, &s_sess[0], &s_ops, &s_scratch, &s_br);
    tlb_ble_log(s_br.ok ? TLB_LOG_OK : TLB_LOG_ERROR, s_br.text);
    if (s_br.ok && s_br.paired) {
        mark_bound();
        onb_publish(TLB_ONB_DONE, NULL);
        tlb_ble_log(TLB_LOG_OK, "引导：绑定成功，2 秒后回首页，以后开机自动连车");
        vTaskDelay(pdMS_TO_TICKS(2500)); // 让「绑定成功」在屏幕上停一会再回首页
        s_onb_active = false;
        return;
    }
    // 失败原因只取第一行（绑定结果文本可能多行，屏幕一行放不下）。
    // 窗口耗尽（既没终态也建不起会话）单独给一句人话：车机始终没确认——
    // 最可能是没弹「添加钥匙」、没贴 NFC 卡、蓝牙槽被官方 App 占满或车睡了；
    // 完整逐项排查清单打在串口日志里（s_br.text 原文不精简）。
    char why[TLB_ONB_NOTE_MAX];
    if (!s_br.ok && s_br.wait) {
        snprintf(why, sizeof(why), "等150秒车未确认：没弹窗或没贴卡");
    } else {
        snprintf(why, sizeof(why), "%.63s", s_br.text);
        for (char *p = why; *p != '\0'; p++) {
            if (*p == '\n') {
                *p = '\0';
                break;
            }
        }
    }
    onb_publish(TLB_ONB_FAIL, why[0] != '\0' ? why : "绑定未完成，请靠近车辆重试");
}

static void handle_probe(const char *vin)
{
    memset(&s_br, 0, sizeof(s_br));
    tlb_probe_enrollment(vin, NULL, &s_sess[0], &s_ops, &s_scratch, &s_br);
    tlb_ble_log(s_br.ok ? TLB_LOG_OK : TLB_LOG_ERROR, s_br.text);
}

// ble-transport.js:readVersion —— 「通信协议版本 = <hex>」
static void handle_version(void)
{
    uint8_t buf[32];
    size_t len = 0;
    char err[160];
    if (tlb_ble_read_version(buf, sizeof(buf), &len, err, sizeof(err))) {
        char msg[160];
        tlb_sb_t sb;
        sb_init(&sb, msg, sizeof(msg));
        sb_puts(&sb, "通信协议版本 = ");
        for (size_t i = 0; i < len; i++) {
            sb_printf(&sb, "%02x", buf[i]);
        }
        sb_log(TLB_LOG_OK, &sb);
    } else {
        tlb_ble_log(TLB_LOG_ERROR, err);
    }
}

// credential-service.js 的两次 forget。偏离：clearVehicle 不移植；
// 设备版清档案时顺带清两个域的会话槽位（没有 vehicle-store 那层，档案即全部身份）。
static void forget_bind_profile(void)
{
    s_auto_suspended = false; // suspendAutoConnect(false)
    stop_loop("绑定档案已清除");
    tlb_nvs_profile_clear();
    memset(&s_profile, 0, sizeof(s_profile));
    lock_state();
    tlb_store_clear(&s_backend, TLB_STORE_SLOT_VCSEC);
    tlb_store_clear(&s_backend, TLB_STORE_SLOT_INFOTAINMENT);
    tlb_v3_session_reset(&s_sess[0]);
    tlb_v3_session_reset(&s_sess[1]);
    unlock_state();
    tlb_ble_log(TLB_LOG_WARN, "绑定档案已清除（下次打开 App 不再自动连接，需要重新走「扫描并连接」）");
}

static void handle_forget(int arg)
{
    if (arg == 0) {
        // forgetEverything：clearKeys() 在前
        lock_state();
        tlb_store_clear(&s_backend, TLB_STORE_SLOT_KEY);
        memset(&s_key, 0, sizeof(s_key));
        s_have_key = false;
        unlock_state();
        sync_signer_ops();
        forget_bind_profile();
        tlb_ble_log(TLB_LOG_WARN, "本机密钥与所有域的 V3 会话（含 counter）已清除（下次绑定需要重新刷卡）");
    } else {
        forget_bind_profile();
    }
}

// 组合键出厂重置（社区用户自助换车/重置，不依赖串口）：
// 断链停轮询 → 清密钥 → 清档案/两个域会话 → 清手输 VIN → 提示 1.5 秒 → 重启。
// 重启后 tlb_app_init 见无密钥/无档案，自动进入首次绑定引导页。
static void handle_factory_reset(void)
{
    tlb_ble_log(TLB_LOG_WARN, "开始出厂重置：清除全部钥匙数据");
    tlb_ble_disconnect();
    stop_loop("出厂重置");
    lock_state();
    tlb_store_clear(&s_backend, TLB_STORE_SLOT_KEY);
    memset(&s_key, 0, sizeof(s_key));
    s_have_key = false;
    unlock_state();
    sync_signer_ops();

    tlb_nvs_profile_clear();
    memset(&s_profile, 0, sizeof(s_profile));
    lock_state();
    tlb_store_clear(&s_backend, TLB_STORE_SLOT_VCSEC);
    tlb_store_clear(&s_backend, TLB_STORE_SLOT_INFOTAINMENT);
    tlb_v3_session_reset(&s_sess[0]);
    tlb_v3_session_reset(&s_sess[1]);
    unlock_state();

    tlb_nvs_vin_clear();
    s_vin[0] = '\0';

    // 先发布重置态让屏幕显示提示，再延时重启
    s_fac_reset = true;
    tlb_ble_log(TLB_LOG_WARN, "钥匙数据已全部清除，即将重启进入首次绑定引导");
    vTaskDelay(pdMS_TO_TICKS(1500));
    esp_restart();
}

static void handle_disconnect(void)
{
    tlb_ble_disconnect();
    invalidate_all("断开连接");
    s_auto_suspended = true; // suspendAutoConnect(true)：先置位，stop 里就不会再被当成可恢复
    stop_loop("你主动断开过");
    tlb_ble_log(TLB_LOG_INFO, "已暂停自动重连（下次手动连接、点「恢复自动重连」或重开 App 会恢复）");
}

// ---------------------------------------------------------------- 状态行
// session-status.js:one(domain)
// 偏离（设备侧专有）：追加 NVS 里持久化的 counter。上下文卡 §7.5 项 8 要判「复位后
// counter 的基线由谁起算」，只看内存里那个数分不开两种解释。纯展示，不参与任何判读。
static void sb_session_one(tlb_sb_t *sb, int idx)
{
    const tlb_v3_session_t *s = &s_sess[idx];
    bool live = s->has_key && s->epoch_len > 0 && s->has_anchor;
    uint32_t dom = (idx == 1) ? TLB_DOMAIN_INFOTAINMENT : TLB_DOMAIN_VCSEC;
    tlb_store_session_t rec;
    bool on_disk = (tlb_store_load_session(&s_backend, dom, &rec) == TLB_STORE_OK);
    sb_printf(sb, "%u@", (unsigned)s->counter);
    sb_puts(sb, live ? (s->ready ? "ready" : "未就绪") : "未握手");
    if (s->epoch_len > 0) {
        sb_puts(sb, " epoch=");
        for (size_t i = 0; i < 8 && i < s->epoch_len; i++) {
            sb_printf(sb, "%02x", s->epoch[i]);
        }
        sb_puts(sb, "…");
    }
    if (on_disk) {
        sb_printf(sb, "（盘上counter=%u）", (unsigned)rec.counter);
    } else {
        sb_puts(sb, "（盘上无存档）");
    }
}

// session-status.js:statusText（内部版：调用方持锁或单线程场景）
static void build_status(tlb_sb_t *sb)
{
    sb_puts(sb, "BLE=");
    sb_puts(sb, tlb_ble_state());
    sb_puts(sb, " | ");
    if (op_has_key(NULL)) {
        char kid[48];
        tlb_tesla_key_id(&s_ops, kid, sizeof(kid));
        sb_puts(sb, "keyId=");
        sb_puts(sb, kid);
    } else {
        sb_puts(sb, "无密钥");
    }
    sb_puts(sb, " | VCSEC=");
    sb_session_one(sb, 0);
    sb_puts(sb, " | 车机=");
    sb_session_one(sb, 1);
    sb_puts(sb, " | ");
    // describeAutoLoop 内联（避免自锁）
    if (!op_has_key(NULL) || !has_bind()) {
        sb_puts(sb, "自动重连：未启动（无密钥或无绑定档案）");
    } else if (s_auto_suspended) {
        sb_puts(sb, "自动重连：已暂停（你主动断开过，点「恢复自动重连」）");
    } else if (!s_loop_wanted) {
        sb_puts(sb, "自动重连：未启动（回到前台会自动启动）");
    } else if (tlb_ble_connected()) {
        sb_puts(sb, "自动重连：已连上车，断线会自动重连");
    } else if (s_link_run) {
        sb_printf(sb, "自动重连：正在连接（第 %d 次尝试）", s_loop_tries);
    } else if (s_loop_next_at != 0) {
        int64_t rem = s_loop_next_at - tlb_port_now_ms();
        long secs = (long)((rem + 500) / 1000); // Math.round
        if (secs < 1) {
            secs = 1;                          // Math.max(1, ...)
        }
        sb_printf(sb, "自动重连：%ld 秒后重试（已试 %d 次）", secs, s_loop_tries);
    } else {
        sb_puts(sb, "自动重连：等待中");
    }
}

void tlb_app_status(char *out, size_t cap)
{
    if (cap == 0) {
        return;
    }
    out[0] = '\0';
    if (!s_state_mtx) {
        return;
    }
    lock_state();
    tlb_sb_t sb;
    sb_init(&sb, out, cap);
    build_status(&sb);
    unlock_state();
}

void tlb_app_auto_state(char *out, size_t cap)
{
    tlb_app_status(out, cap); // 兜底：没别的调用方只要这一小段
}

// UI 快照：key_ui.c 每个心跳轮询一次。全是单字节/对齐整数的 volatile 读，不加锁。
void tlb_app_ui_snapshot(tlb_app_ui_t *out)
{
    if (!out) {
        return;
    }
    out->connected = tlb_ble_connected();
    out->trying = s_link_run;
    out->tries = s_loop_tries;
    out->ever_connected = s_ever_connected;
    out->rke_action = s_rke_action;
    out->rke_pending = s_rke_pending;
    out->rke_ok = s_rke_ok;
    out->rke_at = s_rke_at;
    out->has_status = s_has_status;
    for (int i = 0; i < 8; i++) {
        out->closure[i] = s_closure[i];
    }
    out->lock_state = s_lock_state;
    // 引导列表是多字段结构体，读写两侧都进临界区（注释见 tlb_ble.h 快照节）
    portENTER_CRITICAL(&s_onb_mux);
    out->onb_active = s_onb_active;
    out->onb_stage = s_onb_pub.stage;
    out->onb_count = s_onb_pub.count;
    out->onb_cursor = s_onb_pub.cursor;
    out->onb_total = s_onb_pub.total;
    out->onb_page = s_onb_pub.page;
    out->onb_pages = s_onb_pub.pages;
    out->onb_at = s_onb_pub.at;
    memcpy(out->onb_note, s_onb_pub.note, sizeof(out->onb_note));
    for (int i = 0; i < TLB_ONB_LIST_MAX; i++) {
        out->onb_list[i] = s_onb_pub.list[i];
    }
    portEXIT_CRITICAL(&s_onb_mux);
    snprintf(out->onb_vin, sizeof(out->onb_vin), "%.17s", active_vin());
    out->fac_reset = s_fac_reset;
}

// ---------------------------------------------------------------- worker
static void handle_cmd(const cmd_msg_t *m)
{
    const char *vin = m->vin[0] ? m->vin : active_vin();
    switch (m->cmd) {
    case TLB_CMD_SCAN_LIST:
        handle_scan_list(vin);
        break;
    case TLB_CMD_CONNECT_VIN:
        handle_connect_vin(vin);
        break;
    case TLB_CMD_CONNECT_AUTO:
    case TLB_CMD_LOOP_START:
        start_loop();
        break;
    case TLB_CMD_LOOP_STOP:
        stop_loop("");
        break;
    case TLB_CMD_RESUME:
        s_auto_suspended = false;
        start_loop();
        break;
    case TLB_CMD_DISCONNECT:
        handle_disconnect();
        break;
    case TLB_CMD_HANDSHAKE:
        handle_handshake(vin);
        break;
    case TLB_CMD_RKE:
        handle_rke(m->arg, vin);
        break;
    case TLB_CMD_LID:
        handle_lid(m->arg, vin);
        break;
    case TLB_CMD_STATUS_QUERY:
        handle_status_query(vin);
        break;
    case TLB_CMD_BIND:
        handle_bind(vin);
        break;
    case TLB_CMD_PROBE:
        handle_probe(vin);
        break;
    case TLB_CMD_VERSION:
        handle_version();
        break;
    case TLB_CMD_STATUS: {
        char line[1024];
        tlb_app_status(line, sizeof(line));
        tlb_ble_log(TLB_LOG_INFO, line);
        break;
    }
    case TLB_CMD_FORGET:
        handle_forget(m->arg);
        break;
    case TLB_CMD_ONB_SELECT:
        handle_onb_select();
        break;
    case TLB_CMD_ONB_RESCAN:
        handle_onb_rescan();
        break;
    case TLB_CMD_ONB_RESCAN_ASK:
        handle_onb_rescan_ask();
        break;
    case TLB_CMD_ONB_RESCAN_CANCEL:
        handle_onb_rescan_cancel();
        break;
    case TLB_CMD_FACTORY_RESET:
        handle_factory_reset();
        break;
    default:
        break;
    }
}

static void worker_task(void *arg)
{
    (void)arg;
    cmd_msg_t m;
    for (;;) {
        if (xQueueReceive(s_cmd_q, &m, portMAX_DELAY) == pdTRUE) {
            handle_cmd(&m);
        }
    }
}

// ---------------------------------------------------------------- 对外入口
const tlb_dispatch_ops_t *tlb_app_ops(void) { return &s_ops; }

void tlb_app_post(tlb_cmd_t cmd, int32_t arg)
{
    if (!s_cmd_q) {
        return;
    }
    cmd_msg_t m;
    memset(&m, 0, sizeof(m));
    m.cmd = cmd;
    m.arg = arg;
    snprintf(m.vin, sizeof(m.vin), "%s", s_vin);
    if (xQueueSend(s_cmd_q, &m, 0) != pdTRUE) {
        // 偏离（设备侧专有）：JS 单线程没有这个状态
        tlb_ble_log(TLB_LOG_WARN, "命令队列已满，丢弃一条命令");
    }
}

void tlb_app_post_vin(const char *vin)
{
    if (!vin) {
        return;
    }
    char up[TLB_VIN_MAX];
    size_t j = 0;
    for (const char *p = vin; *p && j + 1 < sizeof(up); p++) {
        if (*p == ' ') {
            continue;
        }
        up[j++] = (*p >= 'a' && *p <= 'z') ? (char)(*p - 32) : *p;
    }
    up[j] = '\0';
    snprintf(s_vin, sizeof(s_vin), "%s", up);
    tlb_nvs_vin_save(up); // config/index.js:VIN_STORE —— 换车、清档案都不丢

    if (s_cfg_mode) {
        // 配网模式（蓝牙栈根本没起，热恢复无从谈起）：请求 vin_cfg 延时 2 秒重启。
        // 重启后 VIN 已在 NVS → 走正常模式：开蓝牙、热点不再开（用户规则）。
        vin_cfg_stop();
        return;
    }
    // 正常模式 = 只可能是串口 REPL 换/补 VIN：落盘即生效，后续命令自然用新值。
}

bool tlb_app_onboarding(void) { return s_onb_active; }

// 重扫确认弹窗是否挂在屏幕上（按键任务用：弹窗期间右一/右二/右三改走确认与取消）
bool tlb_app_onb_rescan_pending(void)
{
    return s_onb_active && onb_stage() == TLB_ONB_RESCAN_ASK;
}

// 引导页右三单击：PAIRING 中直接置「我已确认」标志（按键任务上下文，只动一个
// volatile bool，与 onb_move 同款做法）；其余阶段照常入队走选车流程。
void tlb_app_onb_press(void)
{
    if (onb_stage() == TLB_ONB_PAIRING) {
        s_onb_confirm = true;
        tlb_ble_log(TLB_LOG_INFO, "引导：用户已确认，立即验证绑定结果");
        return;
    }
    tlb_app_post(TLB_CMD_ONB_SELECT, 0);
}

// 引导列表光标移动：按键任务直接调（只动一个 int），LVGL 侧经快照看到
void tlb_app_onb_move(int delta)
{
    int n = s_onb_n;
    if (n <= 0) {
        return;
    }
    int c = s_onb_cursor + delta;
    if (c < 0) {
        c = 0;
    }
    if (c > n - 1) {
        c = n - 1;
    }
    if (c == s_onb_cursor) {
        return; // 已在边界，别白发布
    }
    s_onb_cursor = c;
    onb_publish_window(); // 跨页时窗口整体换血，页内光标同步
}

esp_err_t tlb_app_init(void)
{
    tlb_nvs_init();
    tlb_nvs_backend(&s_backend);

    memset(&s_ops, 0, sizeof(s_ops));
    s_ops.ud = NULL;
    s_ops.now_ms = op_now_ms;
    s_ops.sleep_ms = op_sleep_ms;
    s_ops.connected = op_connected;
    s_ops.has_key = op_has_key;
    s_ops.exchange = op_exchange;
    s_ops.receive = op_receive;
    s_ops.session_stored = op_session_stored;
    s_ops.session_cleared = op_session_cleared;
    s_ops.mtu_note = op_mtu_note;
    s_ops.log = op_log;

    s_state_mtx = xSemaphoreCreateMutex();
    s_cmd_q = xQueueCreate(TLB_APP_CMD_Q_LEN, sizeof(cmd_msg_t));
    s_link_wake = xSemaphoreCreateCounting(8, 0);

    load_key();    // credential-store.js:loadKey
    load_profile(); // bind-profile.js:loadBind（含设备侧播种）
    load_sessions(); // v3-session-store.js:v3Session 的读盘分支
    sync_signer_ops();

    // 用户规则（内存只够一条链路）：设备里没有 VIN（哈希广播名拿不到，只能用户填）
    // → 进「纯配网模式」：只留屏幕提示页 + AP + DHCP + DNS + HTTP，蓝牙栈与
    // worker/link 任务一律不启动（实测 BLE 栈吃掉 ~105KB，热点必死）。
    // VIN 存进 NVS 后 vin_cfg 延时 2 秒重启；重启后走到下面的正常模式。
    if (active_vin()[0] == '\0') {
        s_cfg_mode = true;
        s_onb_active = true;
        if (!vin_cfg_start()) {
            onb_publish(TLB_ONB_FAIL, "AP启动失败 见串口");
        } else {
            onb_publish(TLB_ONB_NOVIN, NULL);
        }
        return ESP_OK;
    }

    // 失败不中止：函数自带错误日志行，后续命令会各自撞上「栈没起」的等价提示
    tlb_ble_stack_start();

    // core 的栈预算（tlb_dispatch.c / tlb_bind.c 头部注释里 gcc -fstack-usage 实测）最深链约
    // 12.0KB，再叠上本层帧与 newlib printf，12KB 会被 bind 打穿（真机 Stack protection fault）。
    // 按文档口径给 24KB —— 「设备侧任务栈按 24KB 给（16KB 不够）」。
    xTaskCreate(worker_task, "tlb_worker", 24576, NULL, 5, NULL);
    xTaskCreate(link_task, "tlb_link", 8192, NULL, 4, NULL);

    // 探针 App.vue onShow → startAutoReconnectLoop；设备的「回到前台」就是开机
    tlb_app_post(TLB_CMD_LOOP_START, 0);
    // 首次绑定引导：无密钥或无档案（社区新用户刷机后第一次开机）→ 自动进引导页，
    // 全程不用输 VIN；已绑定的老板子照常自动连车，引导不出场。串口 forget/wipe
    // 后重启也会重新走到这里（无 VIN 时先被上面的配网分支截住）。
    if (!op_has_key(NULL) || !has_bind()) {
        s_onb_active = true;
        tlb_app_post(TLB_CMD_ONB_RESCAN, 0);
    }
    return ESP_OK;
}
