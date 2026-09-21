// main/main.c —— “特斯拉钥匙”应用入口：初始化硬件 → 读取车辆档案 → 进入应用界面。
//
// 这是二次开发应用，不是基线 BSP 测试菜单：上电后直接进 tesla_ui（未绑定=绑定向导，
// 已绑定=钥匙主控页），基线的 DEMOS[] 注册表与 ui_pixel 外壳不参与本应用的启动路径。
// 按键语义由 tesla_ui 自己定义，见 main/tesla_ui.h。
//
// 并发约定（docs/development/ai-guide.zh_CN.md 第 4 节）：
//   * 按键回调运行在共享的 esp_timer 任务上，只做入队，不做慢操作；
//   * LVGL 对象只能在 LVGL 任务里改，所以另起一个工作任务取 bsp_lvgl_lock 后再派发；
//   * 显示/LVGL 起不来就没有任何可交互的界面，此时只打日志并停在这里。
#include "bsp_i2c.h"
#include "bsp_display.h"
#include "bsp_button.h"
#include "bsp_battery.h"
#include "bsp_pins.h"      // 错误日志里要打印 BSP_LCD_* 引脚号
#include "esp_log.h"
#include "esp_sleep.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "tesla_ui.h"

static const char *TAG = "main";

#define INPUT_QUEUE_DEPTH 8

typedef struct {
    bsp_btn_t btn;
    bsp_btn_ev_t event;
} input_event_t;

static QueueHandle_t s_input_queue;
static TaskHandle_t s_input_task;
static volatile bool s_input_ready;

static void input_task(void *arg)
{
    (void)arg;
    input_event_t input;
    for (;;) {
        if (xQueueReceive(s_input_queue, &input, portMAX_DELAY) == pdTRUE) {
            // tesla_ui_key() 内部自行取放 LVGL 锁。
            tesla_ui_key(input.btn, input.event);
        }
    }
}

static esp_err_t input_dispatch_start(void)
{
    s_input_queue = xQueueCreate(INPUT_QUEUE_DEPTH, sizeof(input_event_t));
    if (s_input_queue == NULL) return ESP_ERR_NO_MEM;
    if (xTaskCreate(input_task, "tesla_input", 4096, NULL, 5, &s_input_task) != pdPASS) {
        vQueueDelete(s_input_queue);
        s_input_queue = NULL;
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

static void input_dispatch_stop(void)
{
    s_input_ready = false;
    if (s_input_task != NULL) {
        vTaskDelete(s_input_task);
        s_input_task = NULL;
    }
    if (s_input_queue != NULL) {
        vQueueDelete(s_input_queue);
        s_input_queue = NULL;
    }
}

static void on_key(bsp_btn_t btn, bsp_btn_ev_t ev, void *user)
{
    (void)user;
    if (!s_input_ready || s_input_queue == NULL) return;
    const input_event_t input = { .btn = btn, .event = ev };
    (void)xQueueSend(s_input_queue, &input, 0);
}

void app_main(void)
{
    ESP_LOGI(TAG, "特斯拉钥匙启动");
    const esp_sleep_wakeup_cause_t wakeup = esp_sleep_get_wakeup_cause();
    if (wakeup != ESP_SLEEP_WAKEUP_UNDEFINED) {
        ESP_LOGI(TAG, "休眠唤醒原因: %d", wakeup);
    }

    bsp_i2c_init();
    bsp_i2c_scan();

    if (bsp_display_init() != ESP_OK || !bsp_lvgl_init()) {
        ESP_LOGE(TAG, "显示/LVGL 初始化失败,应用无法继续。"
                      "检查 SPI 接线(MOSI=%d SCLK=%d CS=%d DC=%d BL=%d)",
                 BSP_LCD_MOSI, BSP_LCD_SCLK, BSP_LCD_CS, BSP_LCD_DC, BSP_LCD_BL);
        return;
    }
    bsp_display_backlight(100);

    // 电量只用于右上角显示,读不到时 tesla_ui 会自己降级成 "--",不阻塞启动。
    const esp_err_t battery_err = bsp_battery_init();
    if (battery_err != ESP_OK) {
        ESP_LOGW(TAG, "电量计初始化失败,右上角不显示电量: %s", esp_err_to_name(battery_err));
    }

    // 上电先读 NVS 里的车辆档案;读失败也继续,界面会以“未绑定”进向导。
    const esp_err_t profile_err = tesla_ui_prepare();
    if (profile_err != ESP_OK) {
        ESP_LOGE(TAG, "车辆档案不可用,从绑定向导开始: %s", esp_err_to_name(profile_err));
    }

    const esp_err_t input_err = input_dispatch_start();
    esp_err_t button_err = input_err == ESP_OK ? bsp_button_init(on_key, NULL)
                                              : ESP_ERR_INVALID_STATE;
    if (input_err != ESP_OK) {
        ESP_LOGE(TAG, "按键派发任务创建失败: %s", esp_err_to_name(input_err));
    } else if (button_err != ESP_OK) {
        ESP_LOGE(TAG, "按键初始化失败,界面将无法操作: %s", esp_err_to_name(button_err));
        input_dispatch_stop();
    }

    if (bsp_lvgl_lock(1000)) {
        tesla_ui_enter();
        bsp_lvgl_unlock();
        s_input_ready = button_err == ESP_OK;
    } else {
        ESP_LOGE(TAG, "取 LVGL 锁失败,界面未加载");
    }

    ESP_LOGI(TAG, "就绪:页面=%d 已绑定=%d 输入=%d",
             tesla_ui_page(), tesla_ui_state()->bound, s_input_ready);
}
