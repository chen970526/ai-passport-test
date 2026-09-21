// main/tesla_wizard.c —— 绑定向导的纯逻辑实现（不含任何界面/硬件代码）。
#include "tesla_wizard.h"

#include <string.h>

// 预置昵称。刻意不做自由文本输入：三键设备敲中文姓名既痛苦又需要整套字库，
// 固定清单让字形子集可控，也保证 NVS 里的昵称永远能被显示出来。
// 顺序即界面列表顺序，下标会被持久化到绑定结果里，禁止中间插入。
static const char *const NICKS[TESLA_WIZ_NICK_COUNT] = {
    "我的车",
    "家人车",
    "公司车",
    "朋友车",
    "代步车",
};

const char *tesla_wiz_nick_utf8(uint8_t idx)
{
    if (idx >= TESLA_WIZ_NICK_COUNT) return "";
    return NICKS[idx];
}

void tesla_wiz_nick(uint8_t idx, tesla_nick_t *out)
{
    if (out == NULL) return;
    memset(out, 0, sizeof(*out));
    if (idx >= TESLA_WIZ_NICK_COUNT) return;
    // 昵称按码点存，长度上限由 TESLA_NICK_MAX 兜底；预置串远短于此。
    out->len = (uint8_t)tesla_utf8_decode(NICKS[idx], out->codepoints, TESLA_NICK_MAX);
}

// 把编辑光标钳进合法区间，并让候选码点与光标位置保持一致。
//
// 不变式：pos <= min(plate.len, TESLA_PLATE_MAX-1)。也就是说光标永远停在
// “已存在的某一位”上，第 8 位填完之后仍指向第 8 位（改为覆盖），这样
// “车牌已满”不会变成一个需要向用户解释的死状态。
static void sync_cursor(tesla_wiz_t *w)
{
    if (w->pos >= TESLA_PLATE_MAX) w->pos = TESLA_PLATE_MAX - 1;
    if (w->pos < w->plate.len) {
        w->candidate = w->plate.codepoints[w->pos];
    } else {
        // 位置为空：取该位字符集首项。传 0 给 cycle 时它必然匹配不到任何码点，
        // 于是返回集合起点（见 tesla_plate_cycle 的“集合边缘”分支）。
        w->candidate = tesla_plate_cycle(0, w->pos, 1);
    }
}

void tesla_wiz_begin(tesla_wiz_t *w, const tesla_state_t *st, uint32_t now_ms)
{
    if (w == NULL) return;
    memset(w, 0, sizeof(*w));
    w->step = TESLA_WIZ_MODEL;
    w->err_ms = now_ms;

    if (st != NULL && st->bound) {
        // 换绑：沿用现有车型与车牌，省掉最费时间的手工录入。
        w->model = st->model;
        w->plate = st->plate;
        for (uint8_t i = 0; i < TESLA_WIZ_NICK_COUNT; i++) {
            tesla_nick_t preset;
            tesla_wiz_nick(i, &preset);
            if (preset.len == st->nick.len &&
                memcmp(preset.codepoints, st->nick.codepoints,
                       sizeof(uint16_t) * preset.len) == 0) {
                w->nick = i;
                break;
            }
        }
        w->pos = st->plate.len;
    }
    sync_cursor(w);
}

// 车牌步：把候选码点落到光标位上，并把光标往前挪一格。
// 返回 false 表示当前输入还不允许前进（此时已写好 err）。
static void plate_commit(tesla_wiz_t *w)
{
    const uint8_t slot = w->pos;
    if (slot < w->plate.len) {
        w->plate.codepoints[slot] = w->candidate; // 回头改某一位
    } else {
        // slot == plate.len < TESLA_PLATE_MAX：追加。候选值来自同一位置的字符集，
        // 因此 tesla_plate_append 的字符集校验一定通过。
        (void)tesla_plate_append(&w->plate, w->candidate);
    }
    if (w->pos < TESLA_PLATE_MAX - 1) w->pos = (uint8_t)(w->pos + 1);
    sync_cursor(w);
}

