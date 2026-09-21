// main/tesla_store.c —— 车辆档案的 NVS 持久化。
#include "tesla_store.h"

#include <string.h>

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "tesla_store";
static const char *NVS_NS = "tesla_key";
static const char *NVS_KEY = "profile";

static bool s_ready;

esp_err_t tesla_store_init(void)
{
    if (s_ready) return ESP_OK;

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        // 本应用独占这块 NVS；分区满或版本不匹配时重建，档案会丢但设备可用。
        ESP_LOGW(TAG, "NVS 需要重建: %s", esp_err_to_name(err));
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "NVS 初始化失败: %s", esp_err_to_name(err));
        return err;
    }
    s_ready = true;
    return ESP_OK;
}

esp_err_t tesla_store_load(tesla_state_t *st)
{
    if (st == NULL) return ESP_ERR_INVALID_ARG;
    tesla_state_init(st);

    esp_err_t err = tesla_store_init();
    if (err != ESP_OK) return err;

    nvs_handle_t handle;
    err = nvs_open(NVS_NS, NVS_READONLY, &handle);
    if (err == ESP_ERR_NVS_NOT_FOUND) return ESP_ERR_NOT_FOUND;
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "打开命名空间失败: %s", esp_err_to_name(err));
        return err;
    }

    size_t len = 0;
    err = nvs_get_blob(handle, NVS_KEY, NULL, &len);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        nvs_close(handle);
        return ESP_ERR_NOT_FOUND;
    }

    uint8_t blob[TESLA_BLOB_SIZE];
    if (err == ESP_OK) {
        if (len > sizeof(blob)) {
            ESP_LOGE(TAG, "存档长度异常: %u", (unsigned)len);
            nvs_close(handle);
            return ESP_ERR_INVALID_SIZE;
        }
        err = nvs_get_blob(handle, NVS_KEY, blob, &len);
    }
    nvs_close(handle);

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "读取存档失败: %s", esp_err_to_name(err));
        return err;
    }
    if (!tesla_state_decode(st, blob, len)) {
        // 校验和或内容不一致：按“未绑定”处理，让 UI 能重新引导绑定。
        ESP_LOGE(TAG, "存档损坏（%u 字节），已按未绑定处理", (unsigned)len);
        tesla_state_init(st);
        return ESP_ERR_INVALID_CRC;
    }
    ESP_LOGI(TAG, "已恢复车辆档案: bound=%d model=%s", st->bound, tesla_model_ascii(st->model));
    return ESP_OK;
}

esp_err_t tesla_store_save(const tesla_state_t *st)
{
    if (st == NULL) return ESP_ERR_INVALID_ARG;

    uint8_t blob[TESLA_BLOB_SIZE];
    const size_t len = tesla_state_encode(st, blob, sizeof(blob));
    if (len == 0) {
        ESP_LOGE(TAG, "状态不可持久化，未写盘");
        return ESP_ERR_INVALID_STATE;
    }

    esp_err_t err = tesla_store_init();
    if (err != ESP_OK) return err;

    nvs_handle_t handle;
    err = nvs_open(NVS_NS, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "打开命名空间失败: %s", esp_err_to_name(err));
        return err;
    }
    err = nvs_set_blob(handle, NVS_KEY, blob, len);
    if (err == ESP_OK) err = nvs_commit(handle);
    nvs_close(handle);

    if (err != ESP_OK) ESP_LOGE(TAG, "保存失败: %s", esp_err_to_name(err));
    return err;
}

esp_err_t tesla_store_erase(void)
{
    esp_err_t err = tesla_store_init();
    if (err != ESP_OK) return err;

    nvs_handle_t handle;
    err = nvs_open(NVS_NS, NVS_READWRITE, &handle);
    if (err == ESP_ERR_NVS_NOT_FOUND) return ESP_OK;
    if (err != ESP_OK) return err;

    err = nvs_erase_key(handle, NVS_KEY);
    if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
    if (err == ESP_OK) err = nvs_commit(handle);
    nvs_close(handle);
    return err;
}
