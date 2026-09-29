// 车机域的功能接口：寻车提示 —— 闪灯 / 鸣笛。
//
// 一个功能接口一个文件；本文件这两条是同一类动作（car_server.proto:43-44 的两个空 message），
// 取证口径完全一致，所以共用一份注释。发包统一走同目录的 car-action.js。
//
// 官方原型：car_server.proto:361-365
//   message VehicleControlFlashLightsAction {}   → oneof 成员 26
//   message VehicleControlHonkHornAction    {}   → oneof 成员 27
// 空 message 仍要写 tag+len（oneof 成员一律显式存在），所以整条 Action 固定 5 字节，
// 金标准见 tests/run.mjs 的 [8b] 段。

import { sendCarAction } from './car-action.js';

export function flashLights() {
  return sendCarAction('vehicleControlFlashLightsAction', {}, '闪灯');
}

export function honkHorn() {
  return sendCarAction('vehicleControlHonkHornAction', {}, '鸣笛');
}
