// 本机钥匙身份：P-256 密钥对、钥匙 ID（SHA1(公钥)）、车辆 BLE 广播名规则。
//
// 与协议版本无关，所以放在 protocol 根下而不是 v3/。
// GATT 特征值在 infra/ble/gatt.js，2 字节长度前缀在 infra/ble/frame-codec.js，这里不再重复定义。

import { sha1 } from '../infra/crypto/sha1.js';
import { randomBytes } from '../infra/crypto/aes.js';
import { publicKeyFromPrivate, normalizePrivateKey } from '../infra/crypto/p256.js';
import { toHex, utf8ToBytes } from '../infra/bytes.js';

// 车辆 BLE 广播名：新 = "Tesla " + VIN 后 6 位；旧 = "S" + SHA1(VIN)hex 前 16 位 + [C|R|D|P]
// 注意车主打过蓝牙名的话两条都不成立，只能走「扫描列表里手选设备」。
export function bleNamesForVin(vin) {
  const v = String(vin || '').trim().toUpperCase();
  const out = { exact: [], prefixes: [] };
  if (v.length >= 6) out.exact.push('Tesla ' + v.slice(-6));
  if (v.length) out.prefixes.push('S' + toHex(sha1(utf8ToBytes(v))).slice(0, 16)); // 末位 C/R/D/P 未知
  return out;
}

export function newKeyPair() {
  const privateKey = normalizePrivateKey(randomBytes(32));
  return { privateKey, publicKey: publicKeyFromPrivate(privateKey) };
}

// 钥匙 ID = SHA1(公钥)，V3 用完整 20 字节。
// 实测车辆 GET_WHITELIST_INFO 回的条目只带前 4 字节，比对时要按前缀归一
// （见 src/domain/v3-context.js:keyIdMatches），这里不再截断。
export function keyIdOf(publicKey) {
  return sha1(publicKey);
}
