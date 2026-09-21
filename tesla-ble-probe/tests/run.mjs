// 离线自测：把纯 JS 密码学实现与 Node 官方 crypto 逐字节比对。
// 运行： node tesla-ble-probe/tests/run.mjs
// 注意：本文件只在开发机上跑，不参与 uni-app 打包（HBuilderX 不识别 .mjs 也不影响）。
import crypto from 'crypto';
import { toHex, fromHex, concatBytes, beBytes, utf8ToBytes, equalBytes } from '../common/bytes.js';
import { sha1 } from '../common/sha1.js';
import { aes128EncryptBlock, aes128GcmEncrypt, aes128GcmDecrypt, randomBytes } from '../common/aes.js';
import {
  publicKeyFromPrivate,
  deriveSharedSecret,
  normalizePrivateKey,
  isOnCurve,
  bytesToLimbs,
  mulMod,
  addMod,
  subMod,
  invMod,
  P,
  N,
  limbsToBytes
} from '../common/p256.js';
import { SPEC } from '../common/spec.js';
import * as vcsec from '../common/vcsec.js';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  PASS ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra ? '  -> ' + extra : ''));
  }
}
function eqHex(name, a, b) {
  const ha = toHex(a), hb = toHex(b);
  ok(name, ha === hb, 'mine=' + ha + ' ref=' + hb);
}

console.log('[1] SHA-1');
for (const msg of ['', 'abc', '5YJ3E1EA1KF000000', 'a'.repeat(55), 'b'.repeat(64), 'c'.repeat(119)]) {
  const mine = sha1(utf8ToBytes(msg));
  const ref = crypto.createHash('sha1').update(msg).digest();
  eqHex('sha1(' + JSON.stringify(msg.slice(0, 12)) + ' len=' + msg.length + ')', mine, new Uint8Array(ref));
}
{
  const big = new Uint8Array(1000).fill(7);
  eqHex('sha1(1000 字节)', sha1(big), new Uint8Array(crypto.createHash('sha1').update(big).digest()));
}

console.log('[2] AES-128 单块');
for (let i = 0; i < 5; i++) {
  const key = randomBytes(16);
  const blk = randomBytes(16);
  const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(key), null);
  c.setAutoPadding(false);
  const ref = new Uint8Array(Buffer.concat([c.update(Buffer.from(blk)), c.final()]));
  eqHex('aes-128-ecb block#' + i, aes128EncryptBlock(key, blk), ref);
}

console.log('[3] AES-128-GCM（12 字节 nonce）');
for (let i = 0; i < 4; i++) {
  const key = randomBytes(16);
  const nonce = randomBytes(12);
  const pt = randomBytes(i * 17 + 3);
  const c = crypto.createCipheriv('aes-128-gcm', Buffer.from(key), Buffer.from(nonce));
  const ref = new Uint8Array(Buffer.concat([c.update(Buffer.from(pt)), c.final()]));
  const refTag = new Uint8Array(c.getAuthTag());
  const mine = aes128GcmEncrypt(key, nonce, pt, new Uint8Array(0));
  eqHex('gcm12 ct#' + i, mine.ciphertext, ref);
  eqHex('gcm12 tag#' + i, mine.tag, refTag);
}
{
  // 带 AAD 的用例
  const key = randomBytes(16);
  const nonce = randomBytes(12);
  const pt = randomBytes(40);
  const aad = fromHex('deadbeef01');
  const c = crypto.createCipheriv('aes-128-gcm', Buffer.from(key), Buffer.from(nonce));
  c.setAAD(Buffer.from(aad));
  const ref = new Uint8Array(Buffer.concat([c.update(Buffer.from(pt)), c.final()]));
  const mine = aes128GcmEncrypt(key, nonce, pt, aad);
  eqHex('gcm12+aad ct', mine.ciphertext, ref);
  eqHex('gcm12+aad tag', mine.tag, new Uint8Array(c.getAuthTag()));
}

