// BLE 传输层（uni-app）：适配器 / 扫描 / 连接 / MTU / 服务发现 / 订阅 / 串行写 / 帧分发。
//
// 职责边界：只搬运「已剥掉 2 字节长度前缀的完整帧」，不解析任何协议内容。
// 上层的 V3 会话、下层的分帧重组（frame-codec）、MTU（mtu-manager）、
// 广播匹配（device-matcher）、GATT 常量（gatt）各自独立可测。
//
// 三条来自实测经验的硬规则，写死在这里：
//   A. 连上之后必须立刻 stopBluetoothDevicesDiscovery，否则 Android 栈会掉包/断连。
//   B. 所有 write 必须排队串行，绝不在 BLE 回调里直接再 write。
//   C. 一次 ATT 通知只能装一个 PDU，特斯拉响应里有 65 字节的临时公钥，
//      所以必须先把 MTU 抬到 >= 帧长 + 3，否则收不到完整响应。
//
// 运行环境限制：uni.xxx 蓝牙 API 只在 App（真机 / 自定义基座）里存在，
// H5 与小程序不可用；setBLEMTU 只有 Android 有，iOS 由系统自动协商。

import { toHex } from '../bytes.js';
import { abToBytes, bytesToAb, bleApi, errText, delay, matchUuid } from './uni-ble-api.js';
import { GATT } from './gatt.js';
import { FrameReassembler } from './frame-codec.js';
import { makeMatcher, sortAdv, hasTeslaService, normName } from './device-matcher.js';
import { MTU_DEFAULT, payloadCap, negotiateMtu, watchMtuChange } from './mtu-manager.js';

export { makeMatcher, sortAdv, normName, hasTeslaService, payloadCap };

// 车辆会连发多帧 ACK。只有在 receive() 之后才暂存无人等待的帧，
// send() 按参数决定是否清空 —— 旧版「一问一答」行为完全不变。
const BUFFERED_MAX = 8;

// ---------------------------------------------------------- 0x212 的写入方式
// 官方 vehicle-command 对 0x212 用的是「无响应写」：
//   pkg/connector/ble/ble.go:121  WriteCharacteristic(txChar, out[:blockLength], false)
// uni 不传 writeType 时由运行时自己挑（文档：iOS 优先 write、安卓优先 writeNoResponse），
// 挑错就回 errCode=10007 "property not support"（当前特征值不支持此操作）。
// 这里显式指定 writeType，并在被回「属性不支持」时换另一种写法重试同一批字节。
const WRITE_NR = 'writeNoResponse';
const WRITE_REQ = 'write';

// getBLEDeviceCharacteristics 的 properties 各端形状不一样：
// 多数是 {write, writeNoResponse, notify, indicate}，个别安卓基座回位掩码数字。
function describeWriteProps(ch) {
  const p = ch && ch.properties;
  if (!p) return null;
  if (typeof p === 'number') {
    // Android BluetoothGattCharacteristic: WRITE=0x08, WRITE_NO_RESPONSE=0x04
    return { write: (p & 0x08) !== 0, writeNoResponse: (p & 0x04) !== 0 };
  }
  return { write: !!p.write, writeNoResponse: !!(p.writeNoResponse || p.writeWithoutResponse) };
}

function writePropsText(p) {
  if (!p) return '未上报';
  return 'write=' + (p.write ? 'y' : 'n') + ' writeNoResponse=' + (p.writeNoResponse ? 'y' : 'n');
}

function writeTypeCandidates(props) {
  const out = [];
  if (props && props.writeNoResponse) out.push(WRITE_NR); // 官方口径优先
  if (props && props.write) out.push(WRITE_REQ);
  // 车端上报的属性未必完整，安卓基座也可能读漏：没在清单里的写法一律留作兜底，
  // 真被协议栈回 property not support 时才有第二次机会。
  if (out.indexOf(WRITE_NR) < 0) out.push(WRITE_NR);
  if (out.indexOf(WRITE_REQ) < 0) out.push(WRITE_REQ);
  return out;
}

// uni 的错误表：10007 = property not support（特征值不支持此操作），10008 = system error。
// 只有前者才说明是「写法与属性不匹配」，换 writeType 才有意义；10008 之类不许重发。
function isPropertyReject(text) {
  const t = String(text || '').toLowerCase();
  return t.indexOf('property not support') >= 0 || t.indexOf('errcode=10007') >= 0;
}

