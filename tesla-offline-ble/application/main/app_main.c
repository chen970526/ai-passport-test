// application/main/app_main.c —— 整块板子 = 特斯拉车钥匙。
// 开机顺序：先把屏幕点起来（开机动画「正在连接车机…」），再起 BLE 主链路，
// 最后挂按键。左上角电源键是硬件开关，软件读不到；三个 ADC 键的映射见下表。
#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "tesla_ble/tlb_ble.h"

#include "bsp_button.h"
#include "app_button.h" // 自带三键驱动（bsp_button 的带错误日志+重试分叉版）
#include "bsp_battery.h" // CW2017 板载电量计（屏幕右上角百分比）
#include "key_ui.h"

static const char *TAG = "tlb";


// ---------------------------------------------------------------- 按键映射
// 三键共用 GPIO0 一路 ADC（分压窗口见 bsp_pins.h），物理顺序「右一/右二/右三」
// 与 UP/DOWN/OK 的对应关系已实机确认。按键不再打串口日志（刷屏日志页），
// 排障看诊断页1「键=N」计数与屏幕按键反馈。
#define BTN_RIGHT1 BSP_BTN_UP   // 右一 = 上锁（RKE 1）
#define BTN_RIGHT2 BSP_BTN_DOWN // 右二 = 解锁 + 启动授权（RKE 0 → 20）
#define BTN_RIGHT3 BSP_BTN_OK   // 右三 = 单击前备箱 / 双击后备箱 / 长按切诊断

// 组合键回调（运行在按键 esp_timer 任务）：只入队出厂重置命令，真正的清除
// 在 worker 任务串行执行。社区用户无需串口即可重置设备换车绑定。
static void on_combo_factory(void *user)
{
    (void)user;
    ESP_LOGW(TAG, "组合键触发：清除全部钥匙数据并重启");
    tlb_app_post(TLB_CMD_FACTORY_RESET, 0);
}

