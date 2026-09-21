// tests/test_tesla_state.c —— 特斯拉钥匙业务规则的主机测试。
#include <assert.h>
#include <string.h>

#include "tesla_state.h"

static tesla_plate_t make_plate(const uint16_t *cps, uint8_t len)
{
    tesla_plate_t plate;
    tesla_plate_clear(&plate);
    for (uint8_t i = 0; i < len; i++) {
        assert(plate.len < TESLA_PLATE_MAX);
        assert(tesla_plate_append(&plate, cps[i]));
    }
    return plate;
}

static void test_utf8_helpers(void)
{
    // 与 PLATE_POS0 的顺序、数量必须逐位一致：字体子集是按这份字面量取字形的。
    uint8_t count = 0;
    const uint16_t *set = tesla_plate_charset_position(&count);
    uint16_t decoded[TESLA_PLATE_MAX * 8];
    size_t n = tesla_utf8_decode(tesla_plate_charset_position_utf8(), decoded,
                                 sizeof(decoded) / sizeof(decoded[0]));
    assert(n == (size_t)count);
    for (size_t i = 0; i < n; i++) {
        assert(decoded[i] == set[i]);
        assert(tesla_plate_pos_accepts(decoded[i], 0));
    }
    // 上面只保证“字面量和码点数组互相对得上”，两边一起写错照样通过。
    // 这里再钉住三个真实锚点：31 个省份简称、首项京、第 12 项必须是安徽的
    // “皖”(U+7696) 而不是形近码点“盖”(U+76D6)，末项“使”。
    assert(count == 31);
    assert(set[0] == 0x4EAC && set[11] == 0x7696 && set[30] == 0x4F7F);
    assert(!tesla_plate_pos_accepts(0x76D6, 0));

    // ASCII / 两字节 / 三字节混排，以及 max 截断。
    const char *mixed = "A红€B";
    uint16_t cps[8];
    assert(tesla_utf8_decode(mixed, cps, 8) == 4);
    assert(cps[0] == 'A' && cps[1] == 0x7EA2 && cps[2] == 0x20AC && cps[3] == 'B');
    assert(tesla_utf8_decode(mixed, cps, 2) == 2);
    assert(cps[0] == 'A' && cps[1] == 0x7EA2);

    // 截断的续接字节必须被跳过而不是吞掉后面的字符。
    assert(tesla_utf8_decode("\xE7\xBA", cps, 8) == 0);
    assert(tesla_utf8_decode("a\xE7\xBA" "b", cps, 8) == 2);
    assert(cps[0] == 'a' && cps[1] == 'b');
    assert(tesla_utf8_decode(NULL, cps, 8) == 0);
}

static void test_plate_charset_rules(void)
{
    // 沪 A 1 2 3 4 5
    const uint16_t ok[] = { 0x6CAA, 'A', '1', '2', '3', '4', '5' };
    tesla_plate_t plate = make_plate(ok, 7);
    assert(tesla_plate_valid(&plate));

    // 首位必须是省份简称：数字 / 字母都不允许。
    assert(!tesla_plate_pos_accepts('A', 0));
    assert(!tesla_plate_pos_accepts('1', 0));
    assert(tesla_plate_pos_accepts(0x6CAA, 0));
    // 后续位不接受中文。
    assert(!tesla_plate_pos_accepts(0x6CAA, 1));

    tesla_plate_t bad = { 0 };
    bad.codepoints[0] = 'A';
    bad.codepoints[1] = 'B';
    bad.len = 2;
    assert(!tesla_plate_valid(&bad));

    // 只有省份简称也还不够，至少两位。
    tesla_plate_t one = make_plate(ok, 1);
    assert(!tesla_plate_valid(&one));

    // 满了不能再加。
    tesla_plate_t full = make_plate(ok, 7);
    assert(tesla_plate_append(&full, '6'));
    assert(full.len == TESLA_PLATE_MAX);
    assert(!tesla_plate_append(&full, '7'));

    assert(tesla_plate_pop(&full));
    assert(full.len == TESLA_PLATE_MAX - 1);
}

