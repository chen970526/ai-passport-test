// session_info 握手与响应搭车（piggyback）刷新会话。

import { V3_SPEC, newRoutingAddress, newUuid, sharedKeyOf, buildSessionInfoRequest, applySessionInfo, parseFrame, summarize, label, decode, inspect, toHex, prependLength } from '../protocol/index.js';
import { log } from '../infra/logging/log-bus.js';
import { state } from '../store/app-state.js';
import { v3Session, storeV3Session, invalidateV3Session } from '../store/v3-session-store.js';
import { ble } from './connection-service.js';
import { MAX_LATENCY_MS, FIRST_RESPONSE_MS, sleep } from './dispatch-policy.js';
import { VC, domainText, mustConnect, mustKey, vinOrEmpty } from './v3-context.js';
import { TAP_HINT } from './response-hints.js';

// ---------------------------------------------------------------- 握手

// 一次 session_info 握手。K 是从「响应里带的车辆公钥」现算的，所以必须先解出
// session_info 才能验它的 HMAC —— 和官方 processHello 的顺序一致。
export async function handshakeOnce(vin, session, domain) {
  const uuid = newUuid();
  const addr = newRoutingAddress();
  const built = buildSessionInfoRequest(domain, state.publicKey, uuid, addr);
  log('tx', 'V3 握手 session_info_request（' + domainText(domain) + '，明文，uuid=' + toHex(uuid) + '）\n' + inspect(V3_SPEC, 'RoutableMessage', built.message));

  const body = await ble().send(prependLength(built.bytes), FIRST_RESPONSE_MS, true);
  if (body === null) return { ok: false, error: FIRST_RESPONSE_MS + ' 秒内没有响应（车辆休眠 / 没订阅成功）' };

  const parsed = parseFrame(body);
  if (parsed.kind !== 'routable') return { ok: false, error: '响应不是 RoutableMessage：' + parsed.text.slice(0, 120) };

  const rm = parsed.rm;
  const brief = summarize(rm);
  log('rx', '握手响应：' + brief.text + '\n' + parsed.text);
  const info = rm.session_info;
  if (!info || !info.length) return { ok: false, error: '响应里没有 session_info（' + brief.text + '）' };

  // 车辆拒绝建会话时（实测：钥匙不在白名单）只回 `session_info = 28 01`，
  // 既不带 publicKey 也不带 signature_data。必须先把 status 翻成人话，
  // 否则下面「没有 session_info_tag」会把真正的原因盖掉，还会白跑一次重试。
  let si = null;
  try {
    si = decode(V3_SPEC, 'SessionInfo', info);
  } catch (e) {
    return { ok: false, error: 'session_info 解不开：' + ((e && e.message) || String(e)) };
  }
  const status = si.status === undefined ? 0 : si.status;
  if (status !== 0) {
    const name = label('Session_Info_Status', status);
    return {
      ok: false,
      fatal: true, // 确定性拒绝，重试没有意义
      notWhitelisted: status === 1,
      error: '车辆拒绝建立会话：' + name +
        (status === 1 ? ' —— 这把钥匙还没进白名单。先按「③ 绑定（刷钥匙卡）」，踩一脚刹车唤醒车机，' + TAP_HINT : '')
    };
  }

  const sd = rm.signature_data || {};
  const tag = sd.session_info_tag ? sd.session_info_tag.tag : null;
  if (!tag) return { ok: false, error: '响应没有 session_info_tag（官方会当成 unauthenticated 直接丢弃）' };

  const pk = si.publicKey;
  if (!pk || pk.length !== 65 || pk[0] !== 0x04) {
    return { ok: false, error: 'session_info.publicKey 格式意外（' + (pk ? pk.length + 'B 首字节 0x' + pk[0] : '缺失') + '）' };
  }

  try {
    session.key = sharedKeyOf(state.privateKey, pk);
  } catch (e) {
    return { ok: false, error: 'ECDH 失败：' + ((e && e.message) || String(e)) };
  }

  // challenge = 车辆回显的 request_uuid；老固件不带时用我们自己发的 uuid 兜底
  const applied = applySessionInfo(session, {
    vin,
    challenge: rm.request_uuid || uuid,
    encodedInfo: info,
    tag
  });
  if (!applied.ok) {
    session.key = null;
    return { ok: false, error: applied.error };
  }
  return { ok: true, text: applied.text, status: applied.status, notWhitelisted: applied.notWhitelisted };
}

