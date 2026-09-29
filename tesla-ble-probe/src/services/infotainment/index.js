// 车机域（car_server）功能接口的汇总出口：一个功能接口一个文件，这里只做具名再导出（禁 export *）。
//
// ---------------------------------------------------------------- 车机域（car_server）动作
//
// 这一组走的是 INFOTAINMENT 那份会话，不是 VCSEC：协议层区别见 ./car-action.js 的
// 「INFOTAINMENT（car_server）动作」段（官方 pkg/vehicle/infotainment.go:19-45）。

export { sendCarAction } from './car-action.js';
export { chargePortDoor } from './charge-port.js';
export { flashLights, honkHorn } from './flash-horn.js';
export { hvacAuto } from './hvac-auto.js';
export { windowAction } from './window-action.js';
export { pingInfotainment } from './ping.js';
export { VEHICLE_DATA, VEHICLE_DATA_ALL, vehicleData } from './vehicle-data.js';
