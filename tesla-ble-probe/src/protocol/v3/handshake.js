// V3 握手：共享密钥派生、session_info_request / session_info 的组包与校验。
//
// 权威依据（teslamotors/vehicle-command main 分支）：
//   internal/authentication/{native,peer}.go  —— K = SHA1(ECDH)[:16]、子密钥、session_info HMAC
//   internal/dispatcher/{dispatcher,signer}.go —— 握手报文编排、UpdateSessionInfo 的接受条件

import { V3_SPEC } from './spec.js';
import { encode, decode } from '../pb.js';
import { toHex, equalBytes, utf8ToBytes } from '../../infra/bytes.js';
import { hmacSha256 } from '../../infra/crypto/sha256.js';
import { deriveSharedSecret } from '../../infra/crypto/p256.js';
import { sha1 } from '../../infra/crypto/sha1.js';
import { Metadata } from './metadata.js';
import { TAG, SIGTYPE, ADDR_LEN, LABEL_SESSION_INFO, localNow } from './constants.js';

const EMPTY = new Uint8Array(0);

// ---------------------------------------------------------------- 共享密钥

// K = SHA1(ECDH(C, V).X)[:16]（native.go Exchange；与旧版算法一致，只是来源换成握手响应）
export function sharedKeyOf(privateKey, vehiclePublicKey) {
  return sha1(deriveSharedSecret(privateKey, vehiclePublicKey)).subarray(0, 16);
}

// 子密钥 = HMAC-SHA256(K, label)
export function subkey(key, label) {
  return hmacSha256(key, utf8ToBytes(label));
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
