// components/tesla_ble/src/tlb_ble.c
// NimBLE central 传输层。
//
// 权威依据：探针 src/infra/ble/ble-transport.js（文案与调用顺序逐字照抄）、
// mtu-manager.js、device-matcher.js、uni-ble-api.js（errText / uuidHex / matchUuid）、
// gatt.js（0211/0212/0213/0214）。
//
// 平台差异（都是「uni 才有这个东西」，不是行为差异）：
//   · uni 的 setBLEMTU 换成 ATT 标准 MTU Exchange；「车辆给的值更小」依旧以回读为准。
//   · uni 不能写描述符，这里能：订阅直接写 0x2902。
//   · uni 的 10007「property not support」是安卓协议栈替我们校验属性；
//     这里换成车端回 ATT 错误（0x03/0x06），同样映射成 errCode=10007 走换写法重试。
//   · 广播里的 deviceId 用 12 位大写冒号 MAC（见 tlb_ble.h 登记的偏离）。
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "esp_err.h"

#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_gap.h"
#include "host/ble_gatt.h"
#include "host/ble_hs.h"
#include "host/ble_hs_id.h"
#include "host/ble_hs_mbuf.h"
#include "host/ble_sm.h"
#include "host/util/util.h"

#include "tesla_ble/tlb_ble.h"
#include "tesla_core/tlb_frame.h"

// ---------------------------------------------------------------- 常量（gatt.js）
#define WRITE_NR "writeNoResponse"
#define WRITE_REQ "write"

static const char *GATT_SERVICE = "00000211-b2d1-43f0-9b88-960cebf8b91e";
static const char *GATT_WRITE = "00000212-b2d1-43f0-9b88-960cebf8b91e";
static const char *GATT_INDICATE = "00000213-b2d1-43f0-9b88-960cebf8b91e";
static const char *GATT_VERSION = "00000214-b2d1-43f0-9b88-960cebf8b91e";

// ATT 属性位（与 Android BluetoothGattCharacteristic 同一套位掩码）
#define CHR_PROP_READ 0x02u
#define CHR_PROP_WRITE_NO_RSP 0x04u
#define CHR_PROP_WRITE 0x08u
#define CHR_PROP_NOTIFY 0x10u
#define CHR_PROP_INDICATE 0x20u

#define CCCD_UUID 0x2902u

#define BUFFERED_MAX 8
#define TLB_ADV_MAX 24
#define TLB_SEEN_MAX 40
#define TLB_UUID_LIST_MAX 12

// GATT 过程超时：探针交给 uni/安卓的默认超时，这里必须自己钉一个，
// 否则车端不回 Write Response 时 worker 会永远挂着。
#define GATT_PROC_MS 8000LL
#define CONNECT_MS 10000

// ---------------------------------------------------------------- 日志出口
static tlb_ble_log_fn s_log_fn;
static void *s_log_ud;

static const char *kind_tag(tlb_log_kind_t k)
{
    switch (k) {
    case TLB_LOG_OK:
        return "ok";
    case TLB_LOG_WARN:
        return "warn";
    case TLB_LOG_ERROR:
        return "error";
    case TLB_LOG_TX:
        return "tx";
    case TLB_LOG_RX:
        return "rx";
    default:
        return "info";
    }
}

static void out_line(tlb_log_kind_t kind, const char *text)
{
    if (s_log_fn) {
        s_log_fn(kind, text, s_log_ud);
        return;
    }
    printf("[%s] %s\n", kind_tag(kind), text);
}

void tlb_ble_set_log_sink(tlb_ble_log_fn fn, void *ud)
{
    s_log_fn = fn;
    s_log_ud = ud;
}

// 长文案一律拼进静态行缓冲：host 任务栈只有 5KB，不能按 2.6KB 开局部数组。
// 约定（硬规矩）：Lbegin/Lend 必须配对；绝不把动态内容当 fmt 传给 Lfmt。
#define LINE_MAX 2600
static char s_line[LINE_MAX];
static size_t s_line_len;
static SemaphoreHandle_t s_line_mtx;
static SemaphoreHandle_t s_ble_mtx;
static SemaphoreHandle_t s_rx_sem;     // 帧命中 / 等待中止
static SemaphoreHandle_t s_proc_sem;   // GATT 过程回调完成
static SemaphoreHandle_t s_conn_sem;   // GAP CONNECT
static SemaphoreHandle_t s_scan_sem;   // 扫描命中
static SemaphoreHandle_t s_sync_sem;   // host sync
static SemaphoreHandle_t s_sec_sem;    // TIB：ENC_CHANGE 落定

static void s_line_mtx_take(void)
{
    if (s_line_mtx) {
        xSemaphoreTake(s_line_mtx, portMAX_DELAY);
    }
}

static void s_line_mtx_give(void)
{
    if (s_line_mtx) {
        xSemaphoreGive(s_line_mtx);
    }
}

// 注意：sink 里绝不能再调用 tlb_ble_log / L*，那是自死锁（锁不是递归的）。
void tlb_ble_log(tlb_log_kind_t kind, const char *text)
{
    if (!text) {
        return;
    }
    s_line_mtx_take();
    out_line(kind, text);
    s_line_mtx_give();
}

static void Lbegin(void)
{
    s_line_mtx_take();
    s_line_len = 0;
    s_line[0] = '\0';
}

static void Lput(const char *s)
{
    size_t n;
    if (!s) {
        return;
    }
    n = strlen(s);
    if (n > (size_t)(LINE_MAX - 1) - s_line_len) {
        n = (size_t)(LINE_MAX - 1) - s_line_len;
    }
    memcpy(s_line + s_line_len, s, n);
    s_line_len += n;
    s_line[s_line_len] = '\0';
}

static void Lfmt(const char *fmt, ...)
{
    char tmp[192];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(tmp, sizeof(tmp), fmt, ap);
    va_end(ap);
    Lput(tmp);
}

static void Lhex(const uint8_t *b, size_t n)
{
    static const char *hexd = "0123456789abcdef";
    size_t i;
    if (!b) {
        return;
    }
    for (i = 0; i < n; i++) {
        if (s_line_len + 2 >= (size_t)LINE_MAX) {
            return;
        }
        s_line[s_line_len++] = hexd[b[i] >> 4];
        s_line[s_line_len++] = hexd[b[i] & 0x0f];
    }
    s_line[s_line_len] = '\0';
}

static void Lend(tlb_log_kind_t kind)
{
    out_line(kind, s_line);
    s_line_len = 0;
    s_line[0] = '\0';
    s_line_mtx_give();
}

// ---------------------------------------------------------------- 错误码 → 文案
// uni 的错都长这样：'<中文说明> errCode=<n>'；探针靠字符串判据识别属性拒绝，
// 所以设备侧必须把 NimBLE 的 rc 也渲染成同样的形状（见 is_property_reject）。
static void rc_text(int rc, char *out, size_t cap)
{
    if (rc == 0) {
        snprintf(out, cap, "操作成功 errCode=0");
        return;
    }
    if (rc >= BLE_HS_ERR_ATT_BASE && rc < (BLE_HS_ERR_ATT_BASE + 0x100)) {
        unsigned att = (unsigned)(rc - BLE_HS_ERR_ATT_BASE);
        switch (att) {
        case 0x02: // READ_NOT_PERMITTED（读路径的属性不匹配）
        case 0x03: // WRITE_NOT_PERMITTED
        case 0x06: // REQ_NOT_SUPPORTED（例如对 Write Command 回错误）
            snprintf(out, cap, "当前特征值不支持此操作 errCode=10007");
            return;
        case 0x0a: // INSUFFICIENT_RESOURCES 之外的 ATT 0x0a = 不存在该句柄
            snprintf(out, cap, "没有找到指定特征 errCode=10006");
            return;
        case 0x0d: // INVALID_ATTR_VALUE_LEN
            snprintf(out, cap, "写入长度超过 MTU/特征上限 errCode=10008");
            return;
        case 0x05: // INSUFFICIENT_AUTHENTICATION
        case 0x08: // INSUFFICIENT_ENCRYPTION
        case 0x0f: // INSUFFICIENT_ENCRYPTION_KEY_SIZE
        case 0x12: // INSUFFICIENT_AUTHORIZATION
            snprintf(out, cap, "配对或加密未完成 errCode=10008");
            return;
        case 0x13: // VALUE_NOT_ALLOWED
            snprintf(out, cap, "车辆拒绝该值 errCode=10008");
            return;
        default:
            snprintf(out, cap, "ATT 错误 0x%02x errCode=10008", att);
            return;
        }
    }
    switch (rc) {
    case BLE_HS_ENOTCONN:
        snprintf(out, cap, "连接已断开 errCode=10009");
        return;
    case BLE_HS_ETIMEOUT:
        snprintf(out, cap, "操作超时 errCode=10012");
        return;
    case BLE_HS_EDONE:
        snprintf(out, cap, "操作已经结束 errCode=10008");
        return;
    case BLE_HS_EBUSY:
        snprintf(out, cap, "蓝牙栈正忙（扫描或另一条连接在进行）errCode=10008");
        return;
    case BLE_HS_EALREADY:
        snprintf(out, cap, "已经有连接尝试在进行 errCode=10008");
        return;
    case BLE_HS_EINVAL:
        snprintf(out, cap, "参数无效 errCode=10008");
        return;
    case BLE_HS_ENOMEM:
        snprintf(out, cap, "蓝牙栈内存不足 errCode=10008");
        return;
    default:
        snprintf(out, cap, "蓝牙栈错误 %d errCode=10008", rc);
        return;
    }
}

// 探针 ble-transport.js:isPropertyReject —— 判据是字符串，不是错误码白名单
static bool is_property_reject(const char *text)
{
    char low[256];
    size_t i;
    if (!text) {
        return false;
    }
    for (i = 0; text[i] && i < sizeof(low) - 1; i++) {
        char c = text[i];
        if (c >= 'A' && c <= 'Z') {
            c = (char)(c - 'A' + 'a');
        }
        low[i] = c;
    }
    low[i] = '\0';
    return strstr(low, "property not support") != NULL || strstr(low, "errcode=10007") != NULL;
}

