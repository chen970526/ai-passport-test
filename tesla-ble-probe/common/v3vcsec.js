// Tesla V3（UniversalMessage.RoutableMessage）协议层
//
// 权威依据（teslamotors/vehicle-command main 分支）：
//   pkg/protocol/protocol.md                            —— 报文格式、TLV 元数据、测试向量
//   internal/authentication/{native,metadata,peer,signer,crypto}.go —— 会话/加密实现
//   internal/dispatcher/{dispatcher,session,receiver}.go            —— 报文编排
//   pkg/vehicle/{vehicle,vcsec,security}.go                         —— 应用层怎么用
//
// 协议要点（相对早期 VCSEC 直连写法）：
//   1) 外层从 ToVCSECMessage 换成 RoutableMessage，带 to/from_destination、uuid、flags；
//   2) 密钥协商从「GET_EPHEMERAL_PUBLIC_KEY 信息请求」换成 session_info_request(14) ↔ session_info(15) 握手，
//      握手响应用 HMAC-SHA256(HMAC-SHA256(K,"session info"), 元数据 ‖ 0xFF ‖ session_info) 认证；
//   3) 命令加密从「nonce = counter 大端 4 字节、AAD 空」换成 12 字节随机 nonce +
//      AAD = SHA256(TLV 元数据 ‖ 0xFF)，tag 放进 signature_data.AES_GCM_Personalized_data。
//
// 载荷（payload）内容：
//   VCSEC 域的 protobuf_message_as_bytes 直接就是 VCSEC.UnsignedMessage（请求）/
//   VCSEC.FromVCSECMessage（响应），不再套 ToVCSECMessage。
//   唯一例外：加白名单（需要刷 NFC 卡、此时还没有会话）沿用裸
//   ToVCSECMessage{signedMessage{signatureType=PRESENT_KEY}}，
//   官方 security.go:338 SendAddKeyRequestWithRole 就是这么发的。
//
// 本文件只做协议，不碰 BLE、不碰存储；会话状态由调用方（common/v3actions.js）持有。

import { V3_SPEC } from './v3spec.js';
import { encode, decode, inspect } from './pb.js';
import { sha256, hmacSha256 } from './sha256.js';
import { aes128GcmEncrypt, aes128GcmDecrypt, randomBytes } from './aes.js';
import { deriveSharedSecret } from './p256.js';
import { sha1 } from './sha1.js';
import { concatBytes, beBytes, toHex, equalBytes, utf8ToBytes } from './bytes.js';

export const DOMAIN = V3_SPEC.enums.Domain;
export const TAG = V3_SPEC.enums.Tag;
export const SIGTYPE = V3_SPEC.enums.SignatureType;
export const FLAGS = V3_SPEC.enums.Flags;
export const FAULT = V3_SPEC.enums.MessageFault_E;
export const UM = V3_SPEC.enums.UMOperationStatus_E;

// 官方常量（internal/dispatcher/session.go, internal/authentication/crypto.go）
export const DEFAULT_EXPIRES_IN = 5; // dispatcher.defaultExpiration = 5s
export const MAX_EPOCH_SECONDS = 1 << 30; // authentication.epochLength
export const ADDR_LEN = 16; // receiver.go: addressLength / uuidLength / challengeLength
export const NONCE_LEN = 12; // gcm.NonceSize()

const EMPTY = new Uint8Array(0);
const END_TAG = new Uint8Array([TAG.TAG_END]);

// 会话标签（native.go 里的 labelSessionInfo / labelMessageAuth）
export const LABEL_SESSION_INFO = 'session info';
export const LABEL_MESSAGE_AUTH = 'authenticated command';

export function localNow() {
  return Math.floor(Date.now() / 1000);
}

export function newRoutingAddress() {
  return randomBytes(ADDR_LEN);
}

export function newUuid() {
  return randomBytes(ADDR_LEN); // uuidLength == addressLength == 16
}

// ---------------------------------------------------------------- 共享密钥

