// 车机域的功能接口：开 / 关充电盖板。
//
// 一个功能接口一个文件：本文件只装 chargePortDoor，发包统一走同目录的 car-action.js。

import { sendCarAction } from './car-action.js';

// 充电盖板：car_server.proto:494/497 —— close=61（EA 03）/ open=62（F2 03），
// 同样是空 message。注意这条走的是车机域，跟 VCSEC 的 ClosureMoveRequest.chargePort
// 是两套东西，别混着发。
export function chargePortDoor(open) {
  return open
    ? sendCarAction('chargePortDoorOpen', {}, '打开充电盖板')
    : sendCarAction('chargePortDoorClose', {}, '关闭充电盖板');
}
