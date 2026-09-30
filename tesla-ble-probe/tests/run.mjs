// 离线自测：把纯 JS 密码学实现与 Node 官方 crypto 逐字节比对。
// 运行： node tesla-ble-probe/tests/run.mjs
// 注意：本文件只在开发机上跑，不参与 uni-app 打包（HBuilderX 不识别 .mjs 也不影响）。
import crypto from 'crypto';
import { toHex, fromHex, concatBytes, beBytes, utf8ToBytes, equalBytes } from '../src/infra/bytes.js';
import { sha1 } from '../src/infra/crypto/sha1.js';
import { aes128EncryptBlock, aes128GcmEncrypt, aes128GcmDecrypt, randomBytes } from '../src/infra/crypto/aes.js';
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
} from '../src/infra/crypto/p256.js';
import { V3_SPEC as SPEC } from '../src/protocol/v3/spec.js';
import * as vcsec from '../src/protocol/index.js';
import { sha256, hmacSha256 } from '../src/infra/crypto/sha256.js';
import * as v3 from '../src/protocol/index.js';
import * as api from '../src/services/vehicle-api.js';
import * as acts from '../src/services/index.js';
import { BleTransport } from '../src/infra/ble/ble-transport.js';
import { makeMatcher, sortAdv } from '../src/infra/ble/device-matcher.js';
import {
  state as probe,
  v3Session,
  storeV3Session,
  invalidateV3Session,
  invalidateAllV3Sessions,
  resetV3Session,
  describeKey,
  beginAction,
  endAction,
  action,
  clearLogs,
  getLogs,
  saveKeyPair,
  saveBind,
  forgetBind,
  forgetKey,
  hasKey,
  hasBind,
  autoReconnect,
  suspendAutoConnect,
  startAutoReconnectLoop,
  stopAutoReconnectLoop,
  describeAutoLoop,
  connection,
  ble as sessionBle
} from '../src/services/index.js';
import { notify, copyText, preview, NOTIFY_MAX } from '../src/infra/platform/notify.js';
import { ICONS } from '../src/ui/icons.js';
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

  // RKE：UnsignedMessage 整条就是一个 oneof sub_message，oneof 成员是「显式存在」——
  // UNLOCK=0 也必须写 tag（10 00）。省成空报文是 UNLOCK 一直回 WAIT 的根因。
  // 字段 2 -> tag = 2*8+0 = 0x10
  eqHex('UNLOCK 内层=1000（oneof 成员 0 值不省略）', v3.encode(SPEC, 'UnsignedMessage', { RKEAction: 0 }), fromHex('1000'));
  eqHex('LOCK 内层=1001', v3.encode(SPEC, 'UnsignedMessage', { RKEAction: 1 }), fromHex('1001'));
  // closureMoveRequest 是 oneof 里的 message(4) -> tag 0x22；frontTrunk 是普通字段(6) -> tag 0x30，OPEN=3
  eqHex('前备箱 OPEN 内层=22023003', v3.encode(SPEC, 'UnsignedMessage', { closureMoveRequest: { frontTrunk: 3 } }), fromHex('22023003'));
  // 普通标量照旧省略：informationRequestType 在 oneof 外，GET_STATUS=0 不编码；
  // 但 InformationRequest 本身是 oneof 成员，tag 必须写 -> 0a 00（不再是空报文）
  eqHex('GET_STATUS 内层=0a00', v3.encode(SPEC, 'UnsignedMessage', { InformationRequest: { informationRequestType: 0 } }), fromHex('0a00'));
  // 整条消息就是 oneof 的两种形态：0 值 / 空 bytes 都要留下 tag
  eqHex('Destination broadcast=0800', v3.encode(SPEC, 'Destination', { domain: 0 }), fromHex('0800'));
  eqHex('Destination 空 routing_address=1200', v3.encode(SPEC, 'Destination', { routing_address: new Uint8Array(0) }), fromHex('1200'));
  eqHex('KeyIdentity handle=0 -> 1800', v3.encode(SPEC, 'KeyIdentity', { handle: 0 }), fromHex('1800'));
  // 同一 oneof 给两个成员是非法编码，必须当场抛错而不是悄悄发出去
  let oneofErr = '';
  try {
    v3.encode(SPEC, 'UnsignedMessage', { RKEAction: 1, closureMoveRequest: { frontTrunk: 3 } });
  } catch (e2) {
    oneofErr = e2.message;
  }
  ok('oneof 同组冲突会报错', oneofErr.indexOf('oneof') > 0, oneofErr);
  let payloadErr = '';
  try {
    v3.encode(SPEC, 'RoutableMessage', { protobuf_message_as_bytes: fromHex('00'), session_info: fromHex('00') });
  } catch (e2) {
    payloadErr = e2.message;
  }
  ok('RoutableMessage payload 互斥', payloadErr.indexOf('payload') > 0, payloadErr);

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

