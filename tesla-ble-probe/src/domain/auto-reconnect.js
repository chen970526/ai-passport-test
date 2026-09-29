// ---------------------------------------------------------------- 自动重连
//
// 「第一次输 VIN → 绑定 → 以后打开 App 就自动连上」是这台探针现在最该有的行为：
// 私钥（tesla_probe_key_v1）和两个域的 counter/epoch（tesla_probe_v3_*_v1）本来就落盘，
// 唯一缺的就是「车是哪台」这条档案 + 启动时主动跑一次连接。
//
// 两条路都走：
//   1. 先用档案里的 deviceId 直连（Android 上是车辆真实 MAC，iOS 上是系统给本 App 的稳定
//      UUID，多数情况下秒连，且能在车辆蓝牙名被改过时照样连上）；
//   2. 直连失败（Android 有时要求设备先被扫描到才能连）再扫一轮，按
//      deviceId → 命中 VIN 广播名 → 命中档案里的名字 → 广播了 0211 服务的顺序挑一条。
// 全程只在「有私钥 + 有绑定档案 + 当前没连着 + 用户没主动断开过」时才做。
//
// ---------------------------------------------------------------- 自动重连循环
//
// 「打开 App 时试一次」不符合真实用法：人离车还有几十米就点开 App，这一次必然失败
// （deviceId 直连要等系统超时、扫描窗口内也扫不到广播）；等他走到车边，App 早就不试了，
// 只能杀掉后台重开 —— 而私钥和两个域的 counter 明明都还在，重开毫无意义。
// 所以前台期间要一直试：连上就停，链路断了再武装，人走进范围那一轮自己就连上了。
//
// 为什么按退避排期而不是死循环：车辆休眠 / 真不在范围内时，连着扫会让系统蓝牙栈长期忙碌、
// 也费电。阶梯 3 → 6 → 12 → 24 → 30 秒封顶；只有「自动重试」才升档，
// 手动触发和断线重连都归零重来（这两种情况下用户就在车旁边，要的是马上连上）。

import { normName } from '../infra/ble/device-matcher.js';
import { ensureAndroidPermissions } from '../infra/platform/permissions.js';
import { log } from '../infra/logging/log-bus.js';
import { RETRY_STEPS_MS, AUTO_RECONNECT_SCAN_MS } from '../config/index.js';
import { state } from '../store/app-state.js';
import { hasKey } from '../store/credential-store.js';
import { bind, hasBind, describeBind } from '../store/bind-profile.js';
import { ble, connection, connectTo, namesForVin, setConnectionHooks } from './connection-service.js';

// 用户主动断开之后，本次 App 生命周期内不再自动重连 ——
// 否则回到前台立刻又连回去，等于根本断不开（车边有别人的钥匙时这点很重要）。
let autoSuspended = false;

export function suspendAutoConnect(on) {
  autoSuspended = on === undefined ? true : !!on;
  // 主动断开 = 「现在别连」，正在排期的重试必须一起取消，否则退避到点又连回去了
  if (autoSuspended) stopAutoReconnectLoop('你主动断开过');
}

function pickFromList(list) {
  if (!list || !list.length) return null;
  if (bind.deviceId) {
    const exact = list.find((d) => d.deviceId === bind.deviceId);
    if (exact) return { dev: exact, why: '档案里的 deviceId' };
  }
  const hit = list.find((d) => d.hit);
  if (hit) return { dev: hit, why: '命中 VIN 广播名 ' + hit.hit };
  if (bind.name) {
    const named = list.find((d) => d.name && normName(d.name) === normName(bind.name));
    if (named) return { dev: named, why: '命中档案里的名字 ' + named.name };
  }
  const svc = list.find((d) => d.tesla);
  if (svc) return { dev: svc, why: '广播了 0211（特斯拉 VCSEC 服务）' };
  return null;
}

let autoConnecting = null;

export function autoReconnect(opts) {
  if (autoConnecting) return autoConnecting;
  const p = doAutoReconnect(opts || {}).then((r) => {
    if (autoConnecting === p) autoConnecting = null;
    return r;
  });
  autoConnecting = p;
  return p;
}

