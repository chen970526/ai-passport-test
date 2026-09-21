// AES-128 分组加密 + AES-GCM（支持任意长度 nonce，含特斯拉的 4 字节 nonce）
//
// 为什么要自己写：
//  1. uni-app App 端逻辑层（JSCore）没有 WebCrypto，也没有 node crypto。
//  2. 几乎所有库（WebCrypto / OpenSSL / cryptography.io / node crypto）都拒绝或改写
//     非 12 字节 nonce，而特斯拉 RKE 报文用的是 counter 的大端 4 字节当 nonce。
//     参考 https://www.teslabtapi.com/docs/start
//
// S-box 在模块加载时按 FIPS-197 定义算出（GF(2^8) 求逆 + 仿射变换），
// 避免手抄 256 字节常量表出错；正确性由 tests/run.mjs 与 Node 官方实现逐字节比对。

const POLY = 0x1b;

function buildSbox() {
  const exp = new Uint8Array(256);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x = x ^ (((x << 1) & 0xff) ^ (x & 0x80 ? POLY : 0)); // x *= 3（0x03 是本原元）
  }
  const inv = new Uint8Array(256);
  for (let a = 1; a < 256; a++) inv[a] = exp[(255 - log[a]) % 255];
  const rotr = (v, k) => ((v >> k) | (v << (8 - k))) & 0xff;
  const sbox = new Uint8Array(256);
  for (let a = 0; a < 256; a++) {
    const y = inv[a];
    sbox[a] = (y ^ rotr(y, 4) ^ rotr(y, 5) ^ rotr(y, 6) ^ rotr(y, 7) ^ 0x63) & 0xff;
  }
  return sbox;
}

const SBOX = buildSbox();

function gmul2(v) {
  const shifted = (v << 1) & 0xff;
  return (v & 0x80 ? shifted ^ POLY : shifted) & 0xff;
}

// 16 字节密钥 -> 176 字节轮密钥
export function expandKey(key16) {
  const w = new Uint32Array(44);
  for (let i = 0; i < 4; i++) {
    w[i] =
      ((key16[4 * i] << 24) |
        (key16[4 * i + 1] << 16) |
        (key16[4 * i + 2] << 8) |
        key16[4 * i + 3]) >>>
      0;
  }
  let rcon = 1;
  for (let i = 4; i < 44; i++) {
    let t = w[i - 1];
    if (i % 4 === 0) {
      t = ((t << 8) | (t >>> 24)) >>> 0; // RotWord
      t =
        ((SBOX[(t >>> 24) & 0xff] << 24) |
          (SBOX[(t >>> 16) & 0xff] << 16) |
          (SBOX[(t >>> 8) & 0xff] << 8) |
          SBOX[t & 0xff]) >>>
        0; // SubWord
      t = (t ^ (rcon << 24)) >>> 0;
      rcon = gmul2(rcon);
    }
    w[i] = (w[i - 4] ^ t) >>> 0;
  }
  const out = new Uint8Array(176);
  for (let i = 0; i < 44; i++) {
    out[4 * i] = (w[i] >>> 24) & 0xff;
    out[4 * i + 1] = (w[i] >>> 16) & 0xff;
    out[4 * i + 2] = (w[i] >>> 8) & 0xff;
    out[4 * i + 3] = w[i] & 0xff;
  }
  return out;
}

function encryptBlock(rk, input, inOff, output, outOff) {
  const s = new Uint8Array(16);
  const t = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = input[inOff + i] ^ rk[i];
  for (let round = 1; round <= 10; round++) {
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        t[4 * c + r] = SBOX[s[4 * ((r + c) % 4) + r]]; // SubBytes + ShiftRows
      }
    }
    s.set(t);
    if (round !== 10) {
      for (let c = 0; c < 4; c++) {
        const o = 4 * c;
        const a0 = s[o], a1 = s[o + 1], a2 = s[o + 2], a3 = s[o + 3];
        s[o] = gmul2(a0) ^ (gmul2(a1) ^ a1) ^ a2 ^ a3;
        s[o + 1] = a0 ^ (gmul2(a2) ^ a2) ^ gmul2(a1) ^ a3;
        s[o + 2] = a0 ^ a1 ^ (gmul2(a3) ^ a3) ^ gmul2(a2);
        s[o + 3] = (gmul2(a0) ^ a0) ^ a1 ^ a2 ^ gmul2(a3);
      }
    }
    for (let i = 0; i < 16; i++) s[i] ^= rk[16 * round + i];
  }
  for (let i = 0; i < 16; i++) output[outOff + i] = s[i];
}