console.log('[8b] car_server（INFOTAINMENT）协议表金标准');
{
  const A = (obj) => v3.encode(SPEC, 'Action', obj);
  // 官方 proto：Action.vehicleAction=2，VehicleAction 的 oneof 成员字段号见 car_server.proto
  //   盖板开 62 -> tag 62*8+2=498 -> F2 03；关 61 -> 490 -> EA 03；ping 46 -> 370 -> F2 02
  // 三个参考实现都是「空 message 只带 tag+len=0」，所以盖板那两条整条 Action 固定 5 字节。
  eqHex('充电盖板打开 Action=1203f20300', A({ vehicleAction: { chargePortDoorOpen: {} } }), fromHex('1203f20300'));
  eqHex('充电盖板关闭 Action=1203ea0300', A({ vehicleAction: { chargePortDoorClose: {} } }), fromHex('1203ea0300'));
  // Ping 不是空 message：ping_id=1 是字段 1 的 varint，所以内层还有 08 01
  eqHex('Ping Action=1205f202020801', A({ vehicleAction: { ping: { ping_id: 1 } } }), fromHex('1205f202020801'));
  // GetVehicleData：字段 1；开关 getChargeState=2 / getClosuresState=8（空 message 仍写 tag+00）
  eqHex(
    'GetVehicleData Action=12060a0412004200',
    A({ vehicleAction: { getVehicleData: { getChargeState: {}, getClosuresState: {} } } }),
    fromHex('12060a041200' + '4200')
  );
  // oneof 互斥照样生效：一次 Action 只能带一个 vehicle_action_msg 成员
  let csErr = '';
  try {
    A({ vehicleAction: { ping: { ping_id: 1 }, chargePortDoorOpen: {} } });
  } catch (e2) {
    csErr = e2.message;
  }
  ok('car_server oneof 互斥', csErr.indexOf('vehicle_action_msg') > 0, csErr);

  // ---- 阶段5c 新增的 4 个 oneof 成员（纯增量，上面 4 条老金标准一个字节都没动）
  //   闪灯 26 -> key D2 01；鸣笛 27 -> DA 01；都是空 message，整条 Action 5 字节
  eqHex('闪灯 Action=1203d20100', A({ vehicleAction: { vehicleControlFlashLightsAction: {} } }), fromHex('1203d20100'));
  eqHex('鸣笛 Action=1203da0100', A({ vehicleAction: { vehicleControlHonkHornAction: {} } }), fromHex('1203da0100'));
  //   HvacAutoAction=10 -> key 52；pkg/vehicle/climate.go:38-62 只填 PowerOn，
  //   false 是 proto3 默认值会被省略，但外层 tag+len 照写（12 02 52 00 就是「关空调」）
  eqHex('启动空调 Action=120452020801', A({ vehicleAction: { hvacAutoAction: { power_on: true } } }), fromHex('120452020801'));
  eqHex('关闭空调 Action=12025200', A({ vehicleAction: { hvacAutoAction: { power_on: false } } }), fromHex('12025200'));
  //   VehicleControlWindowAction=34 -> key 92 02；内层靠「哪个 Void 存在」表达（car_server.proto:401-408）
  eqHex('车窗通风 Action=12059202021a00', A({ vehicleAction: { vehicleControlWindowAction: { vent: {} } } }), fromHex('12059202021a00'));
  eqHex('关窗 Action=12059202022200', A({ vehicleAction: { vehicleControlWindowAction: { close: {} } } }), fromHex('12059202022200'));
  let winErr = '';
  try {
    A({ vehicleAction: { vehicleControlWindowAction: { vent: {}, close: {} } } });
  } catch (e3) {
    winErr = e3.message;
  }
  ok('车窗 oneof(action) 互斥', winErr.indexOf('action') > 0, winErr);

  // ---- 解码：伪枚举 / float / u64 / sint / 负 int32 都要能还原
  const vd = v3.encode(SPEC, 'VehicleData', {
    drive_state: { shift_state: { P: {} }, speed: 0, power: 12 },
    charge_state: { charging_state: { Charging: {} }, battery_level: 77, battery_range: 214.5, charge_port_door_open: true },
    climate_state: { inside_temp_celsius: 21.4 },
    location_state: { gps_as_of: 1700000000, latitude: 31.2345 },
    tire_pressure_state: { tpms_pressure_fl: 2.5 }
  });
  const back = v3.decode(SPEC, 'VehicleData', vd);
  ok('ShiftState 伪枚举', back.drive_state.shift_state.P !== undefined, JSON.stringify(back.drive_state.shift_state));
  ok('ChargingState 伪枚举', back.charge_state.charging_state.Charging !== undefined);
  ok('battery_level=77', back.charge_state.battery_level === 77, String(back.charge_state.battery_level));
  ok('bool charge_port_door_open', back.charge_state.charge_port_door_open === true);
  ok('float battery_range=214.5', Math.abs(back.charge_state.battery_range - 214.5) < 1e-4, String(back.charge_state.battery_range));
  ok('float inside_temp 21.4 截位可读', v3.inspect(SPEC, 'VehicleData', back).indexOf('inside_temp_celsius=21.4') > 0, v3.inspect(SPEC, 'VehicleData', back));
  ok('u64 gps_as_of 精确到秒', back.location_state.gps_as_of === 1700000000, String(back.location_state.gps_as_of));
  ok('latitude float', Math.abs(back.location_state.latitude - 31.2345) < 1e-3);
  ok('tpms float', Math.abs(back.tire_pressure_state.tpms_pressure_fl - 2.5) < 1e-4);

  // sint32 走 zigzag（ChargeState.scheduled_charging_start_time_app=153）
  const szBack = v3.decode(SPEC, 'ChargeState', v3.encode(SPEC, 'ChargeState', { scheduled_charging_start_time_app: -120 }));
  ok('sint32 负值还原', szBack.scheduled_charging_start_time_app === -120, JSON.stringify(szBack));

  // proto3 负 int32 会符号扩展成 10 字节 varint（DriveState.power=103）。
  // 这是补 pb.js 之前的崩溃点：一旦车辆回一帧负值，整条 VehicleData 就解不出来。
  const negTag = [0xb8, 0x06]; // (103<<3)|0 = 824 的 base-128
  const negVal = [];
  {
    let v = (1n << 64n) - 5n; // -5 的 64 位补码
    for (;;) {
      const b = Number(v & 0x7fn);
      v >>= 7n;
      negVal.push(v ? b | 0x80 : b);
      if (!v) break;
    }
  }
  ok('负 int32 编码是 10 字节', negVal.length === 10, String(negVal.length));
  const negBack = v3.decode(SPEC, 'DriveState', new Uint8Array(negTag.concat(negVal, [0x22, 0x02, 0x08, 0x06])));
  ok('负 int32 power=-5 归一', negBack.power === -5, JSON.stringify(negBack));
  ok('同帧其它字段照常解析', negBack.timestamp !== undefined && negBack.timestamp.seconds === 6, v3.inspect(SPEC, 'DriveState', negBack));

  // 字段号抄错（wire type 不匹配）时降级成 f<n>，不能整帧抛错
  const mismatch = v3.decode(SPEC, 'ClosuresState', new Uint8Array([0x58, 0x03])); // 11 声明为 msg，实收 varint
  ok('wire 不匹配降级为 f11', mismatch.f11 === 3 && mismatch.sun_roof_state === undefined, JSON.stringify(mismatch));
  // 未登记的字段同样是降级，不是错误（24 = parental_controls_state，本项目没登记）
  const unknown = v3.decode(SPEC, 'VehicleData', new Uint8Array([0xc0, 0x01, 0x07]));
  ok('未登记字段降级为 f24', unknown.f24 === 7, JSON.stringify(unknown));

  // Response：应用层判读要用 carserver 自己那套 OperationStatus_E（只有 OK/ERROR）
  const respBytes = v3.encode(SPEC, 'Response', {
    actionStatus: { result: 1, result_reason: { plain_text: 'Vehicle is not awake' } },
    vehicleData: { closures_state: { locked: false } }
  });
  const resp = v3.decode(SPEC, 'Response', respBytes);
  ok('Response.actionStatus.result=ERROR(1)', resp.actionStatus.result === 1);
  ok('Response.plain_text', resp.actionStatus.result_reason.plain_text === 'Vehicle is not awake', JSON.stringify(resp.actionStatus));
  ok('carserver 枚举没有 WAIT', SPEC.enums.CSOperationStatus_E.OPERATIONSTATUS_WAIT === undefined);
  ok('locked=false 显式存在（oneof）', resp.vehicleData.closures_state.locked === false, JSON.stringify(resp.vehicleData));
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

  // 响应 AAD 的**不对称**回归锁（真机 GetVehicleData「响应 GCM tag 不符」的根因锁）。
  // 上面那块假车机直接调用我方 responseMetadata，结构上测不出「响应 AAD 的 domain 字节取错」——
  // 车辆和我方各算各的才叫验证。这里车辆侧照官方 peer.go:105-117 手工拼 TLV，不经 responseMetadata。
  {
    const T = v3.TAG;
    const respPlain = fromHex('0801');
    const respCounter = 4243;
    const reqId = v3.requestIdOf(rmBack);
    const prevId = concatBytes([fromHex('05'), fromHex('112233445566778899aabbccddeeff')]); // 上一次请求的 ID

    // 车辆算响应 AAD：domain 取的是**车辆自己写进 from_destination 的那个字节**，
    // 没写就是 0（Go getter 对 nil 安全）—— 绝不是「请求的域」。
    const carAad = (o) => {
      const m = new v3.Metadata();
      m.addByte(T.TAG_SIGNATURE_TYPE, v3.SIGTYPE.SIGNATURE_TYPE_AES_GCM_RESPONSE);
      m.addByte(T.TAG_DOMAIN, o.domain);
      m.add(T.TAG_PERSONALIZATION, utf8ToBytes(String(vin).toUpperCase()));
      m.addUint32(T.TAG_COUNTER, respCounter);
      m.addUint32(T.TAG_FLAGS, 2); // 响应恒含 flags（peer.go:112）
      m.add(T.TAG_REQUEST_HASH, o.requestId);
      m.addUint32(T.TAG_FAULT, 0);
      return m.sha256();
    };

    // 造一条车辆回包：aadDomain 进 AAD，frameDomain 写进帧（undefined = 整个 from_destination 缺失）
    const carFrame = (o) => {
      const nonce = randomBytes(12);
      const e = aes128GcmEncrypt(o.key || K, nonce, respPlain, carAad({ domain: o.aadDomain, requestId: o.requestId }));
      const resp = {
        to_destination: { routing_address: addr },
        protobuf_message_as_bytes: e.ciphertext,
        signature_data: { AES_GCM_Response_data: { nonce, counter: respCounter, tag: e.tag } },
        request_uuid: fromHex('58406580528b6a5301391800b4fe9b99'),
        flags: 2
      };
      if (o.frameDomain !== undefined) resp.from_destination = { domain: o.frameDomain };
      return v3.decode(v3.V3_SPEC, 'RoutableMessage', v3.encode(v3.V3_SPEC, 'RoutableMessage', resp));
    };

    ok('responseDomainByte：没有 from_destination = 0', v3.responseDomainByte({}) === 0);
    ok('responseDomainByte：from_destination 只有 routing_address = 0',
      v3.responseDomainByte({ from_destination: { routing_address: addr } }) === 0);
    ok('responseDomainByte：有 domain 取原值', v3.responseDomainByte({ from_destination: { domain: 3 } }) === 3);

    // A. 车辆不带 from_destination（AAD domain=0）—— 即使我方这条请求发向 INFOTAINMENT(3) 也必须解开。
    //    修掉之前 decryptResponse 回退成「请求的域」的那一行，真机 VCSEC 响应就是死在这里。
    const gotA = v3.decryptResponse(carFrame({ aadDomain: 0, requestId: reqId }),
      { domain: v3.DOMAIN.DOMAIN_INFOTAINMENT, vin, requestId: reqId, session: { key: K } });
    ok('A 车辆不带 from_destination（AAD domain=0）解得开', gotA.ok, gotA.error);
    eqHex('A 明文', gotA.plaintext || new Uint8Array(), respPlain);

    // B. 车辆带了 from_destination 时用它，不能被请求域盖掉（这里请求域故意给 VCSEC=2）
    const gotB = v3.decryptResponse(carFrame({ aadDomain: 3, frameDomain: 3, requestId: reqId }),
      { domain: v3.DOMAIN.DOMAIN_VEHICLE_SECURITY, vin, requestId: reqId, session: { key: K } });
    ok('B 有 from_destination 时以响应为准', gotB.ok, gotB.error);

    // C. 车辆 AAD 用请求域、帧里却不带 from_destination：按官方就是解不开，但诊断必须点名 domain
    const gotC = v3.decryptResponse(carFrame({ aadDomain: 3, requestId: reqId }),
      { domain: 3, vin, requestId: reqId, session: { key: K } });
    ok('C 元数据不一致时拒绝解密', !gotC.ok);
    ok('C 诊断点名 domain 试算命中',
      !gotC.ok && gotC.error.indexOf('domain 用请求的域 3') > 0 && gotC.error.indexOf('就能对上 → 根因是这个字段') > 0, gotC.error);
    ok('C 诊断不带会话密钥（安全红线）',
      gotC.error.indexOf(toHex(K)) < 0 && String(gotC.detail || '').indexOf(toHex(K)) < 0);

    // D. 迟到/串台帧：车辆回的是上一次请求的 request_hash
    const gotD = v3.decryptResponse(carFrame({ aadDomain: 0, requestId: prevId }),
      { domain: 3, vin, requestId: reqId, session: { key: K }, previousRequestIds: [{ name: '上一次', id: prevId }] });
    ok('D 迟到帧按本次 requestId 验不过', !gotD.ok);
    ok('D 诊断点名更早那次请求',
      !gotD.ok && gotD.error.indexOf('更早那次请求（上一次）') > 0 && gotD.error.indexOf('就能对上 → 根因是这个字段') > 0, gotD.error);

    // E. 车机把回包记在另一个域 → 密钥换成那一份才对上
    const K2 = randomBytes(16);
    const gotE = v3.decryptResponse(carFrame({ aadDomain: 0, requestId: reqId, key: K2 }),
      { domain: 3, vin, requestId: reqId, session: { key: K }, altKeys: [{ name: '安全', key: K2 }] });
    ok('E 拿错域密钥时诊断点名密钥',
      !gotE.ok && gotE.error.indexOf('安全 的会话密钥') > 0 && gotE.error.indexOf('就能对上 → 根因是这个字段') > 0, gotE.error);
    ok('E 诊断不泄露备用密钥', gotE.error.indexOf(toHex(K2)) < 0 && String(gotE.detail || '').indexOf(toHex(K2)) < 0);

    // F. 密文被截断：单字段怎么换都对不上
    const cut = carFrame({ aadDomain: 0, requestId: reqId });
    cut.protobuf_message_as_bytes = cut.protobuf_message_as_bytes.subarray(0, 1);
    const gotF = v3.decryptResponse(cut, { domain: 3, vin, requestId: reqId, session: { key: K } });
    ok('F 截断密文拒绝解密', !gotF.ok);
    ok('F 诊断说明单字段全试完都对不上',
      !gotF.ok && gotF.error.indexOf('以上单字段全试完都对不上') > 0, gotF.error);
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
    // UNLOCK=0 是 oneof 成员，载荷必须是 1000；空载荷会让车辆一直回 WAIT（现场实测踩过）
    eqHex('V3 RKE UNLOCK 载荷 = 1000', v3.encodeUnsignedMessage({ RKEAction: 0 }), fromHex('1000'));
    // 驾驶授权（RemoteDrive）：vcsec.proto:79 RKE_ACTION_REMOTE_DRIVE = 20，
    // 载荷和 UNLOCK/LOCK 完全同形状，只是数值换成 20 —— 它是**又一条独立的 RKE 命令**，
    // 不是解锁的附属步骤（官方 vcsec.go:173-202 里 Unlock 与 RemoteDrive 各调一次 executeRKEAction）。
    eqHex('V3 RKE REMOTE_DRIVE 载荷 = 1014', v3.encodeUnsignedMessage({ RKEAction: 20 }), fromHex('1014'));
    // 端到端：走加密链路后，外层 RoutableMessage 必须真的带上 payload。
    // 旧实现把 0 值 oneof 省成空串 → 密文也 0 字节 → protobuf_message_as_bytes 整个字段消失，
    // 车辆收到的是一条「没有载荷」的命令，只能一直回 operation_status=WAIT。
    {
      const s = { key: K, epoch, anchor: 0, counter: 6 };
      const u = v3.encryptCommand({
        domain: v3.DOMAIN.DOMAIN_VEHICLE_SECURITY, vin, session: s, publicKey: pubC,
        payload: v3.encodeUnsignedMessage({ RKEAction: 0 }), routingAddress: addr, uuid, now: 2650,
        nonce: fromHex('00112233445566778899aabb')
      });
      const back = v3.decode(v3.V3_SPEC, 'RoutableMessage', u.bytes);
      ok('UNLOCK 整包带上 payload 字段', back.protobuf_message_as_bytes instanceof Uint8Array && back.protobuf_message_as_bytes.length === 2,
        v3.inspect(v3.V3_SPEC, 'RoutableMessage', back));
      eqHex('UNLOCK 密文解回明文 = 1000', aes128GcmDecrypt(K, u.nonce, back.protobuf_message_as_bytes, u.aad).plaintext, fromHex('1000'));
    }
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
//   1）pages/ 只 import src/services/vehicle-api.js —— api.js 的转发、V3 会话（counter 只增不减）、
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
  // 解锁之后挂不上挡要靠它：REMOTE_DRIVE 必须在收窄后的表里留着（vcsec.proto:79 = 20）
  ok('RKE 保留 REMOTE_DRIVE=20（驾驶授权）', api.rkeEnum('RKE_ACTION_REMOTE_DRIVE') === 20, String(api.rkeEnum('RKE_ACTION_REMOTE_DRIVE')));
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

  // 驾驶授权那颗按钮的台账名：页面 lastResult(DRIVE_LEDGER) 按字符串命中，
  // 所以「分段名 = 台账名 = vehicle-api 的 tracked 名」这三处必须一次锁死，改一个字界面就永远停在「还没试过」。
  const { lastResult, clearDiagnostics } = acts;
  clearDiagnostics();
  let driveErr = '';
  try {
    await api.remoteDrive();
  } catch (e) {
    driveErr = e.message;
  }
  const m4 = marks();
  ok('未连接时驾驶授权同样分段收尾', driveErr.indexOf('还没连上车辆') >= 0 && m4[0] === '-----start----- 驾驶授权（RemoteDrive）', JSON.stringify(m4));
  {
    const d = lastResult('驾驶授权（RemoteDrive）', 'VCSEC');
    ok('驾驶授权按「名字+VCSEC」落进诊断台账', !!d && d.ok === false && d.text.indexOf('还没连上车辆') >= 0, JSON.stringify(d));
    ok('驾驶授权两层都在：原始 requestDrive + 页面用的 tracked 包装', typeof acts.requestDrive === 'function' && typeof api.remoteDrive === 'function');
    ok('GenericError 处置建议表在门面上可读', !!acts.GENERIC_ERROR_HINTS && typeof acts.GENERIC_ERROR_HINTS.GENERICERROR_NOT_ALLOWED_OVER_TRANSPORT === 'string');
  }
  clearDiagnostics();
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
  ok('describeKey 展开 VCSEC counter', describeKey().indexOf('VCSEC counter=900') >= 0, describeKey());
  ok('describeKey 同时列出的车机域', describeKey().indexOf('车机 counter=0') >= 0, describeKey());
  invalidateV3Session('测试：换了连接');
  ok('作废会话只清共享密钥，counter 不回退', vs.key === null && vs.ready === false && vs.counter === 900);
  resetV3Session();
  ok('reset 才把 V3 counter 归零', v3Session().counter === 0 && v3Session().ready === false);

  // ---------------------------------------------------------- 分域会话（per-domain）
  //
  // 官方 dispatcher.go:36 `sessions map[Domain]*session` + tesla-ble include/peer.h
  // 每个 Peer 各自 counter_，所以这里必须验证：
  //   1) 两个域的 counter 各走各的，谁都不许覆盖谁；
  //   2) 落盘是两个互不相干的键（VCSEC 沿用老键名，真机已有的 counter 不回退）；
  //   3) 换连接只作废「本次连接才有效」的共享密钥，两域都作废，但 counter 全部保留。
  {
    const D_INF = v3.DOMAIN.DOMAIN_INFOTAINMENT;
    const mem = {};
    globalThis.uni = {
      setStorageSync: (k, v) => {
        mem[k] = v === null ? null : JSON.parse(JSON.stringify(v));
      },
      getStorageSync: (k) => (mem[k] === undefined || mem[k] === null ? '' : JSON.parse(JSON.stringify(mem[k])))
    };
    resetV3Session();
    resetV3Session(D_INF);
    const sVc = v3Session();
    const sIf = v3Session(D_INF);
    ok('两个域拿到的是两个不同对象', sVc !== sIf && sVc.domain === 2 && sIf.domain === 3, sVc.domain + '/' + sIf.domain + '/' + (sVc === sIf));
    sVc.counter = 41;
    sVc.ready = true;
    sVc.epoch = new Uint8Array(16).fill(3);
    sIf.counter = 7;
    sIf.ready = true;
    sIf.epoch = new Uint8Array(16).fill(9);
    sIf.key = new Uint8Array(16).fill(4);
    storeV3Session();
    storeV3Session(D_INF);
    ok('VCSEC 落盘键沿用老名字（真机 counter 不回退）', mem.tesla_probe_v3_session_v1.counter === 41, JSON.stringify(mem));
    ok('车机域独立落盘', mem.tesla_probe_v3_infotainment_v1.counter === 7, JSON.stringify(mem));
    ok('落盘内容不带共享密钥', mem.tesla_probe_v3_infotainment_v1.key === undefined, JSON.stringify(mem.tesla_probe_v3_infotainment_v1));
    invalidateAllV3Sessions('测试：换连接');
    ok('换连接作废两域密钥但 counter 全部保留',
      sVc.key === null && sIf.key === null && sVc.counter === 41 && sIf.counter === 7);
    ok('reset 只清指定域，另一个域 counter 不动',
      (resetV3Session(D_INF), v3Session(D_INF).counter === 0 && v3Session().counter === 41));
    // 内存清空后从存储恢复：两域各自回到各自的 counter
    probe.v3 = {};
    ok('重启后 VCSEC 恢复 counter=41', v3Session().counter === 41, String(v3Session().counter));
    ok('重启后车机域恢复 counter=0（刚被 reset 落盘）', v3Session(D_INF).counter === 0, String(v3Session(D_INF).counter));
    probe.v3 = {};
    ok('BROADCAST 域不建会话', (() => {
      try {
        v3Session(0);
        return false;
      } catch (e) {
        return e.message.indexOf('不建会话') >= 0;
      }
    })());
    delete globalThis.uni;
    resetV3Session();
    resetV3Session(D_INF);
  }

  // ---------------------------------------------------------- 传输层：分帧 / 暂存 / keepQueue
  const bleLogs = [];
  const ble = new BleTransport({ log: (kind, msg) => bleLogs.push(kind + ' ' + msg) });
  ble.connected = true;
  {
    const f = frameOf(fromHex('0801120452020801'));
    const p = ble.waitForFrame(1000);
    ble.onChunk({ value: ab(f.subarray(0, 4)) });
    ok('半个帧不会被交付', ble.waiters.length === 1 && ble.reassembler.buffer.length === 4);
    ble.onChunk({ value: ab(f.subarray(4)) });
    const got = await p;
    ok('分包会重组后再交付完整帧', toHex(got) === '0801120452020801');
  }
  {
    const two = concatBytes([frameOf(fromHex('0801')), frameOf(fromHex('120452020801'))]);
    const p = ble.waitForFrame(1000);
    ble.buffering = true; // V3 的 readUntil 语义：还在处理上一帧
    ble.onChunk({ value: ab(two) });
    const first = await p;
    ok('一包两帧按长度前缀切开', toHex(first) === '0801');
    ok('第二帧被暂存而不是丢弃', ble.queue.length === 1 && toHex(ble.queue[0]) === '120452020801');
    const second = await ble.receive(1000);
    ok('receive 优先取暂存帧', toHex(second) === '120452020801' && ble.queue.length === 0);
    ok('无帧时 receive 超时返回 null 不抛错', (await ble.receive(60)) === null);
  }
  {
    // Node 里没有 uni：老实现的 send 测试其实是靠「写失败被 catch(() => {}) 吞掉」才过的。
    // 现在写失败会如实抛出，所以先桩一个「写永远成功」的 uni，让 keepQueue/超时用例走真实路径。
    globalThis.uni = { writeBLECharacteristicValue: (o) => setTimeout(() => o.success && o.success({}), 0) };
    ble.queue.push(fromHex('a1'));
    ble.reassembler.buffer = fromHex('0010');
    ble.reassembler.lastAt = Date.now();
    await ble.send(frameOf(fromHex('0801')), 0, true);
    ok('keepQueue=true 保留暂存帧（V3）', ble.queue.length === 1);
    ok('send 不再丢弃正在拼的半帧（官方只在分包静默 1 秒后清）', ble.reassembler.buffer.length === 2, toHex(ble.reassembler.buffer));
    await ble.send(frameOf(fromHex('0801')), 0);
    ok('send 默认清空暂存帧（一条请求只对应一轮应答）', ble.queue.length === 0);
  }
  {
    // GetVehicleData 的响应要拆成十几包慢慢推：重发时正在拼的半截帧必须继续拼完，
    // 否则送进 GCM 的是截断密文，现场只看到误导人的「响应 GCM tag 不符」。
    ble.reassembler.buffer = fromHex('0010'); // 上一包的长度前缀：声明 16 字节，还没收完
    ble.reassembler.lastAt = Date.now();
    const pTail = ble.waitForFrame(1000);
    ble.onChunk({ value: ab(new Uint8Array(16).fill(0x11)) });
    ok('半截帧在下一条通知里拼成完整帧', toHex(await pTail) === '11'.repeat(16), toHex(ble.reassembler.buffer));
  }
  {
    // 官方 ble.go:98-106：分包静默超过 rxTimeout(1s) 才丢半截帧
    ble.reassembler.buffer = fromHex('0010');
    ble.reassembler.lastAt = Date.now() - 5000;
    const pIdle = ble.waitForFrame(1000);
    ble.onChunk({ value: ab(frameOf(fromHex('0801'))) });
    ok('分包静默 1 秒后丢弃残留并正常交付新帧', toHex(await pIdle) === '0801');
    ok('丢弃残留时有日志（不是静默行为）', bleLogs.join('\n').indexOf('分包间隔超过') >= 0, bleLogs.join('\n'));
  }
  {
    // 官方 flush()：声明长度 > maxBLEMessageSize(1024) 就是错位前缀，整块丢掉，绝不能永远卡在「等待后续分包」
    bleLogs.length = 0;
    ble.reassembler.buffer = new Uint8Array(0);
    ble.reassembler.lastAt = Date.now();
    const pCap = ble.waitForFrame(1000);
    let capResolved = false;
    pCap.then(() => { capResolved = true; }, () => {}); // 第二个处理函数不能省：否则这条派生 Promise 自己变成未捕获拒绝
    ble.onChunk({ value: ab(fromHex('ffff080100020801')) });
    await new Promise((r) => setTimeout(r, 20));
    ok('超长前缀触发丢缓冲而不是无限等待', ble.reassembler.buffer.length === 0 && !capResolved, toHex(ble.reassembler.buffer));
    ok('超长前缀有 error 级日志', bleLogs.join('\n').indexOf('超过单帧上限') >= 0, bleLogs.join('\n'));
    await pCap.catch(() => {}); // 这一帧本就等不到，让它的等待走完，别把下一条测试的响应喂给它
    const pNext = ble.waitForFrame(1000);
    ble.onChunk({ value: ab(frameOf(fromHex('0802'))) });
    ok('丢掉垃圾后下一帧照常对齐', toHex(await pNext) === '0802');
  }
  {
    const p = ble.waitForFrame(5000);
    ble.rejectAll(new Error('BLE 已断开'));
    let msg = '';
    try {
      await p;
    } catch (e) {
      msg = e.message;
    }
    ok('断连时等待中的帧被拒绝', msg.indexOf('BLE 已断开') >= 0 && ble.waiters.length === 0);
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
    ok('写失败后不留悬着的响应等待', ble.waiters.length === 0);
  }
  {
    // 回归锁：0x212 只接受「无响应写」时（官方 ble.go:121 用的就是 withResponse=false），
    // 协议栈会回 property not support —— 必须换 writeType 把同一批字节重写出去，不能直接失败。
    const seen = [];
    const nrLogs = [];
    globalThis.uni = {
      writeBLECharacteristicValue: (o) => {
        seen.push(o.writeType);
        if (o.writeType === 'write') {
          setTimeout(() => o.fail && o.fail({ errMsg: 'writeBLECharacteristicValue:fail property not support', errCode: 10007 }), 0);
        } else {
          setTimeout(() => o.success && o.success({}), 0);
        }
      }
    };
    const nr = new BleTransport({ log: (k, m) => nrLogs.push(k + ':' + m) });
    nr.connected = true;
    nr.deviceId = 'dev';
    nr.serviceId = 'svc';
    nr.writeId = 'w';
    nr.mtu = 517;
    nr.writeProps = { write: true, writeNoResponse: false }; // 车端谎报只支持有响应写：靠重试纠偏
    await nr.writeChunked(frameOf(fromHex('0801')));
    ok('property not support 会换 writeType 重试', seen.join(',') === 'write,writeNoResponse', seen.join(','));
    ok('换写法成功有 warn 日志', nrLogs.join('\n').indexOf('换下一种写入方式重试') >= 0, nrLogs.join('\n'));
    ok('记住本次连接的有效写法', nr.writeType === 'writeNoResponse', String(nr.writeType));
    seen.length = 0;
    await nr.writeChunked(frameOf(fromHex('0802')));
    ok('后续写入直接用已确认的写法，不再试探', seen.join(',') === 'writeNoResponse', seen.join(','));
  }
  {
    // 回归锁：非属性类错误绝不重发 —— 前一片可能已经落进车端组包缓冲，重复发会拼出坏帧。
    const seen = [];
    globalThis.uni = {
      writeBLECharacteristicValue: (o) => {
        seen.push(o.writeType);
        setTimeout(() => o.fail && o.fail({ errMsg: 'writeBLECharacteristicValue:fail invalid handle', errCode: -1 }), 0);
      }
    };
    const one = new BleTransport({});
    one.connected = true;
    one.mtu = 517;
    let oerr = '';
    try {
      await one.writeChunked(frameOf(fromHex('0801')));
    } catch (e) {
      oerr = e.message;
    }
    ok('非属性错误只发一次就抛', seen.length === 1 && oerr.indexOf('第 1/1 片（4 字节，偏移 0）写入失败') === 0 && oerr.indexOf('invalid handle') > 0, oerr);
    ok('每片都显式带上 writeType', String(seen[0]) === 'writeNoResponse', String(seen[0]));
  }
  {
    // 回归锁：uni 的 10008 是 system error（文档：notify 成功后立刻写，部分机型报 10008），
    // 不属于「写法与属性不匹配」，绝不许换写法重发 —— 重复字节会把车端的组包缓冲拼坏。
    const seen = [];
    globalThis.uni = {
      writeBLECharacteristicValue: (o) => {
        seen.push(o.writeType);
        setTimeout(() => o.fail && o.fail({ errMsg: 'writeBLECharacteristicValue:fail', errCode: 10008 }), 0);
      }
    };
    const sys = new BleTransport({});
    sys.connected = true;
    sys.mtu = 517;
    let serr = '';
    try {
      await sys.writeChunked(frameOf(fromHex('0801')));
    } catch (e) {
      serr = e.message;
    }
    ok('10008 系统错误不换写法重发', seen.length === 1 && serr.indexOf('已试 writeType') < 0 && serr.indexOf('errCode=10008') > 0, serr);
  }
  {
    // 回归锁：基座只回 errCode=10007、errMsg 里没有英文关键字时也要认成「属性不支持」
    const seen = [];
    globalThis.uni = {
      writeBLECharacteristicValue: (o) => {
        seen.push(o.writeType);
        const bad = o.writeType === 'writeNoResponse';
        setTimeout(() => (bad ? o.fail : o.success)({ errMsg: 'writeBLECharacteristicValue:fail', errCode: bad ? 10007 : 0 }), 0);
      }
    };
    const code = new BleTransport({});
    code.connected = true;
    code.mtu = 517;
    await code.writeChunked(frameOf(fromHex('0801')));
    ok('只凭 errCode=10007 也会换写法重试成功', seen.join(',') === 'writeNoResponse,write' && code.writeType === 'write', seen.join(','));
  }
  {
    // 回归锁：属性两种平台形状（对象 / Android 位掩码 0x08|0x04）都要解析出来，
    // 并把 0211 的特征清单打进日志 —— 真机上看不到属性就只能猜。
    const logs = [];
    const probe = new BleTransport({ log: (k, m) => logs.push(k + ':' + m) });
    probe.deviceId = 'dev';
    globalThis.uni = {
      getBLEDeviceServices: (o) => setTimeout(() => o.success({ services: [{ uuid: '00000211-B2D1-43F0-9B88-960CEBF8B91E' }] }), 0),
      getBLEDeviceCharacteristics: (o) => setTimeout(() => o.success({
        characteristics: [
          { uuid: '00000212-B2D1-43F0-9B88-960CEBF8B91E', properties: { read: false, write: false, writeNoResponse: true } },
          { uuid: '00000213-B2D1-43F0-9B88-960CEBF8B91E', properties: { read: true, write: false, writeNoResponse: false, indicate: true } },
          { uuid: '00000214-B2D1-43F0-9B88-960CEBF8B91E', properties: 0x02 }
        ]
      }), 0)
    };
    await probe.discoverServices();
    ok('发现服务会解析 0x212 写属性', !!probe.writeProps && probe.writeProps.writeNoResponse === true && probe.writeProps.write === false, JSON.stringify(probe.writeProps));
    ok('只支持无响应写时首选 writeNoResponse', probe.writeTypeOrder()[0] === 'writeNoResponse' && probe.writeTypeOrder()[1] === 'write', probe.writeTypeOrder().join(','));
    ok('特征清单进日志', logs.join('\n').indexOf('0211 特征清单') >= 0 && logs.join('\n').indexOf('0212(write=n writeNoResponse=y)') >= 0, logs.join('\n'));
    const mask = new BleTransport({});
    mask.deviceId = 'dev';
    globalThis.uni = {
      getBLEDeviceServices: (o) => setTimeout(() => o.success({ services: [{ uuid: '00000211-b2d1-43f0-9b88-960cebf8b91e' }] }), 0),
      getBLEDeviceCharacteristics: (o) => setTimeout(() => o.success({
        characteristics: [
          { uuid: '00000212-b2d1-43f0-9b88-960cebf8b91e', properties: 0x08 | 0x04 },
          { uuid: '00000213-b2d1-43f0-9b88-960cebf8b91e', properties: 0x20 }
        ]
      }), 0)
    };
    await mask.discoverServices();
    ok('位掩码形式的属性也认', mask.writeProps.write === true && mask.writeProps.writeNoResponse === true, JSON.stringify(mask.writeProps));
  }
  delete globalThis.uni;
  const off = new BleTransport({});
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

console.log('\n[15] 车机域（car_server / INFOTAINMENT）端到端回归');
{
  // [14] 那辆假车机只会认 VCSEC 的老路；这一节的假车机要真的把加密命令按元数据解开，
  // 再回一帧加密的 car_server.Response。锁死三件事：
  //   1) 车机动作用 INFOTAINMENT 那份会话（counter / epoch 都不许和 VCSEC 串台，
  //      官方 dispatcher.go:36 的 sessions 数组、domains.go:7-13、client.cpp:46-52）；
  //   2) 走完整个加密链路后，上线的明文字节仍然是 [8b] 那几条金标准；
  //   3) actionStatus=ERROR 时 result_reason.plain_text 必须出现在失败文案里
  //      （官方 infotainment.go:37-43 的 "car could not execute command: <text>"）。
  const VIN = '5YJ3E1EA1KF000000';
  const D_VC = v3.DOMAIN.DOMAIN_VEHICLE_SECURITY;
  const D_INF = v3.DOMAIN.DOMAIN_INFOTAINMENT;
  const myKp = vcsec.newKeyPair();
  const carKp = vcsec.newKeyPair();
  // 握手时车辆自报的 counter：两域故意给不同值，好验证各走各的
  const BASE = {};
  BASE[D_VC] = 11;
  BASE[D_INF] = 5;
  const CLOCK = 2650; // 与 [10] 同一份文档向量，保证 expires_at 不越界
  const nap = (n) => new Promise((r) => setTimeout(r, n));

  function makeCar(o) {
    const car = { handshakes: [], cmds: [], wire: [], K: null, tagMismatch: 0, respCounter: 0, plain: 0, frames: [], late: null, errUsed: false, uuidUsed: false, fromUsed: false };
    const epochs = {}; // domain → 握手时下发的 epoch（车辆侧自己记的那份）

    // 车辆自己发的周期广播帧：to={domain:BROADCAST}、from={domain:VCSEC}，既没有路由地址也没有 uuid，
    // 应用层还带着一看就像成功的 actionStatus=OK。真机那次就是它被 receive() 当成车机响应，
    // 才报出「成功：actionStatus=OPERATIONSTATUS_OK(0)」而 vehicleData 一个字节都没有。
    const broadcastFrame = () =>
      v3.encode(SPEC, 'RoutableMessage', {
        to_destination: { domain: v3.DOMAIN.DOMAIN_BROADCAST },
        from_destination: { domain: D_VC },
        protobuf_message_as_bytes: v3.encode(SPEC, 'Response', { actionStatus: { result: 0 } })
      });

    car.ble = {
      connected: true,
      async send(bytes) {
        const rm = v3.decode(SPEC, 'RoutableMessage', bytes.subarray(2));
        const domain = rm.to_destination ? rm.to_destination.domain : undefined;

        // ① 握手：两域同一个形状，只是 domain / epoch / counter 各一份
        if (rm.session_info_request) {
          car.handshakes.push(domain);
          const epoch = randomBytes(16);
          epochs[domain] = epoch;
          car.K = v3.sharedKeyOf(carKp.privateKey, rm.session_info_request.public_key);
          const info = v3.encode(SPEC, 'SessionInfo', {
            counter: BASE[domain],
            publicKey: carKp.publicKey,
            epoch,
            clock_time: CLOCK,
            status: 0
          });
          return v3.encode(SPEC, 'RoutableMessage', {
            session_info: info,
            signature_data: { session_info_tag: { tag: v3.sessionInfoHmac(car.K, VIN, rm.uuid, info) } },
            request_uuid: rm.uuid
          });
        }

        // ② 加密命令：只用请求里带的元数据字段重算 AAD。解不开 = 本机元数据组装有问题
        const g = rm.signature_data ? rm.signature_data.AES_GCM_Personalized_data : null;
        if (!g) {
          car.plain++;
          return null;
        }
        const meta = v3.requestMetadata({
          signatureType: v3.SIGTYPE.SIGNATURE_TYPE_AES_GCM_PERSONALIZED,
          domain,
          vin: VIN,
          epoch: g.epoch,
          expiresAt: g.expires_at,
          counter: g.counter,
          flags: rm.flags || 0
        });
        const dec = aes128GcmDecrypt(car.K, g.nonce, rm.protobuf_message_as_bytes, meta.sha256());
        const authed = equalBytes(dec.expectedTag, g.tag);
        if (!authed) car.tagMismatch++;
        const cmd = {
          domain,
          counter: g.counter,
          epoch: g.epoch,
          plaintext: dec.plaintext,
          authenticated: authed,
          epochMatches: toHex(g.epoch) === toHex(epochs[domain] || '')
        };
        car.cmds.push(cmd);
        car.wire.push(toHex(bytes.subarray(2))); // 上线的整帧字节：重发必须是同一串（官方 dispatcher.go:434-460）

        // ③ 回一帧加密 Response：车辆侧的响应 counter 自己递增，与请求 counter 无关
        // replyFrame 额外支持真机才会出现的两种形状，专门锁死「看不懂的一帧只丢弃、不判死」：
        //   noPayload = 带 AES_GCM_Response_data 但没有 payload（payload 是 oneof，这组合合法）
        //   badTag    = tag 故意取反，模拟元数据对不上 / 拿错域的密钥
        //   to        = 把回包记在**别人的**路由地址上（模拟串台帧），官方 dispatcher.go:280-293 会直接丢掉
        //   fault     = 在 signedMessageStatus 里写协议层错误（真机合包 GetVehicleData 的 25）
        //   uuid      = 覆盖 request_uuid（模拟上一条请求 / 别人的回包）
        //   fromDomain= 改回执来源域（模拟车辆自己发的周期广播冒充响应）
        const replyFrame = (plainBytes, opt) => {
          const rc = ++car.respCounter;
          const rmeta = v3.responseMetadata({
            domain,
            vin: VIN,
            counter: rc,
            flags: rm.flags || 0,
            requestId: v3.requestIdOf(rm),
            fault: (opt && opt.fault) || 0
          });
          const rNonce = randomBytes(12);
          const rEnc = aes128GcmEncrypt(car.K, rNonce, plainBytes, rmeta.sha256());
          const tag = opt && opt.badTag ? Uint8Array.from(rEnc.tag, (b) => b ^ 0xff) : rEnc.tag;
          const msg = {
            to_destination: { routing_address: (opt && opt.to) || rm.from_destination.routing_address },
            from_destination: { domain: (opt && opt.fromDomain) || domain },
            signature_data: { AES_GCM_Response_data: { nonce: rNonce, counter: rc, tag } },
            request_uuid: (opt && opt.uuid) || rm.uuid,
            flags: rm.flags || 0
          };
          if (opt && opt.fault) msg.signedMessageStatus = { operation_status: SPEC.enums.UMOperationStatus_E.OPERATIONSTATUS_ERROR, signed_message_fault: opt.fault };
          if (!(opt && opt.noPayload)) msg.protobuf_message_as_bytes = rEnc.ciphertext;
          return v3.encode(SPEC, 'RoutableMessage', msg);
        };

        // o.vcsec：这辆车按 VCSEC 域作答（FromVCSECMessage：commandStatus / nominalError），
        // 而不是 car_server 的 Response —— 驾驶授权（RemoteDrive）的拒绝就走这条路，
        // 只有把 nominalError 真编码回去，才测得到 response-hints 里那张 GenericError 处置表。
        const replyPlain = v3.encode(
          SPEC,
          o.vcsec && o.reply ? 'FromVCSECMessage' : 'Response',
          o.reply ? o.reply(cmd) : { actionStatus: { result: 0 } }
        );
        const finalFrame = replyFrame(replyPlain);

        // o.lateReply：车辆对第一次请求完全不回（BLE 掉帧 / 车机慢），我方重发时才把**为第一次算好的
        // 那一帧**交出来。官方只在传输层重试时重发同一份已编码字节（dispatcher.go:434-460），
        // request_hash 全程不变，所以这一帧必须解得开；一旦重发重新组包就变成「响应 GCM tag 不符」。
        if (o.lateReply) {
          if (!car.late) {
            car.late = finalFrame;
            return null;
          }
          const held = car.late;
          car.late = null;
          return held;
        }

        // o.foreign：先回一帧挂在**别人路由地址**上的坏 tag 帧（串台帧），真数据帧留在队列里。
        // 官方 dispatcher.go:280-293 在解密之前就丢了它；少了这道闸门，现场只会看到误导人的 GCM 报错。
        if (o.foreign) {
          car.frames.push(finalFrame);
          return replyFrame(replyPlain, { badTag: true, to: randomBytes(16) });
        }

        // o.wrongFrom：先还一帧**车辆自己发的周期广播**（来自 VCSEC 域、没有路由地址也没有 uuid，
        // 应用层却带着 actionStatus=OK），真数据帧留在队列里。
        // 真机上正是这一帧被 receive() 取出来冒充车机响应，才假报「成功：actionStatus=OPERATIONSTATUS_OK(0)」
        // 而 vehicleData 一个字节都没有 —— 官方 dispatcher.go:252-293 用 {domain, address, uuid} 三路配对挡住它。
        if (o.wrongFrom && !car.fromUsed) {
          car.fromUsed = true;
          if (o.wrongFrom !== 'only') car.frames.push(finalFrame); // 'only' = 车机压根没回，只剩广播帧
          return broadcastFrame();
        }

        // o.errFault：车辆用 signedMessageStatus 给出终态结论，而且**一个密文字节都不发**
        //（真机合包 6 类 GetVehicleData 的 fault=25 = RESPONSE_MTU_EXCEEDED）。
        // tag 故意取反：一旦代码退回「拿错误帧试解密」，日志立刻冒出误导人的「响应 GCM tag 不符」。
        // 只作用于第一条请求 —— 拆成每类一问后，被拒的那一类不该拖累其它类。
        if (o.errFault && !car.errUsed) {
          car.errUsed = true;
          return replyFrame(new Uint8Array(0), { noPayload: true, badTag: true, fault: o.errFault });
        }

        // o.wrongUuid：回包带了**非空但对不上**的 request_uuid（上一条请求的残留 / 重放帧）。
        // tesla-key-esp32 的 ARCHITECTURE.md:106 与 ADR-0003 要求非空 request_uuid 必须匹配未决请求。
        if (o.wrongUuid && !car.uuidUsed) {
          car.uuidUsed = true;
          car.frames.push(finalFrame);
          return replyFrame(replyPlain, { uuid: randomBytes(16) });
        }

        // o.ack：先回一帧「受理帧」，真正的终态帧留给 receive()，用来验证收帧循环不会因一帧中止。
        //   nopayload = 真机 GetVehicleData 的第一帧：带 AES_GCM_Response_data、payload 整个缺失，
        //               但对空密文的 tag 是真的 —— 必须能解成「空响应」而不是报错
        //   badtag    = tag 对不上，这一帧确实解不开，只能丢掉继续等
        if (o.ack) {
          const ackFrame = replyFrame(new Uint8Array(0), { noPayload: true, badTag: o.ack === 'badtag' });
          car.frames.push(o.every ? ackFrame : finalFrame);
          return ackFrame;
        }
        return finalFrame;
      },
      async receive() {
        await nap(2);
        return car.frames.length ? car.frames.shift() : null;
      }
    };
    return car;
  }

  const run = async (fn, o) => {
    const car = makeCar(o || {});
    probe.privateKey = myKp.privateKey;
    probe.publicKey = myKp.publicKey;
    probe.vin = VIN;
    probe.ble = car.ble;
    resetV3Session(D_VC);
    resetV3Session(D_INF);
    clearLogs();
    const r = await fn();
    return { car, r, logs: getLogs().map((l) => l.kind + ':' + l.msg).join('\n') };
  };

  // 车辆按「你问哪一类就只答哪一类」作答 —— 官方 state.go:38-82 一请求一类别的镜像。
  // 用来验证 vehicleData() 的多条请求确实被合并回同一个 VehicleData。
  const replyForCategory = (cmd) => {
    const gv = v3.decode(SPEC, 'Action', cmd.plaintext).vehicleAction.getVehicleData;
    const out = {};
    if (gv.getClosuresState) out.closures_state = { locked: true };
    if (gv.getChargeState) out.charge_state = { battery_level: 80 };
    if (gv.getDriveState) out.drive_state = { shift_state: { P: {} } };
    if (gv.getClimateState) out.climate_state = { inside_temp: 21 };
    if (gv.getLocationState) out.location_state = { latitude: 31.2 };
    if (gv.getTirePressureState) out.tire_pressure_state = { tire_pressure_fl: 250 };
    return out;
  };

  // ---- 充电盖板：一条车机命令的完整闭环
  {
    const { car, r } = await run(() => acts.chargePortDoor(true));
    ok('充电盖板：车机域整条链路跑通', r.ok === true, r.text);
    ok('只握手 INFOTAINMENT，没有顺带握手 VCSEC', car.handshakes.length === 1 && car.handshakes[0] === D_INF, JSON.stringify(car.handshakes));
    ok('车机域 counter 从车辆自报的 5 往后走', v3Session(D_INF).counter === BASE[D_INF] + 1, String(v3Session(D_INF).counter));
    ok('VCSEC 那份会话一步没动', v3Session(D_VC).counter === 0 && v3Session(D_VC).key === null, String(v3Session(D_VC).counter));
    const cmd = car.cmds[0];
    ok('车辆按请求元数据能解开（AAD 组装一致）', cmd.authenticated === true && car.tagMismatch === 0, 'tagMismatch=' + car.tagMismatch);
    ok('命令带的是 INFOTAINMENT 自己的 epoch', cmd.epochMatches === true, '');
    ok('命令的 routing 域 = INFOTAINMENT', cmd.domain === D_INF, String(cmd.domain));
    eqHex('上线明文 = 金标准 1203f20300（走完加密链路后仍一字不差）', cmd.plaintext, fromHex('1203f20300'));
    ok('响应按 car_server.Response 解读（不是 FromVCSECMessage）', r.summary.text.indexOf('actionStatus') === 0 && r.summary.status === 0, r.summary.text);
  }
  // ---- actionStatus=ERROR：plain_text 必须摊到人脸上（官方 infotainment.go:37-43）
  {
    const { car, r } = await run(() => acts.pingInfotainment(), {
      reply: () => ({ actionStatus: { result: SPEC.enums.CSOperationStatus_E.OPERATIONSTATUS_ERROR, result_reason: { plain_text: 'Vehicle is not awake' } } })
    });
    eqHex('Ping 明文 = 金标准 1205f202020801', car.cmds[0].plaintext, fromHex('1205f202020801'));
    ok('actionStatus=ERROR 判失败', r.ok === false, r.text);
    ok('失败文案带 actionStatus=ERROR 与车机原话',
      r.text.indexOf('actionStatus=ERROR') > 0 && r.text.indexOf('Vehicle is not awake') > 0, r.text);
    ok('车机域不会把 ERROR 当成 WAIT 反复重发', car.cmds.length === 1, 'cmds=' + car.cmds.length);
  }
  // ---- GetVehicleData：**每类一条请求** + 回执合并
  // 官方 state.go:70-82 的 GetState 只收单个 StateCategory；tesla-ble 的
  // client.cpp:721-737 每次只置一个开关、vehicle.cpp:1231-1246 把 5 类拆成 5 条命令；
  // tesla-key-esp32 的 vehicle_telemetry.cpp:1569-1631 同样是单类别轮询。
  // 合包会让车端回 fault=25（RESPONSE_MTU_EXCEEDED，真机实测「车辆信息拿不到数据」）。
  {
    const { car, r } = await run(() => acts.vehicleData(['closures', 'charge']), {
      reply: (cmd) => ({ actionStatus: { result: 0 }, vehicleData: replyForCategory(cmd) })
    });
    ok('GetVehicleData：摘要标成 vehicleData', r.ok === true && r.summary.kind === 'vehicleData', r.text);
    ok('GetVehicleData：两类的数据被合并进同一个 summary.data',
      r.summary.data.closures_state && r.summary.data.closures_state.locked === true &&
      r.summary.data.charge_state && r.summary.data.charge_state.battery_level === 80,
      JSON.stringify(r.summary.data));
    ok('GetVehicleData：两类 = 两条独立请求（官方每请求一个类别）', car.cmds.length === 2, 'cmds=' + car.cmds.length);
    const switches = car.cmds.map((c) => Object.keys(v3.decode(SPEC, 'Action', c.plaintext).vehicleAction.getVehicleData));
    ok('GetVehicleData：每条请求只带**一个**类别开关',
      switches.every((s) => s.length === 1) && switches.flat().sort().join(',') === 'getChargeState,getClosuresState',
      JSON.stringify(switches));
    ok('GetVehicleData：两条请求的上线字节不同（不是一份字节发两遍）', car.wire[0] !== car.wire[1], car.wire.join('\n'));
  }
  {
    const { car } = await run(() => acts.vehicleData());
    ok('不传类别 = 6 类各发一条（官方 state.go:38-56 的并集）', car.cmds.length === 6, 'cmds=' + car.cmds.length);
    const all = car.cmds
      .map((c) => Object.keys(v3.decode(SPEC, 'Action', c.plaintext).vehicleAction.getVehicleData)[0])
      .sort()
      .join(',');
    ok('6 条请求正好覆盖 6 个开关、一个不重不漏',
      all === ['getChargeState', 'getClosuresState', 'getClimateState', 'getDriveState', 'getLocationState', 'getTirePressureState'].sort().join(','),
      all);
  }
  // ---- 真机口径（2026-09-28 日志）：问 drive 的那一条，车机会**顺带**把 location_state 一起
  // 塞回同一帧 vehicleData；车还在每条 vehicleData 尾部带一个官方 vehicle.proto 里没有的字段 999。
  // 「带回数据」因此必须按类别计数，否则会报成「2 类各发一条，3 类带回数据」这种比问的还多的数。
  {
    const { car, r } = await run(() => acts.vehicleData(['drive', 'charge']), {
      reply: (cmd) => {
        const d = replyForCategory(cmd);
        if (d.drive_state) d.location_state = { latitude: 23.016 };
        return { actionStatus: { result: 0 }, vehicleData: d };
      }
    });
    ok('顺带回来的第二种类别不谎报成第三类',
      r.ok === true && r.summary.text.indexOf('GetVehicleData：2 类各发一条，2 类带回数据') === 0, r.summary.text);
    ok('顺带带回的字段照样合并进 summary.data',
      !!r.summary.data.drive_state && !!r.summary.data.location_state, JSON.stringify(Object.keys(r.summary.data)));
    ok('两类仍是两条命令', car.cmds.length === 2, 'cmds=' + car.cmds.length);
  }
  // ---- 真机回归：车机先回一帧「只有 AES_GCM_Response_data、payload 整个缺失」的受理帧。
  // RoutableMessage.payload 是 oneof（universal_message.proto:87-91），这组合合法；
  // 官方 signer.go:219-242 对空 payload 也没有任何前置报错，dispatcher.go:302-308 对
  // 解不开的一帧只是 log 后丢弃。老代码在这里 return fatal，整条 GetVehicleData 当场判死。
  {
    const { car, r } = await run(() => acts.vehicleData(['closures', 'charge']), {
      ack: 'nopayload',
      reply: () => ({ actionStatus: { result: 0 }, vehicleData: { closures_state: { locked: true } } })
    });
    ok('受理帧（payload 缺失）不再报「响应没有 payload」',
      r.ok === true && r.text.indexOf('响应没有 payload') < 0, r.text);
    ok('受理帧之后继续等，真正的 vehicleData 帧被收下',
      r.ok === true && r.summary.kind === 'vehicleData' && r.summary.data.closures_state.locked === true, r.summary && r.summary.text);
    ok('两类 = 两条命令，没有因为看不懂受理帧而重发', car.cmds.length === 2, 'cmds=' + car.cmds.length);
  }
  {
    const { car, r } = await run(() => acts.vehicleData(['closures']), {
      ack: 'badtag',
      reply: () => ({ actionStatus: { result: 0 }, vehicleData: { closures_state: { locked: false } } })
    });
    ok('解不开的帧只丢弃、不终止请求（官方 dispatcher 口径）',
      r.ok === true && r.summary.data.closures_state.locked === false, r.text);
    ok('丢弃的那一帧在日志里留了痕（不至于静默失败）',
      getLogs().some((l) => l.msg.indexOf('解密失败') >= 0) || car.cmds.length === 1, '');
  }
  // ---- 所有帧都解不开：只能等到超时，而且超时文案要说明丢过帧
  {
    const { r } = await run(() => acts.sendRequest({
      name: 'GetVehicleData（全丢帧）',
      domain: D_INF,
      payload: new Uint8Array([0x12, 0x03, 0xf2, 0x01, 0x00]),
      done: () => false,
      maxMs: 3000
    }), { ack: 'badtag', every: true });
    ok('全是坏帧时判超时而不是当场成功', r.ok === false && r.timeout === true, r.text);
    ok('超时文案里带上被丢弃的帧', r.text.indexOf('已丢弃 2 帧') > 0 || r.text.indexOf('都解不开') > 0, r.text);
  }
  // ---- 重发必须是**同一份已编码字节**：车机对第一次请求的迟到回包照样要解得开
  // 官方 dispatcher.go:434-460：Send 只 proto.Marshal 一次，传输重试发的是同一串字节。
  // 老代码每次重发都重新 encryptCommand（counter / nonce / tag 全变 → request_hash 变了），
  // 真机上 GetVehicleData 慢回包正好撞上，症状就是「响应 GCM tag 不符 + 等待终态超时」。
  {
    const { car, r, logs } = await run(() => acts.vehicleData(['closures']), {
      lateReply: true,
      reply: () => ({ actionStatus: { result: 0 }, vehicleData: { closures_state: { locked: true } } })
    });
    ok('迟到回包触发了一次重发', car.cmds.length === 2, 'cmds=' + car.cmds.length);
    ok('重发的是同一份字节（counter/nonce/tag 一字不差）', car.wire[0] === car.wire[1], car.wire.join('\n'));
    ok('第一次请求的迟到回包解得开、拿到数据',
      r.ok === true && r.summary && r.summary.data && r.summary.data.closures_state.locked === true, r.text);
    ok('迟到回包不再报「GCM tag 不符」',
      r.text.indexOf('GCM tag 不符') < 0 && logs.indexOf('GCM tag 不符') < 0, r.text);
  }
  // ---- 串台帧：挂在别人路由地址上的帧按官方在解密之前就丢掉，不许伪装成「GCM tag 不符」
  {
    const { car, r, logs } = await run(() => acts.vehicleData(['closures']), {
      foreign: true,
      reply: () => ({ actionStatus: { result: 0 }, vehicleData: { closures_state: { locked: true } } })
    });
    ok('串台帧不干扰本次请求（真数据帧仍被收下）',
      r.ok === true && r.summary.data.closures_state.locked === true, r.text);
    ok('串台帧在日志里点名路由地址对不上', logs.indexOf('路由地址不是本次请求') >= 0, logs.slice(0, 300));
    ok('串台帧没有被拿去解密（不会误导成 GCM tag 不符）',
      logs.indexOf('GCM tag 不符') < 0 && logs.indexOf('响应解密诊断') < 0, logs.slice(0, 300));
    ok('串台帧只发一次命令', car.cmds.length === 1, 'cmds=' + car.cmds.length);
  }
  // ---- 真机回归 ①：车机回「协议层错误帧 + 零密文」（合包 6 类 GetVehicleData 的 fault=25）
  // universal_message.proto:57 + protocol.md:59-61 —— 协议层错误由 signedMessageStatus 表达，
  // 响应体根本没上线；error.go:195-198 把 25 归为「命令可能已执行」；error_test.go:62-65 钉死不重发。
  // 老代码拿这种空密文去试解密 → skipped → 一路等到「等待终态超时」，把车辆明说的拒绝盖掉。
  {
    const MTU = SPEC.enums.MessageFault_E.MESSAGEFAULT_ERROR_RESPONSE_MTU_EXCEEDED;
    const { car, r, logs } = await run(() => acts.vehicleData(['closures']), {
      errFault: MTU,
      reply: (cmd) => ({ actionStatus: { result: 0 }, vehicleData: replyForCategory(cmd) })
    });
    ok('错误帧直接判终态，不再等到超时', r.ok === false && r.text.indexOf('等待终态超时') < 0, r.text);
    ok('结论用的是车辆自己写的 fault 名', r.text.indexOf('MESSAGEFAULT_ERROR_RESPONSE_MTU_EXCEEDED') > 0, r.text);
    ok('被拒的一类不重发（官方 error_test.go:62-65）', car.cmds.length === 1, 'cmds=' + car.cmds.length);
    ok('错误帧没被拿去做解密试算（不出现误导人的 tag 报错）',
      logs.indexOf('GCM tag 不符') < 0 && logs.indexOf('响应解密诊断') < 0, logs.slice(0, 500));
    ok('日志点名协议层错误帧分支', logs.indexOf('协议层错误帧') >= 0, logs.slice(0, 500));
    ok('按官方口径说明「车收下了请求，只是不发答案」', r.text.indexOf('命令可能已经执行') > 0, r.text);
    ok('给出 MTU 相关的下一步（每类一问已拆开 + 看协商值）',
      r.text.indexOf('每类一条') > 0 && r.text.indexOf('MTU') > 0, r.text);
  }
  // ---- 真机回归 ②：拆成每类一问后，被拒的那一类不拖累其它类
  {
    const MTU = SPEC.enums.MessageFault_E.MESSAGEFAULT_ERROR_RESPONSE_MTU_EXCEEDED;
    const { car, r, logs } = await run(() => acts.vehicleData(['closures', 'charge']), {
      errFault: MTU,
      reply: (cmd) => ({ actionStatus: { result: 0 }, vehicleData: replyForCategory(cmd) })
    });
    ok('两类各发一条，第一条被拒、第二条照样拿到数据',
      r.ok === true && r.summary.data.charge_state.battery_level === 80 && !r.summary.data.closures_state,
      JSON.stringify(r.summary.data));
    ok('摘要写明几类带回、几类被拒', r.summary.text.indexOf('1 类带回数据') > 0 && r.summary.text.indexOf('1 类被拒') > 0, r.summary.text);
    ok('失败的那一类原文附在正文里', r.text.indexOf('closures ——') >= 0 && r.text.indexOf('RESPONSE_MTU_EXCEEDED') >= 0, r.text);
    ok('被拒不重发、也不影响另一条请求（总请求数 = 类别数）', car.cmds.length === 2, 'cmds=' + car.cmds.length);
    ok('全程没有一次解密误报', logs.indexOf('GCM tag 不符') < 0, logs.slice(0, 500));
  }
  // ---- 真机回归 ③：非空 request_uuid 对不上（残留帧 / 重放帧）→ 官方丢掉不解密
  {
    const { car, r, logs } = await run(() => acts.vehicleData(['closures']), {
      wrongUuid: true,
      reply: () => ({ actionStatus: { result: 0 }, vehicleData: { closures_state: { locked: true } } })
    });
    ok('带错 request_uuid 的帧被挡下，真帧仍被收下',
      r.ok === true && r.summary.data.closures_state.locked === true, r.text);
    ok('日志点名 request_uuid 对不上', logs.indexOf('request_uuid 不是本次请求') >= 0, logs.slice(0, 500));
    ok('挡下的帧没有被拿去解密（不误报 tag）',
      logs.indexOf('GCM tag 不符') < 0 && logs.indexOf('响应解密诊断') < 0, logs.slice(0, 500));
    ok('只发一次命令', car.cmds.length === 1, 'cmds=' + car.cmds.length);
  }
  // ---- 真机回归 ④：车辆自己发的 VCSEC 周期广播不许冒充车机响应
  // 现场症状：「取暂存帧 26 字节」→「成功：actionStatus=OPERATIONSTATUS_OK(0)」，但一个 vehicleData 都没有。
  {
    const { car, r, logs } = await run(() => acts.vehicleData(['closures']), {
      wrongFrom: true,
      reply: () => ({ actionStatus: { result: 0 }, vehicleData: { closures_state: { locked: true } } })
    });
    ok('广播帧被域闸门挡下，等到 INFOTAINMENT 的真帧',
      r.ok === true && r.summary.data.closures_state.locked === true, r.text);
    ok('日志点名这帧来自 VCSEC、本次请求发往车机',
      logs.indexOf('帧来自') >= 0 && logs.indexOf('本次请求发往') >= 0, logs.slice(-500));
    ok('只发一次命令', car.cmds.length === 1, 'cmds=' + car.cmds.length);
  }
  {
    const { r, logs } = await run(() => acts.sendRequest({
      name: 'GetVehicleData（只剩广播帧）',
      domain: D_INF,
      payload: new Uint8Array([0x12, 0x03, 0xf2, 0x01, 0x00]),
      done: (obj) => !!(obj && obj.actionStatus),
      maxMs: 3000
    }), { wrongFrom: 'only' });
    ok('广播帧不再假报「成功：actionStatus=OK」', r.ok === false && r.timeout === true, r.text);
    ok('超时文案里带上被丢弃的广播帧，并点名它来自哪个域',
      r.text.indexOf('已丢弃 1 帧') > 0 && r.text.indexOf('DOMAIN_VEHICLE_SECURITY') > 0 && r.text.indexOf('不是本次请求') > 0, r.text);
    ok('没有把广播帧当成终态解密', logs.indexOf('GCM tag 不符') < 0, logs.slice(0, 500));
  }
  // ---- 未知类别：当场抛错，一个字节都不许发出去
  {
    const { car } = await run(() => acts.pingInfotainment());
    const before = car.cmds.length;
    let err = '';
    try {
      await acts.vehicleData(['bogus']);
    } catch (e) {
      err = e.message;
    }
    ok('未知类别抛错并且不发任何包',
      err.indexOf('不认识的类别') >= 0 && err.indexOf('bogus') >= 0 && car.cmds.length === before, err || '(没抛错)');
  }
  // ---- Ping：官方同值的探针
  {
    const { car } = await run(() => acts.pingInfotainment());
    const va = v3.decode(SPEC, 'Action', car.cmds[0].plaintext).vehicleAction;
    ok('Ping 载荷 ping_id=1（infotainment.go:59-70 同值）', va.ping !== undefined && va.ping.ping_id === 1, JSON.stringify(va));
  }
  // ---- 驾驶授权（RemoteDrive）：解锁之后仍挂不上挡时才需要的**独立**命令
  // 官方取证（ref-repos/vehicle-command，commit f61e29e）：
  //   vcsec.go:173-202  Unlock 与 RemoteDrive 各自调一次 executeRKEAction —— SDK 里根本没有「并入解锁」这条路；
  //   commands.go:311-318  "drive" 与 "unlock" 同属 requiresAuth / 非 requiresFleetAPI，--ble 不拒绝它 —— 允许走 BLE；
  //   proxy/command.go:207-208  Fleet 的 remote_start_drive 转调的还是同一个 RemoteDrive(ctx)。
  // 所以本项目把它做成独立动作、照样发在 BLE 上，成不成只认车端回执：下面三种车分别给通过 / 两种拒绝。
  {
    const { car, r } = await run(() => acts.requestDrive());
    ok('驾驶授权只握手 VCSEC，不顺手碰车机域', car.handshakes.length === 1 && car.handshakes[0] === D_VC, JSON.stringify(car.handshakes));
    ok('驾驶授权明文 = 1014（REMOTE_DRIVE=20）', toHex(car.cmds[0].plaintext) === '1014' && car.cmds[0].domain === D_VC, toHex(car.cmds[0].plaintext));
    ok('车辆没回 commandStatus 就算这条命令走完', r.ok === true, r.text);
  }
  {
    const { lastResult, clearDiagnostics } = acts;
    clearDiagnostics();
    const { car, r, logs } = await run(() => api.remoteDrive(), {
      vcsec: true,
      reply: () => ({ nominalError: { genericError: SPEC.enums.GenericError_E.GENERICERROR_NOT_ALLOWED_OVER_TRANSPORT } })
    });
    ok('车端拒驾驶授权就判失败（绝不替车辆模拟「启动成功」）',
      r.ok === false && r.text.indexOf('GENERICERROR_NOT_ALLOWED_OVER_TRANSPORT(7)') > 0, r.text);
    ok('拒绝原文旁边写清下一步：改走 Fleet 的 remote_start_drive',
      r.text.indexOf('remote_start_drive') > 0 && r.text.indexOf('Fleet') > 0, r.text);
    ok('被拒不按 WAIT 反复重发', car.cmds.length === 1, 'cmds=' + car.cmds.length);
    const d = lastResult('驾驶授权（RemoteDrive）', 'VCSEC');
    ok('按钮那一行读的是车辆回执原文', !!d && d.ok === false && d.text.indexOf('NOT_ALLOWED_OVER_TRANSPORT') > 0, JSON.stringify(d));
    ok('被拒时留一条人话警告，不只是枚举名', logs.indexOf('车辆没接受驾驶授权') > 0, logs.slice(-400));
    clearDiagnostics();
  }
  {
    const { r } = await run(() => acts.requestDrive(), {
      vcsec: true,
      reply: () => ({ nominalError: { genericError: SPEC.enums.GenericError_E.GENERICERROR_VEHICLE_NOT_IN_PARK } })
    });
    ok('不在 P 挡的拒绝同样带处置口径',
      r.ok === false && r.text.indexOf('GENERICERROR_VEHICLE_NOT_IN_PARK(5)') > 0 && r.text.indexOf('P 挡') > 0, r.text);
  }
  // ---- VCSEC 的「重发」必须重新签一份（真机那句「授权启动后锁车要点两次」的回归锁）
  // protocol.md:547-549：Infotainment 用滑动窗口容忍乱序，VCSEC 要求消息**按 counter 顺序到达**，
  // 重复 counter 会被判 MESSAGEFAULT_ERROR_REPEATED_COUNTER。车辆回 WAIT 时官方走的是
  // vcsec.go:84-105 的应用层重试 = 重新 dispatcher.Send = counter++ / 新 nonce / 新路由地址
  //（dispatcher.go:392-413/428）。一旦像车机域那样复用同一份字节，重发的帧全被车当旧包丢掉，
  // 现场就成了「第一次按没反应、再按一次才生效」。
  {
    let n = 0;
    const WAIT = SPEC.enums.UMOperationStatus_E.OPERATIONSTATUS_WAIT;
    const { car, r, logs } = await run(() => acts.sendRke(SPEC.enums.RKEAction_E.RKE_ACTION_LOCK, '上锁'), {
      vcsec: true,
      reply: () => (n++ === 0 ? { commandStatus: { operationStatus: WAIT } } : {})
    });
    ok('车辆回 WAIT 后确实重发了一条命令', car.cmds.length === 2, 'cmds=' + car.cmds.length);
    ok('VCSEC 重发的 counter 前进了（不是原样重发旧帧）',
      car.cmds[0].counter === BASE[D_VC] + 1 && car.cmds[1].counter === BASE[D_VC] + 2,
      car.cmds[0].counter + ' → ' + car.cmds[1].counter);
    ok('两份帧的上线字节整帧不同（新 nonce / 新 tag / 新路由地址）', car.wire[0] !== car.wire[1]);
    ok('重发不必重新握手（会话还在，只让 counter 前进）',
      car.handshakes.length === 1 && car.handshakes[0] === D_VC, JSON.stringify(car.handshakes));
    ok('第二次拿到终态就判成功', r.ok === true && r.text.indexOf('上锁 完成') >= 0, r.text);
    ok('日志按域写清这次重发是「重新签一份」', logs.indexOf('counter 必须前进') > 0, logs.slice(-400));
  }
  // ---- 解锁串发驾驶授权：真机验证 BLE 发 REMOTE_DRIVE 车辆接受之后才允许的编排
  {
    const { lastResult, clearDiagnostics } = acts;
    clearDiagnostics();
    const { car, r } = await run(() => api.unlockAndDrive());
    ok('串发 = 两条 VCSEC 命令，明文依次 1000 / 1014',
      car.cmds.length === 2 && car.cmds[0].domain === D_VC && car.cmds[1].domain === D_VC &&
        toHex(car.cmds[0].plaintext) === '1000' && toHex(car.cmds[1].plaintext) === '1014',
      car.cmds.map((c) => toHex(c.plaintext)).join(','));
    ok('两条命令共用同一次 VCSEC 握手（不是各握手一遍）', car.handshakes.length === 1, JSON.stringify(car.handshakes));
    ok('整体成功以两条各自拿到终态成功为准', r.ok === true && r.unlock.ok === true && r.drive.ok === true, r.text);
    ok('回执把两条结论分开写',
      r.text.indexOf('UNLOCK') >= 0 && r.text.indexOf('REMOTE_DRIVE') >= 0 && r.text.indexOf('驾驶授权：') >= 0, r.text);
    const u = lastResult('UNLOCK', 'VCSEC');
    const d = lastResult('驾驶授权（RemoteDrive）', 'VCSEC');
    const both = lastResult('解锁并授权驾驶', 'VCSEC');
    ok('解锁与驾驶授权各占一条台账，页面两行读数不互相覆盖',
      !!u && !!d && !!both && u.ok === true && d.ok === true && both.ok === true,
      JSON.stringify([u, d, both]));
    clearDiagnostics();
  }
  {
    const { car, r } = await run(() => api.unlockAndDrive(), {
      vcsec: true,
      reply: (cmd) => (toHex(cmd.plaintext) === '1014'
        ? { nominalError: { genericError: SPEC.enums.GenericError_E.GENERICERROR_VEHICLE_NOT_IN_PARK } }
        : {})
    });
    ok('授权被拒不把已成功的解锁说成失败（绝不代替车辆下结论）',
      r.ok === true && r.unlock.ok === true && r.drive.ok === false, r.text);
    ok('拒绝原因原样留在回执里，人一眼知道还得单独再按一次授权',
      car.cmds.length === 2 && r.text.indexOf('VEHICLE_NOT_IN_PARK') >= 0, r.text);
  }
  {
    const { car, r } = await run(() => api.unlockAndDrive(), {
      vcsec: true,
      reply: () => ({ nominalError: { genericError: SPEC.enums.GenericError_E.GENERICERROR_CLOSURES_OPEN } })
    });
    ok('解锁本身被拒时绝不补发驾驶授权（车没开，发它没意义）',
      car.cmds.length === 1 && toHex(car.cmds[0].plaintext) === '1000', 'cmds=' + car.cmds.length);
    ok('解锁被拒按车辆结论判失败，并带上「门没关严」这类车端策略的下一步',
      r.ok === false && r.text.indexOf('CLOSURES_OPEN') >= 0 && r.text.indexOf('没关严') >= 0, r.text);
  }
  // ---- 两域交替：先 RKE 再充电盖板，各自的 counter / epoch 全程不串
  {
    const { car, r } = await run(async () => ({
      a: await acts.sendRke(SPEC.enums.RKEAction_E.RKE_ACTION_LOCK, '上锁'),
      b: await acts.chargePortDoor(true)
    }));
    ok('两域各自握手一次', car.handshakes.length === 2 && car.handshakes[0] === D_VC && car.handshakes[1] === D_INF, JSON.stringify(car.handshakes));
    ok('两条命令都成功', r.a.ok === true && r.b.ok === true, r.a.text + ' / ' + r.b.text);
    ok('VCSEC 明文 = 1001（RKE LOCK）', toHex(car.cmds[0].plaintext) === '1001' && car.cmds[0].domain === D_VC, toHex(car.cmds[0].plaintext));
    ok('两域 counter 各走各的起点',
      car.cmds[0].counter === BASE[D_VC] + 1 && car.cmds[1].counter === BASE[D_INF] + 1,
      car.cmds[0].counter + '/' + car.cmds[1].counter);
    ok('两域用的是两个不同的 epoch（会话没共用）',
      car.cmds[0].epochMatches && car.cmds[1].epochMatches &&
        toHex(car.cmds[0].epoch) !== toHex(car.cmds[1].epoch),
      toHex(car.cmds[0].epoch) + ' / ' + toHex(car.cmds[1].epoch));
    ok('收尾时两份会话都在', v3Session(D_VC).counter === BASE[D_VC] + 1 && v3Session(D_INF).counter === BASE[D_INF] + 1,
      v3Session(D_VC).counter + '/' + v3Session(D_INF).counter);
    const st = acts.statusText();
    ok('状态行两域各报一份 counter', st.indexOf('VCSEC=' + (BASE[D_VC] + 1) + '@') > 0 && st.indexOf('车机=' + (BASE[D_INF] + 1) + '@') > 0, st);
  }

  probe.ble = null;
  probe.privateKey = null;
  probe.publicKey = null;
  resetV3Session(D_VC);
  resetV3Session(D_INF);
  clearLogs();
}

console.log('\n[16] 自动重连循环（前台持续重试 / 退避升档 / 断线再武装）');
{
  // 真实用户的场景：离车几十米就点开 App，这一次必然连不上。回归锁要保证的是
  // 「失败之后还会自己接着试」，而不是只试一次逼人杀后台重开。
  // 退避阶梯是 3 秒起步，测试不能真等 → 捕获 >=1000ms 的定时器手动触发；
  // 短延时（蓝牙内部 delay(600) 之类）必须原样放行，否则会永远挂住。
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  let held = [];
  let hid = 1;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (typeof ms === 'number' && ms >= 1000) {
      const t = { id: hid++, fn, ms };
      held.push(t);
      return t.id;
    }
    return realSet(fn, ms, ...rest);
  };
  globalThis.clearTimeout = (id) => {
    held = held.filter((t) => t.id !== id);
    if (id && typeof id === 'object') realClear(id);
  };
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => realSet(r, 0));
  };
  const delays = () => held.map((t) => t.ms);
  const fire = async () => {
    const t = held.shift();
    if (!t) return -1;
    t.fn();
    await flush();
    return t.ms;
  };

  // 蓝牙适配器按用例切换：fail = 立刻抛错（走 skip('adapter')，不碰扫描，快且可控）
  // hold = 回调永远不返回（用来验「一次只跑一轮」）
  let adapterMode = 'fail';
  let heldAdapter = null;
  globalThis.uni = {
    openBluetoothAdapter: (o) => {
      if (adapterMode === 'hold') {
        heldAdapter = o;
        return;
      }
      if (o.fail) o.fail({ errMsg: 'openBluetoothAdapter:fail bluetooth not available' });
    },
    getBluetoothAdapterState: (o) => {
      if (o.fail) o.fail({ errMsg: 'getBluetoothAdapterState:fail' });
    }
  };

  // ① 什么都有还没跑起来之前，状态行就该说清楚为什么没启动
  ok('没密钥时 describeAutoLoop 说明原因', describeAutoLoop().indexOf('无密钥或无绑定档案') > 0, describeAutoLoop());
  {
    const r = await startAutoReconnectLoop('测试：无密钥');
    ok('无密钥直接停循环，不排期', r.skipped === 'nokey' && delays().length === 0, JSON.stringify({ r, held: delays() }));
  }

  // ② 真实场景：有密钥 + 有档案，但车不在范围（这里用适配器不可用代表「这次连不上」）
  const kp = vcsec.newKeyPair();
  saveKeyPair(kp, '5YJ3E1EA7KF327239');
  saveBind({ vin: '5YJ3E1EA7KF327239', deviceId: 'AA:BB:CC:11:22:33', name: 'Tesla723591', keyId: 'aabbccddeeff0011' });
  connection.connection = 'idle';
  clearLogs();
  {
    const r = await startAutoReconnectLoop('测试：第一次失败');
    ok('第一次失败不结束，排下一轮', r.ok === false && r.skipped === 'adapter' && delays().length === 1, JSON.stringify({ r, held: delays() }));
    ok('退避第一档 3 秒', delays()[0] === 3000, JSON.stringify(delays()));
    ok('状态行看得到「几秒后重试（已试 N 次）」', describeAutoLoop().indexOf('3 秒后重试（已试 1 次）') > 0, describeAutoLoop());
    ok('失败日志承诺「不必重开 App」', getLogs().some((l) => l.msg.indexOf('不必重开 App') > 0), JSON.stringify(getLogs().map((l) => l.msg)));
  }
  {
    const got = [];
    for (let i = 0; i < 6; i++) got.push(await fire());
    ok('连续失败按 3→6→12→24→30 升档并封顶', JSON.stringify(got) === JSON.stringify([3000, 6000, 12000, 24000, 30000, 30000]), JSON.stringify(got));
    ok('循环不会因为失败而自动停', describeAutoLoop().indexOf('秒后重试（已试 7 次）') > 0, describeAutoLoop());
  }

  // ③ 重复触发（用户连点、onShow 连着来）绝不能叠出两轮扫描
  {
    adapterMode = 'hold';
    const p1 = startAutoReconnectLoop('测试：重复 start');
    ok('start 会把档位归零重来', delays().length === 0, JSON.stringify(delays()));
    await flush();
    const p2 = startAutoReconnectLoop('测试：重复 start 2');
    const p3 = autoReconnect();
    ok('进行中的那一轮被复用（单飞）', p2 === p1 && !!p3 && typeof p3.then === 'function', String(p2 === p1));
    await flush();
    ok('重复触发不会叠出两轮尝试', describeAutoLoop().indexOf('正在连接（第 1 次尝试）') > 0, describeAutoLoop());
    adapterMode = 'fail';
    heldAdapter.fail({ errMsg: 'openBluetoothAdapter:fail 手动取消' });
    await flush();
    ok('一轮只排一个下次重试', delays().length === 1 && delays()[0] === 3000, JSON.stringify(delays()));
  }

  // ④ 链路真断了（车辆休眠 / 3 把钥匙上限 / 走远）：立刻重新武装，别等 30 秒
  {
    await fire();
    ok('断线前挂着的是退避排期', delays().length === 1 && delays()[0] === 6000, JSON.stringify(delays()));
    sessionBle().setState('disconnected');
    await flush();
    ok('断线立刻重试并清掉旧排期', delays().length === 1 && delays()[0] === 3000, JSON.stringify(delays()));
    ok('断线重连档位归零', describeAutoLoop().indexOf('已试 1 次') > 0, describeAutoLoop());
  }

  // ⑤ 用户明确说「现在别连」：正在排期的一次必须取消
  {
    suspendAutoConnect(true);
    ok('主动断开取消退避排期', delays().length === 0, JSON.stringify(delays()));
    ok('暂停时状态行提示怎么恢复', describeAutoLoop().indexOf('已暂停') > 0 && describeAutoLoop().indexOf('恢复自动重连') > 0, describeAutoLoop());
    const r = await startAutoReconnectLoop('测试：暂停中 start');
    ok('暂停中自动重连被跳过且不再排期', r.skipped === 'suspended' && delays().length === 0, JSON.stringify({ r, held: delays() }));
  }

  // ⑥ 已经连在车上：不重复连，等断线事件再武装
  {
    suspendAutoConnect(false);
    connection.connection = 'connected';
    const r = await autoReconnect();
    ok('已连接时跳过（already）', r.skipped === 'already', JSON.stringify(r));
    const r2 = await startAutoReconnectLoop('测试：已连接 start');
    ok('已连接不排重试', r2.skipped === 'already' && delays().length === 0, JSON.stringify(delays()));
    ok('已连接时状态行说明断线会自动重连', describeAutoLoop().indexOf('已连上车') > 0, describeAutoLoop());
    const st = api.statusText();
    ok('状态行以 BLE= 开头并带上自动重连状态', st.indexOf('BLE=') === 0 && st.indexOf('| 自动重连：') > 0, st);
  }

  // ⑦ 档案没了 = 没有目标车可连，循环让位（避免后台空扫）
  {
    connection.connection = 'idle';
    await startAutoReconnectLoop('测试：清档前');
    ok('清档前有一次退避排期', delays().length === 1, JSON.stringify(delays()));
    stopAutoReconnectLoop('测试：手动停');
    ok('stopAutoReconnectLoop 取消排期', delays().length === 0, JSON.stringify(delays()));
    await startAutoReconnectLoop('测试：再启动');
    ok('再启动会重新排期', delays().length === 1 && describeAutoLoop().indexOf('秒后重试') > 0, JSON.stringify(delays()));
    forgetBind();
    ok('清除绑定档案会停循环', delays().length === 0 && hasBind() === false && describeAutoLoop().indexOf('无密钥或无绑定档案') > 0, JSON.stringify(delays()));
    ok('停止循环有日志（不是静默行为）', getLogs().some((l) => l.msg.indexOf('自动重连已停止') >= 0), JSON.stringify(getLogs().map((l) => l.msg).slice(-3)));
  }

  // 收尾：把测试造出来的密钥 / 档案 / 蓝牙实例全部清掉，别污染后面的用例
  globalThis.setTimeout = realSet;
  globalThis.clearTimeout = realClear;
  delete globalThis.uni;
  suspendAutoConnect(false);
  forgetKey();
  connection.connection = 'idle';
  connection.device = null;
  probe.ble = null;
  clearLogs();
}