// ---------------------------------------------------------------- UUID 渲染与匹配
// ble_uuid_to_str 对 16 位回 "0x%04x"，探针要的是全形式小写；一律自绘。
static void uuid_to_full(const ble_uuid_any_t *u, char *out, size_t cap)
{
    if (!u || cap < 5) {
        if (out && cap) {
            out[0] = '\0';
        }
        return;
    }
    switch (u->u.type == BLE_UUID_TYPE_16 ? 2
            : u->u.type == BLE_UUID_TYPE_32 ? 4
            : u->u.type == BLE_UUID_TYPE_128 ? 16 : 0) {
    case 2:
        snprintf(out, cap, "0000%04x-0000-1000-8000-00805f9b34fb", (unsigned)u->u16.value);
        return;
    case 4:
        snprintf(out, cap, "0000%08x-0000-1000-8000-00805f9b34fb", (unsigned)u->u32.value);
        return;
    case 16: {
        // value 是小端：字符串要从 value[15] 往回读
        char hex[33];
        static const char *hexd = "0123456789abcdef";
        int i;
        for (i = 0; i < 16; i++) {
            uint8_t b = u->u128.value[15 - i];
            hex[i * 2] = hexd[b >> 4];
            hex[i * 2 + 1] = hexd[b & 0x0f];
        }
        hex[32] = '\0';
        snprintf(out, cap, "%.8s-%.4s-%.4s-%.4s-%.12s", hex, hex + 8, hex + 12, hex + 16, hex + 20);
        return;
    }
    default:
        out[0] = '\0';
        return;
    }
}

// uuidHex(u)：去横线 + 小写
static void uuid_hexify(const char *u, char *out, size_t cap)
{
    size_t o = 0;
    size_t i;
    if (!u) {
        if (out && cap) {
            out[0] = '\0';
        }
        return;
    }
    for (i = 0; u[i] && o + 1 < cap; i++) {
        char c = u[i];
        if (c == '-') {
            continue;
        }
        if (c >= 'A' && c <= 'Z') {
            c = (char)(c - 'A' + 'a');
        }
        out[o++] = c;
    }
    out[o] = '\0';
}

// matchUuid(u, target)（uni-ble-api.js:59-67）：入参已是 uuidHex 的结果
static bool uuid_match_hex(const char *a, const char *b)
{
    size_t la, lb;
    const char *short_s, *long_s;
    char padded[40];
    if (!a || !b) {
        return false;
    }
    la = strlen(a);
    lb = strlen(b);
    if (la == 0 || lb == 0) {
        return false;
    }
    if (la == lb) {
        return strcmp(a, b) == 0;
    }
    if (la < lb) {
        short_s = a;
        long_s = b;
    } else {
        short_s = b;
        long_s = a;
    }
    if (strlen(short_s) < 8) {
        size_t need = 8 - strlen(short_s);
        if (need >= sizeof(padded)) {
            return false;
        }
        memset(padded, '0', need);
        memcpy(padded + need, short_s, strlen(short_s) + 1);
        short_s = padded;
    }
    return strncmp(long_s, short_s, strlen(short_s)) == 0;
}

// 与全形式常量比对（等价探针 matchUuid(c.uuid, GATT.write)）
static bool uuid_match_target(const char *full_uuid, const char *target)
{
    char a[40], b[40];
    uuid_hexify(full_uuid, a, sizeof(a));
    uuid_hexify(target, b, sizeof(b));
    return uuid_match_hex(a, b);
}

// String(uuid).replace(/^0000(....).*$/, '$1')：能匹上就取 4 位短号
static const char *uuid_short4(const char *full, char *scratch, size_t cap)
{
    if (full && strlen(full) >= 8 && strncmp(full, "0000", 4) == 0) {
        if (cap >= 5) {
            memcpy(scratch, full + 4, 4);
            scratch[4] = '\0';
            return scratch;
        }
    }
    return full ? full : "";
}

// ---------------------------------------------------------------- 运行状态
static bool s_stack_up;
static uint8_t s_own_addr_type;
static const char *volatile s_state = "idle";
static uint16_t s_conn = 0xFFFF;
static int s_mtu = TLB_MTU_DEFAULT;
static bool s_mtu_negotiating;
static tlb_ble_dev_t s_cur;

// GAP 回调要读扫描上下文，所以声明必须排在所有回调之前
static const tlb_ble_names_t *s_scan_names;
static int s_scan_mode; // 0 空闲 / 1 命中即停 / 2 全部列出 / 3 按 MAC 命中即停
static uint8_t s_scan_addr[6]; // mode 3 的目标地址（ble_addr_t val 序，即显示顺序的倒序）
static uint8_t s_scan_addr_type; // mode 3 的目标地址类型
static bool s_scan_found;
static tlb_ble_dev_t s_scan_dev;
static int s_conn_status; // GAP CONNECT 的 status（0 = 成功）

// TIB（配对/加密）：连接发起前置位，GAP CONNECT 成功回调里真正发起 security procedure。
// 偏离：需求写的是「在 ble_gap_connect 之前调 ble_gap_security_initiate」，但 GAP 在
// 连接建立之前根本没有 conn_handle 可传（ble_gap.h 的 conn_handle 只在链路存在时有效），
// 所以这里保持「connect 之前登记意图」，实际发起落在 CONNECT 成功后的第一个瞬间——
// 仍在 discover_services / 订阅 / 写 0212 之前，配对早于任何业务报文这一硬约束没有变。
static volatile bool s_sec_pending;
static volatile bool s_sec_done;

// 探针 scan() 里那个 seen[]：同一条广播只打一次
#define SEEN_SLOTS 41
static char s_seen[SEEN_SLOTS][TLB_ADV_NAME_MAX];
static int s_seen_n;

// 探针 discover() 里那个 Map<deviceId, rec>
static tlb_ble_dev_t s_adv[TLB_ADV_MAX];
static int s_adv_n;

// 0211 服务与特征
static uint16_t s_svc_start, s_svc_end;
static uint16_t s_write_val, s_ind_val, s_ver_val, s_ind_cccd;
static uint8_t s_ind_props;
static char s_write_id_str[TLB_UUID_STR_MAX];
static bool s_write_props_known; // 对应 writeProps == null
static bool s_write_prop_write, s_write_prop_nr;
static char s_write_type[24];    // 空串 = 探针的 writeType = null
static bool s_subscribed;

typedef struct {
    uint16_t def_handle;
    uint16_t val_handle;
    uint16_t cccd;
    uint8_t props;
    char uuid[TLB_UUID_STR_MAX];
} chr_rec_t;
static chr_rec_t s_chrs[32];
static int s_n_chrs;

static char s_svcs[TLB_UUID_LIST_MAX][TLB_UUID_STR_MAX];
static int s_n_svcs;
static bool s_svc_hit;

// GATT 过程同步
static int s_proc_rc;
static bool s_proc_skip; // 读长值时的中间回调不终结过程

// 分帧重组 + 等待 + 暂存队列
static tlb_frame_t s_frame;
static volatile bool s_armed;
static volatile bool s_abort;
static uint8_t s_wait_body[TLB_FRAME_MAX];
static size_t s_wait_len;
static char s_wait_err[192];
static bool s_buffering;

typedef struct {
    size_t len;
    uint8_t body[TLB_FRAME_MAX];
} qslot_t;
static qslot_t s_queue[BUFFERED_MAX];
static int s_q_head, s_q_count;

static uint8_t s_txbuf[TLB_DISPATCH_FRAME_MAX];
static uint8_t s_notify_buf[TLB_FRAME_NOTIFY_MAX];
static uint8_t s_read_buf[256];
static size_t s_read_len;
static uint16_t s_mtu_result;

// ---------------------------------------------------------------- 小工具
static int64_t now_ms(void)
{
    return tlb_port_now_ms();
}

static void sleep_ms(int64_t ms)
{
    if (ms <= 0) {
        return;
    }
    if (ms > INT32_MAX) {
        ms = INT32_MAX;
    }
    vTaskDelay(pdMS_TO_TICKS((int32_t)ms));
}

static void flush_sem(SemaphoreHandle_t s)
{
    while (s && xSemaphoreTake(s, 0) == pdTRUE) {
    }
}

static size_t copy_str(char *dst, size_t cap, const char *src, size_t src_len)
{
    size_t n = src_len;
    if (cap == 0) {
        return 0;
    }
    if (n > cap - 1) {
        n = cap - 1;
    }
    if (src && n) {
        memcpy(dst, src, n);
    }
    dst[n] = '\0';
    return n;
}

// deviceId = 12 位大写冒号 MAC（val 是小端，val[5] 是最左边的字节）
static void addr_to_id(const ble_addr_t *a, char *out, size_t cap)
{
    snprintf(out, cap, "%02X:%02X:%02X:%02X:%02X:%02X", a->val[5], a->val[4], a->val[3], a->val[2],
             a->val[1], a->val[0]);
}

// addr_to_id 的逆运算：冒号（或纯 12 位）十六进制串 → val 小端序原始字节。
// 分隔符只认 ':'，但位置不限；大小写都可以；任何非十六进制字符即失败。
static bool id_to_addr(const char *id, uint8_t out[6])
{
    uint8_t raw[6];
    size_t n = 0;

    if (!id) {
        return false;
    }
    while (*id && n < 6) {
        uint8_t v = 0;
        int i;
        for (i = 0; i < 2; i++) {
            char c = id[0];
            if (c >= '0' && c <= '9') {
                v = (uint8_t)(v * 16 + (c - '0'));
            } else if (c >= 'A' && c <= 'F') {
                v = (uint8_t)(v * 16 + (c - 'A' + 10));
            } else if (c >= 'a' && c <= 'f') {
                v = (uint8_t)(v * 16 + (c - 'a' + 10));
            } else {
                return false;
            }
            id++;
        }
        raw[n++] = v;
        if (*id == ':') {
            id++;
        }
    }
    if (n != 6 || (*id != '\0')) {
        return false;
    }
    // 显示顺序 raw[0]..raw[5] 对应 val[5]..val[0]
    for (n = 0; n < 6; n++) {
        out[n] = raw[5 - n];
    }
    return true;
}

// 字符串常量版（copy_str 的第四个参数是字节数，这里按 strlen 走，避免到处写 strlen）
static size_t set_str(char *dst, size_t cap, const char *src)
{
    return copy_str(dst, cap, src, src ? strlen(src) : 0);
}

// 探针 m.mode 的那四个字面量（device-matcher.js:makeMatcher）
static const char *mode_text(tlb_match_mode_t m)
{
    switch (m) {
    case TLB_MATCH_EXACT:
        return "exact";
    case TLB_MATCH_PREFIX:
        return "prefix";
    case TLB_MATCH_LOOSE:
        return "loose";
    case TLB_MATCH_LOOSE_PREFIX:
        return "loose-prefix";
    default:
        return "";
    }
}

