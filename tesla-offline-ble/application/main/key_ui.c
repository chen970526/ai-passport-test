// application/main/key_ui.c —— Tesla AI Passport 首页（严格按 UI_SPEC.md 重做）。
//
// 首页结构（240×320，黑底白字极简）：
//   顶部状态区：TESLA / Model Y + 连接状态点 + bluetooth/battery 图标
//   中央车辆区：car 图标（88px）+ 开闭状态小字（克制：仅前/后备箱文案，车门用描边变色）
//   状态文字行：已连接 / 连接中… / 连接失败
//   底部操作区：[锁车][解锁][前备箱] 三张静态卡片（对应右上/右中/右下键，不可点）
//   操作反馈：成功 check+文案约 600ms 回首页；失败两行短暂显示；发送中「正在执行…」
// 调试能力（非规范界面，长按右三进入）：诊断页1 ADC/键数/RAM/连/重启原因/阶=N，
// 诊断页2 全屏日志（log_tee 环形缓冲）。进诊断时隐藏首页元素。
// 数据来源只有一个：tlb_app_ui_snapshot()。这里绝不做业务判断、绝不碰 BLE。
// 刷新走 lv_timer（跑在 esp_lvgl_port 的 LVGL 任务里），所以回调内操作 LVGL 对象
// 不需要 bsp_lvgl_lock；反过来，本文件之外的任何线程都不许直接动这些对象。
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "bsp_button.h"
#include "app_button.h"
#include "bsp_battery.h"
#include "bsp_display.h"
#include "key_ui.h"
#include "key_icons.h"
#include "lvgl.h"
#include "tesla_ble/tlb_ble.h"
#include "vin_cfg.h" // NOVIN 引导页的接入点名/密码/地址与 vin_cfg.c 同源

static const char *TAG = "key_ui";

// 由 tools/gen_key_font.py 生成的本界面专用中文子集（源字体 simhei.ttf）。
LV_FONT_DECLARE(key_font_20);
LV_FONT_DECLARE(key_font_14);

// 配色按 UI_SPEC「视觉原则」：黑色背景、白色主文字、浅灰辅助；状态点用彩色。
#define C_BG      0x000000
#define C_INK     0xFFFFFF
#define C_DIM     0x9AA4B0
#define C_OK      0x34C759 // 已连接（绿）
#define C_ACCENT  0x3E8BFF // 连接中（蓝闪）
#define C_ERR     0xF16A5A // 连接失败 / 操作失败（红）
#define C_WARN    0xF0B429 // 车门开着时的车图标描边（琥珀）
#define C_UNKNOWN 0x6E7681 // 未知（灰）
#define C_LINE    0x2A323C // 分隔线
#define C_CARD_BG 0x0B0F14 // 卡片底
#define C_SEL     0x39D2FF // 引导列表 VIN 后6位高亮（青）

#define UI_PERIOD_MS  150  // 界面心跳
#define ACK_SHOW_MS   600  // 规范「约 500–700 ms 后回首页」
#define PENDING_MAX_MS 5000 // 发送中文案最长显示时间（超时回首页，防回执丢失卡死）
#define FAIL_TRIES    5    // 未连接且 tries>=5 → 连接失败（后台仍继续轮询）
#define LCD_W         240
#define LCD_H         320
#define MARGIN_X      15   // 规范安全边距：左右 14–16px
#define MARGIN_Y      12   // 规范安全边距：上下 10–14px

static lv_obj_t *s_tesla;    // 顶部小字 TESLA
static lv_obj_t *s_model;    // 顶部主字 Model Y
static lv_obj_t *s_dot;      // 连接状态圆点 ●
static lv_obj_t *s_bt;       // 顶部 bluetooth 图标（14px）
static lv_obj_t *s_batt;     // 顶部 battery 图标（14px）
static lv_obj_t *s_batt_txt; // 板子电量百分比（CW2017 电量计，30 秒一刷）
static int  s_batt_soc = -2; // -2=还没读过 -1=读失败 0..100=SOC%
static int64_t s_batt_at;
static lv_obj_t *s_col;      // 中央 flex 纵向列容器（车图/小字/状态/分隔线/卡片行均分）
static lv_obj_t *s_row;      // 底部卡片 flex 横向行容器
static lv_obj_t *s_car;      // 中央 car 全彩实车图（88×150 竖版）
static lv_obj_t *s_closure;  // 车辆开闭状态小字（前/后备箱已打开）
static lv_obj_t *s_sep;      // 分隔线
static lv_obj_t *s_card[3];  // 底部三张动作卡片
static lv_obj_t *s_fb_check; // 反馈：check 图标
static lv_obj_t *s_fb_line1; // 反馈：主文案
static lv_obj_t *s_fb_line2; // 反馈：副文案（失败第二行）
static lv_obj_t *s_diag_a;   // 诊断页1 第一行
static lv_obj_t *s_diag_b;   // 诊断页1 第二行
// —— 首次绑定引导页（无密钥/无档案时 tlb_app 自动进入；布局按 5 行写死）——
static lv_obj_t *s_onb_title;                     // 标题
static lv_obj_t *s_onb_step;                      // 步骤说明（配对中换成刷卡指引）
static lv_obj_t *s_onb_status;                    // 阶段状态行
static lv_obj_t *s_onb_panel;                     // 列表弹窗卡片（圆角边框容器，纵向 flex）
static lv_obj_t *s_onb_row[TLB_ONB_LIST_MAX];     // 列表行容器（横向 flex：圆点/名字/尾号/RSSI）
static lv_obj_t *s_onb_dot[TLB_ONB_LIST_MAX];     // 列表行：疑似特斯拉青色圆点
static lv_obj_t *s_onb_name[TLB_ONB_LIST_MAX];    // 列表行：广播名
static lv_obj_t *s_onb_vin6[TLB_ONB_LIST_MAX];    // 列表行：VIN 后 6 位（青色高亮）
static lv_obj_t *s_onb_rssi[TLB_ONB_LIST_MAX];    // 列表行：信号强度
static lv_obj_t *s_onb_vin;                       // 当前生效 VIN 行（步骤与列表之间）
static lv_obj_t *s_onb_keys;                      // 底部按键说明
static lv_obj_t *s_onb_qr;                        // 配网阶段二维码（直达 http://192.168.4.2）
static bool s_onb_shown;                          // 引导页当前是否占屏
static lv_obj_t *s_log_box;  // 页2 可滚动容器（单 label 全文，退出时删）
static lv_obj_t *s_log_label; // 页2 日志正文（text 直接指向 s_log_text 堆缓冲，零拷贝）
static lv_obj_t *s_log_idx;  // 日志页底部的操作提示行
static bool s_log_shown;     // 日志页当前是否占屏（仅 LVGL 任务读写）
static bool s_home_shown = true;   // 首页元素组当前是否可见
static bool s_fb_shown;            // 反馈覆盖层当前是否占屏
static uint32_t s_last_dot_color = C_UNKNOWN;
static lv_opa_t s_last_dot_opa = LV_OPA_COVER;

