// 本机密钥对的读写。
//
// 安全说明：私钥用 uni.setStorageSync 明文存在 App 沙箱里，属于「探针够用、
// 产品不可用」的做法。正式产品必须放进 Android Keystore / iOS Keychain。
//
// 「清除」的一半职责在这里：内存字段归零 + 删掉密钥键 + 让 v3-session-store 把它
// 自己那两份（内存 map 与两个域的落盘键）清掉；而「顺带清绑定档案 + 那条 warn 日志」
// 属于跨档案的组合动作，上移到 services/credential-service.js 的 forgetEverything()。

import { newKeyPair, keyIdOf } from '../protocol/index.js';
import { toHex, fromHex } from '../infra/bytes.js';
import { writeValue, readValue, removeValue } from '../infra/storage/local-store.js';
import { log } from '../infra/logging/log-bus.js';
import { KEY_STORE } from '../config/index.js';
import { state } from './app-state.js';
import { dropV3Memory, clearV3Disk, describeDomain, DOMAIN } from './v3-session-store.js';

export function hasKey() {
  return !!(state.privateKey && state.publicKey);
}

export function saveKeyPair(kp, vin) {
  state.privateKey = kp.privateKey;
  state.publicKey = kp.publicKey;
  state.keyId = toHex(keyIdOf(kp.publicKey));
  if (vin) state.vin = vin;
  writeValue(KEY_STORE, { priv: toHex(kp.privateKey), pub: toHex(kp.publicKey), vin: state.vin });
  log('ok', '私钥已保存到本机存储（明文沙箱，仅限探针） keyId=' + state.keyId);
}

export function loadKey() {
  const raw = readValue(KEY_STORE);
  if (!raw || !raw.priv) return false;
  try {
    state.privateKey = fromHex(raw.priv);
    state.publicKey = raw.pub ? fromHex(raw.pub) : null;
    state.keyId = state.publicKey ? toHex(keyIdOf(state.publicKey)) : '';
    state.vin = raw.vin || state.vin;
    log('info', '已加载本机密钥 keyId=' + state.keyId);
    return true;
  } catch (e) {
    log('error', '密钥存储损坏: ' + (e && e.message));
    return false;
  }
}

export function ensureKey(vin) {
  if (hasKey()) return { created: false };
  const kp = newKeyPair();
  saveKeyPair(kp, vin);
  return { created: true };
}

export function clearKeys() {
  state.privateKey = null;
  state.publicKey = null;
  state.keyId = '';
  dropV3Memory();
  removeValue(KEY_STORE);
  clearV3Disk();
}

export function describeKey() {
  if (!hasKey()) return '未生成密钥';
  return 'keyId=' + state.keyId + ' 公钥=' + toHex(state.publicKey).slice(0, 16) + '…' +
    ' | ' + describeDomain(DOMAIN.DOMAIN_VEHICLE_SECURITY) +
    ' | ' + describeDomain(DOMAIN.DOMAIN_INFOTAINMENT);
}