// 回调运行在 button 组件的 esp_timer 任务里：只做入队和 volatile 打点，绝不直接碰 BLE/LVGL。
// 动作认单击（CLICK）与右三双击（DOUBLE）；任意事件都推屏幕按键反馈（key_ui_notify_btn 只写 volatile），
// 这样不管按多久，用户都能立刻看到"屏幕认为我按的是哪个键"。
static void on_btn(bsp_btn_t btn, bsp_btn_ev_t ev, void *user)
{
    (void)user;
    // 不再打印「按键 X 单击」日志：按键事件会刷屏日志环形缓冲，把真正的
    // 业务日志挤掉（2026-10-10 用户实机反馈）。排障改用诊断页1「键=N」计数
    // + 屏幕按键反馈（key_ui_notify_btn），两者都不产生日志。
    key_ui_notify_btn(btn);
    if (btn == BTN_RIGHT3 && ev == BSP_BTN_LONG) {
        // 右三长按 = 屏幕诊断模式开关（无电脑时排查按键链路，见 key_ui.c）；
        // 引导模式下同样生效，方便新用户开箱时排查按键
        key_ui_toggle_diag();
    } else if (key_ui_in_diag()) {
        // 诊断模式内按键按页分流（必须排在引导分支之前，第 30 次修复）：
        // 页1：右三单击=进页2，其余吞掉；
        // 页2：右一/右二=上下滚动日志，右三单击=回页1，双击吞掉。
        if (btn == BTN_RIGHT3 && ev == BSP_BTN_CLICK) {
            key_ui_diag_next_page();
        } else if (key_ui_diag_page() == 1 && btn == BTN_RIGHT1 && ev == BSP_BTN_CLICK) {
            key_ui_diag_scroll(-1);
        } else if (key_ui_diag_page() == 1 && btn == BTN_RIGHT2 && ev == BSP_BTN_CLICK) {
            key_ui_diag_scroll(1);
        }
    } else if (tlb_app_onboarding()) {
        // 首次绑定引导模式：三键临时改作列表导航，绑定完成后自动恢复常态映射
        if (tlb_app_onb_rescan_pending()) {
            // 重扫确认弹窗（右一长按唤出）：右三单击=是，立刻重扫；其余单击=取消
            if (btn == BTN_RIGHT3 && ev == BSP_BTN_CLICK) {
                tlb_app_post(TLB_CMD_ONB_RESCAN, 0);
            } else if (ev == BSP_BTN_CLICK || ev == BSP_BTN_DOUBLE) {
                tlb_app_post(TLB_CMD_ONB_RESCAN_CANCEL, 0);
            }
        } else if (btn == BTN_RIGHT1 && ev == BSP_BTN_CLICK) {
            tlb_app_onb_move(-1); // 右一 = 光标上移（列表按信号强度排序）
        } else if (btn == BTN_RIGHT2 && ev == BSP_BTN_CLICK) {
            tlb_app_onb_move(1); // 右二 = 光标下移
        } else if (btn == BTN_RIGHT1 && ev == BSP_BTN_LONG) {
            tlb_app_post(TLB_CMD_ONB_RESCAN_ASK, 0); // 右一长按 = 重扫确认弹窗（防误触）
        } else if (btn == BTN_RIGHT3 && ev == BSP_BTN_CLICK) {
            tlb_app_onb_press(); // 右三单击 = 连接光标所指车辆；PAIRING 中 = 我已确认
        } else if (btn == BTN_RIGHT3 && ev == BSP_BTN_DOUBLE) {
            tlb_app_post(TLB_CMD_ONB_RESCAN, 0); // 右三双击 = 重新扫描
        }
    } else if (btn == BTN_RIGHT1 && ev == BSP_BTN_CLICK) {
        tlb_app_post(TLB_CMD_RKE, 1); // LOCK 上锁
    } else if (btn == BTN_RIGHT2 && ev == BSP_BTN_CLICK) {
        // 解锁 + 启动：worker 串行消费，先 0（UNLOCK）再 20（REMOTE_DRIVE）
        tlb_app_post(TLB_CMD_RKE, 0);
        tlb_app_post(TLB_CMD_RKE, 20);
    } else if (btn == BTN_RIGHT3 && ev == BSP_BTN_CLICK) {
        if (key_ui_in_diag()) {
            key_ui_diag_next_page(); // 诊断内右三单击 = 页1↔页2 翻页
        } else {
            tlb_app_post(TLB_CMD_LID, 0); // 右三单击 = 开前备箱
        }
    } else if (btn == BTN_RIGHT3 && ev == BSP_BTN_DOUBLE) {
        if (!key_ui_in_diag()) {
            tlb_app_post(TLB_CMD_LID, 1); // 右三双击 = 开后备箱（诊断内不响应，双击会连带动一次锁机构）
        }
    }
}

void app_main(void)
{
    // 屏幕先行：开机动画要尽早出现；失败不致命，BLE 与串口命令照常
    if (key_ui_start() != ESP_OK) {
        ESP_LOGW(TAG, "界面未就绪，仅串口可用");
    }
    key_ui_boot_stage(1); // 界面就绪
    // 板载电量计（软依赖）：CW2017 不应答时屏幕电量显示 "--%"，不致命。
    // 放主任务初始化：电量计首次上电可能要写 profile（最长等 5 秒），
    // 不能塞进 LVGL 任务里卡屏幕刷新。
    if (bsp_battery_init() == ESP_OK) {
        ESP_LOGI(TAG, "电量计就绪:SOC=%d%%", bsp_battery_soc());
    } else {
        ESP_LOGW(TAG, "电量计不可用,屏幕电量显示为未知");
    }
    if (tlb_app_init() != ESP_OK) {
        ESP_LOGE(TAG, "tlb_app_init failed");
    }
    key_ui_boot_stage(2); // BLE 核心就绪；若电池态阶停在 1，说明卡在 tlb_app_init
    if (app_button_init(on_btn, NULL) != ESP_OK) {
        ESP_LOGW(TAG, "按键初始化失败，设备不可操作");
    }
    // 组合键（先按住右三再按右一保持3秒）= 出厂重置，注册在按键就绪之后
    app_button_set_combo_cb(on_combo_factory, NULL);
    key_ui_boot_stage(3); // 按键初始化已返回；若电池态阶停在 2，说明卡在按键初始化内部
    key_ui_boot_stage(4); // 主流程走完
}
