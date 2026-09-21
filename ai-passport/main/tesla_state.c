// main/tesla_state.c —— 特斯拉钥匙的业务规则（纯逻辑，主机可测）。
#include "tesla_state.h"

#include <string.h>

// 车牌首位可选的省份简称（含“使”），顺序即字符选择器的循环顺序。
static const uint16_t PLATE_POS0[] = {
    0x4EAC, // 京
    0x6D25, // 津
    0x6CAA, // 沪
    0x6E1D, // 渝
    0x5180, // 冀
    0x8C6B, // 豫
    0x4E91, // 云
    0x8FBD, // 辽
    0x6842, // 桂
    0x6E58, // 湘
    0x95FD, // 闽
    0x7696, // 皖
    0x9C81, // 鲁
    0x82CF, // 苏
    0x6D59, // 浙
    0x8D63, // 赣
    0x5DDD, // 川
    0x9752, // 青
    0x85CF, // 藏
    0x743C, // 琼
    0x5B81, // 宁
    0x8D35, // 贵
    0x8499, // 蒙
    0x9655, // 陕
    0x7518, // 甘
    0x664B, // 晋
    0x5409, // 吉
    0x9ED1, // 黑
    0x9102, // 鄂
    0x65B0, // 新
    0x4F7F, // 使
};

#define PLATE_REST_COUNT 36 // A-Z + 0-9
static const uint16_t PLATE_REST[PLATE_REST_COUNT] = {
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
    'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
};

#define PLATE_POS0_UTF8                                                                        \
    "京津沪渝冀豫云辽桂湘闽皖鲁苏浙赣川青藏琼宁贵蒙陕甘晋吉黑鄂新使"

const uint16_t *tesla_plate_charset_position(uint8_t *count)
{
    *count = (uint8_t)(sizeof(PLATE_POS0) / sizeof(PLATE_POS0[0]));
    return PLATE_POS0;
}

const char *tesla_plate_charset_position_utf8(void)
{
    return PLATE_POS0_UTF8;
}

size_t tesla_utf8_decode(const char *text, uint16_t *out, size_t max)
{
    if (text == NULL || out == NULL) return 0;
    size_t n = 0;
    const uint8_t *p = (const uint8_t *)text;
    while (*p != '\0' && n < max) {
        uint32_t cp;
        uint8_t extra;
        if (p[0] < 0x80) {
            cp = p[0];
            extra = 0;
        } else if ((p[0] & 0xE0) == 0xC0) {
            cp = p[0] & 0x1Fu;
            extra = 1;
        } else if ((p[0] & 0xF0) == 0xE0) {
            cp = p[0] & 0x0Fu;
            extra = 2;
        } else if ((p[0] & 0xF8) == 0xF0) {
            cp = p[0] & 0x07u;
            extra = 3;
        } else {
            p++; // 非法首字节：跳过，保持推进
            continue;
        }
        for (uint8_t i = 1; i <= extra; i++) {
            if ((p[i] & 0xC0) != 0x80) { // 续接字节缺失，跳过该首字节
                cp = 0;
                break;
            }
            cp = (cp << 6) | (uint32_t)(p[i] & 0x3Fu);
        }
        if (cp == 0) {
            p++;
            continue;
        }
        out[n++] = (uint16_t)cp;
        p += extra + 1;
    }
    return n;
}

const uint16_t *tesla_plate_charset_rest(uint8_t *count)
{
    *count = PLATE_REST_COUNT;
    return PLATE_REST;
}

static const uint16_t *plate_charset_at(uint8_t pos, uint8_t *count)
{
    return (pos == 0) ? tesla_plate_charset_position(count)
                      : tesla_plate_charset_rest(count);
}

bool tesla_plate_pos_accepts(uint16_t cp, uint8_t pos)
{
    uint8_t count = 0;
    const uint16_t *set = plate_charset_at(pos, &count);
    for (uint8_t i = 0; i < count; i++) {
        if (set[i] == cp) return true;
    }
    return false;
}

