// BLE 生命周期与连接编排：现在连着谁、连上之后记什么档、断开时作废哪些会话。
//
// 「连上了要退回最低退避档」「链路断了要立刻重新武装一轮」是自动重连模块的私有状态，
// 本模块不许直接 import 它（会成环）—— 由 domain/auto-reconnect.js 在模块加载时
// 用 setConnectionHooks() 把这三个动作登记进来，依赖方向恒为 auto-reconnect → 本模块。

import { BleTransport } from '../infra/ble/ble-transport.js';
import { toHex } from '../infra/bytes.js';
import { bleNamesForVin } from '../protocol/index.js';
import { log, emit } from '../infra/logging/log-bus.js';
import { state } from '../store/app-state.js';
import { invalidateAllV3Sessions } from '../store/v3-session-store.js';
import { bind, saveBind } from '../store/bind-profile.js';
import { RECENT_RAW_MAX, SCAN_TIMEOUT_MS } from '../config/index.js';

export const connection = { connection: 'idle', device: null, raw: [] };

let hooks = null;

export function setConnectionHooks(next) {
  hooks = next;
}

export function ble() {
  if (state.ble) return state.ble;
  state.ble = new BleTransport({
    log: (kind, msg) => log(kind, msg),
    state: (s) => {
      connection.connection = s;
      emit({ kind: 'state', msg: s, stamp: '' });
      // 链路真断了（车辆休眠 / 3 把钥匙上限 / 人走远了）：立刻重新武装一轮，
      // 档位归零 —— 这种情况下人通常还在车旁边，要的是马上连回来，不是等 30 秒。
      // 只认 disconnected：主动 close() 走的是 idle，不该被当成断线（那是用户明确要断开）。
      if (s === 'disconnected' && hooks) hooks.onLinkLost();
    },
    raw: (dir, bytes) => {
      connection.raw.push({ dir, hex: toHex(bytes), at: Date.now() });
      if (connection.raw.length > RECENT_RAW_MAX) connection.raw.shift();
    }
  });
  return state.ble;
}

export function namesForVin(vin) {
  return bleNamesForVin(vin || state.vin);
}

// device 传进来就直接连它（弹窗手选的结果 / 绑定档案里的 deviceId），完全跳过按 VIN
// 匹配广播名那一步 —— 车辆蓝牙名被改过时只有这条路能走通。
// 连上即记档：下次打开 App 就能凭 deviceId 自动回连，不必再手选。
export async function connectTo(vin, device) {
  const b = ble();
  await b.init();
  let dev = device;
  if (!dev) {
    const names = namesForVin(vin);
    if (!names.exact.length && !names.prefixes.length) throw new Error('请先填写 VIN（需要后 6 位才能匹配广播名），或在扫描列表里手选设备');
    dev = await b.scan(names, SCAN_TIMEOUT_MS);
    if (!dev) return null;
  }
  connection.device = dev;
  await b.connect(dev);
  // 换了连接：两个域本次连接才有效的共享密钥都要作废（counter / epoch 保留，不回退）
  invalidateAllV3Sessions('换了连接，共享密钥随本次会话失效');
  if (hooks) hooks.onConnected();
  saveBind({
    vin: vin || state.vin || bind.vin || '',
    deviceId: b.deviceId,
    name: b.name,
    connectedAt: Date.now()
  });
  return dev;
}

export async function disconnectAll() {
  if (state.ble) await state.ble.close();
  invalidateAllV3Sessions('断开连接');
  connection.device = null;
  connection.connection = 'idle';
  // 用户主动断开 = 明确表达「现在别连」，直到他下一次手动连接才恢复自动重连
  if (hooks) hooks.suspend(true);
  log('info', '已暂停自动重连（下次手动连接、点「恢复自动重连」或重开 App 会恢复）');
}