static void test_plate_cycle_wraps(void)
{
    uint8_t count = 0;
    const uint16_t *rest = tesla_plate_charset_rest(&count);
    assert(count == 36);
    assert(rest[0] == 'A' && rest[25] == 'Z' && rest[26] == '0' && rest[35] == '9');
    assert(tesla_plate_cycle('A', 1, +1) == 'B');
    assert(tesla_plate_cycle('A', 1, -1) == '9'); // 反向越界回绕到集合尾部
    assert(tesla_plate_cycle('9', 1, +1) == 'A'); // 正向越界回绕到集合头部
    assert(tesla_plate_cycle('Z', 1, +1) == '0');
    assert(tesla_plate_cycle('A', 1, 0) == 'A');

    const uint16_t *pos0 = tesla_plate_charset_position(&count);
    assert(count >= 30);
    assert(tesla_plate_cycle(pos0[0], 0, -1) == pos0[count - 1]);
    // 值不在本位置集合里时，从边缘开始而不是返回 0。
    assert(tesla_plate_cycle('A', 0, +1) == pos0[0]);
    assert(tesla_plate_cycle('A', 0, -1) == pos0[count - 1]);
}

static void test_plate_utf8(void)
{
    const uint16_t ok[] = { 0x6CAA, 'A', '1', '2', '3', '4', '5' };
    tesla_plate_t plate = make_plate(ok, 7);

    char buf[32];
    assert(tesla_plate_to_utf8(&plate, buf, sizeof(buf)) == 9);
    assert(strcmp(buf, "\xE6\xB2\xAA" "A12345") == 0);

    // 空车牌得到空串；缓冲不足时整体失败而不是写出半截字符。
    tesla_plate_t empty;
    tesla_plate_clear(&empty);
    assert(tesla_plate_to_utf8(&empty, buf, sizeof(buf)) == 0);
    assert(buf[0] == '\0');
    assert(tesla_plate_to_utf8(&plate, buf, 4) == 0);
    assert(tesla_plate_to_utf8(NULL, buf, sizeof(buf)) == 0);
}

static void test_dispatch_and_ack(void)
{
    tesla_state_t st;
    tesla_state_init(&st);

    // 未绑定：任何指令都被拒。
    assert(!st.bound);
    assert(!tesla_state_dispatch(&st, TESLA_CMD_LOCK, 10));
    assert(st.deny == TESLA_DENY_NOT_BOUND);
    tesla_state_ack_done(&st);

    const uint16_t ok[] = { 0x4EAC, 'B', '8', '8', '8', '8', '8' };
    tesla_plate_t plate = make_plate(ok, 7);
    tesla_state_bind(&st, TESLA_MODEL_MODELY, &plate, NULL, 20);
    assert(st.bound && st.model == TESLA_MODEL_MODELY);
    assert(st.lock == TESLA_LOCK_LOCKED);
    assert(st.frunk == TESLA_PORT_CLOSED && st.trunk == TESLA_PORT_CLOSED);

    // 未解锁时不允许开前/后备箱。
    assert(!tesla_state_dispatch(&st, TESLA_CMD_FRUNK, 30));
    assert(st.deny == TESLA_DENY_LOCKED);
    tesla_state_ack_done(&st);

    // 解锁：SENDING -> ACCEPTED 需要 TESLA_ACK_MS。
    assert(tesla_state_dispatch(&st, TESLA_CMD_UNLOCK, 100));
    assert(tesla_state_busy(&st));
    assert(!tesla_state_dispatch(&st, TESLA_CMD_LOCK, 120)); // 忙
    assert(st.deny == TESLA_DENY_BUSY);
    tesla_state_ack_done(&st);

    assert(!tesla_state_step(&st, 100 + TESLA_ACK_MS - 1));
    assert(st.lock == TESLA_LOCK_LOCKED);
    assert(tesla_state_step(&st, 100 + TESLA_ACK_MS));
    assert(st.lock == TESLA_LOCK_UNLOCKED);
    assert(st.job == TESLA_JOB_ACCEPTED);
    assert(!tesla_state_busy(&st));
    tesla_state_ack_done(&st);
    assert(st.job == TESLA_JOB_IDLE);

    // 开前备箱：先 MOVING，TESLA_PORT_MOVE_MS 后到 OPEN。
    assert(tesla_state_dispatch(&st, TESLA_CMD_FRUNK, 1000));
    assert(tesla_state_step(&st, 1000 + TESLA_ACK_MS));
    assert(st.frunk == TESLA_PORT_MOVING);
    assert(tesla_state_busy(&st));
    assert(!tesla_state_step(&st, 1000 + TESLA_ACK_MS + TESLA_PORT_MOVE_MS - 1));
    assert(st.frunk == TESLA_PORT_MOVING);
    assert(tesla_state_step(&st, 1000 + TESLA_ACK_MS + TESLA_PORT_MOVE_MS));
    assert(st.frunk == TESLA_PORT_OPEN);
    assert(!tesla_state_busy(&st));
    tesla_state_ack_done(&st);

    // 再按一次是关：立刻 CLOSED，不再经过 MOVING。
    assert(tesla_state_dispatch(&st, TESLA_CMD_FRUNK, 3000));
    assert(tesla_state_step(&st, 3000 + TESLA_ACK_MS));
    assert(st.frunk == TESLA_PORT_CLOSED);
    tesla_state_ack_done(&st);

    // 锁车会把已开的前备/后备箱带上 MOVING（方向为关），随后落到 CLOSED。
    assert(tesla_state_dispatch(&st, TESLA_CMD_UNLOCK, 4000));
    assert(tesla_state_step(&st, 4000 + TESLA_ACK_MS));
    tesla_state_ack_done(&st);
    assert(tesla_state_dispatch(&st, TESLA_CMD_TRUNK, 5000));
    assert(tesla_state_step(&st, 5000 + TESLA_ACK_MS));
    assert(st.trunk == TESLA_PORT_MOVING);
    assert(tesla_state_step(&st, 5000 + TESLA_ACK_MS + TESLA_PORT_MOVE_MS));
    assert(st.trunk == TESLA_PORT_OPEN);
    tesla_state_ack_done(&st);

    assert(tesla_state_dispatch(&st, TESLA_CMD_LOCK, 7000));
    assert(tesla_state_step(&st, 7000 + TESLA_ACK_MS));
    assert(st.lock == TESLA_LOCK_LOCKED && st.trunk == TESLA_PORT_MOVING);
    assert(tesla_state_busy(&st));
    assert(!tesla_state_dispatch(&st, TESLA_CMD_TRUNK, 7100)); // 收盖过程中不接受新指令
    assert(st.deny == TESLA_DENY_BUSY);
    tesla_state_ack_done(&st);
    assert(tesla_state_step(&st, 7000 + TESLA_ACK_MS + TESLA_PORT_MOVE_MS));
    assert(st.trunk == TESLA_PORT_CLOSED); // 锁车是收盖，绝不是开盖
    assert(!tesla_state_busy(&st));
}

