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
import { V3_SPEC as SPEC } from '../common/v3spec.js';
import * as vcsec from '../common/vcsec.js';
import { sha256, hmacSha256 } from '../common/sha256.js';
import * as v3 from '../common/v3vcsec.js';
import * as api from '../common/api.js';
import * as acts from '../common/v3actions.js';
import { TeslaBle, makeMatcher, sortAdv } from '../common/tesla-ble.js';
import {
  state as probe,
  v3Session,
  storeV3Session,
  invalidateV3Session,
  resetV3Session,
  describeKey,
  beginAction,
  endAction,
  action,
  clearLogs,
  getLogs
} from '../common/session.js';
import { notify, copyText, preview, NOTIFY_MAX } from '../common/notify.js';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  ok('keyId 是完整 20 字节 SHA1', vcsec.keyIdOf(pub).length === 20 && equalBytes(vcsec.keyIdOf(pub), sha1(pub)));
}

console.log('[7] 辅助函数');
eqHex('beBytes(3,4)', beBytes(3, 4), fromHex('00000003'));
ok('fromHex/toHex', toHex(fromHex('00 0c 22 0a')) === '000c220a');
eqHex('concatBytes', concatBytes([fromHex('aabb'), fromHex('cc')]), fromHex('aabbcc'));

console.log('[8] protobuf / 传输层辅助（官方文档样例字节做金标准）');
{
  // 文档样例：车辆回复「请等待」（刷钥匙卡前）
  const wait = fromHex('00 04 22 02 08 01');
  const body = vcsec.stripLength(wait);
  eqHex('stripLength', body, fromHex('22020801'));
  eqHex('prependLength 回环', vcsec.prependLength(body), wait);
  let lenErr = '';
  try {
    vcsec.stripLength(fromHex('00 09 22 02 08 01'));
  } catch (e) {
    lenErr = e.message;
  }
  ok('长度前缀对不上会报错', lenErr.length > 0, lenErr);
  const r = v3.decodeFromVcsec(body);
  ok('WAIT 解码 operationStatus=1', r.obj.commandStatus.operationStatus === 1, r.text);
  ok('WAIT summarize', v3.summarizeVcsec(r.obj).status === 1);
  ok('label(WAIT)', v3.label('VCOperationStatus_E', 1).indexOf('OPERATIONSTATUS_WAIT') === 0);

  // 文档样例：钥匙卡已刷（operationStatus=OK=0 被 proto3 省略）
  const kc = v3.decodeFromVcsec(vcsec.stripLength(fromHex('00 0c 22 0a 1a 08 12 06 0a 04 5f 0d 64 b3')));
  eqHex('signerOfOperation', kc.obj.commandStatus.whitelistOperationStatus.signerOfOperation.publicKeySHA1, fromHex('5f0d64b3'));
  const sum = v3.summarizeVcsec(kc.obj);
  ok('刷卡 summarize=OK(默认0)', sum.kind === 'whitelist' && sum.status === 0, sum.text);

  // 文档样例：握手响应里的车辆公钥（65 字节未压缩点，protocol.md 原样字节去掉 1a 41 头）
  const pubV = fromHex('0479c0504a216ffc2646b75780399f1ce123f401561b685c3183' +
    '64fa96cc3fe67a5ac5048c447af88d9152865a1efc15bbd56898' +
    'dd2c46f7a19bad4fb28052c460');
  ok('文档车辆公钥 65 字节且 0x04 开头', pubV.length === 65 && pubV[0] === 0x04, String(pubV.length));

  // 端到端：本机私钥 -> 与文档公钥做 ECDH -> sharedKey，与 Node 对齐
  const kp = vcsec.newKeyPair();
  ok('密钥对形状', kp.privateKey.length === 32 && kp.publicKey.length === 65 && kp.publicKey[0] === 0x04);
  const e1 = crypto.createECDH('prime256v1');
  e1.setPrivateKey(Buffer.from(kp.privateKey));
  const nodeSecret = new Uint8Array(e1.computeSecret(Buffer.from(pubV)));
  eqHex('ECDH(车辆公钥) 与 Node 一致', deriveSharedSecret(kp.privateKey, pubV), nodeSecret);
  eqHex('sharedKey=SHA1(secret)[:16]', v3.sharedKeyOf(kp.privateKey, pubV), sha1(nodeSecret).subarray(0, 16));

  // 绑定报文：裸 ToVCSECMessage{signedMessage{PRESENT_KEY}}（官方 security.go:338）
  const env = v3.buildAddKeyEnvelope(kp.publicKey, SPEC.enums.Role.ROLE_DRIVER, 7);
  ok('信封不带长度前缀（由传输层补）', env[0] === 0x0a, '0x' + env[0].toString(16));
  const add = v3.decode(SPEC, 'ToVCSECMessage', env);
  ok('绑定 signatureType=PRESENT_KEY', add.signedMessage.signatureType === 2);
  const pc = v3.decode(SPEC, 'UnsignedMessage', add.signedMessage.protobufMessageAsBytes)
    .WhitelistOperation.addKeyToWhitelistAndAddPermissions;
  eqHex('绑定公钥回环', pc.key.PublicKeyRaw, kp.publicKey);
  ok('绑定用 keyRole=DRIVER（现行字段）', pc.keyRole === SPEC.enums.Role.ROLE_DRIVER, String(pc.keyRole));
  ok('现行 PermissionChange 没有 permission 数组', pc.permission === undefined, JSON.stringify(pc.permission));

  // 握手请求：dispatcher.Send() 恒定补 uuid + from_destination.routing_address
  const VC = v3.DOMAIN.DOMAIN_VEHICLE_SECURITY;
  const sir = v3.buildSessionInfoRequest(VC, kp.publicKey, randomBytes(16), randomBytes(16));
  const sirBack = v3.decode(SPEC, 'RoutableMessage', sir.bytes);
  ok('握手走 RoutableMessage 而不是 signedMessage',
    sirBack.signedMessage === undefined && sirBack.to_destination.domain === VC, v3.inspect(SPEC, 'RoutableMessage', sirBack));
  ok('握手带 65 字节公钥', sirBack.session_info_request.public_key.length === 65);
  ok('握手带 uuid 和路由地址', sirBack.uuid.length === 16 && sirBack.from_destination.routing_address.length === 16);

  // RKE：UNLOCK=0 必须被 proto3 省略成空报文；LOCK=1 必须带 10 01
  ok('UNLOCK 内层为空', v3.encode(SPEC, 'UnsignedMessage', { RKEAction: 0 }).length === 0);
  // UnsignedMessage.RKEAction 是字段 2 -> tag = 2*8+0 = 0x10
  eqHex('LOCK 内层=1001', v3.encode(SPEC, 'UnsignedMessage', { RKEAction: 1 }), fromHex('1001'));

  // BLE 广播名规则（文档示例 VIN）
  const names = vcsec.bleNamesForVin('5YJ3E1EA1KF000000');
  ok('新命名 Tesla 00000', names.exact[0] === 'Tesla 000000', JSON.stringify(names));
  ok('旧命名前缀 Sa6bab0d54ffaecf1', names.prefixes[0] === 'Sa6bab0d54ffaecf1', names.prefixes[0]);

  // 报文控制台允许 bytes 字段直接写 hex 字符串
  const hexIn = v3.encode(SPEC, 'KeyIdentifier', { publicKeySHA1: toHex(sha1(kp.publicKey)) });
  const binIn = v3.encode(SPEC, 'KeyIdentifier', { publicKeySHA1: sha1(kp.publicKey) });
  eqHex('hex 字符串与字节数组编码结果一致', hexIn, binIn);
  let hexBad = '';
  try {
    v3.encode(SPEC, 'KeyIdentifier', { publicKeySHA1: '0a1' });
  } catch (e2) {
    hexBad = e2.message;
  }
  ok('奇数长度 hex 会报错', hexBad.indexOf('偶数') > 0, hexBad);
}