// K = SHA1(ECDH(C, V).X)[:16]（native.go Exchange；与旧版算法一致，只是来源换成握手响应）
export function sharedKeyOf(privateKey, vehiclePublicKey) {
  return sha1(deriveSharedSecret(privateKey, vehiclePublicKey)).subarray(0, 16);
}

// 子密钥 = HMAC-SHA256(K, label)
export function subkey(key, label) {
  return hmacSha256(key, utf8ToBytes(label));
}

// ---------------------------------------------------------------- TLV 元数据

// 对应 internal/authentication/metadata.go：
//   Add(tag,value) 写 [tag u8][len u8][value]；value 为 nil 时静默跳过；>255 报错；tag 必须递增
//   Checksum(msg) 先写 0xFF 再写 msg，然后取摘要
export class Metadata {
  constructor() {
    this.parts = [];
    this.lastTag = -1;
  }

  add(tag, value) {
    if (value === null || value === undefined) return this;
    const v = value instanceof Uint8Array ? value : Uint8Array.from(value);
    if (v.length > 255) throw new Error('V3: 元数据字段过长 tag=' + tag + ' len=' + v.length);
    if (tag <= this.lastTag) throw new Error('V3: 元数据 tag 必须递增，已有 ' + this.lastTag + '，又要写 ' + tag);
    this.lastTag = tag;
    this.parts.push(beBytes(tag, 1), beBytes(v.length, 1), v);
    return this;
  }

  // 元数据里的 uint32 一律大端（protobuf 的 fixed32 才是小端，别混）
  addUint32(tag, value) {
    return this.add(tag, beBytes(value >>> 0, 4));
  }

  addByte(tag, value) {
    return this.add(tag, beBytes(value & 0xff, 1));
  }

  // Checksum 的输入：TLV 串 ‖ 0xFF ‖ msg
  bytes(withEnd, msg) {
    const list = this.parts.slice();
    if (withEnd !== false) list.push(END_TAG);
    if (msg && msg.length) list.push(msg instanceof Uint8Array ? msg : Uint8Array.from(msg));
    return concatBytes(list);
  }

  // GCM 请求的 AAD = SHA256(TLV ‖ 0xFF)
  sha256(msg) {
    return sha256(this.bytes(true, msg));
  }

  // HMAC 请求 / session_info 的 tag = HMAC-SHA256(子密钥, TLV ‖ 0xFF ‖ msg)
  hmac(subKey, msg) {
    return hmacSha256(subKey, this.bytes(true, msg));
  }
}

// 请求侧元数据（peer.go extractMetadata）：sigtype→domain→VIN→epoch→expires→counter→flags(仅 >0)
export function requestMetadata(opts) {
  const domain = opts.domain;
  if (domain === undefined || domain === null) throw new Error('V3: 元数据缺少 domain（官方直接报错，不能省）');
  if (domain < 0 || domain > 255) throw new Error('V3: domain 超出 1 字节范围 ' + domain);
  const expiresAt = opts.expiresAt;
  if (expiresAt > MAX_EPOCH_SECONDS || expiresAt < 0) throw new Error('V3: expires_at 越界 ' + expiresAt);

  const m = new Metadata();
  m.addByte(TAG.TAG_SIGNATURE_TYPE, opts.signatureType);
  m.addByte(TAG.TAG_DOMAIN, domain);
  m.add(TAG.TAG_PERSONALIZATION, utf8ToBytes(String(opts.vin || '').toUpperCase()));
  m.add(TAG.TAG_EPOCH, opts.epoch);
  m.addUint32(TAG.TAG_EXPIRES_AT, expiresAt);
  m.addUint32(TAG.TAG_COUNTER, opts.counter);
  // 向后兼容：只有真的置了位才把 flags 写进哈希（中间人抹掉标志位时哈希会不一致）
  if (opts.flags > 0) m.addUint32(TAG.TAG_FLAGS, opts.flags);
  return m;
}

