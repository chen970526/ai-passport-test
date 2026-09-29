// 单帧解码、协议层 / 应用层终态判读、发一条 V3 请求的重发循环。

import { ADDR_LEN, UM, newRoutingAddress, newUuid, buildPlainRequest, encryptCommand, requestIdOf, decryptResponse, parseFrame, summarize, label, toHex, equalBytes, prependLength } from '../protocol/index.js';
import { log } from '../infra/logging/log-bus.js';
import { state } from '../store/app-state.js';
import { v3Session, invalidateV3Session } from '../store/v3-session-store.js';
import { ble } from './connection-service.js';
import { REQUEST_FLAGS, RETRYABLE_FAULTS, RESYNC_FAULTS, MAY_HAVE_SUCCEEDED, MAX_ATTEMPTS, DEFAULT_MAX_MS, FIRST_RESPONSE_MS, sleep } from './dispatch-policy.js';
import { FAULT_HINT, GENERIC_ERROR_HINTS, mtuNote } from './response-hints.js';
import { VC, CS, domainText, appCodec, otherDomainKeys, recentIds, rememberRequestId, mustConnect, mustKey, vinOrEmpty } from './v3-context.js';
import { handshake, applyPiggyback } from './handshake-service.js';

// ---------------------------------------------------------------- 单帧解码

