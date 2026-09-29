// 环形日志总线：所有层往这里写，页面 subscribe 之后渲染。
//
// clearLogs 需要顺带归零「动作分段」的嵌套计数，但分段器（action-tracer）依赖本模块，
// 反过来 import 会成环 —— 所以这里只留一个 setClearHook 注入口，由分段器自己登记。

import { MAX_LOGS } from '../../config/index.js';

const listeners = [];
const logs = [];

export function subscribe(cb) {
  if (listeners.indexOf(cb) < 0) listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function emit(entry) {
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

let clearHook = null;

export function setClearHook(fn) {
  clearHook = fn;
}

export function clearLogs() {
  logs.length = 0;
  if (clearHook) clearHook();
  emit({ kind: 'info', msg: '（日志已清空）', stamp: '' });
}