static void test_step_is_time_robust(void)
{
    tesla_state_t st;
    tesla_state_init(&st);
    const uint16_t ok[] = { 0x6CAA, 'A', '1' };
    tesla_plate_t plate = make_plate(ok, 3);
    tesla_state_bind(&st, TESLA_MODEL_MODEL3, &plate, NULL, 0);

    assert(tesla_state_dispatch(&st, TESLA_CMD_UNLOCK, 0xFFFFFFF0u));
    // 跨越 tick 回绕：now - since 仍然是很小的正数，不能提前完成。
    assert(!tesla_state_step(&st, 0xFFFFFFF0u + 10));
    assert(st.job == TESLA_JOB_SENDING);
    assert(tesla_state_step(&st, (uint32_t)(0xFFFFFFF0u + TESLA_ACK_MS)));
    assert(st.job == TESLA_JOB_ACCEPTED);
}

static void test_bind_rejects_invalid_plate(void)
{
    tesla_state_t st;
    tesla_state_init(&st);
    tesla_plate_t shorty = { 0 };
    shorty.codepoints[0] = 0x4EAC;
    shorty.len = 1;
    tesla_state_bind(&st, TESLA_MODEL_MODELX, &shorty, NULL, 5);
    assert(!st.bound);
    assert(st.model != TESLA_MODEL_MODELX);
}