// 响应侧元数据（peer.go responseMetadata）：sigtype=9→domain(from)→VIN→counter→flags(恒含)→request_hash→fault
export function responseMetadata(opts) {
  const m = new Metadata();
  m.addByte(TAG.TAG_SIGNATURE_TYPE, SIGTYPE.SIGNATURE_TYPE_AES_GCM_RESPONSE);
  m.addByte(TAG.TAG_DOMAIN, opts.domain);
  m.add(TAG.TAG_PERSONALIZATION, utf8ToBytes(String(opts.vin || '').toUpperCase()));
  m.addUint32(TAG.TAG_COUNTER, opts.counter);
  m.addUint32(TAG.TAG_FLAGS, opts.flags || 0);
  m.add(TAG.TAG_REQUEST_HASH, opts.requestId); // undefined 会被静默跳过
  m.addUint32(TAG.TAG_FAULT, opts.fault || 0);
  return m;
}

// ---------------------------------------------------------------- 握手

// 官方 SessionInfoRequest() 只写 to_destination.domain + session_info_request.public_key，
// 但 dispatcher.Send() 在打包前一定会补上随机 uuid 和 from_destination.routing_address
// （dispatcher.go:410-413），VCSEC 域的路由地址还是每条消息重新随机（:400-403）。
// 所以这里显式收 uuid / routingAddress，落地的字节和官方一致。
export function buildSessionInfoRequest(domain, publicKey, uuid, routingAddress) {
  const message = {
    to_destination: { domain },
    from_destination: { routing_address: routingAddress },
    session_info_request: { public_key: publicKey },
    uuid
  };
  return { message, bytes: encode(V3_SPEC, 'RoutableMessage', message) };
}

// 校验车辆回的上层 session_info。
// native.go SessionInfoHMAC：sigtype=HMAC(6) → VIN → challenge(= 我们请求里的 uuid) → 0xFF → session_info 原文
export function sessionInfoHmac(key, vin, challenge, encodedInfo) {
  const m = new Metadata();
  m.addByte(TAG.TAG_SIGNATURE_TYPE, SIGTYPE.SIGNATURE_TYPE_HMAC);
  m.add(TAG.TAG_PERSONALIZATION, utf8ToBytes(String(vin || '').toUpperCase()));
  m.add(TAG.TAG_CHALLENGE, challenge);
  return m.hmac(subkey(key, LABEL_SESSION_INFO), encodedInfo);
}

