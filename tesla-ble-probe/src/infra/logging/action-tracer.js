// 把一次动作产生的所有日志包成一段，复制出来能一眼看清是谁产生的。
// 形如：-----start----- 绑定（刷钥匙卡） …… -----end----- 绑定（刷钥匙卡） | 成功：…
// 嵌套调用（例如 sendRke 内部会 handshake）只算一段，不会到处插标记。

import { log, setClearHook } from './log-bus.js';

let actionDepth = 0;
let actionName = '';

// clearLogs 之后不许出现「凭空多出来的 end」：嵌套计数与段名必须一起归零。
function resetTrace() {
  actionDepth = 0;
  actionName = '';
}

setClearHook(resetTrace);

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
