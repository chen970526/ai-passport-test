// VCSEC 域的功能接口：上锁 / 解锁 / 唤醒等 RKE 动作。
//
// 一个功能接口一个文件：本文件只装 sendRke。它依赖的会话状态、BLE 连接、
// 重试策略与协议编解码全部复用现有单例（store / infra / protocol / domain），
// 这里只做「页面上的一个按钮 → 一条 VCSEC 请求」的编排，不重复实现任何逻辑。

import { label, encodeUnsignedMessage } from '../../protocol/index.js';
import { log } from '../../infra/logging/log-bus.js';
import { KNOWN_RKE, sendRequest, doneCommand } from '../../domain/index.js';

// ---------------------------------------------------------------- 页面按钮

// 上锁 / 解锁 / 唤醒等 RKE 动作
export async function sendRke(action, name) {
  const label_ = name || label('RKEAction_E', action);
  if (KNOWN_RKE.indexOf(action) < 0) log('warn', label_ + '：官方现行 RKEAction_E 里没有这个值，车辆多半会拒');
  return sendRequest({ name: label_, payload: encodeUnsignedMessage({ RKEAction: action }), done: doneCommand });
}