// 解 session_info 并核对 HMAC，成功后把会话参数写进 session。
// 返回 { ok, info, error }；失败时绝不污染已有会话（counter 只上调）。
export function applySessionInfo(session, opts) {
  const vin = String(opts.vin || '').toUpperCase();
  const encoded = opts.encodedInfo;
  const given = opts.tag;
  if (!session.key || session.key.length !== 16) return { ok: false, error: '还没有共享密钥，无法校验握手' };
  if (!encoded || !encoded.length) return { ok: false, error: '响应里没有 session_info' };
  if (!given || !given.length) return { ok: false, error: '响应里没有 session_info_tag' };

  const expect = sessionInfoHmac(session.key, vin, opts.challenge, encoded);
  if (!equalBytes(expect, given)) {
    return {
      ok: false,
      error: 'session_info HMAC 校验不通过（握手 tag 不符：VIN 不对 / 密钥不同 / 握手包被重放）\n  期望=' + toHex(expect) + '\n  实际=' + toHex(given),
      expect,
      given
    };
  }

  let info;
  try {
    info = decode(V3_SPEC, 'SessionInfo', encoded);
  } catch (e) {
    return { ok: false, error: 'session_info 不是合法 protobuf: ' + (e && e.message) };
  }
  const pk = info.publicKey;
  if (!(pk instanceof Uint8Array) || pk.length !== 65 || pk[0] !== 0x04) {
    return { ok: false, error: 'session_info.publicKey 格式意外（' + (pk ? pk.length + 'B 首字节 ' + pk[0] : '缺失') + '）' };
  }

  const epoch = info.epoch instanceof Uint8Array ? info.epoch : EMPTY;
  if (epoch.length !== ADDR_LEN) return { ok: false, error: 'session_info.epoch 长度应为 16，实际 ' + epoch.length };

  const clockTime = info.clock_time === undefined ? 0 : info.clock_time;
  // signer.go UpdateSessionInfo：epoch 变了，或车辆时钟没倒退，才接受新的会话参数
  const accept = toHex(epoch) !== toHex(session.epoch || EMPTY) || (session.setTime === undefined || session.setTime <= clockTime);
  if (!accept) {
    return { ok: false, error: '同一 epoch 且车辆时钟倒退（setTime=' + session.setTime + ' > clock_time=' + clockTime + '），忽略本次握手', info };
  }

  const counter = info.counter === undefined ? 0 : info.counter;
  session.epoch = epoch;
  session.vehiclePublicKey = pk;
  session.clockTime = clockTime;
  session.setTime = clockTime;
  // timeZero = epochStartTime(clock_time) = 握手时刻本地时间 - clock_time
  // 之后 expires_at = 本地秒 - timeZero + 生命周期
  session.anchor = localNow() - clockTime;
  session.counter = Math.max(session.counter || 0, counter);
  session.setAt = localNow();
  session.ready = info.status === undefined || info.status === 0;

  return {
    ok: true,
    info,
    status: info.status === undefined ? 0 : info.status,
    notWhitelisted: info.status === 1,
    text: 'counter=' + counter + ' clock_time=' + clockTime + ' epoch=' + toHex(epoch) +
      ' 车辆公钥=' + toHex(pk).slice(0, 16) + '… anchor(本地秒-clock)=' + session.anchor
  };
}

// ---------------------------------------------------------------- 组包

// 不需要会话的明文请求（InformationRequest 等，auth=None）
export function buildPlainRequest(opts) {
  const message = {
    to_destination: { domain: opts.domain },
    from_destination: { routing_address: opts.routingAddress },
    protobuf_message_as_bytes: opts.payload,
    uuid: opts.uuid
  };
  if (opts.flags > 0) message.flags = opts.flags;
  return { message, bytes: encode(V3_SPEC, 'RoutableMessage', message) };
}

// 加密一条命令（signer.go encryptWithCounter）。
// opts: { domain, vin, session, publicKey, payload, flags, expiresInSeconds, routingAddress, uuid, now }
// 返回里带上 aad/nonce/明文/密文/tag，方便报文控制台逐项核对。
export function encryptCommand(opts) {
  const session = opts.session;
  if (!session || !session.key || session.key.length !== 16) throw new Error('V3: 没有共享密钥，请先做 session_info 握手');
  if (!session.epoch || !session.epoch.length) throw new Error('V3: 没有 epoch，请先做 session_info 握手');
  if (session.anchor === undefined) throw new Error('V3: 没有时钟基准，请先做 session_info 握手');

  const counter = (session.counter || 0) + 1;
  // 0xFFFFFFFF 是官方保留的 counterMax 哨兵（crypto.go:18），永远不能发出去：
  // signer.go:171 在 counter 等于它就报错，所以最后一个可用值是 0xFFFFFFFE。
  if (counter >= 0xffffffff) throw new Error('V3: counter 到达上限（0xFFFFFFFF），必须重新绑定密钥');

  const now = typeof opts.now === 'number' ? opts.now : localNow();
  const expiresIn = opts.expiresInSeconds === undefined ? DEFAULT_EXPIRES_IN : opts.expiresInSeconds;
  const expiresAt = now - session.anchor + expiresIn;
  const flags = opts.flags || 0;

  const meta = requestMetadata({
    signatureType: SIGTYPE.SIGNATURE_TYPE_AES_GCM_PERSONALIZED,
    domain: opts.domain,
    vin: opts.vin,
    epoch: session.epoch,
    expiresAt,
    counter,
    flags
  });
  const aad = meta.sha256();

  const plaintext = opts.payload;
  // nonce 默认随机；只有自测时显式传入（Uint8Array）
  const nonce = opts.nonce ? opts.nonce : randomBytes(NONCE_LEN);
  const enc = aes128GcmEncrypt(session.key, nonce, plaintext, aad);

  const message = {
    to_destination: { domain: opts.domain },
    from_destination: { routing_address: opts.routingAddress },
    protobuf_message_as_bytes: enc.ciphertext,
    signature_data: {
      signer_identity: { public_key: opts.publicKey },
      AES_GCM_Personalized_data: {
        epoch: session.epoch,
        nonce,
        counter,
        expires_at: expiresAt,
        tag: enc.tag
      }
    },
    uuid: opts.uuid
  };
  if (flags > 0) message.flags = flags;

  // 官方 signer.go Encrypt() 是先 s.counter++ 再组包，发送失败也不回滚。
  // 这里等价：整帧组好才落地，上面任何一步抛错等于这号没发出去。
  // 重发（v3actions.sendRequest 的 attempt 循环）会重新调本函数 → counter 前进、
  // nonce 重取，只复用同一组 routingAddress / uuid，与官方行为一致。
  session.counter = counter;

  return {
    message,
    bytes: encode(V3_SPEC, 'RoutableMessage', message),
    tlv: meta.bytes(true),
    aad,
    plaintext,
    nonce,
    ciphertext: enc.ciphertext,
    tag: enc.tag,
    counter,
    expiresAt,
    flags
  };
}

