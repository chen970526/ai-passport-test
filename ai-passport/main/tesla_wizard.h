// main/tesla_wizard.h —— “绑定车辆”向导的纯逻辑状态机。
//
// 与 tesla_state 一样，本文件不依赖 ESP-IDF / LVGL / FreeRTOS：向导的每一步、
// 按键语义、车牌编辑光标与校验全部是纯函数，可以在主机上直接测试
// （tests/test_tesla_wizard.c）。tesla_ui 只负责把这些状态画到屏幕上，
// 不复制任何判断逻辑。
//
// 按键语义（向导全局统一，界面底部逐字显示）：
//   UP / DOWN     修改当前步骤的值（车型列表 / 车牌字符 / 昵称列表）
//   OK 单击       前进：接受当前值并进入下一步
//   OK 双击       撤销：车牌步删除末位；确认步回到开头
//   OK 长按       后退 / 取消：返回上一步，首步表示取消向导
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "tesla_state.h"

#ifdef __cplusplus
extern "C" {
#endif

// 向导步骤。顺序即交互顺序，也是界面标题的取值依据。
typedef enum {
    TESLA_WIZ_MODEL = 0, // 选择车型
    TESLA_WIZ_PLATE,     // 编辑车牌（位置 0 为省份简称）
    TESLA_WIZ_NICK,      // 从预置昵称里挑一个
    TESLA_WIZ_CONFIRM,   // 复核并写入
    TESLA_WIZ_COUNT
} tesla_wiz_step_t;

// 按键事件。与 bsp_button 的事件一一对应，由 tesla_ui 负责翻译。
typedef enum {
    TESLA_WIZ_UP = 0,      // BSP_BTN_UP   + CLICK
    TESLA_WIZ_DOWN,        // BSP_BTN_DOWN + CLICK
    TESLA_WIZ_OK,          // BSP_BTN_OK   + CLICK
    TESLA_WIZ_OK_DOUBLE,   // BSP_BTN_OK   + DOUBLE
    TESLA_WIZ_OK_LONG,     // BSP_BTN_OK   + LONG
    TESLA_WIZ_KEY_COUNT
} tesla_wiz_key_t;

// 一次按键处理完之后 tesla_ui 要做的事。
typedef enum {
    TESLA_WIZ_NONE = 0, // 只是数值变化，重画当前步即可
    TESLA_WIZ_DENY,     // 操作无效，闪一下 err 文案
    TESLA_WIZ_DONE,     // 用户确认绑定：tesla_ui 负责 bind + 落盘 + 回主控页
    TESLA_WIZ_CANCEL,   // 用户取消：已绑定则回主控页，未绑定则留在首步
    TESLA_WIZ_COUNT_RESULTS
} tesla_wiz_result_t;

// 拒绝原因。与 tesla_deny_t 不同：这里是“输入不合法”，不是“车辆忙”。
typedef enum {
    TESLA_WIZ_ERR_NONE = 0,
    TESLA_WIZ_ERR_PLATE_SHORT, // 车牌不足 2 位，不能进入下一步
    TESLA_WIZ_ERR_PLATE_FULL   // 车牌已满 8 位，先删一位再改
} tesla_wiz_err_t;

// 向导内的错误提示停留时长（毫秒）。与状态机的 DENY 提示保持同一量级，
// 太短看不清、太长会让人以为卡住。
#define TESLA_WIZ_ERR_MS 1200

// 向导的全部可见状态。没有指针成员，可整体拷贝，也可 memset 清零。
typedef struct {
    tesla_wiz_step_t step;
    tesla_model_t model;    // 当前选中的车型
    tesla_plate_t plate;    // 已确定的车牌
    uint8_t pos;            // 编辑光标：0..TESLA_PLATE_MAX-1（钳位，见 .c 注释）
    uint16_t candidate;     // 光标所在位的候选码点（尚未写入 plate 的部分）
    uint8_t nick;           // 预置昵称下标
    tesla_wiz_err_t err;    // 需要提示的输入错误（瞬时态，不落盘）
    uint32_t err_ms;        // 错误产生时刻，用于自动消失
} tesla_wiz_t;

// 预置昵称的数量。界面与主机测试都用它做循环边界。
#define TESLA_WIZ_NICK_COUNT 5

// 初始化向导。st 可以为 NULL（全新设备）；已绑定时会用现有机型/车牌/昵称做预填，
// 让“换绑”从最省事的状态开始。now_ms 只用于给错误提示打时间戳。
void tesla_wiz_begin(tesla_wiz_t *w, const tesla_state_t *st, uint32_t now_ms);

// 处理一个按键。返回 tesla_ui 应当采取的动作；状态一律就地更新。
// w 为 NULL 或 key 越界时返回 TESLA_WIZ_NONE，不产生副作用。
tesla_wiz_result_t tesla_wiz_handle(tesla_wiz_t *w, tesla_wiz_key_t key, uint32_t now_ms);

// 周期调用：到时就清掉错误提示。返回提示是否发生变化（界面据此决定要不要重画）。
bool tesla_wiz_tick(tesla_wiz_t *w, uint32_t now_ms);

// 取第 idx 个预置昵称（UTF-8）。idx 越界返回空串，绝不返回 NULL，方便直接塞给标签。
const char *tesla_wiz_nick_utf8(uint8_t idx);

// 把第 idx 个预置昵称解码成 tesla_nick_t，供 tesla_state_bind() 使用。
// idx 越界时清空 *out。
void tesla_wiz_nick(uint8_t idx, tesla_nick_t *out);

#ifdef __cplusplus
}
#endif