// 一帧 → { skipped } 或 { fault, opStatus, obj, app, text }
// ctx.domain 决定应用层按哪张表解：VCSEC=ToVCSECMessage，INFOTAINMENT=car_server.Response
//
// skipped = 这一帧没法判读（解不开 / 解不出来），按官方 dispatcher.go:302-308 的口径
// 「log 一行然后丢弃这一帧」处理，请求继续往下收，绝不因为一帧看不懂就把整条命令判死。
// 真机 GetVehicleData 就吃过这个亏：车机先回一帧带 AES_GCM_Response_data 但 payload 为空
// 的受理帧，老代码 return fatal，sendRequest 立刻终止，真正的数据帧再也看不到。
export function decodeFrame(body, ctx) {
  const codec = appCodec(ctx.domain);
  const parsed = parseFrame(body);

  // 车辆直接回裸 FromVCSECMessage（加白名单那条 PRESENT_KEY 老路会这样）
  if (parsed.kind !== 'routable') {
    const obj = parsed.vcsec || {};
    const app = codec.summarize(obj);
    log('rx', ctx.name + ' 裸 ' + codec.name + ' 帧：' + app.text + '\n' + parsed.text);
    return { fault: 0, opStatus: 0, obj, app, text: parsed.text };
  }

  const rm = parsed.rm;

  // 配对闸门（对齐官方 dispatcher.go:252-293 的 receiverKey = {domain, address, uuid} 三路配对）
  // 权威依据：protocol.md:36-38「车辆用路由地址把响应退回给对应客户端，并把自己的 to / from
  // 两个字段对调」+ universal_message.proto:16-21（Destination 是个 oneof：要么带 domain、
  // 要么带 routing_address，不会同时有）+ protocol.md:52-55（请求里的 uuid 会被原样复制进
  // 响应的 request_uuid；受内存限制 VCSEC 的回包通常不填）。
  // 三条闸门各自**只在本帧真带了那一线索时**才否决，线索缺失一律放行（老车 / VCSEC 常不带）。
  // 少了这几道，上一条命令的残留帧和车辆自己发的周期广播都会被当成本次请求的响应：
  // 轻则拿错的 request_hash 去验 tag（现场只看到一句误导人的「响应 GCM tag 不符」），
  // 重则像真机那次 —— VCSEC 的广播帧被当成车机 GetVehicleData 的终态，报「成功：actionStatus=OK」，
  // 实际一个 vehicleData 字节都没有。
  const theirs = rm.to_destination ? rm.to_destination.routing_address : null;
  if (ctx.routingAddress && theirs && theirs.length === ADDR_LEN && !equalBytes(theirs, ctx.routingAddress)) {
    log('warn', ctx.name + ' 帧的路由地址不是本次请求（本帧 ' + toHex(theirs) + '，本次 ' + toHex(ctx.routingAddress) + '），按官方丢掉不解密');
    return { skipped: true, fault: 0, opStatus: 0, text: '串台帧：路由地址 ' + toHex(theirs) + ' 不是本次请求' };
  }

  // request_uuid：只在「非空」时否决。tesla-key-esp32 的 ARCHITECTURE.md:106 与
  // docs/adr/0003-replayed-tesla-responses.md:46 写死了这条规则 —— 响应带了非空 request_uuid
  // 就必须对上某个未决请求，对不上直接丢（防重放）。我们串行发、一条请求一个 uuid，
  // 所以要求它等于本次的 uuid。
  const reqUuid = rm.request_uuid;
  if (ctx.uuid && reqUuid && reqUuid.length && !equalBytes(reqUuid, ctx.uuid)) {
    log('warn', ctx.name + ' 帧的 request_uuid 不是本次请求（本帧 ' + toHex(reqUuid) + '，本次 ' + toHex(ctx.uuid) + '），按官方丢掉不解密');
    return { skipped: true, fault: 0, opStatus: 0, text: '串台帧：request_uuid ' + toHex(reqUuid) + ' 不是本次请求' };
  }

  // from_destination 的域：车机回包会说自己来自 INFOTAINMENT，VCSEC 的周期广播来自 VEHICLE_SECURITY。
  // 域对不上 = 这帧压根不是本次请求的答案（protocol.md:37-38 的 to/from 对调）。
  const fromDomain = rm.from_destination ? rm.from_destination.domain : undefined;
  if (ctx.domain !== undefined && fromDomain !== undefined && fromDomain !== ctx.domain) {
    log('warn', ctx.name + ' 帧来自 ' + domainText(fromDomain) + '，本次请求发往 ' + domainText(ctx.domain) + '，按官方丢掉不解密');
    return { skipped: true, fault: 0, opStatus: 0, text: '串台帧：来自 ' + domainText(fromDomain) + '，不是本次请求的 ' + domainText(ctx.domain) };
  }

  const st = rm.signedMessageStatus || {};
  const fault = st.signed_message_fault || 0;
  const opStatus = st.operation_status || 0;
  const proto = summarize(rm);
  log(fault ? 'warn' : 'rx', ctx.name + ' 协议层：' + proto.text);
  if (rm.session_info) applyPiggyback(rm, ctx);

  const sd = rm.signature_data || {};

  // 协议层错误帧：车辆用 signedMessageStatus 给出了终态结论，而且**一个密文字节都没发**
  // （signature_data 里的 nonce / counter / tag 是给那份被它自己挡下的大响应准备的，
  //  响应体从来没上线）。这种帧本地永远验不过 GCM tag —— 拿它去试解密只会刷出一句
  //  「期望/实际 tag 不符」，把车辆明说的拒绝盖掉。
  // 取证：protocol.md:59-61「车辆用 signedMessageStatus 表示协议层错误，应用层错误才会出现在
  //       protobuf_message_as_bytes 里」；universal_message.proto:57（fault=25 的官方注释）。
  // 真机 GetVehicleData 的 fault=25 就是被老代码判成「解不开的帧」→ skipped → 一路等到
  // 「等待终态超时」，人只看到超时，看不到车其实已经回答了。
  if ((fault !== 0 || opStatus === UM.OPERATIONSTATUS_ERROR) && sd.AES_GCM_Response_data && !(rm.protobuf_message_as_bytes && rm.protobuf_message_as_bytes.length)) {
    const why = protoOutcome(fault, opStatus);
    log('warn', ctx.name + ' 车辆回的是协议层错误帧（没有响应体），不再拿它试解密：' + why.text);
    return {
      fault,
      opStatus,
      obj: {},
      refused: true,
      hint: FAULT_HINT[fault] || '',
      app: { kind: 'refused', status: 2, text: '车辆拒绝返回响应体：' + why.text + (FAULT_HINT[fault] ? '。' + FAULT_HINT[fault] : '') },
      text: why.text
    };
  }

  let obj = {};
  let text = '';
  try {
    if (sd.AES_GCM_Response_data) {
      const d = decryptResponse(rm, {
        domain: ctx.domain,
        vin: ctx.vin,
        session: ctx.session,
        requestId: ctx.requestId,
        previousRequestIds: ctx.previous,
        altKeys: otherDomainKeys(ctx.domain)
      });
      if (!d.ok) {
        // tag 不符时把「车辆可能用来算 AAD 的每个字段」连同逐字段试算结论一起打全，
        // 现场只需要把这一段贴回来就能定位，不用再来一轮盲猜
        log('error', ctx.name + ' 响应解密诊断：' + d.error + '\n' + d.detail);
        const evidence = '（本帧 ' + body.length + 'B，request_uuid=' + (rm.request_uuid ? toHex(rm.request_uuid) : '无') +
          '，to=' + (rm.to_destination && rm.to_destination.routing_address ? '有' : '无') +
          '，from=' + (rm.from_destination ? domainText(rm.from_destination.domain) : '无') + '）';
        return { skipped: true, fault, opStatus, text: ctx.name + ' 响应解密失败：' + d.error + evidence };
      }
      const inner = codec.decode(d.plaintext);
      obj = inner.obj;
      text = inner.text;
      log('rx', ctx.name + ' 解密后（车辆 counter=' + d.counter + '）:\n' + text);
    } else {
      const inner = codec.decode(rm.protobuf_message_as_bytes);
      obj = inner.obj;
      text = inner.text;
      log('rx', ctx.name + ' 应用层:\n' + text);
    }
  } catch (e) {
    return { skipped: true, fault, opStatus, text: ctx.name + ' 响应解析失败：' + ((e && e.message) || String(e)) };
  }

  const empty = !obj || Object.keys(obj).length === 0;
  const app = empty ? { kind: 'empty', status: 0, text: '空响应（车辆已受理，应用层没有任何字段）' } : codec.summarize(obj);
  return { fault, opStatus, obj, app, text };
}