// HMAC 认证但不加密（signer.go AuthorizeHMAC）——留给需要看明文 payloads 的场合
export function authorizeHmacCommand(opts) {
  const session = opts.session;
  const counter = (session.counter || 0) + 1;
  if (counter > 0xffffffff) throw new Error('V3: counter 溢出');
  const now = typeof opts.now === 'number' ? opts.now : localNow();
  const expiresIn = opts.expiresInSeconds === undefined ? DEFAULT_EXPIRES_IN : opts.expiresInSeconds;
  const expiresAt = now - session.anchor + expiresIn;
  const flags = opts.flags || 0;

  const message = {
    to_destination: { domain: opts.domain },
    from_destination: { routing_address: opts.routingAddress },
    protobuf_message_as_bytes: opts.payload,
    uuid: opts.uuid
  };
  if (flags > 0) message.flags = flags;

  const meta = requestMetadata({
    signatureType: SIGTYPE.SIGNATURE_TYPE_HMAC_PERSONALIZED,
    domain: opts.domain,
    vin: opts.vin,
    epoch: session.epoch,
    expiresAt,
    counter,
    flags
  });
  const tag = meta.hmac(subkey(session.key, LABEL_MESSAGE_AUTH), opts.payload);
  message.signature_data = {
    signer_identity: { public_key: opts.publicKey },
    HMAC_Personalized_data: { epoch: session.epoch, counter, expires_at: expiresAt, tag }
  };
  session.counter = counter;
  return { message, bytes: encode(V3_SPEC, 'RoutableMessage', message), tlv: meta.bytes(true), tag, counter, expiresAt };
}

// ---------------------------------------------------------------- 响应

// 请求 ID：用于把响应和请求对上，同时进响应 AAD（peer.go RequestID）
export function requestIdOf(rm) {
  const sd = rm && rm.signature_data;
  if (!sd) return null;
  if (sd.AES_GCM_Personalized_data && sd.AES_GCM_Personalized_data.tag) {
    return concatBytes([beBytes(SIGTYPE.SIGNATURE_TYPE_AES_GCM_PERSONALIZED, 1), sd.AES_GCM_Personalized_data.tag]);
  }
  if (sd.HMAC_Personalized_data && sd.HMAC_Personalized_data.tag) {
    let tag = sd.HMAC_Personalized_data.tag;
    const dom = rm.to_destination ? rm.to_destination.domain : undefined;
    if (dom === DOMAIN.DOMAIN_VEHICLE_SECURITY && tag.length > 16) tag = tag.subarray(0, 16);
    return concatBytes([beBytes(SIGTYPE.SIGNATURE_TYPE_HMAC_PERSONALIZED, 1), tag]);
  }
  return null;
}

