# 特斯拉离线 BLE 钥匙（FoloToy AI Passport / ESP32-C3）
# 薄工程：板级能力复用 ../ai-passport/components/bsp，本仓库只放应用与协议实现。
cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS
    "${CMAKE_CURRENT_LIST_DIR}/../ai-passport/components"
    "${CMAKE_CURRENT_LIST_DIR}/components"
    "${CMAKE_CURRENT_LIST_DIR}/application/main")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(tesla-offline-ble)
