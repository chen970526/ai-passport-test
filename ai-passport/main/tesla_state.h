// main/tesla_state.h —— “特斯拉钥匙”应用的核心状态与规则。
//
// 本文件刻意不依赖 ESP-IDF / LVGL / FreeRTOS：所有状态迁移、输入校验和
// 序列化都在这里以纯函数实现，可以在主机上直接测试（tests/test_tesla_state.c）。
// 硬件相关的事情（NVS、屏幕、蜂鸣、BLE）分别放在 tesla_store / tesla_ui /
// tesla_tone / tesla_ble 里，它们只做 I/O，不复制业务规则。
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define TESLA_PLATE_MAX      8   // 一块车牌最多 8 个码点（新能源车牌）
#define TESLA_NICK_MAX       15  // 昵称最多 15 个码点
#define TESLA_STATE_VERSION  1
#define TESLA_BLOB_SIZE      96  // tesla_state_encode() 需要的最小缓冲

// 支持绑定的车型。顺序与绑定向导列表一致，索引会被持久化，禁止中间插入。
typedef enum {
    TESLA_MODEL_MODEL3 = 0,
    TESLA_MODEL_MODELY,
    TESLA_MODEL_MODELS,
    TESLA_MODEL_MODELX,
    TESLA_MODEL_CYBERTRUCK,
    TESLA_MODEL_COUNT
} tesla_model_t;

typedef enum {
    TESLA_LOCK_LOCKED = 0,
    TESLA_LOCK_UNLOCKED,
    TESLA_LOCK_COUNT
} tesla_lock_t;

typedef enum {
    TESLA_PORT_CLOSED = 0,
    TESLA_PORT_MOVING, // 正在开/关，用于动画与“忙”判定
    TESLA_PORT_OPEN,
    TESLA_PORT_COUNT
} tesla_port_t;

// 钥匙可以下发的四条指令。
typedef enum {
    TESLA_CMD_LOCK = 0,
    TESLA_CMD_UNLOCK,
    TESLA_CMD_FRUNK,
    TESLA_CMD_TRUNK,
    TESLA_CMD_COUNT
} tesla_cmd_t;

typedef enum {
    TESLA_JOB_IDLE = 0,
    TESLA_JOB_SENDING, // 指令已下发，等待回执
    TESLA_JOB_ACCEPTED,
    TESLA_JOB_COUNT
} tesla_job_t;

// 指令被拒绝的原因，写入后由 step() 在 TESLA_DENY_MS 后自动清除。
typedef enum {
    TESLA_DENY_NONE = 0,
    TESLA_DENY_NOT_BOUND, // 还没有绑定车辆
    TESLA_DENY_BUSY,      // 上一条指令还在处理
    TESLA_DENY_LOCKED     // 车未解锁，不允许开前/后备箱
} tesla_deny_t;

// moving_closing 的方向标记：置位表示该盖正在关闭，未置位表示正在打开。
#define TESLA_CLOSING_FRUNK 0x01
#define TESLA_CLOSING_TRUNK 0x02

typedef struct {
    uint16_t codepoints[TESLA_PLATE_MAX];
    uint8_t len; // 已填入的码点数量
} tesla_plate_t;

typedef struct {
    uint16_t codepoints[TESLA_NICK_MAX];
    uint8_t len;
} tesla_nick_t;

typedef struct {
    bool bound;
    tesla_model_t model;
    tesla_plate_t plate;
    tesla_nick_t nick;

    tesla_lock_t lock;
    tesla_port_t frunk;
    tesla_port_t trunk;

    tesla_job_t job;
    tesla_cmd_t job_cmd;
    tesla_deny_t deny;
    tesla_cmd_t deny_cmd;        // 被拒的指令（仅用于提示文案）
    uint32_t deny_ms;            // 拒绝提示的产生时间（瞬时态，不持久化）
    uint32_t job_started_ms;
    uint32_t moving_since_ms;  // 前/后备箱 MOVING 中间态的起点，不参与持久化
    uint8_t moving_closing;    // TESLA_CLOSING_* 位掩码，表示 MOVING 的进行方向
    uint32_t updated_ms;
    uint32_t last_ok_ms;
    tesla_cmd_t last_ok_cmd;
} tesla_state_t;