console.log('[9] SHA-256 / HMAC-SHA256');
{
  for (const msg of ['', 'abc', 'session info', 'authenticated command', 'a'.repeat(63), 'b'.repeat(64), 'c'.repeat(200)]) {
    const mine = sha256(utf8ToBytes(msg));
    const ref = new Uint8Array(crypto.createHash('sha256').update(msg).digest());
    eqHex('sha256(' + JSON.stringify(msg.slice(0, 10)) + ' len=' + msg.length + ')', mine, ref);
  }
  const key = randomBytes(16);
  const data = randomBytes(37);
  const ref = new Uint8Array(crypto.createHmac('sha256', Buffer.from(key)).update(Buffer.from(data)).digest());
  eqHex('hmacSha256(key, data)', hmacSha256(key, data), ref);
  const longKey = randomBytes(80); // key > 64 字节要先哈希
  const ref2 = new Uint8Array(crypto.createHmac('sha256', Buffer.from(sha256(longKey))).update(Buffer.from(data)).digest());
  eqHex('hmacSha256(长 key)', hmacSha256(longKey, data), ref2);
  const ref3 = new Uint8Array(crypto.createHmac('sha256', Buffer.from(key)).update(Buffer.from(data)).update(Buffer.from(data)).digest());
  eqHex('hmacSha256(多段)', hmacSha256(key, data, data), ref3);
}

