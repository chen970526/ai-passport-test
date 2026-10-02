# 设备层：NimBLE central 传输 + NVS 持久化 + mbedTLS P-256。
# 协议与文案全在 tesla_core（主机金标准锁死），本组件只做「只有真机才有」的动作。
idf_component_register(
    SRCS "src/tlb_ble.c"
         "src/tlb_port_esp.c"
         "src/tlb_nvs_store.c"
    INCLUDE_DIRS "include"
    REQUIRES tesla_core
    PRIV_REQUIRES bt nvs_flash esp_timer mbedtls)
