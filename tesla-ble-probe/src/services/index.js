// 面向页面的唯一门面：把 config / infra / store / domain 的能力按旧的名字表聚合出口。
//
// 只用具名再导出（禁 export *），前半段的门面名字与重构前 session 门面的导出面完全一致：
// forgetKey / forgetBind 是 services 层的组合动作换了个名字对外，其余同名同实。
// state 仍是 src/store/app-state.js 里那个对象本身（同一引用、字段名不变）。
//
// 文件后半段（「domain / 功能接口原始层」起）把 domain 与各功能接口模块的原始导出面也
// 一并具名再导出，方便测试用一个命名空间拿到完整旧导出面；页面按功能接口逐个 import，
// 动作一律走 services/vehicle-api.js 那层带日志分段的包装。

import { state } from '../store/app-state.js';

export { subscribe, log, getLogs, clearLogs } from '../infra/logging/log-bus.js';
export { beginAction, endAction, action } from '../infra/logging/action-tracer.js';
export { state } from '../store/app-state.js';
export { hasKey, saveKeyPair, loadKey, ensureKey, describeKey } from '../store/credential-store.js';
export { bind, hasBind, saveBind, loadBind, describeBind, markBound } from '../store/bind-profile.js';
export { DOMAIN, SESSION_DOMAINS, v3Session, storeV3Session, invalidateV3Session, invalidateAllV3Sessions, resetV3Session } from '../store/v3-session-store.js';
export { vehicle, vehicleView, applyVehicleData, clearVehicle, subscribeVehicle, UNKNOWN as VEHICLE_UNKNOWN } from '../store/vehicle-store.js';
export { diagnostics, MAX_DIAGNOSTICS, recordResult, recordError, recentResults, lastResult, clearDiagnostics, subscribeDiagnostics } from '../store/diagnostic-store.js';
export { connection, ble, namesForVin, connectTo, disconnectAll } from '../domain/connection-service.js';
export { autoReconnect, suspendAutoConnect, startAutoReconnectLoop, stopAutoReconnectLoop, describeAutoLoop } from '../domain/auto-reconnect.js';
export { forgetEverything as forgetKey, forgetBindProfile as forgetBind } from './credential-service.js';

// ---------------------------------------------------------------- domain / 功能接口原始层
// 以下都是「未经 action() 包装」的原始导出面，逐个具名再导出，与
// src/domain/index.js、src/services/vcsec/index.js、src/services/infotainment/index.js 一一对应。

// —— 编排策略常量
export {
  sleep,
  REQUEST_FLAGS,
  MAX_LATENCY_MS,
  RETRYABLE_FAULTS,
  RESYNC_FAULTS,
  MAY_HAVE_SUCCEEDED,
  MAX_ATTEMPTS,
  DEFAULT_MAX_MS,
  WHITELIST_MAX_MS,
  FIRST_RESPONSE_MS,
  PAIR_WINDOW_MS,
  PAIR_RECEIVE_MS,
  PROBE_FIRST_MS,
  PROBE_INTERVAL_MS,
  pick
} from '../domain/index.js';

// —— 上下文（域、编解码器、请求 ID 台账、前置检查）
export {
  VC,
  INFO_DOMAIN,
  DOMAINS,
  domainText,
  appCodec,
  otherDomainKeys,
  RECENT_ID_LIMIT,
  recentIds,
  rememberRequestId,
  RKE,
  CLOSURE,
  CS,
  ROLE,
  FORM_FACTOR,
  INFO,
  FORM_FACTORS,
  DEFAULT_FORM_FACTOR,
  formFactorText,
  mustConnect,
  mustKey,
  vinOrEmpty,
  myKeyId,
  teslaKeyId,
  entryKeyId,
  keyIdMatches
} from '../domain/index.js';

// —— 响应提示文案
export { KNOWN_RKE, TAP_HINT, PAIR_HINTS, FAULT_HINT, GENERIC_ERROR_HINTS, mtuNote } from '../domain/index.js';

// —— 握手
export { handshakeOnce, handshake, requestEphemeralKey, applyPiggyback } from '../domain/index.js';

// —— 单帧解码与请求派发
export {
  decodeFrame,
  protoOutcome,
  appOutcome,
  sendRequest,
  doneCommand,
  doneWhitelist
} from '../domain/index.js';

// —— 入白名单（绑定）
export {
  probeOnce,
  probeEnrollment,
  pairVerdict,
  infoRequest,
  queries,
  bindKey,
  bindKeyViaSession,
  checkWhitelisted,
  probeSession
} from '../domain/index.js';

// —— 页面状态行
export { statusText } from '../domain/index.js';

// —— VCSEC 域功能接口
export { sendRke, sendClosure, requestDrive } from './vcsec/index.js';

// —— 车机域（car_server）功能接口
export {
  sendCarAction,
  chargePortDoor,
  flashLights,
  honkHorn,
  hvacAuto,
  windowAction,
  pingInfotainment,
  VEHICLE_DATA,
  VEHICLE_DATA_ALL,
  vehicleData
} from './infotainment/index.js';

export default state;
