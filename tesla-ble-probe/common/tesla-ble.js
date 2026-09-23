// Tesla BLE 传输层（uni-app 封装）
//
// 职责：适配器/扫描/连接/MTU/服务发现/订阅/串行发送/粘包重组。
// 不做任何协议解析，只搬运「带 2 字节长度前缀的完整帧」。
//
// 三条来自实测经验的硬规则，写死在这里：
//   A. 连上之后必须立刻 stopBluetoothDevicesDiscovery，否则 Android 栈会掉包/断连。
//   B. 所有 write 必须排队串行，绝不在 BLE 回调里直接再 write。
//   C. 一次 ATT 通知只能装一个 PDU，特斯拉响应里有 65 字节的临时公钥，
//      所以必须先把 MTU 抬到 >= 帧长 + 3，否则收不到完整响应。
//
// 运行环境限制：uni.xxx 蓝牙 API 只在 App（真机 / 自定义基座）里存在，
// H5 与小程序不可用；setBLEMTU 只有 Android 有，iOS 由系统自动协商。

import { toHex, concatBytes } from './bytes.js';
import { GATT, stripLength } from './vcsec.js';

// ---------------------------------------------------------------- 小工具

export function uuidHex(u) {
  return String(u || '').replace(/-/g, '').toLowerCase();
}