// 按键反馈状态：button 任务写、ui_tick（LVGL 任务）读。先写 id 再写时间戳，
// 读侧见到新键名时时间戳必然已就位，最坏多亮一帧旧键名，无撕裂风险。
// 首页不再显示按键反馈行（规范隐藏操作提示），计数仅供诊断页1 判读。
static volatile int s_key_id = -1;
static volatile int64_t s_key_at;
static volatile int s_key_ev_count; // 开机至今收到的按键事件总数（诊断用）

// 屏幕诊断模式：长按右三切换。无电脑时用它肉眼排查按键链路——
// 页1：按键线实时 ADC + 事件计数 + 剩余堆 + 连接 + 重启原因；
// 页2（合并日志页）：最近 16 条日志拼成一屏、横线分隔，右一/右二上下滚动
// （一次约 3 行），右三单击回页1。方便整屏拍照排查，不用逐条翻页。
// 条数上限由 RAM 决定：C3 正常模式（BLE 运行中）空闲堆实测仅 ~11 KB，
// 32 条版静态 .bss 多占 9.2 KB 直接把扫描饿死（列表整块变白、无结果，
// 2026-10-10 用户实机回退），16×128B 是实测安全上限（静态净增 ~2.7 KB）。
#define LOG_RING_N   16
#define LOG_RING_LEN 128
// 快照拼接缓冲（每条间插一行 ----- 分隔）。只在进入日志页那一刻从堆上申请、
// 退出即释放。教训（2026-10-10 第 33 次，实车 logdump 铁证）：这 2.2KB 若静态
// 常驻，叠加 ring 2KB + scratch 256B 共 ~4.5KB，把启动堆压到只剩 11KB，
// NimBLE 连接期分配直接「BLE_INIT: Malloc failed」→ 车的回包收不到 → 重发
// → 车踢线 → 绑定报「链路错误」，BLE 功能整体瘫痪。
#define LOG_TEXT_CAP (LOG_RING_N * (LOG_RING_LEN + 8))
static char *s_log_text;
static volatile bool s_diag;
static volatile int s_diag_page;      // 0=电压页 1=日志页
static volatile int s_log_scroll_dir; // 页2 待处理滚动：-1 上移 +1 下移 0 无
static volatile int s_boot_stage;     // app_main 走到第几步（诊断页1「阶=N」）

void key_ui_boot_stage(int n)
{
    s_boot_stage = n;
}

void key_ui_toggle_diag(void)
{
    s_diag = !s_diag;
    s_diag_page = 0;
}

void key_ui_diag_next_page(void)
{
    if (!s_diag) {
        return;
    }
    s_diag_page = s_diag_page ? 0 : 1; // 页1 ↔ 页2 往返切换
}

void key_ui_diag_scroll(int dir)
{
    if (s_diag && s_diag_page == 1) {
        s_log_scroll_dir = dir;
    }
}

int key_ui_diag_page(void)
{
    return s_diag ? s_diag_page : 0;
}

bool key_ui_in_diag(void)
{
    return s_diag;
}

// —— 日志环形缓冲：esp_log_set_vprintf 钩子把每条日志 tee 进静态内存（不走堆，
//    内存紧张时不会雪上加霜）。屏幕诊断页2 逐条翻看。自研日志全中文，
//    字库已按 gen_key_font.py 扩扫 tlb/bsp 源码保证渲染。——
static char s_log_ring[LOG_RING_N][LOG_RING_LEN];
static int s_log_head; // 下一个写入槽位
static portMUX_TYPE s_log_mux = portMUX_INITIALIZER_UNLOCKED;
static int (*s_prev_vprintf)(const char *, va_list);

static int log_tee(const char *fmt, va_list ap)
{
    static char scratch[256]; // 临界区外格式化，锁只做拷贝
    va_list ap2;
    va_copy(ap2, ap);
    int n = vsnprintf(scratch, sizeof(scratch), fmt, ap2);
    va_end(ap2);
    if (n > 0) {
        portENTER_CRITICAL(&s_log_mux);
        char *slot = s_log_ring[s_log_head];
        s_log_head = (s_log_head + 1) % LOG_RING_N;
        int o = 0;
        for (int i = 0; scratch[i] != '\0' && o < LOG_RING_LEN - 1; i++) {
            if (scratch[i] == 0x1b) { // 跳过 ANSI 颜色序列直到 'm'
                while (scratch[i] != '\0' && scratch[i] != 'm') {
                    i++;
                }
                continue; // i 已在 'm'，循环 i++ 后跳过
            }
            if (scratch[i] == '\n') {
                break;
            }
            slot[o++] = scratch[i];
        }
        // 截断可能切在 UTF-8 中间：回退到最后一个完整码点，避免屏幕出乱码
        while (o > 0 && ((unsigned char)slot[o - 1] & 0xC0) == 0x80) {
            o--; // 去掉悬空的后续字节
        }
        if (o > 0 && (unsigned char)slot[o - 1] >= 0xC0) {
            o--; // 去掉没有续字节的引导字节
        }
        slot[o] = '\0';
        portEXIT_CRITICAL(&s_log_mux);
    }
    return s_prev_vprintf != NULL ? s_prev_vprintf(fmt, ap) : n;
}

// 取倒数第 back 条日志（0=最新）。空槽为全零字符串，显示为空白。
static void log_ring_tail(int back, char *out, size_t n)
{
    portENTER_CRITICAL(&s_log_mux);
    int idx = (s_log_head - 1 - back + LOG_RING_N * 2) % LOG_RING_N;
    snprintf(out, n, "%s", s_log_ring[idx]);
    portEXIT_CRITICAL(&s_log_mux);
}

static const char *rst_text(void)
{
    switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "上电";
    case ESP_RST_EXT: return "外部";
    case ESP_RST_SW: return "软件";
    case ESP_RST_PANIC: return "崩溃";
    case ESP_RST_INT_WDT: return "看门狗";
    case ESP_RST_TASK_WDT: return "看门狗";
    case ESP_RST_BROWNOUT: return "掉电";
    case ESP_RST_DEEPSLEEP: return "深睡";
    default: return "其他";
    }
}

void key_ui_notify_btn(bsp_btn_t btn)
{
    s_key_id = (int)btn;
    s_key_at = tlb_port_now_ms();
    s_key_ev_count++;
}

static void set_text(lv_obj_t *label, const char *text)
{
    const char *cur = lv_label_get_text(label);
    if (cur != NULL && strcmp(cur, text) == 0) {
        return; // 文本没变就别让 LVGL 重绘
    }
    lv_label_set_text(label, text);
}