static void fill_dev(tlb_ble_dev_t *dev, const char *id, const char *name, const ble_addr_t *addr,
                     int8_t rssi, bool tesla, const char *hit, const char *mode)
{
    memset(dev, 0, sizeof(*dev));
    dev->valid = true;
    set_str(dev->id, sizeof(dev->id), id);
    set_str(dev->name, sizeof(dev->name), name);
    set_str(dev->hit, sizeof(dev->hit), hit);
    set_str(dev->mode, sizeof(dev->mode), mode);
    memcpy(dev->addr, addr->val, 6);
    dev->addr_type = addr->type;
    dev->rssi = rssi;
    dev->tesla = tesla;
}

static void seen_reset(void)
{
    s_seen_n = 0;
}

// 返回 true = 之前已经见过（探针 seen.indexOf(n) >= 0）；false = 这一次新加进去
static bool seen_push(const char *name)
{
    int i;
    for (i = 0; i < s_seen_n; i++) {
        if (strcmp(s_seen[i], name) == 0) {
            return true;
        }
    }
    if (s_seen_n < SEEN_SLOTS) {
        set_str(s_seen[s_seen_n], TLB_ADV_NAME_MAX, name);
        s_seen_n++;
    }
    return false;
}

static void adv_reset(void)
{
    s_adv_n = 0;
}

static tlb_ble_dev_t *adv_find_or_add(const char *id)
{
    int i;
    for (i = 0; i < s_adv_n; i++) {
        if (strcmp(s_adv[i].id, id) == 0) {
            return &s_adv[i];
        }
    }
    if (s_adv_n >= TLB_ADV_MAX) {
        return NULL;
    }
    memset(&s_adv[s_adv_n], 0, sizeof(s_adv[s_adv_n]));
    set_str(s_adv[s_adv_n].id, sizeof(s_adv[s_adv_n].id), id);
    s_adv[s_adv_n].valid = true;
    return &s_adv[s_adv_n++];
}

// device-matcher.js:sortAdv
//   rank = hit ? 0 : tesla ? 1 : name ? 2 : 3
//   r    = （是数字且非 0）? rssi : -999
//   比较 = rank 升序 || r 降序 || name localeCompare
// DEFER: localeCompare 换 strcmp —— 名字全是 ASCII（Tesla 723591 / S+16hex），
// 只有车主塞进中文时才可能与 ICU 排序不同，不影响选车。
static int adv_rank(const tlb_ble_dev_t *e)
{
    if (e->hit[0]) {
        return 0;
    }
    if (e->tesla) {
        return 1;
    }
    if (e->name[0]) {
        return 2;
    }
    return 3;
}

static int adv_rssi_key(const tlb_ble_dev_t *e)
{
    return e->rssi ? (int)e->rssi : -999;
}

static int adv_cmp(const tlb_ble_dev_t *a, const tlb_ble_dev_t *b)
{
    int d = adv_rank(a) - adv_rank(b);
    if (d) {
        return d;
    }
    d = adv_rssi_key(b) - adv_rssi_key(a);
    if (d) {
        return d;
    }
    return strcmp(a->name, b->name);
}

static int adv_sorted(tlb_ble_dev_t *list, size_t cap)
{
    int i, j, n = s_adv_n;
    if ((size_t)n > cap) {
        n = (int)cap;
    }
    for (i = 0; i < s_adv_n && i < n; i++) {
        list[i] = s_adv[i];
    }
    for (i = 1; i < n; i++) {
        tlb_ble_dev_t key = list[i];
        j = i - 1;
        while (j >= 0 && adv_cmp(&list[j], &key) > 0) {
            list[j + 1] = list[j];
            j--;
        }
        list[j + 1] = key;
    }
    return n;
}

// ---------------------------------------------------------------- 队列与等待
static void queue_clear(void)
{
    s_q_head = 0;
    s_q_count = 0;
}

static void queue_push(const uint8_t *body, size_t len)
{
    int idx;
    if (len > TLB_FRAME_MAX) {
        len = TLB_FRAME_MAX;
    }
    if (s_q_count >= BUFFERED_MAX) {
        s_q_head = (s_q_head + 1) % BUFFERED_MAX;
        s_q_count--;
    }
    idx = (s_q_head + s_q_count) % BUFFERED_MAX;
    memcpy(s_queue[idx].body, body, len);
    s_queue[idx].len = len;
    s_q_count++;
}

static bool queue_shift(uint8_t *out, size_t cap, size_t *len)
{
    int idx;
    size_t n;
    if (s_q_count <= 0) {
        return false;
    }
    idx = s_q_head;
    n = s_queue[idx].len;
    if (n > cap) {
        n = cap;
    }
    memcpy(out, s_queue[idx].body, n);
    *len = n;
    s_q_head = (s_q_head + 1) % BUFFERED_MAX;
    s_q_count--;
    return true;
}

// 探针 deliver(body) 的第一个分支：命中一个等待者
static void deliver(const uint8_t *body, size_t len)
{
    if (s_armed) {
        s_armed = false;
        s_abort = false;
        s_wait_err[0] = '\0';
        s_wait_len = len > TLB_FRAME_MAX ? TLB_FRAME_MAX : len;
        memcpy(s_wait_body, body, s_wait_len);
        xSemaphoreGive(s_rx_sem);
        return;
    }
    if (s_buffering) {
        queue_push(body, len);
        Lbegin();
        Lput("暂存车辆推送（队列 ");
        Lfmt("%d", s_q_count);
        Lput(" 帧）");
        Lhex(body, len);
        Lend(TLB_LOG_INFO);
        return;
    }
    Lbegin();
    Lput("无人等待的响应（车辆主动上报？）");
    Lhex(body, len);
    Lend(TLB_LOG_INFO);
}

// 对应 FrameReassembler 的 onFrame
static void on_reasm_frame(void *ud, const uint8_t *body, size_t body_len)
{
    (void)ud;
    deliver(body, body_len);
}

static void reject_all(const char *text)
{
    if (s_armed) {
        s_armed = false;
        s_abort = true;
        s_wait_len = 0;
        copy_str(s_wait_err, sizeof(s_wait_err), text, strlen(text));
        xSemaphoreGive(s_rx_sem);
    }
    tlb_frame_reset(&s_frame);
    queue_clear();
}

static void arm_waiter(void)
{
    flush_sem(s_rx_sem);
    s_wait_len = 0;
    s_wait_err[0] = '\0';
    s_abort = false;
    s_armed = true;
}

// 超时文案只进 s_wait_err 给上层，不多打一行日志：借道行缓冲取格式化能力，
// 用完立刻丢弃内容并放锁（探针 send() 超时那一支就是纯 reject）。
static void wait_timeout_text(int64_t ms)
{
    Lbegin();
    Lput("等待车辆响应超时 ");
    Lfmt("%lld", (long long)ms);
    Lput("ms（可能没订阅成功 / 车辆休眠 / MTU 不足）");
    copy_str(s_wait_err, sizeof(s_wait_err), s_line, s_line_len);
    s_line_len = 0;
    s_line[0] = '\0';
    s_line_mtx_give();
}

// 1 = 命中（返回帧体长度），0 = 超时，-1 = 被中止（BLE 已断开 / 主动断开 / 写失败）
static int wait_frame(int64_t ms, uint8_t *out, size_t cap)
{
    int rc;
    if (ms <= 0) {
        ms = 1;
    }
    if (ms > INT32_MAX) {
        ms = INT32_MAX;
    }
    rc = xSemaphoreTake(s_rx_sem, pdMS_TO_TICKS((int32_t)ms));
    if (rc != pdTRUE) {
        s_armed = false;
        // 日志由 receive() 自己打（探针在 :499 那支才 log）
        wait_timeout_text(ms);
        return 0;
    }
    if (s_abort) {
        s_abort = false;
        return -1;
    }
    {
        size_t n = s_wait_len > cap ? cap : s_wait_len;
        memcpy(out, s_wait_body, n);
        return (int)n;
    }
}

// ---------------------------------------------------------------- GATT 过程回调
static int svc_cb(uint16_t conn_handle, const struct ble_gatt_error *error,
                  const struct ble_gatt_svc *service, void *arg)
{
    (void)conn_handle;
    (void)arg;
    if (error->status == 0 && service != NULL) {
        char full[TLB_UUID_STR_MAX];
        uuid_to_full(&service->uuid, full, sizeof(full));
        if (s_n_svcs < TLB_UUID_LIST_MAX) {
            copy_str(s_svcs[s_n_svcs], TLB_UUID_STR_MAX, full, strlen(full));
            s_n_svcs++;
        }
        if (uuid_match_target(full, GATT_SERVICE)) {
            s_svc_start = service->start_handle;
            s_svc_end = service->end_handle;
            s_svc_hit = true;
        }
        return 0;
    }
    s_proc_rc = (error->status == 0 || error->status == BLE_HS_EDONE) ? 0 : error->status;
    xSemaphoreGive(s_proc_sem);
    return 0;
}

static int chr_cb(uint16_t conn_handle, const struct ble_gatt_error *error,
                  const struct ble_gatt_chr *chr, void *arg)
{
    (void)conn_handle;
    (void)arg;
    if (error->status == 0 && chr != NULL) {
        chr_rec_t *rec;
        if (s_n_chrs >= (int)(sizeof(s_chrs) / sizeof(s_chrs[0]))) {
            return 0;
        }
        rec = &s_chrs[s_n_chrs];
        rec->def_handle = chr->def_handle;
        rec->val_handle = chr->val_handle;
        rec->cccd = 0;
        rec->props = chr->properties;
        uuid_to_full(&chr->uuid, rec->uuid, sizeof(rec->uuid));
        s_n_chrs++;
        if (uuid_match_target(rec->uuid, GATT_WRITE)) {
            s_write_val = chr->val_handle;
            s_write_props_known = true;
            s_write_prop_write = (chr->properties & CHR_PROP_WRITE) != 0;
            s_write_prop_nr = (chr->properties & CHR_PROP_WRITE_NO_RSP) != 0;
            copy_str(s_write_id_str, sizeof(s_write_id_str), rec->uuid, strlen(rec->uuid));
        } else if (uuid_match_target(rec->uuid, GATT_INDICATE)) {
            s_ind_val = chr->val_handle;
            s_ind_props = chr->properties;
        } else if (uuid_match_target(rec->uuid, GATT_VERSION)) {
            s_ver_val = chr->val_handle;
        }
        return 0;
    }
    s_proc_rc = (error->status == 0 || error->status == BLE_HS_EDONE) ? 0 : error->status;
    xSemaphoreGive(s_proc_sem);
    return 0;
}

