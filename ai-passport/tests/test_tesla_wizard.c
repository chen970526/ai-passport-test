// tests/test_tesla_wizard.c —— 绑定向导纯逻辑的主机测试。
//
// 覆盖：默认值/预填、每一步的按键语义、车牌光标不变式、字符集按位置生效、
// 错误提示的定时清除（含 tick 回绕）、以及“确认绑定/取消”这两个终态。
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "tesla_wizard.h"

#define CP_JING 0x4EAC /* 京 */
#define CP_HU   0x6CAA /* 沪 */

// 按一个键并断言向导没有要求界面做终态动作，用于“只是改数值”的按键。
static void press(tesla_wiz_t *w, tesla_wiz_key_t key, uint32_t now_ms)
{
    const tesla_wiz_result_t r = tesla_wiz_handle(w, key, now_ms);
    assert(r == TESLA_WIZ_NONE || r == TESLA_WIZ_DENY);
}

// 把车牌渲染成 UTF-8 后与期望串整串比对，失败时能直接看出少/错了哪一位。
static void expect_plate(const tesla_wiz_t *w, const char *utf8)
{
    char buf[64];
    const size_t n = tesla_plate_to_utf8(&w->plate, buf, sizeof(buf));
    assert(n == strlen(utf8));
    assert(memcmp(buf, utf8, n) == 0);
}

static void test_begin_defaults(void)
{
    tesla_wiz_t w;
    tesla_wiz_begin(&w, NULL, 0);
    assert(w.step == TESLA_WIZ_MODEL);
    assert(w.model == TESLA_MODEL_MODEL3);
    assert(w.plate.len == 0);
    assert(w.pos == 0);
    // 空车牌时光标落在第 0 位，候选值必须是省份简称集合的首项“京”。
    assert(w.candidate == CP_JING);
    assert(tesla_plate_pos_accepts(w.candidate, 0));
    puts("  ok begin_defaults");
}

static void test_begin_prefills_existing(void)
{
    tesla_state_t st;
    tesla_plate_t plate = { .len = 3 };
    tesla_nick_t nick;

    plate.codepoints[0] = CP_HU;
    plate.codepoints[1] = 'B';
    plate.codepoints[2] = '8';
    tesla_state_init(&st);
    tesla_wiz_nick(2, &nick); // “公司车”
    tesla_state_bind(&st, TESLA_MODEL_MODELY, &plate, &nick, 10);

    tesla_wiz_t w;
    tesla_wiz_begin(&w, &st, 20);
    assert(w.step == TESLA_WIZ_MODEL);
    assert(w.model == TESLA_MODEL_MODELY);
    expect_plate(&w, "沪B8");
    assert(w.nick == 2);
    assert(w.pos == 3);
    // 光标停在末尾之后的新格子里，候选值取该位字符集首项。
    assert(w.candidate == 'A');
    puts("  ok begin_prefill");
}

static void test_model_step(void)
{
    tesla_wiz_t w;
    tesla_wiz_begin(&w, NULL, 0);

    press(&w, TESLA_WIZ_DOWN, 1);
    assert(w.model == TESLA_MODEL_MODELY);
    press(&w, TESLA_WIZ_UP, 2);
    assert(w.model == TESLA_MODEL_MODEL3);
    // 列表是循环的：首项再往前一格落到末项。
    press(&w, TESLA_WIZ_UP, 3);
    assert(w.model == TESLA_MODEL_CYBERTRUCK);
    press(&w, TESLA_WIZ_DOWN, 4);
    assert(w.model == TESLA_MODEL_MODEL3);
    assert(w.candidate == CP_JING); // 选车型不应该动到车牌

    assert(tesla_wiz_handle(&w, TESLA_WIZ_OK_LONG, 5) == TESLA_WIZ_CANCEL);
    press(&w, TESLA_WIZ_OK, 6);
    assert(w.step == TESLA_WIZ_PLATE);
    puts("  ok model_step");
}

static void test_plate_commit_and_cursor(void)
{
    tesla_wiz_t w;
    tesla_wiz_begin(&w, NULL, 0);
    press(&w, TESLA_WIZ_OK, 1); // -> PLATE

    assert(w.pos == 0);
    press(&w, TESLA_WIZ_DOWN, 2);
    assert(w.candidate == 0x6D25); // 京 -> 津（集合顺序，见 PLATE_POS0）
    press(&w, TESLA_WIZ_UP, 3);
    assert(w.candidate == CP_JING);

    press(&w, TESLA_WIZ_OK, 4); // 落“京”
    expect_plate(&w, "京");
    assert(w.pos == 1);
    assert(w.candidate == 'A');
    // 第 1 位起不再接受省份简称。
    assert(!tesla_plate_pos_accepts(CP_JING, 1));

    press(&w, TESLA_WIZ_OK, 5); // 落“A”
    expect_plate(&w, "京A");
    assert(w.pos == 2);

    // 数字：从“A”往后循环 26 格是“0”（A-Z 共 26 项）。
    for (int i = 0; i < 26; i++) press(&w, TESLA_WIZ_DOWN, 6 + (uint32_t)i);
    assert(w.candidate == '0');
    press(&w, TESLA_WIZ_DOWN, 40);
    assert(w.candidate == '1');
    press(&w, TESLA_WIZ_OK, 41);
    expect_plate(&w, "京A1");

    // 回头改某一位：光标始终停在已存在的位上，OK 是覆盖而不是无限增长。
    press(&w, TESLA_WIZ_OK_DOUBLE, 42); // 删“1”
    expect_plate(&w, "京A");
    assert(w.pos == 2);
    assert(w.candidate == 'A');
    press(&w, TESLA_WIZ_UP, 43);
    // 第 1 位起的集合是 A-Z 后接 0-9 的单一循环，从“A”往前一格绕到末项“9”。
    assert(w.candidate == '9');
    puts("  ok plate_commit_and_cursor");
}

