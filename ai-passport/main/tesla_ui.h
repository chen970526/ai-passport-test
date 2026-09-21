// main/tesla_ui.h —— “特斯拉钥匙”应用界面（绑定向导 + 钥匙主控页 + 车辆管理页）。
//
// 界面完全独立实现，不复用基线 demo 的 ui_pixel 外壳（二次开发强制重新设计 UI）。
// 本页只负责“把状态画出来 + 把按键翻译成向导/状态机的事件”，所有业务判断都在
// tesla_state（车控状态机）与 tesla_wizard（绑定向导状态机）里，且都有主机测试。
//
// 三键交互（应用自定义，不沿用 demo 菜单语义）：
//   UP / DOWN   在四把钥匙 / 向导可编辑项 / 管理页条目之间移动或改值
//   OK 单击     执行选中的钥匙；向导里表示“接受当前值并前进”
//   OK 双击     向导里表示“撤销一格 / 从头再来”
//   OK 长按     主控页=进入车辆管理；向导/管理页=返回或取消
#pragma once

#include "bsp_button.h"
#include "esp_err.h"
#include "tesla_state.h"

#ifdef __cplusplus
extern "C" {
#endif

// 当前显示的应用页面。 tesla_ui_page() 只读，便于日志与上层策略判断。
typedef enum {
    TESLA_UI_NONE = 0, // 还没建过界面
    TESLA_UI_FOB,      // 钥匙主控页
    TESLA_UI_WIZARD,   // 绑定向导
    TESLA_UI_MANAGE,   // 车辆管理（换绑 / 解绑）
} tesla_ui_page_t;

// 不持 LVGL 锁调用：挂载 NVS、读取已绑定的车辆档案。
// 必须在 tesla_ui_enter() 之前调用一次；档案损坏时按“未绑定”降级并返回 ESP_OK，
// 只有底层存储真的不可用时才返回错误（界面仍能以未绑定状态启动）。
esp_err_t tesla_ui_prepare(void);

// 持 LVGL 锁调用：按“是否已绑定”建立向导或主控页并加载到屏幕。
void tesla_ui_enter(void);

// 持 LVGL 锁调用：先停掉界面定时器，再删除所有对象并清空指针。
// 幂等：没建过界面时直接返回。
void tesla_ui_exit(void);

// 不持 LVGL 锁调用：内部自行取放 LVGL 锁。忽略不属于上述语义的按键事件。
void tesla_ui_key(bsp_btn_t btn, bsp_btn_ev_t ev);

// 只读访问当前车控状态（供日志/上层策略使用）；指针由本模块持有，禁止修改或释放。
const tesla_state_t *tesla_ui_state(void);

// 当前页面；未建界面时返回 TESLA_UI_NONE。
tesla_ui_page_t tesla_ui_page(void);

#ifdef __cplusplus
}
#endif