console.log('[4] AES-128-GCM（4 字节 nonce，特斯拉用法）');
let nodeAccepts4 = true;
for (let i = 0; i < 3; i++) {
  const key = randomBytes(16);
  const nonce = beBytes(i + 1, 4);
  const pt = randomBytes(i * 21 + 5);
  let ref, refTag;
  try {
    const c = crypto.createCipheriv('aes-128-gcm', Buffer.from(key), Buffer.from(nonce));
    ref = new Uint8Array(Buffer.concat([c.update(Buffer.from(pt)), c.final()]));
    refTag = new Uint8Array(c.getAuthTag());
  } catch (e) {
    nodeAccepts4 = false;
    console.log('  SKIP Node 拒绝 4 字节 nonce: ' + e.message);
    break;
  }
  const mine = aes128GcmEncrypt(key, nonce, pt, new Uint8Array(0));
  eqHex('gcm4 ct#' + i, mine.ciphertext, ref);
  eqHex('gcm4 tag#' + i, mine.tag, refTag);
  const dec = aes128GcmDecrypt(key, nonce, ref, new Uint8Array(0));
  eqHex('gcm4 解密 ct#' + i, dec.plaintext, pt);
  eqHex('gcm4 重算 tag#' + i, dec.expectedTag, refTag);
}
if (!nodeAccepts4) {
  const key = randomBytes(16);
  const nonce = beBytes(3, 4);
  const pt = utf8ToBytes('self-consistency-check');
  const enc = aes128GcmEncrypt(key, nonce, pt, new Uint8Array(0));
  const dec = aes128GcmDecrypt(key, nonce, enc.ciphertext, new Uint8Array(0));
  ok('gcm4 自洽解密', equalBytes(dec.plaintext, pt) && equalBytes(dec.expectedTag, enc.tag));
}
// >=13 字节 nonce 走 GHASH 派生路径，覆盖通用分支
{
  const key = randomBytes(16);
  const nonce = randomBytes(20);
  const pt = randomBytes(35);
  const c = crypto.createCipheriv('aes-128-gcm', Buffer.from(key), Buffer.from(nonce));
  const ref = new Uint8Array(Buffer.concat([c.update(Buffer.from(pt)), c.final()]));
  const mine = aes128GcmEncrypt(key, nonce, pt, new Uint8Array(0));
  eqHex('gcm20 ct', mine.ciphertext, ref);
  eqHex('gcm20 tag', mine.tag, new Uint8Array(c.getAuthTag()));
}

console.log('[5] P-256 域运算（对拍 BigInt 参考实现）');
{
  const toBig = (limbs) => {
    let v = 0n;
    for (let i = limbs.length - 1; i >= 0; i--) v = (v << 16n) | BigInt(limbs[i] & 0xffff);
    return v;
  };
  const fromBig = (v) => {
    const out = new Uint8Array(32);
    let x = v;
    for (let i = 31; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
    return out;
  };
  const modInvBig = (a, m) => {
    let old_r = a, r = m, old_s = 1n, s = 0n;
    while (r !== 0n) {
      const q = old_r / r;
      const t1 = r; r = old_r - q * r; old_r = t1;
      const t2 = s; s = old_s - q * s; old_s = t2;
    }
    return ((old_s % m) + m) % m;
  };
  const Pmod = toBig(P), Nmod = toBig(N);
  ok('P 常量正确', Pmod === 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn);
  ok('N 常量正确', Nmod === 0xffffffffffffffffffffffffffffffffbce6faada7179e84f3b9cac2fc632551n);
  for (let i = 0; i < 4; i++) {
    const la = bytesToLimbs(randomBytes(32));
    const lb = bytesToLimbs(randomBytes(32));
    const ba = toBig(la) % Pmod, bb = toBig(lb) % Pmod;
    eqHex('mulMod#' + i, limbsToBytes(mulMod(la, lb, P)), fromBig((ba * bb) % Pmod));
    eqHex('addMod#' + i, limbsToBytes(addMod(la, lb, P)), fromBig((ba + bb) % Pmod));
    eqHex('subMod#' + i, limbsToBytes(subMod(la, lb, P)), fromBig((ba - bb + Pmod) % Pmod));
    if (bb !== 0n) eqHex('invMod#' + i, limbsToBytes(invMod(lb)), fromBig(modInvBig(bb, Pmod)));
  }
  for (let i = 0; i < 2; i++) {
    const la = bytesToLimbs(normalizePrivateKey(randomBytes(32)));
    const lb = bytesToLimbs(normalizePrivateKey(randomBytes(32)));
    const na = toBig(la), nb = toBig(lb);
    eqHex('mulMod mod N#' + i, limbsToBytes(mulMod(la, lb, N)), fromBig((na * nb) % Nmod));
  }
}

console.log('[6] P-256 公钥派生 / ECDH');
{
  // 生成元自检：d=1 的公钥必须就是 G（曾因 Gy 抄错一个 hex 位而全错）
  const small = (v) => { const a = new Uint8Array(32); a[31] = v; return a; };
  for (const v of [1, 2, 3, 7]) {
    const e1 = crypto.createECDH('prime256v1');
    e1.setPrivateKey(Buffer.from(small(v)));
    eqHex('pub(' + v + 'G) 与 Node 一致', publicKeyFromPrivate(small(v)), new Uint8Array(e1.getPublicKey()));
  }
}
for (let i = 0; i < 4; i++) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const priv = new Uint8Array(ecdh.getPrivateKey());
  const padded = new Uint8Array(32);
  padded.set(priv, 32 - priv.length);
  const refPub = new Uint8Array(ecdh.getPublicKey());
  const t0 = Date.now();
  const minePub = publicKeyFromPrivate(padded);
  console.log('    (耗时 ' + (Date.now() - t0) + ' ms)');
  eqHex('pub(G*d)#' + i, minePub, refPub);
}
{
  const a = crypto.createECDH('prime256v1');
  a.generateKeys();
  const b = crypto.createECDH('prime256v1');
  b.generateKeys();
  const privA = new Uint8Array(a.getPrivateKey());
  const pa = new Uint8Array(32);
  pa.set(privA, 32 - privA.length);
  const pubB = new Uint8Array(b.getPublicKey());
  const ref = new Uint8Array(a.computeSecret(b.getPublicKey()));
  const t0 = Date.now();
  eqHex('ecdh 共享秘密', deriveSharedSecret(pa, pubB), ref);
  console.log('    (ECDH 耗时 ' + (Date.now() - t0) + ' ms)');
  const pubA = new Uint8Array(a.getPublicKey());
  ok('点在曲线上', isOnCurve(bytesToLimbs(pubA.subarray(1, 33)), bytesToLimbs(pubA.subarray(33, 65))));
}
{
  const d = normalizePrivateKey(randomBytes(32));
  const pub = publicKeyFromPrivate(d);
  ok('normalize + pubkey 形状', pub.length === 65 && pub[0] === 0x04);
  ok('keyId 长度', sha1(pub).subarray(0, 4).length === 4);
}