static int dsc_cb(uint16_t conn_handle, const struct ble_gatt_error *error,
                  uint16_t chr_val_handle, const struct ble_gatt_dsc *dsc, void *arg)
{
    uint16_t *slot = (uint16_t *)arg;
    (void)conn_handle;
    (void)chr_val_handle;
    if (error->status == 0 && dsc != NULL) {
        if (slot && dsc->uuid.u.type == BLE_UUID_TYPE_16 && dsc->uuid.u16.value == CCCD_UUID) {
            *slot = dsc->handle;
        }
        return 0;
    }
    s_proc_rc = (error->status == 0 || error->status == BLE_HS_EDONE) ? 0 : error->status;
    xSemaphoreGive(s_proc_sem);
    return 0;
}

// read 与 write 共用：read 会多次回调（长读），最后一次带非 0 状态收尾
static int attr_cb(uint16_t conn_handle, const struct ble_gatt_error *error,
                   struct ble_gatt_attr *attr, void *arg)
{
    (void)conn_handle;
    (void)arg;
    if (error->status == 0 && attr != NULL) {
        if (s_proc_skip) { // 读路径：把数据收进 s_read_buf，继续等下一段
            uint16_t olen = 0;
            if (attr->om) {
                ble_hs_mbuf_to_flat(attr->om, s_read_buf + s_read_len,
                                    (uint16_t)(sizeof(s_read_buf) - s_read_len), &olen);
                s_read_len += olen;
            }
            return 0;
        }
        s_proc_rc = 0;
        xSemaphoreGive(s_proc_sem);
        return 0;
    }
    s_proc_rc = (error->status == BLE_HS_EDONE) ? 0 : error->status;
    xSemaphoreGive(s_proc_sem);
    return 0;
}

static int mtu_cb(uint16_t conn_handle, const struct ble_gatt_error *error, uint16_t mtu,
                  void *arg)
{
    (void)conn_handle;
    (void)arg;
    if (error->status == 0 || error->status == BLE_HS_EDONE) {
        s_mtu_result = mtu;
        s_proc_rc = 0;
    } else {
        s_mtu_result = 0;
        s_proc_rc = error->status;
    }
    xSemaphoreGive(s_proc_sem);
    return 0;
}

static bool wait_proc(int64_t ms)
{
    flush_sem(s_proc_sem);
    s_proc_rc = 0;
    if (xSemaphoreTake(s_proc_sem, pdMS_TO_TICKS((int32_t)ms)) != pdTRUE) {
        s_proc_rc = BLE_HS_ETIMEOUT;
        return false;
    }
    return true;
}

// ---------------------------------------------------------------- GAP 事件
static void on_disc_report(struct ble_gap_event *event)
{
    struct ble_hs_adv_fields fields;
    char name[TLB_ADV_NAME_MAX] = "";
    char id[TLB_BLE_ID_MAX];
    bool tesla = false;
    int rc;

    if (event->disc.data == NULL || event->disc.length_data == 0) {
        rc = 0;
    } else {
        rc = ble_hs_adv_parse_fields(&fields, event->disc.data, event->disc.length_data);
    }
    if (rc != 0) {
        return; // 广播数据不合规：探针那边由系统过滤，这里跳过
    }
    if (rc == 0 && fields.name != NULL && fields.name_len > 0) {
        copy_str(name, sizeof(name), (const char *)fields.name, fields.name_len);
    }
    // 服务 UUID：16/32 位用短形式（uni 在安卓上回的也是短形式），128 位保持全形式
    {
        uint8_t i;
        char scratch[TLB_UUID_STR_MAX];
        if (fields.uuids16 != NULL) {
            for (i = 0; i < fields.num_uuids16; i++) {
                snprintf(scratch, sizeof(scratch), "%04x", (unsigned)fields.uuids16[i].value);
                if (tlb_uuid_is_tesla_service(scratch)) {
                    tesla = true;
                }
            }
        }
        if (fields.uuids32 != NULL) {
            for (i = 0; i < fields.num_uuids32; i++) {
                snprintf(scratch, sizeof(scratch), "%08x", (unsigned)fields.uuids32[i].value);
                if (tlb_uuid_is_tesla_service(scratch)) {
                    tesla = true;
                }
            }
        }
        if (fields.uuids128 != NULL) {
            for (i = 0; i < fields.num_uuids128; i++) {
                uuid_to_full((const ble_uuid_any_t *)&fields.uuids128[i], scratch,
                             sizeof(scratch));
                if (tlb_uuid_is_tesla_service(scratch)) {
                    tesla = true;
                }
            }
        }
    }
    addr_to_id(&event->disc.addr, id, sizeof(id));

    if (s_scan_mode == 3) {
        // 按 MAC 命中即停。偏离：探针没有这条路（Android 拿 deviceId 直连由系统负责扫描），
        // 设备侧必须自己把目标广播收进来才允许发起连接，所以这行日志也是设备侧专有文案。
        if (s_scan_found) {
            return;
        }
        if (memcmp(event->disc.addr.val, s_scan_addr, 6) != 0 ||
            event->disc.addr.type != s_scan_addr_type) {
            return;
        }
        Lbegin();
        Lput("按 MAC 命中目标车辆 name=");
        Lput(name[0] ? name : "(无名)");
        Lput(" id=");
        Lput(id);
        Lput(" rssi=");
        Lfmt("%d", (int)event->disc.rssi);
        Lend(TLB_LOG_OK);
        fill_dev(&s_scan_dev, id, name, &event->disc.addr, event->disc.rssi, tesla, "", "");
        s_scan_found = true;
        xSemaphoreGive(s_scan_sem);
        return;
    }

    if (s_scan_mode == 1) {
        char matched[TLB_ADV_NAME_MAX] = "";
        tlb_match_mode_t m;
        if (s_scan_found) {
            return;
        }
        m = s_scan_names ? tlb_match_adv_name(s_scan_names, name, matched, sizeof(matched))
                         : TLB_MATCH_NONE;
        if (m != TLB_MATCH_NONE) {
            Lbegin();
            Lput("发现车辆 name=");
            Lput(name);
            Lput(" (");
            Lput(mode_text(m));
            Lput(" 命中 ");
            Lput(matched);
            Lput(") id=");
            Lput(id);
            Lend(TLB_LOG_OK);
            fill_dev(&s_scan_dev, id, name, &event->disc.addr, event->disc.rssi, tesla, matched,
                     mode_text(m));
            s_scan_found = true;
            xSemaphoreGive(s_scan_sem);
            return;
        }
        if (name[0] == '\0' && tesla) {
            Lbegin();
            Lput("发现疑似车辆（无名，但广播了 0211 服务）id=");
            Lput(id);
            Lend(TLB_LOG_OK);
            fill_dev(&s_scan_dev, id, name, &event->disc.addr, event->disc.rssi, tesla, "", "");
            s_scan_found = true;
            xSemaphoreGive(s_scan_sem);
            return;
        }
        {
            char norm[TLB_ADV_NAME_MAX];
            tlb_norm_name(name, norm, sizeof(norm));
            if (name[0] != '\0' && strstr(norm, "TESLA") != NULL && !seen_push(name)) {
                Lbegin();
                Lput("广播名含 TESLA 但未命中期望名: \"");
                Lput(name);
                Lput("\" rssi=");
                Lfmt("%d", (int)event->disc.rssi);
                Lput(" —— 若这是本车，把它补进匹配规则");
                Lend(TLB_LOG_WARN);
                return;
            }
            if (name[0] != '\0' && !seen_push(name)) {
                if (s_seen_n <= TLB_SEEN_MAX) {
                    Lbegin();
                    Lput("广播中: ");
                    Lput(name);
                    Lput(" rssi=");
                    Lfmt("%d", (int)event->disc.rssi);
                    Lend(TLB_LOG_RX);
                }
            }
        }
        return;
    }

    if (s_scan_mode == 2) {
        // discover()：按 deviceId 归并（device-matcher.js:sortAdv 之前那张 Map）
        tlb_ble_dev_t *rec = adv_find_or_add(id);
        char matched[TLB_ADV_NAME_MAX] = "";
        tlb_match_mode_t m;
        if (!rec) {
            return;
        }
        if (name[0] == '\0' && rec->name[0] != '\0') {
            copy_str(name, sizeof(name), rec->name, strlen(rec->name));
        }
        m = (name[0] != '\0' && s_scan_names)
                ? tlb_match_adv_name(s_scan_names, name, matched, sizeof(matched))
                : TLB_MATCH_NONE;
        copy_str(rec->name, sizeof(rec->name), name, strlen(name));
        rec->rssi = event->disc.rssi;
        rec->tesla = tesla || rec->tesla;
        memcpy(rec->addr, event->disc.addr.val, 6);
        rec->addr_type = event->disc.addr.type;
        rec->valid = true;
        if (m != TLB_MATCH_NONE) {
            copy_str(rec->hit, sizeof(rec->hit), matched, strlen(matched));
            copy_str(rec->mode, sizeof(rec->mode), mode_text(m), strlen(mode_text(m)));
        }
        return;
    }
}

static void on_notify(struct ble_gap_event *event)
{
    uint16_t olen = 0;
    if (event->notify_rx.conn_handle != s_conn) {
        return;
    }
    if (event->notify_rx.om == NULL) {
        return;
    }
    ble_hs_mbuf_to_flat(event->notify_rx.om, s_notify_buf, sizeof(s_notify_buf), &olen);
    if (olen == 0) {
        return;
    }
    if (event->notify_rx.attr_handle != s_ind_val) {
        const char *who = NULL;
        char scratch[TLB_UUID_STR_MAX];
        int i;
        for (i = 0; i < s_n_chrs; i++) {
            if (s_chrs[i].val_handle == event->notify_rx.attr_handle) {
                who = s_chrs[i].uuid;
                break;
            }
        }
        if (!who) {
            snprintf(scratch, sizeof(scratch), "handle 0x%04x",
                     (unsigned)event->notify_rx.attr_handle);
            who = scratch;
        }
        Lbegin();
        Lput("收到非 0213 特征 ");
        Lput(who);
        Lput(" 的数据 ");
        Lhex(s_notify_buf, olen);
        Lend(TLB_LOG_RX);
    }
    // 探针不因为「不是 0213」就丢掉：照样进重组器
    tlb_frame_push(&s_frame, s_notify_buf, olen, now_ms(), on_reasm_frame, NULL);
}