console.log('[10] V3（RoutableMessage）—— protocol.md 官方测试向量');
{
  const vin = '5YJ30123456789ABC';
  const privC = fromHex('2538cdc29a97c19c1e99a637d6cf4f8c970c118b56ede1e6323e6d162c4b30db');
  const pubC = fromHex('04b2b6bc68c2da0665ce656815594996c62394edd8bea905fe781a754fe6a845a7' +
    '14330902f225e9269d466e05b349981fda9d85cc23c6fb444aa73b629105dc6e');
  const pubV = fromHex('04c7a1f47138486aa4729971494878d33b1a24e39571f748a6e16c5955b3d877d3' +
    'a6aaa0e955166474af5d32c410f439a2234137ad1bb085fd4e8813c958f11d97');
  const K = fromHex('1b2fce19967b79db696f909cff89ea9a');
  const uuid = fromHex('1588d5a30eabc6f8fc9a951b11f6fd11');
  const addr = fromHex('2c907bd76c640d360b3027dc7404efde');
  const epoch = fromHex('4c463f9cc0d3d26906e982ed224adde6');

  // 共享密钥：先与 Node ECDH 对拍，再与文档 K 对拍
  const e = crypto.createECDH('prime256v1');
  e.setPrivateKey(Buffer.from(privC));
  eqHex('ECDH(c,V) 与 Node 一致', deriveSharedSecret(privC, pubV), new Uint8Array(e.computeSecret(Buffer.from(pubV))));
  eqHex('K = SHA1(ECDH)[:16]', v3.sharedKeyOf(privC, pubV), K);
  eqHex('SESSION_INFO_KEY = HMAC(K,"session info")', v3.subkey(K, v3.LABEL_SESSION_INFO),
    fromHex('fceb679ee7bca756fcd441bf238bf2f338629b41d9eb9c67be1b32c9672ce300'));
  ok('公钥对得上私钥', equalBytes(publicKeyFromPrivate(privC), pubC));

  // 握手请求：编码 -> 解码回环
  const hs = v3.buildSessionInfoRequest(v3.DOMAIN.DOMAIN_INFOTAINMENT, pubC, uuid, addr);
  const hsBack = v3.decode(v3.V3_SPEC, 'RoutableMessage', hs.bytes);
  ok('握手 to_destination.domain=INFOTAINMENT', hsBack.to_destination.domain === 3, v3.inspect(v3.V3_SPEC, 'RoutableMessage', hsBack));
  eqHex('握手 from_destination.routing_address', hsBack.from_destination.routing_address, addr);
  eqHex('握手 session_info_request.public_key', hsBack.session_info_request.public_key, pubC);
  eqHex('握手 uuid', hsBack.uuid, uuid);
  ok('握手摘要', v3.summarize(hsBack).kind === 'handshakeRequest', v3.summarize(hsBack).text);

  // 握手响应（文档原样字节）
  const sessionInfo = fromHex('0806124104c7a1f47138486aa4729971494878d33b1a24e39571f748a6e16c5955b3d877d3' +
    'a6aaa0e955166474af5d32c410f439a2234137ad1bb085fd4e8813c958f11d971a104c463f9cc0d3d26906e982ed224adde6255a0a0000');
  const siTag = fromHex('996c1fe38331be138f8039c194b14db2198846ed7d8251e6749284d7b32ea002');
  const hm = new v3.Metadata();
  hm.addByte(v3.TAG.TAG_SIGNATURE_TYPE, v3.SIGTYPE.SIGNATURE_TYPE_HMAC);
  hm.add(v3.TAG.TAG_PERSONALIZATION, utf8ToBytes(vin));
  hm.add(v3.TAG.TAG_CHALLENGE, uuid);
  eqHex('握手元数据 = 文档', hm.bytes(true),
    fromHex('000106021135594a333031323334353637383941424306101588d5a30eabc6f8fc9a951b11f6fd11ff'));
  eqHex('session_info HMAC = 文档', v3.sessionInfoHmac(K, vin, uuid, sessionInfo), siTag);

  const parsed = v3.parseFrame(sessionInfo); // 裸 session_info 不是 RoutableMessage，应落到另一种解析
  ok('parseFrame 不会把 session_info 误判成 RoutableMessage', parsed.kind !== 'routable', parsed.text.slice(0, 40));

  const sess = { key: K, counter: 0 };
  const applied = v3.applySessionInfo(sess, { vin, challenge: uuid, encodedInfo: sessionInfo, tag: siTag });
  ok('握手通过校验', applied.ok, applied.error);
  ok('counter=6', sess.counter === 6, String(sess.counter));
  ok('clock_time=2650', sess.clockTime === 2650, String(sess.clockTime));
  eqHex('epoch', sess.epoch, epoch);
  eqHex('车辆公钥', sess.vehiclePublicKey, pubV);
  const tampered = v3.applySessionInfo({ key: K, counter: 0 }, { vin, challenge: uuid, encodedInfo: sessionInfo, tag: new Uint8Array(32) });
  ok('tag 被篡改时拒绝', !tampered.ok, tampered.error);
  ok('拒绝时不写会话', tampered.info === undefined);
  const wrongVin = v3.applySessionInfo({ key: K, counter: 0 }, { vin: '5YJ3E1EA1KF000000', challenge: uuid, encodedInfo: sessionInfo, tag: siTag });
  ok('VIN 不符时拒绝', !wrongVin.ok);

  // 命令元数据
  const meta = v3.requestMetadata({
    signatureType: v3.SIGTYPE.SIGNATURE_TYPE_AES_GCM_PERSONALIZED,
    domain: v3.DOMAIN.DOMAIN_INFOTAINMENT,
    vin, epoch, expiresAt: 2655, counter: 7, flags: 2
  });
  eqHex('命令元数据 = 文档', meta.bytes(true),
    fromHex('000105010103021135594a333031323334353637383941424303104c463f9cc0d3d26906e982ed224adde6040400000a5f050400000007070400000002ff'));
  eqHex('AAD = SHA256(元数据)', meta.sha256(), sha256(meta.bytes(true)));

  // flags=0 时元数据里没有 TAG_FLAGS
  const metaNoFlags = v3.requestMetadata({
    signatureType: v3.SIGTYPE.SIGNATURE_TYPE_AES_GCM_PERSONALIZED,
    domain: v3.DOMAIN.DOMAIN_INFOTAINMENT,
    vin, epoch, expiresAt: 2655, counter: 7, flags: 0
  });
  ok('flags=0 不进元数据', toHex(metaNoFlags.bytes(true)).indexOf('070400000002') < 0, toHex(metaNoFlags.bytes(true)));
  let metaErr = '';
  try {
    v3.requestMetadata({ signatureType: 5, vin, epoch, expiresAt: 2655, counter: 7 });
  } catch (e2) {
    metaErr = e2.message;
  }
  ok('缺 domain 会报错', metaErr.indexOf('domain') > 0, metaErr);

  // 端到端加密命令（固定 nonce 复现文档输出）
  sess.anchor = 0; // 让 expires_at = now + 5 直接落在文档的 2655
  sess.counter = 6;
  const enc = v3.encryptCommand({
    domain: v3.DOMAIN.DOMAIN_INFOTAINMENT,
    vin,
    session: sess,
    publicKey: pubC,
    payload: fromHex('120452020801'), // CarServer.Action: HVAC on
    flags: 2,
    routingAddress: addr,
    uuid: fromHex('58406580528b6a5301391800b4fe9b99'),
    now: 2650,
    nonce: fromHex('dbf79447fa156674dae1caed')
  });
  eqHex('密文 = 文档', enc.ciphertext, fromHex('38038e8c0f2e'));
  eqHex('GCM tag = 文档', enc.tag, fromHex('c228e0ff64991481db3a7bbc133696c5'));
  ok('counter 推进到 7', enc.counter === 7 && sess.counter === 7, String(sess.counter));
  ok('expires_at = 2655', enc.expiresAt === 2655, String(enc.expiresAt));
  eqHex('元数据一致', enc.tlv, meta.bytes(true));
  {
    const d = crypto.createDecipheriv('aes-128-gcm', Buffer.from(K), Buffer.from(enc.nonce));
    d.setAAD(Buffer.from(enc.aad));
    d.setAuthTag(Buffer.from(enc.tag));
    const plain = new Uint8Array(Buffer.concat([d.update(Buffer.from(enc.ciphertext)), d.final()]));
    eqHex('Node 按 AAD 解密回明文', plain, fromHex('120452020801'));
  }
  const rmBack = v3.decode(v3.V3_SPEC, 'RoutableMessage', enc.bytes);
  eqHex('整包 payload = 密文', rmBack.protobuf_message_as_bytes, enc.ciphertext);
  ok('整包 flags = 2', rmBack.flags === 2);
  ok('整包 signature_data 齐全', rmBack.signature_data.signer_identity.public_key.length === 65 &&
    rmBack.signature_data.AES_GCM_Personalized_data.nonce.length === 12 &&
    rmBack.signature_data.AES_GCM_Personalized_data.expires_at === 2655,
    v3.inspect(v3.V3_SPEC, 'RoutableMessage', rmBack));
  eqHex('requestId = 05 ‖ tag', v3.requestIdOf(rmBack), concatBytes([fromHex('05'), enc.tag]));

  // 加密后再解一次：车辆侧用同一把 K 应该能还原
  {
    const dec = aes128GcmDecrypt(K, enc.nonce, enc.ciphertext, enc.aad);
    eqHex('自解（车辆侧）得到明文', dec.plaintext, fromHex('120452020801'));
  }

  // counter 上限：官方 TestSignerCounterRollover（signer_test.go:190）——
  // 0xFFFFFFFF 是保留哨兵，最后一个能发出去的值是 0xFFFFFFFE
  {
    const mk = (sess) => v3.encryptCommand({
      domain: v3.DOMAIN.DOMAIN_INFOTAINMENT, vin, publicKey: pubC,
      session: sess,
      payload: fromHex('120452020801'), routingAddress: addr, uuid: fromHex('58406580528b6a5301391800b4fe9b99'),
      now: 2650, nonce: fromHex('dbf79447fa156674dae1caed')
    });
    const s1 = { key: K, epoch, anchor: 0, counter: 0xfffffffd };
    ok('0xFFFFFFFE 是最后一个可用值', mk(s1).counter === 0xfffffffe && s1.counter === 0xfffffffe);
    let rollErr = '';
    try { mk(s1); } catch (e2) { rollErr = e2.message; }
    ok('0xFFFFFFFF 被拒绝', rollErr.indexOf('上限') > 0, rollErr);
    ok('拒绝后 counter 不落地', s1.counter === 0xfffffffe, String(s1.counter));
  }

  // 响应加密回环（文档没有响应向量，自造一条验证 AAD 组装一致）
  {
    const respPlain = fromHex('0801'); // FromVCSECMessage{ vehicleStatus{...} } 之类，随便一段字节
    const respCounter = 4243;
    const reqId = v3.requestIdOf(rmBack);
    const rmeta = v3.responseMetadata({ domain: v3.DOMAIN.DOMAIN_INFOTAINMENT, vin, counter: respCounter, flags: 2, requestId: reqId, fault: 0 });
    const rAad = rmeta.sha256();
    const rNonce = randomBytes(12);
    const rEnc = aes128GcmEncrypt(K, rNonce, respPlain, rAad);
    const resp = {
      to_destination: { routing_address: addr },
      from_destination: { domain: v3.DOMAIN.DOMAIN_INFOTAINMENT },
      protobuf_message_as_bytes: rEnc.ciphertext,
      signature_data: { AES_GCM_Response_data: { nonce: rNonce, counter: respCounter, tag: rEnc.tag } },
      request_uuid: fromHex('58406580528b6a5301391800b4fe9b99'),
      flags: 2
    };
    const wire = v3.encode(v3.V3_SPEC, 'RoutableMessage', resp);
    const back = v3.decode(v3.V3_SPEC, 'RoutableMessage', wire);
    const got = v3.decryptResponse(back, { vin, requestId: reqId, session: { key: K } });
    ok('响应解密成功', got.ok, got.error);
    eqHex('响应明文', got.plaintext, respPlain);
    const bad = v3.decryptResponse(back, { vin, requestId: fromHex('05aabbcc'), session: { key: K } });
    ok('requestId 不符时拒绝解密', !bad.ok, bad.error);
    const sum = v3.summarize(back);
    ok('响应摘要识别出加密响应', sum.text.indexOf('响应已加密') > 0, sum.text);
  }

  // HMAC 认证（明文）路径
  {
    const s2 = { key: K, counter: 6, epoch, anchor: 0 };
    const hmac = v3.authorizeHmacCommand({
      domain: v3.DOMAIN.DOMAIN_VEHICLE_SECURITY, vin, session: s2, publicKey: pubC,
      payload: fromHex('1001'), flags: 0, routingAddress: addr, uuid: uuid, now: 2650
    });
    const refTag = new Uint8Array(crypto.createHmac('sha256', Buffer.from(v3.subkey(K, v3.LABEL_MESSAGE_AUTH)))
      .update(Buffer.from(concatBytes([hmac.tlv, fromHex('1001')]))).digest()); // tag = HMAC(K', M ‖ P)
    eqHex('HMAC tag = Node(HMAC(K\', 元数据‖明文))', hmac.tag, refTag);
    eqHex('HMAC 请求 requestId = 08 ‖ tag(截16)', v3.requestIdOf(v3.decode(v3.V3_SPEC, 'RoutableMessage', hmac.bytes)),
      concatBytes([fromHex('08'), hmac.tag.subarray(0, 16)]));
  }

  // 应用层载荷
  {
    const rke = v3.encodeUnsignedMessage({ RKEAction: v3.V3_SPEC.enums.RKEAction_E.RKE_ACTION_LOCK });
    eqHex('V3 RKE LOCK 载荷 = 1001', rke, fromHex('1001'));
    ok('V3 RKE UNLOCK 载荷为空', v3.encodeUnsignedMessage({ RKEAction: 0 }).length === 0);
    const add = v3.decode(v3.V3_SPEC, 'ToVCSECMessage', v3.buildAddKeyEnvelope(pubC, v3.V3_SPEC.enums.Role.ROLE_OWNER, 7));
    ok('加白名单走裸 ToVCSECMessage', add.signedMessage.signatureType === 2);
    const inner = v3.decode(v3.V3_SPEC, 'UnsignedMessage', add.signedMessage.protobufMessageAsBytes);
    eqHex('加白名单公钥', inner.WhitelistOperation.addKeyToWhitelistAndAddPermissions.key.PublicKeyRaw, pubC);
    ok('加白名单用 keyRole（现行字段）', inner.WhitelistOperation.addKeyToWhitelistAndAddPermissions.keyRole === 2);
    ok('加白名单带 formFactor', inner.WhitelistOperation.metadataForKey.keyFormFactor === 7);
    const wait = v3.decodeFromVcsec(fromHex('22020801'));
    const s = v3.summarizeVcsec(wait.obj);
    ok('V3 应用层 WAIT 摘要与旧版同形', s.kind === 'command' && s.status === 1, s.text);
    ok('空 payload = 成功', v3.summarizeVcsec(v3.decodeFromVcsec(new Uint8Array(0)).obj).status === 0);
  }
}

