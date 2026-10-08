// application/main/app_button.h —— 特斯拉工程自带的 ADC 三键驱动。
// 与基线 bsp_button 同接口同行为，但 ADC 读取失败不再沉默：带重试，
// 并把真实原因（超时/校准…）打进日志（屏幕诊断页2 可见）。
#pragma once

#include "esp_err.h"
#include "bsp_button.h" // 复用 bsp_btn_t / bsp_btn_ev_t / bsp_btn_cb_t 类型

esp_err_t app_button_init(bsp_btn_cb_t cb, void *user);
int app_button_read_mv(void); // 失败重试后仍读不到才返回 -1
const char *app_button_last_err(void); // 最近一次 ADC 失败原因名（"无"=没失败过）
esp_err_t app_button_try_reinit(void); // 初始化失败时每 5 秒自愈重试一次

// 组合键（出厂重置）回调：先按住右三、再按下右一，两键一起保持 3 秒触发。
typedef void (*app_combo_cb_t)(void *user);
void app_button_set_combo_cb(app_combo_cb_t cb, void *user);
