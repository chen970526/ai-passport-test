#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "tesla_ble/tlb_ble.h"

void app_main(void)
{
    if (tlb_app_init() != ESP_OK) {
        ESP_LOGE("tlb", "tlb_app_init failed");
    }
}
