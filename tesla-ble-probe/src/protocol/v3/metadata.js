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
// 本文件只做协议，不碰 BLE、不碰存储；会话状态由调用方（src/domain/）持有。
//
// —— 以上是整个 V3 协议层的总述；
//    本文件负责其中的「TLV 元数据」：Metadata / requestMetadata / responseMetadata。

import { sha256, hmacSha256 } from '../../infra/crypto/sha256.js';
import { concatBytes, beBytes, utf8ToBytes } from '../../infra/bytes.js';
import { TAG, SIGTYPE, MAX_EPOCH_SECONDS } from './constants.js';

const END_TAG = new Uint8Array([TAG.TAG_END]);

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