uint16_t tesla_plate_cycle(uint16_t current, uint8_t pos, int8_t delta)
{
    uint8_t count = 0;
    const uint16_t *set = plate_charset_at(pos, &count);
    if (count == 0 || delta == 0) return current;

    int index = -1;
    for (uint8_t i = 0; i < count; i++) {
        if (set[i] == current) {
            index = (int)i;
            break;
        }
    }
    // 当前值不属于本位置的字符集（例如删掉了首位省份字）时，从集合边缘开始。
    if (index < 0) return set[(delta > 0) ? 0 : count - 1];

    int next = index + ((delta > 0) ? 1 : -1);
    if (next >= (int)count) next = 0;
    if (next < 0) next = (int)count - 1;
    return set[next];
}

bool tesla_plate_append(tesla_plate_t *plate, uint16_t cp)
{
    if (plate == NULL || cp == 0 || plate->len >= TESLA_PLATE_MAX) return false;
    if (!tesla_plate_pos_accepts(cp, plate->len)) return false;
    plate->codepoints[plate->len++] = cp;
    return true;
}

bool tesla_plate_pop(tesla_plate_t *plate)
{
    if (plate == NULL || plate->len == 0) return false;
    plate->codepoints[--plate->len] = 0;
    return true;
}

void tesla_plate_clear(tesla_plate_t *plate)
{
    if (plate != NULL) {
        plate->len = 0;
        memset(plate->codepoints, 0, sizeof(plate->codepoints));
    }
}

bool tesla_plate_valid(const tesla_plate_t *plate)
{
    if (plate == NULL || plate->len < 2 || plate->len > TESLA_PLATE_MAX) return false;
    for (uint8_t i = 0; i < plate->len; i++) {
        if (!tesla_plate_pos_accepts(plate->codepoints[i], i)) return false;
    }
    return true;
}

size_t tesla_plate_to_utf8(const tesla_plate_t *plate, char *out, size_t cap)
{
    if (plate == NULL || out == NULL || cap == 0) return 0;
    size_t used = 0;
    for (uint8_t i = 0; i < plate->len; i++) {
        const uint32_t cp = plate->codepoints[i];
        size_t need = (cp < 0x80) ? 1 : ((cp < 0x800) ? 2 : 3);
        if (used + need >= cap) return 0; // 必须给结尾 NUL 留位置
        if (need == 1) {
            out[used++] = (char)cp;
        } else if (need == 2) {
            out[used++] = (char)(0xC0 | (cp >> 6));
            out[used++] = (char)(0x80 | (cp & 0x3F));
        } else {
            out[used++] = (char)(0xE0 | (cp >> 12));
            out[used++] = (char)(0x80 | ((cp >> 6) & 0x3F));
            out[used++] = (char)(0x80 | (cp & 0x3F));
        }
    }
    out[used] = '\0';
    return used;
}

// ---- 状态机 -----------------------------------------------------------

void tesla_state_init(tesla_state_t *st)
{
    if (st == NULL) return;
    memset(st, 0, sizeof(*st));
    st->model = TESLA_MODEL_MODEL3;
    st->lock = TESLA_LOCK_LOCKED;
    st->frunk = TESLA_PORT_CLOSED;
    st->trunk = TESLA_PORT_CLOSED;
    st->job = TESLA_JOB_IDLE;
}

void tesla_state_bind(tesla_state_t *st, tesla_model_t model, const tesla_plate_t *plate,
                      const tesla_nick_t *nick, uint32_t now_ms)
{
    if (st == NULL || model >= TESLA_MODEL_COUNT || !tesla_plate_valid(plate)) return;
    st->bound = true;
    st->model = model;
    st->plate = *plate;
    st->nick = (nick != NULL) ? *nick : (tesla_nick_t){ 0 };
    st->lock = TESLA_LOCK_LOCKED;
    st->frunk = TESLA_PORT_CLOSED;
    st->trunk = TESLA_PORT_CLOSED;
    st->job = TESLA_JOB_IDLE;
    st->deny = TESLA_DENY_NONE;
    st->deny_cmd = TESLA_CMD_LOCK;
    st->deny_ms = 0;
    st->job_started_ms = 0;
    st->moving_since_ms = 0;
    st->moving_closing = 0;
    st->last_ok_cmd = TESLA_CMD_LOCK;
    st->last_ok_ms = 0;
    st->updated_ms = now_ms;
}

