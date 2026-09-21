// 探针的全局会话状态：密钥、counter、共享密钥、BLE 实例、日志总线。
//
// 为什么 counter 一定要落盘：车辆侧记录「上次用过的 counter」，
// 一旦我们重启 App 后从 1 重来，AES-GCM 的 nonce 被重复使用，
// 车辆会直接回 FAULT_IV_SMALLER_THAN_EXPECTED / TOKEN_AND_COUNTER_INVALID，
// 而且这个洞对同一把 key 是永久的 —— 只能重新绑定。所以 counter 只增不减。
//
// 安全说明：私钥用 uni.setStorageSync 明文存在 App 沙箱里，属于「探针够用、
// 产品不可用」的做法。正式产品必须放进 Android Keystore / iOS Keychain。

import { TeslaBle } from './tesla-ble.js';
import { newKeyPair, keyIdOf, bleNamesForVin } from './vcsec.js';
import { toHex, fromHex } from './bytes.js';

const KEY_STORE = 'tesla_probe_key_v1';
const CT_STORE = 'tesla_probe_counter_v1';

const MAX_LOGS = 400;

export const state = {
  vin: '',
  privateKey: null, // Uint8Array(32)
  publicKey: null, // Uint8Array(65)
  keyId: '', // hex(8)
  counter: 0,
  sharedKey: null, // 每次连接重新协商，不落盘
  ephemeral: '',
  ble: null
};

const listeners = [];
const logs = [];

export function subscribe(cb) {
  if (listeners.indexOf(cb) < 0) listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function emit(entry) {
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  for (const cb of listeners.slice()) {
    try {
      cb(entry, logs);
    } catch (e) {
      /* 页面销毁之类的错误不许冒泡到 BLE 回调 */
    }
  }
}

export function log(kind, msg) {
  const t = new Date();
  const stamp = String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0') + '.' + String(t.getMilliseconds()).padStart(3, '0');
  emit({ kind, msg: String(msg), stamp });
}

export function getLogs() {
  return logs.slice();
}

export function clearLogs() {
  logs.length = 0;
  emit({ kind: 'info', msg: '（日志已清空）', stamp: '' });
}

// ---------------------------------------------------------------- 存储

function store(key, value) {
  if (typeof uni === 'undefined' || !uni.setStorageSync) return;
  uni.setStorageSync(key, value);
}

function read(key) {
  if (typeof uni === 'undefined' || !uni.getStorageSync) return null;
  const v = uni.getStorageSync(key);
  return v === '' || v === undefined ? null : v;
}

export function hasKey() {
  return !!(state.privateKey && state.publicKey);
}

export function saveKeyPair(kp, vin) {
  state.privateKey = kp.privateKey;
  state.publicKey = kp.publicKey;
  state.keyId = toHex(keyIdOf(kp.publicKey));
  if (vin) state.vin = vin;
  store(KEY_STORE, { priv: toHex(kp.privateKey), pub: toHex(kp.publicKey), vin: state.vin });
  log('ok', '私钥已保存到本机存储（明文沙箱，仅限探针） keyId=' + state.keyId);
}

export function loadKey() {
  const raw = read(KEY_STORE);
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

export function forgetKey() {
  state.privateKey = null;
  state.publicKey = null;
  state.keyId = '';
  state.sharedKey = null;
  state.counter = 0;
  store(KEY_STORE, null);
  store(CT_STORE, null);
  log('warn', '本机密钥与 counter 已清除（下次绑定需要重新刷卡）');
}

export function ensureKey(vin) {
  if (hasKey()) return { created: false };
  const kp = newKeyPair();
  saveKeyPair(kp, vin);
  return { created: true };
}

export function getCounter() {
  if (state.counter > 0) return state.counter;
  const v = read(CT_STORE);
  state.counter = typeof v === 'number' ? v : 0;
  return state.counter;
}

export function nextCounter() {
  const c = getCounter() + 1;
  state.counter = c;
  store(CT_STORE, c);
  return c;
}

// 车辆有时会在响应里告诉我们它期望的 counter，用来纠偏（只上调，不下调）
export function syncCounter(expected) {
  if (typeof expected !== 'number' || !isFinite(expected)) return;
  if (expected > getCounter()) {
    state.counter = expected;
    store(CT_STORE, expected);
    log('warn', '按车辆提示把 counter 抬到 ' + expected);
  }
}

// ---------------------------------------------------------------- BLE 生命周期

export function ble() {
  if (state.ble) return state.ble;
  state.ble = new TeslaBle({
    log: (kind, msg) => log(kind, msg),
    state: (s) => {
      connection.connection = s;
      emit({ kind: 'state', msg: s, stamp: '' });
    },
    raw: (dir, bytes) => {
      connection.raw.push({ dir, hex: toHex(bytes), at: Date.now() });
      if (connection.raw.length > 60) connection.raw.shift();
    }
  });
  return state.ble;
}

export const connection = { connection: 'idle', device: null, raw: [] };

export function namesForVin(vin) {
  return bleNamesForVin(vin || state.vin);
}

export async function connectTo(vin) {
  const b = ble();
  await b.init();
  const names = namesForVin(vin);
  if (!names.exact.length && !names.prefixes.length) throw new Error('请先填写 VIN（需要后 6 位才能匹配广播名）');
  const device = await b.scan(names, 20000);
  if (!device) return null;
  connection.device = device;
  await b.connect(device);
  state.sharedKey = null; // 换连接必须重新协商临时公钥
  return device;
}

export async function disconnectAll() {
  if (state.ble) await state.ble.close();
  state.sharedKey = null;
  connection.device = null;
  connection.connection = 'idle';
}

export function describeKey() {
  if (!hasKey()) return '未生成密钥';
  return 'keyId=' + state.keyId + ' 公钥=' + toHex(state.publicKey).slice(0, 16) + '…' +
    ' counter=' + getCounter() + ' 共享密钥=' + (state.sharedKey ? toHex(state.sharedKey) : '未协商');
}

export default state;
