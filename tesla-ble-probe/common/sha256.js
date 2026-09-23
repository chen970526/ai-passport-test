// SHA-256 / HMAC-SHA256（纯 JS，无依赖）
//
// V3（RoutableMessage）协议大量使用 SHA-256：
//   1) AAD      = SHA256(TLV 元数据 || 0xFF)
//   2) 子密钥    = HMAC-SHA256(K, "session info" / "authenticated command")
// 旧版只用 SHA-1（见 sha1.js），两者互不影响。
//
// 同时提供分块写入的 Sha256 流对象，方便逐段 Add 元数据时不必先拼数组。

const MASK = 0xffffffff;

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rotr(v, n) {
  return ((v >>> n) | (v << (32 - n))) >>> 0;
}

function processBlock(h, block, offset) {
  const w = new Array(64);
  for (let i = 0; i < 16; i++) {
    const p = offset + i * 4;
    w[i] = ((block[p] << 24) | (block[p + 1] << 16) | (block[p + 2] << 8) | block[p + 3]) >>> 0;
  }
  for (let i = 16; i < 64; i++) {
    const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
    const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
  }
  let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
  for (let i = 0; i < 64; i++) {
    const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
    const ch = ((e & f) ^ (~e & g)) >>> 0;
    const temp1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
    const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
    const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
    const temp2 = (S0 + maj) >>> 0;
    hh = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }
  h[0] = (h[0] + a) >>> 0;
  h[1] = (h[1] + b) >>> 0;
  h[2] = (h[2] + c) >>> 0;
  h[3] = (h[3] + d) >>> 0;
  h[4] = (h[4] + e) >>> 0;
  h[5] = (h[5] + f) >>> 0;
  h[6] = (h[6] + g) >>> 0;
  h[7] = (h[7] + hh) >>> 0;
}

const INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
];

// 流式 SHA-256：write(...) / digest()
export function newSha256() {
  return new Sha256State();
}

class Sha256State {
  constructor() {
    this.h = INITIAL.slice();
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    this.total = 0;
  }

  write(bytes) {
    let i = 0;
    while (i < bytes.length) {
      if (this.bufLen === 64) {
        processBlock(this.h, this.buf, 0);
        this.bufLen = 0;
      }
      const n = Math.min(64 - this.bufLen, bytes.length - i);
      this.buf.set(bytes.subarray(i, i + n), this.bufLen);
      this.bufLen += n;
      this.total += n;
      i += n;
    }
    return this;
  }

  digest() {
    const bitLenHi = Math.floor(this.total / 0x20000000); // total * 8 / 2^32
    const bitLenLo = (this.total << 3) >>> 0;
    this.write(new Uint8Array([0x80]));
    const pad = (56 - this.bufLen + 64) % 64;
    this.write(new Uint8Array(pad));
    const tail = new Uint8Array(8);
    tail[0] = (bitLenHi >>> 24) & 0xff;
    tail[1] = (bitLenHi >>> 16) & 0xff;
    tail[2] = (bitLenHi >>> 8) & 0xff;
    tail[3] = bitLenHi & 0xff;
    tail[4] = (bitLenLo >>> 24) & 0xff;
    tail[5] = (bitLenLo >>> 16) & 0xff;
    tail[6] = (bitLenLo >>> 8) & 0xff;
    tail[7] = bitLenLo & 0xff;
    this.write(tail); // 此时 bufLen 恰为 64，需要手动收尾最后一块
    processBlock(this.h, this.buf, 0);
    this.bufLen = 0;
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      const v = this.h[i] >>> 0;
      out[i * 4] = (v >>> 24) & 0xff;
      out[i * 4 + 1] = (v >>> 16) & 0xff;
      out[i * 4 + 2] = (v >>> 8) & 0xff;
      out[i * 4 + 3] = v & 0xff;
    }
    return out;
  }
}

export function sha256(...parts) {
  const s = new Sha256State();
  for (const p of parts) s.write(p);
  return s.digest();
}

const BLOCK = 64;

// HMAC-SHA256(key, ...messages)；key 超过 64B 时先哈希（RFC 2104）
export function hmacSha256(key, ...messages) {
  let k = key;
  if (k.length > BLOCK) k = sha256(k);
  const padKey = new Uint8Array(BLOCK);
  padKey.set(k);
  const inner = new Uint8Array(BLOCK);
  const outer = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    inner[i] = padKey[i] ^ 0x36;
    outer[i] = padKey[i] ^ 0x5c;
  }
  const a = new Sha256State();
  a.write(inner);
  for (const m of messages) a.write(m);
  const innerHash = a.digest();
  const b = new Sha256State();
  b.write(outer);
  b.write(innerHash);
  return b.digest();
}

export default sha256;
