// 把「协议层 + 传输层 + 会话状态」串成页面上那几颗按钮。
// 页面只负责调用和显示，所有 BLE/协议时序都集中在这里，方便现场改流程。

import { SPEC } from './spec.js';
import {
  buildWhitelistFrame,
  buildEphemeralRequestFrame,
  buildInfoRequestFrame,
  buildRkeFrame,
  decodeResponse,
  ephemeralKeyFromResponse,
  sharedKeyOf,
  summarize,
  label,
  toHex
} from './vcsec.js';
import { state, ble, log, hasKey, ensureKey, nextCounter, getCounter, syncCounter, connection } from './session.js';

// 我们这台手机要申请的权限：本地驾驶 + 本地解锁 + 远程驾驶 + 远程解锁
const FORM_FACTOR_ANDROID = SPEC.enums.KeyFormFactor.KEY_FORM_FACTOR_ANDROID_DEVICE;

function mustConnect() {
  if (!state.ble || !state.ble.connected) throw new Error('还没连上车辆，先按「扫描并连接」');
}

function mustKey() {
  if (!hasKey()) throw new Error('还没有密钥，先做绑定');
}

// 发一帧并解析响应；车辆没回东西时把超时信息变成可读文字
async function exchange(frame, what, timeoutMs) {
  const body = await ble().send(frame, timeoutMs);
  if (body === null) return { obj: null, text: '（不等待响应）', summary: null };
  const { obj, text } = decodeResponse(body);
  const summary = summarize(obj);
  log(summary.kind === 'other' ? 'warn' : 'rx', what + ' 响应: ' + summary.text);
  log('rx', what + ' 解码:\n' + text);
  if (summary.counter !== undefined) syncCounter(summary.counter);
  return { obj, text, summary };
}

// ---------------------------------------------------------------- 1. 绑定

// 步骤：确保有密钥 -> 发自定义 formFactor -> 等车主刷钥匙卡 -> 判定
export async function bindKey(vin) {
  mustConnect();
  const { created } = ensureKey((vin || state.vin || '').toUpperCase());
  if (created) log('ok', '已生成 P-256 密钥对 公钥=' + toHex(state.publicKey));
  log('info', '提示：车辆会在收到报文后进入 WAIT 状态，请在 30 秒内把 NFC 钥匙卡贴到中控台钥匙位（或方向盘下方的 B 柱）；本端最长等待 60 秒');
  const frame = buildWhitelistFrame(state.publicKey, FORM_FACTOR_ANDROID);
  log('tx', '白名单添加报文（明文，signatureType=PRESENT_KEY） ' + toHex(frame));
  const r = await exchange(frame, 'addKeyToWhitelistAndAddPermissions', 60000);
  const s = r.summary;
  const ok = s && s.status === 0 && (s.kind === 'whitelist' || s.kind === 'command');
  const info = s && s.info !== undefined && s.info !== 0
    ? label('WhitelistOperation_information_E', s.info)
    : '';
  return {
    ok,
    wait: s && s.status === 1,
    text: ok
      ? '绑定成功：公钥已进白名单，keyId=' + state.keyId
      : '绑定未完成 status=' + label('OperationStatus_E', s && s.status) + (info ? ' 原因=' + info : '')
  };
}

// ---------------------------------------------------------------- 2. 临时公钥

export async function requestEphemeralKey() {
  mustConnect();
  mustKey();
  const frame = buildEphemeralRequestFrame(state.publicKey);
  const r = await exchange(frame, 'GET_EPHEMERAL_PUBLIC_KEY', 8000);
  const eph = r.obj ? ephemeralKeyFromResponse(r.obj) : null;
  if (!eph) {
    state.sharedKey = null;
    return { ok: false, text: '响应里没有 sessionInfo.publicKey：' + r.text };
  }
  if (eph.length !== 65 || eph[0] !== 0x04) {
    state.sharedKey = null;
    return { ok: false, text: '临时公钥格式意外（长度 ' + eph.length + '，首字节 ' + eph[0] + '）：' + toHex(eph) };
  }
  state.ephemeral = toHex(eph);
  state.sharedKey = sharedKeyOf(state.privateKey, eph);
  log('ok', '共享密钥已协商 = ' + toHex(state.sharedKey) + '（AES-128-GCM 用，本次连接内有效）');
  return { ok: true, text: '临时公钥 65 字节，sharedKey=SHA1(ECDH)[:16] 已生成' };
}

