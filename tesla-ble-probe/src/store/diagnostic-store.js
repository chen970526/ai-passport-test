// ---------------------------------------------------------------- 诊断台账
//
// 诊断页要回答的是「刚才那几条命令各自怎么样了」，而日志总线给的是逐行文本：
// 想按动作聚合（同一个动作最近一次的结论、成功失败各多少次、充电盖板两条路径谁成功），
// 就得把行日志再解析一遍 —— 那是最脆的做法。
//
// 所以这里由**动作的返回结果**直接登记一份结构化台账：每条只存
// { name, ok, text, at, tag }，text 就是页面 toast / 日志里那句原文，不改写、不截断。
//
// tag 是给 A/B 对照用的：同一个物理动作走不同协议路径时，界面上必须看得出是哪条路。
// 充电盖板就有两条已验证的入口 —— 车机域 chargePortDoorOpen/Close 与 VCSEC
// ClosureMoveRequest{chargePort}，用户明确要求两条都留着做对照，台账按 name 区分即可。
//
// 安全红线：这里只存「动作名 + 结论」，绝不存载荷、密钥、epoch、共享秘密。

import { log } from '../infra/logging/log-bus.js';

export const MAX_DIAGNOSTICS = 60;

const listeners = [];

export const diagnostics = {
  records: [], // 最新的在末尾
  total: 0,
  okCount: 0,
  failCount: 0
};

export function subscribeDiagnostics(cb) {
  if (listeners.indexOf(cb) < 0) listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function notify() {
  for (const cb of listeners.slice()) {
    try {
      cb(diagnostics);
    } catch (e) {
      /* 页面销毁之类的错误不许冒泡回动作调用方 */
    }
  }
}

// 一行台账：r 是功能接口返回的 { ok, text }，name 缺省取动作自己的分段名。
export function recordResult(name, r, tag) {
  const ok = !!(r && r.ok === true);
  const text = r && r.text ? String(r.text) : '';
  const entry = { name: String(name || '未命名动作'), ok, text, at: Date.now(), tag: tag || '' };
  diagnostics.records.push(entry);
  if (diagnostics.records.length > MAX_DIAGNOSTICS) diagnostics.records.shift();
  diagnostics.total++;
  if (ok) diagnostics.okCount++;
  else diagnostics.failCount++;
  notify();
  return entry;
}

// 异常也要落账：action() 包装的抛出路径不会返回 { ok:false }，页面 catch 之后调这里。
export function recordError(name, err, tag) {
  const msg = ((err && (err.message || err.errMsg)) || String(err)) +
    (err && err.errCode !== undefined ? ' errCode=' + err.errCode : '');
  return recordResult(name, { ok: false, text: msg }, tag);
}

export function recentResults(limit = MAX_DIAGNOSTICS) {
  return diagnostics.records.slice(-Math.max(0, limit)).reverse();
}

// 同名动作的最近一条：A/B 对照时界面上「车机域 / VCSEC」两条各看自己的结论。
export function lastResult(name, tag) {
  for (let i = diagnostics.records.length - 1; i >= 0; i--) {
    const e = diagnostics.records[i];
    if (e.name === name && (!tag || e.tag === tag)) return e;
  }
  return null;
}

export function clearDiagnostics() {
  diagnostics.records = [];
  diagnostics.total = 0;
  diagnostics.okCount = 0;
  diagnostics.failCount = 0;
  log('info', '诊断台账已清空');
  notify();
}

export default diagnostics;