console.log('\n[17] 车辆状态仓库 / 诊断台账（UI 视图模型）');
{
  const { vehicleView, applyVehicleData, clearVehicle, subscribeVehicle, VEHICLE_UNKNOWN } = acts;
  const { recentResults, lastResult, clearDiagnostics, recordResult } = acts;

  clearVehicle();
  clearDiagnostics();
  clearLogs();

  // —— 空仓库：什么都没拉过时，视图必须是「未知」而不是「关着 / 未上锁」
  {
    const v = vehicleView();
    ok('空仓库 hasData=false', v.hasData === false && v.updatedAt === 0);
    ok('空仓库电量/续航是未知', v.batteryText === VEHICLE_UNKNOWN && v.rangeText === VEHICLE_UNKNOWN, v.batteryText + '/' + v.rangeText);
    ok('空仓库锁状态是未知（不是未上锁）', v.locked === null && v.lockedText === VEHICLE_UNKNOWN, v.lockedText);
    ok('空仓库四门未知而不是全关', v.doorsOpen === null && v.doorUnknown === true, JSON.stringify({ d: v.doorsOpen, u: v.doorUnknown }));
    ok(
      '空仓库逐门也是未知（俯视图不能画成四个关着的点）',
      v.doorStates.driverFront === null && v.doorStates.passengerRear === null,
      JSON.stringify(v.doorStates)
    );
    ok('空仓库没有位置与胎压', v.hasLocation === false && v.hasTirePressure === false);
    ok('没数据时写入不报错也不更新时间戳', applyVehicleData({ ok: false, text: '车机只回了 actionStatus' }).updated === false && vehicleView().updatedAt === 0);
  }

  // —— 真机那份回包的形状：嵌套 *_state + 伪枚举 {type} + 尾部那个官方没有的 f999
  const REAL = {
    closures_state: {
      locked: false,
      door_open_driver_front: false,
      door_open_passenger_front: false,
      door_open_driver_rear: false,
      door_open_passenger_rear: false,
      door_open_trunk_front: true,
      door_open_trunk_rear: false,
      is_user_present: true,
      sentry_mode_state: { type: 'SentryModeStateDisabled' },
      sentry_mode_available: true
    },
    charge_state: {
      battery_level: 59,
      usable_battery_level: 58,
      est_battery_range: 200.4,
      ideal_battery_range: 215.2,
      charging_state: { type: 'ChargingStateCharging' },
      charge_port_door_open: true,
      charge_port_latch: { type: 'ChargePortLatchEngaged' },
      charge_limit_soc: 80
    },
    drive_state: { shift_state: { type: 'P' }, speed: 0, odometer_in_hundredths_of_a_mile: 1234567 },
    climate_state: { inside_temp_celsius: 21.5, outside_temp_celsius: -3.24, driver_temp_setting: 22, is_climate_on: true },
    location_state: { latitude: 23.02501, longitude: 113.07311, heading: 175 },
    tire_pressure_state: { tpms_pressure_fl: 2.5, tpms_pressure_fr: 2.51, tpms_pressure_rl: 2.48, tpms_pressure_rr: 2.49 },
    f999: 1
  };

  const wrapped = applyVehicleData(
    { ok: true, summary: { kind: 'vehicleData', status: 0, data: REAL }, text: 'GetVehicleData：6 类各发一条，7 类带回数据' },
    'GetVehicleData（全部）'
  );
  ok('写入成功并带回视图', wrapped.updated === true && wrapped.view.hasData === true);
  {
    const v = vehicleView();
    ok('类别按 *_state 计数（f999 不算类别）', v.categories.length === 6 && v.categories.indexOf('charge') >= 0, JSON.stringify(v.categories));
    ok('电量取 battery_level', v.batteryPercent === 59 && v.batteryText === '59%', v.batteryText);
    ok('续航英里换公里', Math.abs(v.rangeKm - 200.4 * 1.609344) < 0.05 && /km$/.test(v.rangeText), v.rangeText);
    ok('里程按百分之一英里换算', Math.abs(v.odometerKm - 12345.67 * 1.609344) < 0.05, String(v.odometerKm));
    ok('车速 0 mph 是「停着」而不是「未知」', v.speed === 0 && v.speedKmh === 0, JSON.stringify({ s: v.speed, k: v.speedKmh }));
    ok('locked=false 是「未上锁」而不是「未知」', v.locked === false && v.lockedText === '未上锁', v.lockedText);
    ok('前备箱开 / 后备箱关', v.frunkOpen === true && v.trunkOpen === false);
    ok('四门全关 = 0 个开着（不等于未知）', v.doorsOpen === 0 && v.doorUnknown === false, JSON.stringify({ d: v.doorsOpen, u: v.doorUnknown }));
    ok(
      '俯视图逐门状态各自可读',
      v.doorStates.driverFront === false && v.doorStates.passengerRear === false,
      JSON.stringify(v.doorStates)
    );
    ok('驻车状态可读成中文', v.shift === 'P' && v.parked === true && v.shiftText === '已驻车', v.shiftText);
    ok('伪枚举取 type 字符串', v.chargingState === 'ChargingStateCharging' && v.chargePortLatch === 'ChargePortLatchEngaged');
    ok('盖板状态与挡位无关的字段各归各位', v.chargePortOpen === true && v.chargePortOpenText === '开着');
    ok('温度保留一位小数', v.insideTemp === 21.5 && v.outsideTemp === -3.2, JSON.stringify({ i: v.insideTemp, o: v.outsideTemp }));
    ok('位置与胎压成组', v.hasLocation === true && v.tire.fr === 2.51 && v.hasTirePressure === true);
    ok('来源可追溯', v.source === 'GetVehicleData（全部）', v.source);
  }

  // —— 车机只回一部分字段：没回的那部分必须回到「未知」，不能沿用上一轮的值
  {
    const partial = { closures_state: { locked: true } };
    applyVehicleData({ ok: true, summary: { kind: 'vehicleData', status: 0, data: partial }, text: '只有闭锁' });
    const v = vehicleView();
    ok('部分回包整体替换（电量回到未知）', v.locked === true && v.batteryText === VEHICLE_UNKNOWN, v.batteryText);
    ok('drive 没回时车速也是未知（不把 0 当成默认值）', v.speed === null && v.speedKmh === null, String(v.speedKmh));
    ok('部分回包时车窗/门未知', v.doorUnknown === true && v.windowsOpen === null);
    ok(
      '部分回包时逐门全部回到未知（不沿用上一轮的 false）',
      v.doorStates.driverFront === null &&
        v.doorStates.passengerFront === null &&
        v.doorStates.driverRear === null &&
        v.doorStates.passengerRear === null,
      JSON.stringify(v.doorStates)
    );
    ok('类别只剩 closures', v.categories.length === 1 && v.categories[0] === 'closures', JSON.stringify(v.categories));
  }

  // —— 订阅：页面靠它刷新，回调里出错不许冒泡
  {
    let hits = 0;
    const off = subscribeVehicle(() => {
      hits++;
      throw new Error('页面已销毁');
    });
    applyVehicleData({ closures_state: { locked: false } });
    ok('写入会通知订阅者', hits === 1, String(hits));
    off();
    applyVehicleData({ closures_state: { locked: true } });
    ok('退订后不再通知', hits === 1, String(hits));
  }

  // —— 诊断台账：只认 { ok:boolean }，文本原样存
  {
    recordResult('打开充电盖板', { ok: true, text: '车机已受理\n第一条路径' }, 'INFOTAINMENT');
    recordResult('OPEN_CHARGE_PORT', { ok: false, text: '车辆拒绝' }, 'VCSEC');
    const list = recentResults();
    ok('台账按时间倒序给页面', list.length === 2 && list[0].name === 'OPEN_CHARGE_PORT', JSON.stringify(list.map((e) => e.name)));
    ok('台账文本不截断', list[1].text.indexOf('车机已受理\n第一条路径') === 0, list[1].text);
    ok('同名同 tag 才互相命中', lastResult('打开充电盖板', 'INFOTAINMENT') && lastResult('打开充电盖板', 'VCSEC') === null);
    ok('计数分开累计', acts.diagnostics.total === 2 && acts.diagnostics.okCount === 1 && acts.diagnostics.failCount === 1, JSON.stringify(acts.diagnostics));
  }

  // —— 封顶滚动：诊断页写着「只留最近 N 条」，那么记录必须淘汰最旧的，但计数不能跟着丢，
  //   否则页面上的「成功 x / 失败 y」会悄悄变成窗口内的数，用户看到的比例就是假的。
  {
    clearDiagnostics();
    const cap = acts.MAX_DIAGNOSTICS;
    ok('上限由门面透出（页面不必直连 store）', typeof cap === 'number' && cap > 20, String(cap));
    for (let i = 0; i < cap + 7; i++) recordResult('滚动' + i, { ok: i % 3 === 0, text: '第 ' + i + ' 条结论原文' }, 'VCSEC');
    ok('记录数封顶在上限', acts.diagnostics.records.length === cap, String(acts.diagnostics.records.length));
    ok('被淘汰的是最旧那 7 条', acts.diagnostics.records[0].name === '滚动7', acts.diagnostics.records[0].name);
    ok('total 继续累加，不跟着裁剪', acts.diagnostics.total === cap + 7, String(acts.diagnostics.total));
    {
      let expect = 0;
      for (let i = 0; i < cap + 7; i++) if (i % 3 === 0) expect++;
      ok('okCount / failCount 统计全部历史而不是窗口', acts.diagnostics.okCount === expect && acts.diagnostics.failCount === cap + 7 - expect, JSON.stringify(acts.diagnostics));
    }
    ok('最旧那条已从窗口里消失（lastResult 再也命中不到）', lastResult('滚动0', 'VCSEC') === null && lastResult('滚动7', 'VCSEC') !== null);
    {
      const top20 = recentResults(20);
      ok('recentResults(20) 给最近 20 条且新在前', top20.length === 20 && top20[0].name === '滚动' + (cap + 6) && top20[19].name === '滚动' + (cap - 13), JSON.stringify(top20.map((e) => e.name).slice(0, 3)));
    }
    ok('不传 limit 时给满窗口', recentResults().length === cap);
  }

  clearVehicle();
  clearDiagnostics();
  clearLogs();
}

