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

import { sha1 } from './sha1.js';
import {
  V3_SPEC,
  DOMAIN,
  FLAGS,
  FAULT,
  UM,
  newRoutingAddress,
  newUuid,
  sharedKeyOf,
  buildSessionInfoRequest,
  applySessionInfo,
  buildPlainRequest,
  encryptCommand,
  requestIdOf,
  decryptResponse,
  parseFrame,
  summarize,
  summarizeVcsec,
  label,
  encodeUnsignedMessage,
  decodeFromVcsec,
  buildAddKeyPayload,
  buildAddKeyEnvelope,
  prependLength,
  toHex,
  decode,
  inspect
} from './v3vcsec.js';
import {
  state,
  ble,
  log,
  hasKey,
  ensureKey,
  v3Session,
  storeV3Session,
  invalidateV3Session,
  connection
} from './session.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 常量

// vehicle.go DefaultFlags：只要「加密响应」这一位，USER_COMMAND 官方从不置位
export const REQUEST_FLAGS = 1 << FLAGS.FLAG_ENCRYPT_RESPONSE;

// ble.go: maxLatency = 4s —— 响应搭车的 session_info 只有在这个窗口内才被采用
const MAX_LATENCY_MS = 4000;

// protocol.go ShouldRetry：车辆说「忙 / 暂时不行」时值得整条重发
const RETRYABLE_FAULTS = [
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
const RESYNC_FAULTS = [
  FAULT.MESSAGEFAULT_ERROR_INVALID_TOKEN_OR_COUNTER,
  FAULT.MESSAGEFAULT_ERROR_INCORRECT_EPOCH,
  FAULT.MESSAGEFAULT_ERROR_TIME_EXPIRED,
  FAULT.MESSAGEFAULT_ERROR_REPEATED_COUNTER
];

const MAX_ATTEMPTS = 3; // vehicle.go 的重试上限用上下文超时兜底，这里给个明确的次数便于看日志
const DEFAULT_MAX_MS = 20000;
const WHITELIST_MAX_MS = 60000;
const FIRST_RESPONSE_MS = 8000;

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

const PAIR_WINDOW_MS = 150000; // 整个绑定窗口（含人刷卡 + 车机屏幕确认的动手时间）
const PAIR_RECEIVE_MS = 2500; // 每一片「只收不发」的时间片
const PROBE_FIRST_MS = 8000; // 发完请求后先等 8 秒再打第一针（避免和车端 WAIT 抢链路）
const PROBE_INTERVAL_MS = 5000; // 之后每 5 秒一针；一次探针自身最多占 FIRST_RESPONSE_MS

// 取 opts 里的数值覆盖，非有限数（含 undefined / null / NaN）时回落到默认值。
function pick(opts, key, dflt) {
  const v = opts ? opts[key] : undefined;
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : dflt;
}

const VC = DOMAIN.DOMAIN_VEHICLE_SECURITY;

export const RKE = V3_SPEC.enums.RKEAction_E;
export const CLOSURE = V3_SPEC.enums.ClosureMoveType_E;

const ROLE = V3_SPEC.enums.Role;
const FORM_FACTOR = V3_SPEC.enums.KeyFormFactor;
const INFO = V3_SPEC.enums.InformationRequestType;

// 官方 RKEAction_E 只剩这五个值，页面上的自定义 action 超范围时先提个醒
const KNOWN_RKE = [
  RKE.RKE_ACTION_UNLOCK,
  RKE.RKE_ACTION_LOCK,
  RKE.RKE_ACTION_REMOTE_DRIVE,
  RKE.RKE_ACTION_AUTO_SECURE_VEHICLE,
  RKE.RKE_ACTION_WAKE_VEHICLE
];

// 刷卡配对的操作提示。官方 security.go:314 的注释要求两步：
// 「tapping their NFC card on the center console」+「confirming their intent on the vehicle UI」
//
// 关键：这里的 NFC card 指的是 Tesla 随车发的**实体钥匙卡 / 钥匙遥控器**，不是手机。
// 车端读卡区只是 RFID 读卡器，不做 HCE 卡 emulation；三星 / 小米的 NFC 贴上去
// 只会触发起手机自己的 NFC 探测弹窗，车辆侧什么都收不到。官方 Tesla App 配对手机
// 时同样要求刷实体钥匙卡（车主手册：钥匙卡用于「authenticate 手机」）。
const TAP_HINT =
  '必须用 Tesla 实体钥匙卡（或钥匙遥控器），手机 NFC 贴读卡区无效——车端只读 RFID 卡，不做手机卡模拟。' +
  '读卡区（官方说明）：Model 3/Y = 中控台杯架后方；Model S/X/Cybertruck = 左侧无线充电板顶部往下刷。' +
  '刷卡后还要在车机屏幕点「确认」，官方文档要求两步齐全才会落库';

// 白名单操作回执 → 人话。只列配对场景真会遇到的码，其余走枚举名原文
const PAIR_HINTS = {
  0: '已加入白名单，可以回去试「查白名单」和开锁了',
  3: '钥匙卡槽位已满，先移除一把不用的实体钥匙',
  4: '白名单已满，先移除一把不用的钥匙',
  5: '当前这把钥匙没有加钥匙的权限，需要用车主钥匙刷卡',
  12: '用来签署这条请求的钥匙本身不在白名单里',
  13: '本机公钥已经在白名单里了，直接试开锁即可',
  14: '车辆要求先检测到钥匙卡在读卡区才允许添加：先把卡放上去再重按绑定',
  23: '车机没能起本地授权流程，重新踩刹车唤醒车机再试',
  24: '车机屏幕上点了「拒绝」',
  25: '等刷卡超时：卡没贴 / 贴的位置不对 / 贴太晚',
  26: '刷了卡但没在车机屏幕上点确认，超时了',
  27: '车辆处于代客模式，不允许加钥匙',
  28: '车机屏幕上取消了配对'
};

// ---------------------------------------------------------------- 钥匙类型（FORM_FACTOR）
//
// 官方 vehicle-command **没有默认 formFactor**：cmd/tesla-control/commands.go:363 把它做成
// 必填位置参数「One of: nfc_card, ios_device, android_device, cloud_key」，
// pkg/vehicle/vcsec.go:151 addKeyPayload 只是原样塞进 KeyMetadata.keyFormFactor。
// 三个参考实现的取值不同（0Bu 生产固件 = CLOUD_KEY，它 vendor 的 tesla-ble C++ 库
// src/vehicle.cpp:1471 的 Vehicle::pair 硬编码 NFC_CARD，官方文档示例写 android_key）
// —— 这是**产品选择**上的差异，不是协议分歧，所以按「不许因为别的项目不同就改协议」的规则：
// 默认值保持本项目原有的 ANDROID_DEVICE（我们确实是手机），同时把官方四个值全部开放给现场 A/B。
export const FORM_FACTORS = [
  { value: FORM_FACTOR.KEY_FORM_FACTOR_ANDROID_DEVICE, note: '安卓手机钥匙（本项目默认）' },
  { value: FORM_FACTOR.KEY_FORM_FACTOR_CLOUD_KEY, note: '云端钥匙（0Bu 量产固件实测可用）' },
  { value: FORM_FACTOR.KEY_FORM_FACTOR_NFC_CARD, note: '实体钥匙卡（tesla-ble C++ 库内部用这个）' },
  { value: FORM_FACTOR.KEY_FORM_FACTOR_IOS_DEVICE, note: 'iOS 手机钥匙' }
];

export const DEFAULT_FORM_FACTOR = FORM_FACTOR.KEY_FORM_FACTOR_ANDROID_DEVICE;

export function formFactorText(value) {
  return label('KeyFormFactor', value);
}

// ---------------------------------------------------------------- 前置检查

function mustConnect() {
  if (!state.ble || !state.ble.connected) throw new Error('还没连上车辆，先按「扫描并连接」');
}

function mustKey() {
  if (!hasKey()) throw new Error('还没有密钥，先做绑定');
}

function vinOrEmpty() {
  return String(state.vin || '').toUpperCase();
}

// V3 的 keyId = 完整的 SHA1(公钥)，20 字节 / 40 个 hex 字符。
function myKeyId() {
  return state.publicKey ? toHex(sha1(state.publicKey)) : '';
}

// 车机「钥匙」列表里新登记的钥匙一律显示为 "Unknown key"，现场根本认不出哪把是本项目加的。
// 与 0Bu main/vehicle_pairing.cpp:809-866 同源的做法：Tesla 对外的 key id 取
// SHA1(65 字节未压缩公钥点) 的**前 4 字节**，冒号分隔的大写十六进制。
// 车辆回 GET_WHITELIST_INFO 时的 4 字节 keyId 就是这个（见 keyIdMatches 的前缀归一）。
function teslaKeyId() {
  const full = myKeyId();
  if (full.length < 8) return '-';
  return full.slice(0, 8).match(/../g).join(':').toUpperCase();
}

function entryKeyId(e) {
  const raw = e && e.keyId ? e.keyId.publicKeySHA1 : e && e.publicKeySHA1;
  return raw ? toHex(raw) : '-';
}

// 实测（2026-09 车端固件）GET_WHITELIST_INFO 回的条目只有 4 字节 keyId
// （protobuf 里是 `0a 04 xx xx xx xx`），而本机算出来的是 20 字节。
// 直接 indexOf 永远不命中，所以统一按「完整 SHA1 的前缀」归一比对。
function keyIdMatches(entry, full) {
  if (!entry || entry === '-' || !full) return false;
  const e = String(entry).toLowerCase();
  return e === full || full.indexOf(e) === 0;
}

// ---------------------------------------------------------------- 握手

// 一次 session_info 握手。K 是从「响应里带的车辆公钥」现算的，所以必须先解出
// session_info 才能验它的 HMAC —— 和官方 processHello 的顺序一致。
async function handshakeOnce(vin, session) {
  const uuid = newUuid();
  const addr = newRoutingAddress();
  const built = buildSessionInfoRequest(VC, state.publicKey, uuid, addr);
  log('tx', 'V3 握手 session_info_request（明文，uuid=' + toHex(uuid) + '）\n' + inspect(V3_SPEC, 'RoutableMessage', built.message));

  const body = await ble().send(prependLength(built.bytes), FIRST_RESPONSE_MS, true);
  if (body === null) return { ok: false, error: FIRST_RESPONSE_MS + ' 秒内没有响应（车辆休眠 / 没订阅成功）' };

  const parsed = parseFrame(body);
  if (parsed.kind !== 'routable') return { ok: false, error: '响应不是 RoutableMessage：' + parsed.text.slice(0, 120) };

  const rm = parsed.rm;
  const brief = summarize(rm);
  log('rx', '握手响应：' + brief.text + '\n' + parsed.text);
  const info = rm.session_info;
  if (!info || !info.length) return { ok: false, error: '响应里没有 session_info（' + brief.text + '）' };

  // 车辆拒绝建会话时（实测：钥匙不在白名单）只回 `session_info = 28 01`，
  // 既不带 publicKey 也不带 signature_data。必须先把 status 翻成人话，
  // 否则下面「没有 session_info_tag」会把真正的原因盖掉，还会白跑一次重试。
  let si = null;
  try {
    si = decode(V3_SPEC, 'SessionInfo', info);
  } catch (e) {
    return { ok: false, error: 'session_info 解不开：' + ((e && e.message) || String(e)) };
  }
  const status = si.status === undefined ? 0 : si.status;
  if (status !== 0) {
    const name = label('Session_Info_Status', status);
    return {
      ok: false,
      fatal: true, // 确定性拒绝，重试没有意义
      notWhitelisted: status === 1,
      error: '车辆拒绝建立会话：' + name +
        (status === 1 ? ' —— 这把钥匙还没进白名单。先按「③ 绑定（刷钥匙卡）」，踩一脚刹车唤醒车机，' + TAP_HINT : '')
    };
  }

  const sd = rm.signature_data || {};
  const tag = sd.session_info_tag ? sd.session_info_tag.tag : null;
  if (!tag) return { ok: false, error: '响应没有 session_info_tag（官方会当成 unauthenticated 直接丢弃）' };

  const pk = si.publicKey;
  if (!pk || pk.length !== 65 || pk[0] !== 0x04) {
    return { ok: false, error: 'session_info.publicKey 格式意外（' + (pk ? pk.length + 'B 首字节 0x' + pk[0] : '缺失') + '）' };
  }

  try {
    session.key = sharedKeyOf(state.privateKey, pk);
  } catch (e) {
    return { ok: false, error: 'ECDH 失败：' + ((e && e.message) || String(e)) };
  }

  // challenge = 车辆回显的 request_uuid；老固件不带时用我们自己发的 uuid 兜底
  const applied = applySessionInfo(session, {
    vin,
    challenge: rm.request_uuid || uuid,
    encodedInfo: info,
    tag
  });
  if (!applied.ok) {
    session.key = null;
    return { ok: false, error: applied.error };
  }
  return { ok: true, text: applied.text, status: applied.status, notWhitelisted: applied.notWhitelisted };
}

// force=false：会话还能用就直接复用；true：无论如何重做一次（页面上的「重新协商」按钮）
export async function handshake(force) {
  mustConnect();
  mustKey();
  const vin = vinOrEmpty();
  if (!vin) return { ok: false, text: 'VIN 为空，先在首页填 VIN 再连接' };

  const session = v3Session();
  if (!force && session.ready && session.key && session.epoch && session.anchor !== undefined) {
    return { ok: true, reused: true, text: '复用 V3 会话（counter=' + session.counter + '）' };
  }

  let last = { ok: false, error: '没跑过握手' };
  for (let i = 1; i <= 2; i++) {
    last = await handshakeOnce(vin, session);
    if (last.ok) {
      storeV3Session();
      log('ok', 'V3 握手成功 ' + last.text);
      if (last.notWhitelisted) {
        log('warn', '车辆回了 KEY_NOT_ON_WHITELIST：这把钥匙还没进白名单，先做绑定再发命令');
        return { ok: false, notWhitelisted: true, text: '握手通过，但车辆说这把钥匙不在白名单里（先刷卡绑定）' };
      }
      return { ok: true, text: '握手成功 ' + last.text };
    }
    log('warn', 'V3 握手第 ' + i + ' 次失败：' + last.error);
    // 车辆明确拒绝（session_info.status != 0）是确定性的，重发只会拿到同一条拒绝
    if (last.fatal) {
      invalidateV3Session('车辆拒绝握手');
      return { ok: false, fatal: true, notWhitelisted: last.notWhitelisted, text: 'V3 握手被拒：' + last.error };
    }
    if (i < 2) await sleep(1000);
  }
  invalidateV3Session('握手连续失败');
  return { ok: false, text: 'V3 握手失败：' + last.error };
}

// 页面上的「换取时公钥」按钮在 V3 里的等价动作：重做一次 session_info 握手
export async function requestEphemeralKey() {
  const r = await handshake(true);
  return { ok: r.ok, text: r.ok ? 'V3 会话已就绪：' + r.text : r.text };
}

// ---------------------------------------------------------------- 入白名单探针
//
// 「绑定到底成没成」不能只靠 whitelist-add 自己的回执判断（见文件头 PAIR_WINDOW_MS 的取证）：
//   官方 security.go:324 —— "Clients can check if publicKey has been enrolled ... by
//     attempting to call v.SessionInfo"
//   0Bu vehicle_pairing.cpp:246 —— 车机加白后**不发** completing commandStatus，
//     成功与否靠事后的签名 VCSEC 探针（它的 8 轮 get_vehicle_status）判断。
//
// 官方 SessionInfo（internal/dispatcher/dispatcher.go:464 SessionInfoRequest）用的是
// **不带签名**的 session_info_request + AuthMethodNone，正好等于本项目已有的 handshakeOnce
// 发包形状，只是这里把它的返回值当成「问句」而不是「握手步骤」用：
// 车端回 SessionInfo.status = OK → 钥匙已在白名单；= KEY_NOT_ON_WHITELIST → 还没加上。
//
// 探针打在 VCSEC 域而不是官方注释里举例的 INFOTAINMENT 域，理由有两条：
//   1) VCSEC 才是解锁/上锁要用的域，「能建 VCSEC 会话」才是我们要的强判据；
//   2) yoziru/esphome-tesla-ble 的 AGENTS.md 明确「VCSEC is always safe to poll
//      （低功耗控制器，不会唤醒车机）」，而 INFOTAINMENT 探针在车休眠时会干扰休眠。
//      本机实测（README F11）车辆拒绝建会话时回的 `session_info = 28 01` 也是 VCSEC 域。

async function probeOnce(vin) {
  invalidateV3Session('探针要求重新协商');
  const r = await handshakeOnce(vin, v3Session());
  if (r.ok) {
    storeV3Session();
    return { paired: true, text: '会话已建立（' + r.text + '）' };
  }
  if (r.notWhitelisted) return { paired: false, notWhitelisted: true, text: r.error };
  // 没响应 / 响应不是 RoutableMessage（例如正好把 add-key 的 WAIT 帧当成握手响应读走了）
  // 只说明这一针没打上，**不代表没绑上**，下一轮继续。
  return { paired: false, retryable: true, text: r.error };
}

// 页面上的「④ 探针确认」：单独打一针，回答「这把钥匙到底进没进白名单」
export async function probeEnrollment(opts) {
  mustConnect();
  mustKey();
  const vin = vinOrEmpty();
  if (!vin) return { ok: false, paired: false, text: 'VIN 为空，先在首页填 VIN 再连接' };

  const s = v3Session();
  if (!(opts && opts.force) && s.ready && s.key) {
    return { ok: true, paired: true, reused: true, text: '本机已有可用 V3 会话（counter=' + s.counter + '），说明钥匙已在白名单' };
  }

  const r = await probeOnce(vin);
  log(r.paired ? 'ok' : 'warn', '探针：' + r.text);
  return {
    ok: r.paired,
    paired: r.paired,
    notWhitelisted: !!r.notWhitelisted,
    text:
      (r.paired ? '已入白名单：' : '尚未入白名单：') + r.text +
      '\n本机 Tesla key id = ' + teslaKeyId() + '（车机钥匙列表里通常显示为 Unknown key）'
  };
}

// 绑定结果的人话收尾：把「判据来源」写清楚，避免现场把「没回执」当成失败
function pairVerdict(p, attempt) {
  return {
    ok: true,
    paired: true,
    text:
      '绑定成功 —— 探针第 ' + attempt + ' 次确认：' + p.text +
      '\n判据：session_info_request(VCSEC) 拿到了 status=OK 的 SessionInfo（官方 security.go:324 与 0Bu 都用这条）。' +
      '\n本机 Tesla key id = ' + teslaKeyId() + '，去车机 控制 > 安全 > 钥匙 里找那把 "Unknown key"。' +
      '\n下一步：到「上锁 / 解锁页」发 RKE 解锁验证'
  };
}

// 命令发出后车辆可能顺手刷新会话（dispatcher.go checkForSessionUpdate 的三道闸）
function applyPiggyback(rm, ctx) {
  const session = ctx.session;
  if (!session.key) {
    log('info', '响应带 session_info，但本机还没有共享密钥，按官方规则忽略');
    return;
  }
  if (Date.now() - ctx.sentAt > MAX_LATENCY_MS) {
    log('info', '响应带 session_info，但距请求发出已超过 ' + MAX_LATENCY_MS + 'ms，丢弃');
    return;
  }
  const sd = rm.signature_data || {};
  const tag = sd.session_info_tag ? sd.session_info_tag.tag : null;
  const applied = applySessionInfo(session, {
    vin: ctx.vin,
    challenge: rm.request_uuid || null,
    encodedInfo: rm.session_info,
    tag
  });
  if (applied.ok) {
    storeV3Session();
    log('rx', '顺手刷新会话：' + applied.text);
  } else {
    log('warn', '响应里的 session_info 未采用：' + applied.error);
  }
}

// ---------------------------------------------------------------- 单帧解码

// 一帧 → { fatal } 或 { fault, opStatus, obj, app, text }
function decodeFrame(body, ctx) {
  const parsed = parseFrame(body);

  // 车辆直接回裸 FromVCSECMessage（加白名单那条 PRESENT_KEY 老路会这样）
  if (parsed.kind !== 'routable') {
    const obj = parsed.vcsec || {};
    const app = summarizeVcsec(obj);
    log('rx', ctx.name + ' 裸 VCSEC 帧：' + app.text + '\n' + parsed.text);
    return { fault: 0, opStatus: 0, obj, app, text: parsed.text };
  }

  const rm = parsed.rm;
  const st = rm.signedMessageStatus || {};
  const fault = st.signed_message_fault || 0;
  const opStatus = st.operation_status || 0;
  const proto = summarize(rm);
  log(fault ? 'warn' : 'rx', ctx.name + ' 协议层：' + proto.text);
  if (rm.session_info) applyPiggyback(rm, ctx);

  const sd = rm.signature_data || {};
  let obj = {};
  let text = '';
  try {
    if (sd.AES_GCM_Response_data) {
      const d = decryptResponse(rm, { domain: VC, vin: ctx.vin, session: ctx.session, requestId: ctx.requestId });
      if (!d.ok) return { fatal: true, fault, opStatus, text: ctx.name + ' 响应解密失败：' + d.error };
      const inner = decodeFromVcsec(d.plaintext);
      obj = inner.obj;
      text = inner.text;
      log('rx', ctx.name + ' 解密后（车辆 counter=' + d.counter + '）:\n' + text);
    } else {
      const inner = decodeFromVcsec(rm.protobuf_message_as_bytes);
      obj = inner.obj;
      text = inner.text;
      log('rx', ctx.name + ' 应用层:\n' + text);
    }
  } catch (e) {
    return { fatal: true, fault, opStatus, text: ctx.name + ' 响应解析失败：' + ((e && e.message) || String(e)) };
  }

  const empty = !obj || Object.keys(obj).length === 0;
  const app = empty ? { kind: 'empty', status: 0, text: '空响应（车辆已受理，没有 commandStatus）' } : summarizeVcsec(obj);
  return { fault, opStatus, obj, app, text };
}

// 协议层结论，对应 protocol.GetError：先看 fault，再看 operation_status
function protoOutcome(fault, opStatus) {
  if (fault) {
    const text = label('MessageFault_E', fault);
    if (RESYNC_FAULTS.indexOf(fault) >= 0) return { action: 'resync', text };
    if (RETRYABLE_FAULTS.indexOf(fault) >= 0) return { action: 'busy', text };
    return { action: 'fail', text };
  }
  if (opStatus === UM.OPERATIONSTATUS_WAIT) return { action: 'busy', text: 'operation_status=WAIT' };
  if (opStatus === UM.OPERATIONSTATUS_ERROR) return { action: 'fail', text: 'operation_status=ERROR' };
  return { action: 'pass' };
}

// 应用层结论，对应 vcsec.go unmarshalVCSECResponse
function appOutcome(obj) {
  if (obj.nominalError) {
    return { action: 'fail', text: 'nominalError ' + label('GenericError_E', obj.nominalError.genericError) };
  }
  const cs = obj.commandStatus;
  if (cs) {
    const st = cs.operationStatus === undefined ? 0 : cs.operationStatus;
    if (st === UM.OPERATIONSTATUS_WAIT) return { action: 'busy', text: 'commandStatus=WAIT' };
    if (st === UM.OPERATIONSTATUS_ERROR) {
      const w = cs.whitelistOperationStatus;
      if (w) {
        const info = w.whitelistOperationInformation === undefined ? 0 : w.whitelistOperationInformation;
        if (info !== 0) return { action: 'fail', text: '白名单被拒：' + label('WhitelistOperation_information_E', info) };
      }
      if (!cs.signedMessageStatus) return { action: 'fail', text: 'operationStatus=ERROR 且车辆没给原因' };
    }
  }
  return { action: 'pass' };
}

// ---------------------------------------------------------------- 发一条 V3 请求

// opts: { name, payload, plain, done, maxMs }
//   plain=true  → 明文（InformationRequest 这类不需要会话的查询，官方用 AuthMethodNone）
//   done(obj, summary) → 是不是终态；不传表示「第一帧就算完」
// 返回 { ok, text, obj, summary, timeout, fault }
export async function sendRequest(opts) {
  mustConnect();
  const name = opts.name || 'V3 请求';
  const done = opts.done || function () { return true; };
  const vin = vinOrEmpty();
  if (!vin) return { ok: false, text: name + '：VIN 为空，先在首页填 VIN 再连接' };
  if (!opts.plain) mustKey();

  const session = v3Session();
  // VCSEC 域的响应只按 routing_address 配对（dispatcher.go:400-407），
  // 所以整条请求连同重发都必须复用同一组 addr / uuid，否则响应会掉进没人领的收件箱。
  const routingAddress = newRoutingAddress();
  const uuid = newUuid();
  const deadline = Date.now() + (opts.maxMs || DEFAULT_MAX_MS);
  let resynced = false;

  for (let attempt = 1; ; attempt++) {
    if (!opts.plain) {
      const h = await handshake(false);
      if (!h.ok) return { ok: false, text: name + '：' + h.text };
    }

    let built = null;
    let buildError = '';
    try {
      built = opts.plain
        ? buildPlainRequest({ domain: VC, routingAddress, payload: opts.payload, uuid, flags: REQUEST_FLAGS })
        : encryptCommand({
            domain: VC,
            vin,
            session,
            publicKey: state.publicKey,
            payload: opts.payload,
            flags: REQUEST_FLAGS,
            routingAddress,
            uuid
          });
    } catch (e) {
      buildError = (e && e.message) || String(e);
    }
    if (!built) {
      if (!opts.plain && attempt < MAX_ATTEMPTS) {
        log('warn', name + ' 组包失败（' + buildError + '），作废会话后重新握手');
        invalidateV3Session('组包时会话参数不全');
        await sleep(1000);
        continue;
      }
      return { ok: false, text: name + ' 组包失败：' + buildError };
    }

    const ctx = { name, vin, session, requestId: requestIdOf(built.message), sentAt: Date.now() };
    log(
      'tx',
      name +
        (opts.plain ? ' 明文请求 ' : ' counter=' + built.counter + ' nonce=' + toHex(built.nonce) + ' 密文=' + built.ciphertext.length + 'B ') +
        toHex(built.bytes)
    );

    let body = null;
    try {
      // keepQueue=true：收帧循环期间车辆可能又推进来一帧，清空队列会把终态丢掉
      body = await ble().send(prependLength(built.bytes), FIRST_RESPONSE_MS, true);
    } catch (e) {
      return { ok: false, text: name + ' 发送失败：' + ((e && e.message) || String(e)) };
    }

    let first = true;
    let last = null;
    for (;;) {
      if (body === null) {
        if (first) {
          if (attempt < MAX_ATTEMPTS) {
            log('warn', name + ' 没收到响应，1 秒后重发（第 ' + (attempt + 1) + '/' + MAX_ATTEMPTS + ' 次）');
            await sleep(1000);
            break;
          }
          return { ok: false, timeout: true, text: name + '：车辆 ' + FIRST_RESPONSE_MS + ' 秒内没有任何响应' };
        }
        if (Date.now() >= deadline) {
          return { ok: false, timeout: true, text: name + ' 等待终态超时（最后一帧：' + (last ? last.text : '无') + '）' };
        }
        await sleep(1000);
        body = await ble().receive(Math.max(500, Math.min(3000, deadline - Date.now())));
        continue;
      }
      first = false;

      const r = decodeFrame(body, ctx);
      if (r.fatal) return { ok: false, text: r.text, fault: r.fault };
      last = r;

      const why = r.fault || r.opStatus ? protoOutcome(r.fault, r.opStatus) : appOutcome(r.obj);
      if (why.action === 'resync' && !resynced) {
        resynced = true;
        log('warn', name + ' 车辆回 ' + why.text + '，counter/epoch 疑似失步，重新握手');
        invalidateV3Session('车辆回 ' + why.text);
        await sleep(1000);
        break;
      }
      if (why.action === 'busy') {
        if (attempt < MAX_ATTEMPTS) {
          log('warn', name + ' ' + why.text + '，1 秒后重发');
          await sleep(1000);
          break;
        }
        return { ok: false, text: name + ' 车辆一直回 ' + why.text, fault: r.fault };
      }
      if (why.action === 'fail') return { ok: false, text: name + ' 被拒：' + why.text, fault: r.fault };

      if (done(r.obj, r.app)) {
        return { ok: true, obj: r.obj, summary: r.app, text: name + ' 完成：' + r.app.text, raw: r.text };
      }
      if (Date.now() >= deadline) {
        return { ok: false, timeout: true, text: name + ' 等待终态超时（最后一帧：' + r.app.text + '）' };
      }
      await sleep(1000);
      body = await ble().receive(Math.max(500, Math.min(3000, deadline - Date.now())));
    }
    // break 到这里 = 整条重发
  }
}

// ---------------------------------------------------------------- 三类终态判据

// RKE / 闭锁器：vcsec.go executeRKEAction —— 收到一条「没有 commandStatus」的报文才算完
const doneCommand = (obj) => !(obj && obj.commandStatus);

// 白名单操作：vcsec.go isWhitelistOperationComplete —— 必须带 whitelistOperationStatus 才是终态
const doneWhitelist = (obj) => !!(obj && obj.commandStatus && obj.commandStatus.whitelistOperationStatus);

// ---------------------------------------------------------------- 页面按钮

// 上锁 / 解锁 / 唤醒等 RKE 动作
export async function sendRke(action, name) {
  const label_ = name || label('RKEAction_E', action);
  if (KNOWN_RKE.indexOf(action) < 0) log('warn', label_ + '：官方现行 RKEAction_E 里没有这个值，车辆多半会拒');
  return sendRequest({ name: label_, payload: encodeUnsignedMessage({ RKEAction: action }), done: doneCommand });
}

// 后备箱 / 前备箱 / 充电口等：走 ClosureMoveRequest，不再是 RKE action
// fields 例：{ frontTrunk: CLOSURE.CLOSURE_MOVE_TYPE_OPEN }
export async function sendClosure(fields, name) {
  return sendRequest({
    name: name || 'ClosureMoveRequest',
    payload: encodeUnsignedMessage({ closureMoveRequest: fields || {} }),
    done: doneCommand
  });
}

// 明文查询（不需要会话）；slot 只有 GET_WHITELIST_ENTRY_INFO 用得上
export async function infoRequest(type, name, timeoutMs, slot) {
  const req = { informationRequestType: type };
  if (slot !== undefined && slot !== null) req.slot = slot;
  return sendRequest({
    name: name || label('InformationRequestType', type),
    payload: encodeUnsignedMessage({ InformationRequest: req }),
    plain: true,
    done: () => true,
    maxMs: timeoutMs || DEFAULT_MAX_MS
  });
}

// 官方现行 vcsec.proto 只有这三种查询；GET_VEHICLE_INFO / GET_CAPABILITIES / GET_KEYSTATUS_INFO
// 已经从 proto 里删掉了，所以页面上也不给按钮
export const queries = {
  status: () => infoRequest(INFO.INFORMATION_REQUEST_TYPE_GET_STATUS, 'GET_STATUS'),
  whitelist: () => infoRequest(INFO.INFORMATION_REQUEST_TYPE_GET_WHITELIST_INFO, 'GET_WHITELIST_INFO'),
  whitelistEntry: (slot) =>
    infoRequest(INFO.INFORMATION_REQUEST_TYPE_GET_WHITELIST_ENTRY_INFO, 'GET_WHITELIST_ENTRY_INFO', DEFAULT_MAX_MS, slot)
};

// 主绑定路径：官方 security.go:338 SendAddKeyRequestWithRole ——
// 裸 ToVCSECMessage{signedMessage{PRESENT_KEY}}，不带会话。
//
// 三段状态机（照 0Bu main/vehicle_pairing.cpp:240-301 的量产实现，判据换成官方也认可的会话探针）：
//   0. 先打一针。已经能建会话 = 早就绑好了，直接返回 —— **绝不再发 add-key**。
//      0Bu 的原话：一轮只发一次（而不是每 ~45 秒重发一块）「也止住了钥匙登记成功后
//      车机反复弹配对请求」。
//   1. 发一次 whitelist-add。官方发完就 return；我们多等一会儿，因为 protocol.md:824 说
//      车端会先回 WAIT、刷完卡再回带 whitelistOperationStatus 的终态。
//   2. 交替进行：收车端回执（2.5 秒一片）+ 每 5 秒打一针会话探针。
//      0Bu 实测「车机加白后不发 completing commandStatus」，所以**探针先命中是正常路径**，
//      不能等到窗口耗尽才下结论；反过来，真拿到 whitelistOperationStatus 终态时以它为准
//      （那是车辆自己给的确切答案，比探针强）。
export async function bindKey(vin, opts) {
  mustConnect();
  const formFactor = opts && opts.formFactor !== undefined ? opts.formFactor : DEFAULT_FORM_FACTOR;
  // 时间片可覆盖，仅为了离线回归能在秒级跑完「探针命中 / 窗口耗尽」两条路径；
  // 默认值就是上面的常量，不改变任何协议字节。
  const windowMs = pick(opts, 'windowMs', PAIR_WINDOW_MS);
  const receiveMs = pick(opts, 'receiveMs', PAIR_RECEIVE_MS);
  const probeFirstMs = pick(opts, 'probeFirstMs', PROBE_FIRST_MS);
  const probeIntervalMs = pick(opts, 'probeIntervalMs', PROBE_INTERVAL_MS);
  const k = ensureKey((vin || vinOrEmpty() || '').toUpperCase());
  if (k.created) log('info', '已生成本机密钥对，接着把公钥交给车辆');

  const name = 'AddKey（刷卡配对）';
  const ffText = formFactorText(formFactor);
  log('info', name + ' 开始：formFactor=' + ffText + ' role=' + label('Role', ROLE.ROLE_DRIVER) + ' 本机 key id=' + teslaKeyId());

  // ---- 阶段 0：先确认是不是已经绑好了
  const vinUp = vinOrEmpty();
  if (!vinUp) return { ok: false, text: name + '：VIN 为空，先在首页填 VIN 再连接' };
  const pre = await probeOnce(vinUp);
  if (pre.paired) {
    return { ok: true, paired: true, already: true, text: '不用绑定，这把钥匙早就在白名单里且会话可用：' + pre.text + '\n直接去「上锁 / 解锁页」发指令即可' };
  }
  log('info', name + ' 预探针：' + pre.text + ' —— 继续发加白名单请求');

  // ---- 阶段 1：发一次（且仅一次）whitelist-add
  const envelope = buildAddKeyEnvelope(state.publicKey, ROLE.ROLE_DRIVER, formFactor);
  log('tx', name + ' PRESENT_KEY，不带会话 ' + toHex(envelope));

  const ctx = { name, vin: vinUp, session: v3Session(), requestId: null, sentAt: Date.now() };
  let body = null;
  try {
    body = await ble().send(prependLength(envelope), FIRST_RESPONSE_MS, true);
  } catch (e) {
    return { ok: false, text: name + ' 发送失败：' + ((e && e.message) || String(e)) + '\n先确认 ② 还连着（车辆同时最多约 3 个 BLE 连接，官方 Tesla App 在后台会占掉一个）' };
  }

  // ---- 阶段 2：等回执 / 打探针，谁先来算谁
  const deadline = Date.now() + windowMs;
  let nextProbe = Date.now() + probeFirstMs;
  let probes = 0;
  let sawWait = false;
  let lastStatus = '';

  for (;;) {
    while (body !== null && body !== undefined) {
      const r = decodeFrame(body, ctx);
      const cs = r.obj && r.obj.commandStatus;
      const st = cs && cs.operationStatus !== undefined ? cs.operationStatus : 0;

      // 车辆给了 whitelistOperationStatus —— 官方 protocol.md:836 认定这是唯一终态，
      // 它比探针权威（是车自己说的成/败），直接照它下结论。
      if (cs && cs.whitelistOperationStatus) {
        const info = cs.whitelistOperationStatus.whitelistOperationInformation === undefined
          ? 0
          : cs.whitelistOperationStatus.whitelistOperationInformation;
        const hint = PAIR_HINTS[info] || '';
        if (info !== 0) {
          return { ok: false, info, text: '车辆明确回执：' + label('WhitelistOperation_information_E', info) + (hint ? '\n' + hint : '') };
        }
        // 车说加好了，再打一针拿会话（0Bu 的第 3 步；官方 security.go:324 同一件事）
        const after = await probeOnce(vinUp);
        probes++;
        return {
          ok: true,
          paired: after.paired,
          info,
          text:
            '车辆回执已加入白名单（' + label('WhitelistOperation_information_E', 0) + '）' + (hint ? '\n' + hint : '') +
            '\n会话探针：' + after.text +
            '\n本机 Tesla key id = ' + teslaKeyId() + '（车机钥匙列表里显示为 Unknown key）' +
            (after.paired ? '\n下一步：到「上锁 / 解锁页」发 RKE 解锁验证' : '\n注意：车机可能还要几秒才同步完，稍后再按一次「④ 探针确认」')
        };
      }

      // WAIT = 等刷卡，不是「忙」，绝不能重发（重发会把配对窗口重新开始计时）
      if (st === UM.OPERATIONSTATUS_WAIT) {
        if (!sawWait) {
          sawWait = true;
          log('ok', '车辆已进入配对等待，' + TAP_HINT);
        }
      } else if (st === UM.OPERATIONSTATUS_ERROR) {
        return { ok: false, text: name + ' 被车端拒绝：' + r.app.text + '\n' + TAP_HINT };
      } else if (r.fault) {
        log('warn', name + ' 收到协议层 fault：' + label('MessageFault_E', r.fault) + '（继续等，不重发 add-key）');
      }
      body = await ble().receive(receiveMs);
    }

    if (Date.now() >= deadline) break;
    if (Date.now() < nextProbe) {
      body = await ble().receive(Math.min(receiveMs, Math.max(200, deadline - Date.now())));
      continue;
    }

    probes++;
    const p = await probeOnce(vinUp);
    nextProbe = Date.now() + probeIntervalMs;
    if (p.paired) return pairVerdict(p, probes);
    if (p.text !== lastStatus) {
      lastStatus = p.text;
      log('info', '探针第 ' + probes + ' 次未通过：' + p.text);
    } else {
      log('info', '探针第 ' + probes + ' 次结果同前');
    }
    if (!sawWait) log('info', '提示：车端始终没回 WAIT，可能根本没进入配对流程（车机屏幕有没有弹「添加钥匙」？BLE 连接数是否已被官方 App 占满？）');
    body = null; // 探针自己收走了响应，回到循环顶部按时间片继续等
  }

  return {
    ok: false,
    wait: true,
    probes,
    text:
      name + ' 已发出并等待 ' + Math.round(windowMs / 1000) + ' 秒（探针 ' + probes + ' 次），' +
      '既没拿到车端 whitelistOperationStatus 终态，也建不起会话 —— 判「没绑上」。\n' +
      '最后一次探针：' + (lastStatus || '没打上') + '\n' +
      '逐项排查：\n' +
      '1）车机屏幕有没有弹「添加钥匙 / Add key」并需要你点确认？没弹说明请求没进配对流程。\n' +
      '2）' + TAP_HINT + '\n' +
      '3）蓝牙连接数：一辆车同时最多约 3 个 BLE 连接（官方 Tesla App、手机钥匙、遥控钥匙共享）。' +
      '请退出并杀掉官方 App 后台，或在 Tesla App > 安全 > 钥匙 里移除不用的钥匙。\n' +
      '4）车是不是睡了：踩一脚刹车让车机亮屏后，重新点「③ 绑定」——' +
      '本函数每轮只发一次 add-key，重复点是为了让车机重新起配对流程。'
  };
}

// 备用路径：官方 AddKeyWithRole —— 已经有一把能用的高权限钥匙时，直接走会话加密写进白名单，
// 不需要刷实体卡。
export async function bindKeyViaSession(vin, opts) {
  mustConnect();
  ensureKey((vin || vinOrEmpty() || '').toUpperCase());
  const formFactor = opts && opts.formFactor !== undefined ? opts.formFactor : DEFAULT_FORM_FACTOR;
  const payload = buildAddKeyPayload(state.publicKey, ROLE.ROLE_DRIVER, formFactor);
  const r = await sendRequest({ name: 'AddKey（会话内）', payload, done: doneWhitelist, maxMs: WHITELIST_MAX_MS });
  if (r.ok && r.summary && r.summary.kind === 'whitelist') {
    const okInfo = r.summary.info === 0;
    return { ok: okInfo, text: (okInfo ? '已加入白名单：' : '车辆拒绝加入白名单：') + r.summary.text };
  }
  return r;
}

export async function checkWhitelisted() {
  try {
    const r = await queries.whitelist();
    const wi = r.obj && r.obj.whitelistInfo;
    if (!wi) return { known: false, text: '白名单查询无结果：' + r.text };
    const entries = (wi.whitelistEntries || []).map(entryKeyId);
    const full = myKeyId();
    const mine = hasKey() && entries.some((e) => keyIdMatches(e, full));
    const slots = wi.slotMask === undefined ? null : wi.slotMask;
    return {
      known: true,
      mine,
      text:
        '白名单 ' + entries.length + ' 条 [' + entries.join(' ') + ']' +
        (slots !== null ? ' 可用槽位掩码=0b' + (slots >>> 0).toString(2) : '') +
        (hasKey()
          ? '；本机 Tesla key id=' + teslaKeyId() + '（完整 SHA1=' + (full || '-') + '）' +
            (mine ? ' → 在内' : ' → 不在内，需要重新绑定刷卡')
          : '（本机还没有密钥）')
    };
  } catch (e) {
    return { known: false, text: '白名单查询失败：' + ((e && e.message) || String(e)) };
  }
}

// 会话能不能建 = 钥匙在不在白名单。绑定之后优先看这个，别只盯着白名单列表。
export async function probeSession() {
  return probeEnrollment({ force: true });
}

export function statusText() {
  const s = v3Session();
  const live = s.key && s.epoch && s.anchor !== undefined;
  const kid = teslaKeyId();
  return (
    'BLE=' + connection.connection +
    ' | ' + (hasKey() ? 'keyId=' + kid : '无密钥') +
    ' | V3counter=' + (s.counter || 0) +
    ' | 会话=' + (live ? (s.ready ? 'ready' : '未就绪') : '未握手') +
    ' | epoch=' + (s.epoch ? toHex(s.epoch).slice(0, 16) + '…' : '-')
  );
}
