// 探针的全局会话状态：密钥、V3 会话、BLE 实例、日志总线。
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
const V3_STORE = 'tesla_probe_v3_session_v1';

// 一轮完整绑定（60 秒等待 + 每帧 hex + 逐帧解码）就能产生上百条日志，
// 留 400 条会在复测中途把最早的关键日志滚掉 —— 放大到 1000。
const MAX_LOGS = 1000;

export const state = {
  vin: '',
  privateKey: null, // Uint8Array(32)
  publicKey: null, // Uint8Array(65)
  keyId: '', // hex(40) = SHA1(公钥)
  v3: null, // V3 会话（握手参数 + counter），见 v3Session()
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
  actionDepth = 0;
  actionName = '';
  emit({ kind: 'info', msg: '（日志已清空）', stamp: '' });
}

// 把一次动作产生的所有日志包成一段，复制出来能一眼看清是谁产生的。
// 形如：-----start----- 绑定（刷钥匙卡） …… -----end----- 绑定（刷钥匙卡） | 成功：…
// 嵌套调用（例如 sendRke 内部会 handshake）只算一段，不会到处插标记。
let actionDepth = 0;
let actionName = '';

export function beginAction(name) {
  actionDepth++;
  if (actionDepth > 1) return;
  actionName = String(name || '未命名动作');
  log('info', '-----start----- ' + actionName);
}

export function endAction(outcome) {
  if (actionDepth === 0) return;
  actionDepth--;
  if (actionDepth > 0) return;
  log('info', '-----end----- ' + actionName + (outcome ? ' | ' + outcome : ''));
  actionName = '';
}

// 页面动作的统一包装：自动写 start/end 分段，异常也保证收尾。
export async function action(name, fn) {
  beginAction(name);
  let outcome = '';
  try {
    const r = await fn();
    if (r && typeof r === 'object' && typeof r.ok === 'boolean') {
      const t = r.text ? String(r.text).replace(/\s+/g, ' ') : '';
      // 不截断：-----end----- 这一行常常是唯一带完整失败原因的日志行
      outcome = (r.ok ? '成功' : '失败') + (t ? '：' + t : '');
    }
    return r;
  } catch (e) {
    const code = e && e.errCode !== undefined ? ' errCode=' + e.errCode : '';
    outcome = '异常：' + (((e && e.message) || String(e)) + code);
    throw e;
  } finally {
    endAction(outcome);
  }
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
  state.v3 = null;
  store(KEY_STORE, null);
  store(V3_STORE, null);
  log('warn', '本机密钥与 V3 会话（含 counter）已清除（下次绑定需要重新刷卡）');
}

// ---------------------------------------------------------------- V3 会话
//
// epoch 变了也不回退 counter（protocol.md 明确要求），
// 因为车辆在新 epoch 下从 0 开始记，我们发大数只会「跳过」而不会被拒。

function freshV3Session() {
  return {
    key: null, // 本次连接 ECDH 出的 16 字节共享密钥，不落盘
    counter: 0,
    epoch: null, // Uint8Array(16)
    vehiclePublicKey: null, // Uint8Array(65)
    clockTime: 0,
    setTime: 0,
    anchor: undefined, // 本地秒 - 车辆秒
    setAt: 0,
    ready: false
  };
}

function v3ToDisk(s) {
  return {
    counter: s.counter || 0,
    epoch: s.epoch ? toHex(s.epoch) : '',
    vehiclePublicKey: s.vehiclePublicKey ? toHex(s.vehiclePublicKey) : '',
    clockTime: s.clockTime || 0,
    setTime: s.setTime || 0,
    anchor: s.anchor === undefined ? null : s.anchor,
    setAt: s.setAt || 0,
    ready: !!s.ready
  };
}

export function v3Session() {
  if (state.v3) return state.v3;
  const s = freshV3Session();
  const raw = read(V3_STORE);
  if (raw && typeof raw === 'object') {
    try {
      const saved = v3ToDisk(s);
      Object.assign(saved, raw);
      s.counter = typeof saved.counter === 'number' ? saved.counter : 0;
      s.epoch = saved.epoch ? fromHex(saved.epoch) : null;
      s.vehiclePublicKey = saved.vehiclePublicKey ? fromHex(saved.vehiclePublicKey) : null;
      s.clockTime = saved.clockTime;
      s.setTime = saved.setTime;
      s.anchor = saved.anchor === null || saved.anchor === undefined ? undefined : saved.anchor;
      s.setAt = saved.setAt;
      s.ready = !!saved.ready && !!s.epoch;
      if (s.counter > 0) log('info', '已恢复 V3 会话 counter=' + s.counter + (s.ready ? '（可复用，握手失败时再刷新）' : '（尚未握手）'));
    } catch (e) {
      log('error', 'V3 会话存储损坏: ' + (e && e.message));
      state.v3 = freshV3Session();
      return state.v3;
    }
  }
  state.v3 = s;
  return s;
}

export function storeV3Session() {
  if (!state.v3) return;
  store(V3_STORE, v3ToDisk(state.v3));
}

// 换连接 / 握手失效：只清掉本次连接才有效的共享密钥，counter 保留
export function invalidateV3Session(why) {
  if (!state.v3) return;
  if (state.v3.key) log('info', 'V3 共享密钥已作废' + (why ? '（' + why + '）' : ''));
  state.v3.key = null;
  state.v3.ready = false;
}

// 彻底重来（epoch 变了或用户主动清）：counter 也归零
export function resetV3Session() {
  state.v3 = freshV3Session();
  store(V3_STORE, v3ToDisk(state.v3));
  log('warn', 'V3 会话已重置（counter 归零，车辆侧需要重新同步）');
}

export function ensureKey(vin) {
  if (hasKey()) return { created: false };
  const kp = newKeyPair();
  saveKeyPair(kp, vin);
  return { created: true };
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
      if (connection.raw.length > 200) connection.raw.shift();
    }
  });
  return state.ble;
}

export const connection = { connection: 'idle', device: null, raw: [] };

export function namesForVin(vin) {
  return bleNamesForVin(vin || state.vin);
}

// device 传进来就直接连它（弹窗手选的结果），完全跳过按 VIN 匹配广播名那一步 ——
// 车辆蓝牙名被改过时只有这条路能走通。
export async function connectTo(vin, device) {
  const b = ble();
  await b.init();
  let dev = device;
  if (!dev) {
    const names = namesForVin(vin);
    if (!names.exact.length && !names.prefixes.length) throw new Error('请先填写 VIN（需要后 6 位才能匹配广播名），或在扫描列表里手选设备');
    dev = await b.scan(names, 20000);
    if (!dev) return null;
  }
  connection.device = dev;
  await b.connect(dev);
  invalidateV3Session('换了连接，共享密钥随本次会话失效'); // counter / epoch 保留，不回退
  return dev;
}

export async function disconnectAll() {
  if (state.ble) await state.ble.close();
  invalidateV3Session('断开连接');
  connection.device = null;
  connection.connection = 'idle';
}

export function describeKey() {
  if (!hasKey()) return '未生成密钥';
  const s = state.v3 || v3Session();
  return 'keyId=' + state.keyId + ' 公钥=' + toHex(state.publicKey).slice(0, 16) + '…' +
    ' V3counter=' + (s.counter || 0) +
    ' epoch=' + (s.epoch ? toHex(s.epoch).slice(0, 12) + '…' : '未握手') +
    ' 共享密钥=' + (s.key ? toHex(s.key) : '未协商');
}

export default state;
