// ---------------------------------------------------------------- 车辆状态仓库
//
// GetVehicleData 的六条回包在 src/services/infotainment/vehicle-data.js 里合并成一份
// vehicle.proto 的嵌套结构（charge_state / climate_state / drive_state / location_state /
// closures_state / tire_pressure_state），字段名和单位全是车机原样。页面若各自去挖嵌套、
// 各自决定「字段没回」怎么显示，同一台车在两个页面上就会写成两种样子。
//
// 本模块只做一件事：**把那份嵌套结构归一成一个扁平视图**，页面读视图，不读原始字段。
// 三条口径：
//   1. 「未知」只有一种表达 —— 数值/布尔用 null，文本用 UNKNOWN。车机没回某个字段和
//      车机回了 false 是两回事（locked 回了 false = 确认未上锁；没回 = 不知道），
//      所以这里一律不做 `|| false` 之类的兜底。
//   2. 单位换算只发生在显示层：vehicle.proto 的续航/速度/里程是英里、mph、百分之一英里，
//      胎压是 bar（vehicle.proto 注释），温度是摄氏度。原始值一律保留在 raw 里，
//      视图里的 xxxKm 之类是换算结果，绝不回头去改协议字段。
//   3. 伪枚举（ChargingState / ShiftState / ChargePortLatchState …）解出来是 { type: 'P' }
//      这种形状（见 src/protocol/v3/summary.js 的 kind 用法），这里统一取 type 字符串。
//
// 状态是内存级的、带时间戳的：断线之后界面上显示的仍然是「最后一次拉到的样子」，
// 所以页面必须把 updatedAt 一起显示出来，别让人误读成实时状态；
// 而换车 / 清档这类「这台车已经不再是我们那台车」的时刻，由 services/credential-service.js
// 的 forgetBindProfile() 显式调用 clearVehicle()。

import { log } from '../infra/logging/log-bus.js';

export const UNKNOWN = '未知';
export const MI_TO_KM = 1.609344;

const listeners = [];

// 车辆状态本体：raw 是车机原样的合并结果，updatedAt 是「这份数据属于什么时候」。
export const vehicle = {
  raw: null,
  categories: [], // 本次真的带回数据的类别（charge/climate/…），不是字段名
  updatedAt: 0,
  source: '' // 产生这份数据的那个动作的收尾文案，诊断页要能追溯
};