tesla_wiz_result_t tesla_wiz_handle(tesla_wiz_t *w, tesla_wiz_key_t key, uint32_t now_ms)
{
    if (w == NULL || key >= TESLA_WIZ_KEY_COUNT) return TESLA_WIZ_NONE;

    switch (w->step) {
    case TESLA_WIZ_MODEL:
        if (key == TESLA_WIZ_UP) {
            w->model = (tesla_model_t)((w->model + TESLA_MODEL_COUNT - 1u) % TESLA_MODEL_COUNT);
        } else if (key == TESLA_WIZ_DOWN) {
            w->model = (tesla_model_t)((w->model + 1u) % TESLA_MODEL_COUNT);
        } else if (key == TESLA_WIZ_OK) {
            w->step = TESLA_WIZ_PLATE;
            w->err = TESLA_WIZ_ERR_NONE;
            sync_cursor(w);
        } else if (key == TESLA_WIZ_OK_LONG) {
            return TESLA_WIZ_CANCEL;
        }
        break;

    case TESLA_WIZ_PLATE:
        if (key == TESLA_WIZ_UP) {
            w->candidate = tesla_plate_cycle(w->candidate, w->pos, -1);
        } else if (key == TESLA_WIZ_DOWN) {
            w->candidate = tesla_plate_cycle(w->candidate, w->pos, 1);
        } else if (key == TESLA_WIZ_OK) {
            plate_commit(w);
        } else if (key == TESLA_WIZ_OK_DOUBLE) {
            // 删末位：pop 之后光标指向新的末尾，候选值同步成该位的现值。
            if (tesla_plate_pop(&w->plate)) {
                w->pos = w->plate.len;
                sync_cursor(w);
            }
        } else if (key == TESLA_WIZ_OK_LONG) {
            if (!tesla_plate_valid(&w->plate)) {
                w->err = TESLA_WIZ_ERR_PLATE_SHORT;
                w->err_ms = now_ms;
                return TESLA_WIZ_DENY;
            }
            w->step = TESLA_WIZ_NICK;
            w->err = TESLA_WIZ_ERR_NONE;
        }
        break;

    case TESLA_WIZ_NICK:
        if (key == TESLA_WIZ_UP) {
            w->nick = (uint8_t)((w->nick + TESLA_WIZ_NICK_COUNT - 1u) % TESLA_WIZ_NICK_COUNT);
        } else if (key == TESLA_WIZ_DOWN) {
            w->nick = (uint8_t)((w->nick + 1u) % TESLA_WIZ_NICK_COUNT);
        } else if (key == TESLA_WIZ_OK) {
            w->step = TESLA_WIZ_CONFIRM;
        } else if (key == TESLA_WIZ_OK_LONG) {
            w->step = TESLA_WIZ_PLATE;
            sync_cursor(w);
        }
        break;

    case TESLA_WIZ_CONFIRM:
        if (key == TESLA_WIZ_OK) {
            return TESLA_WIZ_DONE;
        }
        if (key == TESLA_WIZ_UP || key == TESLA_WIZ_DOWN) {
            w->step = TESLA_WIZ_NICK; // 回到上一步继续改
        } else if (key == TESLA_WIZ_OK_DOUBLE) {
            w->step = TESLA_WIZ_MODEL;
            w->err = TESLA_WIZ_ERR_NONE;
        } else if (key == TESLA_WIZ_OK_LONG) {
            return TESLA_WIZ_CANCEL;
        }
        break;

    default:
        break;
    }
    return TESLA_WIZ_NONE;
}

bool tesla_wiz_tick(tesla_wiz_t *w, uint32_t now_ms)
{
    if (w == NULL || w->err == TESLA_WIZ_ERR_NONE) return false;
    // 用减法比较，tick 回绕时（约 49.7 天）依然正确。
    if ((uint32_t)(now_ms - w->err_ms) < TESLA_WIZ_ERR_MS) return false;
    w->err = TESLA_WIZ_ERR_NONE;
    return true;
}
