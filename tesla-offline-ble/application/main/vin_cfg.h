// application/main/vin_cfg.h —— 无 VIN 时的「热点 + 内网网页」配网通道。
//
// 规则（用户定死）：只有设备里没有 VIN（首次开机/出厂重置后）才开热点；
// 配网模式只留「屏幕提示页 + AP + DHCP + DNS + HTTP」，蓝牙栈不启动；
// VIN 存进 NVS 后延时 2 秒 esp_restart()，重启即进正常模式（热点不再开）。
// 网关 IP 特意用 192.168.4.2（不是默认的 4.1）—— 用户另一块固件占着 4.1。
// VIN 只在手机直连本热点的局域网里传输，热点不联网、不出网。
#pragma once

#define VIN_AP_SSID "AI-PASSPORT-TSL"
#define VIN_AP_PASS "87654321" // WPA2 最低 8 位；仅本地点对点用，屏幕会显示
#define VIN_AP_IP   "192.168.4.2"

// 开热点+配网页+DNS 门户（幂等：已开着直接返回 true）。失败已打日志，
// 返回 false 时调用方应把「哪步失败 + 错误码 + 空闲堆」显示到屏幕（无电脑排障）。
bool vin_cfg_start(void);
// 请求保存后重启（非阻塞：httpd 回调里调用也安全）。
void vin_cfg_stop(void);
// 当前热点是否在跑。
bool vin_cfg_active(void);
