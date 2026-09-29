// V3（RoutableMessage + session_info 握手 + AES-GCM 会话）动作层。
//
// 参考实现的优先级（用户 2026-09 定的规则，比对分歧时必须按这个顺序裁决，
// 不许因为某个项目跟我们不一样就直接改协议字节）：
//   1) Tesla 官方 vehicle-command —— 本地副本 f:\Desktop\test\ref-repos\vehicle-command
//      （与 .hosttest/vc 同一 commit f61e29e，逐行核过，无漂移）
//   2) 0Bu/tesla-key-esp32（量产 ESP32 BLE 钥匙固件，pin 了下面这个 C++ 库）
//   3) yoziru/esphome-tesla-ble（第二个独立参考实现）
//      2/3 共用的底层协议库 tesla-ble（nanopb + mbedtls）也已克隆到 ref-repos\tesla-ble，
//      它的 src/client.cpp:165 build_white_list_message 与本项目 buildAddKeyPayload
//      逐字段一致 —— 我方组包已被独立验证为正确。
//
// 官方源码对齐点（时序完全照抄）：
//   pkg/vehicle/security.go     —— AddKeyWithRole / SendAddKeyRequestWithRole（刷卡配对）；
//                                  :324 明确「想知道钥匙进没进白名单，就去试 SessionInfo」
//   pkg/vehicle/vcsec.go        —— executeWhitelistOperation / addKeyPayload 的载荷形状、
//                                  readUntil 的 done 谓词、WAIT 算 ErrBusy（整条重发，不是继续读）
//   pkg/vehicle/vehicle.go      —— flags = 1<<FLAG_ENCRYPT_RESPONSE、BLE 每 1 秒重发一次
//   internal/dispatcher/*.go    —— 握手、请求 ID、VCSEC 域只按 routing_address 配对响应、
//                                  :464 SessionInfoRequest 是不带签名的探针包、
//                                  响应里搭车的 session_info 要过「私钥 / 未超时 / 带 tag」三道闸
//   pkg/protocol/protocol.md    —— :824 配对请求车端会先回 OPERATIONSTATUS_WAIT；
//                                  :836 白名单操作的终态判据
//   pkg/protocol/error.go       —— 哪些 fault 值得重发
//
// 本文件只做「BLE + 会话状态 + 协议层」的编排，不重复实现任何密码学。
//
// domain 层统一出口：把编排 / 策略模块逐个具名再导出。
//
// 刻意不用 `export *`：依赖面要一眼可见，也便于 tree-shaking。
// 各模块之间是单向依赖（dispatch-policy ← v3-context ← response-hints ←
// handshake-service ← command-dispatcher ← enrollment-service），本文件只做汇总，
// 任何模块都不许反过来 import 这里（否则成环）。

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
} from './dispatch-policy.js';

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
} from './v3-context.js';

// —— 响应提示文案
export { KNOWN_RKE, TAP_HINT, PAIR_HINTS, FAULT_HINT, GENERIC_ERROR_HINTS, mtuNote } from './response-hints.js';

// —— 握手
export { handshakeOnce, handshake, requestEphemeralKey, applyPiggyback } from './handshake-service.js';

// —— 单帧解码与请求派发
export {
  decodeFrame,
  protoOutcome,
  appOutcome,
  sendRequest,
  doneCommand,
  doneWhitelist
} from './command-dispatcher.js';

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
} from './enrollment-service.js';

// —— 页面状态行
export { statusText } from './session-status.js';
