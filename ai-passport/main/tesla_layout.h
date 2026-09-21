// main/tesla_layout.h —— “特斯拉钥匙”的几何布局（纯整数计算，不含 LVGL）。
//
// 仓库规范（docs/development/ai-guide.zh_CN.md）要求“布局计算与 ESP-IDF/LVGL 分离，
// 优先加入主机逻辑测试”，所以屏幕尺寸、控件矩形全部放在这里，由
// tests/test_tesla_ui_layout.c 在主机上验证：所有控件都落在 240x320 之内、
// 四把钥匙互不重叠、钥匙区不与状态条/提示行相撞。tesla_ui.c 只消费这些矩形。
//
// 面板是 ST7789P3 240x320，四角有 BSP_LVGL_SCREEN_RADIUS(=30) 的圆角遮罩，
// 因此文字一律不贴屏幕四角，边距固定 6px。
#pragma once

#include <stdbool.h>
#include <stdint.h>

#define TESLA_UI_W      240 // 与 BSP_LVGL_SCREEN_H_RES 一致
#define TESLA_UI_H      320 // 与 BSP_LVGL_SCREEN_V_RES 一致
#define TESLA_UI_MARGIN 6   // 圆角遮罩安全边距
#define TESLA_KEY_COUNT 4   // 上锁 / 解锁 / 前备箱 / 后备箱
#define TESLA_SLOT_W    26  // 车牌单格宽
#define TESLA_SLOT_GAP  3   // 车牌格间距

typedef struct {
    int16_t x;
    int16_t y;
    int16_t w;
    int16_t h;
} tesla_rect_t;

static inline tesla_rect_t tesla_rect(int16_t x, int16_t y, int16_t w, int16_t h)
{
    tesla_rect_t r;
    r.x = x;
    r.y = y;
    r.w = w;
    r.h = h;
    return r;
}

// ---- 通用判据（主机测试用） --------------------------------------------

static inline bool tesla_rect_inside(tesla_rect_t r)
{
    if (r.w <= 0 || r.h <= 0) return false;
    if (r.x < 0 || r.y < 0) return false;
    if ((int32_t)r.x + (int32_t)r.w > TESLA_UI_W) return false;
    if ((int32_t)r.y + (int32_t)r.h > TESLA_UI_H) return false;
    return true;
}

// 边框相切（x+w == 另一块的 x）不算重叠。
static inline bool tesla_rect_overlap(tesla_rect_t a, tesla_rect_t b)
{
    if ((int32_t)a.x + (int32_t)a.w <= (int32_t)b.x) return false;
    if ((int32_t)b.x + (int32_t)b.w <= (int32_t)a.x) return false;
    if ((int32_t)a.y + (int32_t)a.h <= (int32_t)b.y) return false;
    if ((int32_t)b.y + (int32_t)b.h <= (int32_t)a.y) return false;
    return true;
}

// ---- 全局页眉（三个页面共用同一坐标，切页时视觉不跳动） ----------------

static inline tesla_rect_t tesla_layout_title(void)   { return tesla_rect(6, 2, 140, 26); }
static inline tesla_rect_t tesla_layout_battery(void) { return tesla_rect(152, 8, 80, 16); }
static inline tesla_rect_t tesla_layout_hint(void)    { return tesla_rect(6, 300, 228, 16); }

// ---- 钥匙主控页 --------------------------------------------------------

static inline tesla_rect_t tesla_layout_vehicle(void) { return tesla_rect(6, 30, 228, 64); }

// 车辆牌内部：昵称 14px / 车牌 20px / 车型 14px，三行都相对车辆牌定位。
static inline tesla_rect_t tesla_layout_vehicle_nick(void)  { return tesla_rect(2, 1, 224, 18); }
static inline tesla_rect_t tesla_layout_vehicle_plate(void) { return tesla_rect(2, 21, 224, 26); }
static inline tesla_rect_t tesla_layout_vehicle_model(void) { return tesla_rect(2, 47, 224, 16); }

// 2x2 钥匙卡：112x84，横向 120 步距、纵向 90 步距。
static inline tesla_rect_t tesla_layout_key(uint8_t idx)
{
    const int32_t i = (int32_t)idx;
    return tesla_rect((int16_t)(6 + (i % 2) * 120), (int16_t)(98 + (i / 2) * 90), 112, 84);
}

// 钥匙卡内部：名称 20px / 状态 14px / 选中指示条。
static inline tesla_rect_t tesla_layout_key_name(void)  { return tesla_rect(0, 10, 112, 26); }
static inline tesla_rect_t tesla_layout_key_state(void) { return tesla_rect(0, 42, 112, 18); }
static inline tesla_rect_t tesla_layout_key_bar(void)   { return tesla_rect(40, 68, 32, 5); }

static inline tesla_rect_t tesla_layout_status(void) { return tesla_rect(6, 276, 228, 22); }

// ---- 绑定向导页 --------------------------------------------------------

static inline tesla_rect_t tesla_layout_wiz_step(void)   { return tesla_rect(6, 32, 228, 18); }
static inline tesla_rect_t tesla_layout_wiz_value(void)  { return tesla_rect(6, 96, 228, 28); }
static inline tesla_rect_t tesla_layout_wiz_detail(void) { return tesla_rect(6, 126, 228, 18); }
static inline tesla_rect_t tesla_layout_wiz_summary(void){ return tesla_rect(6, 148, 228, 46); }
static inline tesla_rect_t tesla_layout_wiz_err(void)    { return tesla_rect(6, 200, 228, 18); }

// 车牌 8 格：单格 26x32，间距 3，总宽 8*26+7*3 = 229。
static inline tesla_rect_t tesla_layout_slot(uint8_t idx)
{
    const int32_t i = (int32_t)idx;
    return tesla_rect((int16_t)(TESLA_UI_MARGIN + i * (TESLA_SLOT_W + TESLA_SLOT_GAP)), 58,
                      TESLA_SLOT_W, 32);
}

// ---- 车辆管理页 --------------------------------------------------------

static inline tesla_rect_t tesla_layout_manage_item(uint8_t idx)
{
    return tesla_rect(6, (int16_t)(40 + (int32_t)idx * 54), 228, 48);
}

static inline tesla_rect_t tesla_layout_manage_name(void) { return tesla_rect(0, 2, 228, 26); }
static inline tesla_rect_t tesla_layout_manage_desc(void) { return tesla_rect(0, 29, 228, 17); }