// ---------------------------------------------------------------- 11. V3 单一入口
// 旧版协议已经删掉了，这一节守两条底线：
//   1）pages/ 只 import common/api.js —— api.js 的转发、V3 会话（counter 只增不减）、
//      以及传输层为「一次请求多帧响应」加的暂存，必须在没有蓝牙、没有 uni 的环境里也是确定的；
//   2）日志分段（-----start----- / -----end-----）是用户「复制」日志后唯一的导航，
//      必须成对、嵌套只算一段、抛异常也要收尾。
console.log('\n[11] V3 单一入口（api 转发 / 日志分段 / V3 会话 / 传输层收包）');
{
  const ab = (b) => new Uint8Array(b).buffer; // 复制成独立 ArrayBuffer，避免 subarray 共享底层缓冲
  const frameOf = (body) => concatBytes([beBytes(body.length, 2), body]);

  // ---------------------------------------------------------- 只剩 V3 一套
  ok('api.version() 恒为 v3', api.version() === 'v3' && api.versionName() === 'V3');
  const tk = api.toolkit();
  ok('控制台规格表是 V3', tk.v3 === true && tk.root === 'RoutableMessage' && !!tk.SPEC.messages.RoutableMessage);
  ok('V3 表里仍保留 ToVCSECMessage（绑定用的裸信封）', !!tk.SPEC.messages.ToVCSECMessage);
  ok('控制台能解析 V3 帧', typeof tk.parseFrame === 'function' && typeof tk.summarize === 'function' && typeof tk.summarizeVcsec === 'function');
  ok('编解码工具齐全', ['encode', 'decode', 'inspect', 'label', 'prependLength'].every((n) => typeof tk[n] === 'function'));

  // ---------------------------------------------------------- 枚举（V3 收窄后的现状）
  ok('RKE 保留 UNLOCK=0 / LOCK=1', api.rkeEnum('RKE_ACTION_UNLOCK') === 0 && api.rkeEnum('RKE_ACTION_LOCK') === 1);
  ok('RKE 收窄后没有 OPEN_TRUNK', api.rkeEnum('RKE_ACTION_OPEN_TRUNK') === undefined);
  ok('RKE 保留 AUTO_SECURE=29 / WAKE=30', api.rkeEnum('RKE_ACTION_AUTO_SECURE_VEHICLE') === 29 && api.rkeEnum('RKE_ACTION_WAKE_VEHICLE') === 30);
  ok('后备箱等走 ClosureMoveType OPEN=3 / CLOSE=4', api.closureEnum('CLOSURE_MOVE_TYPE_OPEN') === 3 && api.closureEnum('CLOSURE_MOVE_TYPE_CLOSE') === 4);
  ok('页面用的 label 也走 V3 枚举表', api.label('ClosureMoveType_E', 3).indexOf('CLOSURE_MOVE_TYPE_OPEN') === 0);
  ok('握手拒绝能翻成话', v3.label('Session_Info_Status', 1).indexOf('SESSION_INFO_STATUS_KEY_NOT_ON_WHITELIST') === 0, v3.label('Session_Info_Status', 1));
  ok('刷卡终态码能翻成话', v3.label('WhitelistOperation_information_E', 14).indexOf('NOT_ALLOWED_TO_ADD_UNLESS_ON_READER') > 0, v3.label('WhitelistOperation_information_E', 14));
  ok('状态行不抛异常', typeof api.statusText() === 'string' && api.statusText().indexOf('BLE=') === 0, api.statusText());

  // ---------------------------------------------------------- 日志分段
  clearLogs();
  const marks = () => getLogs().filter((l) => l.msg.indexOf('-----') === 0).map((l) => l.msg);
  beginAction('手工段');
  ok('beginAction 打 start', marks()[0] === '-----start----- 手工段', JSON.stringify(marks()));
  beginAction('内层动作');
  endAction('内层完成');
  ok('嵌套的内层不打标记', marks().length === 1, JSON.stringify(marks()));
  endAction('成功：外层');
  ok('外层收尾才打 end', marks()[1] === '-----end----- 手工段 | 成功：外层', JSON.stringify(marks()));
  endAction('野生的收尾');
  ok('没有 start 时不会凭空打 end', marks().length === 2, JSON.stringify(marks()));
  beginAction('泄漏的段');
  clearLogs();
  endAction('不该出现');
  ok('clearLogs 会重置嵌套计数', marks().length === 0, JSON.stringify(marks()));

  clearLogs();
  await action('返回体动作', async () => ({ ok: false, text: '车辆回执：超时\n请把卡贴到读卡区' }));
  const m1 = marks();
  ok('action() 自动成对', m1.length === 2 && m1[0] === '-----start----- 返回体动作' && m1[1].indexOf('-----end----- 返回体动作 | 失败：') === 0, JSON.stringify(m1));
  ok('end 里的 text 压成一行', m1[1].indexOf('\n') < 0 && m1[1].indexOf('车辆回执：超时 请把卡贴到读卡区') > 0, m1[1]);
  clearLogs();
  let thrown = '';
  try {
    await action('抛错动作', async () => {
      throw new Error('还没连上车辆');
    });
  } catch (e) {
    thrown = e.message;
  }
  const m2 = marks();
  ok('抛异常也收尾', thrown === '还没连上车辆' && m2.length === 2 && m2[1].indexOf('异常：还没连上车辆') > 0, JSON.stringify(m2));

  // 页面按钮 -> 动作名：确认 api.js 的转发都带上了人话名字
  clearLogs();
  let noConn = '';
  try {
    await api.queries.whitelistEntry(0);
  } catch (e) {
    noConn = e.message;
  }
  const m3 = marks();
  ok('未连接时动作抛错但分段收尾', noConn.indexOf('还没连上车辆') >= 0 && m3.length === 2 && m3[0] === '-----start----- 查白名单条目 0', JSON.stringify(m3));
  clearLogs();

  // ---------------------------------------------------------- V3 会话：counter 只增不减
  probe.privateKey = null;
  probe.publicKey = null;
  ok('未绑定密钥时 describeKey 给人话', describeKey() === '未生成密钥');
  const vs = v3Session();
  vs.counter = 900;
  vs.key = new Uint8Array(16).fill(7);
  vs.ready = true;
  let diskErr = '';
  try {
    storeV3Session();
  } catch (e) {
    diskErr = String(e && e.message);
  }
  ok('无 uni 环境下落盘静默跳过', diskErr === '');
  // describeKey 需要「本机有密钥」才会展开，这里放一对假密钥只为看文案
  probe.privateKey = new Uint8Array(32).fill(1);
  probe.publicKey = new Uint8Array(65).fill(2);
  ok('describeKey 展开 V3counter', describeKey().indexOf('V3counter=900') >= 0, describeKey());
  invalidateV3Session('测试：换了连接');
  ok('作废会话只清共享密钥，counter 不回退', vs.key === null && vs.ready === false && vs.counter === 900);
  resetV3Session();
  ok('reset 才把 V3 counter 归零', v3Session().counter === 0 && v3Session().ready === false);

  // ---------------------------------------------------------- 传输层：分帧 / 暂存 / keepQueue
  const ble = new TeslaBle({});
  ble.connected = true;
  {
    const f = frameOf(fromHex('0801120452020801'));
    const p = ble._waitForFrame(1000);
    ble._onChunk({ value: ab(f.subarray(0, 4)) });
    ok('半个帧不会被交付', ble._waiters.length === 1 && ble._rx.length === 4);
    ble._onChunk({ value: ab(f.subarray(4)) });
    const got = await p;
    ok('分包会重组后再交付完整帧', toHex(got) === '0801120452020801');
  }
  {
    const two = concatBytes([frameOf(fromHex('0801')), frameOf(fromHex('120452020801'))]);
    const p = ble._waitForFrame(1000);
    ble._buffering = true; // V3 的 readUntil 语义：还在处理上一帧
    ble._onChunk({ value: ab(two) });
    const first = await p;
    ok('一包两帧按长度前缀切开', toHex(first) === '0801');
    ok('第二帧被暂存而不是丢弃', ble._queue.length === 1 && toHex(ble._queue[0]) === '120452020801');
    const second = await ble.receive(1000);
    ok('receive 优先取暂存帧', toHex(second) === '120452020801' && ble._queue.length === 0);
    ok('无帧时 receive 超时返回 null 不抛错', (await ble.receive(60)) === null);
  }
  {
    // Node 里没有 uni：老实现的 send 测试其实是靠「写失败被 catch(() => {}) 吞掉」才过的。
    // 现在写失败会如实抛出，所以先桩一个「写永远成功」的 uni，让 keepQueue/超时用例走真实路径。
    globalThis.uni = { writeBLECharacteristicValue: (o) => setTimeout(() => o.success && o.success({}), 0) };
    ble._queue.push(fromHex('a1'));
    ble._rx = fromHex('ff10');
    await ble.send(frameOf(fromHex('0801')), 0, true);
    ok('keepQueue=true 保留暂存帧（V3）', ble._queue.length === 1);
    ok('send 丢弃上次残留的半帧', ble._rx.length === 0);
    await ble.send(frameOf(fromHex('0801')), 0);
    ok('send 默认清空暂存帧（一条请求只对应一轮应答）', ble._queue.length === 0);
  }
  {
    const p = ble._waitForFrame(5000);
    ble._rejectAll(new Error('BLE 已断开'));
    let msg = '';
    try {
      await p;
    } catch (e) {
      msg = e.message;
    }
    ok('断连时等待中的帧被拒绝', msg.indexOf('BLE 已断开') >= 0 && ble._waiters.length === 0);
  }
  {
    const p = ble.send(frameOf(fromHex('0801')), 60);
    let timeout = '';
    try {
      await p;
    } catch (e) {
      timeout = e.message;
    }
    ok('send 等不到响应会报超时', timeout.indexOf('超时') >= 0);
  }
  {
    // 回归锁：BLE 写失败必须原样抛出（errMsg + errCode + 第几片），
    // 绝不能再被 .catch(() => {}) 吞成误导性的「响应超时」。
    globalThis.uni = {
      writeBLECharacteristicValue: (o) => setTimeout(() => o.fail && o.fail({ errMsg: 'writeBLECharacteristicValue:fail adapter not initialized', errCode: -1 }), 0)
    };
    let werr = '';
    try {
      await ble.send(frameOf(fromHex('0801')), 3000);
    } catch (e) {
      werr = (e && e.message) || String(e);
    }
    ok('写失败不再被吞：send 抛 BLE 写失败', werr.indexOf('BLE 写失败') === 0 && werr.indexOf('第 1/1 片') > 0 && werr.indexOf('errCode=-1') > 0, werr);
    ok('写失败后不留悬着的响应等待', ble._waiters.length === 0);
  }
  delete globalThis.uni;
  const off = new TeslaBle({});
  let offErr = '';
  try {
    await off.receive(10);
  } catch (e) {
    offErr = e.message;
  }
  ok('未连接时 receive 直接抛错', offErr.indexOf('尚未连接') >= 0);
}

