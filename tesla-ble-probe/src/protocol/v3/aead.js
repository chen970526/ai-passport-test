// V3 组包与加解密：明文请求、AES-GCM 命令、HMAC 认证命令、请求 ID、响应解密。
//
// 权威依据（teslamotors/vehicle-command main 分支）：
//   internal/authentication/signer.go —— Encrypt / AuthorizeHMAC / Decrypt
//   internal/authentication/peer.go   —— RequestID、响应 AAD 里的 domain 字节

import { V3_SPEC } from './spec.js';
import { encode } from '../pb.js';
import { concatBytes, beBytes, toHex, equalBytes } from '../../infra/bytes.js';
import { aes128GcmEncrypt, aes128GcmDecrypt, randomBytes } from '../../infra/crypto/aes.js';
import { requestMetadata, responseMetadata } from './metadata.js';
import { subkey } from './handshake.js';
import { DOMAIN, SIGTYPE, DEFAULT_EXPIRES_IN, NONCE_LEN, LABEL_MESSAGE_AUTH, localNow } from './constants.js';

const EMPTY = new Uint8Array(0);

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
  // 谁会被调用第二次，由 src/domain/command-dispatcher.js 决定：
  //   VCSEC —— 每次重发都重新调本函数（counter 前进、nonce 重取，路由地址 / uuid 也换新一组），
  //     因为 protocol.md:547-549 要求 VCSEC 侧消息按 counter 顺序到达，重复 counter 会被判
  //     REPEATED_COUNTER 丢掉；
  //   INFOTAINMENT —— 重发复用同一份已编码字节，不再进本函数（官方 dispatcher.go:434-460 的
  //     传输层重试语义，也保住车机对第一次请求的迟到回包还能解得开）。
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

// 响应帧的 domain 字节：peer.go:108 是 `byte(message.GetFromDestination().GetDomain())`。
// Go 的 getter 对 nil 安全 —— from_destination 整个缺失、或只带 routing_address 没带 domain，
// 结果都是 0（DOMAIN_BROADCAST）。车辆算响应 AAD 用的是它自己写进 from_destination 的那个字节，
// 所以这里不能回退成「请求的域」，只能照官方一样当成 0。
export function responseDomainByte(rm) {
  const d = rm && rm.from_destination ? rm.from_destination.domain : undefined;
  return d === undefined || d === null ? 0 : d & 0xff;
}

// 解密 FLAG_ENCRYPT_RESPONSE 响应（signer.go:219-242 Decrypt）。
// 返回 { ok, plaintext, counter, error, detail }；tag 不符时不抛错，交调用方打日志。
//
// tag 不符只可能是「响应侧独有的那几个字段」或密钥/密文对不上（请求侧能被车辆验通，
// 说明 K、VIN、epoch 这些两边共用的东西是对的）。所以失败时顺手做逐字段试算：
// 把某一个字段换成另一种取法能解开，根因就是它。
// 命中只写进诊断文案，绝不静默采纳错误的元数据 —— 猜出来的 AAD 解开的明文不是协议允许的读法。
// 另外：诊断里绝不出现会话密钥（ref-repos/tesla-key-esp32/.agents/rules/ble-tesla-protocol.md 的安全红线）。
export function decryptResponse(rm, opts) {
  const sd = rm && rm.signature_data;
  const rd = sd && sd.AES_GCM_Response_data;
  if (!rd) return { ok: false, error: '响应没有 AES_GCM_Response_data（车辆没启用响应加密）' };
  const counter = rd.counter === undefined ? 0 : rd.counter;
  // 空 payload 不是错误：RoutableMessage.payload 是 oneof
  // （protobuf/universal_message.proto:87-91 protobuf_message_as_bytes=10 / session_info_request=14 / session_info=15），
  // 车辆回一帧「只有 AES_GCM_Response_data、没有 payload」的受理帧是合法组合。
  // 官方 signer.go:219-242 Decrypt 也没有任何「payload 为空就报错」的前置检查 ——
  // 它把 GetProtobufMessageAsBytes()（可以是 nil）直接当密文交给 AES-GCM，空密文照样验 tag。
  const ct = rm.protobuf_message_as_bytes || EMPTY;
  const nonce = rd.nonce || EMPTY;
  const given = rd.tag || EMPTY;
  const key = opts.session.key;
  const fields = {
    domain: responseDomainByte(rm),
    vin: opts.vin,
    counter,
    flags: rm.flags || 0,
    requestId: opts.requestId,
    fault: rm.signedMessageStatus ? rm.signedMessageStatus.signed_message_fault || 0 : 0
  };

  // 用一组元数据算 AAD 并验 tag
  const verify = (f, k) => {
    const meta = responseMetadata({
      domain: f.domain,
      vin: f.vin,
      counter: f.counter,
      flags: f.flags,
      requestId: f.requestId,
      fault: f.fault
    });
    const aad = meta.sha256();
    const dec = aes128GcmDecrypt(k, nonce, ct, aad);
    return { ok: equalBytes(dec.expectedTag, given), expected: dec.expectedTag, aad, tlv: meta.bytes(true), plaintext: dec.plaintext };
  };

  const hit = verify(fields, key);
  if (hit.ok) return { ok: true, plaintext: hit.plaintext, counter, aad: hit.aad, tlv: hit.tlv };

  // ---- 逐字段试算：每一项都只偏离官方口径一处
  const variants = [];
  const tryVariant = (name, patch, k) => variants.push({ name, res: verify(Object.assign({}, fields, patch), k === undefined ? key : k) });
  if (opts.domain !== undefined && opts.domain !== null) {
    tryVariant('domain 用请求的域 ' + opts.domain + '（车辆没带 from_destination 时的老做法）', { domain: opts.domain });
  }
  tryVariant('不带 request_hash', { requestId: null });
  tryVariant('flags 按 0', { flags: 0 });
  tryVariant('fault 按 0', { fault: 0 });
  tryVariant('counter 按 0', { counter: 0 });
  for (const p of opts.previousRequestIds || []) {
    tryVariant('request_hash 换成更早那次请求（' + p.name + '）', { requestId: p.id });
  }
  for (const a of opts.altKeys || []) {
    if (a.key && !equalBytes(a.key, key)) tryVariant(a.name + ' 的会话密钥', {}, a.key);
  }
  const matched = variants.filter((v) => v.res.ok).map((v) => v.name);

  const dump = [
    'domain=' + fields.domain + (rm.from_destination ? '（响应的 from_destination）' : '（响应没有 from_destination，按官方取 0）'),
    'counter=' + fields.counter,
    'flags=0x' + (fields.flags >>> 0).toString(16),
    'fault=' + fields.fault,
    'request_hash=' + (fields.requestId ? fields.requestId.length + 'B ' + toHex(fields.requestId) : '缺'),
    'VIN=' + String(opts.vin || '').toUpperCase(),
    'nonce=' + toHex(nonce),
    '密文=' + ct.length + 'B'
  ].join(' ');
  const why = matched.length
    ? '换 [' + matched.join(' / ') + '] 就能对上 → 根因是这个字段'
    : (variants.length ? '以上单字段全试完都对不上 → 密文被截断或会话密钥不对' : '单字段试算未命中');
  return {
    ok: false,
    error: '响应 GCM tag 不符（元数据或密钥对不上）\n  期望=' + toHex(hit.expected) + '\n  实际=' + toHex(given) +
      '\n  ' + dump + '\n  ' + why,
    detail: 'AAD(TLV)=' + toHex(hit.tlv) + '\n  AAD=SHA256(上面这段 ‖ 0xFF)',
    aad: hit.aad,
    tlv: hit.tlv
  };
}
