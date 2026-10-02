# 应用层：单 worker 任务 + 命令队列 + 自动重连链路任务（tlb_app.c），固件入口 app_main.c。
# UI（ai-passport/main）不动，本组件只注册 main 组件本身需要的源文件。
idf_component_register(
    SRCS "tlb_app.c"
         "app_main.c"
    INCLUDE_DIRS "."
    REQUIRES tesla_ble tesla_core
    PRIV_REQUIRES nvs_flash esp_timer bt)