export function subscribeVehicle(cb) {
  if (listeners.indexOf(cb) < 0) listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function notify() {
  for (const cb of listeners.slice()) {
    try {
      cb(vehicle);
    } catch (e) {
      /* 页面销毁之类的错误不许冒泡回命令派发 */
    }
  }
}

export function clearVehicle(why) {
  const had = !!vehicle.raw;
  vehicle.raw = null;
  vehicle.categories = [];
  vehicle.updatedAt = 0;
  vehicle.source = '';
  if (had && why) log('info', '车辆状态已清除（' + why + '）');
  notify();
}

// 数值：只有真的是数字才算「有值」，其余（undefined / null / 字符串）一律算未知。
function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

// 布尔：车机没回这个字段是 null（未知），回了才是 true/false。
function bool(v) {
  return v === true || v === false ? v : null;
}

// 伪枚举 → 字符串：{ type: 'P' } → 'P'；已经是字符串就直接用；没回 → null。
function kindOf(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return typeof v.type === 'string' ? v.type : null;
}

// 摄氏温度：保留一位小数就够（车机给的是 float，显示 21.5℃ 而不是 21.500000953674316℃）。
function temp(v) {
  const n = num(v);
  return n === null ? null : Math.round(n * 10) / 10;
}

function mileToKm(mi) {
  const n = num(mi);
  return n === null ? null : Math.round(n * MI_TO_KM * 10) / 10;
}

// 六个子状态一次取齐：缺哪个就是 null，页面自己决定显示什么。
function parts(raw) {
  const d = raw || {};
  return {
    closures: d.closures_state || null,
    charge: d.charge_state || null,
    climate: d.climate_state || null,
    drive: d.drive_state || null,
    location: d.location_state || null,
    tire: d.tire_pressure_state || null
  };
}

const CATEGORY_OF_FIELD = {
  closures_state: 'closures',
  charge_state: 'charge',
  climate_state: 'climate',
  drive_state: 'drive',
  location_state: 'location',
  tire_pressure_state: 'tirePressure'
};

// 车机在每条 vehicleData 尾部都带一个官方 vehicle.proto 里没有的字段 999
// （解出来记成 f999，值恒为 1，见 src/services/infotainment/vehicle-data.js 的注释）。
// 它不是状态类别，不能混进 categories，否则又会算出「问 6 类回 7 类」。
function categoriesOf(raw) {
  const keys = Object.keys(raw || {});
  const cats = [];
  for (const k of keys) {
    const c = CATEGORY_OF_FIELD[k];
    if (c && cats.indexOf(c) < 0) cats.push(c);
  }
  return cats;
}

const SHIFT_TEXT = { P: '已驻车', R: '倒挡', N: '空挡', D: '前进', Invalid: '未知', SNA: '不可用' };

// 视图模型：新 UI 六个页面共用这一份，字段名即界面上的语义。
export function vehicleView() {
  const p = parts(vehicle.raw);
  const c = p.closures || {};
  const g = p.charge || {};
  const k = p.climate || {};
  const s = p.drive || {};
  const l = p.location || {};
  const t = p.tire || {};

  const doors = [
    c.door_open_driver_front,
    c.door_open_passenger_front,
    c.door_open_driver_rear,
    c.door_open_passenger_rear
  ];
  const windows = [
    c.window_open_driver_front,
    c.window_open_passenger_front,
    c.window_open_driver_rear,
    c.window_open_passenger_rear
  ];
  // 「有没有知道的数据」与「有几个开着」分开算：四门全没回 → 未知；
  // 回了但全是 false → 0（关着）。这两种情况在界面上不能显示成同一个词。
  const known = (list) => list.filter((v) => v === true || v === false);
  const openCount = (list) => {
    const got = known(list);
    if (!got.length) return null;
    return got.filter((v) => v === true).length;
  };

  const battery = num(g.battery_level);
  const usable = num(g.usable_battery_level);
  const est = num(g.est_battery_range);
  const ideal = num(g.ideal_battery_range);
  const rangeKm = mileToKm(est);
  const idealRangeKm = mileToKm(ideal);
  const shown = battery !== null ? battery : usable;
  const locked = bool(c.locked);
  const chargePortOpen = bool(g.charge_port_door_open);
  const shift = kindOf(s.shift_state);
  const speed = num(s.speed);
  const lat = num(l.latitude);
  const lng = num(l.longitude);
  const odometer = num(s.odometer_in_hundredths_of_a_mile);

  return {
    hasData: !!vehicle.raw,
    updatedAt: vehicle.updatedAt,
    categories: vehicle.categories.slice(),
    source: vehicle.source,

    // —— 首页头部：电量 + 续航 + 驻车状态
    batteryPercent: shown,
    batteryText: shown === null ? UNKNOWN : shown + '%',
    idealPercent: battery,
    usablePercent: usable,
    rangeKm: rangeKm,
    idealRangeKm: idealRangeKm,
    rangeText: rangeKm === null ? UNKNOWN : rangeKm + ' km',
    shift: shift,
    shiftText: SHIFT_TEXT[shift || ''] || UNKNOWN,
    parked: shift === 'P',
    speed: speed,
    // 信息页显示 km/h：vehicle.proto 的 speed 是 mph，换算同样只发生在视图层
    speedKmh: mileToKm(speed),
    odometerKm: odometer === null ? null : mileToKm(odometer / 100),

    // —— 控制页：锁 / 前备箱 / 后备箱 / 充电盖板
    locked: locked,
    lockedText: locked === null ? UNKNOWN : locked ? '已上锁' : '未上锁',
    userPresent: bool(c.is_user_present),
    remoteStart: bool(c.remote_start),
    sentryAvailable: bool(c.sentry_mode_available),
    sentryState: kindOf(c.sentry_mode_state),
    valetMode: bool(c.valet_mode),
    frunkOpen: bool(c.door_open_trunk_front),
    trunkOpen: bool(c.door_open_trunk_rear),
    doorsOpen: openCount(doors),
    doorUnknown: known(doors).length === 0,
    // 俯视图按「哪一侧哪一排」逐门着色：doorsOpen 那个计数只够写一行文字，画不出四个点。
    doorStates: {
      driverFront: bool(doors[0]),
      passengerFront: bool(doors[1]),
      driverRear: bool(doors[2]),
      passengerRear: bool(doors[3])
    },
    windowsOpen: openCount(windows),
    windowUnknown: known(windows).length === 0,
    chargePortOpen: chargePortOpen,
    chargePortOpenText: chargePortOpen === null ? UNKNOWN : chargePortOpen ? '开着' : '关着',
    chargePortLatch: kindOf(g.charge_port_latch),

    // —— 温度页
    insideTemp: temp(k.inside_temp_celsius),
    outsideTemp: temp(k.outside_temp_celsius),
    driverTemp: temp(k.driver_temp_setting),
    passengerTemp: temp(k.passenger_temp_setting),
    climateOn: bool(k.is_climate_on),
    preconditioning: bool(k.is_preconditioning),

    // —— 充电信息
    chargingState: kindOf(g.charging_state),
    chargeLimitSoc: num(g.charge_limit_soc),
    chargerPower: num(g.charger_power),
    minutesToFullCharge: num(g.minutes_to_full_charge),

    // —— 位置页
    latitude: lat,
    longitude: lng,
    hasLocation: lat !== null && lng !== null,
    heading: num(l.heading),
    gpsAsOf: num(l.gps_as_of),
    locationName: typeof l.location_name === 'string' && l.location_name ? l.location_name : null,

    // —— 胎压（bar，车机原样单位）
    tire: {
      fl: num(t.tpms_pressure_fl),
      fr: num(t.tpms_pressure_fr),
      rl: num(t.tpms_pressure_rl),
      rr: num(t.tpms_pressure_rr)
    },
    hasTirePressure: num(t.tpms_pressure_fl) !== null || num(t.tpms_pressure_fr) !== null ||
      num(t.tpms_pressure_rl) !== null || num(t.tpms_pressure_rr) !== null
  };
}

// 写入一份新的车辆状态。
// 入参既接受 vehicleData() 的完整结果 { ok, summary:{kind,data}, text }，
// 也接受已经剥出来的 data 对象（报文控制台之类会直接递 VehicleData）。
// 没有数据时**不动旧值**：一次「只回 actionStatus」的失败请求不该把已有的状态抹掉，
// 但也必须让调用方知道这次没更新，所以返回值里带 updated。
export function applyVehicleData(payload, source) {
  const raw = payload && payload.summary && payload.summary.kind === 'vehicleData'
    ? payload.summary.data
    : payload && payload.data
      ? payload.data
      : payload && payload.closures_state !== undefined
        ? payload
        : null;

  if (!raw || !Object.keys(raw).length) {
    return { updated: false, view: vehicleView() };
  }

  vehicle.raw = raw;
  vehicle.categories = categoriesOf(raw);
  vehicle.updatedAt = Date.now();
  vehicle.source = source || (payload && payload.text ? String(payload.text).split('\n')[0] : '');
  notify();
  return { updated: true, view: vehicleView() };
}

export default vehicle;