// 解密 FLAG_ENCRYPT_RESPONSE 响应（signer.go Decrypt）。
// 返回 { ok, plaintext, counter, error }；tag 不符时不抛错，交调用方打日志。
export function decryptResponse(rm, opts) {
  const sd = rm && rm.signature_data;
  const rd = sd && sd.AES_GCM_Response_data;
  if (!rd) return { ok: false, error: '响应没有 AES_GCM_Response_data（车辆没启用响应加密）' };
  const ct = rm.protobuf_message_as_bytes;
  if (!ct || !ct.length) return { ok: false, error: '响应没有 payload' };

  const counter = rd.counter === undefined ? 0 : rd.counter;
  const meta = responseMetadata({
    domain: rm.from_destination ? rm.from_destination.domain : opts.domain,
    vin: opts.vin,
    counter,
    flags: rm.flags || 0,
    requestId: opts.requestId,
    fault: rm.signedMessageStatus ? rm.signedMessageStatus.signed_message_fault || 0 : 0
  });
  const aad = meta.sha256();
  const dec = aes128GcmDecrypt(opts.session.key, rd.nonce || EMPTY, ct, aad);
  const given = rd.tag || EMPTY;
  if (!equalBytes(dec.expectedTag, given)) {
    return {
      ok: false,
      error: '响应 GCM tag 不符（元数据或密钥对不上）\n  期望=' + toHex(dec.expectedTag) + '\n  实际=' + toHex(given),
      aad,
      tlv: meta.bytes(true)
    };
  }
  return { ok: true, plaintext: dec.plaintext, counter, aad, tlv: meta.bytes(true) };
}

// 帧分类：BLE 上可能同时出现 RoutableMessage（V3）和裸 FromVCSECMessage（加白名单那条老路）
export function parseFrame(body) {
  let rm = null;
  try {
    const obj = decode(V3_SPEC, 'RoutableMessage', body);
    const keys = Object.keys(obj);
    // 未知字段会被记成 f<n>；若全是 f* 说明这压根不是 RoutableMessage
    if (keys.length && keys.some((k) => k.charAt(0) !== 'f')) rm = obj;
  } catch (e) {
    rm = null;
  }
  if (rm) return { kind: 'routable', rm, text: inspect(V3_SPEC, 'RoutableMessage', rm) };
  let vcsec = null;
  let text = '';
  try {
    vcsec = decode(V3_SPEC, 'FromVCSECMessage', body);
    text = inspect(V3_SPEC, 'FromVCSECMessage', vcsec);
  } catch (e) {
    text = '(两种规格都解不出来) ' + toHex(body);
  }
  return { kind: 'vcsec', vcsec, text };
}

// ---------------------------------------------------------------- 摘要（UI 文案）

export function label(enumName, value) {
  if (value === undefined || value === null) return '(默认0)';
  const map = V3_SPEC.enums[enumName];
  if (!map) return String(value);
  for (const k of Object.keys(map)) {
    if (map[k] === value) return k + '(' + value + ')';
  }
  return '未知(' + value + ')';
}

function flagsText(flags) {
  const bits = [];
  if (flags & (1 << FLAGS.FLAG_USER_COMMAND)) bits.push('USER_COMMAND');
  if (flags & (1 << FLAGS.FLAG_ENCRYPT_RESPONSE)) bits.push('ENCRYPT_RESPONSE');
  return bits.length ? bits.join('|') : '0';
}

