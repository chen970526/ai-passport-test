// 页面顶部状态行：BLE 与两个域各自的 counter / 会话状态。

import { toHex } from '../protocol/index.js';
import { hasKey } from '../store/credential-store.js';
import { v3Session } from '../store/v3-session-store.js';
import { connection } from './connection-service.js';
import { describeAutoLoop } from './auto-reconnect.js';
import { VC, INFO_DOMAIN, teslaKeyId } from './v3-context.js';

// 页面顶部的状态行。两个域各报一份 counter / 会话状态 ——
// 现场排查「车机能连但VCSEC 报 counter 错」这类问题全靠这一行分清是谁的会话。
export function statusText() {
  const one = (domain) => {
    const s = v3Session(domain);
    const live = s.key && s.epoch && s.anchor !== undefined;
    return (
      (s.counter || 0) + '@' +
      (live ? (s.ready ? 'ready' : '未就绪') : '未握手') +
      (s.epoch ? ' epoch=' + toHex(s.epoch).slice(0, 16) + '…' : '')
    );
  };
  return (
    'BLE=' + connection.connection +
    ' | ' + (hasKey() ? 'keyId=' + teslaKeyId() : '无密钥') +
    ' | VCSEC=' + one(VC) +
    ' | 车机=' + one(INFO_DOMAIN) +
    // 自动重连循环的实时状态：连不上时用户看得见「它还在试、几秒后试」，
    // 就不会以为只能杀后台重开。
    ' | ' + describeAutoLoop()
  );
}
