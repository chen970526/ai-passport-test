// main/tesla_ui.c —— “特斯拉钥匙”界面：绑定向导 + 钥匙主控页 + 车辆管理页。
//
// 设计约定（见 tesla_ui.h 与 docs/development/ai-guide.zh_CN.md 的“二次开发 UI 强制
// 重新设计”）：
//   * 完全自绘，不使用基线 demo 的 ui_pixel 外壳，也不使用 LVGL_SYMBOL（避免依赖
//     内置符号字体，字形全部来自本应用自己生成的中文子集）。
//   * 不写任何业务判断：车控走 tesla_state_*，绑定录入走 tesla_wiz_*，两者都有主机测试；
//     几何布局全部取自 tesla_layout.h，同样有主机测试。
//   * 只在 tesla_ui_key() 与 lv_timer 回调里碰 LVGL 对象：前者自行取放 bsp_lvgl_lock，
//     后者已经运行在 LVGL 任务上下文内。
#include "tesla_ui.h"

#include <stdio.h>
#include <string.h>

#include "bsp_battery.h"
#include "bsp_display.h"
#include "esp_log.h"
#include "lvgl.h"
#include "tesla_layout.h"
#include "tesla_state.h"
#include "tesla_store.h"
#include "tesla_wizard.h"

static const char *TAG = "tesla_ui";

// 深色“数字钥匙卡”风格；圆角遮罩由 BSP 在刷屏时施加，这里只画内容。
#define C_BG     0x080B10
#define C_CARD   0x161D27
#define C_CARD_ON 0x1E2C3F
#define C_LINE   0x2B3849
#define C_INK    0xEAF0F8
#define C_DIM    0x8694A6
#define C_ACCENT 0x3E8BFF
#define C_OK     0x3DDC84
#define C_WARN   0xF0B429
#define C_ERR    0xF16A5A

// 由 tools/gen_tesla_font.py 生成的字形子集（ASCII + 本应用用到的全部中文）。
LV_FONT_DECLARE(tesla_font_20);
LV_FONT_DECLARE(tesla_font_14);

#define UI_PERIOD_MS   150 // 界面心跳：驱动状态机计时与动画
#define ACK_SHOW_MS    1200 // 回执停留时长（ACCEPTED 由 UI 负责消费）
#define BATTERY_EVERY  10   // 每 10 个心跳读一次电量（约 1.5s），别把 I2C 问爆
#define MANAGE_ITEMS   2

typedef struct {
    lv_obj_t *scr;
    lv_obj_t *title;
    lv_obj_t *battery;
    lv_obj_t *hint;
    // 主控页
    lv_obj_t *v_nick;
    lv_obj_t *v_plate;
    lv_obj_t *v_model;
    lv_obj_t *k_card[TESLA_KEY_COUNT];
    lv_obj_t *k_name[TESLA_KEY_COUNT];
    lv_obj_t *k_state[TESLA_KEY_COUNT];
    lv_obj_t *k_bar[TESLA_KEY_COUNT];
    lv_obj_t *status;
    // 向导页
    lv_obj_t *w_step;
    lv_obj_t *w_value;
    lv_obj_t *w_detail;
    lv_obj_t *w_summary;
    lv_obj_t *w_err;
    lv_obj_t *slot_box[TESLA_PLATE_MAX];
    lv_obj_t *slot_char[TESLA_PLATE_MAX];
    // 管理页
    lv_obj_t *m_card[MANAGE_ITEMS];
    lv_obj_t *m_name[MANAGE_ITEMS];
    lv_obj_t *m_desc[MANAGE_ITEMS];
} widgets_t;

// 页面构建/刷新互相引用（build_* 里要刷新一次，切换按键又在文件后部），先给原型。
static void show_page(tesla_ui_page_t page);
static void refresh_fob(void);
static void refresh_wizard(void);
static void refresh_manage(void);

static tesla_state_t s_state;
static tesla_wiz_t s_wiz;
static widgets_t s_ui;
static lv_timer_t *s_timer;
static tesla_ui_page_t s_page = TESLA_UI_NONE;
static uint8_t s_focus;      // 主控页=选中的钥匙；管理页=选中的条目
static bool s_rebinding;     // 向导标题区分“首次绑定”和“换绑”
static uint8_t s_divider;
static int s_battery_last = -2; // -2 = 未知，-1 = 电量计不可用

// 已落盘内容的快照，用来避免每 150ms 往 NVS 写一次。
static uint8_t s_saved[TESLA_BLOB_SIZE];
static bool s_saved_valid;

// 文案缓冲：同一函数内只用一个，赋值给标签后立即被 lv_label_set_text 复制走。
static char s_buf[TESLA_PLATE_MAX * 3 + TESLA_NICK_MAX * 3 + 64];

