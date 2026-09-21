// tests/test_tesla_ui_layout.c —— 布局数学的主机测试（见 tesla_layout.h 顶部说明）。
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "tesla_layout.h"

static int s_failures;

static void expect_inside(tesla_rect_t r, const char *what)
{
    if (!tesla_rect_inside(r)) {
        s_failures++;
        printf("FAIL %s 超出 %dx%d: x=%d y=%d w=%d h=%d\n", what, TESLA_UI_W, TESLA_UI_H, r.x,
               r.y, r.w, r.h);
    }
}

static void expect_no_overlap(tesla_rect_t a, tesla_rect_t b, const char *what)
{
    if (tesla_rect_overlap(a, b)) {
        s_failures++;
        printf("FAIL %s 相互重叠\n", what);
    }
}

// 子矩形必须落在父矩形内（相对坐标）
static void expect_within(tesla_rect_t child, tesla_rect_t parent, const char *what)
{
    const bool ok = child.x >= 0 && child.y >= 0 &&
                    (int32_t)child.x + child.w <= parent.w &&
                    (int32_t)child.y + child.h <= parent.h;
    if (!ok) {
        s_failures++;
        printf("FAIL %s 超出父容器: x=%d y=%d w=%d h=%d (父 %dx%d)\n", what, child.x, child.y,
               child.w, child.h, parent.w, parent.h);
    }
}

static void test_screen_geometry(void)
{
    expect_inside(tesla_layout_title(), "标题");
    expect_inside(tesla_layout_battery(), "电量");
    expect_inside(tesla_layout_hint(), "提示行");
    expect_inside(tesla_layout_vehicle(), "车辆牌");
    expect_inside(tesla_layout_status(), "状态条");
    for (uint8_t i = 0; i < TESLA_KEY_COUNT; i++) {
        expect_inside(tesla_layout_key(i), "钥匙卡");
        expect_inside(tesla_layout_manage_item(i), "管理条目");
    }
    for (uint8_t i = 0; i < 8; i++) {
        expect_inside(tesla_layout_slot(i), "车牌格");
    }
    expect_inside(tesla_layout_wiz_step(), "向导步骤");
    expect_inside(tesla_layout_wiz_value(), "向导取值");
    expect_inside(tesla_layout_wiz_detail(), "向导说明");
    expect_inside(tesla_layout_wiz_summary(), "向导复核");
    expect_inside(tesla_layout_wiz_err(), "向导报错");
    printf("PASS screen_geometry\n");
}

static void test_no_collision(void)
{
    // 页眉三件套两两不重叠
    expect_no_overlap(tesla_layout_title(), tesla_layout_battery(), "标题/电量");
    expect_no_overlap(tesla_layout_title(), tesla_layout_vehicle(), "标题/车辆牌");
    expect_no_overlap(tesla_layout_battery(), tesla_layout_vehicle(), "电量/车辆牌");
    expect_no_overlap(tesla_layout_status(), tesla_layout_hint(), "状态条/提示行");

    // 四把钥匙互不重叠，且都不压状态条与提示行
    for (uint8_t a = 0; a < TESLA_KEY_COUNT; a++) {
        for (uint8_t b = (uint8_t)(a + 1); b < TESLA_KEY_COUNT; b++) {
            expect_no_overlap(tesla_layout_key(a), tesla_layout_key(b), "钥匙卡之间");
        }
        expect_no_overlap(tesla_layout_key(a), tesla_layout_vehicle(), "钥匙卡/车辆牌");
        expect_no_overlap(tesla_layout_key(a), tesla_layout_status(), "钥匙卡/状态条");
        expect_no_overlap(tesla_layout_key(a), tesla_layout_hint(), "钥匙卡/提示行");
        expect_no_overlap(tesla_layout_manage_item(a), tesla_layout_hint(), "管理条目/提示行");
    }

    // 向导元素纵向不重叠
    expect_no_overlap(tesla_layout_wiz_step(), tesla_layout_slot(0), "向导步骤/车牌格");
    expect_no_overlap(tesla_layout_slot(7), tesla_layout_wiz_value(), "车牌格/取值");
    expect_no_overlap(tesla_layout_wiz_value(), tesla_layout_wiz_detail(), "取值/说明");
    expect_no_overlap(tesla_layout_wiz_detail(), tesla_layout_wiz_err(), "说明/报错");
    expect_no_overlap(tesla_layout_wiz_summary(), tesla_layout_wiz_err(), "复核/报错");
    printf("PASS no_collision\n");
}

