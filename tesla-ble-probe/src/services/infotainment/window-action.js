// 车机域的功能接口：车窗通风 / 关窗。
//
// 一个功能接口一个文件；发包统一走同目录的 car-action.js。
//
// 取证：car_server.proto:401-408
//   message VehicleControlWindowAction {
//     reserved 1;                       // 老车型要带位置，支持本协议的车型不用
//     oneof action { Void unknown=2; Void vent=3; Void close=4; }
//   }
// 官方调用链 pkg/vehicle/actions.go:67-95 —— CloseWindows 填 close、VentWindows 填 vent，
// 都是「哪个 Void 存在」表达动作，跟 vehicle.proto 里那批伪枚举同一种写法。

import { sendCarAction } from './car-action.js';

// mode 只认 'vent' / 'close'：oneof 里没有别的可用成员，写错直接在 encode 阶段抛错，不会发半截包。
export function windowAction(mode) {
  const key = mode === 'close' ? 'close' : 'vent';
  const fields = {};
  fields[key] = {};
  return sendCarAction('vehicleControlWindowAction', fields, key === 'close' ? '关窗' : '车窗通风');
}