static void on_mtu_event(struct ble_gap_event *event)
{
    int m = (int)event->mtu.value;
    if (s_mtu_negotiating) {
        if (m > 0) {
            s_mtu = m; // 协商期间只记账，文案由 negotiate_mtu 统一打
        }
        return;
    }
    if (m > 0 && m != s_mtu) {
        s_mtu = m;
        Lbegin();
        Lput("MTU 变更（车辆侧回读）= ");
        Lfmt("%d", m);
        Lput("，分包按每包 ");
        Lfmt("%u", (unsigned)tlb_payload_cap(m));
        Lput(" 字节");
        Lend(TLB_LOG_OK);
    }
}

static void on_disconnect(struct ble_gap_event *event)
{
    if (event->disconnect.conn.conn_handle != s_conn) {
        return;
    }
    s_conn = 0xFFFF;
    s_state = "disconnected";
    s_subscribed = false;
    Lbegin();
    Lput("连接已断开（车辆 3 台钥匙上限 / 车机休眠 / 距离都可能是原因）");
    Lend(TLB_LOG_WARN);
    reject_all("BLE 已断开");
    flush_sem(s_conn_sem);
    xSemaphoreGive(s_conn_sem);
}

static int gap_cb(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            s_conn = event->connect.conn_handle;
            s_conn_status = 0;
            // TIB：链路一存在就立刻发起安全过程（早于枚举服务 / 订阅 / 写 0212）
            if (s_sec_pending) {
                int rc = ble_gap_security_initiate(event->connect.conn_handle);
                if (rc != 0) {
                    char t[64];
                    rc_text(rc, t, sizeof(t));
                    s_sec_done = true;
                    xSemaphoreGive(s_sec_sem);
                    Lbegin();
                    Lput("发起配对失败: ");
                    Lput(t);
                    Lend(TLB_LOG_WARN);
                }
            }
        } else {
            s_conn_status = event->connect.status;
        }
        xSemaphoreGive(s_conn_sem);
        return 0;
    case BLE_GAP_EVENT_ENC_CHANGE:
        // 偏离：需求里的「配对结果」在 NimBLE 里就是 ENC_CHANGE（没有 BLE_GAP_EVENT_SECURITY）。
        // 只打文本、不打数字码；无论成功与否都让 connect 的有界等待立刻返回。
        s_sec_done = true;
        Lbegin();
        if (event->enc_change.status == 0) {
            Lput("配对/加密已完成（bond 已保留到 NVS）");
            Lend(TLB_LOG_OK);
        } else {
            char t[64];
            rc_text(event->enc_change.status, t, sizeof(t));
            Lput("配对/加密未成功: ");
            Lput(t);
            Lput(" —— 继续按未加密链路尝试");
            Lend(TLB_LOG_WARN);
        }
        xSemaphoreGive(s_sec_sem);
        return 0;
    case BLE_GAP_EVENT_DISCONNECT:
        on_disconnect(event);
        return 0;
    case BLE_GAP_EVENT_DISC:
        on_disc_report(event);
        return 0;
    case BLE_GAP_EVENT_NOTIFY_RX:
        on_notify(event);
        return 0;
    case BLE_GAP_EVENT_MTU:
        on_mtu_event(event);
        return 0;
    default:
        return 0;
    }
}

// ---------------------------------------------------------------- 蓝牙栈启动
static void on_host_sync(void)
{
    int rc = ble_hs_util_ensure_addr(0);
    if (rc == 0) {
        rc = ble_hs_id_infer_auto(0, &s_own_addr_type);
    }
    if (rc == 0) {
        s_stack_up = true;
    } else {
        tlb_ble_log(TLB_LOG_ERROR, "拿不到本机蓝牙地址，扫描和连接都不可用");
    }
    xSemaphoreGive(s_sync_sem);
}

static void on_host_reset(int reason)
{
    s_stack_up = false;
    s_conn = 0xFFFF;
    s_state = "idle";
    (void)reason;
    tlb_ble_log(TLB_LOG_WARN, "蓝牙栈已复位（controller 重启），请重新连接车辆");
}