void tesla_state_unbind(tesla_state_t *st)
{
    if (st == NULL) return;
    const uint32_t now = st->updated_ms;
    tesla_state_init(st);
    st->updated_ms = now;
}

bool tesla_state_busy(const tesla_state_t *st)
{
    if (st == NULL) return false;
    return st->job == TESLA_JOB_SENDING || st->frunk == TESLA_PORT_MOVING ||
           st->trunk == TESLA_PORT_MOVING;
}

static void reject(tesla_state_t *st, tesla_cmd_t cmd, tesla_deny_t reason, uint32_t now_ms)
{
    // 拒绝只留下提示，绝不覆盖正在处理中的任务，否则会出现“按错了把上一条指令弄丢”。
    st->deny = reason;
    st->deny_cmd = cmd;
    st->deny_ms = now_ms;
}

bool tesla_state_dispatch(tesla_state_t *st, tesla_cmd_t cmd, uint32_t now_ms)
{
    if (st == NULL || cmd >= TESLA_CMD_COUNT) return false;

    if (!st->bound) {
        reject(st, cmd, TESLA_DENY_NOT_BOUND, now_ms);
        return false;
    }
    if (tesla_state_busy(st)) {
        reject(st, cmd, TESLA_DENY_BUSY, now_ms);
        return false;
    }
    if ((cmd == TESLA_CMD_FRUNK || cmd == TESLA_CMD_TRUNK) && st->lock != TESLA_LOCK_UNLOCKED) {
        reject(st, cmd, TESLA_DENY_LOCKED, now_ms);
        return false;
    }

    st->deny = TESLA_DENY_NONE;
    st->job = TESLA_JOB_SENDING;
    st->job_cmd = cmd;
    st->job_started_ms = now_ms;
    st->updated_ms = now_ms;
    return true;
}

static bool elapsed(uint32_t since, uint32_t now, uint32_t window)
{
    return (uint32_t)(now - since) >= window;
}

bool tesla_state_step(tesla_state_t *st, uint32_t now_ms)
{
    if (st == NULL) return false;
    bool changed = false;

    if (st->job == TESLA_JOB_SENDING && elapsed(st->job_started_ms, now_ms, TESLA_ACK_MS)) {
        st->job = TESLA_JOB_ACCEPTED;
        changed = true;
        bool started_motion = false;

        switch (st->job_cmd) {
        case TESLA_CMD_LOCK:
            // 锁车先把开着的盖子收起来，收完才算真正锁好。
            st->lock = TESLA_LOCK_LOCKED;
            if (st->frunk == TESLA_PORT_OPEN) {
                st->frunk = TESLA_PORT_MOVING;
                st->moving_closing |= TESLA_CLOSING_FRUNK;
                started_motion = true;
            }
            if (st->trunk == TESLA_PORT_OPEN) {
                st->trunk = TESLA_PORT_MOVING;
                st->moving_closing |= TESLA_CLOSING_TRUNK;
                started_motion = true;
            }
            break;
        case TESLA_CMD_UNLOCK:
            st->lock = TESLA_LOCK_UNLOCKED;
            break;
        case TESLA_CMD_FRUNK:
            if (st->frunk == TESLA_PORT_OPEN) {
                st->frunk = TESLA_PORT_CLOSED;
            } else {
                st->frunk = TESLA_PORT_MOVING;
                st->moving_closing &= (uint8_t)~TESLA_CLOSING_FRUNK;
                started_motion = true;
            }
            break;
        case TESLA_CMD_TRUNK:
            if (st->trunk == TESLA_PORT_OPEN) {
                st->trunk = TESLA_PORT_CLOSED;
            } else {
                st->trunk = TESLA_PORT_MOVING;
                st->moving_closing &= (uint8_t)~TESLA_CLOSING_TRUNK;
                started_motion = true;
            }
            break;
        default:
            break;
        }
        if (started_motion) st->moving_since_ms = now_ms;

        st->last_ok_cmd = st->job_cmd;
        st->last_ok_ms = now_ms;
        st->updated_ms = now_ms;
    }

    if ((st->frunk == TESLA_PORT_MOVING || st->trunk == TESLA_PORT_MOVING) &&
        elapsed(st->moving_since_ms, now_ms, TESLA_PORT_MOVE_MS)) {
        if (st->frunk == TESLA_PORT_MOVING) {
            const bool closing = (st->moving_closing & TESLA_CLOSING_FRUNK) != 0;
            st->frunk = closing ? TESLA_PORT_CLOSED : TESLA_PORT_OPEN;
            st->moving_closing &= (uint8_t)~TESLA_CLOSING_FRUNK;
            changed = true;
        }
        if (st->trunk == TESLA_PORT_MOVING) {
            const bool closing = (st->moving_closing & TESLA_CLOSING_TRUNK) != 0;
            st->trunk = closing ? TESLA_PORT_CLOSED : TESLA_PORT_OPEN;
            st->moving_closing &= (uint8_t)~TESLA_CLOSING_TRUNK;
            changed = true;
        }
        if (changed) st->updated_ms = now_ms;
    }

    if (st->deny != TESLA_DENY_NONE && elapsed(st->deny_ms, now_ms, TESLA_DENY_MS)) {
        st->deny = TESLA_DENY_NONE;
        changed = true;
    }

    return changed;
}