async function doAutoReconnect(opts) {
  const skip = (reason, text) => ({ ok: false, skipped: reason, text });
  if (!hasKey()) return skip('nokey', '本机还没有密钥，先走「③ 绑定（刷钥匙卡）」');
  if (!hasBind()) return skip('nobind', '还没有绑定档案，先「② 扫描并连接（手选）」连一次');
  if (autoSuspended) return skip('suspended', '你刚才主动断开过，已暂停自动重连（点「恢复自动重连」或手动连接一次即可恢复）');
  if (connection.connection === 'connected') return skip('already', '已经连在车上了');

  const scanMs = opts.scanMs || AUTO_RECONNECT_SCAN_MS;
  const b = ble();
  const vin = bind.vin || state.vin;
  log('info', '自动重连：' + describeBind());

  try {
    const perm = await ensureAndroidPermissions();
    if (perm.needed && !perm.granted) return skip('permission', '蓝牙权限被拒绝，自动重连中止：' + JSON.stringify(perm.denied));
    await b.init();
  } catch (e) {
    return skip('adapter', '蓝牙适配器不可用：' + ((e && e.message) || String(e)));
  }

  // 1. 先按档案里的 deviceId 直连
  if (bind.deviceId) {
    try {
      const dev = await connectTo(vin, bind.deviceId);
      if (dev) return { ok: true, how: 'deviceId', text: '自动连接成功（deviceId 直连）：' + (bind.name || bind.deviceId) + '（车辆已休眠或不在范围内时会失败，稍后重试）' };
    } catch (e) {
      log('warn', 'deviceId 直连失败（' + ((e && e.message) || String(e)) + '），改为一轮扫描');
    }
  }

  // 2. 扫描一轮再挑
  let list = [];
  try {
    list = await b.discover(scanMs, namesForVin(vin));
  } catch (e) {
    return skip('scan', '扫描失败：' + ((e && e.message) || String(e)));
  }
  const picked = pickFromList(list);
  if (!picked) {
    const seen = list.filter((d) => d.name || d.tesla).slice(0, 8).map((d) => (d.name || '(无名)') + (d.tesla ? '[0211]' : ''));
    return {
      ok: false,
      skipped: 'notfound',
      list,
      text: '没扫到绑定过的车（车可能休眠 / 距离太远 / 换过蓝牙名）。扫到 ' + list.length + ' 个广播' +
        (seen.length ? '：' + seen.join('、') : '') + ' —— 踩刹车唤醒车辆后再试，或用「② 扫描并连接（手选）」'
    };
  }
  try {
    const dev = await connectTo(bind.vin || vin, picked.dev);
    if (!dev) return skip('notfound', '扫描结果里那条设备连不上');
    log('ok', '自动连接成功（' + picked.why + '）：' + (picked.dev.name || picked.dev.deviceId));
    return { ok: true, how: 'scan', text: '自动连接成功（' + picked.why + '）：' + (picked.dev.name || picked.dev.deviceId) };
  } catch (e) {
    return skip('connect', '扫到了但连接失败：' + ((e && e.message) || String(e)));
  }
}

let loopWanted = false; // 前台期间是否希望「连不上就继续试」
let loopTimer = null; // 下一次重试的定时器
let loopNextAt = 0; // 下一次重试的时间点，只给状态行算剩余秒数
let loopRun = null; // 正在进行中的那一次尝试（单飞：多次 start 只跑一轮）
let loopStep = 0; // 当前退避档位
let loopTries = 0; // 本次前台生命周期内已尝试次数

function clearLoopTimer() {
  if (loopTimer !== null) clearTimeout(loopTimer);
  loopTimer = null;
  loopNextAt = 0;
}

function armRetry() {
  const delay = RETRY_STEPS_MS[Math.min(loopStep, RETRY_STEPS_MS.length - 1)];
  loopStep++;
  clearLoopTimer();
  loopNextAt = Date.now() + delay;
  loopTimer = setTimeout(() => {
    loopTimer = null;
    loopNextAt = 0;
    if (loopWanted) runLoopOnce('退避重试');
  }, delay);
  return delay;
}

