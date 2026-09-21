// P-256 (secp256r1 / prime256v1) 有限域 + 椭圆曲线 ECDH，纯 JS 实现。
//
// 不用 BigInt：uni-app App 端逻辑层是 JSCore，老版本没有 BigInt，
// 所以这里用 base 2^16 的 16  limb 数组做模运算（乘积累加最大 16*2^32 < 2^53，双精度安全）。
//
// 正确性由 tests/run.mjs 与 Node 的 crypto.createECDH('prime256v1') 交叉验证。

const NL = 16; // limb 数
const MASK = 0xffff;

function limbsFromHex(hex) {
  const out = new Array(NL).fill(0);
  for (let i = 0; i < NL; i++) {
    // limb i 是最低端的第 i 个 16 位字 -> 取 hex 末尾第 i 组 4 个字符
    const start = hex.length - 4 * i - 4;
    out[i] = parseInt(hex.substr(start, 4), 16);
  }
  return out;
}

// NIST P-256 参数
const P = limbsFromHex('ffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
const N = limbsFromHex('ffffffffffffffffffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const Gx = limbsFromHex('6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296');
const Gy = limbsFromHex('4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5');
const B = limbsFromHex('5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b');
const ONE = (() => { const a = new Array(NL).fill(0); a[0] = 1; return a; })();

function clone(a) { return a.slice(); }
function isZero(a) { for (let i = 0; i < NL; i++) if (a[i] !== 0) return false; return true; }
function cmp(a, b) {
  for (let i = NL - 1; i >= 0; i--) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

// r -= m，返回是否借位（1 = 结果为负，已 mod 2^256）
function subRaw(r, m) {
  let borrow = 0;
  for (let j = 0; j < NL; j++) {
    const cur = r[j] - borrow - m[j];
    const q = Math.floor(cur / 65536);
    r[j] = cur - q * 65536;
    borrow = -q;
  }
  return borrow > 0 ? 1 : 0;
}

// r += m，返回进位
function addRaw(r, m) {
  let c = 0;
  for (let j = 0; j < NL; j++) {
    const s = r[j] + m[j] + c;
    r[j] = s & MASK;
    c = s >>> 16;
  }
  return c;
}

// a + b (mod m)
function addMod(a, b, m) {
  const r = new Array(NL).fill(0);
  let c = 0;
  for (let j = 0; j < NL; j++) {
    const s = a[j] + b[j] + c;
    r[j] = s & MASK;
    c = s >>> 16;
  }
  for (let k = 0; k < 4; k++) {
    if (c === 0 && cmp(r, m) < 0) break;
    c -= subRaw(r, m);
  }
  return r;
}

// a - b (mod m)
function subMod(a, b, m) {
  const r = a.slice();
  const borrow = subRaw(r, b);
  if (borrow) addRaw(r, m);
  return r;
}

// r += L * m，从 offset 开始（m 为 16 limb，L < 2^16）
function addMul(a, offset, m, L) {
  let carry = 0;
  for (let j = 0; j < NL; j++) {
    const cur = a[offset + j] + carry + L * m[j];
    const q = Math.floor(cur / 65536);
    a[offset + j] = cur - q * 65536;
    carry = q;
  }
  let k = offset + NL;
  while (carry > 0 && k < a.length) {
    const cur = a[k] + carry;
    const q = Math.floor(cur / 65536);
    a[k] = cur - q * 65536;
    carry = q;
    k++;
  }
}

// R = 2^256 - m（要求 m 的最高位为 1，则 R < m，可安全用于折叠）
function two256Minus(m) {
  const r = new Array(NL);
  let carry = 1;
  for (let i = 0; i < NL; i++) {
    const cur = MASK - m[i] + carry;
    r[i] = cur & MASK;
    carry = cur >>> 16;
  }
  return r;
}

function normalize(t) {
  for (let k = 0; k < t.length - 1; k++) {
    const q = Math.floor(t[k] / 65536);
    if (q === 0) continue;
    t[k] -= q * 65536;
    t[k + 1] += q;
  }
}

// t（32 limb 以上的乘积累加）归约到 16 limb
function reduceHigh(t, m) {
  normalize(t);
  const R = two256Minus(m);
  // 2^256 ≡ R (mod m)，所以 t[i]*2^(16i) ≡ t[i]*R*2^(16(i-NL))
  // 每一轮把最高非零 limb 清零并向低位加上 L*R；R 至多 16 limb，
  // 因此最高非零下标每轮至少下降 1，33 槽时 <= 18 轮收敛。
  for (let pass = 0; pass < 40; pass++) {
    let hi = -1;
    for (let i = t.length - 1; i >= NL; i--) {
      if (t[i] !== 0) { hi = i; break; }
    }
    if (hi < 0) break;
    const L = t[hi];
    t[hi] = 0;
    addMul(t, hi - NL, R, L);
    normalize(t);
  }
  const r = new Array(NL).fill(0);
  for (let i = 0; i < NL; i++) r[i] = t[i] & MASK;
  for (let k = 0; k < 4; k++) {
    if (cmp(r, m) < 0) break;
    subRaw(r, m);
  }
  return r;
}

// a * b (mod m)
function mulMod(a, b, m) {
  const t = new Array(NL * 2 + 4).fill(0);
  for (let i = 0; i < NL; i++) {
    if (a[i] === 0) continue;
    const ai = a[i];
    for (let j = 0; j < NL; j++) {
      t[i + j] += ai * b[j];
    }
  }
  return reduceHigh(t, m);
}

function sqrMod(a, m) {
  return mulMod(a, a, m);
}

// a^(p-2) mod p —— 模逆（费马小定理，256 次平方 + 约 150 次乘）
function subSmall(a, v) {
  const r = a.slice();
  let borrow = v;
  for (let j = 0; j < NL && borrow > 0; j++) {
    const cur = r[j] - borrow;
    if (cur >= 0) {
      r[j] = cur;
      borrow = 0;
    } else {
      r[j] = cur + 65536;
      borrow = 1;
    }
  }
  return r;
}

function bitOf(a, i) {
  return (a[i >> 4] >>> (i & 15)) & 1;
}

function powMod(base, exp, m) {
  let r = ONE.slice();
  let top = 255;
  while (top > 0 && bitOf(exp, top) === 0) top--;
  for (let i = top; i >= 0; i--) {
    r = sqrMod(r, m);
    if (bitOf(exp, i) === 1) r = mulMod(r, base, m);
  }
  return r;
}

function invMod(a) {
  return powMod(a, subSmall(P, 2), P);
}

// ---- 射影点（Jacobian，a = -3）----
const INF = () => ({ x: new Array(NL).fill(0), y: new Array(NL).fill(0), z: new Array(NL).fill(0) });
function isInf(pt) { return isZero(pt.z); }
function aff(x, y) {
  return { x: x.slice(), y: y.slice(), z: ONE.slice() };
}

function pointDouble(p1) {
  if (isInf(p1)) return INF();
  if (isZero(p1.y)) return INF();
  // a = -3 的 Jacobian 倍点，对任意 Z 成立：
  //   M = 3(X1 - Z1²)(X1 + Z1²)
  //   S = 4·X1·Y1²
  //   X3 = M² - 2S
  //   Y3 = M(S - X3) - 8·Y1⁴
  //   Z3 = 2·Y1·Z1
  const z1z1 = sqrMod(p1.z, P);
  const mx = subMod(p1.x, z1z1, P);
  const px = addMod(p1.x, z1z1, P);
  let m = mulMod(mx, px, P);
  const m2 = addMod(m, m, P);
  m = addMod(m2, m, P); // M = 3(X1-Z1²)(X1+Z1²)
  const yy = sqrMod(p1.y, P);
  let s = mulMod(p1.x, yy, P);
  s = addMod(s, s, P);
  s = addMod(s, s, P); // S = 4·X1·Y1²
  let x3 = sqrMod(m, P);
  x3 = subMod(x3, s, P);
  x3 = subMod(x3, s, P); // X3 = M² - 2S
  const y4 = sqrMod(yy, P);
  let eight = addMod(y4, y4, P);
  eight = addMod(eight, eight, P);
  eight = addMod(eight, eight, P); // 8·Y1⁴
  const y3 = subMod(mulMod(m, subMod(s, x3, P), P), eight, P);
  let z3 = mulMod(p1.y, p1.z, P);
  z3 = addMod(z3, z3, P);
  return { x: x3, y: y3, z: z3 };
}

function pointAdd(p1, p2) {
  if (isInf(p1)) return clonePoint(p2);
  if (isInf(p2)) return clonePoint(p1);
  // Guide to ECC 算法 3.22（Jacobian）：
  //   U1 = X2·Z1²   U2 = X1·Z2²   S1 = Y2·Z1³   S2 = Y1·Z2³
  //   H  = U1-U2    r  = S1-S2
  //   X3 = r² - H³ - 2·U2·H²
  //   Y3 = r·(U2·H² - X3) - S2·H³
  //   Z3 = Z1·Z2·H
  const z1sq = sqrMod(p1.z, P);
  const z2sq = sqrMod(p2.z, P);
  const u1 = mulMod(p2.x, z1sq, P);
  const u2 = mulMod(p1.x, z2sq, P);
  const s1 = mulMod(p2.y, mulMod(z1sq, p1.z, P), P);
  const s2 = mulMod(p1.y, mulMod(z2sq, p2.z, P), P);
  if (cmp(u1, u2) === 0) {
    if (cmp(s1, s2) !== 0) return INF();
    return pointDouble(p1);
  }
  const h = subMod(u1, u2, P);
  const r = subMod(s1, s2, P);
  const h2 = sqrMod(h, P);
  const h3 = mulMod(h2, h, P);
  const u2h2 = mulMod(u2, h2, P);
  let x3 = sqrMod(r, P);
  x3 = subMod(x3, h3, P);
  x3 = subMod(x3, addMod(u2h2, u2h2, P), P);
  const y3 = subMod(mulMod(r, subMod(u2h2, x3, P), P), mulMod(s2, h3, P), P);
  const z3 = mulMod(mulMod(p1.z, p2.z, P), h, P);
  return { x: x3, y: y3, z: z3 };
}

function clonePoint(p) {
  return { x: p.x.slice(), y: p.y.slice(), z: p.z.slice() };
}

function toAffine(p) {
  if (isInf(p)) return null;
  const zi = invMod(p.z);
  const zi2 = mulMod(zi, zi, P);
  return { x: mulMod(p.x, zi2, P), y: mulMod(p.y, mulMod(zi2, zi, P), P) };
}

function scalarMult(k /* Uint8Array 32 */, base) {
  let acc = INF();
  let started = false;
  for (let i = 0; i < 256; i++) {
    const bit = (k[i >> 3] >>> (7 - (i & 7))) & 1;
    if (!started) {
      if (bit === 1) {
        acc = clonePoint(base);
        started = true;
      }
      continue;
    }
    acc = pointDouble(acc);
    if (bit === 1) acc = pointAdd(acc, base);
  }
  return started ? acc : INF();
}

function limbsToBytes(a) {
  const out = new Uint8Array(32);
  for (let i = 0; i < NL; i++) {
    out[31 - 2 * i] = a[i] & 0xff;
    out[30 - 2 * i] = (a[i] >>> 8) & 0xff;
  }
  return out;
}

function bytesToLimbs(bytes) {
  const out = new Array(NL).fill(0);
  for (let i = 0; i < NL; i++) {
    out[i] = (bytes[bytes.length - 1 - 2 * i] | (bytes[bytes.length - 2 - 2 * i] << 8)) & MASK;
  }
  return out;
}

const G = aff(Gx, Gy);

// 点在曲线上？ y^2 = x^3 - 3x + b
export function isOnCurve(x, y) {
  const lhs = sqrMod(y, P);
  let rhs = mulMod(sqrMod(x, P), x, P);
  const threeX = addMod(addMod(x, x, P), x, P);
  rhs = subMod(rhs, threeX, P);
  rhs = addMod(rhs, B, P);
  return cmp(lhs, rhs) === 0;
}

// 32 字节私钥 -> 65 字节未压缩公钥（0x04 || X || Y）
export function publicKeyFromPrivate(priv32) {
  const point = scalarMult(priv32, G);
  const a = toAffine(point);
  if (!a) throw new Error('私钥无效（结果为无穷远点）');
  const x = limbsToBytes(a.x);
  const y = limbsToBytes(a.y);
  const pub = new Uint8Array(65);
  pub[0] = 0x04;
  pub.set(x, 1);
  pub.set(y, 33);
  return pub;
}

// 对端公钥（65 字节未压缩，允许 64 字节裸 X||Y）-> ECDH 共享秘密（32 字节 X）
export function deriveSharedSecret(priv32, peerPublic) {
  if (!(peerPublic.length === 65 || peerPublic.length === 64 || peerPublic.length === 33)) {
    throw new Error('对端公钥长度异常: ' + peerPublic.length);
  }
  if (peerPublic.length === 33) throw new Error('暂不支持压缩点，请让车辆返回未压缩公钥');
  const off = peerPublic.length === 65 ? 1 : 0;
  const x = bytesToLimbs(peerPublic.subarray(off + 0, off + 32));
  const y = bytesToLimbs(peerPublic.subarray(off + 32, off + 64));
  if (cmp(x, P) >= 0 || cmp(y, P) >= 0) throw new Error('对端公钥坐标越界');
  if (!isOnCurve(x, y)) throw new Error('对端公钥不在 P-256 曲线上（可能不是未压缩格式）');
  const point = aff(x, y);
  const shared = scalarMult(priv32, point);
  const a = toAffine(shared);
  if (!a) throw new Error('ECDH 结果为无穷远点');
  return limbsToBytes(a.x);
}

// 把任意 32 字节随机数据约减成合法私钥（d = k mod n，d != 0）
export function normalizePrivateKey(k32) {
  const d = mulMod(bytesToLimbs(k32), ONE, N);
  if (isZero(d)) throw new Error('随机数恰好为 n 的倍数，请重新生成');
  return limbsToBytes(d);
}

export { P, N, G, limbsToBytes, bytesToLimbs, mulMod, addMod, subMod, invMod, toAffine, scalarMult, isZero, cmp };