// 协议层（RoutableMessage）摘要
export function summarize(rm) {
  if (!rm) return { kind: 'none', text: '(空)' };
  if (rm.session_info_request) {
    const pk = rm.session_info_request.public_key;
    return { kind: 'handshakeRequest', text: 'session_info_request public_key=' + (pk ? pk.length + 'B' : '缺') + (rm.uuid ? ' uuid=' + toHex(rm.uuid) : '') };
  }
  if (rm.session_info) {
    const st = rm.session_info.status === undefined ? 0 : rm.session_info.status;
    const tag = rm.signature_data && rm.signature_data.session_info_tag ? rm.signature_data.session_info_tag.tag : null;
    return {
      kind: 'handshake',
      status: st,
      text: 'session_info ' + label('Session_Info_Status', st) +
        ' counter=' + (rm.session_info.counter === undefined ? 0 : rm.session_info.counter) +
        ' clock_time=' + (rm.session_info.clock_time === undefined ? 0 : rm.session_info.clock_time) +
        ' request_uuid=' + (rm.request_uuid ? toHex(rm.request_uuid) : '缺') +
        ' tag=' + (tag ? toHex(tag) : '缺')
    };
  }
  const fault = rm.signedMessageStatus ? rm.signedMessageStatus.signed_message_fault : undefined;
  const sd = rm.signature_data || {};
  const bits = [];
  if (fault !== undefined && fault !== 0) bits.push('fault=' + label('MessageFault_E', fault));
  if (rm.flags) bits.push('flags=' + flagsText(rm.flags));
  if (rm.protobuf_message_as_bytes) bits.push('payload=' + rm.protobuf_message_as_bytes.length + 'B');
  if (sd.AES_GCM_Response_data) bits.push('响应已加密 counter=' + (sd.AES_GCM_Response_data.counter === undefined ? 0 : sd.AES_GCM_Response_data.counter));
  if (sd.AES_GCM_Personalized_data) bits.push('请求 tag=' + toHex(sd.AES_GCM_Personalized_data.tag).slice(0, 16) + '…');
  return {
    kind: fault === undefined || fault === 0 ? 'message' : 'fault',
    fault: fault === undefined ? 0 : fault,
    text: 'RoutableMessage' + (bits.length ? ' ' + bits.join(' ') : ' (无 payload)')
  };
}

// 应用层（FromVCSECMessage）摘要，形状和旧版 summarize 保持一致，方便页面复用判断
export function summarizeVcsec(obj) {
  if (!obj) return { kind: 'empty', status: 0, text: '空响应（payload 为 0 字节 = 成功）' };
  const cs = obj.commandStatus;
  if (cs) {
    const st = cs.operationStatus === undefined ? 0 : cs.operationStatus;
    if (cs.whitelistOperationStatus) {
      const w = cs.whitelistOperationStatus;
      const signer = w.signerOfOperation && w.signerOfOperation.publicKeySHA1 ? toHex(w.signerOfOperation.publicKeySHA1) : '-';
      return {
        kind: 'whitelist',
        status: w.operationStatus === undefined ? st : w.operationStatus,
        info: w.whitelistOperationInformation === undefined ? 0 : w.whitelistOperationInformation,
        text: '白名单操作 status=' + label('VCOperationStatus_E', w.operationStatus) +
          ' info=' + label('WhitelistOperation_information_E', w.whitelistOperationInformation) + ' 签署者=' + signer
      };
    }
    if (cs.signedMessageStatus) {
      const s = cs.signedMessageStatus;
      return {
        kind: 'signed',
        status: st,
        info: s.signedMessageInformation === undefined ? 0 : s.signedMessageInformation,
        counter: s.counter,
        text: '签名报文 status=' + label('VCOperationStatus_E', st) +
          ' info=' + label('SignedMessage_information_E', s.signedMessageInformation) +
          (s.counter !== undefined ? ' 车辆期望 counter=' + s.counter : '')
      };
    }
    return { kind: 'command', status: st, text: 'status=' + label('VCOperationStatus_E', st) };
  }
  if (obj.nominalError) {
    return { kind: 'error', status: 2, text: 'nominalError ' + label('GenericError_E', obj.nominalError.genericError) };
  }
  if (obj.vehicleStatus) {
    return { kind: 'status', status: 0, text: '车辆状态 ' + inspect(V3_SPEC, 'VehicleStatus', obj.vehicleStatus) };
  }
  if (obj.whitelistInfo) {
    const list = (obj.whitelistInfo.whitelistEntries || []).map((e) => toHex(e.publicKeySHA1));
    return { kind: 'whitelistInfo', status: 0, text: '白名单条目数=' + (obj.whitelistInfo.numberOfEntries === undefined ? '?' : obj.whitelistInfo.numberOfEntries) + ' [' + list.join(' ') + ']' };
  }
  if (obj.whitelistEntryInfo) {
    const k = obj.whitelistEntryInfo.publicKey && obj.whitelistEntryInfo.publicKey.PublicKeyRaw;
    return {
      kind: 'whitelistEntry',
      status: 0,
      text: '条目 slot=' + obj.whitelistEntryInfo.slot + ' role=' + label('Role', obj.whitelistEntryInfo.keyRole) +
        ' 公钥=' + (k ? toHex(k) : '-')
    };
  }
  return { kind: 'other', status: 0, text: '(未识别) ' + inspect(V3_SPEC, 'FromVCSECMessage', obj) };
}

