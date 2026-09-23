// Tesla VCSEC 的「公共底座」：BLE 特征值、广播名规则、2 字节长度前缀、P-256 密钥对。
//
// 这里只留与协议版本无关的工具，报文本身全部在 common/v3vcsec.js + common/v3spec.js。
// （旧版「VCSEC 直连 + counter 当 nonce」那一套已经删除，车辆固件只认 V3 了。）

import { encode, decode, inspect } from './pb.js';
import { sha1 } from './sha1.js';
import { randomBytes } from './aes.js';
import { publicKeyFromPrivate, normalizePrivateKey } from './p256.js';
import { concatBytes, beBytes, toHex, equalBytes, utf8ToBytes } from './bytes.js';

export const GATT = {
  service: '00000211-b2d1-43f0-9b88-960cebf8b91e',
  write: '00000212-b2d1-43f0-9b88-960cebf8b91e',
  indicate: '00000213-b2d1-43f0-9b88-960cebf8b91e',
  version: '00000214-b2d1-43f0-9b88-960cebf8b91e'
};

// 车辆 BLE 广播名：新 = "Tesla " + VIN 后 6 位；旧 = "S" + SHA1(VIN)hex 前 16 位 + [C|R|D|P]
// 注意车主打过蓝牙名的话两条都不成立，只能走「扫描列表里手选设备」。
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

export function newKeyPair() {
  const privateKey = normalizePrivateKey(randomBytes(32));
  return { privateKey, publicKey: publicKeyFromPrivate(privateKey) };
}

// 钥匙 ID = SHA1(公钥)，V3 用完整 20 字节。
// 实测车辆 GET_WHITELIST_INFO 回的条目只带前 4 字节，比对时要按前缀归一
// （见 v3actions.js:keyIdMatches），这里不再截断。
export function keyIdOf(publicKey) {
  return sha1(publicKey);
}

export { toHex, equalBytes, inspect, encode, decode };
