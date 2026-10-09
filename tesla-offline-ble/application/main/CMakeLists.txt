# 应用层：单 worker 任务 + 命令队列 + 自动重连链路任务（tlb_app.c），
# 车钥匙最小界面（key_ui.c，LVGL + bsp 显示/按键），固件入口 app_main.c。
# 基线 ai-passport/main 依旧不动；bsp 组件只读复用（显示/背光/ADC 三键）。
idf_component_register(
    SRCS "tlb_app.c"
         "tlb_console.c"
         "key_ui.c"
         # 图标 L8 遮罩数组由 tools/gen_key_icons.py 从 UI_SPEC 资源包 PNG 生成
         "key_icons.c"
         "app_main.c"
         "app_button.c"
         "vin_cfg.c"
         # 中文字体子集由 tools/gen_key_font.py 生成，产物入本工程 assets/fonts/
         "../../assets/fonts/key_font_20.c"
         "../../assets/fonts/key_font_14.c"
    INCLUDE_DIRS "."
    REQUIRES tesla_ble tesla_core bsp
    PRIV_REQUIRES nvs_flash esp_timer bt console esp_wifi esp_http_server esp_netif)
