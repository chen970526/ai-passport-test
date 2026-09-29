// 车机域的功能接口：一键启动 / 关闭空调（预热、预冷）。
//
// 一个功能接口一个文件；发包统一走同目录的 car-action.js。
//
// 取证：car_server.proto:209-212
//   message HvacAutoAction { bool power_on = 1; bool manual_override = 2; }
// 官方调用链 pkg/vehicle/climate.go:38-62 —— ClimateOn / ClimateOff 都只填 PowerOn，
// **不设 ManualOverride**，所以这里也不设（第二个字段留默认值，界面上不暴露开关）。
//
// ⚠ 这条走 INFOTAINMENT 会话，不是 VCSEC。power_on=false 时内层虽然 0 字节，
//   外层 tag+len 照写：「关掉空调」和「没发过这条」在车上是两回事。

import { sendCarAction } from './car-action.js';

export function hvacAuto(on) {
  return sendCarAction('hvacAutoAction', { power_on: !!on }, on ? '启动空调' : '关闭空调');
}