// ---------------------------------------------------------------- VCSEC 载荷

export function encodeUnsignedMessage(obj) {
  return encode(V3_SPEC, 'UnsignedMessage', obj);
}

export function decodeFromVcsec(bytes) {
  if (!bytes || !bytes.length) return { obj: {}, text: '(空 payload = 命令已受理)' };
  const obj = decode(V3_SPEC, 'FromVCSECMessage', bytes);
  return { obj, text: inspect(V3_SPEC, 'FromVCSECMessage', obj) };
}

// 加白名单的内层载荷：VCSEC.UnsignedMessage{WhitelistOperation{addKeyToWhitelistAndAddPermissions}}
// 对应官方 security.go addKeyPayload()。注意现行 proto 里已经没有 permission 数组，
// 权限改由 keyRole 表达（PermissionChange 只剩 key / secondsToBeActive / keyRole）。
export function buildAddKeyPayload(publicKey, role, formFactor) {
  return encode(V3_SPEC, 'UnsignedMessage', {
    WhitelistOperation: {
      addKeyToWhitelistAndAddPermissions: { key: { PublicKeyRaw: publicKey }, keyRole: role },
      metadataForKey: { keyFormFactor: formFactor }
    }
  });
}

// 加白名单：裸 ToVCSECMessage{signedMessage{PRESENT_KEY}}。
// 对应官方 security.go:338 SendAddKeyRequestWithRole —— 此刻还没有会话，
// 所以不走 RoutableMessage，直接把这个老式信封交给 BLE 层（首字节 0x0a 而不是 0x12）。
// 车辆会先回 operationStatus=WAIT 表示等刷卡，刷完再回 whitelistOperationStatus 终态。
export function buildAddKeyEnvelope(publicKey, role, formFactor) {
  const payload = buildAddKeyPayload(publicKey, role, formFactor);
  return encode(V3_SPEC, 'ToVCSECMessage', {
    signedMessage: { protobufMessageAsBytes: payload, signatureType: V3_SPEC.enums.VcsecSignatureType.SIGNATURE_TYPE_PRESENT_KEY }
  });
}

// 长度前缀属于传输层，与协议版本无关
function prependLength(msg) {
  return concatBytes([beBytes(msg.length, 2), msg]);
}

function stripLength(frame) {
  if (frame.length < 2) throw new Error('报文不足 2 字节');
  const expect = (frame[0] << 8) | frame[1];
  const body = frame.subarray(2);
  if (body.length !== expect) throw new Error('长度前缀不符: 声明 ' + expect + ' 实际 ' + body.length);
  return body;
}

export { toHex, equalBytes, inspect, encode, decode, V3_SPEC, prependLength, stripLength };