static void test_plate_charset_cycle_stays_in_set(void)
{
    tesla_wiz_t w;
    tesla_wiz_begin(&w, NULL, 0);
    press(&w, TESLA_WIZ_OK, 1);
    // 在第 0 位连按 40 次（超过集合长度），每一位都必须仍被该位置接受。
    for (uint8_t i = 0; i < 40; i++) {
        press(&w, TESLA_WIZ_DOWN, 2u + i);
        assert(tesla_plate_pos_accepts(w.candidate, 0));
    }
    assert(w.plate.len == 0); // 没按 OK 就不该写进车牌
    puts("  ok plate_charset_cycle");
}

static void test_plate_full_overwrites_last(void)
{
    tesla_wiz_t w;
    tesla_wiz_begin(&w, NULL, 0);
    press(&w, TESLA_WIZ_OK, 1);
    for (uint8_t i = 0; i < TESLA_PLATE_MAX; i++) press(&w, TESLA_WIZ_OK, 2u + i);

    assert(w.plate.len == TESLA_PLATE_MAX);
    assert(w.pos == TESLA_PLATE_MAX - 1); // 光标钳在最后一位
    const uint16_t before = w.plate.codepoints[TESLA_PLATE_MAX - 1];
    press(&w, TESLA_WIZ_OK, 20);          // 再按 OK 只覆盖，不越界
    assert(w.plate.len == TESLA_PLATE_MAX);
    assert(w.plate.codepoints[TESLA_PLATE_MAX - 1] == before);
    puts("  ok plate_full");
}

static void test_deny_and_tick(void)
{
    tesla_wiz_t w;
    tesla_wiz_begin(&w, NULL, 0);
    press(&w, TESLA_WIZ_OK, 100);

    // 空车牌不允许前进。
    assert(tesla_wiz_handle(&w, TESLA_WIZ_OK_LONG, 200) == TESLA_WIZ_DENY);
    assert(w.err == TESLA_WIZ_ERR_PLATE_SHORT);
    assert(w.step == TESLA_WIZ_PLATE);
    assert(!tesla_wiz_tick(&w, 200 + TESLA_WIZ_ERR_MS - 1));
    assert(w.err == TESLA_WIZ_ERR_PLATE_SHORT);
    assert(tesla_wiz_tick(&w, 200 + TESLA_WIZ_ERR_MS));
    assert(w.err == TESLA_WIZ_ERR_NONE);
    assert(!tesla_wiz_tick(&w, 9999)); // 没有提示时 tick 不产生重绘

    // 只有一位也不允许；两位起放行。
    press(&w, TESLA_WIZ_OK, 300);
    assert(tesla_wiz_handle(&w, TESLA_WIZ_OK_LONG, 301) == TESLA_WIZ_DENY);
    press(&w, TESLA_WIZ_OK, 302);
    assert(tesla_wiz_handle(&w, TESLA_WIZ_OK_LONG, 303) == TESLA_WIZ_NONE);
    assert(w.step == TESLA_WIZ_NICK);
    assert(w.err == TESLA_WIZ_ERR_NONE);
    puts("  ok deny_and_tick");
}

static void test_tick_survives_wrap(void)
{
    tesla_wiz_t w;
    tesla_wiz_begin(&w, NULL, 0);
    press(&w, TESLA_WIZ_OK, 1);
    assert(tesla_wiz_handle(&w, TESLA_WIZ_OK_LONG, 0xFFFFFFF0u) == TESLA_WIZ_DENY);
    // 回绕后的“现在”是一个小数值：用无符号差值仍然算得出正确的经过时间。
    assert(!tesla_wiz_tick(&w, 0x400u)); // 经过了 1040ms，未到 1200ms 窗口
    assert(tesla_wiz_tick(&w, 0x4A0u));  // 经过了 1200ms，提示到期
    puts("  ok tick_wrap");
}