console.log('\n[12] 广播手选列表（makeMatcher / sortAdv）');
{
  const names = { exact: ['Tesla723591'], prefixes: ['S4adfe3eacbdb58b7'] };
  const m = makeMatcher(names);
  ok('精确命中', m('Tesla723591').mode === 'exact');
  ok('前缀命中', m('S4adfe3eacbdb58b7C').mode === 'prefix' && m('S4adfe3eacbdb58b7C').matched === 'S4adfe3eacbdb58b7');
  ok('分隔符差异宽松命中', m('Tesla 723591').mode === 'loose' && m('tesla_723591').mode === 'loose');
  ok('前缀的大小写/分隔符差异也认', m('s4-adfe3eacbdb58b7-extra').mode === 'loose-prefix');
  ok('改过名就不命中', m('Tesla Model Y 小米YU7') === null && m('midea') === null);
  ok('空名不报错', m('') === null && m(undefined) === null);
  const empty = makeMatcher(undefined);
  ok('没有期望名时一律不命中', empty('S4adfe3eacbdb58b7C') === null);

  const list = sortAdv([
    { deviceId: 'd1', name: 'midea', rssi: -50, tesla: false, hit: null },
    { deviceId: 'd2', name: 'S4adfe3eacbdb58b7C', rssi: -90, tesla: false, hit: 'S4adfe3eacbdb58b7' },
    { deviceId: 'd3', name: '', rssi: -40, tesla: true, hit: null },
    { deviceId: 'd4', name: 'weclamp', rssi: -60, tesla: false, hit: null },
    { deviceId: 'd5', name: '', rssi: -55, tesla: false, hit: null }
  ]);
  ok('命中 VIN 的排第一', list[0].deviceId === 'd2');
  ok('其次是有 0211 服务的（哪怕无名、信号差）', list[1].deviceId === 'd3');
  ok('有名字的按信号排', list[2].deviceId === 'd1' && list[3].deviceId === 'd4');
  ok('无名无 0211 的沉底', list[4].deviceId === 'd5');
  ok('sortAdv 不改原数组', list[0].deviceId === 'd2');
  ok('空列表安全', sortAdv([]).length === 0 && sortAdv(undefined).length === 0);
  ok('缺 rssi 当最弱处理', sortAdv([{ deviceId: 'a', name: 'a' }, { deviceId: 'b', name: 'b', rssi: -70 }])[0].deviceId === 'b');
}