export function aes128EncryptBlock(key16, block16) {
  const out = new Uint8Array(16);
  encryptBlock(expandKey(key16), block16, 0, out, 0);
  return out;
}

// ---- GF(2^128) 乘法（按 GCM 定义：byte0 的 MSB 是最高次项）----
function gfMul(x, y) {
  const z = new Uint8Array(16);
  const v = new Uint8Array(16);
  v.set(y);
  for (let i = 0; i < 128; i++) {
    if (((x[i >> 3] >>> (7 - (i & 7))) & 1) === 1) {
      for (let j = 0; j < 16; j++) z[j] ^= v[j];
    }
    const lsb = v[15] & 1;
    for (let j = 15; j > 0; j--) v[j] = (v[j] >>> 1) | ((v[j - 1] & 1) << 7);
    v[0] >>>= 1;
    if (lsb) v[0] ^= 0xe1; // R
  }
  return z;
}

// acc: 16 字节累加器；data: 任意长度（内部按 16 字节补零分块）
function ghashUpdate(acc, H, data) {
  for (let off = 0; off < data.length; off += 16) {
    for (let j = 0; j < 16; j++) acc[j] ^= off + j < data.length ? data[off + j] : 0;
    const next = gfMul(acc, H);
    acc.set(next);
  }
  return acc;
}

function ghash(H, data) {
  return ghashUpdate(new Uint8Array(16), H, data);
}

function pad16(data) {
  const n = Math.ceil(data.length / 16) * 16;
  const out = new Uint8Array(n);
  out.set(data, 0);
  return out;
}

function putBits64(out, base, byteLen) {
  let x = byteLen * 8;
  for (let i = base + 7; i >= base; i--) {
    out[i] = x & 0xff;
    x = Math.floor(x / 256);
  }
}

function computeJ0(H, rk, nonce) {
  const j0 = new Uint8Array(16);
  if (nonce.length === 12) {
    j0.set(nonce);
    j0[12] = 0;
    j0[13] = 0;
    j0[14] = 0;
    j0[15] = 1;
    return j0;
  }
  // 通用路径（SP 800-38D §7.1）：J0 = GHASH_H(IV || 0^(s+64) || [len(IV)]_64)
  // 注意：这里**不再**套一层 AES 加密。
  const buf = pad16(nonce);
  const full = new Uint8Array(buf.length + 16);
  full.set(buf, 0);
  // [len(A)]_64 = 0 已为零，只需写 [len(IV)*8]_64
  putBits64(full, buf.length + 8, nonce.length);
  return ghash(H, full);
}

function inc32(c) {
  for (let i = 15; i >= 12; i--) {
    c[i] = (c[i] + 1) & 0xff;
    if (c[i] !== 0) return;
  }
}

function gctr(rk, counter, input) {
  const out = new Uint8Array(input.length);
  for (let off = 0; off < input.length; off += 16) {
    const ks = new Uint8Array(16);
    encryptBlock(rk, counter, 0, ks, 0);
    const n = Math.min(16, input.length - off);
    for (let j = 0; j < n; j++) out[off + j] = input[off + j] ^ ks[j];
    if (off + n < input.length) inc32(counter);
  }
  return out;
}

function tagOf(rk, H, j0, aad, payload) {
  const acc = ghashUpdate(new Uint8Array(16), H, pad16(aad));
  ghashUpdate(acc, H, pad16(payload));
  const lens = new Uint8Array(16);
  putBits64(lens, 0, aad.length);
  putBits64(lens, 8, payload.length);
  ghashUpdate(acc, H, lens);
  const ej0 = new Uint8Array(16);
  encryptBlock(rk, j0, 0, ej0, 0);
  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i++) tag[i] = acc[i] ^ ej0[i];
  return tag;
}

