// Tesla VCSEC 报文层：密钥、白名单绑定、临时公钥、RKE（上锁/解锁）
//
// 流程（权威依据：teslabtapi docs/start + docs/more/rke）：
//   1) 生成 P-256 私钥 -> 65 字节未压缩公钥（0x04||X||Y）
//   2) 发「addKeyToWhitelistAndAddPermissions」，signatureType=PRESENT_KEY（不加密），
//      车辆先回 OPERATIONSTATUS_WAIT，车主刷钥匙卡后回 whitelistOperationStatus=OK
//   3) 发「InformationRequest GET_EPHEMERAL_PUBLIC_KEY」（顶层 unsignedMessage，不加密）
//      -> 车辆回 sessionInfo.publicKey（65 字节）
//   4) sharedKey = SHA1(ECDH(我方私钥, 车辆临时公钥))[:16]
//   5) RKE：UnsignedMessage{RKEAction} --AES-128-GCM(key=sharedKey, nonce=counter 大端 4 字节)-->
//      SignedMessage{protobufMessageAsBytes=密文, counter, signature=tag, keyId}
//   6) 所有报文前面加 2 字节大端长度；收到的前两字节同样是长度
//
// 注意 proto3 语义：RKE_ACTION_UNLOCK = 0，编码时会被省略，于是 UnsignedMessage 为空串，
// 这正是官方 App / 社区实现发出的内容，车辆按默认值 0 解释。

import { SPEC } from './spec.js';
import { encode, decode, inspect } from './pb.js';
import { sha1 } from './sha1.js';
import { aes128GcmEncrypt, randomBytes } from './aes.js';
import { publicKeyFromPrivate, deriveSharedSecret, normalizePrivateKey } from './p256.js';
import { concatBytes, beBytes, toHex, equalBytes, utf8ToBytes } from './bytes.js';

export const GATT = {
  service: '00000211-b2d1-43f0-9b88-960cebf8b91e',
  write: '00000212-b2d1-43f0-9b88-960cebf8b91e',
  indicate: '00000213-b2d1-43f0-9b88-960cebf8b91e',
  version: '00000214-b2d1-43f0-9b88-960cebf8b91e'
};

// 车辆 BLE 广播名：新 = "Tesla " + VIN 后 6 位；旧 = "S" + SHA1(VIN)hex 前 16 位 + [C|R|D|P]
export function bleNamesForVin(vin) {
  const v = String(vin || '').trim().toUpperCase();
  const out = { exact: [], prefixes: [] };
  if (v.length >= 6) out.exact.push('Tesla ' + v.slice(-6));
  if (v.length) out.prefixes.push('S' + toHex(sha1(utf8ToBytes(v))).slice(0, 16)); // 末位 C/R/D/P 未知
  return out;
}

export function prependLength(msg) {
  return concatBytes([beBytes(msg.length, 2), msg]);
}

// 剥掉 2 字节长度前缀并校验
export function stripLength(frame) {
  if (frame.length < 2) throw new Error('报文不足 2 字节');
  const expect = (frame[0] << 8) | frame[1];
  const body = frame.subarray(2);
  if (body.length !== expect) {
    throw new Error('长度前缀不符: 声明 ' + expect + ' 实际 ' + body.length);
  }
  return body;
}

// ------------------------------------------------------------ 密钥

export function newKeyPair() {
  const privateKey = normalizePrivateKey(randomBytes(32));
  return { privateKey, publicKey: publicKeyFromPrivate(privateKey) };
}

export function keyIdOf(publicKey) {
  return sha1(publicKey).subarray(0, 4); // 只取前 4 字节
}

export function sharedKeyOf(privateKey, ephemeralPublicKey) {
  return sha1(deriveSharedSecret(privateKey, ephemeralPublicKey)).subarray(0, 16);
}

// ------------------------------------------------------------ 组包

// 步骤 2：把公钥加进白名单（需要车主刷钥匙卡）
export function buildWhitelistFrame(publicKey, formFactor) {
  const unsigned = encode(SPEC, 'UnsignedMessage', {
    WhitelistOperation: {
      addKeyToWhitelistAndAddPermissions: {
        key: { PublicKeyRaw: publicKey },
        permission: [
          SPEC.enums.WhitelistKeyPermission_E.WHITELISTKEYPERMISSION_LOCAL_DRIVE,
          SPEC.enums.WhitelistKeyPermission_E.WHITELISTKEYPERMISSION_LOCAL_UNLOCK,
          SPEC.enums.WhitelistKeyPermission_E.WHITELISTKEYPERMISSION_REMOTE_DRIVE,
          SPEC.enums.WhitelistKeyPermission_E.WHITELISTKEYPERMISSION_REMOTE_UNLOCK
        ]
      },
      metadataForKey: { keyFormFactor: formFactor }
    }
  });
  return prependLength(encode(SPEC, 'ToVCSECMessage', {
    signedMessage: { protobufMessageAsBytes: unsigned, signatureType: SPEC.enums.SignatureType.SIGNATURE_TYPE_PRESENT_KEY }
  }));
}