// force=false：会话还能用就直接复用；true：无论如何重做一次（页面上的「重新协商」按钮）
// domain 默认 VCSEC；车机（car_server）侧的动作要先 handshake(false, INFOTAINMENT)
export async function handshake(force, domain = VC) {
  mustConnect();
  mustKey();
  const vin = vinOrEmpty();
  if (!vin) return { ok: false, text: 'VIN 为空，先在首页填 VIN 再连接' };

  const who = domainText(domain);
  const session = v3Session(domain);
  if (!force && session.ready && session.key && session.epoch && session.anchor !== undefined) {
    return { ok: true, reused: true, text: '复用 ' + who + ' 会话（counter=' + session.counter + '）' };
  }

  let last = { ok: false, error: '没跑过握手' };
  for (let i = 1; i <= 2; i++) {
    last = await handshakeOnce(vin, session, domain);
    if (last.ok) {
      storeV3Session(domain);
      log('ok', who + ' 握手成功 ' + last.text);
      if (last.notWhitelisted) {
        log('warn', '车辆回了 KEY_NOT_ON_WHITELIST：这把钥匙还没进白名单，先做绑定再发命令');
        return { ok: false, notWhitelisted: true, text: '握手通过，但车辆说这把钥匙不在白名单里（先刷卡绑定）' };
      }
      return { ok: true, text: who + ' 握手成功 ' + last.text };
    }
    log('warn', who + ' 握手第 ' + i + ' 次失败：' + last.error);
    // 车辆明确拒绝（session_info.status != 0）是确定性的，重发只会拿到同一条拒绝
    if (last.fatal) {
      invalidateV3Session('车辆拒绝握手', domain);
      return { ok: false, fatal: true, notWhitelisted: last.notWhitelisted, text: who + ' 握手被拒：' + last.error };
    }
    if (i < 2) await sleep(1000);
  }
  invalidateV3Session('握手连续失败', domain);
  return { ok: false, text: who + ' 握手失败：' + last.error };
}

// 页面上的「换取时公钥」按钮在 V3 里的等价动作：重做一次 session_info 握手
export async function requestEphemeralKey() {
  const r = await handshake(true);
  return { ok: r.ok, text: r.ok ? 'V3 会话已就绪：' + r.text : r.text };
}

// 命令发出后车辆可能顺手刷新会话（dispatcher.go checkForSessionUpdate 的三道闸）
export function applyPiggyback(rm, ctx) {
  const session = ctx.session;
  if (!session.key) {
    log('info', '响应带 session_info，但本机还没有共享密钥，按官方规则忽略');
    return;
  }
  if (Date.now() - ctx.sentAt > MAX_LATENCY_MS) {
    log('info', '响应带 session_info，但距请求发出已超过 ' + MAX_LATENCY_MS + 'ms，丢弃');
    return;
  }
  const sd = rm.signature_data || {};
  const tag = sd.session_info_tag ? sd.session_info_tag.tag : null;
  const applied = applySessionInfo(session, {
    vin: ctx.vin,
    challenge: rm.request_uuid || null,
    encodedInfo: rm.session_info,
    tag
  });
  if (applied.ok) {
    storeV3Session(ctx.domain);
    log('rx', '顺手刷新会话：' + applied.text);
  } else {
    log('warn', '响应里的 session_info 未采用：' + applied.error);
  }
}
