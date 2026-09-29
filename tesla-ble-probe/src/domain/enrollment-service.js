// 入白名单（绑定钥匙）：会话探针、刷卡配对主路径、白名单查询。

import { label, UM, encodeUnsignedMessage, buildAddKeyPayload, buildAddKeyEnvelope, toHex, prependLength } from '../protocol/index.js';
import { log } from '../infra/logging/log-bus.js';
import { state } from '../store/app-state.js';
import { hasKey, ensureKey } from '../store/credential-store.js';
import { v3Session, storeV3Session, invalidateV3Session } from '../store/v3-session-store.js';
import { ble } from './connection-service.js';
import { WHITELIST_MAX_MS, DEFAULT_MAX_MS, FIRST_RESPONSE_MS, PAIR_WINDOW_MS, PAIR_RECEIVE_MS, PROBE_FIRST_MS, PROBE_INTERVAL_MS, pick } from './dispatch-policy.js';
import { TAP_HINT, PAIR_HINTS } from './response-hints.js';
import { VC, ROLE, INFO, DEFAULT_FORM_FACTOR, formFactorText, mustConnect, mustKey, vinOrEmpty, myKeyId, teslaKeyId, entryKeyId, keyIdMatches } from './v3-context.js';
import { handshakeOnce } from './handshake-service.js';
import { decodeFrame, sendRequest, doneWhitelist } from './command-dispatcher.js';

// ---------------------------------------------------------------- 入白名单探针
//
// 「绑定到底成没成」不能只靠 whitelist-add 自己的回执判断（见文件头 PAIR_WINDOW_MS 的取证）：
//   官方 security.go:324 —— "Clients can check if publicKey has been enrolled ... by
//     attempting to call v.SessionInfo"
//   0Bu vehicle_pairing.cpp:246 —— 车机加白后**不发** completing commandStatus，
//     成功与否靠事后的签名 VCSEC 探针（它的 8 轮 get_vehicle_status）判断。
//
// 官方 SessionInfo（internal/dispatcher/dispatcher.go:464 SessionInfoRequest）用的是
// **不带签名**的 session_info_request + AuthMethodNone，正好等于本项目已有的 handshakeOnce
// 发包形状，只是这里把它的返回值当成「问句」而不是「握手步骤」用：
// 车端回 SessionInfo.status = OK → 钥匙已在白名单；= KEY_NOT_ON_WHITELIST → 还没加上。
//
// 探针打在 VCSEC 域而不是官方注释里举例的 INFOTAINMENT 域，理由有两条：
//   1) VCSEC 才是解锁/上锁要用的域，「能建 VCSEC 会话」才是我们要的强判据；
//   2) yoziru/esphome-tesla-ble 的 AGENTS.md 明确「VCSEC is always safe to poll
//      （低功耗控制器，不会唤醒车机）」，而 INFOTAINMENT 探针在车休眠时会干扰休眠。
//      本机实测（README F11）车辆拒绝建会话时回的 `session_info = 28 01` 也是 VCSEC 域。

export async function probeOnce(vin, domain = VC) {
  invalidateV3Session('探针要求重新协商', domain);
  const r = await handshakeOnce(vin, v3Session(domain), domain);
  if (r.ok) {
    storeV3Session(domain);
    return { paired: true, text: '会话已建立（' + r.text + '）' };
  }
  if (r.notWhitelisted) return { paired: false, notWhitelisted: true, text: r.error };
  // 没响应 / 响应不是 RoutableMessage（例如正好把 add-key 的 WAIT 帧当成握手响应读走了）
  // 只说明这一针没打上，**不代表没绑上**，下一轮继续。
  return { paired: false, retryable: true, text: r.error };
}

// 页面上的「④ 探针确认」：单独打一针，回答「这把钥匙到底进没进白名单」
export async function probeEnrollment(opts) {
  mustConnect();
  mustKey();
  const vin = vinOrEmpty();
  if (!vin) return { ok: false, paired: false, text: 'VIN 为空，先在首页填 VIN 再连接' };

  const s = v3Session();
  if (!(opts && opts.force) && s.ready && s.key) {
    return { ok: true, paired: true, reused: true, text: '本机已有可用 V3 会话（counter=' + s.counter + '），说明钥匙已在白名单' };
  }

  const r = await probeOnce(vin);
  log(r.paired ? 'ok' : 'warn', '探针：' + r.text);
  return {
    ok: r.paired,
    paired: r.paired,
    notWhitelisted: !!r.notWhitelisted,
    text:
      (r.paired ? '已入白名单：' : '尚未入白名单：') + r.text +
      '\n本机 Tesla key id = ' + teslaKeyId() + '（车机钥匙列表里通常显示为 Unknown key）'
  };
}

