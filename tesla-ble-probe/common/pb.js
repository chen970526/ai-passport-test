// 极简 protobuf wire 编解码（proto3 子集，纯 JS，无依赖、无 BigInt）
//
// 只覆盖 Tesla VCSEC 报文用到的类型：
//   varint(int/enum/bool) / bytes / string / 嵌套 message / repeated（标量按 proto3 默认 packed）
// 数值只支持到 2^53 以内（VCSEC 报文里最大的字段是 uint32 counter，够用）。
//
// spec 结构由调用方注入（见 common/spec.js），本文件不依赖任何 Tesla 专有定义：
//   { messages: { <MsgName>: [ {name,num,kind,msg?,enum?,rep?}, ... ] },
//     enums:    { <EnumName>: { <LABEL>: <value>, ... } } }
//   kind: 'int' | 'enum' | 'bool' | 'bytes' | 'string' | 'msg'
//
// 编码遵循 proto3 语义：等于默认值（0 / 空 / false）的 singular 标量字段会被省略。
// 这一点对 Tesla 至关重要：RKE_ACTION_UNLOCK = 0，省略后整个 UnsignedMessage 就是空串，
// 官方与社区实现都是这样发出的（见 teslabtapi docs/more/rke）。

import { toHex, utf8ToBytes } from './bytes.js';

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

function readVarint(bytes, pos) {
  let result = 0;
  let scale = 1;
  let i = pos;
  for (;;) {
    if (i >= bytes.length) throw new Error('pb: varint 读取越界');
    const b = bytes[i++];
    result += (b & 0x7f) * scale;
    if ((b & 0x80) === 0) return { value: result, pos: i };
    scale *= 128;
    if (scale > 4503599627370496) throw new Error('pb: varint 超出安全整数范围');
  }
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
  for (const name of Object.keys(obj || {})) {
    const value = obj[name];
    if (value === undefined || value === null) continue;
    const f = fieldByName(spec, msgName, name);
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
        if (b.length === 0) continue; // proto3: 空 bytes 省略
        pushLenField(out, f.num, b);
        break;
      }
      case 'string':
        if (value === '') continue;
        pushLenField(out, f.num, utf8ToBytes(String(value)));
        break;
      case 'int':
      case 'enum':
      case 'bool': {
        const n = f.kind === 'bool' ? (value ? 1 : 0) : Number(value);
        if (!isFinite(n)) throw new Error('pb: 字段 ' + msgName + '.' + name + ' 不是数字');
        if (n === 0) continue; // proto3: 默认值省略（RKE_ACTION_UNLOCK=0 依赖此行为）
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
      list.push({ num, wire, value: r.value });
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

function bytesToUtf8Safe(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  try {
    return decodeURIComponent(escape(s));
  } catch (e) {
    return s; // 非法 UTF-8 时退化为 latin1，保证日志不抛错
  }
}

function mapFields(spec, msgName, raw) {
  const obj = {};
  for (const r of raw) {
    const f = fieldOf(spec, msgName, r.num);
    if (!f) {
      obj['f' + r.num] = r.wire === WIRE_VARINT ? r.value : '<' + toHex(asBytes(r.value, 'raw')) + '>';
      continue;
    }
    if (f.rep && (f.kind === 'int' || f.kind === 'enum' || f.kind === 'bool')) {
      // packed（LEN 包裹）与 unpacked（逐个 varint）都要能解
      if (r.wire === WIRE_LEN) {
        const acc = [];
        let i = 0;
        while (i < r.value.length) {
          const v = readVarint(r.value, i);
          i = v.pos;
          acc.push(v.value);
        }
        obj[f.name] = acc;
      } else {
        if (!Array.isArray(obj[f.name])) obj[f.name] = [];
        obj[f.name].push(r.value);
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
      default:
        obj[f.name] = r.value;
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