// 试一次，失败就按退避排下一次；返回这一次的结果，方便调用方直接 toast。
function runLoopOnce(why) {
  if (!loopWanted) return Promise.resolve({ ok: false, skipped: 'stopped', text: '自动重连未启动' });
  if (loopRun) return loopRun;
  clearLoopTimer();
  const p = Promise.resolve().then(async () => {
    loopTries++;
    const r = await autoReconnect();
    if (!loopWanted) return r;
    if (r.ok || r.skipped === 'already') {
      loopStep = 0;
      return r;
    }
    // 「没密钥 / 没档案 / 用户主动断开过」= 现在压根不该连，循环让位；
    // 权限、适配器、扫不到、连不上 = 情况会变（走近、车醒、蓝牙打开），继续试。
    if (r.skipped === 'nokey' || r.skipped === 'nobind') {
      stopAutoReconnectLoop('本机还没有密钥或绑定档案');
      return r;
    }
    if (r.skipped === 'suspended') {
      loopWanted = false;
      clearLoopTimer();
      return r;
    }
    const delay = armRetry();
    log('warn', '自动重连第 ' + loopTries + ' 次没成功（' + (r.text || r.skipped) + '），' +
      Math.round(delay / 1000) + ' 秒后继续重试 —— 走到车边会自己连上，不必重开 App');
    return r;
  });
  loopRun = p;
  // 两个参数都要给：只给成功回调时，这条派生 Promise 自己会变成未捕获拒绝。
  p.then(
    () => { if (loopRun === p) loopRun = null; },
    () => { if (loopRun === p) loopRun = null; }
  );
  return p;
}

// 启动（或复用）自动重连循环，并立刻试一次。App.vue 的 onShow、页面上的
// 「立即自动连接」「恢复自动重连」都走这里；重复调用不会叠加两轮扫描。
export function startAutoReconnectLoop(why) {
  loopWanted = true;
  // 已经有一轮在跑（比如用户在扫描过程中又点了一次）时不清计数，
  // 否则状态行会退回「第 0 次尝试」，看起来像循环被重置了两遍。
  if (!loopRun) {
    loopStep = 0;
    loopTries = 0;
  }
  return runLoopOnce(why || '回到前台');
}

export function stopAutoReconnectLoop(why) {
  if (!loopWanted && loopTimer === null && !loopRun) return;
  loopWanted = false;
  loopRun = null;
  clearLoopTimer();
  log('info', '自动重连已停止' + (why ? '（' + why + '）' : '') + '；回到前台或点「立即自动连接」会重新启动');
}

// 状态行用的那一小段话：让用户看得见「它还在试」，而不是以为只能重开 App。
export function describeAutoLoop() {
  if (!hasKey() || !hasBind()) return '自动重连：未启动（无密钥或无绑定档案）';
  if (autoSuspended) return '自动重连：已暂停（你主动断开过，点「恢复自动重连」）';
  if (!loopWanted) return '自动重连：未启动（回到前台会自动启动）';
  if (connection.connection === 'connected') return '自动重连：已连上车，断线会自动重连';
  if (loopRun) return '自动重连：正在连接（第 ' + loopTries + ' 次尝试）';
  if (loopTimer !== null) return '自动重连：' + Math.max(1, Math.round((loopNextAt - Date.now()) / 1000)) + ' 秒后重试（已试 ' + loopTries + ' 次）';
  return '自动重连：等待中';
}

// 反向依赖在这里断掉：本模块单向 import connection-service，然后在模块加载时把
// 「连上了 / 链路断了 / 用户主动断开」三个动作交给它回调。
setConnectionHooks({
  onConnected: () => {
    autoSuspended = false;
    loopStep = 0; // 连上了就退回最低档：下次断线/扫不到时先 3 秒重试，别沿用上一轮的 30 秒
    loopTries = 0;
  },
  onLinkLost: () => {
    if (!loopWanted || autoSuspended) return;
    loopStep = 0;
    loopTries = 0;
    runLoopOnce('断线重连');
  },
  suspend: (on) => suspendAutoConnect(on)
});