console.log('\n[13] 提示弹窗（notify：关闭 / 复制，替代 uni.showToast）');
{
  ok('preview 短文本原样返回', preview('abc') === 'abc' && preview('') === '');
  const long = 'x'.repeat(NOTIFY_MAX + 10);
  const p = preview(long);
  ok('preview 超长留头部并提示复制', p.indexOf('点「复制」取全文') > 0 && p.indexOf('共 ' + long.length + ' 字') > 0 && p.slice(0, NOTIFY_MAX) === long.slice(0, NOTIFY_MAX));
  ok('preview 能指定上限', preview('abcdef', 3).indexOf('abcdef') < 0);
  // Node 里没有 uni：不许抛错，且必须把「未截断的全文」原样交回调用方
  const full = '车辆回执：WHITELISTOPERATION_INFORMATION_NOT_ALLOWED_TO_ADD_UNLESS_ON_READER(14)\n请把钥匙卡贴在中控台无线充电板';
  ok('notify 无 uni 环境降级为返回全文', notify(full) === full);
  let copied = null;
  ok('copyText 无 uni 环境回调 false', copyText('x', (v) => { copied = v; }) === false && copied === false);

  // 静态守卫：全站不许再出现 uni.showToast，也不许在弹提示前把正文 slice 掉
  const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
  const bad = [];
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      if (n === 'node_modules' || n === 'unpackage' || n === '.tmp-page') continue;
      const f = join(dir, n);
      if (statSync(f).isDirectory()) walk(f);
      else if (/\.(vue|js)$/.test(n)) {
        readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
          if (/uni\.showToast\(/.test(line)) bad.push(f.replace(root, '') + ':' + (i + 1) + ' showToast');
          if (/toast\([^)]*\.slice\(/.test(line)) bad.push(f.replace(root, '') + ':' + (i + 1) + ' 提示正文被截断');
        });
      }
    }
  };
  walk(root);
  ok('没有残留的 showToast / 截断提示', bad.length === 0, bad.join(' | '));
}