static void test_nick_and_confirm(void)
{
    tesla_wiz_t w;
    tesla_wiz_begin(&w, NULL, 0);
    press(&w, TESLA_WIZ_OK, 1);   // PLATE
    press(&w, TESLA_WIZ_OK, 2);   // 京
    press(&w, TESLA_WIZ_OK, 3);   // A
    assert(tesla_wiz_handle(&w, TESLA_WIZ_OK_LONG, 4) == TESLA_WIZ_NONE);
    assert(w.step == TESLA_WIZ_NICK);

    press(&w, TESLA_WIZ_OK, 5);
    assert(w.step == TESLA_WIZ_CONFIRM);
    assert(tesla_wiz_handle(&w, TESLA_WIZ_OK, 6) == TESLA_WIZ_DONE);
    assert(w.step == TESLA_WIZ_CONFIRM); // DONE 不自己改状态，由调用方决定去向

    press(&w, TESLA_WIZ_UP, 7); // 复核页往前一格 = 回上一步继续改
    assert(w.step == TESLA_WIZ_NICK);
    press(&w, TESLA_WIZ_OK, 8);
    assert(w.step == TESLA_WIZ_CONFIRM);
    assert(tesla_wiz_handle(&w, TESLA_WIZ_OK_DOUBLE, 9) == TESLA_WIZ_NONE);
    assert(w.step == TESLA_WIZ_MODEL); // 双击 = 从头再来
    assert(tesla_wiz_handle(&w, TESLA_WIZ_OK_LONG, 10) == TESLA_WIZ_CANCEL);
    puts("  ok nick_and_confirm");
}

static void test_nick_back_and_data(void)
{
    tesla_wiz_t w;
    tesla_wiz_begin(&w, NULL, 0);
    press(&w, TESLA_WIZ_OK, 1);
    press(&w, TESLA_WIZ_OK, 2);
    press(&w, TESLA_WIZ_OK, 3);
    assert(tesla_wiz_handle(&w, TESLA_WIZ_OK_LONG, 4) == TESLA_WIZ_NONE);

    press(&w, TESLA_WIZ_UP, 5);
    assert(w.nick == TESLA_WIZ_NICK_COUNT - 1); // 循环到末项
    press(&w, TESLA_WIZ_DOWN, 6);
    assert(w.nick == 0);
    press(&w, TESLA_WIZ_OK_LONG, 7);
    assert(w.step == TESLA_WIZ_PLATE);
    assert(w.pos == 2); // 回车牌步时光标仍指向末尾之后的新格子
    assert(w.candidate == 'A');
    // 回退不应该丢已填内容。
    expect_plate(&w, "京A");

    // 昵称表：每一项都非空、可解码、不超长；越界安全降级。
    for (uint8_t i = 0; i < TESLA_WIZ_NICK_COUNT; i++) {
        tesla_nick_t nick;
        assert(tesla_wiz_nick_utf8(i)[0] != '\0');
        tesla_wiz_nick(i, &nick);
        assert(nick.len > 0 && nick.len <= TESLA_NICK_MAX);
        char buf[TESLA_NICK_MAX * 3 + 1];
        size_t used = 0;
        for (uint8_t k = 0; k < nick.len; k++) {
            const uint32_t cp = nick.codepoints[k];
            if (cp < 0x800) {
                buf[used++] = (char)(0xC0 | (cp >> 6));
                buf[used++] = (char)(0x80 | (cp & 0x3F));
            } else {
                buf[used++] = (char)(0xE0 | (cp >> 12));
                buf[used++] = (char)(0x80 | ((cp >> 6) & 0x3F));
                buf[used++] = (char)(0x80 | (cp & 0x3F));
            }
        }
        buf[used] = '\0';
        assert(used == strlen(tesla_wiz_nick_utf8(i)));
        assert(memcmp(buf, tesla_wiz_nick_utf8(i), used) == 0); // 中文昵称必须都是 3 字节
    }
    tesla_nick_t empty;
    tesla_wiz_nick(TESLA_WIZ_NICK_COUNT, &empty);
    assert(empty.len == 0);
    assert(tesla_wiz_nick_utf8(TESLA_WIZ_NICK_COUNT)[0] == '\0');
    puts("  ok nick_back_and_data");
}

static void test_null_safe(void)
{
    assert(tesla_wiz_handle(NULL, TESLA_WIZ_OK, 0) == TESLA_WIZ_NONE);
    assert(!tesla_wiz_tick(NULL, 0));
    tesla_wiz_begin(NULL, NULL, 0);
    tesla_wiz_nick(0, NULL);

    tesla_wiz_t w;
    tesla_wiz_begin(&w, NULL, 0);
    assert(tesla_wiz_handle(&w, TESLA_WIZ_KEY_COUNT, 0) == TESLA_WIZ_NONE);
    puts("  ok null_safe");
}

int main(void)
{
    puts("test_tesla_wizard");
    test_begin_defaults();
    test_begin_prefills_existing();
    test_model_step();
    test_plate_commit_and_cursor();
    test_plate_charset_cycle_stays_in_set();
    test_plate_full_overwrites_last();
    test_deny_and_tick();
    test_tick_survives_wrap();
    test_nick_and_confirm();
    test_nick_back_and_data();
    test_null_safe();
    puts("test_tesla_wizard: PASS");
    return 0;
}
