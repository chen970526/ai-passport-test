// V3 上下文：域定义、按域挑选编解码器、请求 ID 台账、前置检查。

import { sha1 } from '../infra/crypto/sha1.js';
import { V3_SPEC, DOMAIN, label, decodeFromVcsec, decodeFromCarServer, summarizeVcsec, summarizeCarServer, toHex } from '../protocol/index.js';
import { state } from '../store/app-state.js';
import { hasKey } from '../store/credential-store.js';
import { v3Session } from '../store/v3-session-store.js';

// ---------------------------------------------------------------- 域（domain）
//
// universal_message.proto:11-14 的 Domain 有三档，本项目只建两份会话：
//   DOMAIN_VEHICLE_SECURITY=2（VCSEC）—— 解锁 / 上锁 / 闭锁器 / 白名单，官方 dispatcher.go:36
//     按域各存一份 SessionInfo；
//   DOMAIN_INFOTAINMENT=3（车机）—— 充电盖板 / GetVehicleData / Ping，
//     载荷是 car_server.Action，回执是 car_server.Response；
//   DOMAIN_BLUETOOTH=0 是路由用的，不建会话，传到这里会被 v3-session-store 的 storeKeyOf 直接抛错。
//
// 两个域**必须**各用一套 counter：官方 internal/dispatcher/dispatcher.go:36 是
// `sessions [Domain_MAX]Session`，pkg/protocol/domains.go:7-13 明确了域间互不共享；
// tesla-ble/src/client.cpp:46-52 同样是 per-domain 的 Session 数组，
// include/peer.h 里也是 `Session sessions[DOMAIN_COUNT]`。
// 混用会让第二个域第一条命令就吃到 INVALID_TOKEN_OR_COUNTER。
export const VC = DOMAIN.DOMAIN_VEHICLE_SECURITY;
export const INFO_DOMAIN = DOMAIN.DOMAIN_INFOTAINMENT;

export const DOMAINS = { VCSEC: VC, INFOTAINMENT: INFO_DOMAIN };

// 域 → 人话，日志里所有 V3 收发都带这个前缀，避免现场把两个域的 counter 看串
export function domainText(domain) {
  return label('Domain', domain);
}

// 按域挑选应用层的编解码器：VCSEC 用 ToVCSECMessage/FromVCSECMessage，
// INFOTAINMENT 用 car_server.Action/Response。
export function appCodec(domain) {
  return domain === VC
    ? { decode: decodeFromVcsec, summarize: summarizeVcsec, name: 'VCSEC' }
    : { decode: decodeFromCarServer, summarize: summarizeCarServer, name: 'CAR_SERVER' };
}

// 另一个域的会话密钥（仅在 tag 不符时用于试算，绝不打印密钥本身）。
// 官方 dispatcher.go:232-242 是拿**响应的** from_destination.domain 去 sessions[] 里取会话来解密的，
// 所以如果车机把回包记在另一个域名下，密钥也会跟着换一套。
export function otherDomainKeys(domain) {
  const other = domain === VC ? INFO_DOMAIN : VC;
  const s = v3Session(other);
  return s && s.key ? [{ name: domainText(other), key: s.key }] : [];
}

// 每个域最近用过的请求 ID。重发 / 串台时，车辆回的是**上一次**请求的 request_hash，
// 用当前 requestId 验 tag 必然对不上；tag 不符的试算里命中这一项即可确认是这种情况。
export const RECENT_ID_LIMIT = 3;
export const recentIds = {};
export function rememberRequestId(domain, entry) {
  const list = recentIds[domain] || (recentIds[domain] = []);
  list.unshift(entry);
  if (list.length > RECENT_ID_LIMIT) list.length = RECENT_ID_LIMIT;
}

export const RKE = V3_SPEC.enums.RKEAction_E;
export const CLOSURE = V3_SPEC.enums.ClosureMoveType_E;

// car_server.proto:160-164 —— 只有 OK/ERROR 两档，**没有 WAIT**，
// 所以车机侧的响应不需要像 VCSEC 那样等终态，第一帧就是结论。
export const CS = V3_SPEC.enums.CSOperationStatus_E;

export const ROLE = V3_SPEC.enums.Role;
export const FORM_FACTOR = V3_SPEC.enums.KeyFormFactor;
export const INFO = V3_SPEC.enums.InformationRequestType;

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

export function mustConnect() {
  if (!state.ble || !state.ble.connected) throw new Error('还没连上车辆，先按「扫描并连接」');
}

export function mustKey() {
  if (!hasKey()) throw new Error('还没有密钥，先做绑定');
}

export function vinOrEmpty() {
  return String(state.vin || '').toUpperCase();
}

// V3 的 keyId = 完整的 SHA1(公钥)，20 字节 / 40 个 hex 字符。
export function myKeyId() {
  return state.publicKey ? toHex(sha1(state.publicKey)) : '';
}

// 车机「钥匙」列表里新登记的钥匙一律显示为 "Unknown key"，现场根本认不出哪把是本项目加的。
// 与 0Bu main/vehicle_pairing.cpp:809-866 同源的做法：Tesla 对外的 key id 取
// SHA1(65 字节未压缩公钥点) 的**前 4 字节**，冒号分隔的大写十六进制。
// 车辆回 GET_WHITELIST_INFO 时的 4 字节 keyId 就是这个（见 keyIdMatches 的前缀归一）。
export function teslaKeyId() {
  const full = myKeyId();
  if (full.length < 8) return '-';
  return full.slice(0, 8).match(/../g).join(':').toUpperCase();
}

export function entryKeyId(e) {
  const raw = e && e.keyId ? e.keyId.publicKeySHA1 : e && e.publicKeySHA1;
  return raw ? toHex(raw) : '-';
}

// 实测（2026-09 车端固件）GET_WHITELIST_INFO 回的条目只有 4 字节 keyId
// （protobuf 里是 `0a 04 xx xx xx xx`），而本机算出来的是 20 字节。
// 直接 indexOf 永远不命中，所以统一按「完整 SHA1 的前缀」归一比对。
export function keyIdMatches(entry, full) {
  if (!entry || entry === '-' || !full) return false;
  const e = String(entry).toLowerCase();
  return e === full || full.indexOf(e) === 0;
}