console.log('\n[14] 绑定状态机（假车机离线回归）');
{
  // 造一辆只在内存里的「假车机」：接管 state.ble，按收到的报文类型回对应形状的帧。
  // 目的不是测协议字节（那些在 [10] 已按 protocol.md 金标准锁死），而是锁住 bindKey 的
  // 判据模型：预探针命中就绝不重发 add-key、WAIT 不算失败、探针/终态谁先来算谁、
  // 窗口耗尽必须给可执行的排查清单。时间片通过 opts 覆盖，默认值（150s / 8s / 5s）不变。
  const VIN = '5YJ3E1EA1KF000000';
  const myKp = vcsec.newKeyPair();
  const carKp = vcsec.newKeyPair();
  const nap = (n) => new Promise((r) => setTimeout(r, n));

  // 钥匙不在白名单时车辆的实测响应：只有一个 session_info = {status: 1}
  const DECLINE = v3.encode(SPEC, 'RoutableMessage', { session_info: v3.encode(SPEC, 'SessionInfo', { status: 1 }) });
  // 已入白名单：SessionInfo 带车辆公钥 + 16 字节 epoch，tag 用「车辆私钥 ECDH 我方公钥」现算
  function acceptProbe(rm) {
    const info = v3.encode(SPEC, 'SessionInfo', {
      counter: 7,
      publicKey: carKp.publicKey,
      epoch: randomBytes(16),
      clock_time: 1700000000,
      status: 0
    });
    const K = v3.sharedKeyOf(carKp.privateKey, rm.session_info_request.public_key);
    return v3.encode(SPEC, 'RoutableMessage', {
      session_info: info,
      signature_data: { session_info_tag: { tag: v3.sessionInfoHmac(K, VIN, rm.uuid, info) } },
      request_uuid: rm.uuid
    });
  }
  // 裸 FromVCSECMessage（加白名单那条老路车端就是这么回的）
  const vcsecFrame = (cs) => v3.encode(SPEC, 'FromVCSECMessage', { commandStatus: cs });
  const WAIT = vcsecFrame({ operationStatus: SPEC.enums.UMOperationStatus_E.OPERATIONSTATUS_WAIT });
  const ERR = vcsecFrame({ operationStatus: SPEC.enums.UMOperationStatus_E.OPERATIONSTATUS_ERROR });
  // 官方 protocol.md:836 认定的唯一终态：commandStatus.whitelistOperationStatus
  const terminal = (info) =>
    vcsecFrame({ whitelistOperationStatus: info === undefined ? {} : { whitelistOperationInformation: info } });

  // 假车机要先分辨收到的是哪一类包：握手 = RoutableMessage{session_info_request}，
  // 加白名单 = 裸 ToVCSECMessage{signedMessage}（官方 security.go:338，不带会话、没有 Routable 信封）。
  function classify(bytes) {
    const body = bytes.subarray(2); // 去掉传输层补的 2 字节大端长度前缀
    try {
      const rm = v3.decode(SPEC, 'RoutableMessage', body);
      if (rm.session_info_request) return { kind: 'probe', rm };
    } catch (e) {
      /* 不是握手包 */
    }
    try {
      const env = v3.decode(SPEC, 'ToVCSECMessage', body);
      if (env.signedMessage) return { kind: 'addkey', payload: env.signedMessage.protobufMessageAsBytes };
    } catch (e) {
      /* 也不是加白名单包 */
    }
    return { kind: 'other' };
  }

  function makeCar(o) {
    const car = { probes: 0, addKeys: [], queue: (o.queue || []).slice() };
    car.ble = {
      connected: true,
      async send(bytes) {
        const c = classify(bytes);
        if (c.kind === 'probe') {
          car.probes++;
          return car.probes > (o.enrollAfterProbes === undefined ? 0 : o.enrollAfterProbes) ? acceptProbe(c.rm) : DECLINE;
        }
        if (c.kind === 'addkey') {
          car.addKeys.push(c.payload);
          return o.firstReply === undefined ? null : o.firstReply;
        }
        return null;
      },
      async receive() {
        if (car.queue.length) return car.queue.shift();
        await nap(o.tick || 5);
        return null;
      }
    };
    return car;
  }

  const FAST = { windowMs: 300, probeFirstMs: 10, probeIntervalMs: 15, receiveMs: 5 };
  const run = async (o) => {
    const car = makeCar(o);
    probe.privateKey = myKp.privateKey;
    probe.publicKey = myKp.publicKey;
    probe.vin = VIN;
    probe.ble = car.ble;
    resetV3Session();
    clearLogs();
    const r = await acts.bindKey(VIN, Object.assign({}, FAST, o.opts));
    return { car, r, logs: getLogs().map((l) => l.kind + ':' + l.msg).join('\n') };
  };

  // ---- 阶段 0：早就绑好了 → 直接返回，一个 add-key 都不发
  {
    const { car, r } = await run({ enrollAfterProbes: 0 });
    ok('预探针命中：判已绑定', r.ok === true && r.already === true && r.paired === true, r.text);
    ok('预探针命中：从未发 add-key（不重复弹配对请求）', car.addKeys.length === 0 && car.probes === 1, 'probes=' + car.probes);
  }
  // ---- 探针先命中：车端只回了 WAIT，没有终态（0Bu 实测的量产行为）
  {
    const { car, r, logs } = await run({ enrollAfterProbes: 1, firstReply: WAIT });
    ok('WAIT + 探针命中 = 判成功', r.ok === true && r.paired === true && r.text.indexOf('绑定成功 —— 探针第 1 次确认') === 0, r.text.slice(0, 60));
    ok('add-key 一轮只发一次', car.addKeys.length === 1, 'addKeys=' + car.addKeys.length);
    ok('WAIT 不当失败也不重发', logs.indexOf('车辆已进入配对等待') > 0, '');
    ok('成功结论带上 Tesla key id', r.text.indexOf('Tesla key id = ') > 0 && /[0-9A-F]{2}(:[0-9A-F]{2}){3}/.test(r.text), r.text.slice(-160));
  }
  // ---- 车端给了明确成功回执：以回执为准，再打一针拿会话
  {
    const { car, r } = await run({ enrollAfterProbes: 1, firstReply: terminal(0) });
    ok('whitelistOperationStatus=OK 优先于探针', r.ok === true && r.info === 0 && r.text.indexOf('车辆回执已加入白名单') === 0, r.text.slice(0, 60));
    ok('拿到终态后仍补一针会话', car.probes === 2 && car.addKeys.length === 1, 'probes=' + car.probes);
  }
  // ---- 车端给了明确的失败码：照它下结论，不再等窗口
  {
    const { car, r } = await run({ enrollAfterProbes: 99, firstReply: terminal(25) });
    ok('终态失败码直接判失败', r.ok === false && r.info === 25 && r.wait !== true, r.text.slice(0, 80));
    ok('失败文案带人话提示', r.text.indexOf('等刷卡超时') > 0, r.text);
    ok('失败后不再打探针', car.probes === 1, 'probes=' + car.probes);
  }
  // ---- 车端直接 ERROR 拒绝
  {
    const { r } = await run({ enrollAfterProbes: 99, firstReply: ERR });
    ok('OPERATIONSTATUS_ERROR 判失败', r.ok === false && r.text.indexOf('被车端拒绝') > 0, r.text.slice(0, 80));
  }
  // ---- 窗口耗尽：必须判「没绑上」并给出四项排查
  {
    const { car, r } = await run({ enrollAfterProbes: 999, firstReply: WAIT, opts: { windowMs: 200 } });
    ok('窗口耗尽判失败但可重试', r.ok === false && r.wait === true && r.paired !== true, r.text.slice(0, 60));
    ok('至少打过一次探针', car.probes >= 2 && r.probes === car.probes - 1, 'probes=' + car.probes);
    ok('排查清单四项齐全',
      r.text.indexOf('车机屏幕有没有弹') > 0 && r.text.indexOf('实体钥匙卡') > 0 &&
      r.text.indexOf('同时最多约 3 个 BLE 连接') > 0 && r.text.indexOf('踩一脚刹车') > 0, r.text);
    ok('全程没有重发 add-key', car.addKeys.length === 1, 'addKeys=' + car.addKeys.length);
  }
  // ---- opts.formFactor 必须真的进到 payload（官方无默认值，页面四选一是现场 A/B 用的）
  {
    const { car } = await run({ enrollAfterProbes: 999, firstReply: null, opts: { formFactor: SPEC.enums.KeyFormFactor.KEY_FORM_FACTOR_CLOUD_KEY, windowMs: 120 } });
    const inner = v3.decode(SPEC, 'UnsignedMessage', car.addKeys[0]);
    const ak = inner.WhitelistOperation.addKeyToWhitelistAndAddPermissions;
    eqHex('add-key 带的是本机公钥', ak.key.PublicKeyRaw, myKp.publicKey);
    ok('add-key role=DRIVER', ak.keyRole === SPEC.enums.Role.ROLE_DRIVER, String(ak.keyRole));
    ok('页面选的 formFactor 进了 payload', inner.WhitelistOperation.metadataForKey.keyFormFactor === SPEC.enums.KeyFormFactor.KEY_FORM_FACTOR_CLOUD_KEY, String(inner.WhitelistOperation.metadataForKey.keyFormFactor));
  }
  {
    const { car } = await run({ enrollAfterProbes: 999, firstReply: null, opts: { windowMs: 120 } });
    const ak = v3.decode(SPEC, 'UnsignedMessage', car.addKeys[0]).WhitelistOperation;
    ok('不传时默认 ANDROID_DEVICE', ak.metadataForKey.keyFormFactor === SPEC.enums.KeyFormFactor.KEY_FORM_FACTOR_ANDROID_DEVICE, String(ak.metadataForKey.keyFormFactor));
  }
  // ---- add-key 发送失败（连接断了 / BLE 写失败）：要立刻给人话 + 连接数上限提示，不能挂死在窗口里
  {
    probe.privateKey = myKp.privateKey;
    probe.publicKey = myKp.publicKey;
    probe.vin = VIN;
    probe.ble = {
      connected: true,
      async send(bytes) {
        if (classify(bytes).kind === 'probe') return DECLINE;
        throw new Error('BLE 写失败：第 1/1 片 errCode=-1');
      },
      async receive() {
        return null;
      }
    };
    resetV3Session();
    clearLogs();
    const t0 = Date.now();
    const r = await acts.bindKey(VIN, FAST);
    ok('add-key 写失败即返回，不等窗口', r.ok === false && Date.now() - t0 < 200, String(Date.now() - t0) + 'ms');
    ok('写失败文案带原因与 BLE 连接数上限', r.text.indexOf('BLE 写失败') > 0 && r.text.indexOf('BLE 连接') > 0, r.text);
  }
  {
    probe.ble = { connected: false };
    let e = '';
    try {
      await acts.bindKey(VIN, FAST);
    } catch (err) {
      e = err.message;
    }
    ok('未连接时拒绝绑定', e.indexOf('还没连上车辆') >= 0, e);
  }
  // ---- 探针单独用（页面上的「④ 探针确认」）
  {
    const car = makeCar({ enrollAfterProbes: 1 });
    car.probes = 1; // 当作预探针已经打过了，这一针直接命中
    probe.ble = car.ble;
    resetV3Session();
    clearLogs();
    const r = await acts.probeSession();
    ok('探针命中：已入白名单', r.ok === true && r.paired === true && r.text.indexOf('已入白名单：') === 0, r.text.slice(0, 60));
    ok('探针文案带 key id 便于车机认钥匙', r.text.indexOf('Unknown key') > 0, r.text);
    const car2 = makeCar({ enrollAfterProbes: 99 });
    probe.ble = car2.ble;
    resetV3Session();
    const r2 = await acts.probeSession();
    ok('探针未命中：尚未入白名单', r2.ok === false && r2.notWhitelisted === true && r2.text.indexOf('尚未入白名单：') === 0, r2.text.slice(0, 60));
  }

  probe.ble = null;
  probe.privateKey = null;
  probe.publicKey = null;
  resetV3Session();
  clearLogs();
}

console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
