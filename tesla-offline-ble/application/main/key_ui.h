// application/main/key_ui.h —— 车钥匙最小界面：开机动画 + 连接/回执状态文案。
// 界面只读 tlb_app_ui_snapshot()，不做任何业务判断；文案等 RKE 功能稳定后再优化。
#pragma once

#include <stdbool.h>

#include "bsp_button.h"
#include "esp_err.h"

// 初始化显示与 LVGL 并建好界面。必须在 app_main 里调用一次；
// 失败只回错误码并打串口日志，BLE 主链路不受影响（无屏也能靠 console 操作）。
esp_err_t key_ui_start(void);

// 按键反馈：任意按键事件立刻在屏幕上亮出「右一(UP)/右二(DOWN)/右三(OK)」约 1.2 秒。
// 可从 button 组件任务调用（只写 volatile 变量，不碰 LVGL 对象）。
void key_ui_notify_btn(bsp_btn_t btn);

// 切换屏幕诊断模式（长按右三触发）：页1 显示按键线 ADC 电压/事件计数/剩余堆/
// 连接/重启原因，页2 显示最近两条固件日志。只写 volatile 标志，可从 button 任务调用。
void key_ui_toggle_diag(void);

// 诊断模式内翻页（右三单击触发）：页1 电压 ↔ 页2 日志。非诊断模式下无操作。
void key_ui_diag_next_page(void);

// 当前是否处于屏幕诊断模式（app_main 用它区分右三单击「翻页」还是「开前备箱」）。
bool key_ui_in_diag(void);

// 启动阶段打点（app_main 每完成一步 +1，诊断页1 的「阶=N」直接显示）：
// 1=界面就绪 2=BLE核心就绪 3=按键初始化返回 4=控制台已启动。
// 电池态按键失灵时，看阶停在哪就知道主任务卡死在哪一步。只写 volatile，任何线程可调。
void key_ui_boot_stage(int n);
