// SHA-1（纯 JS）。Tesla 用它派生 keyId 和 session 共享密钥。
import { beBytes } from './bytes.js';

const MASK = 0xffffffff;

function rotl(v, n) {
  return ((v << n) | (v >>> (32 - n))) >>> 0;
}

function processBlock(h, block, offset) {
  const w = new Array(80);
  for (let i = 0; i < 16; i++) {
    const p = offset + i * 4;
    w[i] = ((block[p] << 24) | (block[p + 1] << 16) | (block[p + 2] << 8) | block[p + 3]) >>> 0;
  }
  for (let i = 16; i < 80; i++) {
    w[i] = rotl((w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]) >>> 0, 1);
  }
  let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
  for (let i = 0; i < 80; i++) {
    let f, k;
    if (i < 20) {
      f = (b & c) | (~b & d);
      k = 0x5a827999;
    } else if (i < 40) {
      f = b ^ c ^ d;
      k = 0x6ed9eba1;
    } else if (i < 60) {
      f = (b & c) | (b & d) | (c & d);
      k = 0x8f1bbcdc;
    } else {
      f = b ^ c ^ d;
      k = 0xca62c1d6;
    }
    const temp = (rotl(a, 5) + f + e + k + w[i]) & MASK;
    e = d;
    d = c;
    c = rotl(b, 30);
    b = a;
    a = temp >>> 0;
  }
  h[0] = (h[0] + a) & MASK;
  h[1] = (h[1] + b) & MASK;
  h[2] = (h[2] + c) & MASK;
  h[3] = (h[3] + d) & MASK;
  h[4] = (h[4] + e) & MASK;
}

export function sha1(bytes) {
  const len = bytes.length;
  const bitLenHi = Math.floor(len / 0x20000000); // len * 8 / 2^32
  const bitLenLo = (len << 3) >>> 0;
  const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const total = padded.length;
  padded[total - 8] = (bitLenHi >>> 24) & 0xff;
  padded[total - 7] = (bitLenHi >>> 16) & 0xff;
  padded[total - 6] = (bitLenHi >>> 8) & 0xff;
  padded[total - 5] = bitLenHi & 0xff;
  padded[total - 4] = (bitLenLo >>> 24) & 0xff;
  padded[total - 3] = (bitLenLo >>> 16) & 0xff;
  padded[total - 2] = (bitLenLo >>> 8) & 0xff;
  padded[total - 1] = bitLenLo & 0xff;
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  for (let off = 0; off < total; off += 64) processBlock(h, padded, off);
  const out = new Uint8Array(20);
  for (let i = 0; i < 5; i++) out.set(beBytes(h[i] >>> 0, 4), i * 4);
  return out;
}

export default sha1;