// 步骤 3：索要车辆临时公钥
export function buildEphemeralRequestFrame(publicKey) {
  return prependLength(encode(SPEC, 'ToVCSECMessage', {
    unsignedMessage: {
      InformationRequest: {
        informationRequestType: SPEC.enums.InformationRequestType.INFORMATION_REQUEST_TYPE_GET_EPHEMERAL_PUBLIC_KEY,
        keyId: { publicKeySHA1: keyIdOf(publicKey) }
      }
    }
  }));
}

// 任意 InformationRequest（探针用：查白名单、查车辆信息等）
export function buildInfoRequestFrame(type, publicKey) {
  const ir = { informationRequestType: type };
  if (publicKey) ir.keyId = { publicKeySHA1: keyIdOf(publicKey) };
  return prependLength(encode(SPEC, 'ToVCSECMessage', {
    unsignedMessage: { InformationRequest: ir }
  }));
}

// 步骤 5：RKE（解锁=0 / 上锁=1）
export function buildRkeFrame(publicKey, sharedKey, counter, action) {
  const inner = encode(SPEC, 'UnsignedMessage', { RKEAction: action });
  const nonce = beBytes(counter, 4); // 特斯拉的 nonce 就是 4 字节大端 counter
  const enc = aes128GcmEncrypt(sharedKey, nonce, inner, new Uint8Array(0));
  const frame = prependLength(encode(SPEC, 'ToVCSECMessage', {
    signedMessage: {
      protobufMessageAsBytes: enc.ciphertext,
      counter: counter,
      signature: enc.tag,
      keyId: keyIdOf(publicKey)
    }
  }));
  return { frame, inner, nonce, tag: enc.tag };
}

// ------------------------------------------------------------ 解包

// 输入：不带长度前缀的 FromVCSECMessage 字节
export function decodeResponse(body) {
  const obj = decode(SPEC, 'FromVCSECMessage', body);
  return { obj, text: inspect(SPEC, 'FromVCSECMessage', obj) };
}

// 从响应里取车辆临时公钥
export function ephemeralKeyFromResponse(obj) {
  if (obj && obj.sessionInfo && obj.sessionInfo.publicKey instanceof Uint8Array) {
    return obj.sessionInfo.publicKey;
  }
  return null;
}

// 响应摘要（决定 UI 上的状态文字）
export function summarize(obj) {
  const cs = obj && obj.commandStatus;
  if (cs) {
    const st = cs.operationStatus;
    if (cs.whitelistOperationStatus) {
      const w = cs.whitelistOperationStatus;
      const signer = w.signerOfOperation && w.signerOfOperation.publicKeySHA1
        ? toHex(w.signerOfOperation.publicKeySHA1) : '-';
      return {
        kind: 'whitelist',
        status: st === undefined ? 0 : st,
        info: w.whitelistOperationInformation === undefined ? 0 : w.whitelistOperationInformation,
        text: '白名单操作 status=' + label('OperationStatus_E', st) + ' info=' + label('WhitelistOperation_information_E', w.whitelistOperationInformation) + ' 签署者=' + signer
      };
    }
    if (cs.signedMessageStatus) {
      const s = cs.signedMessageStatus;
      return {
        kind: 'signed',
        status: st === undefined ? 0 : st,
        info: s.signedMessageInformation === undefined ? 0 : s.signedMessageInformation,
        counter: s.counter,
        text: '签名报文 status=' + label('OperationStatus_E', st) + ' info=' + label('SignedMessage_information_E', s.signedMessageInformation) + (s.counter !== undefined ? ' 车辆期望 counter=' + s.counter : '')
      };
    }
    return { kind: 'command', status: st === undefined ? 0 : st, text: 'status=' + label('OperationStatus_E', st) };
  }
  if (obj && obj.sessionInfo) {
    const pk = obj.sessionInfo.publicKey;
    return { kind: 'session', text: 'sessionInfo publicKey=' + (pk ? toHex(pk).slice(0, 16) + '...(' + pk.length + 'B)' : '无') + (obj.sessionInfo.counter !== undefined ? ' counter=' + obj.sessionInfo.counter : '') };
  }
  if (obj && obj.vehicleStatus) {
    return { kind: 'status', text: '车辆状态 ' + inspect(SPEC, 'VehicleStatus', obj.vehicleStatus) };
  }
  if (obj && obj.whitelistInfo) {
    const n = obj.whitelistInfo.numberOfEntries;
    const list = (obj.whitelistInfo.whitelistEntries || []).map((e) => toHex(e.publicKeySHA1));
    return { kind: 'whitelistInfo', text: '白名单条目数=' + (n === undefined ? '?' : n) + ' [' + list.join(' ') + ']' };
  }
  if (obj && obj.vehicleInfo) return { kind: 'vehicleInfo', text: 'VIN=' + obj.vehicleInfo.VIN };
  if (obj && obj.authenticationRequest) {
    return { kind: 'authRequest', text: 'authenticationRequest ' + inspect(SPEC, 'AuthenticationRequest', obj.authenticationRequest) };
  }
  return { kind: 'other', text: '(未识别) ' + inspect(SPEC, 'FromVCSECMessage', obj || {}) };
}

export function label(enumName, value) {
  if (value === undefined || value === null) return '(默认0)';
  const map = SPEC.enums[enumName];
  if (!map) return String(value);
  for (const k of Object.keys(map)) {
    if (map[k] === value) return k + '(' + value + ')';
  }
  return '未知(' + value + ')';
}

export { toHex, equalBytes, inspect, SPEC, encode, decode };