// 绑定结果的人话收尾：把「判据来源」写清楚，避免现场把「没回执」当成失败
export function pairVerdict(p, attempt) {
  return {
    ok: true,
    paired: true,
    text:
      '绑定成功 —— 探针第 ' + attempt + ' 次确认：' + p.text +
      '\n判据：session_info_request(VCSEC) 拿到了 status=OK 的 SessionInfo（官方 security.go:324 与 0Bu 都用这条）。' +
      '\n本机 Tesla key id = ' + teslaKeyId() + '，去车机 控制 > 安全 > 钥匙 里找那把 "Unknown key"。' +
      '\n下一步：到「上锁 / 解锁页」发 RKE 解锁验证'
  };
}

// 明文查询（不需要会话）；slot 只有 GET_WHITELIST_ENTRY_INFO 用得上
export async function infoRequest(type, name, timeoutMs, slot) {
  const req = { informationRequestType: type };
  if (slot !== undefined && slot !== null) req.slot = slot;
  return sendRequest({
    name: name || label('InformationRequestType', type),
    payload: encodeUnsignedMessage({ InformationRequest: req }),
    plain: true,
    done: () => true,
    maxMs: timeoutMs || DEFAULT_MAX_MS
  });
}

// 官方现行 vcsec.proto 只有这三种查询；GET_VEHICLE_INFO / GET_CAPABILITIES / GET_KEYSTATUS_INFO
// 已经从 proto 里删掉了，所以页面上也不给按钮
export const queries = {
  status: () => infoRequest(INFO.INFORMATION_REQUEST_TYPE_GET_STATUS, 'GET_STATUS'),
  whitelist: () => infoRequest(INFO.INFORMATION_REQUEST_TYPE_GET_WHITELIST_INFO, 'GET_WHITELIST_INFO'),
  whitelistEntry: (slot) =>
    infoRequest(INFO.INFORMATION_REQUEST_TYPE_GET_WHITELIST_ENTRY_INFO, 'GET_WHITELIST_ENTRY_INFO', DEFAULT_MAX_MS, slot)
};

