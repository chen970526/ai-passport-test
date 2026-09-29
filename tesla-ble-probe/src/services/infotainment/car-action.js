// 车机域（INFOTAINMENT / car_server）功能接口的共享内核：sendCarAction。
//
// 一个功能接口一个文件；本目录里 charge-port.js / ping.js / vehicle-data.js 都经由这里
// 这个通用出口发包，所以它必须导出。会话状态、BLE 连接、重试策略与协议编解码全部复用
// 现有单例（store / infra / protocol / domain），不重复实现任何逻辑。

// ---------------------------------------------------------------- INFOTAINMENT（car_server）动作
//
// 取证（按用户定的优先级：官方 vehicle-command 为准，C++ 库做交叉印证）：
//   官方 pkg/vehicle/infotainment.go:19-45 getCarServerResponse ——
//     proto.Marshal(car_server.Action{ActionMsg: …}) →
//     v.Send(ctx, Domain_DOMAIN_INFOTAINMENT, payload, v.authMethod) →
//     proto.Unmarshal(car_server.Response)；
//     :37-43 当 actionStatus.result == OPERATIONSTATUS_ERROR 时，
//     把 result_reason.plain_text 拼成 "car could not execute command: <text>" 报出来。
//   官方 pkg/vehicle/state.go:38-86 GetState —— GetVehicleData 也是同一条路，
//     只是把 oneof 里的 car_server.VehicleData 取回来。
//   C++ 侧同构：tesla-ble/src/vehicle.cpp:1297 open_charge_port（走 send_infotainment_action_）→
//     client.cpp:799 build_car_server_vehicle_action_message（域=INFOTAINMENT、
//     encrypt_payload=true，见 client.cpp:713；oneof 成员见 message_builders.cpp:28-29、:252）。
//
// 与 VCSEC 的三处实质差别，全部已在上面的 sendRequest/decodeFrame/appOutcome 里参数化：
//   1) 载荷类型：car_server.Action，不是 ToVCSECMessage；
//   2) 会话：用 INFOTAINMENT 那一份 counter，**绝不**和 VCSEC 共用
//      （dispatcher.go:36 的 sessions 数组、domains.go:7-13、client.cpp:46-52、peer.h）；
//   3) 应用层枚举：CSOperationStatus_E 只有 OK/ERROR 没有 WAIT（car_server.proto:160-164），
//      所以第一帧就是终态，done 用默认的「一帧算完」，也不需要 WAIT 重发逻辑。

import { buildCarServerAction } from '../../protocol/index.js';
import { sendRequest, INFO_DOMAIN } from '../../domain/index.js';

// 通用出口。actionName 必须是 src/protocol/v3/spec.js 的 VehicleAction 表里登记过的成员名，
// 写错会在 encode 时抛错（由 sendRequest 的组包失败分支兜住，不会发半截包出去）。
export function sendCarAction(actionName, fields, name, done) {
  return sendRequest({
    name: name || actionName,
    domain: INFO_DOMAIN,
    payload: buildCarServerAction(actionName, fields),
    done: done || function () { return true; }
  });
}
