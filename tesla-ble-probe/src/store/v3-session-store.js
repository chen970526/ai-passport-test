// ---------------------------------------------------------------- V3 会话
//
// epoch 变了也不回退 counter（protocol.md 明确要求），
// 因为车辆在新 epoch 下从 0 开始记，我们发大数只会「跳过」而不会被拒。
//
// 每个 domain 一份：见文件头 dispatcher.go:36 / peer.h 的取证。
//
// 内存里的那份 map 就是 state.v3（全站唯一引用，见 app-state.js）：本模块是它唯一的
// 读写入口，credential-store 不再自己碰 v3 —— 但整体清空（state.v3 = {}）仍然必须
// 照常生效，所以这里每次都重新取 state.v3[domain]，绝不缓存 map 的本地副本。

import { DOMAIN } from '../protocol/index.js';
import { toHex, fromHex } from '../infra/bytes.js';
import { writeValue, readValue, removeValue } from '../infra/storage/local-store.js';
import { log } from '../infra/logging/log-bus.js';
import { V3_SESSION_STORE, V3_INFOTAINMENT_STORE } from '../config/index.js';
import { state } from './app-state.js';

export { DOMAIN };

// VCSEC 那一份**沿用老键名** tesla_probe_v3_session_v1：已经绑好车、counter 跑到几百的
// 真机不会因为这次升级而回退 counter（回退 = 立刻制造 IV 洞 = 重新绑钥匙）。
export const V3_STORES = {
  [DOMAIN.DOMAIN_VEHICLE_SECURITY]: V3_SESSION_STORE,
  [DOMAIN.DOMAIN_INFOTAINMENT]: V3_INFOTAINMENT_STORE
};

// 只有这两个域会建会话（BROADCAST 不建）
export const SESSION_DOMAINS = Object.keys(V3_STORES).map(Number);

function storeKeyOf(domain) {
  const k = V3_STORES[domain];
  if (!k) throw new Error('session: domain=' + domain + ' 不建会话（只有 VCSEC=2 / INFOTAINMENT=3）');
  return k;
}

function domainLabel(domain) {
  return domain === DOMAIN.DOMAIN_INFOTAINMENT ? '车机' : 'VCSEC';
}

function freshV3Session(domain) {
  return {
    domain, // 决定 AAD 里的 domain 与用哪个 counter，绝不与另一个域串用
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

export function v3Session(domain = DOMAIN.DOMAIN_VEHICLE_SECURITY) {
  const storeKey = storeKeyOf(domain);
  const label = domainLabel(domain);
  if (state.v3[domain]) return state.v3[domain];
  const s = freshV3Session(domain);
  const raw = readValue(storeKey);
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
      if (s.counter > 0) log('info', '已恢复 ' + label + ' 会话 counter=' + s.counter + (s.ready ? '（可复用，握手失败时再刷新）' : '（尚未握手）'));
    } catch (e) {
      log('error', label + ' 会话存储损坏: ' + (e && e.message));
      state.v3[domain] = freshV3Session(domain);
      return state.v3[domain];
    }
  }
  state.v3[domain] = s;
  return s;
}

export function storeV3Session(domain = DOMAIN.DOMAIN_VEHICLE_SECURITY) {
  const s = state.v3[domain];
  if (!s) return;
  writeValue(storeKeyOf(domain), v3ToDisk(s));
}

// 换连接 / 握手失效：只清掉本次连接才有效的共享密钥，counter 保留。
// 不带 domain 时只作废 VCSEC（沿用改动前的语义）；整条链路断开请用 invalidateAllV3Sessions。
export function invalidateV3Session(why, domain = DOMAIN.DOMAIN_VEHICLE_SECURITY) {
  const s = state.v3[domain];
  if (!s) return;
  if (s.key) log('info', domainLabel(domain) + ' 共享密钥已作废' + (why ? '（' + why + '）' : ''));
  s.key = null;
  s.ready = false;
}

export function invalidateAllV3Sessions(why) {
  for (const d of SESSION_DOMAINS) invalidateV3Session(why, d);
}

// 彻底重来（epoch 变了或用户主动清）：这个域的 counter 也归零
export function resetV3Session(domain = DOMAIN.DOMAIN_VEHICLE_SECURITY) {
  state.v3[domain] = freshV3Session(domain);
  writeValue(storeKeyOf(domain), v3ToDisk(state.v3[domain]));
  log('warn', domainLabel(domain) + ' 会话已重置（counter 归零，车辆侧需要重新同步）');
}

// Forget 路径要用到的两件工具：内存整体丢弃 + 两个域的落盘全部抹掉。
export function dropV3Memory() {
  state.v3 = {};
}

export function clearV3Disk() {
  for (const key of Object.keys(V3_STORES)) removeValue(V3_STORES[key]);
}

// 每个域各自一行：两个 counter 独立增长，出问题时一眼看出是哪个域留了洞
export function describeDomain(domain) {
  const s = v3Session(domain);
  return domainLabel(domain) + ' counter=' + (s.counter || 0) +
    ' epoch=' + (s.epoch ? toHex(s.epoch).slice(0, 12) + '…' : '未握手') +
    ' 密钥=' + (s.key ? '已协商' : '未协商');
}