// 主绑定路径：官方 security.go:338 SendAddKeyRequestWithRole ——
// 裸 ToVCSECMessage{signedMessage{PRESENT_KEY}}，不带会话。
//
// 三段状态机（照 0Bu main/vehicle_pairing.cpp:240-301 的量产实现，判据换成官方也认可的会话探针）：
//   0. 先打一针。已经能建会话 = 早就绑好了，直接返回 —— **绝不再发 add-key**。
//      0Bu 的原话：一轮只发一次（而不是每 ~45 秒重发一块）「也止住了钥匙登记成功后
//      车机反复弹配对请求」。
//   1. 发一次 whitelist-add。官方发完就 return；我们多等一会儿，因为 protocol.md:824 说
//      车端会先回 WAIT、刷完卡再回带 whitelistOperationStatus 的终态。
//   2. 交替进行：收车端回执（2.5 秒一片）+ 每 5 秒打一针会话探针。
//      0Bu 实测「车机加白后不发 completing commandStatus」，所以**探针先命中是正常路径**，
//      不能等到窗口耗尽才下结论；反过来，真拿到 whitelistOperationStatus 终态时以它为准
//      （那是车辆自己给的确切答案，比探针强）。
export async function bindKey(vin, opts) {
  mustConnect();
  const formFactor = opts && opts.formFactor !== undefined ? opts.formFactor : DEFAULT_FORM_FACTOR;
  // 时间片可覆盖，仅为了离线回归能在秒级跑完「探针命中 / 窗口耗尽」两条路径；
  // 默认值就是上面的常量，不改变任何协议字节。
  const windowMs = pick(opts, 'windowMs', PAIR_WINDOW_MS);
  const receiveMs = pick(opts, 'receiveMs', PAIR_RECEIVE_MS);
  const probeFirstMs = pick(opts, 'probeFirstMs', PROBE_FIRST_MS);
  const probeIntervalMs = pick(opts, 'probeIntervalMs', PROBE_INTERVAL_MS);
  const k = ensureKey((vin || vinOrEmpty() || '').toUpperCase());
  if (k.created) log('info', '已生成本机密钥对，接着把公钥交给车辆');

  const name = 'AddKey（刷卡配对）';
  const ffText = formFactorText(formFactor);
  log('info', name + ' 开始：formFactor=' + ffText + ' role=' + label('Role', ROLE.ROLE_DRIVER) + ' 本机 key id=' + teslaKeyId());

  // ---- 阶段 0：先确认是不是已经绑好了
  const vinUp = vinOrEmpty();
  if (!vinUp) return { ok: false, text: name + '：VIN 为空，先在首页填 VIN 再连接' };
  const pre = await probeOnce(vinUp);
  if (pre.paired) {
    return { ok: true, paired: true, already: true, text: '不用绑定，这把钥匙早就在白名单里且会话可用：' + pre.text + '\n直接去「上锁 / 解锁页」发指令即可' };
  }
  log('info', name + ' 预探针：' + pre.text + ' —— 继续发加白名单请求');

  // ---- 阶段 1：发一次（且仅一次）whitelist-add
  const envelope = buildAddKeyEnvelope(state.publicKey, ROLE.ROLE_DRIVER, formFactor);
  log('tx', name + ' PRESENT_KEY，不带会话 ' + toHex(envelope));

  const ctx = { name, domain: VC, vin: vinUp, session: v3Session(VC), requestId: null, sentAt: Date.now() };
  let body = null;
  try {
    body = await ble().send(prependLength(envelope), FIRST_RESPONSE_MS, true);
  } catch (e) {
    return { ok: false, text: name + ' 发送失败：' + ((e && e.message) || String(e)) + '\n先确认 ② 还连着（车辆同时最多约 3 个 BLE 连接，官方 Tesla App 在后台会占掉一个）' };
  }

  // ---- 阶段 2：等回执 / 打探针，谁先来算谁
  const deadline = Date.now() + windowMs;
  let nextProbe = Date.now() + probeFirstMs;
  let probes = 0;
  let sawWait = false;
  let lastStatus = '';

  for (;;) {
    while (body !== null && body !== undefined) {
      const r = decodeFrame(body, ctx);
      const cs = r.obj && r.obj.commandStatus;
      const st = cs && cs.operationStatus !== undefined ? cs.operationStatus : 0;

      // 车辆给了 whitelistOperationStatus —— 官方 protocol.md:836 认定这是唯一终态，
      // 它比探针权威（是车自己说的成/败），直接照它下结论。
      if (cs && cs.whitelistOperationStatus) {
        const info = cs.whitelistOperationStatus.whitelistOperationInformation === undefined
          ? 0
          : cs.whitelistOperationStatus.whitelistOperationInformation;
        const hint = PAIR_HINTS[info] || '';
        if (info !== 0) {
          return { ok: false, info, text: '车辆明确回执：' + label('WhitelistOperation_information_E', info) + (hint ? '\n' + hint : '') };
        }
        // 车说加好了，再打一针拿会话（0Bu 的第 3 步；官方 security.go:324 同一件事）
        const after = await probeOnce(vinUp);
        probes++;
        return {
          ok: true,
          paired: after.paired,
          info,
          text:
            '车辆回执已加入白名单（' + label('WhitelistOperation_information_E', 0) + '）' + (hint ? '\n' + hint : '') +
            '\n会话探针：' + after.text +
            '\n本机 Tesla key id = ' + teslaKeyId() + '（车机钥匙列表里显示为 Unknown key）' +
            (after.paired ? '\n下一步：到「上锁 / 解锁页」发 RKE 解锁验证' : '\n注意：车机可能还要几秒才同步完，稍后再按一次「④ 探针确认」')
        };
      }

      // WAIT = 等刷卡，不是「忙」，绝不能重发（重发会把配对窗口重新开始计时）
      if (st === UM.OPERATIONSTATUS_WAIT) {
        if (!sawWait) {
          sawWait = true;
          log('ok', '车辆已进入配对等待，' + TAP_HINT);
        }
      } else if (st === UM.OPERATIONSTATUS_ERROR) {
        return { ok: false, text: name + ' 被车端拒绝：' + r.app.text + '\n' + TAP_HINT };
      } else if (r.fault) {
        log('warn', name + ' 收到协议层 fault：' + label('MessageFault_E', r.fault) + '（继续等，不重发 add-key）');
      }
      body = await ble().receive(receiveMs);
    }

    if (Date.now() >= deadline) break;
    if (Date.now() < nextProbe) {
      body = await ble().receive(Math.min(receiveMs, Math.max(200, deadline - Date.now())));
      continue;
    }

    probes++;
    const p = await probeOnce(vinUp);
    nextProbe = Date.now() + probeIntervalMs;
    if (p.paired) return pairVerdict(p, probes);
    if (p.text !== lastStatus) {
      lastStatus = p.text;
      log('info', '探针第 ' + probes + ' 次未通过：' + p.text);
    } else {
      log('info', '探针第 ' + probes + ' 次结果同前');
    }
    if (!sawWait) log('info', '提示：车端始终没回 WAIT，可能根本没进入配对流程（车机屏幕有没有弹「添加钥匙」？BLE 连接数是否已被官方 App 占满？）');
    body = null; // 探针自己收走了响应，回到循环顶部按时间片继续等
  }

  return {
    ok: false,
    wait: true,
    probes,
    text:
      name + ' 已发出并等待 ' + Math.round(windowMs / 1000) + ' 秒（探针 ' + probes + ' 次），' +
      '既没拿到车端 whitelistOperationStatus 终态，也建不起会话 —— 判「没绑上」。\n' +
      '最后一次探针：' + (lastStatus || '没打上') + '\n' +
      '逐项排查：\n' +
      '1）车机屏幕有没有弹「添加钥匙 / Add key」并需要你点确认？没弹说明请求没进配对流程。\n' +
      '2）' + TAP_HINT + '\n' +
      '3）蓝牙连接数：一辆车同时最多约 3 个 BLE 连接（官方 Tesla App、手机钥匙、遥控钥匙共享）。' +
      '请退出并杀掉官方 App 后台，或在 Tesla App > 安全 > 钥匙 里移除不用的钥匙。\n' +
      '4）车是不是睡了：踩一脚刹车让车机亮屏后，重新点「③ 绑定」——' +
      '本函数每轮只发一次 add-key，重复点是为了让车机重新起配对流程。'
  };
}

