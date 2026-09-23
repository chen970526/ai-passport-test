// 页面唯一的动作入口：现在只有 V3 一套协议，这一层的作用变成
//   1）把 common/v3actions.js 的函数按「页面上的按钮名」统一包一层日志分段
//      （-----start----- 动作名 …… -----end----- 动作名），复制日志时能一眼看清是谁产生的；
//   2）给报文控制台（③ 页）提供整套编解码工具。
//
// 约定：所有动作都返回 { ok, text, ... }，页面只看这两个字段。

import * as v3 from './v3actions.js';
import { action } from './session.js';
import {
  V3_SPEC,
  encode,
  decode,
  inspect,
  prependLength,
  label,
  parseFrame,
  summarize,
  summarizeVcsec
} from './v3vcsec.js';

// ---------------------------------------------------------------- 动作转发

export const version = () => 'v3';
export const versionName = () => 'V3';

export const bindKey = (vin, opts) => action('绑定（刷钥匙卡）', () => v3.bindKey(vin, opts));
export const bindKeyViaSession = (vin, opts) => action('会话内加白名单', () => v3.bindKeyViaSession(vin, opts));
export const probeSession = () => action('探针确认是否已入白名单', () => v3.probeSession());
export const requestEphemeralKey = () => action('重新握手', () => v3.requestEphemeralKey());
export const handshake = (force) => action('V3 握手', () => v3.handshake(force));
export const sendRke = (a, name) => action(name || 'RKE 动作', () => v3.sendRke(a, name));
export const sendClosure = (fields, name) => action(name || '闭锁器请求', () => v3.sendClosure(fields, name));
export const infoRequest = (type, name, timeoutMs, slot) =>
  action(name || '信息查询', () => v3.infoRequest(type, name, timeoutMs, slot));
export const checkWhitelisted = () => action('查白名单', () => v3.checkWhitelisted());

export const queries = {
  status: () => action('查车辆状态', () => v3.queries.status()),
  whitelist: () => action('查白名单', () => v3.queries.whitelist()),
  whitelistEntry: (slot) => action('查白名单条目 ' + slot, () => v3.queries.whitelistEntry(slot))
};

// 枚举：V3 的 RKEAction_E 只剩 0/1/20/29/30，其余动作走 closureMoveRequest
export const rkeEnum = (name) => v3.RKE[name];
export const closureEnum = (name) => (v3.CLOSURE ? v3.CLOSURE[name] : undefined);
export { label };

// 绑定页的「钥匙类型」选择器：官方四个 FORM_FACTOR 枚举值全开，默认值由 v3actions 定
export const formFactorOptions = () =>
  v3.FORM_FACTORS.map((f) => ({ value: f.value, name: v3.formFactorText(f.value), note: f.note }));
export const defaultFormFactor = () => v3.DEFAULT_FORM_FACTOR;

// 同步的状态行，不产生日志，所以不用 action() 包
export const statusText = () => v3.statusText();

// ---------------------------------------------------------------- 报文控制台

export function toolkit() {
  return {
    v3: true,
    SPEC: V3_SPEC,
    root: 'RoutableMessage',
    encode,
    decode,
    inspect,
    prependLength,
    label,
    parseFrame,
    summarize,
    summarizeVcsec
  };
}
