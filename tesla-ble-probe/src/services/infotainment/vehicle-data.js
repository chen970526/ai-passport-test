// 车机域的功能接口：GetVehicleData 车辆状态（类别表 + 串行拉取与合并）。
//
// 一个功能接口一个文件：本文件装 VEHICLE_DATA / VEHICLE_DATA_ALL / vehicleData，
// 发包统一走同目录的 car-action.js；故障文案与 MTU 注记复用 domain 层那份。

import { V3_SPEC, FAULT, inspect } from '../../protocol/index.js';
import { FAULT_HINT, mtuNote } from '../../domain/index.js';
import { sendCarAction } from './car-action.js';

// GetVehicleData 的开关，名字照 state.go:38-56 那张 StateCategory 表，
// 字段号见 src/protocol/v3/spec.js 的 GetVehicleData（car_server.proto:88-103）。
// 这里只登记本项目要用的 6 类；官方还有 chargeSchedule / preconditioningSchedule /
// media / softwareUpdate / vehicleConfig / drivers / location 等，需要时再往表里加。
export const VEHICLE_DATA = {
  charge: 'getChargeState',
  climate: 'getClimateState',
  drive: 'getDriveState',
  location: 'getLocationState',
  closures: 'getClosuresState',
  tirePressure: 'getTirePressureState'
};

export const VEHICLE_DATA_ALL = Object.keys(VEHICLE_DATA);

// 拉车辆状态：**每个类别单独一条 GetVehicleData，串行发完再合并**。
//
// 为什么必须拆开（三个参考实现无一是「一条命令问多类」）：
//   官方 pkg/vehicle/state.go:70-82 —— GetState 的入参是**单个** StateCategory，
//     :38-58 那张 StateCategory 表本身就是「类别 → 一条命令」的一对一映射；
//   tesla-ble/src/client.cpp:721-737 —— switch 每次只置**一个** GetVehicleData 开关；
//   tesla-ble/src/vehicle.cpp:1231-1246 infotainment_poll() —— charge / climate / drive /
//     closures / tirePressure 是**五条**独立命令；
//   tesla-key-esp32/main/vehicle_telemetry.cpp:1569-1631 —— charge 单独 10s 一问，
//     其余四类按 tele_idx % 4 每 30s 轮换，同样从不合包。
// 之前把 6 类塞进同一条，真机上收到的就是 fault=25
// MESSAGEFAULT_ERROR_RESPONSE_MTU_EXCEEDED（universal_message.proto:57
// 「Client's request was received, but response size exceeded MTU」）：
// 车收下了请求，但答案装不进一包，于是**直接不发响应体** —— 表现就是
// 「车辆信息一直拿不到数据」+ 一帧解不开的密文（tag 覆盖的是压根没发出的大响应）。
//
// 撞上 fault=25 时**不自动重发**：官方 error_test.go:62-65 钉死 shouldRetry=false，
// error.go:195-198 只把它归为「命令可能已经执行」。拆成单类别之后每条答案都小到装得下，
// 真再撞上说明单类本身就超包，重发一百次也是同一个结果 —— 所以只报人话、不重试。
export async function vehicleData(keys) {
  const list = keys && keys.length ? keys : VEHICLE_DATA_ALL;
  const cats = [];
  for (const k of list) {
    if (!VEHICLE_DATA[k]) throw new Error('vehicleData: 不认识的类别 ' + k + '（可选：' + VEHICLE_DATA_ALL.join('/') + '）');
    if (cats.indexOf(k) < 0) cats.push(k);
  }

  const data = {};
  const got = []; // 真的带回数据的**类别**（不是合并后的字段数，理由见下面 head）
  const failed = [];
  const empty = [];
  const faults = [];
  let lastSummary = null;

  for (const k of cats) {
    const r = await sendCarAction(
      'getVehicleData',
      { [VEHICLE_DATA[k]]: {} },
      'GetVehicleData（' + k + '）',
      // 车机对带 FLAG_ENCRYPT_RESPONSE 的请求会先回一帧「已受理」（payload 缺失），
      // 用默认的一帧算完会把受理帧当结论，永远读不到后面的 vehicleData。
      (obj) => !!(obj && (obj.vehicleData || obj.actionStatus))
    );
    const d = r.summary && r.summary.kind === 'vehicleData' ? r.summary.data : null;
    if (d && Object.keys(d).length) {
      got.push(k);
      for (const field of Object.keys(d)) data[field] = d[field];
      lastSummary = r.summary;
    } else if (r.ok) {
      empty.push(k);
      if (r.summary) lastSummary = r.summary;
    } else {
      failed.push(k + ' —— ' + r.text);
      if (r.fault) faults.push(r.fault);
    }
  }

  // 「带回数据」按**类别**计数，绝不能拿合并后的字段数当类别数：真机（HW4/V3）回包里
  // ① 问 drive 那一条会顺带塞回 location_state，② 每一条 vehicleData 尾部都带一个
  // 官方 vehicle.proto 里没有的字段 999（值恒为 1，本项目原样记成 f999 显示）。
  // 按字段数算就会报成「6 类各发一条，7 类带回数据」——比问的类别还多，像 bug。
  const head = 'GetVehicleData：' + cats.length + ' 类各发一条，' + got.length + ' 类带回数据' +
    (empty.length ? '，' + empty.length + ' 类只回执没带数据（' + empty.join('/') + '）' : '') +
    (failed.length ? '，' + failed.length + ' 类被拒（每条是独立请求，不影响其它类）' : '');

  if (got.length) {
    return {
      ok: true,
      summary: { kind: 'vehicleData', status: 0, data, text: head + '\n' + inspect(V3_SPEC, 'VehicleData', data) },
      text: head + (failed.length ? '\n' + failed.join('\n') : '')
    };
  }
  const mtu = faults.indexOf(FAULT.MESSAGEFAULT_ERROR_RESPONSE_MTU_EXCEEDED) >= 0 ||
    faults.indexOf(FAULT.MESSAGEFAULT_ERROR_REQUEST_MTU_EXCEEDED) >= 0;
  return {
    ok: false,
    summary: lastSummary,
    text: head + '\n' + (failed.join('\n') || '一条 vehicleData 都没拿到' + (lastSummary ? '：' + lastSummary.text : '（车机只回了 actionStatus）')) +
      (mtu ? '\n' + FAULT_HINT[FAULT.MESSAGEFAULT_ERROR_RESPONSE_MTU_EXCEEDED] + mtuNote() : '')
  };
}