// 协议层结论，对应 protocol.GetError：先看 fault，再看 operation_status
export function protoOutcome(fault, opStatus) {
  if (fault) {
    const text = label('MessageFault_E', fault);
    if (RESYNC_FAULTS.indexOf(fault) >= 0) return { action: 'resync', text };
    if (RETRYABLE_FAULTS.indexOf(fault) >= 0) return { action: 'busy', text };
    return { action: 'fail', text };
  }
  if (opStatus === UM.OPERATIONSTATUS_WAIT) return { action: 'busy', text: 'operation_status=WAIT' };
  if (opStatus === UM.OPERATIONSTATUS_ERROR) return { action: 'fail', text: 'operation_status=ERROR' };
  return { action: 'pass' };
}

// 应用层结论，按域分岔：
//   VCSEC —— vcsec.go unmarshalVCSECResponse：先看 nominalError，再看 commandStatus
//   INFOTAINMENT —— infotainment.go:37-43：只看 actionStatus.result，
//     ERROR 时把 result_reason.plain_text 当成失败原因摊给人看（官方那句
//     "car could not execute command: <plain_text>" 就是这个）。
//     car_server.proto:160-164 没有 WAIT 这一档，所以车机侧永远不会 busy。
export function appOutcome(obj, domain) {
  if (domain !== VC) {
    const as = obj.actionStatus;
    if (as && as.result === CS.OPERATIONSTATUS_ERROR) {
      const reason = as.result_reason && as.result_reason.plain_text ? as.result_reason.plain_text : '车机未给出原因';
      return { action: 'fail', text: 'actionStatus=ERROR：' + reason };
    }
    return { action: 'pass' };
  }
  if (obj.nominalError) {
    return { action: 'fail', text: 'nominalError ' + label('GenericError_E', obj.nominalError.genericError) };
  }
  const cs = obj.commandStatus;
  if (cs) {
    const st = cs.operationStatus === undefined ? 0 : cs.operationStatus;
    if (st === UM.OPERATIONSTATUS_WAIT) return { action: 'busy', text: 'commandStatus=WAIT' };
    if (st === UM.OPERATIONSTATUS_ERROR) {
      const w = cs.whitelistOperationStatus;
      if (w) {
        const info = w.whitelistOperationInformation === undefined ? 0 : w.whitelistOperationInformation;
        if (info !== 0) return { action: 'fail', text: '白名单被拒：' + label('WhitelistOperation_information_E', info) };
      }
      if (!cs.signedMessageStatus) return { action: 'fail', text: 'operationStatus=ERROR 且车辆没给原因' };
    }
  }
  return { action: 'pass' };
}

