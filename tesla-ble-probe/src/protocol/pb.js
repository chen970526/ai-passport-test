// 极简 protobuf wire 编解码（proto3 子集，纯 JS，无依赖、无 BigInt）
//
// 覆盖 Tesla VCSEC / V3 RoutableMessage + car_server（INFOTAINMENT）报文用到的类型：
//   varint(int/enum/bool/u64/sint) / fixed32 / float / double / bytes / string /
//   嵌套 message / repeated（标量按 proto3 默认 packed）
//
// spec 结构由调用方注入（见 ./v3/spec.js），本文件不依赖任何 Tesla 专有定义：
//   { messages: { <MsgName>: [ {name,num,kind,msg?,enum?,rep?,oneof?}, ... ] },
//     enums:    { <EnumName>: { <LABEL>: <value>, ... } } }
//   kind:  'int' | 'enum' | 'bool' | 'u64' | 'sint' | 'fixed32' | 'float' | 'double'
//          | 'bytes' | 'string' | 'msg'
//   oneof: .proto 里该字段所属的 oneof 组名；没有就是普通字段。
//
// 默认值省略只适用于「普通 singular 标量」：proto3 下等于默认值（0 / 空 / false）的
// 非 oneof 标量不编码。oneof 成员是「显式存在」，值为 0 也必须写 tag —— 这是 protobuf
// 官方 Field Presence 表格的规定（protobuf.dev/programming-guides/field-presence/），
// 也是官方 Go 实现的行为：vcsec.go 组 RKE 请求时用
//   SubMessage: &vcsec.UnsignedMessage_RKEAction{RKEAction: action} + proto.Marshal，
// oneof wrapper 会无条件编码；nanopb 侧（tesla-ble/src/client.cpp）靠 which_sub_message
// 达到同样效果。
//
// 这一点对 Tesla 至关重要：RKE_ACTION_UNLOCK = 0，而 UnsignedMessage 整条消息只有
// 一个 oneof sub_message。一旦把 UNLOCK 当普通标量省略，整条内层报文就变成 0 字节，
// 车辆收不到「解锁」这个动作，只会一直回 operation_status=WAIT。

import { toHex, utf8ToBytes } from '../infra/bytes.js';

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

// ---------------------------------------------------------------- 低层读写

function pushVarint(out, value) {
  let v = Math.floor(Number(value));
  if (!isFinite(v) || v < 0) throw new Error('pb: varint 只支持非负数，收到 ' + value);
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
}

// varint 读取：用 lo/hi 两个 32 位累加，绝不因为「超过 2^53」而抛错。
//
// 为什么必须这么改：proto3 的 int32/int64 在 wire 上永远按 64 位符号扩展编码，
// 一个负数（例如 DriveState.power=-5、ClimateState.left_temp_direction）会占满 10 个字节
// （0xFB 0xFF*8 0x01）。老的实现累加到第 9 个字节就 throw，结果一帧 VehicleData 里
// 只要有一个负的 int32，整条解码就崩掉，而不是优雅降级 —— 车辆信息界面会直接空白。
// 官方 Go 用 uint64 存 varint 再由字段类型截断，这里等价地保留低 32 位 + 高 32 位。
const TWO32 = 4294967296;