// ---------------------------------------------------------------- 3. RKE

export async function sendRke(action, name) {
  mustConnect();
  mustKey();
  if (!state.sharedKey) {
    log('info', '还没有共享密钥，先协商临时公钥');
    const e = await requestEphemeralKey();
    if (!e.ok) return { ok: false, text: e.text };
  }
  const counter = nextCounter();
  const built = buildRkeFrame(state.publicKey, state.sharedKey, counter, action);
  log('tx', name + ' counter=' + counter + ' nonce=' + toHex(built.nonce) + ' 明文=' + (built.inner.length ? toHex(built.inner) : '(空=proto3 省略默认值)'));
  const r = await exchange(built.frame, name, 8000);
  const s = r.summary;
  const ok = !!s && s.status === 0;
  const info = s && s.info ? label('SignedMessage_information_E', s.info) : '';
  return {
    ok,
    text: name + ' status=' + label('OperationStatus_E', s && s.status) + (info ? ' 原因=' + info : '') + ' counter=' + counter
  };
}

export const RKE = SPEC.enums.RKEAction_E;

// ---------------------------------------------------------------- 4. 只读查询

export function infoRequest(type, label_, timeoutMs) {
  mustConnect();
  const frame = buildInfoRequestFrame(type, hasKey() ? state.publicKey : null);
  log('tx', 'InformationRequest ' + label_ + ' type=' + type + ' ' + toHex(frame));
  return exchange(frame, label_, timeoutMs || 8000);
}

export const queries = {
  status: () => infoRequest(SPEC.enums.InformationRequestType.INFORMATION_REQUEST_TYPE_GET_STATUS, 'GET_STATUS'),
  whitelist: () => infoRequest(SPEC.enums.InformationRequestType.INFORMATION_REQUEST_TYPE_GET_WHITELIST_INFO, 'GET_WHITELIST_INFO'),
  vehicleInfo: () => infoRequest(SPEC.enums.InformationRequestType.INFORMATION_REQUEST_TYPE_GET_VEHICLE_INFO, 'GET_VEHICLE_INFO'),
  capabilities: () => infoRequest(SPEC.enums.InformationRequestType.INFORMATION_REQUEST_TYPE_GET_CAPABILITIES, 'GET_CAPABILITIES'),
  keyStatus: () => infoRequest(SPEC.enums.InformationRequestType.INFORMATION_REQUEST_TYPE_GET_KEYSTATUS_INFO, 'GET_KEYSTATUS_INFO')
};

// 连接后自查：白名单里有几把钥匙、我们的 keyId 还在不在。
// 注意 GET_WHITELIST_INFO 是无签名请求，绑定前也能发 —— 现场用它先摸清还剩几个槽。
export async function checkWhitelisted() {
  try {
    const r = await queries.whitelist();
    const wi = r.obj && r.obj.whitelistInfo;
    if (!wi) return { known: false, text: '白名单查询无结果：' + (r.summary && r.summary.text) };
    const entries = (wi.whitelistEntries || []).map((e) => toHex(e.publicKeySHA1));
    const mine = hasKey() && entries.indexOf(state.keyId) >= 0;
    return {
      known: true,
      mine,
      text: '白名单 ' + entries.length + ' 条 [' + entries.join(' ') + ']' +
        (hasKey()
          ? '，本机 keyId=' + state.keyId + (mine ? ' 在内' : ' 不在内')
          : '（本机还没有密钥，先记下条数）')
    };
  } catch (e) {
    return { known: false, text: '白名单查询失败：' + (e && e.message) };
  }
}

export function statusText() {
  return 'BLE=' + connection.connection + ' | ' + (hasKey() ? 'keyId=' + state.keyId : '无密钥') +
    ' | counter=' + getCounter() + ' | sharedKey=' + (state.sharedKey ? toHex(state.sharedKey) : '-');
}