// AES-128-GCM；nonce 可为 1..n 字节（特斯拉传 4 字节）
// 返回 { ciphertext, tag }
export function aes128GcmEncrypt(key16, nonce, plaintext, aad) {
  const rk = expandKey(key16);
  const H = new Uint8Array(16);
  encryptBlock(rk, new Uint8Array(16), 0, H, 0);
  const j0 = computeJ0(H, rk, nonce);
  const counter = new Uint8Array(16);
  counter.set(j0);
  inc32(counter);
  const ciphertext = gctr(rk, counter, plaintext);
  const tag = tagOf(rk, H, j0, aad || new Uint8Array(0), ciphertext);
  return { ciphertext, tag };
}

// 解密并返回 { plaintext, expectedTag }（探针用途：不抛错，交给调用方比对/打日志）
export function aes128GcmDecrypt(key16, nonce, ciphertext, aad) {
  const rk = expandKey(key16);
  const H = new Uint8Array(16);
  encryptBlock(rk, new Uint8Array(16), 0, H, 0);
  const j0 = computeJ0(H, rk, nonce);
  const counter = new Uint8Array(16);
  counter.set(j0);
  inc32(counter);
  const plaintext = gctr(rk, counter, ciphertext);
  const expectedTag = tagOf(rk, H, j0, aad || new Uint8Array(0), ciphertext);
  return { plaintext, expectedTag };
}

// 随机字节（App 逻辑层没有 WebCrypto）。
// 用模块级持久 xoshiro128** 状态，种子取自 4 次独立 Math.random + 时间 + 堆地址噪声，
// 避免每次调用只用一个 32bit 种子（那样 32 字节私钥只隐含 32bit 熵）。
// 探针用途可接受；正式产品必须换成原生 CSPRNG。
let rs = [0, 0, 0, 0];
(function seedRandom() {
  const now = Date.now();
  const perf = typeof performance !== 'undefined' && performance && performance.now
    ? performance.now() * 1000
    : Math.random() * 1e6;
  const pool = [
    Math.floor(Math.random() * 0x100000000),
    Math.floor(Math.random() * 0x100000000),
    Math.floor(Math.random() * 0x100000000),
    Math.floor(Math.random() * 0x100000000),
    now >>> 0,
    Math.floor(now / 0x100000000) >>> 0,
    Math.floor(Math.random() * 0x100000000),
    perf >>> 0
  ];
  for (let i = 0; i < pool.length; i++) {
    rs[i % 4] = (rs[i % 4] ^ (pool[i] >>> 0)) >>> 0;
  }
  if (!rs[0] && !rs[1] && !rs[2] && !rs[3]) {
    rs = [(0x9e3779b9 ^ now) >>> 0, 0x243f6a88 >>> 0, 0xb5db139e >>> 0, 0x1b0caec1 >>> 0];
  }
  for (let i = 0; i < 32; i++) nextUint32(); // 预热，打散种子相关性
})();

function rotl(x, k) {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function nextUint32() {
  // xoshiro128**
  const result = (Math.imul(rotl(Math.imul(rs[1], 5), 7), 9)) >>> 0;
  const t = (rs[1] << 9) >>> 0;
  rs[2] = (rs[2] ^ rs[0]) >>> 0;
  rs[3] = (rs[3] ^ rs[1]) >>> 0;
  rs[1] = (rs[1] ^ rs[2]) >>> 0;
  rs[0] = (rs[0] ^ rs[3]) >>> 0;
  rs[2] = (rs[2] ^ t) >>> 0;
  rs[3] = rotl(rs[3], 11);
  return result;
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  let buf = 0;
  for (let i = 0; i < n; i++) {
    if (i % 4 === 0) buf = nextUint32();
    out[i] = (buf >>> ((i % 4) * 8)) & 0xff;
  }
  return out;
}

export { gfMul, ghash };