static void test_children_fit(void)
{
    const tesla_rect_t vehicle = tesla_layout_vehicle();
    const tesla_rect_t nick = tesla_layout_vehicle_nick();
    const tesla_rect_t plate = tesla_layout_vehicle_plate();
    const tesla_rect_t model = tesla_layout_vehicle_model();
    expect_within(nick, vehicle, "昵称行");
    expect_within(plate, vehicle, "车牌行");
    expect_within(model, vehicle, "车型行");
    expect_no_overlap(nick, plate, "昵称/车牌");
    expect_no_overlap(plate, model, "车牌/车型");

    const tesla_rect_t card = tesla_layout_key(0);
    expect_within(tesla_layout_key_name(), card, "钥匙名称");
    expect_within(tesla_layout_key_state(), card, "钥匙状态");
    expect_within(tesla_layout_key_bar(), card, "钥匙指示条");

    const tesla_rect_t item = tesla_layout_manage_item(0);
    expect_within(tesla_layout_manage_name(), item, "管理标题");
    expect_within(tesla_layout_manage_desc(), item, "管理说明");
    printf("PASS children_fit\n");
}

static void test_plate_slots_are_contiguous(void)
{
    // 8 格等距、互不重叠、总宽与注释一致（229 = 8*26 + 7*3）
    int32_t total = 0;
    for (uint8_t i = 0; i < 8; i++) {
        const tesla_rect_t s = tesla_layout_slot(i);
        assert(s.w == TESLA_SLOT_W);
        assert(s.h == 32);
        assert(s.x == TESLA_UI_MARGIN + i * (TESLA_SLOT_W + TESLA_SLOT_GAP));
        if (i > 0) {
            expect_no_overlap(tesla_layout_slot(i - 1), s, "相邻车牌格");
        }
        total = s.x + s.w;
    }
    assert(total == TESLA_UI_MARGIN + 8 * TESLA_SLOT_W + 7 * TESLA_SLOT_GAP); // 235
    assert(total <= TESLA_UI_W);
    printf("PASS plate_slots (总宽到 x=%d)\n", total);
}

static void test_rect_helpers(void)
{
    const tesla_rect_t a = tesla_rect(0, 0, 10, 10);
    const tesla_rect_t touch = tesla_rect(10, 0, 10, 10);
    const tesla_rect_t hit = tesla_rect(9, 9, 10, 10);
    assert(tesla_rect_inside(a));
    assert(!tesla_rect_inside(tesla_rect(235, 0, 10, 10)));
    assert(!tesla_rect_inside(tesla_rect(0, 0, 0, 10)));
    assert(!tesla_rect_inside(tesla_rect(-1, 0, 10, 10)));
    assert(!tesla_rect_overlap(a, touch)); // 边对边不算重叠
    assert(tesla_rect_overlap(a, hit));
    assert(tesla_rect_overlap(a, a));
    printf("PASS rect_helpers\n");
}

int main(void)
{
    test_screen_geometry();
    test_no_collision();
    test_children_fit();
    test_plate_slots_are_contiguous();
    test_rect_helpers();
    if (s_failures != 0) {
        printf("布局测试失败 %d 项\n", s_failures);
        return 1;
    }
    printf("tesla_ui 布局: 全部通过\n");
    return 0;
}
