// VCSEC 域的功能接口：后备箱 / 前备箱 / 充电口等闭锁器请求。
//
// 一个功能接口一个文件：本文件只装 sendClosure。会话状态、BLE 连接、重试策略与
// 协议编解码全部复用现有单例（store / infra / protocol / domain），不重复实现。

import { encodeUnsignedMessage } from '../../protocol/index.js';
import { sendRequest, doneCommand } from '../../domain/index.js';

// ---------------------------------------------------------------- 页面按钮

// 后备箱 / 前备箱 / 充电口等：走 ClosureMoveRequest，不再是 RKE action
// fields 例：{ frontTrunk: CLOSURE.CLOSURE_MOVE_TYPE_OPEN }
export async function sendClosure(fields, name) {
  return sendRequest({
    name: name || 'ClosureMoveRequest',
    payload: encodeUnsignedMessage({ closureMoveRequest: fields || {} }),
    done: doneCommand
  });
}