// ---- 静态文案 ----------------------------------------------------------

static const char *const KEY_NAME[TESLA_CMD_COUNT] = { "上锁", "解锁", "前备箱", "后备箱" };

static const char *const MANAGE_NAME[MANAGE_ITEMS] = { "换绑车辆", "解绑删除" };
static const char *const MANAGE_DESC[MANAGE_ITEMS] = { "重新填写车型车牌昵称",
                                                      "清除本机档案与状态" };

// ---- 小工具 ------------------------------------------------------------

static void set_text(lv_obj_t *label, const char *text)
{
    if (label == NULL || text == NULL) return;
    const char *cur = lv_label_get_text(label);
    if (cur != NULL && strcmp(cur, text) == 0) return; // 文本没变就别让 LVGL 重绘
    lv_label_set_text(label, text);
}

static void set_hidden(lv_obj_t *obj, bool hidden)
{
    if (obj == NULL) return;
    if (lv_obj_has_flag(obj, LV_OBJ_FLAG_HIDDEN) == hidden) return;
    if (hidden) lv_obj_add_flag(obj, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_clear_flag(obj, LV_OBJ_FLAG_HIDDEN);
}

static void apply_box(lv_obj_t *obj, uint32_t bg, uint32_t border, uint32_t width)
{
    lv_obj_set_style_bg_color(obj, lv_color_hex(bg), 0);
    lv_obj_set_style_bg_opa(obj, bg ? LV_OPA_COVER : LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_color(obj, lv_color_hex(border), 0);
    lv_obj_set_style_border_width(obj, width, 0);
    lv_obj_set_style_border_opa(obj, width ? LV_OPA_COVER : LV_OPA_TRANSP, 0);
}

static lv_obj_t *add_label(lv_obj_t *parent, tesla_rect_t r, const lv_font_t *font,
                           uint32_t color, lv_text_align_t align, const char *text)
{
    lv_obj_t *label = lv_label_create(parent);
    lv_obj_set_pos(label, r.x, r.y);
    lv_obj_set_size(label, r.w, r.h);
    apply_box(label, 0, 0, 0); // 去掉主题默认的底板与描边，只留文字
    lv_obj_set_style_text_font(label, font, 0);
    lv_obj_set_style_text_color(label, lv_color_hex(color), 0);
    lv_obj_set_style_text_align(label, align, 0);
    lv_obj_set_style_pad_all(label, 0, 0);
    lv_label_set_text(label, text);
    return label;
}

static lv_obj_t *add_box(lv_obj_t *parent, tesla_rect_t r, uint32_t bg, uint32_t border,
                         uint32_t width, lv_coord_t radius)
{
    lv_obj_t *box = lv_obj_create(parent);
    lv_obj_remove_style_all(box);
    lv_obj_remove_flag(box, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_remove_flag(box, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_pos(box, r.x, r.y);
    lv_obj_set_size(box, r.w, r.h);
    lv_obj_set_style_radius(box, radius, 0);
    apply_box(box, bg, border, width);
    return box;
}

static lv_obj_t *screen_create(void)
{
    lv_obj_t *scr = lv_obj_create(NULL);
    lv_obj_remove_flag(scr, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_bg_color(scr, lv_color_hex(C_BG), 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(scr, 0, 0);
    lv_obj_set_style_border_width(scr, 0, 0);
    lv_obj_set_style_pad_all(scr, 0, 0);
    return scr;
}

// 单个码点转 UTF-8：复用 tesla_state 里已经测过的编码器，不在界面重复制版逻辑。
static const char *cp_utf8(uint16_t cp)
{
    static char one[TESLA_PLATE_MAX * 3 + 1];
    tesla_plate_t tmp = { 0 };
    if (cp == 0) return "";
    tmp.codepoints[0] = cp;
    tmp.len = 1;
    (void)tesla_plate_to_utf8(&tmp, one, sizeof(one));
    return one;
}

static const char *plate_utf8(const tesla_plate_t *plate)
{
    if (plate == NULL || plate->len == 0) return "";
    if (tesla_plate_to_utf8(plate, s_buf, sizeof(s_buf)) == 0) return "";
    return s_buf;
}

static const char *state_nick_utf8(void)
{
    if (s_state.nick.len == 0) return "";
    tesla_plate_t tmp = { 0 }; // 借用同一套编码器（昵称来自预置表，长度远小于 8）
    const uint8_t n = (s_state.nick.len < TESLA_PLATE_MAX) ? s_state.nick.len : (TESLA_PLATE_MAX - 1);
    for (uint8_t i = 0; i < n; i++) tmp.codepoints[i] = s_state.nick.codepoints[i];
    tmp.len = n;
    return plate_utf8(&tmp);
}

// ---- 文案组合 ----------------------------------------------------------

static const char *cmd_cn(tesla_cmd_t cmd)
{
    if (cmd >= TESLA_CMD_COUNT) return "";
    return KEY_NAME[cmd];
}

static const char *port_cn(tesla_port_t port)
{
    switch (port) {
    case TESLA_PORT_CLOSED: return "关闭";
    case TESLA_PORT_MOVING: return "运动中";
    case TESLA_PORT_OPEN:   return "打开";
    default:                return "";
    }
}

// 每张钥匙卡下面的小字：这张卡对应的当前状态。
static const char *key_state_cn(tesla_cmd_t cmd)
{
    switch (cmd) {
    case TESLA_CMD_LOCK:   return s_state.lock == TESLA_LOCK_LOCKED ? "已上锁" : "未上锁";
    case TESLA_CMD_UNLOCK: return s_state.lock == TESLA_LOCK_UNLOCKED ? "已解锁" : "仍上锁";
    case TESLA_CMD_FRUNK:  return port_cn(s_state.frunk);
    case TESLA_CMD_TRUNK:  return port_cn(s_state.trunk);
    default:               return "";
    }
}

static uint32_t key_state_color(tesla_cmd_t cmd)
{
    if (!s_state.bound) return C_DIM;
    switch (cmd) {
    case TESLA_CMD_LOCK:
        return s_state.lock == TESLA_LOCK_LOCKED ? C_OK : C_DIM;
    case TESLA_CMD_UNLOCK:
        return s_state.lock == TESLA_LOCK_UNLOCKED ? C_OK : C_DIM;
    case TESLA_CMD_FRUNK:
        return s_state.frunk == TESLA_PORT_MOVING ? C_WARN
                                                  : (s_state.frunk == TESLA_PORT_OPEN ? C_OK : C_DIM);
    case TESLA_CMD_TRUNK:
        return s_state.trunk == TESLA_PORT_MOVING ? C_WARN
                                                  : (s_state.trunk == TESLA_PORT_OPEN ? C_OK : C_DIM);
    default:
        return C_DIM;
    }
}

// 拒绝原因直接写进目标缓冲：这里用的就是全局 s_buf，不能再套一层 "%s" 自我复制。
static void deny_render(char *out, size_t cap)
{
    switch (s_state.deny) {
    case TESLA_DENY_NOT_BOUND:
        (void)snprintf(out, cap, "请先绑定车辆");
        break;
    case TESLA_DENY_BUSY:
        (void)snprintf(out, cap, "上一条还在处理");
        break;
    case TESLA_DENY_LOCKED:
        (void)snprintf(out, cap, "解锁后才能%s打开",
                       s_state.deny_cmd == TESLA_CMD_TRUNK ? "后备箱" : "前备箱");
        break;
    default:
        out[0] = '\0';
        break;
    }
}

// 状态条：拒绝 > 处理中 > 回执 > 动画 > 静态总览。全部来自状态机字段，界面不做推断。
static void fob_status_line(char *out, size_t cap, uint32_t *color)
{
    const bool moving = s_state.frunk == TESLA_PORT_MOVING || s_state.trunk == TESLA_PORT_MOVING;
    if (s_state.deny != TESLA_DENY_NONE) {
        deny_render(out, cap);
        *color = C_ERR;
        return;
    }
    if (s_state.job == TESLA_JOB_SENDING) {
        (void)snprintf(out, cap, "%s 指令发送中", cmd_cn(s_state.job_cmd));
        *color = C_ACCENT;
        return;
    }
    if (s_state.job == TESLA_JOB_ACCEPTED) {
        (void)snprintf(out, cap, "已完成 %s", cmd_cn(s_state.last_ok_cmd));
        *color = C_OK;
        return;
    }
    if (!s_state.bound) {
        (void)snprintf(out, cap, "还没有绑定车辆");
        *color = C_WARN;
        return;
    }
    if (moving) {
        (void)snprintf(out, cap, "盖子运动中 %s",
                       (s_state.moving_closing & (TESLA_CLOSING_FRUNK | TESLA_CLOSING_TRUNK)) ? "关闭中"
                                                                                              : "打开中");
        *color = C_WARN;
        return;
    }
    (void)snprintf(out, cap, "%s 前%s 后%s", s_state.lock == TESLA_LOCK_LOCKED ? "已上锁" : "未上锁",
                   port_cn(s_state.frunk), port_cn(s_state.trunk));
    *color = s_state.lock == TESLA_LOCK_LOCKED ? C_DIM : C_INK;
}

// ---- 电量（仓库规范：右上角显示，读不到时优雅降级） --------------------

static void refresh_battery(void)
{
    const int soc = bsp_battery_soc();
    if (soc == s_battery_last) return;
    s_battery_last = soc;
    if (soc < 0) {
        set_text(s_ui.battery, "电量 --");
        lv_obj_set_style_text_color(s_ui.battery, lv_color_hex(C_DIM), 0);
        return;
    }
    (void)snprintf(s_buf, sizeof(s_buf), "电量 %d%%", soc);
    set_text(s_ui.battery, s_buf);
    lv_obj_set_style_text_color(s_ui.battery, lv_color_hex(soc <= 15 ? C_ERR : C_DIM), 0);
}

// ---- 持久化 ------------------------------------------------------------

static void note_saved(void)
{
    s_saved_valid = tesla_state_encode(&s_state, s_saved, sizeof(s_saved)) > 0;
}

// 静止且内容与上次不同时才写盘：既保留“锁状态断电也要记住”，又避免刷 NVS。
static void save_if_idle(void)
{
    if (!s_state.bound || s_state.job != TESLA_JOB_IDLE || tesla_state_busy(&s_state)) return;
    uint8_t now[TESLA_BLOB_SIZE];
    const size_t n = tesla_state_encode(&s_state, now, sizeof(now));
    if (n == 0) return;
    if (s_saved_valid && memcmp(s_saved, now, n) == 0) return;
    if (tesla_store_save(&s_state) == ESP_OK) {
        memcpy(s_saved, now, n);
        s_saved_valid = true;
    }
}

// ---- 页面公共页眉 ------------------------------------------------------

static void build_header(const char *title, const char *hint)
{
    s_ui.title = add_label(s_ui.scr, tesla_layout_title(), &tesla_font_20, C_INK,
                           LV_TEXT_ALIGN_LEFT, title);
    s_ui.battery = add_label(s_ui.scr, tesla_layout_battery(), &tesla_font_14, C_DIM,
                             LV_TEXT_ALIGN_RIGHT, "电量 --");
    s_ui.hint = add_label(s_ui.scr, tesla_layout_hint(), &tesla_font_14, C_DIM,
                          LV_TEXT_ALIGN_CENTER, hint);
    s_battery_last = -2;
    refresh_battery();
}

// ---- 主控页 ------------------------------------------------------------

// 钥匙卡的底色/描边只在唯一一处决定，refresh_fob 不再重复设置，避免互相覆盖。
static void apply_key_focus(void)
{
    for (uint8_t i = 0; i < TESLA_KEY_COUNT; i++) {
        const bool on = (i == s_focus);
        const uint32_t bg = !s_state.bound ? C_BG : (on ? C_CARD_ON : C_CARD);
        lv_obj_set_style_bg_color(s_ui.k_card[i], lv_color_hex(bg), 0);
        lv_obj_set_style_bg_opa(s_ui.k_card[i], LV_OPA_COVER, 0);
        lv_obj_set_style_border_width(s_ui.k_card[i], on ? 2 : 1, 0);
        lv_obj_set_style_border_color(s_ui.k_card[i], lv_color_hex(on ? C_ACCENT : C_LINE), 0);
        lv_obj_set_style_border_opa(s_ui.k_card[i], LV_OPA_COVER, 0);
        lv_obj_set_style_text_color(s_ui.k_name[i], lv_color_hex(on ? C_INK : C_DIM), 0);
        lv_obj_set_style_bg_color(s_ui.k_bar[i], lv_color_hex(on ? C_ACCENT : C_LINE), 0);
    }
}

static void build_fob(void)
{
    s_ui.scr = screen_create();
    build_header("数字钥匙", "上下键选择 单击执行 长按车辆管理");

    lv_obj_t *vehicle = add_box(s_ui.scr, tesla_layout_vehicle(), C_CARD, C_LINE, 1, 12);
    s_ui.v_nick = add_label(vehicle, tesla_layout_vehicle_nick(), &tesla_font_14, C_DIM,
                            LV_TEXT_ALIGN_CENTER, "");
    s_ui.v_plate = add_label(vehicle, tesla_layout_vehicle_plate(), &tesla_font_20, C_INK,
                             LV_TEXT_ALIGN_CENTER, "");
    s_ui.v_model = add_label(vehicle, tesla_layout_vehicle_model(), &tesla_font_14, C_DIM,
                             LV_TEXT_ALIGN_CENTER, "");

    for (uint8_t i = 0; i < TESLA_KEY_COUNT; i++) {
        s_ui.k_card[i] = add_box(s_ui.scr, tesla_layout_key(i), C_CARD, C_LINE, 1, 12);
        s_ui.k_name[i] = add_label(s_ui.k_card[i], tesla_layout_key_name(), &tesla_font_20, C_INK,
                                   LV_TEXT_ALIGN_CENTER, KEY_NAME[i]);
        s_ui.k_state[i] = add_label(s_ui.k_card[i], tesla_layout_key_state(), &tesla_font_14, C_DIM,
                                    LV_TEXT_ALIGN_CENTER, "");
        s_ui.k_bar[i] = add_box(s_ui.k_card[i], tesla_layout_key_bar(), C_LINE, 0, 0, 2);
    }

    s_ui.status = add_label(s_ui.scr, tesla_layout_status(), &tesla_font_14, C_INK,
                            LV_TEXT_ALIGN_CENTER, "");
    apply_box(s_ui.status, 0, 0, 0); // 标签不要主题默认的底板和描边

    refresh_fob();
}

static void refresh_fob(void)
{
    set_text(s_ui.v_nick, s_state.bound ? state_nick_utf8() : "未绑定");
    set_text(s_ui.v_plate, s_state.bound ? plate_utf8(&s_state.plate) : "绑定后显示车牌");
    set_text(s_ui.v_model, tesla_model_ascii(s_state.model));

    for (uint8_t i = 0; i < TESLA_KEY_COUNT; i++) {
        set_text(s_ui.k_state[i], s_state.bound ? key_state_cn((tesla_cmd_t)i) : "绑定后可用");
        lv_obj_set_style_text_color(s_ui.k_state[i], lv_color_hex(key_state_color((tesla_cmd_t)i)), 0);
    }
    apply_key_focus();

    uint32_t color = C_DIM;
    fob_status_line(s_buf, sizeof(s_buf), &color);
    set_text(s_ui.status, s_buf);
    lv_obj_set_style_text_color(s_ui.status, lv_color_hex(color), 0);
    refresh_battery();
}

static void fob_key(bsp_btn_t btn, bsp_btn_ev_t ev)
{
    if (ev == BSP_BTN_CLICK) {
        if (btn == BSP_BTN_UP) {
            s_focus = (uint8_t)((s_focus + TESLA_KEY_COUNT - 1) % TESLA_KEY_COUNT);
            apply_key_focus();
        } else if (btn == BSP_BTN_DOWN) {
            s_focus = (uint8_t)((s_focus + 1) % TESLA_KEY_COUNT);
            apply_key_focus();
        } else if (btn == BSP_BTN_OK) {
            // 忙 / 未解锁 / 未绑定都由状态机判定并给出 deny，界面只负责显示。
            (void)tesla_state_dispatch(&s_state, (tesla_cmd_t)s_focus, lv_tick_get());
            refresh_fob();
        }
        return;
    }
    if (ev == BSP_BTN_LONG && btn == BSP_BTN_OK) {
        show_page(TESLA_UI_MANAGE);
    }
}

// ---- 绑定向导页 --------------------------------------------------------

static const char *wiz_step_text(void)
{
    switch (s_wiz.step) {
    case TESLA_WIZ_MODEL:   return "第 1/4 步 选择车型";
    case TESLA_WIZ_PLATE:   return "第 2/4 步 输入车牌";
    case TESLA_WIZ_NICK:    return "第 3/4 步 选择昵称";
    case TESLA_WIZ_CONFIRM: return "第 4/4 步 确认绑定";
    default:                return "";
    }
}

static const char *wiz_hint_text(void)
{
    switch (s_wiz.step) {
    case TESLA_WIZ_MODEL:   return "上下键切换 单击下一步 长按取消";
    case TESLA_WIZ_PLATE:   return "上下改字 单击填下一位 双击删一位";
    case TESLA_WIZ_NICK:    return "上下切换 单击下一步 长按回车牌";
    case TESLA_WIZ_CONFIRM: return "单击确认 双击回第一步 长按取消";
    default:                return "";
    }
}

static const char *wiz_err_text(void)
{
    switch (s_wiz.err) {
    case TESLA_WIZ_ERR_PLATE_SHORT: return "车牌至少两位 省份简称加字母";
    case TESLA_WIZ_ERR_PLATE_FULL:  return "车牌已满 先双击删一位";
    default:                        return "";
    }
}

// 循环列表的“上一个 / 下一个”预览，让单键循环不显得突兀。
static void list_detail(char *out, size_t cap, uint8_t cur, uint8_t count,
                        const char *(*item)(uint8_t))
{
    const uint8_t prev = (uint8_t)((cur + count - 1u) % count);
    const uint8_t next = (uint8_t)((cur + 1u) % count);
    (void)snprintf(out, cap, "上一 %s 下一 %s", item(prev), item(next));
}

static const char *model_item(uint8_t idx)
{
    return tesla_model_ascii((tesla_model_t)idx);
}

static const char *nick_item(uint8_t idx)
{
    return tesla_wiz_nick_utf8(idx);
}

static void build_wizard(void)
{
    s_ui.scr = screen_create();
    build_header(s_rebinding ? "换绑车辆" : "绑定车辆", "");

    s_ui.w_step = add_label(s_ui.scr, tesla_layout_wiz_step(), &tesla_font_14, C_ACCENT,
                            LV_TEXT_ALIGN_CENTER, "");
    for (uint8_t i = 0; i < TESLA_PLATE_MAX; i++) {
        s_ui.slot_box[i] = add_box(s_ui.scr, tesla_layout_slot(i), C_CARD, C_LINE, 1, 6);
        s_ui.slot_char[i] = add_label(s_ui.slot_box[i], tesla_rect(0, 4, TESLA_SLOT_W, 24),
                                      &tesla_font_20, C_INK, LV_TEXT_ALIGN_CENTER, "");
    }
    s_ui.w_value = add_label(s_ui.scr, tesla_layout_wiz_value(), &tesla_font_20, C_INK,
                             LV_TEXT_ALIGN_CENTER, "");
    s_ui.w_detail = add_label(s_ui.scr, tesla_layout_wiz_detail(), &tesla_font_14, C_DIM,
                              LV_TEXT_ALIGN_CENTER, "");
    s_ui.w_summary = add_label(s_ui.scr, tesla_layout_wiz_summary(), &tesla_font_14, C_INK,
                               LV_TEXT_ALIGN_CENTER, "");
    s_ui.w_err = add_label(s_ui.scr, tesla_layout_wiz_err(), &tesla_font_14, C_ERR,
                           LV_TEXT_ALIGN_CENTER, "");
    refresh_wizard();
}

static void refresh_wizard(void)
{
    const bool plate_step = s_wiz.step == TESLA_WIZ_PLATE;
    const bool confirm = s_wiz.step == TESLA_WIZ_CONFIRM;

    set_text(s_ui.title, s_rebinding ? "换绑车辆" : "绑定车辆");
    set_text(s_ui.w_step, wiz_step_text());
    set_text(s_ui.hint, wiz_hint_text());

    for (uint8_t i = 0; i < TESLA_PLATE_MAX; i++) {
        set_hidden(s_ui.slot_box[i], !plate_step);
        if (!plate_step) continue;
        uint16_t cp = 0;
        if (i == s_wiz.pos) cp = s_wiz.candidate;
        else if (i < s_wiz.plate.len) cp = s_wiz.plate.codepoints[i];
        set_text(s_ui.slot_char[i], cp_utf8(cp));
        const bool cursor = (i == s_wiz.pos);
        apply_box(s_ui.slot_box[i], cursor ? C_CARD_ON : C_CARD, cursor ? C_ACCENT : C_LINE,
                  cursor ? 2 : 1);
    }

    switch (s_wiz.step) {
    case TESLA_WIZ_MODEL:
        set_text(s_ui.w_value, model_item((uint8_t)s_wiz.model));
        list_detail(s_buf, sizeof(s_buf), (uint8_t)s_wiz.model, TESLA_MODEL_COUNT, model_item);
        set_text(s_ui.w_detail, s_buf);
        break;
    case TESLA_WIZ_PLATE:
        set_text(s_ui.w_value, cp_utf8(s_wiz.candidate));
        (void)snprintf(s_buf, sizeof(s_buf), "第 %u 位 共 %u 位（满 8 位）",
                       (unsigned)(s_wiz.pos + 1), (unsigned)s_wiz.plate.len);
        set_text(s_ui.w_detail, s_buf);
        break;
    case TESLA_WIZ_NICK:
        set_text(s_ui.w_value, nick_item(s_wiz.nick));
        list_detail(s_buf, sizeof(s_buf), s_wiz.nick, TESLA_WIZ_NICK_COUNT, nick_item);
        set_text(s_ui.w_detail, s_buf);
        break;
    case TESLA_WIZ_CONFIRM:
        set_text(s_ui.w_value, plate_utf8(&s_wiz.plate));
        (void)snprintf(s_buf, sizeof(s_buf), "%s\n%s", model_item((uint8_t)s_wiz.model),
                       nick_item(s_wiz.nick));
        set_text(s_ui.w_detail, s_buf);
        break;
    default:
        break;
    }
    set_hidden(s_ui.w_value, confirm);
    set_hidden(s_ui.w_detail, false);
    set_hidden(s_ui.w_summary, !confirm);
    if (confirm) {
        (void)snprintf(s_buf, sizeof(s_buf), "车型 %s\n车牌 %s\n昵称 %s",
                       model_item((uint8_t)s_wiz.model), plate_utf8(&s_wiz.plate),
                       nick_item(s_wiz.nick));
        set_text(s_ui.w_summary, s_buf);
    }

    set_text(s_ui.w_err, wiz_err_text());
    set_hidden(s_ui.w_err, s_wiz.err == TESLA_WIZ_ERR_NONE);
    refresh_battery();
}

static void wizard_key(bsp_btn_t btn, bsp_btn_ev_t ev)
{
    tesla_wiz_key_t key;
    if (btn == BSP_BTN_UP && ev == BSP_BTN_CLICK) key = TESLA_WIZ_UP;
    else if (btn == BSP_BTN_DOWN && ev == BSP_BTN_CLICK) key = TESLA_WIZ_DOWN;
    else if (btn == BSP_BTN_OK && ev == BSP_BTN_CLICK) key = TESLA_WIZ_OK;
    else if (btn == BSP_BTN_OK && ev == BSP_BTN_DOUBLE) key = TESLA_WIZ_OK_DOUBLE;
    else if (btn == BSP_BTN_OK && ev == BSP_BTN_LONG) key = TESLA_WIZ_OK_LONG;
    else return;

    const uint32_t now = lv_tick_get();
    switch (tesla_wiz_handle(&s_wiz, key, now)) {
    case TESLA_WIZ_DONE: {
        tesla_nick_t nick;
        tesla_wiz_nick(s_wiz.nick, &nick);
        tesla_state_bind(&s_state, s_wiz.model, &s_wiz.plate, &nick, now);
        s_focus = 0;
        if (tesla_store_save(&s_state) != ESP_OK) {
            ESP_LOGW(TAG, "绑定成功但存档失败，掉电后会回到未绑定");
        }
        note_saved();
        show_page(TESLA_UI_FOB);
        break;
    }
    case TESLA_WIZ_CANCEL:
        if (s_state.bound) show_page(TESLA_UI_FOB);
        else refresh_wizard(); // 首次绑定没得退，停在第一步
        break;
    case TESLA_WIZ_DENY:
    case TESLA_WIZ_NONE:
    default:
        refresh_wizard();
        break;
    }
}

// ---- 车辆管理页 --------------------------------------------------------

static void build_manage(void)
{
    s_ui.scr = screen_create();
    build_header("车辆管理", "上下键选择 单击进入 长按返回");
    for (uint8_t i = 0; i < MANAGE_ITEMS; i++) {
        s_ui.m_card[i] = add_box(s_ui.scr, tesla_layout_manage_item(i), C_CARD, C_LINE, 1, 12);
        s_ui.m_name[i] = add_label(s_ui.m_card[i], tesla_layout_manage_name(), &tesla_font_20, C_INK,
                                   LV_TEXT_ALIGN_CENTER, MANAGE_NAME[i]);
        s_ui.m_desc[i] = add_label(s_ui.m_card[i], tesla_layout_manage_desc(), &tesla_font_14, C_DIM,
                                   LV_TEXT_ALIGN_CENTER, MANAGE_DESC[i]);
    }
    s_focus = 0;
    refresh_manage();
}

static void refresh_manage(void)
{
    for (uint8_t i = 0; i < MANAGE_ITEMS; i++) {
        const bool on = (i == s_focus);
        apply_box(s_ui.m_card[i], on ? C_CARD_ON : C_CARD, on ? C_ACCENT : C_LINE, on ? 2 : 1);
        lv_obj_set_style_text_color(s_ui.m_name[i], lv_color_hex(on ? C_INK : C_DIM), 0);
    }
    refresh_battery();
}

static void manage_key(bsp_btn_t btn, bsp_btn_ev_t ev)
{
    if (ev == BSP_BTN_CLICK && (btn == BSP_BTN_UP || btn == BSP_BTN_DOWN)) {
        const uint8_t step = (btn == BSP_BTN_UP) ? (uint8_t)(MANAGE_ITEMS - 1) : 1u;
        s_focus = (uint8_t)((s_focus + step) % MANAGE_ITEMS);
        refresh_manage();
        return;
    }
    if (ev == BSP_BTN_LONG && btn == BSP_BTN_OK) {
        show_page(TESLA_UI_FOB);
        return;
    }
    if (ev != BSP_BTN_CLICK || btn != BSP_BTN_OK) return;

    const uint32_t now = lv_tick_get();
    if (s_focus == 0) {
        s_rebinding = true;
        tesla_wiz_begin(&s_wiz, &s_state, now);
        show_page(TESLA_UI_WIZARD);
        return;
    }
    // 解绑：先擦档案，再直接进向导，不给“有钥匙但没绑定”的中间态留机会。
    if (tesla_store_erase() != ESP_OK) ESP_LOGW(TAG, "解绑时擦除存档失败");
    tesla_state_unbind(&s_state);
    s_saved_valid = false;
    s_rebinding = false;
    tesla_wiz_begin(&s_wiz, NULL, now);
    show_page(TESLA_UI_WIZARD);
}

// ---- 页面切换与心跳 ----------------------------------------------------

static void destroy_page(void)
{
    if (s_ui.scr != NULL) {
        lv_obj_delete(s_ui.scr);
    }
    memset(&s_ui, 0, sizeof(s_ui));
    s_page = TESLA_UI_NONE;
}

static void show_page(tesla_ui_page_t page)
{
    destroy_page();
    switch (page) {
    case TESLA_UI_FOB:    build_fob(); break;
    case TESLA_UI_WIZARD: build_wizard(); break;
    case TESLA_UI_MANAGE: build_manage(); break;
    default:              return;
    }
    s_page = page;
    lv_screen_load(s_ui.scr);
    ESP_LOGI(TAG, "页面: %d (bound=%d)", page, s_state.bound);
}

static void refresh_page(void)
{
    switch (s_page) {
    case TESLA_UI_FOB:    refresh_fob(); break;
    case TESLA_UI_WIZARD: refresh_wizard(); break;
    case TESLA_UI_MANAGE: refresh_manage(); break;
    default:              break;
    }
}

// 运行在 LVGL 任务里（esp_lvgl_port 的定时器），无需再加 bsp_lvgl_lock。
static void on_tick(lv_timer_t *timer)
{
    (void)timer;
    if (s_page == TESLA_UI_NONE) return;
    const uint32_t now = lv_tick_get();

    bool changed = tesla_state_step(&s_state, now);
    if (s_state.job == TESLA_JOB_ACCEPTED &&
        (uint32_t)(now - s_state.last_ok_ms) >= ACK_SHOW_MS) {
        tesla_state_ack_done(&s_state);
        changed = true;
    }
    if (s_page == TESLA_UI_WIZARD && tesla_wiz_tick(&s_wiz, now)) changed = true;

    if (++s_divider >= BATTERY_EVERY) {
        s_divider = 0;
        changed = true;
    }
    if (changed) refresh_page();
    if (s_page == TESLA_UI_FOB) save_if_idle();
}

// ---- 对外接口 ----------------------------------------------------------

esp_err_t tesla_ui_prepare(void)
{
    memset(&s_ui, 0, sizeof(s_ui));
    s_saved_valid = false;
    const esp_err_t err = tesla_store_load(&s_state);
    if (err == ESP_OK || err == ESP_ERR_NOT_FOUND || err == ESP_ERR_INVALID_CRC) {
        if (err != ESP_OK) ESP_LOGW(TAG, "无可用车辆档案: %s", esp_err_to_name(err));
        return ESP_OK; // 未绑定/损坏都从向导重新开始，界面照常起来
    }
    tesla_state_init(&s_state);
    ESP_LOGE(TAG, "读车辆档案失败: %s", esp_err_to_name(err));
    return err;
}

void tesla_ui_enter(void)
{
    if (s_page != TESLA_UI_NONE) {
        refresh_page();
        return;
    }
    if (s_timer == NULL) {
        s_timer = lv_timer_create(on_tick, UI_PERIOD_MS, NULL);
    }
    s_rebinding = false;
    if (s_state.bound) {
        s_focus = 0;
        show_page(TESLA_UI_FOB);
    } else {
        tesla_wiz_begin(&s_wiz, &s_state, lv_tick_get());
        show_page(TESLA_UI_WIZARD);
    }
    note_saved();
}

void tesla_ui_exit(void)
{
    if (s_timer) {
        lv_timer_delete(s_timer);
        s_timer = NULL;
    }
    if (s_ui.scr) {
        lv_obj_delete(s_ui.scr);
        s_ui.scr = NULL;
    }
    memset(&s_ui, 0, sizeof(s_ui));
    s_page = TESLA_UI_NONE;
}

void tesla_ui_key(bsp_btn_t btn, bsp_btn_ev_t ev)
{
    if (s_page == TESLA_UI_NONE) return;
    if (!bsp_lvgl_lock(500)) {
        ESP_LOGE(TAG, "取 LVGL 锁超时，按键被丢弃: btn=%d ev=%d", btn, ev);
        return;
    }
    switch (s_page) {
    case TESLA_UI_FOB:    fob_key(btn, ev); break;
    case TESLA_UI_WIZARD: wizard_key(btn, ev); break;
    case TESLA_UI_MANAGE: manage_key(btn, ev); break;
    default:              break;
    }
    bsp_lvgl_unlock();
}

const tesla_state_t *tesla_ui_state(void)
{
    return &s_state;
}

tesla_ui_page_t tesla_ui_page(void)
{
    return s_page;
}