// 车端 GenericError → 下一步。appOutcome 把码渲染成 GENERICERROR_XXX(n)，这里按枚举名匹配。
// 放在 dispatcher 而不是各条命令里：锁车 / 解锁 / 驾驶授权任何一条被拒，人都该看到原因，
// 而不是只有 RemoteDrive 带提示。
export function genericErrorHint(text) {
  if (!text) return '';
  for (const key of Object.keys(GENERIC_ERROR_HINTS)) {
    if (text.indexOf(key) >= 0) return GENERIC_ERROR_HINTS[key];
  }
  return '';
}

// ---------------------------------------------------------------- 发一条 V3 请求

// opts: { name, domain, payload, plain, done, maxMs }
//   domain      → VCSEC（默认）或 INFOTAINMENT；决定用哪一份会话、应用层按哪张表解
//   plain=true  → 明文（InformationRequest 这类不需要会话的查询，官方用 AuthMethodNone）
//   done(obj, summary) → 是不是终态；不传表示「第一帧就算完」
// 返回 { ok, text, obj, summary, timeout, fault }
export async function sendRequest(opts) {
  mustConnect();
  const name = opts.name || 'V3 请求';
  const done = opts.done || function () { return true; };
  const domain = opts.domain === undefined ? VC : opts.domain;
  const who = domainText(domain);
  const vin = vinOrEmpty();
  if (!vin) return { ok: false, text: name + '：VIN 为空，先在首页填 VIN 再连接' };
  if (!opts.plain) mustKey();

  const session = v3Session(domain);
  // 响应配对：官方 dispatcher.go:252-285 组 receiverKey{domain, address, uuid} ——
  // address 永远是响应帧 to_destination.routing_address，而 uuid 只在**非 VCSEC 域**参与
  // （:259-261 `if key.domain != DOMAIN_VEHICLE_SECURITY { copy(key.uuid[:], requestUUID) }`）。
  // 真机上一批响应根本不带 request_uuid（protocol.md:52-55 也说了 VCSEC 受内存限制通常不填），
  // 所以闸门**只在帧里真带了非空 request_uuid 时才拿它否决**，不带就只看地址和域，
  // 既堵住串台 / 重放（ARCHITECTURE.md:106、ADR-0003），又不会把能用的响应丢掉。
  // 整条请求（含所有重发）复用同一组 addr / uuid，否则响应会掉进没人领的收件箱 ——
  // 这条只适用于车机域。VCSEC 见下面的 resignVCSEC。
  let routingAddress = newRoutingAddress();
  let uuid = newUuid();
  const deadline = Date.now() + (opts.maxMs || DEFAULT_MAX_MS);
  let resynced = false;

  // 两种「重发」在官方是两件事，字节必须区别对待：
  //
  // A. 传输层重试 —— dispatcher.go:434-460：一次 Send 只 `proto.Marshal` 一遍，
  //    内层 for 反复写的就是**同一份已编码字节**。之前这里每次重试都重新 encryptCommand
  //    （counter / nonce / GCM tag 全变），而响应 AAD 里的 request_hash 正是那个 tag
  //    （peer.go RequestID）。于是车机对**第一次**请求的迟到回包，会被第二次的 requestId
  //    拿去验 tag，结果正好是误导人的「响应 GCM tag 不符」→ 真数据帧被当坏帧丢掉 → 等终态超时。
  //    GetVehicleData 这种慢回包最容易撞上。
  //
  // B. 应用层重试 —— vcsec.go:84-105 的 getVCSECResult 外层 for：车辆回 WAIT（ErrBusy）时
  //    它调的是**整个 dispatcher.Send**，而每次 Send 都会重新 session.authorize
  //    （counter++ / 新 nonce / 新 tag，:428）并给 VCSEC 域**重新随机 routingAddress**、
  //    重新生成 uuid（:392-413）。
  //
  // 本项目过去把 A、B 混成一份字节，代价就是真机那句「授权启动后锁车要点两次」：
  // protocol.md:547-549 写明 Infotainment 用滑动窗口容忍乱序，**VCSEC 要求消息按 counter
  // 顺序到达**，重复 counter 会被判 MESSAGEFAULT_ERROR_REPEATED_COUNTER。所以 WAIT 之后
  // 原样重发那几帧，车辆全部当作旧包丢掉；必须等下一次按下按钮（新的 sendRequest →
  // counter+1）才真正生效。
  // 结论：VCSEC 域每次重发都重新签一份；车机域继续复用同一份字节。
  const resignVCSEC = !opts.plain && domain === VC;
  let built = null;
  let ctx = null;
  let frames = 0; // 已经签出过几份帧（用于判断要不要换 addr / uuid）
  let stale = false; // 会话作废过，手里的旧帧属于上一个 epoch，绝不能再上线

  for (let attempt = 1; ; attempt++) {
    if (!opts.plain) {
      const h = await handshake(false, domain);
      if (!h.ok) return { ok: false, text: name + '：' + h.text };
    }

    // 手里的帧还能不能用：会话作废过（旧帧属于上一个 epoch）或 VCSEC 要重发 → 都得重新签一份。
    if (stale || resignVCSEC) { built = null; stale = false; }

    if (!built) {
      // 第二份及以后的帧：按官方 dispatcher.go:392-413 换一组新的路由地址 / uuid
      if (frames > 0) { routingAddress = newRoutingAddress(); uuid = newUuid(); }
      let buildError = '';
      try {
        built = opts.plain
          ? buildPlainRequest({ domain, routingAddress, payload: opts.payload, uuid, flags: REQUEST_FLAGS })
          : encryptCommand({
              domain,
              vin,
              session,
              publicKey: state.publicKey,
              payload: opts.payload,
              flags: REQUEST_FLAGS,
              routingAddress,
              uuid
            });
      } catch (e) {
        buildError = (e && e.message) || String(e);
      }
      if (!built) {
        if (!opts.plain && attempt < MAX_ATTEMPTS) {
          log('warn', name + ' 组包失败（' + buildError + '），作废' + who + '会话后重新握手');
          invalidateV3Session('组包时会话参数不全', domain);
          await sleep(1000);
          continue;
        }
        return { ok: false, text: name + ' 组包失败：' + buildError };
      }

      frames++;
      ctx = {
        name,
        domain,
        vin,
        session,
        routingAddress,
        uuid,
        requestId: requestIdOf(built.message),
        previous: (recentIds[domain] || []).slice(),
        sentAt: Date.now()
      };
      if (ctx.requestId) rememberRequestId(domain, { name: name + '（组包）', id: ctx.requestId });
      log(
        'tx',
        name +
          (opts.plain ? ' 明文请求 ' : ' ' + who + ' counter=' + built.counter + ' nonce=' + toHex(built.nonce) + ' 密文=' + built.ciphertext.length + 'B ') +
          toHex(built.bytes)
      );
    }

    let body = null;
    try {
      // 第一次发之前清掉上一批残留帧（它们属于更早的请求，路由地址对不上）；
      // 重发时**保留队列**：车机域复用同一份字节，requestId 不变，队列里可能正躺着本请求的迟到回包。
      body = await ble().send(prependLength(built.bytes), FIRST_RESPONSE_MS, attempt > 1);
      if (attempt > 1) {
        log('warn', name + ' 第 ' + attempt + '/' + MAX_ATTEMPTS + ' 次发送：' +
          (resignVCSEC ? 'VCSEC 重新签一份（counter 必须前进）' : '复用同一份已编码字节'));
      }
    } catch (e) {
      return { ok: false, text: name + ' 发送失败：' + ((e && e.message) || String(e)) };
    }

    let first = true;
    let last = null;
    let dropped = 0;
    let dropFirst = '';
    let dropLast = '';
    const dropText = () => '已丢弃 ' + dropped + ' 帧：' + dropFirst + (dropLast && dropLast !== dropFirst ? ' ‖ 最后一帧：' + dropLast : '');
    for (;;) {
      if (body === null) {
        if (first) {
          if (attempt < MAX_ATTEMPTS) {
            log('warn', name + ' 没收到响应，1 秒后重发（第 ' + (attempt + 1) + '/' + MAX_ATTEMPTS + ' 次）');
            await sleep(1000);
            break;
          }
          return { ok: false, timeout: true, text: name + '：车辆 ' + FIRST_RESPONSE_MS + ' 秒内没有任何响应' };
        }
        if (Date.now() >= deadline) {
          return { ok: false, timeout: true, text: name + ' 等待终态超时（最后一帧：' + (last ? last.text : '无') + (dropped ? '；' + dropText() : '') + '）' };
        }
        await sleep(1000);
        body = await ble().receive(Math.max(500, Math.min(3000, deadline - Date.now())));
        continue;
      }
      first = false;

      const r = decodeFrame(body, ctx);
      if (r.skipped) {
        // 看不懂的帧只丢弃，继续等 —— 官方 dispatcher.go:302-308 就是这么处理的
        dropped++;
        if (!dropFirst) dropFirst = r.text;
        dropLast = r.text;
        last = null;
        if (Date.now() >= deadline) return { ok: false, timeout: true, text: name + ' 等待终态超时（所有帧都解不开：' + dropText() + '）' };
        await sleep(500);
        body = await ble().receive(Math.max(500, Math.min(3000, deadline - Date.now())));
        continue;
      }
      last = r;

      const why = r.fault || r.opStatus ? protoOutcome(r.fault, r.opStatus) : appOutcome(r.obj, domain);
      if (why.action === 'resync' && !resynced) {
        resynced = true;
        stale = true; // 旧帧是在上一个 epoch 的密钥下签的，重新握手后必须重新组包
        log('warn', name + ' 车辆回 ' + why.text + '，' + who + ' counter/epoch 疑似失步，重新握手');
        invalidateV3Session('车辆回 ' + why.text, domain);
        await sleep(1000);
        break;
      }
      if (why.action === 'busy') {
        if (attempt < MAX_ATTEMPTS) {
          log('warn', name + ' ' + why.text + '，1 秒后重发');
          await sleep(1000);
          break;
        }
        return { ok: false, text: name + ' 车辆一直回 ' + why.text, fault: r.fault };
      }
      if (why.action === 'fail') {
        // 车辆给出的协议层结论：把对应的下一步一并写出来，别让现场只剩一个枚举名
        const hint = [r.hint ? r.hint + mtuNote() : '', genericErrorHint(why.text)].filter(Boolean).join('\n');
        const maybe = MAY_HAVE_SUCCEEDED.indexOf(r.fault) >= 0
          ? '\n注意：按官方口径（error.go:195-198），这种拒绝属于「命令可能已经执行」—— 车收下了请求，只是不发答案。'
          : '';
        return { ok: false, text: name + ' 被拒：' + why.text + (hint ? '\n' + hint : '') + maybe, fault: r.fault };
      }

      if (done(r.obj, r.app)) {
        return { ok: true, obj: r.obj, summary: r.app, text: name + ' 完成：' + r.app.text, raw: r.text };
      }
      if (Date.now() >= deadline) {
        return { ok: false, timeout: true, text: name + ' 等待终态超时（最后一帧：' + r.app.text + '）' };
      }
      await sleep(1000);
      body = await ble().receive(Math.max(500, Math.min(3000, deadline - Date.now())));
    }
    // break 到这里 = 整条重发
  }
}

// ---------------------------------------------------------------- 三类终态判据

// RKE / 闭锁器：vcsec.go executeRKEAction —— 收到一条「没有 commandStatus」的报文才算完
export const doneCommand = (obj) => !(obj && obj.commandStatus);

// 白名单操作：vcsec.go isWhitelistOperationComplete —— 必须带 whitelistOperationStatus 才是终态
export const doneWhitelist = (obj) => !!(obj && obj.commandStatus && obj.commandStatus.whitelistOperationStatus);
