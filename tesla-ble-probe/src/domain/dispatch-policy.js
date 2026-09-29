// V3 请求的编排策略常量：重试、超时、绑定时序参数的唯一口径。

import { FLAGS, FAULT } from '../protocol/index.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 常量

// vehicle.go DefaultFlags：只要「加密响应」这一位，USER_COMMAND 官方从不置位
export const REQUEST_FLAGS = 1 << FLAGS.FLAG_ENCRYPT_RESPONSE;

// ble.go: maxLatency = 4s —— 响应搭车的 session_info 只有在这个窗口内才被采用
export const MAX_LATENCY_MS = 4000;

// protocol.go ShouldRetry：车辆说「忙 / 暂时不行」时值得整条重发
export const RETRYABLE_FAULTS = [
  FAULT.MESSAGEFAULT_ERROR_BUSY,
  FAULT.MESSAGEFAULT_ERROR_TIMEOUT,
  FAULT.MESSAGEFAULT_ERROR_INVALID_SIGNATURE,
  FAULT.MESSAGEFAULT_ERROR_INVALID_TOKEN_OR_COUNTER,
  FAULT.MESSAGEFAULT_ERROR_INTERNAL,
  FAULT.MESSAGEFAULT_ERROR_INCORRECT_EPOCH,
  FAULT.MESSAGEFAULT_ERROR_TIME_EXPIRED,
  FAULT.MESSAGEFAULT_ERROR_TIME_TO_LIVE_TOO_LONG
];

// 这几个 fault 说明两边的 counter / epoch 已经对不上，重发同一把会话参数没意义，
// 必须先重新握手拿新 epoch（官方是靠 tryStartSession 重开 session 做到这件事）
export const RESYNC_FAULTS = [
  FAULT.MESSAGEFAULT_ERROR_INVALID_TOKEN_OR_COUNTER,
  FAULT.MESSAGEFAULT_ERROR_INCORRECT_EPOCH,
  FAULT.MESSAGEFAULT_ERROR_TIME_EXPIRED,
  FAULT.MESSAGEFAULT_ERROR_REPEATED_COUNTER
];

// error.go:195-198 —— 官方认定「命令可能其实已经执行成功」的协议层 fault 只有两个：
// NONE 和 RESPONSE_MTU_EXCEEDED（车收下了请求，只是答案装不进这一包）。
// 撞上它们时绝不能对用户说「失败了」，要说「车没发答案」。
export const MAY_HAVE_SUCCEEDED = [FAULT.MESSAGEFAULT_ERROR_NONE, FAULT.MESSAGEFAULT_ERROR_RESPONSE_MTU_EXCEEDED];

export const MAX_ATTEMPTS = 3; // vehicle.go 的重试上限用上下文超时兜底，这里给个明确的次数便于看日志
export const DEFAULT_MAX_MS = 20000;
export const WHITELIST_MAX_MS = 60000;
export const FIRST_RESPONSE_MS = 8000;

// ---------------------------------------------------------------- 绑定时序参数
//
// 依据（按用户给的优先级：官方 > 0Bu > esphome > 本项目）：
//   官方 pkg/vehicle/security.go:321  「returns nil as soon as the request is transmitted」
//     —— 加白名单请求发出去就算结束，官方 CLI 从不等回执。
//   官方 pkg/protocol/protocol.md:824  「VCSEC sends operationStatus = OPERATIONSTATUS_WAIT
//     to indicate it is waiting for the NFC card tap」+ :836「a message is terminal if
//     commandStatus.whitelistOperationStatus is populated」
//     —— 规范上确实**应该**有终态，所以这个窗口不能直接砍掉，要收。
//   0Bu main/vehicle_pairing.cpp:246  「The car whitelists the key when the user confirms on
//     screen but sends NO completing commandStatus」+ :877 把 whitelist-add 的完成超时
//     标成 ExpectedSilent
//     —— 量产固件的实测结论是「终态通常不会来」。
//   官方 security.go:324 + 0Bu :240-301 给了同一个替代判据：事后试建会话，能建上就是绑好了。
//
// 所以这里两边都不砍：**同时**等车端终态回执 和 做会话探针，谁先来算谁。

export const PAIR_WINDOW_MS = 150000; // 整个绑定窗口（含人刷卡 + 车机屏幕确认的动手时间）
export const PAIR_RECEIVE_MS = 2500; // 每一片「只收不发」的时间片
export const PROBE_FIRST_MS = 8000; // 发完请求后先等 8 秒再打第一针（避免和车端 WAIT 抢链路）
export const PROBE_INTERVAL_MS = 5000; // 之后每 5 秒一针；一次探针自身最多占 FIRST_RESPONSE_MS

// 取 opts 里的数值覆盖，非有限数（含 undefined / null / NaN）时回落到默认值。
export function pick(opts, key, dflt) {
  const v = opts ? opts[key] : undefined;
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : dflt;
}