void tesla_state_ack_done(tesla_state_t *st)
{
    if (st == NULL) return;
    if (st->job == TESLA_JOB_ACCEPTED) {
        st->job = TESLA_JOB_IDLE;
    }
    if (st->deny != TESLA_DENY_NONE) {
        st->deny = TESLA_DENY_NONE;
    }
}

const char *tesla_model_ascii(tesla_model_t model)
{
    switch (model) {
    case TESLA_MODEL_MODEL3:     return "MODEL 3";
    case TESLA_MODEL_MODELY:     return "MODEL Y";
    case TESLA_MODEL_MODELS:     return "MODEL S";
    case TESLA_MODEL_MODELX:     return "MODEL X";
    case TESLA_MODEL_CYBERTRUCK: return "CYBERTRUCK";
    default:                     return "UNKNOWN";
    }
}

const char *tesla_cmd_ascii(tesla_cmd_t cmd)
{
    switch (cmd) {
    case TESLA_CMD_LOCK:   return "LOCK";
    case TESLA_CMD_UNLOCK: return "UNLOCK";
    case TESLA_CMD_FRUNK:  return "FRUNK";
    case TESLA_CMD_TRUNK:  return "TRUNK";
    default:               return "?";
    }
}

// ---- 持久化 -----------------------------------------------------------
//
// 紧凑小端布局（同一份实现同时服务目标机与主机测试）：
//   0  'T' 'K'        2  version(u8)   3  flags(u8, bit0=bound)
//   4  model(u8)      5  lock(u8)      6  frunk(u8)   7  trunk(u8)
//   8  plate_len(u8)  9  nick_len(u8)  10 checksum(u8)  11 保留
//   12.. 车牌码点[u16 * len] + 昵称码点[u16 * len]
#define HDR_SIZE 16
#define HDR_CHECKSUM 10 // 校验和字节本身不参与校验
#define BLOB_BOUND_BIT 0x01

static uint16_t rd16(const uint8_t *p) { return (uint16_t)(p[0] | ((uint16_t)p[1] << 8)); }

static void wr16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)(v >> 8);
}

static uint8_t checksum(const uint8_t *p, size_t len)
{
    uint8_t sum = 0;
    for (size_t i = 0; i < len; i++) {
        if (i == HDR_CHECKSUM) continue;
        sum = (uint8_t)(sum + p[i]);
    }
    return (uint8_t)(0xFF - sum);
}