static lv_obj_t *add_label(lv_obj_t *parent, int x, int y, int w, int h, const lv_font_t *font,
                           uint32_t color, const char *text)
{
    lv_obj_t *label = lv_label_create(parent);
    lv_obj_set_pos(label, x, y);
    lv_obj_set_size(label, w, h);
    lv_obj_set_style_bg_opa(label, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(label, 0, 0);
    lv_obj_set_style_pad_all(label, 0, 0);
    lv_obj_set_style_text_font(label, font, 0);
    lv_obj_set_style_text_color(label, lv_color_hex(color), 0);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(label, text);
    return label;
}

// L8 遮罩图标：48×48 源图经 STRETCH 模式缩到 size×size，image_recolor 染任意色。
static lv_obj_t *add_icon(lv_obj_t *parent, int x, int y, int size, const lv_image_dsc_t *dsc,
                          uint32_t color)
{
    lv_obj_t *img = lv_image_create(parent);
    lv_obj_set_pos(img, x, y);
    lv_obj_set_size(img, size, size);
    lv_image_set_src(img, dsc);
    lv_image_set_inner_align(img, LV_IMAGE_ALIGN_STRETCH);
    lv_obj_set_style_image_recolor(img, lv_color_hex(color), 0);
    lv_obj_set_style_image_recolor_opa(img, LV_OPA_COVER, 0);
    return img;
}

static void set_visible(lv_obj_t *obj, bool on)
{
    if (on == lv_obj_is_hidden(obj)) {
        lv_obj_set_hidden(obj, !on);
    }
}

static void set_group_visible(lv_obj_t **g, size_t n, bool on)
{
    for (size_t i = 0; i < n; i++) {
        set_visible(g[i], on);
    }
}

#if TLB_ONB_LIST_MAX != 5
#error "key_ui 引导页布局按 5 行写死，改 TLB_ONB_LIST_MAX 需同步本文件"
#endif

// 首页整组可见性：引导页/诊断页/日志页接管屏幕时整组让位。幂等，可每帧调。
static void set_home_visible(bool on)
{
    lv_obj_t *g[] = {s_tesla, s_model, s_dot, s_bt, s_batt, s_batt_txt, s_car,
                     s_closure, s_sep, s_card[0], s_card[1], s_card[2],
                     s_fb_check, s_fb_line1, s_fb_line2};
    set_group_visible(g, sizeof g / sizeof g[0], on);
}

// 首次绑定引导页整组
static void set_onb_visible(bool on)
{
    lv_obj_t *g[] = {s_onb_title, s_onb_step, s_onb_vin, s_onb_status, s_onb_keys, s_onb_panel,
                     s_onb_qr};
    set_group_visible(g, sizeof g / sizeof g[0], on);
}

// —— 引导页渲染：只读快照，全部屏幕文案都在本文件字面量里（20px 字库只扫本文件）——
static const char *ONB_STEP_DEFAULT =
    "① 关闭手机蓝牙，车辆钥匙限3把\n② 坐进车内，唤醒车机\n③ 右一/右二选车，右三连接";
static const char *ONB_STEP_PAIR = "车机弹出「添加钥匙」后\n请将NFC钥匙卡贴在\n中控杯架前的读卡区";
// 重扫确认弹窗文案（右一长按唤出，防误触；操作指引直接写进弹窗，不另设控件）
static const char *ONB_STEP_RESCAN = "重新搜索车辆？\n右三 = 是，立即重扫\n右一 / 右二 = 取消";
// NOVIN 阶段：热点+内网网页配 VIN 的三步指引（文案用字均已在 14px 字库内；
// SSID/密码/地址由 vin_cfg.h 宏拼出，改配置不用动这里）
static char s_step_novin[128];

// 按字节截断并回退到完整 UTF-8 码点（车主自定义广播名可能是中文）
static void utf8_cut(const char *src, char *dst, size_t cap, size_t max_bytes)
{
    size_t o = 0;
    while (src[o] != '\0' && o < max_bytes && o + 1 < cap) {
        o++;
    }
    if (src[o] != '\0') { // 截断了：回退悬空的续字节与引导字节
        while (o > 0 && ((unsigned char)src[o - 1] & 0xC0) == 0x80) {
            o--;
        }
        if (o > 0 && (unsigned char)src[o - 1] >= 0xC0) {
            o--;
        }
    }
    memcpy(dst, src, o);
    dst[o] = '\0';
}

static void onb_render(const tlb_app_ui_t *u)
{
    // 列表行：配对/完成/配VIN阶段让位给刷卡指引、成功提示与配网三步曲
    bool list_show = (u->onb_stage != TLB_ONB_PAIRING && u->onb_stage != TLB_ONB_DONE &&
                      u->onb_stage != TLB_ONB_NOVIN);
    // 配网二维码：只占用列表卡片区域，必须与列表互斥（其他阶段列表要用）
    set_visible(s_onb_qr, u->onb_stage == TLB_ONB_NOVIN);
    for (int i = 0; i < TLB_ONB_LIST_MAX; i++) {
        bool show = list_show && i < (int)u->onb_count;
        set_visible(s_onb_row[i], show);
        if (!show) {
            continue;
        }
        const tlb_onb_item_t *it = &u->onb_list[i];
        char nm[24];
        if (it->name[0] != '\0') {
            utf8_cut(it->name, nm, sizeof(nm), 14);
        } else {
            // 无名广播：显示地址尾部（"AA:BB:CC:DD:EE:FF" → "…DD:EE:FF"）
            size_t idl = strlen(it->id);
            snprintf(nm, sizeof(nm), "…%.8s", idl > 8 ? it->id + idl - 8 : it->id);
        }
        set_text(s_onb_name[i], nm);
        bool sel = (i == (int)u->onb_cursor);
        // 选中行：整行容器蓝底白字（flex 铺底，圆角矩形不顶卡片圆角）；
        // 未选中：疑似特斯拉青色字，普通设备灰色字
        uint32_t ncol = sel ? C_INK : (it->tesla ? C_SEL : C_DIM);
        lv_obj_set_style_text_color(s_onb_name[i], lv_color_hex(ncol), 0);
        lv_obj_set_style_bg_color(s_onb_row[i], lv_color_hex(C_ACCENT), 0);
        lv_obj_set_style_bg_opa(s_onb_row[i], sel ? LV_OPA_COVER : LV_OPA_TRANSP, 0);
        lv_obj_set_style_radius(s_onb_row[i], 4, 0);
        // 疑似标记圆点：仅疑似车显示；选中行蓝底上把点换成白色保持对比度
        set_visible(s_onb_dot[i], it->tesla);
        lv_obj_set_style_bg_color(s_onb_dot[i], lv_color_hex(sel ? C_INK : C_SEL), 0);
        lv_obj_set_style_text_color(s_onb_rssi[i], lv_color_hex(sel ? C_INK : C_DIM), 0);
        lv_obj_set_style_text_color(s_onb_vin6[i], lv_color_hex(sel ? C_INK : C_SEL), 0);
        // 新固件车广播名 "Tesla ABC123"：后 6 位青色高亮（用户靠它对上自己的车）
        char v6[8] = "";
        size_t nl = strlen(it->name);
        if (nl >= 12 && strncmp(it->name, "Tesla ", 6) == 0) {
            snprintf(v6, sizeof(v6), "%.6s", it->name + 6);
        }
        set_text(s_onb_vin6[i], v6);
        char rs[8];
        snprintf(rs, sizeof(rs), "%d", (int)it->rssi);
        set_text(s_onb_rssi[i], rs);
    }

    // 状态行 + 步骤区（配对中把步骤区换成醒目的刷卡指引）
    char st[64];
    uint32_t col = C_INK;
    const char *step = ONB_STEP_DEFAULT;
    switch (u->onb_stage) {
    case TLB_ONB_SCAN:
        snprintf(st, sizeof(st), "正在搜索车辆…");
        col = C_ACCENT;
        break;
    case TLB_ONB_NOFOUND:
        snprintf(st, sizeof(st), "没扫到设备，2秒后自动重扫");
        col = C_WARN;
        break;
    case TLB_ONB_LIST:
        if (u->onb_pages > 1) {
            snprintf(st, sizeof(st), "共%d台 第%d/%d页 青色=疑似车", (int)u->onb_total,
                     (int)u->onb_page + 1, (int)u->onb_pages);
        } else {
            snprintf(st, sizeof(st), "共%d台 青色=疑似你的车", (int)u->onb_total);
        }
        break;
    case TLB_ONB_CONNECTING:
        snprintf(st, sizeof(st), "正在连接 %.12s…", u->onb_note);
        col = C_ACCENT;
        break;
    case TLB_ONB_PAIRING:
        snprintf(st, sizeof(st), "等待车主刷卡授权…");
        col = C_ACCENT;
        step = ONB_STEP_PAIR;
        break;
    case TLB_ONB_DONE:
        snprintf(st, sizeof(st), "绑定成功！正在进入首页");
        col = C_OK;
        break;
    case TLB_ONB_NOVIN:
        if (s_step_novin[0] == '\0') {
            snprintf(s_step_novin, sizeof(s_step_novin),
                     "①连WiFi:%s\n②密码:%s\n③扫码或打开 %s", VIN_AP_SSID,
                     VIN_AP_PASS, VIN_AP_IP);
        }
        snprintf(st, sizeof(st), "等待配置 VIN…");
        col = C_WARN;
        step = s_step_novin;
        break;
    case TLB_ONB_FAIL:
    default:
        // 状态行只给一句短提示；失败原因整段搬进上方步骤区（3 行自动换行），
        // 不再 utf8_cut 到 18 字节——之前「失败:AI-passport 已发」就是截断截没了。
        snprintf(st, sizeof(st), "失败：原因见上方");
        col = C_ERR;
        step = u->onb_note[0] != '\0' ? u->onb_note : "绑定未完成，请靠近车辆重试";
        break;
    }
    // 重扫确认弹窗：列表留在原位（用户看得见当前选了谁），只把步骤区换成确认文案
    if (u->onb_stage == TLB_ONB_RESCAN_ASK) {
        snprintf(st, sizeof(st), "重新搜索车辆？");
        col = C_WARN;
        step = ONB_STEP_RESCAN;
    }
    set_text(s_onb_status, st);
    lv_obj_set_style_text_color(s_onb_status, lv_color_hex(col), 0);
    set_text(s_onb_step, step);
    lv_obj_set_style_text_color(s_onb_step, lv_color_hex(
        (step == ONB_STEP_PAIR || step == s_step_novin || step == ONB_STEP_RESCAN) ? C_WARN :
        (u->onb_stage == TLB_ONB_FAIL ? C_ERR : C_DIM)), 0);
    // VIN 行：显示当前生效值（来自 NVS）；配网模式未配置时留空
    char vb[24];
    if (u->onb_vin[0] != '\0') {
        snprintf(vb, sizeof(vb), "VIN:%.17s", u->onb_vin);
        set_text(s_onb_vin, vb);
    } else {
        set_text(s_onb_vin, "");
    }
    // 底部提示行：配对中=立即验证；列表/失败=右一长按重扫（此前重扫零提示，
    // 用户根本不知道能重新检索——列表不实时，没靠近车时扫不到必须给出口）
    set_text(s_onb_keys,
             u->onb_stage == TLB_ONB_PAIRING ? "右三=已确认，立即验证"
             : (u->onb_stage == TLB_ONB_LIST || u->onb_stage == TLB_ONB_FAIL)
                   ? "右一长按=重新搜索" : "");
}

// RKE 成功文案。动作号语义以 tlb_types.h 的 RKEAction_E 为准：
// 1=LOCK 上锁、0=UNLOCK 解锁、20=REMOTE_DRIVE 驾驶授权（右二解锁的连发第二步，
// 按规范归并显示「已解锁」）；100/101 是 handle_lid 的私有号段（100=前备箱、
// 101=后备箱），不属于 RKEAction_E。规范未定义的其它动作号不弹反馈（回首页）。
static const char *rke_ok_text(int32_t action)
{
    switch (action) {
    case 1: return "已锁车";
    case 0: return "已解锁";
    case 20: return "已解锁";
    case 100: return "前备箱已打开";
    case 101: return "后备箱已打开";
    default: return NULL;
    }
}

// closure 快照下标 0前左 1前右 2后左 3后右 4后备箱 5前备箱 6充电口 7卷盖板(不画)。
// OPEN/AJAR/OPENING 都算「开着」。
static bool closure_open(uint8_t c)
{
    return c == TLB_CLOSURE_OPEN || c == TLB_CLOSURE_AJAR || c == TLB_CLOSURE_OPENING;
}

static void ui_tick(lv_timer_t *timer)
{
    (void)timer;

    // 合并日志页（诊断页2）：进入瞬间从环形缓冲拍 8 条快照，页内内容固定不变
    // ——按键/滚动自身也会产生日志，实时刷新的话正在看的行会被新条目顶走，
    // 没法滚动也没法拍照（2026-10-10 用户实机反馈）。退出再进 = 新快照。
    // 页2 内右一/右二滚动、右三单击回页1。
    const bool logpage = s_diag && (s_diag_page == 1);
    if (logpage != s_log_shown) {
        s_log_shown = logpage;
        if (logpage) {
            lv_obj_t *parent = lv_obj_get_parent(s_tesla); // 屏幕根容器
            s_log_box = lv_obj_create(parent);
            lv_obj_set_pos(s_log_box, MARGIN_X, MARGIN_Y);
            lv_obj_set_size(s_log_box, LCD_W - 2 * MARGIN_X, LCD_H - 2 * MARGIN_Y - 22);
            lv_obj_set_style_radius(s_log_box, 0, 0);
            lv_obj_set_style_border_width(s_log_box, 0, 0);
            lv_obj_set_style_bg_opa(s_log_box, LV_OPA_TRANSP, 0);
            lv_obj_set_style_pad_all(s_log_box, 0, 0);
            lv_obj_set_flex_flow(s_log_box, LV_FLEX_FLOW_COLUMN);
            lv_obj_set_scroll_dir(s_log_box, LV_DIR_VER);
            lv_obj_set_scrollbar_mode(s_log_box, LV_SCROLLBAR_MODE_OFF);
            // 快照渲染：进入时一次性取 16 条拼进临时缓冲（堆），页内不再读环形缓冲。
            // 单 label + set_text_static（零拷贝）：合并成一个对象只花 ~200 B。
            // 堆申请失败就只显示提示——诊断页是锦上添花，绝不能拖垮业务。
            s_log_text = (char *)pvPortMalloc(LOG_TEXT_CAP);
            size_t off = 0;
            if (s_log_text != NULL) {
                char buf[LOG_RING_LEN];
                for (int i = 0; i < LOG_RING_N; i++) { // 0=最新，从上往下依次变旧
                    log_ring_tail(i, buf, sizeof buf);
                    if (buf[0] == '\0') {
                        continue; // 开机早期没写满时跳过空条
                    }
                    int w = snprintf(s_log_text + off, LOG_TEXT_CAP - off,
                                     off == 0 ? "%s" : "\n-----\n%s", buf);
                    if (w < 0 || (size_t)w >= LOG_TEXT_CAP - off) {
                        break; // 缓冲写满即止（理论上到不了：条目长度与缓冲同规模）
                    }
                    off += (size_t)w;
                }
                if (off == 0) {
                    snprintf(s_log_text, LOG_TEXT_CAP, "--");
                }
            }
            s_log_label = lv_label_create(s_log_box);
            lv_obj_set_size(s_log_label, LV_PCT(100), LV_SIZE_CONTENT);
            lv_label_set_long_mode(s_log_label, LV_LABEL_LONG_WRAP);
            lv_obj_set_style_text_font(s_log_label, &key_font_14, 0);
            lv_obj_set_style_text_color(s_log_label, lv_color_hex(C_INK), 0);
            lv_obj_set_style_text_align(s_log_label, LV_TEXT_ALIGN_LEFT, 0);
            lv_obj_set_style_pad_ver(s_log_label, 2, 0);
            lv_label_set_text_static(s_log_label,
                                     s_log_text != NULL ? s_log_text : "内存不足，无法显示");
            s_log_idx = add_label(parent, MARGIN_X, LCD_H - MARGIN_Y - 18,
                                  LCD_W - 2 * MARGIN_X, 18, &key_font_14, C_DIM,
                                  "右一上 右二下 右三返回");
            set_home_visible(false);
            set_onb_visible(false);
            set_visible(s_diag_a, false);
            set_visible(s_diag_b, false);
            s_home_shown = false;
            s_fb_shown = false;
            s_onb_shown = false;
        } else {
            lv_obj_del(s_log_box); // 子 label 一并删除（label 是 set_text_static，先删对象再放堆）
            s_log_box = NULL;
            s_log_label = NULL;
            lv_obj_del(s_log_idx);
            s_log_idx = NULL;
            if (s_log_text != NULL) {
                vPortFree(s_log_text); // 退页立刻归还 2.2KB，BLE 运行期堆不留负债
                s_log_text = NULL;
            }
        }
    }
    if (logpage) {
        // 页内只处理滚动，内容保持进入时的快照不动
        int dir = s_log_scroll_dir;
        if (dir != 0) {
            s_log_scroll_dir = 0;
            lv_obj_scroll_by(s_log_box, 0, dir * 48, LV_ANIM_OFF); // 一步约 3 行
        }
        return;
    }

    tlb_app_ui_t u;
    tlb_app_ui_snapshot(&u);
    const int64_t now = tlb_port_now_ms();

    // 出厂重置提示：组合键触发、数据已清，worker 延时后重启。全屏两行提示
    // 接管所有界面（首页/引导/诊断一律隐藏）。
    if (u.fac_reset) {
        if (s_home_shown || s_onb_shown) {
            set_home_visible(false);
            set_onb_visible(false);
            set_visible(s_diag_a, false);
            set_visible(s_diag_b, false);
            s_home_shown = false;
            s_onb_shown = false;
            s_fb_shown = false;
        }
        set_visible(s_car, false);
        set_visible(s_closure, false);
        set_visible(s_fb_check, false);
        set_visible(s_fb_line1, true);
        set_visible(s_fb_line2, true);
        set_text(s_fb_line1, "钥匙数据已清除");
        lv_obj_set_style_text_color(s_fb_line1, lv_color_hex(C_WARN), 0);
        set_text(s_fb_line2, "正在重启，进入首次绑定…");
        return;
    }

    // 板子电量：CW2017 电量计读数，30 秒刷一次（SOC 变化慢，I2C 读很快）。
    // 读失败（电量计不应答/未初始化）显示 "--%"；≤20% 文字变红提醒充电。
    if (s_batt_soc == -2 || now - s_batt_at > 30000) {
        s_batt_at = now;
        s_batt_soc = bsp_battery_soc();
    }
    {
        char buf[16];
        uint32_t col = C_DIM;
        if (s_batt_soc < 0) {
            snprintf(buf, sizeof buf, "--%%");
        } else {
            snprintf(buf, sizeof buf, "%d%%", s_batt_soc);
            col = s_batt_soc <= 20 ? C_ERR : C_INK;
        }
        set_text(s_batt_txt, buf);
        lv_obj_set_style_text_color(s_batt_txt, lv_color_hex(col), 0);
    }

    // 诊断页1：隐藏首页，两行读数。判读口径：
    //   按键时 ADC 应跳到 ≈0/300/600mV 且"键="上涨 → 按键链路通；
    //   ADC 纹丝不动 → 按键线没被拉下；ADC 跳但计数不涨 → 窗口没接住。
    //   "启="是上次重启原因：崩溃/看门狗/掉电 = 出过事，上电/软件 = 正常。
    //   单击右三进入全屏日志页逐条看报错。
    if (s_diag) {
        // 之前漏了 s_onb_shown：引导页占屏时进诊断，home/fb 都是 false →
        // 引导页不会被隐藏，诊断文字直接叠在引导页上（实机「严重遮挡」根因）。
        if (s_home_shown || s_fb_shown || s_onb_shown) {
            set_home_visible(false);
            set_onb_visible(false);
            s_home_shown = false;
            s_fb_shown = false;
            s_onb_shown = false;
        }
        char a[LOG_RING_LEN], b[LOG_RING_LEN];
        app_button_try_reinit(); // 初始化失败时界面心跳顺带驱动 5 秒自愈重试
        const int mv = app_button_read_mv();
        if (mv < 0) {
            // 读失败时把粘存的真实错误码直接顶在第一行——不用翻页、
            // 不怕 NimBLE 日志把环形缓冲挤掉，电池下开机就能看到根因。
            snprintf(a, sizeof(a), "ADC失败:%s 键=%d", app_button_last_err(),
                     (int)s_key_ev_count);
        } else {
            snprintf(a, sizeof(a), "ADC=%dmV 键=%d", mv, (int)s_key_ev_count);
        }
        snprintf(b, sizeof(b), "RAM=%lu 连=%d 启=%s 阶=%d",
                 (unsigned long)esp_get_free_heap_size(),
                 (int)u.connected, rst_text(), (int)s_boot_stage);
        set_text(s_diag_a, a);
        set_text(s_diag_b, b);
        set_visible(s_diag_a, true);
        set_visible(s_diag_b, true);
        return;
    }
    set_visible(s_diag_a, false);
    set_visible(s_diag_b, false);
    // —— 首次绑定引导页：完全接管屏幕（诊断/日志页之下、首页之上）。
    //    每次心跳都强制一遍两组可见性（set_visible 幂等），从诊断页/日志页
    //    切回来时不用关心各自的隐藏状态残留 ——
    if (u.onb_active) {
        set_home_visible(false);
        set_onb_visible(true);
        s_onb_shown = true;
        s_home_shown = false;
        s_fb_shown = false;
        onb_render(&u);
        return;
    }
    if (s_onb_shown) {
        s_onb_shown = false;
        set_onb_visible(false); // 首页恢复交给下方 !s_home_shown 分支
    }
    if (!s_home_shown) {
        lv_obj_t *show[] = {s_tesla, s_model, s_dot, s_bt, s_batt, s_batt_txt, s_car,
                            s_closure, s_sep, s_card[0], s_card[1], s_card[2]};
        set_group_visible(show, sizeof show / sizeof show[0], true);
        s_home_shown = true;
    }

    // —— 操作反馈覆盖层（规范§状态反馈）：成功 check+文案 ~600ms；失败两行；发送中 ——
    bool fb = false, fb_check = false;
    const char *l1 = NULL, *l2 = NULL;
    uint32_t l1_color = C_INK;
    if (u.rke_action >= 0) {
        if (u.rke_pending) {
            if (now - u.rke_at < PENDING_MAX_MS) {
                fb = true;
                l1 = "正在执行…";
            }
        } else if (now - u.rke_at < ACK_SHOW_MS) {
            if (u.rke_ok) {
                const char *t = rke_ok_text(u.rke_action);
                if (t != NULL) {
                    fb = true;
                    fb_check = true;
                    l1 = t;
                }
            } else {
                fb = true;
                l1 = "操作失败";
                l2 = "请靠近车辆重试";
                l1_color = C_ERR;
            }
        }
    }
    if (fb != s_fb_shown) {
        s_fb_shown = fb;
        set_visible(s_car, !fb);
        set_visible(s_closure, !fb);
        set_visible(s_fb_line1, fb);
        set_visible(s_fb_line2, fb && l2 != NULL);
        set_visible(s_fb_check, fb && fb_check);
    }
    if (fb) {
        set_text(s_fb_line1, l1);
        lv_obj_set_style_text_color(s_fb_line1, lv_color_hex(l1_color), 0);
        set_text(s_fb_line2, l2 != NULL ? l2 : "");
        set_visible(s_fb_check, fb_check);
        set_visible(s_fb_line2, l2 != NULL);
        return; // 反馈窗口内冻结状态行/车辆区，超时自动回落首页
    }

    // —— 连接状态只由右上角状态点表达（用户定案：删中间状态行腾空间给车图）：
    //    connected→绿；未连接且 tries<5→蓝闪；tries>=5→红；首轮尝试前→灰。
    //    后台轮询逻辑不动 ——
    uint32_t dot;
    bool flash = false;
    if (u.connected) {
        dot = C_OK;
    } else if (u.tries >= FAIL_TRIES) {
        dot = C_ERR;
    } else {
        dot = C_ACCENT;
        flash = true;
    }
    if (!u.connected && u.tries == 0 && !u.ever_connected) {
        dot = C_UNKNOWN; // 还没发起过第一轮扫描
    }
    lv_opa_t opa = (flash && (now % 1000) >= 500) ? LV_OPA_40 : LV_OPA_COVER;
    if (dot != s_last_dot_color) {
        s_last_dot_color = dot;
        lv_obj_set_style_bg_color(s_dot, lv_color_hex(dot), 0);
    }
    if (opa != s_last_dot_opa) {
        s_last_dot_opa = opa;
        lv_obj_set_style_bg_opa(s_dot, opa, 0);
    }

    // —— 车辆开闭状态（克制表达）：前/后备箱开着→图标下方一行小字（规范文案）。
    //    车图始终全彩原图（用户定案：灰罩在连接后不变全彩，干脆不做染色）——
    const char *closure_txt = "";
    if (u.connected && u.has_status) {
        if (closure_open(u.closure[5])) {
            closure_txt = "前备箱已打开";
        } else if (closure_open(u.closure[4])) {
            closure_txt = "后备箱已打开";
        }
    }
    set_text(s_closure, closure_txt);
    // 没有开盖文案时整行退出 flex 布局（隐藏项不参与排布），否则空标签白占
    // 18px 槽位，把分隔线/卡片的间隙挤到底边被外壳圆角吃掉（用户实拍定案）。
    set_visible(s_closure, closure_txt[0] != '\0');
}

esp_err_t key_ui_start(void)
{
    // 尽早钩住日志输出（诊断页2 的数据源），失败不影响串口日志
    s_prev_vprintf = esp_log_set_vprintf(log_tee);

    if (bsp_display_init() != ESP_OK) {
        ESP_LOGE(TAG, "屏幕初始化失败，界面关闭（BLE 功能不受影响）");
        return ESP_FAIL;
    }
    if (bsp_lvgl_init() == NULL) {
        ESP_LOGE(TAG, "LVGL 初始化失败，界面关闭（BLE 功能不受影响）");
        return ESP_FAIL;
    }

    if (!bsp_lvgl_lock(1000)) {
        ESP_LOGE(TAG, "LVGL 加锁失败");
        return ESP_ERR_INVALID_STATE;
    }
    lv_obj_t *scr = lv_obj_create(NULL);
    lv_obj_set_scrollable(scr, false);
    lv_obj_set_style_bg_color(scr, lv_color_hex(C_BG), 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(scr, 0, 0);
    lv_obj_set_style_pad_all(scr, 0, 0);

    // —— 顶部状态区 ——
    s_tesla = add_label(scr, MARGIN_X, 10, 100, 16, &key_font_14, C_DIM, "TESLA");
    s_model = add_label(scr, MARGIN_X, 26, 140, 26, &key_font_20, C_INK, "Model Y");
    s_dot = lv_obj_create(scr);
    lv_obj_set_pos(s_dot, 144, 15);
    lv_obj_set_size(s_dot, 8, 8);
    lv_obj_set_style_radius(s_dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(s_dot, 0, 0);
    lv_obj_set_style_pad_all(s_dot, 0, 0);
    lv_obj_set_style_bg_color(s_dot, lv_color_hex(C_UNKNOWN), 0);
    lv_obj_set_style_bg_opa(s_dot, LV_OPA_COVER, 0);
    s_bt = add_icon(scr, 158, 12, 14, &key_icon_bluetooth, C_DIM);
    // battery：板子自身电量（CW2017 电量计，非车辆电量），图标+百分比文字
    s_batt = add_icon(scr, 177, 12, 14, &key_icon_battery, C_DIM);
    s_batt_txt = add_label(scr, 191, 11, 34, 16, &key_font_14, C_DIM, "--%");
    lv_obj_set_style_text_align(s_batt_txt, LV_TEXT_ALIGN_RIGHT, 0);

    // —— 中央列：flex 纵向均分（SPACE_EVENLY），车图/开盖小字/连接状态/
    //    分隔线/卡片行由布局引擎分配间隙，杜绝手工坐标的缝隙不一致 ——
    s_col = lv_obj_create(scr);
    lv_obj_set_pos(s_col, 0, 52);
    // 底部预留 18px（大于 MARGIN_Y）：外壳圆角会遮挡屏幕最底缘，卡片必须抬高
    lv_obj_set_size(s_col, LCD_W, LCD_H - 52 - 18);
    lv_obj_set_style_bg_opa(s_col, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(s_col, 0, 0);
    lv_obj_set_style_pad_all(s_col, 0, 0);
    lv_obj_set_scrollbar_mode(s_col, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_scrollable(s_col, false);
    lv_obj_set_flex_flow(s_col, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(s_col, LV_FLEX_ALIGN_SPACE_EVENLY, LV_FLEX_ALIGN_CENTER,
                          LV_FLEX_ALIGN_CENTER);

    // car：用户提供的 88×150 竖版正前视角全彩图（RGB565A8 原生尺寸直贴，
    // 缩放由 gen_key_icons.py 离线完成）；状态叠加色见 ui_tick 注释块。
    s_car = lv_image_create(s_col);
    lv_obj_set_size(s_car, 88, 150);
    lv_image_set_src(s_car, &key_icon_car);
    // 始终全彩原图：不染色（recolor 透明）
    lv_obj_set_style_image_recolor_opa(s_car, LV_OPA_TRANSP, 0);
    s_closure = add_label(s_col, 0, 0, LCD_W - 2 * MARGIN_X, 18, &key_font_14, C_DIM, "");
    s_sep = lv_obj_create(s_col);
    lv_obj_set_size(s_sep, LCD_W - 2 * MARGIN_X, 1);
    lv_obj_set_style_radius(s_sep, 0, 0);
    lv_obj_set_style_border_width(s_sep, 0, 0);
    lv_obj_set_style_pad_all(s_sep, 0, 0);
    lv_obj_set_style_bg_color(s_sep, lv_color_hex(C_LINE), 0);
    lv_obj_set_style_bg_opa(s_sep, LV_OPA_COVER, 0);

    // —— 底部卡片行：flex 横向均分（SPACE_EVENLY），三张纯图标卡片
    //    （对应右上/右中/右下键；用户定案去文字）。不可点：显式关 CLICKABLE ——
    s_row = lv_obj_create(s_col);
    lv_obj_set_size(s_row, LCD_W - 2 * MARGIN_X, 64);
    lv_obj_set_style_bg_opa(s_row, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(s_row, 0, 0);
    lv_obj_set_style_pad_all(s_row, 0, 0);
    lv_obj_set_scrollbar_mode(s_row, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_scrollable(s_row, false);
    lv_obj_set_flex_flow(s_row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(s_row, LV_FLEX_ALIGN_SPACE_EVENLY, LV_FLEX_ALIGN_CENTER,
                          LV_FLEX_ALIGN_CENTER);
    const lv_image_dsc_t *card_icons[3] = {&key_icon_lock, &key_icon_unlock, &key_icon_frunk};
    for (int i = 0; i < 3; i++) {
        lv_obj_t *card = lv_obj_create(s_row);
        lv_obj_set_size(card, 60, 64);
        lv_obj_set_clickable(card, false);
        lv_obj_set_style_bg_color(card, lv_color_hex(C_CARD_BG), 0);
        lv_obj_set_style_bg_opa(card, LV_OPA_COVER, 0);
        lv_obj_set_style_border_width(card, 1, 0);
        lv_obj_set_style_border_color(card, lv_color_hex(C_LINE), 0);
        lv_obj_set_style_radius(card, 10, 0);
        lv_obj_set_style_pad_all(card, 0, 0);
        lv_obj_set_scrollbar_mode(card, LV_SCROLLBAR_MODE_OFF);
        lv_obj_set_scrollable(card, false);
        add_icon(card, 14, 16, 32, card_icons[i], C_INK);
        s_card[i] = card;
    }

    // —— 操作反馈覆盖层（默认隐藏，占车辆区中央）——
    s_fb_check = add_icon(scr, 100, 70, 40, &key_icon_check, C_INK);
    s_fb_line1 = add_label(scr, MARGIN_X, 120, LCD_W - 2 * MARGIN_X, 26, &key_font_20, C_INK, "");
    s_fb_line2 = add_label(scr, MARGIN_X, 148, LCD_W - 2 * MARGIN_X, 18, &key_font_14, C_DIM, "");
    set_visible(s_fb_check, false);
    set_visible(s_fb_line1, false);
    set_visible(s_fb_line2, false);

    // —— 诊断页1 两行读数（默认隐藏）——
    s_diag_a = add_label(scr, MARGIN_X, 110, LCD_W - 2 * MARGIN_X, 18, &key_font_14, C_INK, "");
    s_diag_b = add_label(scr, MARGIN_X, 130, LCD_W - 2 * MARGIN_X, 60, &key_font_14, C_INK, "");
    lv_label_set_long_mode(s_diag_b, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(s_diag_b, LV_TEXT_ALIGN_LEFT, 0);
    set_visible(s_diag_a, false);
    set_visible(s_diag_b, false);

    // —— 首次绑定引导页（默认整组隐藏；无密钥/无档案时 tlb_app 自动进入）——
    s_onb_title = add_label(scr, MARGIN_X, 10, LCD_W - 2 * MARGIN_X, 26, &key_font_20, C_INK,
                            "首次使用·绑定车辆");
    s_onb_step = add_label(scr, MARGIN_X, 40, LCD_W - 2 * MARGIN_X, 54, &key_font_14, C_DIM,
                           ONB_STEP_DEFAULT);
    lv_obj_set_style_text_align(s_onb_step, LV_TEXT_ALIGN_LEFT, 0);
    // 失败时步骤区要整段显示绑定失败原因（运行时任意文本），必须自动换行
    lv_label_set_long_mode(s_onb_step, LV_LABEL_LONG_WRAP);
    s_onb_vin = add_label(scr, MARGIN_X, 97, LCD_W - 2 * MARGIN_X, 16, &key_font_14, C_INK, "");
    s_onb_status = add_label(scr, MARGIN_X, 117, LCD_W - 2 * MARGIN_X, 18, &key_font_14, C_INK, "");
    // 列表卡片：圆角边框容器，纵向 flex，每行是横向 flex
    s_onb_panel = lv_obj_create(scr);
    // 卡片下移并加高 12px：配网阶段二维码上下各留 6px 呼吸位，状态行与底部
    // 按键提示的间距也均衡（列表阶段 5 行 ×20px 仍放得下）
    lv_obj_set_pos(s_onb_panel, MARGIN_X - 2, 150);
    lv_obj_set_size(s_onb_panel, LCD_W - 2 * MARGIN_X + 4, 128);
    lv_obj_set_style_bg_color(s_onb_panel, lv_color_hex(C_CARD_BG), 0);
    lv_obj_set_style_bg_opa(s_onb_panel, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(s_onb_panel, lv_color_hex(C_LINE), 0);
    lv_obj_set_style_border_width(s_onb_panel, 1, 0);
    lv_obj_set_style_radius(s_onb_panel, 10, 0);
    // 配网二维码：多数手机连热点会自动弹配置页（captive portal），不弹的手机
    // 用相机扫这个码直达 http://192.168.4.2。只在 NOVIN 阶段显示（onb_render
    // 按阶段切换），位置占用列表卡片区域（该阶段列表本来就让位给指引）。
    s_onb_qr = lv_qrcode_create(scr);
    lv_qrcode_set_size(s_onb_qr, 116);
    lv_obj_set_pos(s_onb_qr, (LCD_W - 116) / 2, 156);
    {
        const char *qr_url = "http://" VIN_AP_IP;
        if (!lv_qrcode_update(s_onb_qr, qr_url, strlen(qr_url))) {
            ESP_LOGE(TAG, "配网二维码生成失败");
        }
    }
    lv_obj_set_style_pad_all(s_onb_panel, 6, 0);
    lv_obj_remove_flag(s_onb_panel, LV_OBJ_FLAG_SCROLLABLE);
    for (int i = 0; i < TLB_ONB_LIST_MAX; i++) {
        // 行容器：纵向绝对定位（行高20×5+pad12=112≤116，绝不漂移），
        // 横向 flex：名字吃掉剩余空间，vin6/RSSI 固定宽度永远留右内边距。
        // 纵向不用 flex 是教训：内容区只有 104px，flex 主轴分布会把第 5 行顶出卡片。
        s_onb_row[i] = lv_obj_create(s_onb_panel);
        lv_obj_set_size(s_onb_row[i], LV_PCT(100), 20);
        lv_obj_set_pos(s_onb_row[i], 0, i * 20);
        lv_obj_set_style_bg_opa(s_onb_row[i], LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(s_onb_row[i], 0, 0);
        lv_obj_set_style_pad_all(s_onb_row[i], 0, 0);
        lv_obj_set_flex_flow(s_onb_row[i], LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(s_onb_row[i], LV_FLEX_ALIGN_SPACE_BETWEEN,
                              LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
        lv_obj_remove_flag(s_onb_row[i], LV_OBJ_FLAG_SCROLLABLE);
        // 疑似特斯拉标记：8px 青色实心圆点
        s_onb_dot[i] = lv_obj_create(s_onb_row[i]);
        lv_obj_set_size(s_onb_dot[i], 8, 8);
        lv_obj_set_style_bg_color(s_onb_dot[i], lv_color_hex(C_SEL), 0);
        lv_obj_set_style_bg_opa(s_onb_dot[i], LV_OPA_COVER, 0);
        lv_obj_set_style_border_width(s_onb_dot[i], 0, 0);
        lv_obj_set_style_radius(s_onb_dot[i], LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_pad_all(s_onb_dot[i], 0, 0);
        lv_obj_remove_flag(s_onb_dot[i], LV_OBJ_FLAG_SCROLLABLE);
        // 名字：flex grow 吃掉剩余空间，固定单行高度，超长循环滚动不换行
        // （不换行是硬约束：WRAP 折行会撑高行容器，一页 5 行被挤成 4 行）
        s_onb_name[i] = lv_label_create(s_onb_row[i]);
        lv_obj_set_style_text_font(s_onb_name[i], &key_font_14, 0);
        lv_obj_set_style_text_color(s_onb_name[i], lv_color_hex(C_DIM), 0);
        lv_obj_set_style_bg_opa(s_onb_name[i], LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(s_onb_name[i], 0, 0);
        lv_obj_set_style_pad_all(s_onb_name[i], 0, 0);
        lv_obj_set_flex_grow(s_onb_name[i], 1);
        lv_label_set_long_mode(s_onb_name[i], LV_LABEL_LONG_SCROLL_CIRCULAR);
        lv_label_set_text(s_onb_name[i], "");
        // VIN6 尾号：固定小宽度，跟在名字后面
        s_onb_vin6[i] = lv_label_create(s_onb_row[i]);
        lv_obj_set_size(s_onb_vin6[i], 50, LV_SIZE_CONTENT);
        lv_obj_set_style_text_font(s_onb_vin6[i], &key_font_14, 0);
        lv_obj_set_style_text_color(s_onb_vin6[i], lv_color_hex(C_SEL), 0);
        lv_obj_set_style_bg_opa(s_onb_vin6[i], LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(s_onb_vin6[i], 0, 0);
        lv_obj_set_style_pad_all(s_onb_vin6[i], 0, 0);
        lv_label_set_text(s_onb_vin6[i], "");
        // RSSI：固定右端宽度，右对齐，flex 布局自然靠右不贴边
        s_onb_rssi[i] = lv_label_create(s_onb_row[i]);
        lv_obj_set_size(s_onb_rssi[i], 38, LV_SIZE_CONTENT);
        lv_obj_set_style_text_font(s_onb_rssi[i], &key_font_14, 0);
        lv_obj_set_style_text_color(s_onb_rssi[i], lv_color_hex(C_DIM), 0);
        lv_obj_set_style_text_align(s_onb_rssi[i], LV_TEXT_ALIGN_RIGHT, 0);
        lv_obj_set_style_bg_opa(s_onb_rssi[i], LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(s_onb_rssi[i], 0, 0);
        lv_obj_set_style_pad_all(s_onb_rssi[i], 0, 0);
        lv_label_set_text(s_onb_rssi[i], "");
    }
    s_onb_keys = add_label(scr, MARGIN_X, 292, LCD_W - 2 * MARGIN_X, 18, &key_font_14, C_WARN, "");
    set_onb_visible(false);

    lv_screen_load(scr);
    lv_timer_create(ui_tick, UI_PERIOD_MS, NULL);

    bsp_lvgl_unlock();

    bsp_display_backlight(80);
    ESP_LOGI(TAG, "界面就绪");
    return ESP_OK;
}