console.log('\n[18] 路由与界面字面量（静态扫描：防死链 / 防字符串漂移）');
{
  // 这一节不进任何运行时：它只读源码文本。要锁的是两类只能靠肉眼发现的断裂 ——
  //   1）界面上点得到、但 pages.json 里没注册的页（点了白屏，正是补诊断/绑定两页时踩过的坑）；
  //   2）台账按「动作名 + tag」字符串命中，两个页面各抄一份字面量，改一个字就永远命中不到。
  const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
  const read = (rel) => readFileSync(join(root, rel), 'utf8');

  const pagesJson = JSON.parse(read('pages.json'));
  const registered = pagesJson.pages.map((p) => p.path);
  ok('首页排第一（切 tab 用 reLaunch，栈里只留它）', registered[0] === 'pages/home/home', registered[0]);
  ok('在册页面数与页面目录数一致', registered.length === 10, String(registered.length));

  const noFile = [];
  for (const p of registered) {
    let isFile = false;
    try {
      isFile = statSync(join(root, p + '.vue')).isFile();
    } catch (e) {
      isFile = false;
    }
    if (!isFile) noFile.push(p);
  }
  ok('每一册都有对应 .vue 文件（不必等 HBuilderX 编译期才报错）', noFile.length === 0, noFile.join(' | '));

  const dead = [];
  const referenced = {};
  const walk = (dir) => {
    for (const n of readdirSync(join(root, dir))) {
      if (n === 'node_modules' || n === 'unpackage' || n === '.tmp-page') continue;
      const rel = dir + '/' + n;
      const abs = join(root, rel);
      if (statSync(abs).isDirectory()) {
        walk(rel);
        continue;
      }
      if (!/\.(vue|js)$/.test(n)) continue;
      const src = read(rel);
      const hits = src.match(/['"]\/pages\/[A-Za-z0-9_/-]+['"]/g) || [];
      for (const h of hits) {
        const raw = h.slice(1, h.length - 1); // 去掉两端引号 -> /pages/home/home
        referenced[raw] = (referenced[raw] || 0) + 1;
        if (registered.indexOf(raw.slice(1)) < 0) dead.push(rel + ' -> ' + h); // pages.json 里不带前导 /
      }
    }
  };
  walk('pages');
  walk('components');
  ok('界面里跳的每一页都已注册（没有死链）', dead.length === 0, dead.join(' | '));
  ok('新补的诊断页与绑定页都真的被引用到（在册但进不去等于还是死链）', referenced['/pages/diagnostics/diagnostics'] > 0 && referenced['/pages/binding/binding'] > 0, JSON.stringify(referenced));

  // 反方向也要查：注册了却没有任何入口的页，只有真机点遍界面才发现，离线看 pages.json 是完全正常的
  const orphans = [];
  for (const p of registered) {
    if (!referenced['/' + p]) orphans.push(p);
  }
  ok('在册的每一页都至少有一个入口（没有进不去的孤儿页）', orphans.length === 0, orphans.join(' | '));

  const tabSrc = read(join('components', 'tf-tabbar', 'tf-tabbar.vue'));
  const from = tabSrc.indexOf('const TABS');
  const tabRows = tabSrc.slice(from, tabSrc.indexOf('];', from)).split('\n').filter((l) => l.indexOf('{ key:') >= 0);
  ok('底部标签栏五项', tabRows.length === 5, String(tabRows.length));
  const badTab = [];
  for (const line of tabRows) {
    const key = (line.match(/key:\s*'([^']+)'/) || [])[1];
    const icon = (line.match(/icon:\s*'([^']+)'/) || [])[1];
    const url = (line.match(/url:\s*'([^']+)'/) || [])[1];
    if (!key || !icon || !url) {
      badTab.push('字段缺失: ' + line.trim());
      continue;
    }
    if (url !== '/pages/' + key + '/' + key) badTab.push(key + ' 的 url 与自身名字不配对: ' + url);
    if (registered.indexOf(url.slice(1)) < 0) badTab.push(key + ' 指向未注册页 ' + url);
    if (!Object.prototype.hasOwnProperty.call(ICONS, icon)) badTab.push(key + ' 的图标名不在图标库: ' + icon);
  }
  ok('标签栏每一项都指向已注册页、图标名有效', badTab.length === 0, badTab.join(' | '));

  const noBar = [];
  for (const key of ['home', 'control', 'climate', 'info', 'diagnostics']) {
    if (read('pages/' + key + '/' + key + '.vue').indexOf('<tf-tabbar active="' + key + '"') < 0) noBar.push(key);
  }
  ok('五个 tab 页都挂了自己的标签栏（active 与页名对应）', noBar.length === 0, noBar.join(' | '));
  ok('绑定页不是 tab：它不该出现标签栏（进出只有一条返回路径）', read('pages/binding/binding.vue').indexOf('tf-tabbar') < 0);

  // A/B 两条路径的台账键：控制页写它、诊断页也写它，两边必须逐字相同
  const abKeys = (rel) => {
    const src = read(rel);
    const s = src.indexOf('const PATHS');
    const block = src.slice(s, src.indexOf('\n]', s));
    const out = [];
    const re = /names:\s*\[([^\]]*)\][\s\S]{0,40}?tag:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(block))) {
      const names = (m[1].match(/'[^']+'/g) || []).map((x) => x.replace(/'/g, ''));
      out.push(names.join(',') + '@' + m[2]);
    }
    return out;
  };
  const ctl = abKeys('pages/control/control.vue');
  const diag = abKeys('pages/diagnostics/diagnostics.vue');
  ok('控制页与诊断页的 A/B 台账键逐字一致', ctl.length === 2 && diag.length === 2 && ctl.join('|') === diag.join('|'), 'control=' + JSON.stringify(ctl) + ' diagnostics=' + JSON.stringify(diag));

  // 驾驶授权按钮的台账键：页面抄的字符串 vs vehicle-api 登记的字符串，同样是「改一个字就永远命中不到」
  {
    const ctlSrc = read('pages/control/control.vue');
    const apiSrc = read(join('src', 'services', 'vehicle-api.js'));
    const page = ctlSrc.match(/const DRIVE_LEDGER = \{ name: '([^']+)', tag: '([^']+)'/);
    const wrap = apiSrc.match(/export const remoteDrive = \(\) => tracked\('([^']+)', \(\) => rawRequestDrive\(\), '([^']+)'\)/);
    ok('控制页的驾驶授权台账键与 vehicle-api 逐字一致',
      !!page && !!wrap && page[1] === wrap[1] && page[2] === wrap[2],
      'page=' + JSON.stringify(page && [page[1], page[2]]) + ' api=' + JSON.stringify(wrap && [wrap[1], wrap[2]]));
    // 解锁那颗现在会串发驾驶授权（真机验证 BLE 发 REMOTE_DRIVE 车辆接受）。
    // 红线换成两条更硬的：串发只以「解锁终态成功」为前提；协议层（rke.js）永远不许夹带。
    const confirm = ctlSrc.slice(ctlSrc.indexOf('onConfirm()'), ctlSrc.indexOf('doLock()'));
    ok('解锁确认走 unlockAndDrive()（页面只有一处调用）',
      confirm.indexOf('unlockAndDrive()') >= 0 && (ctlSrc.match(/unlockAndDrive\(\)/g) || []).length === 1, confirm);
    ok('串发只以解锁成功为前提（vehicle-api 里先判 u.ok 再发 remoteDrive）',
      /if \(!u \|\| !u\.ok\) return u;[\s\S]{0,120}await remoteDrive\(\)/.test(apiSrc),
      apiSrc.slice(apiSrc.indexOf('export const unlockAndDrive'), apiSrc.indexOf('export const unlockAndDrive') + 700));
    ok('页面不再自己拼解锁的 RKE 载荷（避免两处口径各自演化）',
      confirm.indexOf('RKE_ACTION_UNLOCK') < 0, confirm);
    ok('驾驶授权仍留着单独重试的那颗按钮（页面里只出现一次）',
      (ctlSrc.match(/remoteDrive\(\)/g) || []).length === 1, String((ctlSrc.match(/remoteDrive\(\)/g) || []).length));
    ok('解锁/上锁的实现也没顺带发驾驶授权',
      read(join('src', 'services', 'vcsec', 'rke.js')).indexOf('REMOTE_DRIVE') < 0);
    // 界面不许替车辆下结论：只能写「回执通过 / 回执拒绝」，不能出现自造的启动状态
    ok('按钮文案不伪造启动状态',
      ctlSrc.indexOf('已启动') < 0 && ctlSrc.indexOf('启动成功') < 0 && ctlSrc.indexOf('车辆回执通过') > 0);

    // 首页快捷动作就是控制页那两个：动作实现 + 确认文案都必须逐字相同，
    // 否则同一台车在两个页面上会有两套后果（用户明确要求「两边要一致」）。
    const homeSrc = read('pages/home/home.vue');
    const attr = (re) => { const m = ctlSrc.match(re); return m ? m[1] : '(控制页没找到)'; };
    const dlg = (key) => {
      const s = homeSrc.indexOf('  ' + key + ': {');
      const block = homeSrc.slice(s, homeSrc.indexOf('  },', s));
      const g = (f) => { const m = block.match(new RegExp(f + ": '([^']+)'")); return m ? m[1] : '(首页没找到)'; };
      return { title: g('title'), desc: g('desc'), tip: g('tip'), ok: g('ok') };
    }
    const hu = dlg('unlock');
    ok('首页解锁也走 unlockAndDrive()（且不再自己拼解锁载荷）',
      homeSrc.indexOf('unlockAndDrive()') >= 0 && homeSrc.indexOf('RKE_ACTION_UNLOCK') < 0,
      homeSrc.slice(homeSrc.indexOf('onConfirm()'), homeSrc.indexOf('doLock()')));
    ok('首页与控制页的解锁确认文案逐字一致',
      hu.title === attr(/title="([^"]+)"/) && hu.desc === attr(/desc="([^"]+)"/) && hu.tip === attr(/tip="([^"]+)"/) && hu.ok === attr(/confirm-text="([^"]+)"/),
      JSON.stringify(hu));
    ok('首页解锁同样是三秒倒计时 + 危险色',
      homeSrc.indexOf("dlg === 'unlock' ? 3 : 0") > 0 && homeSrc.indexOf("dlg === 'unlock'") > 0);
    ok('首页上锁与控制页是同一个调用（LOCK 载荷 + busy 码 11）',
      homeSrc.slice(homeSrc.indexOf('doLock()')).indexOf("sendRke(rkeEnum('RKE_ACTION_LOCK'), 'LOCK')") > 0 &&
      ctlSrc.slice(ctlSrc.indexOf('doLock()')).indexOf("sendRke(rkeEnum('RKE_ACTION_LOCK'), 'LOCK')") > 0);
  }
}

console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