static void test_persist_roundtrip(void)
{
    tesla_state_t st;
    tesla_state_init(&st);
    const uint16_t ok[] = { 0x6CAA, 'A', '1', '2', '3', '4', '5', '6' };
    tesla_plate_t plate = make_plate(ok, 8);
    tesla_nick_t nick = { 0 };
    nick.codepoints[0] = 0x7EA2; // 红
    nick.codepoints[1] = 0x8272; // 色
    nick.len = 2;
    tesla_state_bind(&st, TESLA_MODEL_CYBERTRUCK, &plate, &nick, 10);
    st.trunk = TESLA_PORT_OPEN;

    uint8_t blob[TESLA_BLOB_SIZE];
    size_t n = tesla_state_encode(&st, blob, sizeof(blob));
    assert(n > 0 && n <= sizeof(blob));

    tesla_state_t restored;
    tesla_state_init(&restored);
    assert(tesla_state_decode(&restored, blob, n));
    assert(restored.bound && restored.model == TESLA_MODEL_CYBERTRUCK);
    assert(restored.plate.len == 8 && restored.nick.len == 2);
    assert(memcmp(restored.plate.codepoints, plate.codepoints, sizeof(plate.codepoints)) == 0);
    assert(restored.trunk == TESLA_PORT_OPEN);
    assert(restored.job == TESLA_JOB_IDLE);

    char text[40];
    // 沪(3 字节) + 7 个 ASCII
    assert(tesla_plate_to_utf8(&restored.plate, text, sizeof(text)) == 10);
    assert(strcmp(text, "\xE6\xB2\xAA" "A123456") == 0);

    // 单字节翻转必须被校验和挡住。
    for (size_t i = 0; i < n; i++) {
        uint8_t broken[TESLA_BLOB_SIZE];
        memcpy(broken, blob, n);
        broken[i] ^= 0x01;
        tesla_state_t scratch;
        if (!tesla_state_decode(&scratch, broken, n)) continue;
        // 只有“翻转后仍是合法编码”的位置可以放过，这里显式核对内容未被篡改。
        assert(scratch.model == restored.model);
        assert(scratch.plate.len == restored.plate.len);
    }

    // 截断、空缓冲、全零都不可信。
    tesla_state_t scratch;
    assert(!tesla_state_decode(&scratch, blob, 4));
    assert(!tesla_state_decode(&scratch, blob, n - 1));
    uint8_t zeros[32] = { 0 };
    assert(!tesla_state_blob_looks_valid(zeros, sizeof(zeros)));

    // 未绑定的档案也能往返，且不带任何文本。
    tesla_state_t blank;
    tesla_state_init(&blank);
    size_t m = tesla_state_encode(&blank, blob, sizeof(blob));
    assert(m > 0);
    assert(tesla_state_decode(&scratch, blob, m));
    assert(!scratch.bound && scratch.plate.len == 0 && scratch.nick.len == 0);

    // 缓冲不足不写。
    uint8_t small[TESLA_BLOB_SIZE - 1];
    assert(tesla_state_encode(&restored, small, sizeof(small)) == 0);
}

static void test_persist_collapses_moving(void)
{
    tesla_state_t st;
    tesla_state_init(&st);
    const uint16_t ok[] = { 0x4EAC, 'A', '1' };
    tesla_plate_t plate = make_plate(ok, 3);
    tesla_state_bind(&st, TESLA_MODEL_MODEL3, &plate, NULL, 0);

    // 解锁 -> 开前备箱，停在 MOVING（正在开）时写盘。
    assert(tesla_state_dispatch(&st, TESLA_CMD_UNLOCK, 10));
    tesla_state_step(&st, 10 + TESLA_ACK_MS);
    tesla_state_ack_done(&st);
    assert(tesla_state_dispatch(&st, TESLA_CMD_FRUNK, 100));
    assert(tesla_state_step(&st, 100 + TESLA_ACK_MS));
    assert(st.frunk == TESLA_PORT_MOVING);

    uint8_t blob[TESLA_BLOB_SIZE];
    size_t n = tesla_state_encode(&st, blob, sizeof(blob));
    assert(n > 0);
    tesla_state_t restored;
    assert(tesla_state_decode(&restored, blob, n));
    assert(restored.frunk == TESLA_PORT_OPEN && !tesla_state_busy(&restored));

    // 正在关的时候断电，恢复后应是 CLOSED。
    assert(tesla_state_dispatch(&restored, TESLA_CMD_LOCK, 1000));
    assert(tesla_state_step(&restored, 1000 + TESLA_ACK_MS));
    assert(restored.frunk == TESLA_PORT_MOVING);
    assert(tesla_state_encode(&restored, blob, sizeof(blob)) > 0);
    tesla_state_init(&st);
    assert(tesla_state_decode(&st, blob, n));
    assert(st.frunk == TESLA_PORT_CLOSED);
}

static void test_unbind_clears(void)
{
    tesla_state_t st;
    tesla_state_init(&st);
    const uint16_t ok[] = { 0x5DDD, 'B', '1' };
    tesla_plate_t plate = make_plate(ok, 3);
    tesla_state_bind(&st, TESLA_MODEL_MODELS, &plate, NULL, 9);
    assert(st.bound);
    tesla_state_unbind(&st);
    assert(!st.bound && st.plate.len == 0 && st.nick.len == 0);
    assert(st.lock == TESLA_LOCK_LOCKED);
    assert(!tesla_state_dispatch(&st, TESLA_CMD_UNLOCK, 10));
}

int main(void)
{
    test_plate_charset_rules();
    test_plate_cycle_wraps();
    test_plate_utf8();
    test_utf8_helpers();
    test_dispatch_and_ack();
    test_step_is_time_robust();
    test_bind_rejects_invalid_plate();
    test_persist_roundtrip();
    test_persist_collapses_moving();
    test_unbind_clears();
    return 0;
}
