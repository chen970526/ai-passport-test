// 页面唯一的动作入口：现在只有 V3 一套协议，这一层的作用变成
//   1）把 domain / services 各功能接口的函数按「页面上的按钮名」统一包一层日志分段
//      （-----start----- 动作名 …… -----end----- 动作名），复制日志时能一眼看清是谁产生的；
//   2）给报文控制台（③ 页）提供整套编解码工具。
//
// 约定：所有动作都返回 { ok, text, ... }，页面只看这两个字段。

import {
  RKE,
  CLOSURE,
  FORM_FACTORS,
  DEFAULT_FORM_FACTOR,
  formFactorText,
  queries as rawQueries,
  handshake as rawHandshake,
  requestEphemeralKey as rawRequestEphemeralKey,
  probeSession as rawProbeSession,
  bindKey as rawBindKey,
  bindKeyViaSession as rawBindKeyViaSession,
  checkWhitelisted as rawCheckWhitelisted,
  infoRequest as rawInfoRequest,
  statusText as rawStatusText
} from '../domain/index.js';
import { sendRke as rawSendRke, sendClosure as rawSendClosure, requestDrive as rawRequestDrive } from './vcsec/index.js';
import {
  VEHICLE_DATA,
  VEHICLE_DATA_ALL,
  chargePortDoor as rawChargePortDoor,
  flashLights as rawFlashLights,
  honkHorn as rawHonkHorn,
  hvacAuto as rawHvacAuto,
  windowAction as rawWindowAction,
  pingInfotainment as rawPingInfotainment,
  vehicleData as rawVehicleData
} from './infotainment/index.js';
import { action } from '../infra/logging/action-tracer.js';
import { applyVehicleData } from '../store/vehicle-store.js';
import { recordResult, recordError } from '../store/diagnostic-store.js';
import {
  V3_SPEC,
  encode,
  decode,
  inspect,
  label,
  parseFrame,
  summarize,
  summarizeVcsec
} from '../protocol/index.js';
import { prependLength } from '../infra/ble/frame-codec.js';

// ---------------------------------------------------------------- 动作转发
//
// tracked() = action() 的日志分段 + 诊断台账登记，日志文案一个字没多、一个字没改：
// 分段行仍由 action-tracer 产生，台账只是把 { ok, text } 另存一份给诊断页读，
// 免得那个页面去反向解析日志文本。tag 只用来区分同一个物理动作的不同协议路径
// （充电盖板：车机域 chargePortDoor 与 VCSEC ClosureMoveRequest 两条都在用）。
function tracked(name, fn, tag) {
  return action(name, async () => {
    try {
      const r = await fn();
      if (r && typeof r.ok === 'boolean') recordResult(name, r, tag);
      return r;
    } catch (e) {
      recordError(name, e, tag);
      throw e;
    }
  });
}

export const version = () => 'v3';
export const versionName = () => 'V3';

export const bindKey = (vin, opts) => tracked('绑定（刷钥匙卡）', () => rawBindKey(vin, opts));
export const bindKeyViaSession = (vin, opts) => tracked('会话内加白名单', () => rawBindKeyViaSession(vin, opts));
export const probeSession = () => tracked('探针确认是否已入白名单', () => rawProbeSession());
export const requestEphemeralKey = () => tracked('重新握手', () => rawRequestEphemeralKey());
export const handshake = (force, domain) => tracked('V3 握手', () => rawHandshake(force, domain));
export const sendRke = (a, name) => tracked(name || 'RKE 动作', () => rawSendRke(a, name), 'VCSEC');
export const sendClosure = (fields, name) => tracked(name || '闭锁器请求', () => rawSendClosure(fields, name), 'VCSEC');
// 驾驶授权（RemoteDrive）：协议上是一条独立的 RKEAction，官方也把它和 Unlock 分开
// （vcsec.go:200 与 Unlock 各自调一次 executeRKEAction）。真机验证过 BLE 发它车辆是接受的，
// 所以下面 unlockAndDrive() 把它串在解锁后面 —— 但这条本身仍然保持独立，
// 2 分钟授权窗口过期后还要能单独再按一次。台账名 = 页面 lastResult() 的键，别改字。
export const remoteDrive = () => tracked('驾驶授权（RemoteDrive）', () => rawRequestDrive(), 'VCSEC');