// 兼容 Android 回来的全大写 128 位 UUID 和简写 4 位形式
export function matchUuid(u, target) {
  const a = uuidHex(u);
  const b = uuidHex(target);
  if (!a || !b) return false;
  if (a.length === b.length) return a === b;
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  return long.indexOf(short.length >= 8 ? short : short.padStart(8, '0')) === 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errText(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  const code = e.errCode !== undefined ? ' errCode=' + e.errCode : '';
  return (e.errMsg || e.message || JSON.stringify(e)) + code;
}

// 广播名/UUID 归一化：丢掉分隔符差异与大小写差异
function normName(s) {
  return String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

// 车辆 VCSEC 服务的 16 bit 短 UUID 在广播里是 0211（uni 可能回短格式或长格式）
function hasTeslaService(d) {
  const su = (d && d.advertisServiceUUIDs) || [];
  for (const u of su) {
    const n = normName(u);
    if (n === '0211' || n.indexOf('00000211') === 0) return true;
  }
  return false;
}

// 广播名匹配器：精确 / 前缀之外再兜一层「只留字母数字并转大写」的宽松比较
// （不同固件、系统对分隔符和大小写不一致：Tesla 723591 / Tesla_723591 / tesla723591）
// 命中返回 { matched, mode }，没命中返回 null。
export function makeMatcher(names) {
  const exact = (names && names.exact) || [];
  const prefixes = (names && names.prefixes) || [];
  const exactN = exact.map(normName);
  const prefixN = prefixes.map(normName);
  return (n) => {
    const s = String(n || '');
    for (const e of exact) if (s === e) return { matched: e, mode: 'exact' };
    for (const p of prefixes) if (p && s.indexOf(p) === 0) return { matched: p, mode: 'prefix' };
    const nn = normName(s);
    for (const e of exactN) if (nn === e) return { matched: e, mode: 'loose' };
    for (const p of prefixN) if (p && nn.indexOf(p) === 0) return { matched: p, mode: 'loose-prefix' };
    return null;
  };
}

// 手选列表的排序：命中 VIN → 广播了 0211 → 有名字 → 无名，同级按信号强弱（RSSI 越接近 0 越强）
export function sortAdv(list) {
  const rank = (e) => (e.hit ? 0 : e.tesla ? 1 : e.name ? 2 : 3);
  const r = (e) => (typeof e.rssi === 'number' && e.rssi ? e.rssi : -999);
  return (list || []).slice().sort(
    (a, b) => rank(a) - rank(b) || r(b) - r(a) || String(a.name || '').localeCompare(String(b.name || ''))
  );
}

// uni 的 API 在有回调时不返回 Promise，这里统一包一层，顺便处理「环境没有该能力」
function api(name, opts) {
  return new Promise((resolve, reject) => {
    if (typeof uni === 'undefined' || typeof uni[name] !== 'function') {
      reject(new Error('当前运行环境没有 uni.' + name + '()：蓝牙只能在 App 真机上运行'));
      return;
    }
    const args = opts || {};
    uni[name](concatArgs(args, resolve, reject));
  });
}

function concatArgs(args, resolve, reject) {
  const out = {};
  for (const k in args) out[k] = args[k];
  out.success = (res) => resolve(res);
  out.fail = (e) => reject(new Error(errText(e)));
  return out;
}

export function abToBytes(buf) {
  return new Uint8Array(buf);
}

// Android 运行时权限。
// 编译期已在 manifest 声明了 legacy(BLUETOOTH/ADMIN) + 新模型(SCAN/CONNECT) 两套，
// 但运行时该申请哪一套取决于「基座实际的 targetSdkVersion」，而不是我们的期望值：
//   targetSdk <= 30 → 只申请定位，申请 SCAN/CONNECT 会被判「永久拒绝」反而误导；
//   targetSdk >= 31 → 必须申请 SCAN/CONNECT，定位则不再是 BLE 的硬要求。
// 这段是 JS，改完热更新即可，不需要重新打包 —— 所以这里做运行时探测而不是写死。
function sdkInt() {
  try {
    const VERSION = plus.android.importClass('android.os.Build$VERSION');
    return Number(VERSION.SDK_INT) || 0;
  } catch (e) {
    return 0; // 拿不到就按老模型走
  }
}

export function ensureAndroidPermissions() {
  return new Promise((resolve) => {
    if (typeof plus === 'undefined' || !plus.android || typeof plus.android.requestPermissions !== 'function') {
      resolve({ needed: false, granted: true, perms: [] });
      return;
    }
    const perms = ['android.permission.ACCESS_FINE_LOCATION'];
    if (sdkInt() >= 31) perms.push('android.permission.BLUETOOTH_SCAN', 'android.permission.BLUETOOTH_CONNECT');
    plus.android.requestPermissions(
      perms,
      (e) => {
        const denied = (e.deniedAlways || []).concat(e.deniedPresent || []);
        resolve({ needed: true, granted: denied.length === 0, denied, perms });
      },
      (e) => resolve({ needed: true, granted: false, denied: [errText(e)], perms })
    );
  });
}

// 车库前最该先看的一行日志：基座到底是不是新打的那个、蓝牙模块到底进没进。
// plus.bluetooth 只有在基座编译了 Bluetooth 模块时才存在；缺它就一定会弹
// 「打包时未添加bluetooth模块」，跟 manifest 里写了什么无关（写的是源码，跑的是基座）。
export function logRuntimeEnv(log) {
  try {
    if (typeof plus === 'undefined' || !plus.runtime) {
      log('warn', '非 App 环境：无 plus.runtime，蓝牙不可用');
      return;
    }
    const r = plus.runtime;
    log('info', '基座: version=' + r.version + ' (code ' + (r.versionCode || '?') + ') appid=' + r.appid +
      (r.standalone ? ' 独立App' : ' 调试基座'));
    if (typeof plus.bluetooth === 'undefined') {
      log('error', '基座里没有 Bluetooth 模块（plus.bluetooth 不存在）—— 说明手机上装的还是旧基座，' +
        '或打包时 manifest 的 modules 被 HBuilderX 可视化界面回写清掉了。' +
        '请在 manifest.json「App模块配置」里确认 蓝牙(Bluetooth) 已勾选，并抬高 versionCode 重新打基座。');
    } else {
      log('ok', 'Bluetooth 模块已就绪（plus.bluetooth 存在）');
    }
  } catch (e) {
    log('warn', '读运行环境失败: ' + errText(e));
  }
}

// 绑定时要等 60 秒刷钥匙卡，锁屏就整轮作废；车库里这一点比什么都值钱。
export function keepScreenOn(on) {
  try {
    if (typeof uni !== 'undefined' && uni.setKeepScreenOn) uni.setKeepScreenOn({ keepScreenOn: !!on });
  } catch (e) { /* 无 WAKE_LOCK 时忽略 */ }
}

export function bytesToAb(bytes) {
  const out = new Uint8Array(bytes.length); // 复制一份，避免 buffer 视图共享导致长度异常
  out.set(bytes);
  return out.buffer;
}

// ---------------------------------------------------------------- 传输层

export class TeslaBle {
  constructor(handlers) {
    const h = handlers || {};
    this.onLog = h.log || function () {};
    this.onState = h.state || function () {};
    this.onRaw = h.raw || function () {}; // 收到/发出的原始 chunk，供报文控制台
    this.deviceId = null;
    this.name = null;
    this.mtu = 23;
    this.connected = false;
    this.services = [];
    this.characteristics = [];
    this._rx = new Uint8Array(0);
    this._tx = Promise.resolve();
    this._waiters = [];
    // V3 的 readUntil 语义：车辆会连发多帧 ACK。只有在 receive() 之后才暂存无人等待的帧，
    // send() 会清空，旧版「一问一答」行为完全不变。
    this._queue = [];
    this._buffering = false;
    this._listening = false;
  }

  log(kind, msg) {
    try {
      this.onLog(kind, msg);
    } catch (e) {
      /* 日志回调不许影响主流程 */
    }
  }

  setState(s) {
    this.onState(s);
  }

  // ---------------------------------------------------------- 适配器 / 扫描

  async init() {
    await api('openBluetoothAdapter', { mode: 'central' }).catch(() => api('openBluetoothAdapter', {}));
    const st = await api('getBluetoothAdapterState', {});
    this.log('ok', '蓝牙适配器已开启 available=' + st.available + ' discovering=' + st.discovering);
    if (st.available === false) throw new Error('蓝牙不可用，请确认系统蓝牙与定位权限已打开');
    return st;
  }

  // names: {exact:[], prefixes:[]}；超时返回 null，不抛错
  scan(names, timeoutMs) {
    const limit = timeoutMs || 15000;
    const exact = (names && names.exact) || [];
    const prefixes = (names && names.prefixes) || [];
    const hit = makeMatcher(names);
    const seen = [];
    return new Promise((resolve, reject) => {
      let done = false;
      let timer = null;
      const finish = (device) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (typeof uni !== 'undefined' && uni.offBluetoothDeviceFound) {
          try { uni.offBluetoothDeviceFound(); } catch (e) { /* 老版本无此 API */ }
        }
        api('stopBluetoothDevicesDiscovery', { allowDuplicatesKey: false }).catch(() => {});
        resolve(device);
      };
      const cb = (res) => {
        if (done) return;
        const list = res.devices || [];
        for (const d of list) {
          const n = d.name || d.localName || '';
          const m = hit(n);
          if (m) {
            this.log('ok', '发现车辆 name=' + n + ' (' + m.mode + ' 命中 ' + m.matched + ') id=' + d.deviceId);
            finish(d);
            return;
          }
          // 名字被系统缓存吃掉时，用广播里的服务 UUID 兜底（0211 = 特斯拉 VCSEC 服务）
          if (!n && hasTeslaService(d)) {
            this.log('ok', '发现疑似车辆（无名，但广播了 0211 服务）id=' + d.deviceId);
            finish(d);
            return;
          }
          if (n && normName(n).indexOf('TESLA') >= 0 && seen.indexOf(n) < 0) {
            seen.push(n);
            this.log('warn', '广播名含 TESLA 但未命中期望名: "' + n + '" rssi=' + d.RSSI + ' —— 若这是本车，把它补进匹配规则');
            continue;
          }
          if (n && seen.indexOf(n) < 0) {
            seen.push(n);
            if (seen.length <= 40) this.log('rx', '广播中: ' + n + ' rssi=' + d.RSSI);
          }
        }
      };
      if (typeof uni === 'undefined' || typeof uni.onBluetoothDeviceFound !== 'function') {
        reject(new Error('当前运行环境没有蓝牙扫描能力'));
        return;
      }
      uni.onBluetoothDeviceFound(cb);
      api('startBluetoothDevicesDiscovery', {
        allowDuplicatesKey: false,
        powerLevel: 'high',
        interval: 0
      })
        .then(() => {
          this.log('info', '开始扫描（匹配 ' + exact.concat(prefixes).join(' / ') + '）');
          this.setState('scanning');
          timer = setTimeout(() => {
            if (done) return;
            this.log('warn', '扫描 ' + limit + 'ms 未发现目标车辆；请核对 VIN，或用「全部广播」页看车到底在不在');
            this.setState('idle');
            finish(null);
          }, limit);
        })
        .catch((e) => {
          if (done) return;
          done = true;
          uni.offBluetoothDeviceFound && uni.offBluetoothDeviceFound();
          reject(e);
        });
    });
  }

  // 只收集广播，不匹配（排查用）
  async scanAll(timeoutMs) {
    const found = {};
    await api('startBluetoothDevicesDiscovery', { allowDuplicatesKey: false, powerLevel: 'high' });
    await new Promise((resolve) => {
      const cb = (res) => {
        for (const d of res.devices || []) {
          const n = d.name || d.localName || '(无名) ' + String(d.deviceId || '').slice(-8);
          if (!found[n]) found[n] = d.deviceId;
        }
      };
      uni.onBluetoothDeviceFound(cb);
      setTimeout(() => {
        try { uni.offBluetoothDeviceFound(); } catch (e) {}
        resolve();
      }, timeoutMs || 10000);
    });
    await api('stopBluetoothDevicesDiscovery', { allowDuplicatesKey: false }).catch(() => {});
    return Object.keys(found).sort().map((n) => ({ name: n, deviceId: found[n] }));
  }

  // 扫描并把看到的广播实时交给 onFound，超时后返回排好序的全量列表。
  // 和 scan() 的区别：不做「命中即停」，而是全部列出来让人手选 ——
  // 车辆蓝牙名被系统改过（或在系统里已配对、名字被缓存）时，按 VIN 算出来的名字根本匹配不上，只能手选。
  discover(timeoutMs, names, onFound) {
    const limit = timeoutMs || 12000;
    const match = makeMatcher(names);
    const found = new Map(); // deviceId -> { deviceId, name, rssi, tesla, hit, mode }
    return new Promise((resolve, reject) => {
      if (typeof uni === 'undefined' || typeof uni.onBluetoothDeviceFound !== 'function') {
        reject(new Error('当前运行环境没有蓝牙扫描能力'));
        return;
      }
      const snapshot = () => {
        const list = sortAdv(Array.from(found.values()));
        if (typeof onFound === 'function') {
          try { onFound(list); } catch (e) { /* 页面已卸载 */ }
        }
        return list;
      };
      const cb = (res) => {
        for (const d of res.devices || []) {
          if (!d || !d.deviceId) continue;
          const old = found.get(d.deviceId) || {};
          const n = d.name || d.localName || old.name || '';
          const m = n ? match(n) : null;
          found.set(d.deviceId, {
            deviceId: d.deviceId,
            name: n,
            rssi: typeof d.RSSI === 'number' ? d.RSSI : old.rssi,
            tesla: hasTeslaService(d) || !!old.tesla,
            hit: m ? m.matched : old.hit || null,
            mode: m ? m.mode : old.mode || ''
          });
        }
        snapshot();
      };
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        try { uni.offBluetoothDeviceFound(); } catch (e) { /* 老版本无此 API */ }
        api('stopBluetoothDevicesDiscovery', { allowDuplicatesKey: false }).catch(() => {});
        this.setState('idle');
        resolve(snapshot());
      };
      uni.onBluetoothDeviceFound(cb);
      api('startBluetoothDevicesDiscovery', { allowDuplicatesKey: false, powerLevel: 'high', interval: 0 })
        .then(() => {
          this.log('info', '扫描中（' + limit + 'ms，全部列出手选）');
          this.setState('scanning');
          setTimeout(finish, limit);
        })
        .catch((e) => {
          if (finished) return;
          finished = true;
          try { uni.offBluetoothDeviceFound(); } catch (e2) { /* 忽略 */ }
          reject(e);
        });
    });
  }

  // ---------------------------------------------------------- 连接与订阅

  async connect(device) {
    const id = typeof device === 'string' ? device : device.deviceId;
    this.deviceId = id;
    this.name = (device && (device.name || device.localName)) || '';
    this.setState('connecting');
    this.log('info', '连接 ' + (this.name || '(无名)') + ' / ' + id);

    await api('createBLEConnection', { deviceId: id });
    this.connected = true;

    // 规则 A：连上立刻停扫
    await api('stopBluetoothDevicesDiscovery', { allowDuplicatesKey: false }).catch(() => {});
    this.log('info', '已停止扫描（连接期间继续扫会掉包）');

    if (typeof uni.onBLEConnectionStateChange === 'function') {
      uni.onBLEConnectionStateChange((res) => {
        if (res.deviceId !== this.deviceId) return;
        if (!res.connected) {
          this.connected = false;
          this.setState('disconnected');
          this.log('warn', '连接已断开（车辆 3 台钥匙上限 / 车机休眠 / 距离都可能是原因）');
          this._rejectAll(new Error('BLE 已断开'));
        }
      });
    }

    await delay(600); // Android 需要一点时间才能枚举服务
    await this._negotiateMtu();
    await this._discover();
    await this._subscribe();
    this.setState('connected');
    return this;
  }

  async _negotiateMtu() {
    // iOS 没有 setBLEMTU，会自动协商；失败也不致命，只是大包收不全
    for (const m of [247, 185, 128, 64]) {
      try {
        await api('setBLEMTU', { deviceId: this.deviceId, mtu: m });
        this.mtu = m;
        this.log('ok', 'MTU 协商成功 = ' + m);
        return;
      } catch (e) {
        /* 换小一档再试 */
      }
    }
    this.log('warn', 'setBLEMTU 不可用（' + (typeof uni !== 'undefined' && typeof uni.setBLEMTU === 'function' ? '车辆拒绝' : '当前平台无此 API') + '），按 MTU=23 工作；超过 20 字节的响应可能被截断');
  }

  async _discover() {
    const svcList = await api('getBLEDeviceServices', { deviceId: this.deviceId });
    this.services = svcList.services || [];
    const svc = this.services.find((s) => matchUuid(s.uuid, GATT.service));
    if (!svc) {
      throw new Error('没找到特斯拉 VCSEC 服务 0211，实际服务: ' + this.services.map((s) => s.uuid).join(', '));
    }
    this.serviceId = svc.uuid;
    const charList = await api('getBLEDeviceCharacteristics', { deviceId: this.deviceId, serviceId: svc.uuid });
    this.characteristics = charList.characteristics || [];
    this.writeId = (this.characteristics.find((c) => matchUuid(c.uuid, GATT.write)) || {}).uuid;
    this.indicateId = (this.characteristics.find((c) => matchUuid(c.uuid, GATT.indicate)) || {}).uuid;
    this.versionId = (this.characteristics.find((c) => matchUuid(c.uuid, GATT.version)) || {}).uuid;
    this.log('ok', '服务 0211 已就绪 write=' + (this.writeId ? '0212' : '缺') + ' indicate=' + (this.indicateId ? '0213' : '缺') + ' read=' + (this.versionId ? '0214' : '缺'));
    if (!this.writeId || !this.indicateId) {
      throw new Error('0212/0213 特征不全，无法收发 VCSEC 报文');
    }
  }

  async _subscribe() {
    if (!this._listening && typeof uni.onBLECharacteristicValueChange === 'function') {
      uni.onBLECharacteristicValueChange((res) => this._onChunk(res));
      this._listening = true;
    }
    let ok = false;
    try {
      await api('notifyBLECharacteristicValueChange', {
        deviceId: this.deviceId,
        serviceId: this.serviceId,
        characteristicId: this.indicateId,
        state: true
      });
      ok = true;
    } catch (e) {
      this.log('warn', '订阅 0213 失败: ' + errText(e));
    }
    if (ok) {
      this.log('ok', '已订阅 0213（INDICATE）');
    } else {
      // uni-app 无法手写 CCC 描述符；如果这一步失败，只能靠外部工具打开 indicate
      this.log('error', '关键阻塞：运行时未能开启 0213 的通知。uni API 不支持直接写 0x2902 描述符，' +
        '请用 nRF Connect 连同一台车手动 Enable indicate 后重试，或改用支持描述符写入的原生蓝牙插件。');
    }
    await delay(300);
  }

  _onChunk(res) {
    if (res.deviceId && this.deviceId && res.deviceId !== this.deviceId) return;
    if (!matchUuid(res.characteristicId, GATT.indicate)) {
      this.log('rx', '收到非 0213 特征 ' + res.characteristicId + ' 的数据 ' + toHex(abToBytes(res.value)));
    }
    const chunk = abToBytes(res.value);
    this.onRaw('rx', chunk);
    this._rx = concatBytes([this._rx, chunk]);
    // 规则 C 的副作用：可能一次通知只给半帧，循环按长度前缀切
    while (this._rx.length >= 2) {
      const declared = (this._rx[0] << 8) | this._rx[1];
      if (this._rx.length < declared + 2) {
        this.log('info', '等待后续分包（已有 ' + this._rx.length + ' / 需要 ' + (declared + 2) + '）');
        return;
      }
      const frame = this._rx.subarray(0, declared + 2);
      this._rx = this._rx.subarray(declared + 2);
      let body;
      try {
        body = stripLength(frame);
      } catch (e) {
        this.log('error', '分帧失败: ' + errText(e) + ' 原始=' + toHex(frame));
        continue;
      }
      this._deliver(body);
    }
  }

  _deliver(body) {
    const w = this._waiters.shift();
    if (w) {
      clearTimeout(w.timer);
      w.resolve(body);
      return;
    }
    if (this._buffering) {
      // 我们还在处理上一帧，车辆又推了一帧过来：先存着，别丢
      if (this._queue.length >= 8) this._queue.shift();
      this._queue.push(body);
      this.log('info', '暂存车辆推送（队列 ' + this._queue.length + ' 帧）' + toHex(body));
      return;
    }
    this.log('info', '无人等待的响应（车辆主动上报？）' + toHex(body));
  }

  _rejectAll(err) {
    const list = this._waiters.splice(0);
    for (const w of list) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this._rx = new Uint8Array(0);
    this._queue.length = 0;
  }

  // ---------------------------------------------------------- 收发

  // 发一帧（自动排队），等待一个完整响应帧；timeout=0 表示不等响应
  // keepQueue=true：不清空暂存队列。V3 的 readUntil 循环「收一帧 → 处理 → receive 下一帧」
  // 期间车辆可能又推了 ACK 进来，清空会把它们丢掉。旧版一问一答不传这个参数，行为不变。
  async send(frame, timeoutMs, keepQueue) {
    if (!this.connected) throw new Error('尚未连接车辆');
    const wait = timeoutMs === undefined ? 8000 : timeoutMs;
    this._rx = new Uint8Array(0); // 丢弃上次残留，保证一问一答对齐
    this._buffering = false;
    if (!keepQueue) this._queue.length = 0;
    const p = wait > 0 ? this._waitForFrame(wait) : null;
    // 规则 B：串行写
    let writeError = null;
    this._tx = this._tx
      .then(() => this._writeChunked(frame))
      .catch((e) => {
        writeError = e; // 不许吞：以前 .catch(() => {}) 会把真实写失败抹掉，只剩一个误导人的「响应超时」
      });
    await this._tx;
    this.onRaw('tx', frame);
    this.log('tx', '发送 ' + frame.length + ' 字节: ' + toHex(frame));
    if (writeError) {
      const t = errText(writeError);
      this.log('error', 'BLE 写失败：' + t + '（帧 ' + frame.length + ' 字节 / MTU=' + this.mtu + ' / 特征 ' + (this.writeId || '?') + '）');
      // 撤销刚登记的响应等待，避免半写状态下留下悬着的超时定时器
      if (p) {
        p.catch(() => {}); // 下面 _rejectAll 会拒绝它，但没人 await，标记为已处理
        this._rejectAll(new Error('BLE 写失败：' + t));
      }
      throw new Error('BLE 写失败：' + t);
    }
    if (!p) return null;
    const body = await p;
    this.log('rx', '响应 ' + body.length + ' 字节: ' + toHex(body));
    return body;
  }

  _waitForFrame(ms) {
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const i = this._waiters.indexOf(w);
        if (i >= 0) this._waiters.splice(i, 1);
        reject(new Error('等待车辆响应超时 ' + ms + 'ms（可能没订阅成功 / 车辆休眠 / MTU 不足）'));
      }, ms);
      this._waiters.push(w);
    });
  }

  // 不发送，只等车辆下一帧（V3 白名单/RKE 操作会连发多个 ACK，官方用 readUntil 循环收）。
  // 超时返回 null，不抛错；开启暂存后，处理上一帧期间到达的帧也不会丢。
  async receive(timeoutMs) {
    if (!this.connected) throw new Error('尚未连接车辆');
    this._buffering = true;
    if (this._queue.length) {
      const body = this._queue.shift();
      this.log('rx', '取暂存帧 ' + body.length + ' 字节: ' + toHex(body));
      return body;
    }
    try {
      const body = await this._waitForFrame(timeoutMs === undefined ? 3000 : timeoutMs);
      this.log('rx', '续收 ' + body.length + ' 字节: ' + toHex(body));
      return body;
    } catch (e) {
      this.log('info', errText(e));
      return null;
    }
  }

  // 官方 connector/ble/ble.go 的做法：整包前面已经加了 2 字节大端长度前缀，
  // 再按 blockLength = min(ExchangeMTU, 1024) - 3 循环 WriteCharacteristic 分片，
  // 车端靠长度前缀重新组包。所以「分包写」不但被接受，而且是官方唯一的写法。
  // 早期注释说「特斯拉不接受分包写」是错的，这里改成和官方一致的真分包。
  async _writeChunked(frame) {
    const cap = Math.max(20, this.mtu - 3);
    if (frame.length > cap) {
      this.log('info', '帧长 ' + frame.length + ' > MTU 可用 ' + cap + '，按官方规则分成 ' +
        Math.ceil(frame.length / cap) + ' 片写');
    }
    let idx = 0;
    for (let off = 0; off < frame.length; off += cap) {
      const size = Math.min(cap, frame.length - off);
      try {
        await api('writeBLECharacteristicValue', {
          deviceId: this.deviceId,
          serviceId: this.serviceId,
          characteristicId: this.writeId,
          value: bytesToAb(frame.subarray(off, off + size))
        });
      } catch (e) {
        throw new Error('第 ' + (idx + 1) + '/' + Math.ceil(frame.length / cap) + ' 片（' + size + ' 字节，偏移 ' + off + '）写入失败：' + errText(e));
      }
      idx++;
      await delay(20); // 给车机一点处理时间，避免连写丢包
    }
  }

  async readVersion() {
    if (!this.versionId) throw new Error('没有 0214 特征');
    const res = await api('readBLECharacteristicValue', {
      deviceId: this.deviceId,
      serviceId: this.serviceId,
      characteristicId: this.versionId
    });
    const bytes = res && res.value ? abToBytes(res.value) : null;
    if (bytes) this.log('ok', '通信协议版本 = ' + toHex(bytes));
    return bytes;
  }

  async disconnect() {
    this._rejectAll(new Error('主动断开'));
    if (this.deviceId) {
      await api('closeBLEConnection', { deviceId: this.deviceId }).catch(() => {});
    }
    this.connected = false;
    this.setState('idle');
    this.log('info', '已断开');
  }

  async close() {
    await this.disconnect();
    await api('closeBluetoothAdapter', {}).catch(() => {});
  }
}

export default TeslaBle;
