idf_component_register(
    SRCS "main.c"
         "tesla_state.c"
         "tesla_store.c"
         "tesla_wizard.c"
         "tesla_ui.c"
         "demo_navigation.c"
         "ui_pixel.c"
         "ui_pixel_math.c"
         "demo_display.c"
         "demo_button.c"
         "demo_audio.c"
         "demo_battery.c"
         "demo_radio.c"
         "demo_wifi.c"
         "demo_ble.c"
         "demo_low_power.c"
         # 中文子集字体由 tools/gen_tesla_font.py 生成，产物入 assets/fonts/（见 assets/README.md）。
         "../assets/fonts/tesla_font_20.c"
         "../assets/fonts/tesla_font_14.c"
    INCLUDE_DIRS "."
    REQUIRES bsp bt esp_event esp_hw_support esp_netif esp_timer esp_wifi nvs_flash
)