// 指令从“下发”到“回执”的模拟时延、动画中间态时长，以及拒绝提示的停留时长。
#define TESLA_ACK_MS 900
#define TESLA_PORT_MOVE_MS 700
#define TESLA_DENY_MS 1500

// ---- 车牌编辑（纯逻辑，绑定向导只是它的一个调用方） -------------------

// 车牌可选码点集合：位置 0 只允许省份简称，其余位置允许大写字母与数字。
const uint16_t *tesla_plate_charset_position(uint8_t *count);
const uint16_t *tesla_plate_charset_rest(uint8_t *count);
// 省份简称集合的 UTF-8 写法，顺序与 tesla_plate_charset_position() 完全一致
// （主机测试会逐位核对），字体子集就是按这份字面量取字形的。
const char *tesla_plate_charset_position_utf8(void);

// 把 UTF-8 串解码成码点数组，返回写入的码点个数（超出 max 的部分丢弃）。
size_t tesla_utf8_decode(const char *text, uint16_t *out, size_t max);

// 在当前字符集里循环取值；delta 为 +1/-1。返回新的码点，空集返回 0。
uint16_t tesla_plate_cycle(uint16_t current, uint8_t pos, int8_t delta);
// 该位置是否允许此码点。
bool tesla_plate_pos_accepts(uint16_t cp, uint8_t pos);
// 把车牌追加一个码点；已满返回 false。
bool tesla_plate_append(tesla_plate_t *plate, uint16_t cp);
// 删除末位码点；空返回 false。
bool tesla_plate_pop(tesla_plate_t *plate);
void tesla_plate_clear(tesla_plate_t *plate);
// 绑定要求至少 2 位（省份简称 + 字母）。
bool tesla_plate_valid(const tesla_plate_t *plate);
// 把码点写成 UTF-8；缓冲不足返回 0（不含结尾 NUL 的长度）。
size_t tesla_plate_to_utf8(const tesla_plate_t *plate, char *out, size_t cap);

// ---- 状态机 -----------------------------------------------------------

void tesla_state_init(tesla_state_t *st);
// 绑定一辆车并复位成“已上锁、全部关闭”的静态。
void tesla_state_bind(tesla_state_t *st, tesla_model_t model, const tesla_plate_t *plate,
                      const tesla_nick_t *nick, uint32_t now_ms);
void tesla_state_unbind(tesla_state_t *st);

// 下发指令。返回 false 表示被拒绝（原因写入 st->deny，正在处理中的任务不受影响），
// 返回 true 表示进入 TESLA_JOB_SENDING。
bool tesla_state_dispatch(tesla_state_t *st, tesla_cmd_t cmd, uint32_t now_ms);
// 推进计时：SENDING -> ACCEPTED，MOVING -> 按 moving_closing 方向落到 OPEN/CLOSED。
// 返回状态是否发生变化。
bool tesla_state_step(tesla_state_t *st, uint32_t now_ms);
// UI 取走回执（显示 1.5s 后清空）。
void tesla_state_ack_done(tesla_state_t *st);

bool tesla_state_busy(const tesla_state_t *st);
const char *tesla_model_ascii(tesla_model_t model);
const char *tesla_cmd_ascii(tesla_cmd_t cmd);

// ---- 持久化 -----------------------------------------------------------

// 写入大端无关的紧凑二进制；成功返回写入字节数，0 表示缓冲不足或状态非法。
size_t tesla_state_encode(const tesla_state_t *st, uint8_t *out, size_t cap);
// 从 NVS 缓冲恢复；任何不一致都返回 false 并保持 *st 不被部分写入。
bool tesla_state_decode(tesla_state_t *st, const uint8_t *in, size_t len);
// 解码时只读地判断缓冲是否是一副有效档案（用于日志与降级）。
bool tesla_state_blob_looks_valid(const uint8_t *in, size_t len);

#ifdef __cplusplus
}
#endif