// 备用路径（紧接上面的 bindKey；中间插了一段 INFOTAINMENT 动作，搜索「bindKeyViaSession」可跳到）：
// 官方 AddKeyWithRole —— 已经有一把能用的高权限钥匙时，直接走会话加密写进白名单，
// 不需要刷实体卡。
export async function bindKeyViaSession(vin, opts) {
  mustConnect();
  ensureKey((vin || vinOrEmpty() || '').toUpperCase());
  const formFactor = opts && opts.formFactor !== undefined ? opts.formFactor : DEFAULT_FORM_FACTOR;
  const payload = buildAddKeyPayload(state.publicKey, ROLE.ROLE_DRIVER, formFactor);
  const r = await sendRequest({ name: 'AddKey（会话内）', payload, done: doneWhitelist, maxMs: WHITELIST_MAX_MS });
  if (r.ok && r.summary && r.summary.kind === 'whitelist') {
    const okInfo = r.summary.info === 0;
    return { ok: okInfo, text: (okInfo ? '已加入白名单：' : '车辆拒绝加入白名单：') + r.summary.text };
  }
  return r;
}

export async function checkWhitelisted() {
  try {
    const r = await queries.whitelist();
    const wi = r.obj && r.obj.whitelistInfo;
    if (!wi) return { known: false, text: '白名单查询无结果：' + r.text };
    const entries = (wi.whitelistEntries || []).map(entryKeyId);
    const full = myKeyId();
    const mine = hasKey() && entries.some((e) => keyIdMatches(e, full));
    const slots = wi.slotMask === undefined ? null : wi.slotMask;
    return {
      known: true,
      mine,
      text:
        '白名单 ' + entries.length + ' 条 [' + entries.join(' ') + ']' +
        (slots !== null ? ' 可用槽位掩码=0b' + (slots >>> 0).toString(2) : '') +
        (hasKey()
          ? '；本机 Tesla key id=' + teslaKeyId() + '（完整 SHA1=' + (full || '-') + '）' +
            (mine ? ' → 在内' : ' → 不在内，需要重新绑定刷卡')
          : '（本机还没有密钥）')
    };
  } catch (e) {
    return { known: false, text: '白名单查询失败：' + ((e && e.message) || String(e)) };
  }
}

// 会话能不能建 = 钥匙在不在白名单。绑定之后优先看这个，别只盯着白名单列表。
export async function probeSession() {
  return probeEnrollment({ force: true });
}