static void host_task(void *param)
{
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

esp_err_t tlb_ble_stack_start(void)
{
    if (s_line_mtx == NULL) {
        s_line_mtx = xSemaphoreCreateMutex();
    }
    if (s_ble_mtx == NULL) {
        s_ble_mtx = xSemaphoreCreateMutex();
    }
    if (s_rx_sem == NULL) {
        s_rx_sem = xSemaphoreCreateBinary();
    }
    if (s_proc_sem == NULL) {
        s_proc_sem = xSemaphoreCreateBinary();
    }
    if (s_conn_sem == NULL) {
        s_conn_sem = xSemaphoreCreateBinary();
    }
    if (s_scan_sem == NULL) {
        s_scan_sem = xSemaphoreCreateBinary();
    }
    if (s_sync_sem == NULL) {
        s_sync_sem = xSemaphoreCreateBinary();
    }
    if (s_sec_sem == NULL) {
        s_sec_sem = xSemaphoreCreateBinary();
    }
    if (s_stack_up) {
        return ESP_OK;
    }
    // 首选 MTU 先钉到最高档，之后每档试探时再降（对应 uni 的 setBLEMTU 阶梯）
    ble_att_set_preferred_mtu(517);
    if (nimble_port_init() != ESP_OK) {
        tlb_ble_log(TLB_LOG_ERROR, "蓝牙栈初始化失败（NimBLE host 起不来）");
        return ESP_FAIL;
    }
    ble_hs_cfg.sync_cb = on_host_sync;
    ble_hs_cfg.reset_cb = on_host_reset;
    // TIB：配对能力。车辆是 NoInputNoOutput，所以 mitm 必须留 0（置 1 会让 SM 判定
    // 「认证要求无法满足」直接拒配）；sc 开、但不强制 sc_only，兼容老固件回落 Legacy。
    // bond 的落盘不显式调 ble_store_config_init()（该符号只在非公开头里），
    // 靠 CONFIG_BT_NIMBLE_NVS_PERSIST=y 让 NimBLE 自己把 peer 写进 NVS 并在下次 sync 时读回。
    ble_hs_cfg.sm_bonding = 1;
    ble_hs_cfg.sm_mitm = 0;
    ble_hs_cfg.sm_sc = 1;
    ble_hs_cfg.sm_our_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    nimble_port_freertos_init(host_task);
    if (xSemaphoreTake(s_sync_sem, pdMS_TO_TICKS(5000)) != pdTRUE) {
        tlb_ble_log(TLB_LOG_ERROR, "蓝牙栈 5000ms 没有就绪");
        return ESP_ERR_TIMEOUT;
    }
    tlb_ble_log(TLB_LOG_OK, "蓝牙适配器已开启 available=true discovering=false");
    return s_stack_up ? ESP_OK : ESP_FAIL;
}

// ---------------------------------------------------------------- 扫描
static void scan_stop(void)
{
    (void)ble_gap_disc_cancel();
    s_scan_mode = 0;
}

int tlb_ble_scan(const tlb_ble_names_t *names, int64_t timeout_ms, tlb_ble_dev_t *out, char *err,
                 size_t err_cap)
{
    struct ble_gap_disc_params params;
    int64_t limit = (timeout_ms > 0) ? timeout_ms : 15000;
    int rc;

    if (err && err_cap) {
        err[0] = '\0';
    }
    if (!s_stack_up) {
        if (err && err_cap) {
            set_str(err, err_cap, "蓝牙栈没有起来：设备侧蓝牙只能在栈就绪后用");
        }
        return -1;
    }
    if (s_conn != 0xFFFF) {
        if (err && err_cap) {
            set_str(err, err_cap, "已经有连接，先断开再扫描");
        }
        return -1;
    }

    seen_reset();
    adv_reset();
    s_scan_found = false;
    memset(&s_scan_dev, 0, sizeof(s_scan_dev));
    s_scan_names = names;
    flush_sem(s_scan_sem);

    memset(&params, 0, sizeof(params));
    params.itvl = 0x0120;              // 187.5ms
    params.window = 0x0060;            // 60ms
    params.filter_policy = 0;
    params.passive = 0;
    params.filter_duplicates = 1;      // allowDuplicatesKey:false
    rc = ble_gap_disc(s_own_addr_type, 0, &params, gap_cb, NULL);
    if (rc != 0) {
        char t[64];
        rc_text(rc, t, sizeof(t));
        Lbegin();
        Lput("开始扫描失败: ");
        Lput(t);
        Lend(TLB_LOG_ERROR);
        if (err && err_cap) {
            copy_str(err, err_cap, t, strlen(t));
        }
        return -1;
    }

    Lbegin();
    Lput("开始扫描（匹配 ");
    if (names) {
        bool first = true;
        if (names->exact[0]) {
            Lput(names->exact);
            first = false;
        }
        if (names->prefix[0]) {
            if (!first) {
                Lput(" / ");
            }
            Lput(names->prefix);
        }
    }
    Lput("）");
    Lend(TLB_LOG_INFO);
    s_state = "scanning";
    s_scan_mode = 1;

    if (xSemaphoreTake(s_scan_sem, pdMS_TO_TICKS((int32_t)limit)) != pdTRUE && !s_scan_found) {
        Lbegin();
        Lput("扫描 ");
        Lfmt("%lld", (long long)limit);
        Lput("ms 未发现目标车辆；请核对 VIN，或用「全部广播」页看车到底在不在");
        Lend(TLB_LOG_WARN);
        scan_stop();
        s_state = "idle";
        return 0;
    }
    scan_stop();
    s_state = "idle";
    if (out) {
        *out = s_scan_dev;
    }
    return 1;
}

// 偏离：探针没有这条路径（Android 的 deviceId 直连由系统负责扫描）。设备侧必须先把目标
// 广播收进来了才允许 ble_gap_connect，所以这里复用 tlb_ble_scan 的全部形状，只把匹配
// 判据换成对端地址；文案是设备侧专有措辞，不复用「请核对 VIN」那句。
int tlb_ble_scan_mac(const char *mac, uint8_t addr_type, int64_t timeout_ms, tlb_ble_dev_t *out,
                     char *err, size_t err_cap)
{
    struct ble_gap_disc_params params;
    int64_t limit = (timeout_ms > 0) ? timeout_ms : 15000;
    int rc;

    if (err && err_cap) {
        err[0] = '\0';
    }
    if (!s_stack_up) {
        set_str(err, err_cap, "蓝牙栈没有起来：设备侧蓝牙只能在栈就绪后用");
        return -1;
    }
    if (s_conn != 0xFFFF) {
        set_str(err, err_cap, "已经有连接，先断开再扫描");
        return -1;
    }
    if (!id_to_addr(mac, s_scan_addr)) {
        set_str(err, err_cap, "MAC 地址不合法（要 84:16:5C:75:51:B9 这种形式）");
        return -1;
    }
    s_scan_addr_type = addr_type;

    seen_reset();
    adv_reset();
    s_scan_found = false;
    memset(&s_scan_dev, 0, sizeof(s_scan_dev));
    s_scan_names = NULL;
    flush_sem(s_scan_sem);

    memset(&params, 0, sizeof(params));
    params.itvl = 0x0120;              // 187.5ms
    params.window = 0x0060;            // 60ms
    params.filter_policy = 0;
    params.passive = 0;
    params.filter_duplicates = 1;      // allowDuplicatesKey:false
    rc = ble_gap_disc(s_own_addr_type, 0, &params, gap_cb, NULL);
    if (rc != 0) {
        char t[64];
        rc_text(rc, t, sizeof(t));
        Lbegin();
        Lput("开始扫描失败: ");
        Lput(t);
        Lend(TLB_LOG_ERROR);
        set_str(err, err_cap, t);
        return -1;
    }

    Lbegin();
    Lput("开始扫描（按 MAC ");
    Lput(mac ? mac : "");
    Lput("）");
    Lend(TLB_LOG_INFO);
    s_state = "scanning";
    s_scan_mode = 3;

    if (xSemaphoreTake(s_scan_sem, pdMS_TO_TICKS((int32_t)limit)) != pdTRUE && !s_scan_found) {
        Lbegin();
        Lput("扫描 ");
        Lfmt("%lld", (long long)limit);
        Lput("ms 没有收到目标 MAC 的广播（车辆可能在休眠 / 距离太远 / 换过随机地址）");
        Lend(TLB_LOG_WARN);
        scan_stop();
        s_state = "idle";
        return 0;
    }
    scan_stop();
    s_state = "idle";
    if (out) {
        *out = s_scan_dev;
    }
    return 1;
}

// 档案里只有 deviceId 字符串时，用它在本地构造一条可连接的记录（不需要先扫描）。
bool tlb_ble_dev_from_id(const char *device_id, uint8_t addr_type, tlb_ble_dev_t *out)
{
    ble_addr_t a;
    int i;

    if (!out) {
        return false;
    }
    memset(out, 0, sizeof(*out));
    if (!id_to_addr(device_id, a.val)) {
        return false;
    }
    a.type = addr_type;
    out->valid = true;
    addr_to_id(&a, out->id, sizeof(out->id));
    for (i = 0; i < 6; i++) {
        out->addr[i] = a.val[i];
    }
    out->addr_type = addr_type;
    return true;
}

int tlb_ble_discover(int64_t timeout_ms, const tlb_ble_names_t *names, tlb_ble_dev_t *list,
                     size_t cap, char *err, size_t err_cap)
{
    struct ble_gap_disc_params params;
    int64_t limit = (timeout_ms > 0) ? timeout_ms : 12000;
    int rc, i, n;

    if (err && err_cap) {
        err[0] = '\0';
    }
    if (!s_stack_up) {
        if (err && err_cap) {
            set_str(err, err_cap, "蓝牙栈没有起来：设备侧蓝牙只能在栈就绪后用");
        }
        return -1;
    }

    seen_reset();
    adv_reset();
    s_scan_names = names;
    memset(&params, 0, sizeof(params));
    params.itvl = 0x0120;
    params.window = 0x0060;
    params.passive = 0;
    params.filter_duplicates = 1;
    rc = ble_gap_disc(s_own_addr_type, 0, &params, gap_cb, NULL);
    if (rc != 0) {
        char t[64];
        rc_text(rc, t, sizeof(t));
        if (err && err_cap) {
            copy_str(err, err_cap, t, strlen(t));
        }
        return -1;
    }
    Lbegin();
    Lput("扫描中（");
    Lfmt("%lld", (long long)limit);
    Lput("ms，全部列出手选）");
    Lend(TLB_LOG_INFO);
    s_state = "scanning";
    s_scan_mode = 2;

    vTaskDelay(pdMS_TO_TICKS((int32_t)limit));
    scan_stop();
    s_state = "idle";

    n = adv_sorted(list, cap);
    for (i = 0; i < n; i++) {
        Lbegin();
        Lput("广播中: ");
        Lput(list[i].name[0] ? list[i].name : "(无名) ");
        Lput(list[i].id);
        Lput(" rssi=");
        Lfmt("%d", (int)list[i].rssi);
        if (list[i].tesla) {
            Lput(" 0211");
        }
        if (list[i].mode[0]) {
            Lput(" (");
            Lput(list[i].mode);
            Lput(" 命中 ");
            Lput(list[i].hit);
            Lput(")");
        }
        Lend(TLB_LOG_RX);
    }
    return n;
}

// ---------------------------------------------------------------- 服务发现
// writePropsText(p)：known=false 对应探针里 p === null（特征不存在或没上报属性）
static void props_text_of(bool known, bool wr, bool nr)
{
    if (!known) {
        Lput("未上报");
        return;
    }
    Lput("write=");
    Lput(wr ? "y" : "n");
    Lput(" writeNoResponse=");
    Lput(nr ? "y" : "n");
}

static void props_text_append(const char *label)
{
    Lput(label);
    Lput(": ");
    props_text_of(s_write_props_known, s_write_prop_write, s_write_prop_nr);
}

// 探针 writePropsText(p)：p 为 null → 未上报
static void props_of(uint8_t props, bool *known, bool *wr, bool *nr)
{
    if (props == 0) {
        *known = false;
        *wr = false;
        *nr = false;
        return;
    }
    *known = true;
    *wr = (props & CHR_PROP_WRITE) != 0;
    *nr = (props & CHR_PROP_WRITE_NO_RSP) != 0;
}

static int candidates_order(const char **out)
{
    const char *c[2];
    int n = 0;
    bool has_nr = false, has_req = false;
    if (s_write_props_known && s_write_prop_nr) {
        c[n++] = WRITE_NR;
        has_nr = true;
    }
    if (s_write_props_known && s_write_prop_write) {
        c[n++] = WRITE_REQ;
        has_req = true;
    }
    if (!has_nr) {
        c[n++] = WRITE_NR;
    }
    if (!has_req) {
        c[n++] = WRITE_REQ;
    }
    out[0] = c[0];
    out[1] = c[1];
    return 2;
}

// 探针 writeTypeOrder()：已确定的写法排最前
static int write_type_order(const char **out)
{
    const char *c[2];
    int n = candidates_order(c);
    if (s_write_type[0]) {
        int k;
        for (k = 0; k < n; k++) {
            if (strcmp(c[k], s_write_type) == 0) {
                out[0] = c[k];
                out[1] = (n == 2) ? c[1 - k] : c[0];
                return 2;
            }
        }
    }
    out[0] = c[0];
    out[1] = c[1];
    return 2;
}

static bool discover_services(char *err, size_t err_cap)
{
    int i;
    bool have_write = false, have_ind = false;

    s_n_svcs = 0;
    s_n_chrs = 0;
    s_svc_hit = false;
    s_write_val = 0;
    s_ind_val = 0;
    s_ver_val = 0;
    s_ind_cccd = 0;
    s_ind_props = 0;
    s_write_props_known = false;
    s_write_prop_write = false;
    s_write_prop_nr = false;
    s_write_id_str[0] = '\0';
    s_write_type[0] = '\0'; // 探针：每次重新发现服务都按车端上报的属性重算

    if (ble_gattc_disc_all_svcs(s_conn, svc_cb, NULL) != 0) {
        char t[64];
        rc_text(s_proc_rc, t, sizeof(t));
        copy_str(err, err_cap, t, strlen(t));
        return false;
    }
    if (!wait_proc(GATT_PROC_MS)) {
        set_str(err, err_cap, "服务发现超时");
        return false;
    }
    if (s_proc_rc != 0) {
        char t[64];
        rc_text(s_proc_rc, t, sizeof(t));
        copy_str(err, err_cap, t, strlen(t));
        return false;
    }
    if (!s_svc_hit) {
        Lbegin();
        Lput("没找到特斯拉 VCSEC 服务 0211，实际服务: ");
        for (i = 0; i < s_n_svcs; i++) {
            if (i) {
                Lput(", ");
            }
            Lput(s_svcs[i]);
        }
        copy_str(err, err_cap, s_line, s_line_len);
        s_line_len = 0;
        s_line[0] = '\0';
        s_line_mtx_give();
        return false;
    }

    if (ble_gattc_disc_all_chrs(s_conn, s_svc_start, s_svc_end, chr_cb, NULL) != 0) {
        set_str(err, err_cap, "特征发现发起失败");
        return false;
    }
    if (!wait_proc(GATT_PROC_MS)) {
        set_str(err, err_cap, "特征发现超时");
        return false;
    }

    for (i = 0; i < s_n_chrs; i++) {
        if (s_chrs[i].val_handle == s_write_val) {
            have_write = true;
        }
        if (s_chrs[i].val_handle == s_ind_val) {
            have_ind = true;
        }
    }

    Lbegin();
    Lput("服务 0211 已就绪 write=");
    Lput(have_write ? "0212" : "缺");
    Lput(" indicate=");
    Lput(have_ind ? "0213" : "缺");
    Lput(" read=");
    Lput(s_ver_val ? "0214" : "缺");
    Lend(TLB_LOG_OK);
    {
        const char *c[2];
        candidates_order(c);
        Lbegin();
        Lput("0x212 写属性");
        props_text_append("");
        Lput("，准备按 ");
        Lput(c[0]);
        Lput(" / ");
        Lput(c[1]);
        Lput(" 顺序写入");
        Lend(TLB_LOG_INFO);
    }
    // 车端上报了哪些特征、各自什么属性：现场排查「property not support」唯一的事实来源
    Lbegin();
    Lput("0211 特征清单: ");
    for (i = 0; i < s_n_chrs; i++) {
        bool known, wr, nr;
        char scratch[8];
        if (i) {
            Lput(" ");
        }
        Lput(uuid_short4(s_chrs[i].uuid, scratch, sizeof(scratch)));
        Lput("(");
        props_of(s_chrs[i].props, &known, &wr, &nr);
        props_text_of(known, wr, nr);
        if (s_chrs[i].props & (CHR_PROP_NOTIFY | CHR_PROP_INDICATE)) {
            Lput(" notify/indicate");
        }
        Lput(")");
    }
    Lend(TLB_LOG_INFO);

    if (!have_write || !have_ind) {
        set_str(err, err_cap, "0212/0213 特征不全，无法收发 VCSEC 报文");
        return false;
    }

    if (s_ind_val != 0) {
        if (ble_gattc_disc_all_dscs(s_conn, s_ind_val, s_svc_end, dsc_cb, &s_ind_cccd) != 0) {
            s_ind_cccd = 0;
        } else {
            wait_proc(GATT_PROC_MS);
        }
    }
    return true;
}

static void subscribe_indicate(void)
{
    uint8_t val[2];
    bool ok = false;
    char t[64];

    if (s_ind_cccd != 0) {
        if (s_ind_props & CHR_PROP_INDICATE) {
            val[0] = 0x02;
            val[1] = 0x00;
        } else {
            val[0] = 0x01;
            val[1] = 0x00;
        }
        if (ble_gattc_write_flat(s_conn, s_ind_cccd, val, 2, attr_cb, NULL) == 0) {
            s_proc_skip = false;
            if (wait_proc(GATT_PROC_MS) && s_proc_rc == 0) {
                ok = true;
            } else {
                rc_text(s_proc_rc, t, sizeof(t));
            }
        } else {
            rc_text(s_proc_rc ? s_proc_rc : BLE_HS_EBUSY, t, sizeof(t));
        }
        if (!ok) {
            Lbegin();
            Lput("订阅 0213 失败: ");
            Lput(t);
            Lend(TLB_LOG_WARN);
        }
    } else {
        set_str(t, sizeof(t), "车端没有上报 0x2902 描述符");
        Lbegin();
        Lput("订阅 0213 失败: ");
        Lput(t);
        Lend(TLB_LOG_WARN);
    }

    if (ok) {
        s_subscribed = true;
        Lbegin();
        Lput("已订阅 0213（INDICATE）");
        Lend(TLB_LOG_OK);
    } else {
        // 设备侧能写描述符，所以卡点不是「API 不支持」，而是车端没给 CCCD 或拒了写
        Lbegin();
        Lput("关键阻塞：运行时未能开启 0213 的通知。写 0x2902 描述符没有成功，"
             "请用 nRF Connect 连同一台车手动 Enable indicate 后重试，"
             "或确认这台车是否要求先配对加密。");
        Lend(TLB_LOG_ERROR);
    }
    sleep_ms(300);
}

static void negotiate_mtu(void)
{
    int i;
    bool done = false;
    int actual = 0;
    int asked = 0;

    s_mtu_negotiating = true;
    for (i = 0; i < TLB_MTU_STEPS_N && !done; i++) {
        int m = tlb_mtu_steps[i];
        s_mtu_result = 0;
        if (ble_att_set_preferred_mtu((uint16_t)m) != 0) {
            continue;
        }
        if (ble_gattc_exchange_mtu(s_conn, mtu_cb, NULL) != 0) {
            continue;
        }
        if (!wait_proc(GATT_PROC_MS)) {
            continue;
        }
        if (s_proc_rc != 0) {
            continue;
        }
        asked = m;
        actual = s_mtu_result > 0 ? (int)s_mtu_result : m;
        s_mtu = actual;
        done = true;
    }
    s_mtu_negotiating = false;

    if (done) {
        Lbegin();
        Lput("MTU 协商 = ");
        Lfmt("%d", actual);
        if (actual != asked) {
            Lput("（请求 ");
            Lfmt("%d", asked);
            Lput("，车辆给的值更小，按实际值分包）");
        }
        Lput("，每包载荷上限 ");
        Lfmt("%u", (unsigned)tlb_payload_cap(actual));
        Lput(" 字节");
        Lend(TLB_LOG_OK);
        return;
    }
    Lbegin();
    Lput("MTU 协商不可用（车辆拒绝），按 MTU=");
    Lfmt("%d", TLB_MTU_DEFAULT);
    Lput(" 工作；超过 20 字节的响应可能被截断");
    Lend(TLB_LOG_WARN);
}

// ---------------------------------------------------------------- 连接生命周期
bool tlb_ble_connect(const tlb_ble_dev_t *dev, char *err, size_t err_cap)
{
    ble_addr_t peer;
    struct ble_gap_conn_params params;
    int rc, i;

    if (err && err_cap) {
        err[0] = '\0';
    }
    if (!dev || !dev->valid) {
        set_str(err, err_cap, "没有可连接的设备记录（先扫描）");
        return false;
    }
    if (!s_stack_up) {
        set_str(err, err_cap, "蓝牙栈没有起来：设备侧蓝牙只能在栈就绪后用");
        return false;
    }
    if (s_conn != 0xFFFF) {
        set_str(err, err_cap, "已经有连接，先断开再连");
        return false;
    }

    s_cur = *dev;
    s_state = "connecting";
    s_mtu = TLB_MTU_DEFAULT;
    Lbegin();
    Lput("连接 ");
    Lput(dev->name[0] ? dev->name : "(无名)");
    Lput(" / ");
    Lput(dev->id);
    Lend(TLB_LOG_INFO);

    // 规则 A：连上就不能再扫。NimBLE 在扫描中根本不让发起连接，所以这里提前静默取消，
    // 那句「已停止扫描」仍然按探针的位置在连接成功之后打。
    (void)ble_gap_disc_cancel();

    memset(&peer, 0, sizeof(peer));
    peer.type = dev->addr_type;
    for (i = 0; i < 6; i++) {
        peer.val[i] = dev->addr[i];
    }
    memset(&params, 0, sizeof(params));
    params.itvl_min = 36;             // 45ms
    params.itvl_max = 72;             // 90ms
    params.latency = 0;
    params.supervision_timeout = 500; // 5s
    s_conn_status = -1;
    flush_sem(s_conn_sem);

    // TIB：在 ble_gap_connect 之前登记「一连上就配对」。真正的 initiate 只能在 CONNECT
    // 成功回调里做（连接之前没有 conn_handle），详见 s_sec_pending 的声明处注释。
    s_sec_done = false;
    s_sec_pending = true;
    flush_sem(s_sec_sem);

    rc = ble_gap_connect(s_own_addr_type, &peer, CONNECT_MS, &params, gap_cb, NULL);
    if (rc != 0) {
        char t[64];
        s_sec_pending = false;
        rc_text(rc, t, sizeof(t));
        copy_str(err, err_cap, t, strlen(t));
        s_state = "idle";
        return false;
    }
    if (xSemaphoreTake(s_conn_sem, pdMS_TO_TICKS(CONNECT_MS + 2000)) != pdTRUE) {
        char t[64];
        s_sec_pending = false;
        rc_text(BLE_HS_ETIMEOUT, t, sizeof(t));
        copy_str(err, err_cap, t, strlen(t));
        s_state = "idle";
        return false;
    }
    if (s_conn_status != 0 || s_conn == 0xFFFF) {
        char t[64];
        s_sec_pending = false;
        rc_text(s_conn_status, t, sizeof(t));
        copy_str(err, err_cap, t, strlen(t));
        s_state = "idle";
        return false;
    }

    Lbegin();
    Lput("已停止扫描（连接期间继续扫会掉包）");
    Lend(TLB_LOG_INFO);
    sleep_ms(600); // 安卓枚举服务要时间

    // TIB：给配对结果最多 4000ms；超时就放行，绝不阻断「发现服务 → 订阅 0x0213 → 协商 MTU」。
    // 偏离：探针（Android）没有这一步，它靠系统在业务层之前自己处理加密；设备侧必须等一等，
    // 否则 0212 的写在车辆要求加密时会直接被拒。
    if (s_sec_pending && xSemaphoreTake(s_sec_sem, pdMS_TO_TICKS(4000)) != pdTRUE && !s_sec_done) {
        Lbegin();
        Lput("等待配对结果超过 4000ms，按当前链路继续");
        Lend(TLB_LOG_WARN);
    }
    s_sec_pending = false;

    if (!discover_services(err, err_cap)) {
        // 0211/0212/0213 没配对齐，这条连接没有意义：拆掉它。
        // 「连接已断开…」那行由 DISCONNECT 事件打，这里不重复。
        if (s_conn != 0xFFFF) {
            (void)ble_gap_terminate(s_conn, BLE_ERR_REM_USER_CONN_TERM);
        }
        s_state = "idle";
        return false;
    }
    // 规则 C：先订阅再谈 MTU，重排会丢掉首帧响应
    subscribe_indicate();
    negotiate_mtu();
    s_state = "connected";
    return true;
}

// 轮询用：s_conn 由 host 任务改，这里必须每次都真读一次内存
static bool conn_alive(void)
{
    volatile uint16_t *p = &s_conn;
    return *p != 0xFFFF;
}

// 探针 disconnect()：先撤销所有等待（文案「主动断开」），再关链路，最后「已断开」。
void tlb_ble_disconnect(void)
{
    int i;

    reject_all("主动断开");
    if (s_conn != 0xFFFF) {
        (void)ble_gap_terminate(s_conn, BLE_ERR_REM_USER_CONN_TERM);
        // DISCONNECT 事件里的 warn 行要排在「已断开」前面，和探针的顺序一致；最多等 1 秒
        for (i = 0; i < 100 && conn_alive(); i++) {
            sleep_ms(10);
        }
    }
    s_conn = 0xFFFF;
    s_subscribed = false;
    s_buffering = false;
    s_write_type[0] = '\0';
    s_state = "idle";
    Lbegin();
    Lput("已断开");
    Lend(TLB_LOG_INFO);
}

bool tlb_ble_connected(void)
{
    return conn_alive();
}

int tlb_ble_mtu(void)
{
    return conn_alive() ? s_mtu : TLB_MTU_DEFAULT;
}

void tlb_ble_current(tlb_ble_dev_t *out)
{
    if (out) {
        *out = s_cur;
    }
}

const char *tlb_ble_state(void)
{
    return s_state;
}

// 探针 readVersion()
bool tlb_ble_read_version(uint8_t *out, size_t cap, size_t *len, char *err, size_t err_cap)
{
    size_t n;

    if (err && err_cap) {
        err[0] = '\0';
    }
    if (len) {
        *len = 0;
    }
    if (!out || cap == 0) {
        return false;
    }
    if (!conn_alive()) {
        set_str(err, err_cap, "尚未连接车辆");
        return false;
    }
    if (s_ver_val == 0) {
        set_str(err, err_cap, "没有 0214 特征");
        return false;
    }

    s_proc_skip = true; // 长读的中间回调只收数据，不终结过程
    s_read_len = 0;
    if (ble_gattc_read_long(s_conn, s_ver_val, 0, attr_cb, NULL) != 0) {
        char t[64];
        s_proc_skip = false;
        rc_text(s_proc_rc ? s_proc_rc : BLE_HS_EBUSY, t, sizeof(t));
        set_str(err, err_cap, t);
        return false;
    }
    if (!wait_proc(GATT_PROC_MS)) {
        s_proc_skip = false;
        set_str(err, err_cap, "读取 0214 超时");
        return false;
    }
    s_proc_skip = false;
    if (s_proc_rc != 0) {
        char t[64];
        rc_text(s_proc_rc, t, sizeof(t));
        set_str(err, err_cap, t);
        return false;
    }

    n = s_read_len > cap ? cap : s_read_len;
    memcpy(out, s_read_buf, n);
    if (len) {
        *len = n;
    }
    Lbegin();
    Lput("通信协议版本 = ");
    Lhex(s_read_buf, n);
    Lend(TLB_LOG_OK);
    return true;
}

// ---------------------------------------------------------------- 分包写入
// 借道行缓冲拼装动态长文案：调用方必须正处于 Lbegin 之后，返回时锁已释放（同 wait_timeout_text）
static void line_to_text(char *dst, size_t cap)
{
    copy_str(dst, cap, s_line, s_line_len);
    s_line_len = 0;
    s_line[0] = '\0';
    s_line_mtx_give();
}

// 探针 writePart 抛出的原文（最长的是带 hint 的那条），供 send 组装错误行
static char s_write_err[960];

static void ble_mtx_take(void)
{
    if (s_ble_mtx) {
        xSemaphoreTake(s_ble_mtx, portMAX_DELAY);
    }
}

static void ble_mtx_give(void)
{
    if (s_ble_mtx) {
        xSemaphoreGive(s_ble_mtx);
    }
}

// 一次写入：NR 走 Write Command（只有本地 rc），REQ 走 Write Request（等 ATT 响应）
static bool write_once(const uint8_t *chunk, size_t len, const char *wt, char *text, size_t cap)
{
    int rc;

    if (strcmp(wt, WRITE_NR) == 0) {
        rc = ble_gattc_write_no_rsp_flat(s_conn, s_write_val, chunk, (uint16_t)len);
        if (rc != 0) {
            rc_text(rc, text, cap);
            return false;
        }
        return true;
    }
    s_proc_skip = false;
    rc = ble_gattc_write_flat(s_conn, s_write_val, chunk, (uint16_t)len, attr_cb, NULL);
    if (rc != 0) {
        rc_text(rc, text, cap);
        return false;
    }
    if (!wait_proc(GATT_PROC_MS)) {
        rc_text(BLE_HS_ETIMEOUT, text, cap);
        return false;
    }
    if (s_proc_rc != 0) {
        rc_text(s_proc_rc, text, cap);
        return false;
    }
    return true;
}

// 探针 ble-transport.js:writePart —— 硬约束：只有「属性不支持」才换下一种写法，
// 其它错误（超时 / 断链 / 长度超限）立刻上抛，绝不重发，避免车辆收到两条一样的报文。
static bool write_part(const uint8_t *chunk, size_t len, int part_no, int parts, size_t offset)
{
    const char *order[2];
    const char *tried[2];
    char text[160];
    int n_order, n_tried = 0, i;

    text[0] = '\0';
    n_order = write_type_order(order);
    for (i = 0; i < n_order; i++) {
        const char *wt = order[i];
        tried[n_tried++] = wt;
        if (write_once(chunk, len, wt, text, sizeof(text))) {
            if (strcmp(s_write_type, wt) != 0) {
                set_str(s_write_type, sizeof(s_write_type), wt);
                Lbegin();
                Lput("写入方式 = ");
                Lput(wt);
                Lput("（0x212 属性 ");
                props_text_of(s_write_props_known, s_write_prop_write, s_write_prop_nr);
                Lput("），本次连接后续都按它写");
                Lend(TLB_LOG_INFO);
            }
            return true;
        }
        if (!is_property_reject(text)) {
            break;
        }
        Lbegin();
        Lput(wt);
        Lput(" 写入被拒（");
        Lput(text);
        Lput("），换下一种写入方式重试");
        Lend(TLB_LOG_WARN);
    }

    {
        bool rejected = is_property_reject(text);
        Lbegin();
        Lput("第 ");
        Lfmt("%d", part_no);
        Lput("/");
        Lfmt("%d", parts);
        Lput(" 片（");
        Lfmt("%u", (unsigned)len);
        Lput(" 字节，偏移 ");
        Lfmt("%u", (unsigned)offset);
        Lput("）写入失败：");
        Lput(text);
        if (rejected) {
            Lput("（已试 writeType=");
            for (i = 0; i < n_tried; i++) {
                if (i) {
                    Lput(" / ");
                }
                Lput(tried[i]);
            }
            Lput("；0x212 属性 ");
            props_text_of(s_write_props_known, s_write_prop_write, s_write_prop_nr);
            Lput("，MTU=");
            Lfmt("%d", s_mtu);
            Lput(" 每包上限 ");
            Lfmt("%u", (unsigned)tlb_payload_cap(s_mtu));
            Lput(" 字节）");
        }
        line_to_text(s_write_err, sizeof(s_write_err));
    }
    return false;
}

// 探针 writeChunked：cap = payloadCap(mtu)，片间 delay(20)
static bool write_chunked(const uint8_t *frame, size_t len)
{
    size_t cap = tlb_payload_cap(s_mtu);
    size_t off = 0;
    int parts, idx = 0;

    if (cap == 0) {
        cap = 1;
    }
    parts = (int)((len + cap - 1) / cap);
    if (len > cap) {
        Lbegin();
        Lput("帧长 ");
        Lfmt("%u", (unsigned)len);
        Lput(" > MTU 可用 ");
        Lfmt("%u", (unsigned)cap);
        Lput("，按官方规则分成 ");
        Lfmt("%d", parts);
        Lput(" 片写");
        Lend(TLB_LOG_INFO);
    }
    while (off < len) {
        size_t size = len - off;
        if (size > cap) {
            size = cap;
        }
        idx++;
        if (!write_part(frame + off, size, idx, parts, off)) {
            return false;
        }
        sleep_ms(20);
        off += size;
    }
    return true;
}

// ---------------------------------------------------------------- 帧体收发
int tlb_ble_send(const uint8_t *frame, size_t len, int64_t timeout_ms, bool keep_queue,
                 uint8_t *out, size_t cap)
{
    size_t flen = 0;
    bool wait;
    bool wrote;
    int got;

    if (!conn_alive()) {
        // 探针在这里 throw new Error('尚未连接车辆')，没有日志行
        set_str(s_write_err, sizeof(s_write_err), "尚未连接车辆");
        return -1;
    }
    wait = timeout_ms > 0;
    // **不清 s_frame**：官方传输层从不因为「又发了一条」就丢掉正在拼的半截帧
    s_buffering = false;
    if (!keep_queue) {
        queue_clear();
    }
    if (!tlb_frame_prepend(frame, len, s_txbuf, sizeof(s_txbuf), &flen)) {
        set_str(s_write_err, sizeof(s_write_err), "帧体超过单帧上限，长度前缀无法编码");
        return -1;
    }
    if (wait) {
        arm_waiter(); // 规则 B：先登记等待者，再开始写
    }

    ble_mtx_take();
    wrote = write_chunked(s_txbuf, flen);
    ble_mtx_give();

    Lbegin();
    Lput("发送 ");
    Lfmt("%u", (unsigned)flen);
    Lput(" 字节: ");
    Lhex(s_txbuf, flen);
    Lend(TLB_LOG_TX);

    if (!wrote) {
        char rej[192];
        size_t n;
        Lbegin();
        Lput("BLE 写失败：");
        Lput(s_write_err);
        Lput("（帧 ");
        Lfmt("%u", (unsigned)flen);
        Lput(" 字节 / MTU=");
        Lfmt("%d", s_mtu);
        Lput(" / 特征 ");
        Lput(s_write_id_str[0] ? s_write_id_str : "?");
        Lput("）");
        // 同一句话还要当作撤销等待的文案，所以趁锁还在先把行取出来
        n = copy_str(rej, sizeof(rej), "BLE 写失败：", strlen("BLE 写失败："));
        copy_str(rej + n, sizeof(rej) - n, s_write_err, strlen(s_write_err));
        s_line_len = 0;
        s_line[0] = '\0';
        s_line_mtx_give();
        if (wait) {
            reject_all(rej);
        }
        return -1;
    }
    if (!wait) {
        return 0;
    }

    got = wait_frame(timeout_ms, out, cap);
    if (got <= 0) {
        return got;
    }
    Lbegin();
    Lput("响应 ");
    Lfmt("%d", got);
    Lput(" 字节: ");
    Lhex(out, (size_t)got);
    Lend(TLB_LOG_RX);
    return got;
}

int tlb_ble_receive(uint8_t *out, size_t cap, int64_t timeout_ms)
{
    size_t n = 0;
    int got;

    if (!conn_alive()) {
        return -1; // 探针：throw new Error('尚未连接车辆')
    }
    s_buffering = true;
    if (queue_shift(out, cap, &n)) {
        Lbegin();
        Lput("取暂存帧 ");
        Lfmt("%u", (unsigned)n);
        Lput(" 字节: ");
        Lhex(out, n);
        Lend(TLB_LOG_RX);
        return (int)n;
    }
    arm_waiter();
    got = wait_frame(timeout_ms > 0 ? timeout_ms : 3000, out, cap);
    if (got > 0) {
        Lbegin();
        Lput("续收 ");
        Lfmt("%d", got);
        Lput(" 字节: ");
        Lhex(out, (size_t)got);
        Lend(TLB_LOG_RX);
        return got;
    }
    // 探针 receive 的 catch 不区分「超时」和「已断开」：log('info', errText(e)) + return null
    if (s_wait_err[0]) {
        tlb_ble_log(TLB_LOG_INFO, s_wait_err);
    }
    return 0;
}

void tlb_ble_reset_rx(void)
{
    tlb_frame_reset(&s_frame);
    queue_clear();
}
