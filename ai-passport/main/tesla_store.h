// main/tesla_store.h —— 车辆档案的 NVS 持久化（只做 I/O，规则都在 tesla_state）。
#pragma once

#include "esp_err.h"
#include "tesla_state.h"

#ifdef __cplusplus
extern "C" {
#endif

// 打开/挂载 NVS。可重复调用。
esp_err_t tesla_store_init(void);

// 读取档案：
//   ESP_OK             成功恢复（已绑定或未绑定都算成功）
//   ESP_ERR_NOT_FOUND  没有存档，*st 已复位为“未绑定”
//   其它错误           NVS 读失败或存档损坏，*st 同样已复位为“未绑定”
esp_err_t tesla_store_load(tesla_state_t *st);

// 保存档案；状态非法（例如未绑定却带车牌）时返回 ESP_ERR_INVALID_STATE，不写盘。
esp_err_t tesla_store_save(const tesla_state_t *st);

// 删除存档（解绑）。
esp_err_t tesla_store_erase(void);

#ifdef __cplusplus
}
#endif