// 解锁 + 驾驶授权连着发：手机钥匙那条「拉开门就能开走」的路，省掉上车后再点一次。
//
// 编排放在这一层（而不是塞进 rke.js / drive.js）有两个硬理由：
//   1）UNLOCK 与 驾驶授权（RemoteDrive） 各自进一条诊断台账，页面上两行读数互不覆盖，
//      「门开了但授权被拒」这种现场不会被合并成一句含糊的话；
//   2）services/vcsec/* 只依赖 domain，反向调用会成环。
//
// 口径：只有解锁拿到终态成功才补发驾驶授权（解锁失败时车压根没开，发它没意义）；
// 驾驶授权被拒不会把解锁说成失败 —— 两条结论在 text 里如实并列，
// 绝不因为「通常应该能开走」就代替车辆下一个启动成功的结论。
export const unlockAndDrive = () =>
  tracked('解锁并授权驾驶', async () => {
    const u = await sendRke(RKE.RKE_ACTION_UNLOCK, 'UNLOCK');
    if (!u || !u.ok) return u;
    const d = await remoteDrive();
    return {
      ok: true,
      unlock: u,
      drive: d,
      text: u.text + '\n驾驶授权：' + (d ? d.text : '未发起（车辆没给回执）')
    };
  }, 'VCSEC');
export const infoRequest = (type, name, timeoutMs, slot) =>
  tracked(name || '信息查询', () => rawInfoRequest(type, name, timeoutMs, slot));
export const checkWhitelisted = () => tracked('查白名单', () => rawCheckWhitelisted());

// ---------------------------------------------------------------- 车机域（car_server）动作
//
// 这一组走的是 INFOTAINMENT 那份会话，不是 VCSEC：协议层区别见 src/services/infotainment/ 的
// 「INFOTAINMENT（car_server）动作」段（官方 pkg/vehicle/infotainment.go:19-45）。
export const chargePortDoor = (open) =>
  tracked(open ? '打开充电盖板' : '关闭充电盖板', () => rawChargePortDoor(open), 'INFOTAINMENT');
// 寻车提示：车机域的两个空 message（闪灯 / 鸣笛），不动车上任何可动件，出问题时最先试这两个
export const flashLights = () => tracked('闪灯', () => rawFlashLights(), 'INFOTAINMENT');
export const honkHorn = () => tracked('鸣笛', () => rawHonkHorn(), 'INFOTAINMENT');
// 一键启动/关闭空调（HvacAutoAction）与车窗通风/关窗（VehicleControlWindowAction）
export const hvacAuto = (on) => tracked(on ? '启动空调' : '关闭空调', () => rawHvacAuto(on), 'INFOTAINMENT');
export const windowAction = (mode) =>
  tracked(mode === 'close' ? '关窗' : '车窗通风', () => rawWindowAction(mode), 'INFOTAINMENT');
export const pingInfotainment = () => tracked('Ping（车机探针）', () => rawPingInfotainment(), 'INFOTAINMENT');
// 拉到数据就顺手写进车辆状态仓库：页面只要订阅，不需要各自再解析一遍嵌套字段。
export const vehicleData = (keys) =>
  tracked('GetVehicleData' + (keys && keys.length ? ' ' + keys.join('+') : '（全部）'), async () => {
    const r = await rawVehicleData(keys);
    applyVehicleData(r);
    return r;
  }, 'INFOTAINMENT');
// 车辆信息可勾选的类别（键名即 src/services/infotainment/vehicle-data.js 的 VEHICLE_DATA 类别，页面拿它渲染选项）
export const vehicleDataCategories = () => Object.keys(VEHICLE_DATA);
export const vehicleDataAll = () => VEHICLE_DATA_ALL;

export const queries = {
  status: () => tracked('查车辆状态', () => rawQueries.status()),
  whitelist: () => tracked('查白名单', () => rawQueries.whitelist()),
  whitelistEntry: (slot) => tracked('查白名单条目 ' + slot, () => rawQueries.whitelistEntry(slot))
};

// 枚举：V3 的 RKEAction_E 只剩 0/1/20/29/30，其余动作走 closureMoveRequest
export const rkeEnum = (name) => RKE[name];
export const closureEnum = (name) => (CLOSURE ? CLOSURE[name] : undefined);
export { label };

// 绑定页的「钥匙类型」选择器：官方四个 FORM_FACTOR 枚举值全开，默认值由 src/domain/v3-context.js 定
export const formFactorOptions = () =>
  FORM_FACTORS.map((f) => ({ value: f.value, name: formFactorText(f.value), note: f.note }));
export const defaultFormFactor = () => DEFAULT_FORM_FACTOR;

// 同步的状态行，不产生日志，所以不用 action() 包
export const statusText = () => rawStatusText();

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