function readVarint(bytes, pos) {
  let lo = 0; // 低 32 位（无符号）
  let hi = 0; // 高 32 位（无符号）
  let shift = 0;
  let groups = 0;
  let i = pos;
  for (;;) {
    if (i >= bytes.length) throw new Error('pb: varint 读取越界');
    const b = bytes[i++];
    if (++groups > 10) throw new Error('pb: varint 超过 10 字节（非法编码）');
    const part = b & 0x7f;
    if (shift === 28) {
      // 该组横跨 lo/hi 边界：bit28..31 归 lo，bit32..34 归 hi 的 bit0..2
      lo = (lo | ((part & 0x0f) << 28)) >>> 0;
      hi = (hi | (part >>> 4)) >>> 0;
    } else if (shift < 32) {
      lo = (lo | (part << shift)) >>> 0;
    } else {
      hi = (hi | (part << (shift - 32))) >>> 0;
    }
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return { lo, hi, groups, pos: i, value: hi * TWO32 + lo };
}

// int32/uint32/enum 归一：hi==0 就是普通非负值；hi 全 1 且 lo 的最高位是 1，
// 说明这是负 int32 的符号扩展，取 lo 的补码；其余（真正的大 uint64）按 64 位近似值返回。
function normInt(r) {
  if (r.hi === 0) return r.lo;
  if (r.hi === 0xffffffff && (r.lo >>> 31) === 1) return r.lo | 0;
  return r.value;
}

// IEEE754：protobuf 用小端。借用一块 scratch 内存，避免每次分配 DataView。
const scratch = new ArrayBuffer(8);
const scratchU8 = new Uint8Array(scratch);
const scratchView = new DataView(scratch);

function readFloat(bytes, width) {
  const n = width === 8 ? 8 : 4;
  if (bytes.length < n) throw new Error('pb: ' + (n === 4 ? 'float' : 'double') + ' 字段长度不足');
  for (let i = 0; i < n; i++) scratchU8[i] = bytes[i];
  return n === 4 ? scratchView.getFloat32(0, true) : scratchView.getFloat64(0, true);
}

function pushFloat(out, value, width) {
  const n = width === 8 ? 8 : 4;
  if (n === 4) scratchView.setFloat32(0, Number(value), true);
  else scratchView.setFloat64(0, Number(value), true);
  for (let i = 0; i < n; i++) out.push(scratchU8[i]);
}

// zigzag（sint32/sint64）：负数映射成正数再走 varint
function zigzagEncode(n) {
  const v = Math.floor(Number(n));
  if (!isFinite(v)) throw new Error('pb: sint 需要整数，收到 ' + n);
  return v >= 0 ? v * 2 : -v * 2 - 1;
}

function zigzagDecode(value) {
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

function pushTag(out, num, wire) {
  pushVarint(out, num * 8 + wire);
}

function pushLenField(out, num, payload) {
  pushTag(out, num, WIRE_LEN);
  pushVarint(out, payload.length);
  for (let i = 0; i < payload.length; i++) out.push(payload[i]);
}

// 把字节源统一成 Uint8Array（允许传 Array / Buffer / Uint8Array / 十六进制字符串）
// 允许十六进制字符串是为了「报文控制台」里能直接粘 JSON，不用先转成数组。
function asBytes(v, where) {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return new Uint8Array(v);
  if (typeof v === 'string') {
    const s = v.replace(/[^0-9a-fA-F]/g, '');
    if (s.length % 2 !== 0) throw new Error('pb: ' + where + ' 的十六进制字符串长度必须是偶数');
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }
  throw new Error('pb: ' + where + ' 需要 Uint8Array/Array/hex 字符串，收到 ' + typeof v);
}

// ---------------------------------------------------------------- 字段表

function fieldOf(spec, msgName, num) {
  const list = spec.messages[msgName];
  if (!list) throw new Error('pb: 未知 message ' + msgName);
  for (const f of list) if (f.num === num) return f;
  return null;
}

function fieldByName(spec, msgName, name) {
  const list = spec.messages[msgName];
  if (!list) throw new Error('pb: 未知 message ' + msgName);
  for (const f of list) if (f.name === name) return f;
  throw new Error('pb: ' + msgName + ' 没有字段 ' + name);
}

// ---------------------------------------------------------------- 编码

export function encode(spec, msgName, obj) {
  const out = [];
  const oneofUsed = Object.create(null); // oneof 组名 -> 本次已经写入的成员名
  for (const name of Object.keys(obj || {})) {
    const value = obj[name];
    if (value === undefined || value === null) continue;
    const f = fieldByName(spec, msgName, name);
    // oneof 成员一律「显式存在」：force=true 让下面所有「等于默认值就省略」的分支失效。
    // 同时一个 oneof 只允许出现一个成员，给多了 protobuf 编码就是非法的，直接抛错。
    let force = false;
    if (f.oneof) {
      const prev = oneofUsed[f.oneof];
      if (prev !== undefined) {
        throw new Error('pb: ' + msgName + ' 的 oneof ' + f.oneof + ' 同时给了 ' + prev + ' 和 ' + name + '，一次只能选一个');
      }
      oneofUsed[f.oneof] = name;
      force = true;
    }
    if (f.rep) {
      if (!Array.isArray(value)) throw new Error('pb: 字段 ' + msgName + '.' + name + ' 需要数组');
      if (value.length === 0) continue;
      if (f.kind === 'msg' || f.kind === 'bytes') {
        for (const item of value) {
          pushLenField(out, f.num, f.kind === 'msg' ? encode(spec, f.msg, item) : asBytes(item, name));
        }
      } else {
        const packed = [];
        for (const item of value) pushVarint(packed, item);
        pushLenField(out, f.num, new Uint8Array(packed));
      }
      continue;
    }
    switch (f.kind) {
      case 'msg':
        pushLenField(out, f.num, encode(spec, f.msg, value));
        break;
      case 'bytes': {
        const b = asBytes(value, name);
        if (b.length === 0 && !force) continue; // proto3: 普通 bytes 空值省略
        pushLenField(out, f.num, b);
        break;
      }
      case 'string':
        if (value === '' && !force) continue;
        pushLenField(out, f.num, utf8ToBytes(String(value)));
        break;
      case 'fixed32': {
        const n = Number(value);
        if (!isFinite(n) || n < 0) throw new Error('pb: 字段 ' + msgName + '.' + name + ' 需要非负 uint32');
        if (n === 0 && !force) continue; // 普通标量（非 oneof）才按 proto3 省略 0 值
        pushTag(out, f.num, WIRE_FIXED32);
        // protobuf fixed32 是小端 4 字节（例：clock_time=2650 -> 5a0a0000）
        out.push(n & 0xff, Math.floor(n / 0x100) & 0xff, Math.floor(n / 0x10000) & 0xff, Math.floor(n / 0x1000000) & 0xff);
        break;
      }
      case 'float':
      case 'double': {
        const n = Number(value);
        if (!isFinite(n)) throw new Error('pb: 字段 ' + msgName + '.' + name + ' 不是数字');
        if (n === 0 && !force) continue;
        pushTag(out, f.num, f.kind === 'float' ? WIRE_FIXED32 : WIRE_FIXED64);
        pushFloat(out, n, f.kind === 'float' ? 4 : 8);
        break;
      }
      case 'sint': {
        const n = zigzagEncode(value);
        if (n === 0 && !force) continue;
        pushTag(out, f.num, WIRE_VARINT);
        pushVarint(out, n);
        break;
      }
      case 'u64':
      case 'int':
      case 'enum':
      case 'bool': {
        const n = f.kind === 'bool' ? (value ? 1 : 0) : Number(value);
        if (!isFinite(n)) throw new Error('pb: 字段 ' + msgName + '.' + name + ' 不是数字');
        // 普通标量：等于 0 按 proto3 省略。oneof 成员：RKE_ACTION_UNLOCK=0 也必须写，
        // 否则整条 UnsignedMessage 会退化成空报文，车辆只会回 WAIT。
        if (n === 0 && !force) continue;
        pushTag(out, f.num, WIRE_VARINT);
        pushVarint(out, n);
        break;
      }
      default:
        throw new Error('pb: 未知 kind ' + f.kind + ' @ ' + msgName + '.' + name);
    }
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------- 解码（原始）

function decodeRaw(bytes) {
  const list = [];
  let i = 0;
  while (i < bytes.length) {
    const key = readVarint(bytes, i);
    i = key.pos;
    const num = Math.floor(key.value / 8);
    const wire = key.value % 8;
    if (wire === WIRE_VARINT) {
      const r = readVarint(bytes, i);
      i = r.pos;
      list.push({ num, wire, value: r.value, lo: r.lo, hi: r.hi });
    } else if (wire === WIRE_LEN) {
      const l = readVarint(bytes, i);
      i = l.pos;
      if (i + l.value > bytes.length) throw new Error('pb: length 字段越界');
      list.push({ num, wire, value: bytes.slice(i, i + l.value) });
      i += l.value;
    } else if (wire === WIRE_FIXED64 || wire === WIRE_FIXED32) {
      const n = wire === WIRE_FIXED64 ? 8 : 4;
      if (i + n > bytes.length) throw new Error('pb: fixed 字段越界');
      list.push({ num, wire, value: bytes.slice(i, i + n) });
      i += n;
    } else {
      throw new Error('pb: 不支持的 wire type ' + wire);
    }
  }
  return list;
}

// protobuf fixed32 是小端
function le32(bytes) {
  return bytes[0] + bytes[1] * 0x100 + bytes[2] * 0x10000 + bytes[3] * 0x1000000;
}

function bytesToUtf8Safe(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  try {
    return decodeURIComponent(escape(s));
  } catch (e) {
    return s; // 非法 UTF-8 时退化为 latin1，保证日志不抛错
  }
}

// 字段类型与 wire type 是否匹配。手写协议表（src/protocol/v3/spec.js 里几百个字段号）一旦某个
// 字段号抄错，最坏情况是「整帧解码抛错 → 车辆信息界面全白」。这里先校验，不匹配就
// 按未知字段降级成 hex，日志里看得见，其他字段照常解析。
function wireMatches(kind, wire) {
  switch (kind) {
    case 'msg':
    case 'bytes':
    case 'string':
      return wire === WIRE_LEN;
    case 'int':
    case 'enum':
    case 'bool':
    case 'u64':
    case 'sint':
      return wire === WIRE_VARINT;
    case 'fixed32':
    case 'float':
      return wire === WIRE_FIXED32;
    case 'double':
      return wire === WIRE_FIXED64;
    default:
      return false;
  }
}

function mapFields(spec, msgName, raw) {
  const obj = {};
  for (const r of raw) {
    const f = fieldOf(spec, msgName, r.num);
    if (!f || !wireMatches(f.kind, r.wire)) {
      obj['f' + r.num] = r.wire === WIRE_VARINT ? r.value : '<' + toHex(asBytes(r.value, 'raw')) + '>';
      continue;
    }
    if (f.rep && (f.kind === 'int' || f.kind === 'enum' || f.kind === 'bool' || f.kind === 'sint' || f.kind === 'u64')) {
      // packed（LEN 包裹）与 unpacked（逐个 varint）都要能解
      if (r.wire === WIRE_LEN) {
        const acc = [];
        let i = 0;
        while (i < r.value.length) {
          const v = readVarint(r.value, i);
          i = v.pos;
          acc.push(f.kind === 'sint' ? zigzagDecode(v.value) : normInt(v));
        }
        obj[f.name] = acc;
      } else {
        if (!Array.isArray(obj[f.name])) obj[f.name] = [];
        obj[f.name].push(f.kind === 'bool' ? r.value !== 0 : normInt(r));
      }
      continue;
    }
    if (f.rep) {
      if (!Array.isArray(obj[f.name])) obj[f.name] = [];
      obj[f.name].push(f.kind === 'msg' ? mapFields(spec, f.msg, decodeRaw(r.value)) : r.value);
      continue;
    }
    switch (f.kind) {
      case 'msg':
        obj[f.name] = mapFields(spec, f.msg, decodeRaw(r.value));
        break;
      case 'bytes':
        obj[f.name] = asBytes(r.value, f.name);
        break;
      case 'string':
        obj[f.name] = bytesToUtf8Safe(asBytes(r.value, f.name));
        break;
      case 'bool':
        obj[f.name] = r.value !== 0;
        break;
      case 'sint':
        obj[f.name] = zigzagDecode(r.value);
        break;
      case 'u64':
        obj[f.name] = r.value;
        break;
      case 'float':
      case 'double':
        obj[f.name] = readFloat(asBytes(r.value, f.name), f.kind === 'float' ? 4 : 8);
        break;
      case 'fixed32':
        obj[f.name] = r.wire === WIRE_FIXED32 ? le32(asBytes(r.value, f.name)) : r.value;
        break;
      default:
        // int / enum：负 int32 是 10 字节符号扩展，用 normInt 归一回负数
        obj[f.name] = normInt(r);
    }
  }
  return obj;
}

export function decode(spec, msgName, bytes) {
  return mapFields(spec, msgName, decodeRaw(asBytes(bytes, msgName)));
}

// ---------------------------------------------------------------- 日志友好输出

function enumLabel(spec, enumName, value) {
  const map = spec.enums[enumName];
  if (!map) return String(value);
  for (const k of Object.keys(map)) if (map[k] === value) return k + '(' + value + ')';
  return '?(' + value + ')';
}

// 把解码结果渲染成可读字符串（bytes 转 hex，enum 带名字）
export function inspect(spec, msgName, obj, indent) {
  const pad = ' '.repeat(indent || 0);
  const parts = [];
  for (const name of Object.keys(obj)) {
    const value = obj[name];
    const f = fieldByNameOptional(spec, msgName, name);
    if (value instanceof Uint8Array) {
      parts.push(name + '=' + toHex(value));
    } else if (Array.isArray(value) && value.length && value[0] instanceof Uint8Array) {
      parts.push(name + '=[' + value.map((b) => toHex(b)).join(',') + ']');
    } else if (Array.isArray(value) && value.length && typeof value[0] === 'object') {
      parts.push(name + '=[' + value.map((v) => inspect(spec, f ? f.msg : '?', v, 0)).join(' | ') + ']');
    } else if (value && typeof value === 'object') {
      parts.push(name + '{' + inspect(spec, f ? f.msg : '?', value, 0) + '}');
    } else if (f && f.kind === 'enum') {
      parts.push(name + '=' + (Array.isArray(value) ? value.map((v) => enumLabel(spec, f.enum, v)).join(',') : enumLabel(spec, f.enum, value)));
    } else if (f && (f.kind === 'float' || f.kind === 'double') && typeof value === 'number') {
      // getFloat32 会把 21.4 还原成 21.399999618530273，日志里按有效位截一下
      parts.push(name + '=' + String(Math.round(value * 1000) / 1000));
    } else {
      parts.push(name + '=' + JSON.stringify(value));
    }
  }
  return pad + parts.join(' ');
}

function fieldByNameOptional(spec, msgName, name) {
  const list = spec.messages[msgName];
  if (!list) return null;
  for (const f of list) if (f.name === name) return f;
  return null;
}