size_t tesla_state_encode(const tesla_state_t *st, uint8_t *out, size_t cap)
{
    if (st == NULL || out == NULL || cap < TESLA_BLOB_SIZE) return 0;
    if (st->model >= TESLA_MODEL_COUNT || st->lock >= TESLA_LOCK_COUNT ||
        st->frunk >= TESLA_PORT_COUNT || st->trunk >= TESLA_PORT_COUNT ||
        st->plate.len > TESLA_PLATE_MAX || st->nick.len > TESLA_NICK_MAX) {
        return 0;
    }
    // 只持久化“车是什么、车门盖儿什么状态”，指令回执与动画中间态属于瞬时态。
    if (st->bound && !tesla_plate_valid(&st->plate)) return 0;
    if (!st->bound && (st->plate.len != 0 || st->nick.len != 0)) return 0;

    // MOVING 按方向收敛成一个静态值再写盘，避免断电重启后卡在动画中间态。
    const uint8_t frunk = (st->frunk == TESLA_PORT_MOVING)
                              ? ((st->moving_closing & TESLA_CLOSING_FRUNK) ? TESLA_PORT_CLOSED
                                                                           : TESLA_PORT_OPEN)
                              : (uint8_t)st->frunk;
    const uint8_t trunk = (st->trunk == TESLA_PORT_MOVING)
                              ? ((st->moving_closing & TESLA_CLOSING_TRUNK) ? TESLA_PORT_CLOSED
                                                                           : TESLA_PORT_OPEN)
                              : (uint8_t)st->trunk;

    memset(out, 0, HDR_SIZE);
    out[0] = 'T';
    out[1] = 'K';
    out[2] = TESLA_STATE_VERSION;
    out[3] = st->bound ? BLOB_BOUND_BIT : 0;
    out[4] = (uint8_t)st->model;
    out[5] = (uint8_t)st->lock;
    out[6] = frunk;
    out[7] = trunk;
    out[8] = st->plate.len;
    out[9] = st->nick.len;

    size_t n = HDR_SIZE;
    for (uint8_t i = 0; i < st->plate.len; i++, n += 2) wr16(out + n, st->plate.codepoints[i]);
    for (uint8_t i = 0; i < st->nick.len; i++, n += 2) wr16(out + n, st->nick.codepoints[i]);

    out[10] = checksum(out, n);
    return n;
}

bool tesla_state_blob_looks_valid(const uint8_t *in, size_t len)
{
    tesla_state_t scratch;
    return tesla_state_decode(&scratch, in, len);
}

bool tesla_state_decode(tesla_state_t *st, const uint8_t *in, size_t len)
{
    if (st == NULL || in == NULL || len < HDR_SIZE) return false;
    if (in[0] != 'T' || in[1] != 'K' || in[2] != TESLA_STATE_VERSION) return false;

    const uint8_t plate_len = in[8];
    const uint8_t nick_len = in[9];
    if (plate_len > TESLA_PLATE_MAX || nick_len > TESLA_NICK_MAX) return false;

    const size_t need = HDR_SIZE + (size_t)plate_len * 2 + (size_t)nick_len * 2;
    if (len < need) return false;
    if (checksum(in, need) != in[10]) return false;

    if (in[4] >= TESLA_MODEL_COUNT || in[5] >= TESLA_LOCK_COUNT || in[6] >= TESLA_PORT_COUNT ||
        in[7] >= TESLA_PORT_COUNT) {
        return false;
    }

    tesla_plate_t plate = { 0 };
    tesla_nick_t nick = { 0 };
    size_t n = HDR_SIZE;
    for (uint8_t i = 0; i < plate_len; i++, n += 2) plate.codepoints[i] = rd16(in + n);
    plate.len = plate_len;
    for (uint8_t i = 0; i < nick_len; i++, n += 2) nick.codepoints[i] = rd16(in + n);
    nick.len = nick_len;

    const bool bound = (in[3] & BLOB_BOUND_BIT) != 0;
    if (bound) {
        if (!tesla_plate_valid(&plate)) return false;
    } else if (plate_len != 0 || nick_len != 0) {
        return false;
    }

    tesla_state_t next;
    tesla_state_init(&next);
    next.bound = bound;
    next.model = (tesla_model_t)in[4];
    next.lock = (tesla_lock_t)in[5];
    next.frunk = (tesla_port_t)in[6];
    next.trunk = (tesla_port_t)in[7];
    next.plate = plate;
    next.nick = nick;
    *st = next;
    return true;
}