export class BleTransport {
  constructor(handlers) {
    const h = handlers || {};
    this.onLog = h.log || function () {};
    this.onState = h.state || function () {};
    this.onRaw = h.raw || function () {}; // 收到/发出的原始 chunk，供报文控制台
    this.deviceId = null;
    this.name = null;
    this.mtu = MTU_DEFAULT;
    this.connected = false;
    this.services = [];
    this.characteristics = [];
    this.serviceId = null;
    this.writeId = null;
    this.writeProps = null; // 0x212 上报的写属性，排查「property not support」用
    this.writeType = null; // 本连接里已被车端接受的写入方式，一旦确定就不再试探
    this.indicateId = null;
    this.versionId = null;
    this.reassembler = new FrameReassembler({
      log: (kind, msg) => this.log(kind, msg),
      onFrame: (body) => this.deliver(body)
    });
    this.txChain = Promise.resolve();
    this.waiters = [];
    this.queue = [];
    this.buffering = false;
    this.listening = false;
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
    await bleApi('openBluetoothAdapter', { mode: 'central' }).catch(() => bleApi('openBluetoothAdapter', {}));
    const st = await bleApi('getBluetoothAdapterState', {});
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
        bleApi('stopBluetoothDevicesDiscovery', { allowDuplicatesKey: false }).catch(() => {});
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
      bleApi('startBluetoothDevicesDiscovery', {
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
    await bleApi('startBluetoothDevicesDiscovery', { allowDuplicatesKey: false, powerLevel: 'high' });
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
    await bleApi('stopBluetoothDevicesDiscovery', { allowDuplicatesKey: false }).catch(() => {});
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
        bleApi('stopBluetoothDevicesDiscovery', { allowDuplicatesKey: false }).catch(() => {});
        this.setState('idle');
        resolve(snapshot());
      };
      uni.onBluetoothDeviceFound(cb);
      bleApi('startBluetoothDevicesDiscovery', { allowDuplicatesKey: false, powerLevel: 'high', interval: 0 })
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

    await bleApi('createBLEConnection', { deviceId: id });
    this.connected = true;

    // 规则 A：连上立刻停扫
    await bleApi('stopBluetoothDevicesDiscovery', { allowDuplicatesKey: false }).catch(() => {});
    this.log('info', '已停止扫描（连接期间继续扫会掉包）');

    if (typeof uni.onBLEConnectionStateChange === 'function') {
      uni.onBLEConnectionStateChange((res) => {
        if (res.deviceId !== this.deviceId) return;
        if (!res.connected) {
          this.connected = false;
          this.setState('disconnected');
          this.log('warn', '连接已断开（车辆 3 台钥匙上限 / 车机休眠 / 距离都可能是原因）');
          this.rejectAll(new Error('BLE 已断开'));
        }
      });
    }

    await delay(600); // Android 需要一点时间才能枚举服务
    // 顺序按官方：ble.go:345 先 Subscribe，:349 才 ExchangeMTU。
    // 反过来（先改包大小再订阅）时，协商期间车辆推上来的第一帧会落在还没开 notify 的特征上，
    // 丢的那半截要靠 2 字节大端长度前缀（protocol.md:160-161）重新对齐，
    // 现场表现就是「已丢弃 N 帧 / 响应 GCM tag 不符 / 等待终态超时」。
    await this.discoverServices();
    await this.subscribe();
    await this.negotiateMtu();
    this.setState('connected');
    return this;
  }

  async negotiateMtu() {
    // iOS 没有 setBLEMTU（由系统自动协商），失败也不致命，只是大包收不全。
    watchMtuChange((res) => {
      if (!res || res.deviceId !== this.deviceId) return;
      const m = Number(res.mtu);
      if (m > 0 && m !== this.mtu) {
        this.mtu = m;
        this.log('ok', 'MTU 变更（车辆侧回读）= ' + m + '，分包按每包 ' + payloadCap(m) + ' 字节');
      }
    });
    await negotiateMtu({
      deviceId: this.deviceId,
      log: (kind, msg) => this.log(kind, msg),
      apply: (m) => { this.mtu = m; }
    });
  }

  async discoverServices() {
    const svcList = await bleApi('getBLEDeviceServices', { deviceId: this.deviceId });
    this.services = svcList.services || [];
    const svc = this.services.find((s) => matchUuid(s.uuid, GATT.service));
    if (!svc) {
      throw new Error('没找到特斯拉 VCSEC 服务 0211，实际服务: ' + this.services.map((s) => s.uuid).join(', '));
    }
    this.serviceId = svc.uuid;
    const charList = await bleApi('getBLEDeviceCharacteristics', { deviceId: this.deviceId, serviceId: svc.uuid });
    this.characteristics = charList.characteristics || [];
    const writeChar = this.characteristics.find((c) => matchUuid(c.uuid, GATT.write)) || null;
    this.writeId = writeChar ? writeChar.uuid : null;
    this.indicateId = (this.characteristics.find((c) => matchUuid(c.uuid, GATT.indicate)) || {}).uuid;
    this.versionId = (this.characteristics.find((c) => matchUuid(c.uuid, GATT.version)) || {}).uuid;
    // 每次重新发现服务都按车端上报的属性重算写入方式，不要沿用上一次的判定
    this.writeProps = describeWriteProps(writeChar);
    this.writeType = null;
    this.log('ok', '服务 0211 已就绪 write=' + (this.writeId ? '0212' : '缺') + ' indicate=' + (this.indicateId ? '0213' : '缺') + ' read=' + (this.versionId ? '0214' : '缺'));
    this.log('info', '0x212 写属性: ' + writePropsText(this.writeProps) + '，准备按 ' +
      writeTypeCandidates(this.writeProps).join(' / ') + ' 顺序写入');
    // 车端到底上报了哪些特征、各自什么属性，是真机排查「property not support」唯一的事实来源
    this.log('info', '0211 特征清单: ' + this.characteristics.map((c) =>
      String(c.uuid).replace(/^0000(....).*$/, '$1') + '(' + writePropsText(describeWriteProps(c)) +
      (c.properties && (c.properties.notify || c.properties.indicate) ? ' notify/indicate' : '') + ')').join(' '));
    if (!this.writeId || !this.indicateId) {
      throw new Error('0212/0213 特征不全，无法收发 VCSEC 报文');
    }
  }

  async subscribe() {
    if (!this.listening && typeof uni.onBLECharacteristicValueChange === 'function') {
      uni.onBLECharacteristicValueChange((res) => this.onChunk(res));
      this.listening = true;
    }
    let ok = false;
    try {
      await bleApi('notifyBLECharacteristicValueChange', {
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

  onChunk(res) {
    if (res.deviceId && this.deviceId && res.deviceId !== this.deviceId) return;
    if (!matchUuid(res.characteristicId, GATT.indicate)) {
      this.log('rx', '收到非 0213 特征 ' + res.characteristicId + ' 的数据 ' + toHex(abToBytes(res.value)));
    }
    const chunk = abToBytes(res.value);
    this.onRaw('rx', chunk);
    this.reassembler.push(chunk);
  }

  deliver(body) {
    const w = this.waiters.shift();
    if (w) {
      clearTimeout(w.timer);
      w.resolve(body);
      return;
    }
    if (this.buffering) {
      // 我们还在处理上一帧，车辆又推了一帧过来：先存着，别丢
      if (this.queue.length >= BUFFERED_MAX) this.queue.shift();
      this.queue.push(body);
      this.log('info', '暂存车辆推送（队列 ' + this.queue.length + ' 帧）' + toHex(body));
      return;
    }
    this.log('info', '无人等待的响应（车辆主动上报？）' + toHex(body));
  }

  rejectAll(err) {
    const list = this.waiters.splice(0);
    for (const w of list) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.reassembler.reset();
    this.queue.length = 0;
  }

  // ---------------------------------------------------------- 收发

  // 发一帧（自动排队），等待一个完整响应帧；timeout=0 表示不等响应。
  // keepQueue=true：不清空暂存队列。V3 的 readUntil 循环「收一帧 → 处理 → receive 下一帧」
  // 期间车辆可能又推了 ACK 进来，清空会把它们丢掉。旧版一问一答不传这个参数，行为不变。
  async send(frame, timeoutMs, keepQueue) {
    if (!this.connected) throw new Error('尚未连接车辆');
    const wait = timeoutMs === undefined ? 8000 : timeoutMs;
    // **不清 reassembler.buffer**：官方传输层从不因为「又发了一条」就丢掉正在拼的半截帧，
    // 只在分包静默 1 秒后清（见 FrameReassembler.push）。
    this.buffering = false;
    if (!keepQueue) this.queue.length = 0;
    const p = wait > 0 ? this.waitForFrame(wait) : null;
    // 规则 B：串行写
    let writeError = null;
    this.txChain = this.txChain
      .then(() => this.writeChunked(frame))
      .catch((e) => {
        writeError = e; // 不许吞：以前 .catch(() => {}) 会把真实写失败抹掉，只剩一个误导人的「响应超时」
      });
    await this.txChain;
    this.onRaw('tx', frame);
    this.log('tx', '发送 ' + frame.length + ' 字节: ' + toHex(frame));
    if (writeError) {
      const t = errText(writeError);
      this.log('error', 'BLE 写失败：' + t + '（帧 ' + frame.length + ' 字节 / MTU=' + this.mtu + ' / 特征 ' + (this.writeId || '?') + '）');
      // 撤销刚登记的响应等待，避免半写状态下留下悬着的超时定时器
      if (p) {
        p.catch(() => {}); // 下面 rejectAll 会拒绝它，但没人 await，标记为已处理
        this.rejectAll(new Error('BLE 写失败：' + t));
      }
      throw new Error('BLE 写失败：' + t);
    }
    if (!p) return null;
    const body = await p;
    this.log('rx', '响应 ' + body.length + ' 字节: ' + toHex(body));
    return body;
  }

  waitForFrame(ms) {
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('等待车辆响应超时 ' + ms + 'ms（可能没订阅成功 / 车辆休眠 / MTU 不足）'));
      }, ms);
      this.waiters.push(w);
    });
  }