console.log('[7] 辅助函数');
eqHex('beBytes(3,4)', beBytes(3, 4), fromHex('00000003'));
ok('fromHex/toHex', toHex(fromHex('00 0c 22 0a')) === '000c220a');
eqHex('concatBytes', concatBytes([fromHex('aabb'), fromHex('cc')]), fromHex('aabbcc'));

console.log('[8] protobuf / VCSEC 报文（用官方文档样例字节做金标准）');
{
  // 文档样例：车辆回复「请等待」（刷钥匙卡前）
  const wait = fromHex('00 04 22 02 08 01');
  const body = vcsec.stripLength(wait);
  eqHex('stripLength', body, fromHex('22020801'));
  const r = vcsec.decodeResponse(body);
  ok('WAIT 解码 operationStatus=1', r.obj.commandStatus.operationStatus === 1, r.text);
  ok('WAIT summarize', vcsec.summarize(r.obj).status === 1);
  ok('label(WAIT)', vcsec.label('OperationStatus_E', 1) === 'OPERATIONSTATUS_WAIT(1)');

  // 文档样例：钥匙卡已刷（operationStatus=OK=0 被 proto3 省略）
  const kc = vcsec.decodeResponse(vcsec.stripLength(fromHex('00 0c 22 0a 1a 08 12 06 0a 04 5f 0d 64 b3')));
  eqHex('signerOfOperation', kc.obj.commandStatus.whitelistOperationStatus.signerOfOperation.publicKeySHA1, fromHex('5f0d64b3'));
  const sum = vcsec.summarize(kc.obj);
  ok('刷卡 summarize=OK(默认0)', sum.kind === 'whitelist' && sum.status === 0, sum.text);

  // 文档样例：临时公钥响应（65 字节未压缩点）
  const epHex = '00 45 12 43 1a 41 04 79 c0 50 4a 21 6f fc 26 46 b7 57 80 39 9f 1c e1 23 f4 01 56 1b 68 5c 31 83' +
    ' 64 fa 96 cc 3f e6 7a 5a c5 04 8c 44 7a f8 8d 91 52 86 5a 1e fc 15 bb d5 68 98' +
    ' dd 2c 46 f7 a1 9b ad 4f b2 80 52 c4 60';
  const ep = vcsec.decodeResponse(vcsec.stripLength(fromHex(epHex)));
  const ephemeral = vcsec.ephemeralKeyFromResponse(ep.obj);
  ok('临时公钥 65 字节且 0x04 开头', ephemeral && ephemeral.length === 65 && ephemeral[0] === 0x04, ephemeral && String(ephemeral.length));

  // 端到端：我方私钥 -> 与文档临时公钥做 ECDH -> sharedKey，与 Node 对齐
  const kp = vcsec.newKeyPair();
  ok('密钥对形状', kp.privateKey.length === 32 && kp.publicKey.length === 65 && kp.publicKey[0] === 0x04);
  const e1 = crypto.createECDH('prime256v1');
  e1.setPrivateKey(Buffer.from(kp.privateKey));
  const nodeSecret = new Uint8Array(e1.computeSecret(Buffer.from(ephemeral)));
  const mineSecret = deriveSharedSecret(kp.privateKey, ephemeral);
  eqHex('ECDH(车辆临时公钥) 与 Node 一致', mineSecret, nodeSecret);
  eqHex('sharedKey=SHA1(secret)[:16]', vcsec.sharedKeyOf(kp.privateKey, ephemeral), sha1(nodeSecret).subarray(0, 16));
  const sk = vcsec.sharedKeyOf(kp.privateKey, ephemeral);

  // 绑定报文：重新解析自己编出来的字节，校验关键字段
  const wl = vcsec.buildWhitelistFrame(kp.publicKey, 7);
  ok('绑定报文长度前缀一致', ((wl[0] << 8) | wl[1]) === wl.length - 2);
  const wlDec = vcsec.decode(SPEC, 'ToVCSECMessage', vcsec.stripLength(wl));
  ok('绑定 signatureType=PRESENT_KEY', wlDec.signedMessage.signatureType === 2);
  const inner = vcsec.decode(SPEC, 'UnsignedMessage', wlDec.signedMessage.protobufMessageAsBytes);
  const pc = inner.WhitelistOperation.addKeyToWhitelistAndAddPermissions;
  eqHex('绑定公钥回环', pc.key.PublicKeyRaw, kp.publicKey);
  ok('绑定权限打包 [2,1,4,3]', JSON.stringify(pc.permission) === '[2,1,4,3]', JSON.stringify(pc.permission));
  ok('绑定 formFactor=ANDROID', inner.WhitelistOperation.metadataForKey.keyFormFactor === 7);

  // 临时公钥请求
  const req = vcsec.decode(SPEC, 'ToVCSECMessage', vcsec.stripLength(vcsec.buildEphemeralRequestFrame(kp.publicKey)));
  ok('请求走 unsignedMessage', req.signedMessage === undefined && req.unsignedMessage.InformationRequest.informationRequestType === 3);
  eqHex('请求 keyId=SHA1(pub)[:4]', req.unsignedMessage.InformationRequest.keyId.publicKeySHA1, sha1(kp.publicKey).subarray(0, 4));

  // RKE：UNLOCK=0 必须被 proto3 省略成空报文；LOCK=1 必须带 10 01
  ok('UNLOCK 内层为空', vcsec.encode(SPEC, 'UnsignedMessage', { RKEAction: 0 }).length === 0);
  // UnsignedMessage.RKEAction 是字段 2 -> tag = 2*8+0 = 0x10
  eqHex('LOCK 内层=1001', vcsec.encode(SPEC, 'UnsignedMessage', { RKEAction: 1 }), fromHex('1001'));
  const rke = vcsec.buildRkeFrame(kp.publicKey, sk, 3, 1);
  const rkeDec = vcsec.decode(SPEC, 'ToVCSECMessage', vcsec.stripLength(rke.frame));
  ok('RKE counter=3', rkeDec.signedMessage.counter === 3);
  eqHex('RKE keyId', rkeDec.signedMessage.keyId, vcsec.keyIdOf(kp.publicKey));
  eqHex('RKE signature=GCM tag(16B)', rkeDec.signedMessage.signature, rke.tag);
  // 用 Node 解密自己发出的密文，证明与车辆侧算法一致
  const d = crypto.createDecipheriv('aes-128-gcm', Buffer.from(sk), Buffer.from([0, 0, 0, 3]));
  d.setAuthTag(Buffer.from(rkeDec.signedMessage.signature));
  const plain = Buffer.concat([d.update(Buffer.from(rkeDec.signedMessage.protobufMessageAsBytes)), d.final()]);
  eqHex('Node 解密 RKE 得到 LOCK', new Uint8Array(plain), fromHex('1001'));

  // BLE 旧命名规则（文档示例 VIN）
  const names = vcsec.bleNamesForVin('5YJ3E1EA1KF000000');
  ok('新命名 Tesla 00000', names.exact[0] === 'Tesla 000000', JSON.stringify(names));
  ok('旧命名前缀 Sa6bab0d54ffaecf1', names.prefixes[0] === 'Sa6bab0d54ffaecf1', names.prefixes[0]);

  // 报文控制台允许 bytes 字段直接写 hex 字符串
  const hexIn = vcsec.encode(SPEC, 'ToVCSECMessage', {
    unsignedMessage: { InformationRequest: { informationRequestType: 3, keyId: { publicKeySHA1: toHex(sha1(kp.publicKey).subarray(0, 4)) } } }
  });
  const binIn = vcsec.encode(SPEC, 'ToVCSECMessage', {
    unsignedMessage: { InformationRequest: { informationRequestType: 3, keyId: { publicKeySHA1: sha1(kp.publicKey).subarray(0, 4) } } }
  });
  eqHex('hex 字符串与字节数组编码结果一致', hexIn, binIn);
  let hexBad = '';
  try {
    vcsec.encode(SPEC, 'KeyIdentifier', { publicKeySHA1: '0a1' });
  } catch (e) {
    hexBad = e.message;
  }
  ok('奇数长度 hex 会报错', hexBad.indexOf('偶数') > 0, hexBad);
}

console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