  // 不发送，只等车辆下一帧（V3 白名单/RKE 操作会连发多个 ACK，官方用 readUntil 循环收）。
  // 超时返回 null，不抛错；开启暂存后，处理上一帧期间到达的帧也不会丢。
  async receive(timeoutMs) {
    if (!this.connected) throw new Error('尚未连接车辆');
    this.buffering = true;
    if (this.queue.length) {
      const body = this.queue.shift();
      this.log('rx', '取暂存帧 ' + body.length + ' 字节: ' + toHex(body));
      return body;
    }
    try {
      const body = await this.waitForFrame(timeoutMs === undefined ? 3000 : timeoutMs);
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
  async writeChunked(frame) {
    const cap = payloadCap(this.mtu);
    const parts = Math.ceil(frame.length / cap);
    if (frame.length > cap) {
      this.log('info', '帧长 ' + frame.length + ' > MTU 可用 ' + cap + '，按官方规则分成 ' + parts + ' 片写');
    }
    let idx = 0;
    for (let off = 0; off < frame.length; off += cap) {
      const size = Math.min(cap, frame.length - off);
      await this.writePart(frame.subarray(off, off + size), idx + 1, parts, off);
      idx++;
      await delay(20); // 给车机一点处理时间，避免连写丢包
    }
  }

  // 写一片。只有「写属性不匹配」这类拒绝才换 writeType 重试（换写法不会让车端多收或少收字节）；
  // 其它错误立刻原样上抛，绝不重发 —— 前一片已经落进车端组包缓冲，重复发会拼出坏帧。
  async writePart(chunk, partNo, parts, offset) {
    const order = this.writeTypeOrder();
    const tried = [];
    let lastErr = null;
    for (const wt of order) {
      tried.push(wt);
      try {
        await bleApi('writeBLECharacteristicValue', {
          deviceId: this.deviceId,
          serviceId: this.serviceId,
          characteristicId: this.writeId,
          writeType: wt,
          value: bytesToAb(chunk)
        });
        if (this.writeType !== wt) {
          this.writeType = wt;
          this.log('info', '写入方式 = ' + wt + '（0x212 属性 ' + writePropsText(this.writeProps) + '），本次连接后续都按它写');
        }
        return;
      } catch (e) {
        lastErr = e;
        const text = errText(e);
        if (!isPropertyReject(text)) break;
        this.log('warn', wt + ' 写入被拒（' + text + '），换下一种写入方式重试');
      }
    }
    const text = errText(lastErr);
    const hint = isPropertyReject(text)
      ? '（已试 writeType=' + tried.join(' / ') + '；0x212 属性 ' + writePropsText(this.writeProps) +
        '，MTU=' + this.mtu + ' 每包上限 ' + payloadCap(this.mtu) + ' 字节）'
      : '';
    throw new Error('第 ' + partNo + '/' + parts + ' 片（' + chunk.length + ' 字节，偏移 ' + offset + '）写入失败：' + text + hint);
  }

  writeTypeOrder() {
    const cands = writeTypeCandidates(this.writeProps);
    if (this.writeType && cands.indexOf(this.writeType) >= 0) {
      return [this.writeType].concat(cands.filter((x) => x !== this.writeType));
    }
    return cands;
  }

  async readVersion() {
    if (!this.versionId) throw new Error('没有 0214 特征');
    const res = await bleApi('readBLECharacteristicValue', {
      deviceId: this.deviceId,
      serviceId: this.serviceId,
      characteristicId: this.versionId
    });
    const bytes = res && res.value ? abToBytes(res.value) : null;
    if (bytes) this.log('ok', '通信协议版本 = ' + toHex(bytes));
    return bytes;
  }

  async disconnect() {
    this.rejectAll(new Error('主动断开'));
    if (this.deviceId) {
      await bleApi('closeBLEConnection', { deviceId: this.deviceId }).catch(() => {});
    }
    this.connected = false;
    this.setState('idle');
    this.log('info', '已断开');
  }

  async close() {
    await this.disconnect();
    await bleApi('closeBluetoothAdapter', {}).catch(() => {});
  }
}

export default BleTransport;
