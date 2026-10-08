// tools/gen_goldens.mjs
// 生成主机测试用金标准头文件 tests/host/goldens.h。
//   · 哈希 / HMAC / AES / AES-GCM 取自 Node crypto（外部权威实现，不复用探针 JS）
//   · 协议层报文取自 tesla-ble-probe 的参考实现，保证 C 移植逐字节一致
// 用法：node tools/gen_goldens.mjs [--repo <path>]
import { createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(ROOT, 'tests/host/goldens.h');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const PROBE = resolve(ROOT, arg('repo', '../tesla-ble-probe'));

// ---------------------------------------------------------------- 字节数组 -> C
let idc = 0;
const decls = [];
function cbytes(name, buf) {
  const id = name + '_' + idc++;
  const parts = [];
  for (let i = 0; i < buf.length; i++) parts.push('0x' + buf[i].toString(16).padStart(2, '0'));
  decls.push(`static const uint8_t ${id}[] = {${parts.join(',')||'0'}}; // len=${buf.length}`);
  return { id, len: buf.length };
}
function hex(s) {
  return Buffer.from(s.replace(/[^0-9a-fA-F]/g, ''), 'hex');
}
function str(s) {
  return Buffer.from(s, 'utf8');
}
// 可复现伪随机（LCG），避免每次生成都产生不同金标准
function prng(n, seed = 0x1234abcd) {
  const b = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    b[i] = (x >>> 24) ^ (x & 0xff);
  }
  return b;
}

const sections = [];

// ---------------------------------------------------------------- SHA-256 / SHA-1
function hashCases(algo, wantLen, ctxName) {
  const inputs = [
    ['empty', Buffer.alloc(0)],
    ['abc', str('abc')],
    ['len55', prng(55, 11)], // 补位落在同块
    ['len56', prng(56, 12)], // 必须进第二块
    ['len63', prng(63, 13)],
    ['len64', prng(64, 14)], // 正好整块
    ['len65', prng(65, 15)],
    ['len119', prng(119, 16)],
    ['len120', prng(120, 17)],
    ['len1000', prng(1000, 18)],
  ];
  const rows = [];
  for (const [nm, msg] of inputs) {
    const want = createHash(algo).update(msg).digest();
    if (want.length !== wantLen) throw new Error('digest length mismatch');
    const m = cbytes('sha_msg', msg);
    const w = cbytes('sha_want', want);
    rows.push(
      `    { "${algo}/${nm}", ${m.id}, ${m.len}, ${w.id}, ${w.len}, ${(m.len >> 1) | 0} },`
    );
  }
  sections.push(
    `// ${algo}\nstatic const tlb_g_bytes ${ctxName}[] = {\n${rows.join('\n')}\n};`
  );
}
hashCases('sha256', 32, 'g_sha256_cases');
hashCases('sha1', 20, 'g_sha1_cases');

// ---------------------------------------------------------------- HMAC-SHA256
{
  const cases = [
    ['rfc4231-1', hex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'), str('Hi There')],
    ['rfc4231-2', str('Jefe'), str('what do ya want for nothing?')],
    ['rfc4231-3', hex('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), prng(50, 31)],
    ['rfc4231-4', hex(
      '0102030405060708090a0b0c0d0e10111213141516171819',
    ), prng(50, 32)],
    ['empty-key-empty-msg', Buffer.alloc(0), Buffer.alloc(0)],
    ['fox', str('key'), str('The quick brown fox jumps over the lazy dog')],
    ['longkey-131', prng(131, 41), str('Test Using Larger Than Block-Size Key - Hash Key First')],
    ['longkey-131-trailing', prng(131, 41), prng(143, 42)],
    ['key-exact-64', prng(64, 43), prng(200, 44)],
  ];
  const rows = [];
  for (const [nm, k, m] of cases) {
    const want = createHmac('sha256', k.length ? k : Buffer.alloc(0)).update(m).digest();
    const kb = cbytes('hmac_key', k);
    const mb = cbytes('hmac_msg', m);
    const wb = cbytes('hmac_want', want);
    rows.push(
      `    { "hmac/${nm}", ${kb.id}, ${kb.len}, ${mb.id}, ${mb.len}, ${wb.id}, ${wb.len}, ${(mb.len >> 1) | 0} },`
    );
  }
  sections.push(`// HMAC-SHA256\nstatic const tlb_g_hmac g_hmac_cases[] = {\n${rows.join('\n')}\n};`);
}

// ---------------------------------------------------------------- AES-128 单块（FIPS-197 B.1）
{
  const key = hex('000102030405060708090a0b0c0d0e0f');
  const pt = hex('00112233445566778899aabbccddeeff');
  const want = hex('69c4e0d86a7b0430d8cdb78070b4c55a');
  const k = cbytes('aes_key', key);
  const p = cbytes('aes_pt', pt);
  const w = cbytes('aes_want', want);
  const extra = [];
  for (let i = 0; i < 8; i++) {
    const kb = prng(16, 100 + i);
    const pb = prng(16, 200 + i);
    const kk = cbytes('aes_key', kb);
    const pp = cbytes('aes_pt', pb);
    const ecb = createCipheriv('aes-128-ecb', kb, null);
    ecb.setAutoPadding(false);
    const ww = cbytes('aes_want', Buffer.concat([ecb.update(pb), ecb.final()]));
    extra.push(`    { "aes-block/${i}", ${kk.id}, ${kk.len}, ${pp.id}, ${pp.len}, ${ww.id}, ${ww.len} },`);
  }
  sections.push(
    `// AES-128 单块\nstatic const tlb_g_block g_aes_block_cases[] = {\n    { "aes-block/fips197-B1", ${k.id}, ${k.len}, ${p.id}, ${p.len}, ${w.id}, ${w.len} },\n${extra.join('\n')}\n};`
  );
}

// ---------------------------------------------------------------- AES-128-GCM
{
  const nonces = {
    n12: prng(12, 501),
    n4: prng(4, 502), // 特斯拉旧式短 counter nonce
    n8: prng(8, 503),
    n13: prng(13, 504),
    n16: prng(16, 505),
  };
  const combos = [
    ['n12', 'a0', 0],
    ['n12', 'a13', 13],
    ['n12', 'a16', 16],
    ['n12', 'a20', 20],
    ['n4', 'a16', 16],
    ['n4', 'a0', 0],
    ['n8', 'a13', 13],
    ['n13', 'a16', 16],
    ['n16', 'a0', 0],
  ];
  const rows = [];
  for (const [nk, ak, alen] of combos) {
    const nonce = nonces[nk];
    const key = prng(16, 600 + rows.length);
    const aad = alen ? prng(alen, 700 + rows.length) : Buffer.alloc(0);
    for (const plen of [0, 1, 15, 16, 17, 31, 32, 33, 64, 100]) {
      const pt = prng(plen, 800 + plen);
      const c = createCipheriv('aes-128-gcm', key, nonce, { authTagLength: 16 });
      if (alen) c.setAAD(aad);
      const ct = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
      // 反向自检：解密必须还原
      const d = createDecipheriv('aes-128-gcm', key, nonce, { authTagLength: 16 });
      if (alen) d.setAAD(aad);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const back = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      if (!back.equals(pt)) throw new Error('node gcm self-check failed');
      const k = cbytes('gcm_key', key);
      const n = cbytes('gcm_nonce', nonce);
      const a = cbytes('gcm_aad', aad);
      const p = cbytes('gcm_pt', pt);
      const w = cbytes('gcm_want', ct); // 密文 ‖ tag
      rows.push(
        `    { "gcm/${nk}/${ak}/p${plen}", ${k.id}, ${k.len}, ${n.id}, ${n.len}, ${a.id}, ${a.len}, ${p.id}, ${p.len}, ${w.id}, ${w.len} },`
      );
    }
  }
  sections.push(`// AES-128-GCM（want = 密文 ‖ 16 字节 tag）\nstatic const tlb_g_gcm g_gcm_cases[] = {\n${rows.join('\n')}\n};`);
}

// ---------------------------------------------------------------- 协议层金标准
// 全部取自探针的参考实现：C 侧的「字段书写顺序 / oneof 必写 / 默认值省略 / 降级判据」
// 只能靠逐字节比对才锁得住，人肉读 JS 是锁不住的。
async function protocolSections() {
  const url = (p) => new URL('file:///' + resolve(PROBE, p).replace(/\\/g, '/') + '').href;
  let encode, decode, V3_SPEC, codec, handshake, aeadMod, metaMod, C;
  try {
    ({ encode, decode } = await import(url('src/protocol/pb.js')));
    ({ V3_SPEC } = await import(url('src/protocol/v3/spec.js')));
    codec = await import(url('src/protocol/v3/codec.js'));
    handshake = await import(url('src/protocol/v3/handshake.js'));
    aeadMod = await import(url('src/protocol/v3/aead.js'));
    metaMod = await import(url('src/protocol/v3/metadata.js'));
    C = await import(url('src/protocol/v3/constants.js'));
  } catch (e) {
    console.warn('[gen_goldens] 跳过协议层金标准：无法加载探针模块：' + e.message);
    return;
  }

  const DOMAIN = C.DOMAIN;
  const SIGTYPE = C.SIGTYPE;
  const MAX_EPOCH = C.MAX_EPOCH_SECONDS; // authentication.epochLength = 1<<30
  const VIN = '5YJ3E1EA7KF000000'; // 假 VIN 夹具（上架脱敏：绝不用真实车辆 VIN）
  // 固定夹具：全部用带种子的 LCG，保证金标准可复现
  const pub65 = (seed) => { const b = prng(65, seed); b[0] = 0x04; return b; };
  const KEY = prng(16, 900);
  const EPOCH = prng(16, 901);
  const NONCE = prng(12, 902);
  const ROUTING = prng(16, 903);
  const UUID = prng(16, 904);
  const PK = pub65(905);

  // 字节数组 → "id, len"；null/undefined → "NULL, 0"
  const bt = (buf, nm) => {
    if (buf === null || buf === undefined) return 'NULL, 0';
    const c = cbytes(nm, buf);
    return `${c.id}, ${c.len}`;
  };

  // ---- VCSEC.UnsignedMessage{RKEAction}
  {
    const rows = [];
    for (const [nm, act] of [['unlock', 0], ['lock', 1], ['remote_drive', 20], ['wake', 30]]) {
      const w = cbytes('rke', codec.encodeUnsignedMessage({ RKEAction: act }));
      rows.push(`    { "${nm}", ${act}, ${w.id}, ${w.len} },`);
    }
    sections.push(`// UnsignedMessage{RKEAction}：UNLOCK=0 也必须写 tag\nstatic const tlb_g_rke g_rke_cases[] = {\n${rows.join('\n')}\n};`);
  }

  // ---- session_info 握手请求
  {
    const rows = [];
    for (const [nm, dom] of [['vcsec', DOMAIN.DOMAIN_VEHICLE_SECURITY],
                             ['broadcast', DOMAIN.DOMAIN_BROADCAST],
                             ['infotainment', DOMAIN.DOMAIN_INFOTAINMENT]]) {
      const r = handshake.buildSessionInfoRequest(dom, PK, UUID, ROUTING);
      const w = cbytes('hs_want', r.bytes);
      rows.push(`    { "${nm}", ${dom}, ${bt(ROUTING, 'hs_routing')}, ${bt(PK, 'hs_pk')}, ${bt(UUID, 'hs_uuid')}, ${w.id}, ${w.len} },`);
    }
    sections.push(`// buildSessionInfoRequest\nstatic const tlb_g_hs g_hs_cases[] = {\n${rows.join('\n')}\n};`);
  }

  // ---- 加白名单（裸信封）
  {
    const rows = [];
    for (const [nm, role, ff] of [['nfc_driver', 3, 1], ['ff_unknown', 3, 0], ['role_unknown', 0, 9]]) {
      const p = cbytes('ak_payload', codec.buildAddKeyPayload(PK, role, ff));
      const e = cbytes('ak_env', codec.buildAddKeyEnvelope(PK, role, ff));
      rows.push(`    { "${nm}", ${bt(PK, 'ak_pk')}, ${role}, ${ff}, ${p.id}, ${p.len}, ${e.id}, ${e.len} },`);
    }
    sections.push(`// buildAddKeyPayload / buildAddKeyEnvelope（信封首字节必须是 0x0a）\nstatic const tlb_g_addkey g_addkey_cases[] = {\n${rows.join('\n')}\n};`);
  }

  // ---- 请求侧元数据
  {
    const mk = (nm, o) => {
      const m = metaMod.requestMetadata(o);
      const tlv = cbytes('rm_tlv', m.bytes(true));
      const sha = cbytes('rm_sha', m.sha256());
      return `    { "${nm}", ${o.signatureType}, ${o.domain}, "${o.vin}", ${bt(o.epoch, 'rm_epoch')}, ${o.expiresAt >>> 0}, ${o.counter >>> 0}, ${(o.flags || 0) >>> 0}, ${tlv.id}, ${tlv.len}, ${sha.id} },`;
    };
    const base = { signatureType: SIGTYPE.SIGNATURE_TYPE_AES_GCM_PERSONALIZED, domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, vin: VIN, epoch: EPOCH };
    const rows = [
      mk('flags0', { ...base, expiresAt: 12345, counter: 1, flags: 0 }),
      mk('flags_encrypt_response', { ...base, expiresAt: 12345, counter: 1, flags: 2 }),
      mk('flags_user_command', { ...base, expiresAt: 12345, counter: 42, flags: 1 }),
      mk('lowercase_vin', { ...base, vin: VIN.toLowerCase(), expiresAt: 0, counter: 0xFFFFFFFE, flags: 3 }),
      mk('zero_expiry', { ...base, expiresAt: 0, counter: 0, flags: 0 }),
      mk('max_expiry', { ...base, expiresAt: MAX_EPOCH, counter: 0xFFFFFFFF, flags: 0 }),
      mk('no_epoch', { ...base, epoch: null, expiresAt: 12, counter: 7, flags: 0 }),
    ];
    sections.push(`// requestMetadata：TLV（含 0xFF 结尾）与 SHA256(TLV) = GCM 的 AAD\nstatic const tlb_g_reqmeta g_reqmeta_cases[] = {\n${rows.join('\n')}\n};`);
  }

  // ---- 响应侧元数据
  {
    const mk = (nm, o) => {
      const m = metaMod.responseMetadata(o);
      const tlv = cbytes('sm_tlv', m.bytes(true));
      const sha = cbytes('sm_sha', m.sha256());
      return `    { "${nm}", ${o.domain}, "${o.vin}", ${o.counter >>> 0}, ${(o.flags || 0) >>> 0}, ${bt(o.requestId === undefined ? null : o.requestId, 'sm_rid')}, ${(o.fault || 0) >>> 0}, ${tlv.id}, ${tlv.len}, ${sha.id} },`;
    };
    const rid = Uint8Array.from([SIGTYPE.SIGNATURE_TYPE_AES_GCM_PERSONALIZED, ...prng(16, 920)]);
    const rows = [
      mk('no_request_id', { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, vin: VIN, counter: 1, flags: 0, requestId: undefined, fault: 0 }),
      mk('request_id', { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, vin: VIN, counter: 1, flags: 2, requestId: rid, fault: 0 }),
      mk('fault', { domain: DOMAIN.DOMAIN_BROADCAST, vin: VIN, counter: 0xFFFFFFFE, flags: 3, requestId: rid, fault: 6 }),
      mk('lowercase_vin', { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, vin: VIN.toLowerCase(), counter: 9, flags: 1, requestId: null, fault: 20 }),
    ];
    sections.push(`// responseMetadata（sigtype 恒 9，flags 恒含，requestId 为空则跳过 TAG_REQUEST_HASH）\nstatic const tlb_g_resmeta g_resmeta_cases[] = {\n${rows.join('\n')}\n};`);
  }

  // ---- 子密钥派生 + session_info HMAC
  {
    const rows = [];
    for (const label of [C.LABEL_SESSION_INFO, C.LABEL_MESSAGE_AUTH]) {
      const w = cbytes('sk_want', handshake.subkey(KEY, label));
      rows.push(`    { "${label.replace(/ /g, '_')}", ${bt(KEY, 'sk_key')}, "${label}", ${w.id} },`);
    }
    sections.push(`// subkey(K, label) = HMAC-SHA256(K, utf8(label))：输出 32 字节\nstatic const tlb_g_subkey g_subkey_cases[] = {\n${rows.join('\n')}\n};`);

    const siFull = encode(V3_SPEC, 'SessionInfo', { counter: 3, publicKey: PK, epoch: EPOCH, clock_time: 1700000000 });
    const hsRows = [
      ['vcsec', VIN, UUID, siFull],
      ['lowercase_vin', VIN.toLowerCase(), UUID, siFull],
      ['other_challenge', VIN, prng(16, 930), siFull],
      ['empty_msg', VIN, UUID, new Uint8Array(0)],
    ].map(([nm, vin, ch, enc]) => {
      const w = cbytes('sih_want', handshake.sessionInfoHmac(KEY, vin, ch, enc));
      return `    { "${nm}", ${bt(KEY, 'sih_key')}, "${vin}", ${bt(ch, 'sih_ch')}, ${bt(enc, 'sih_si')}, ${w.id} },`;
    });
    sections.push(`// sessionInfoHmac：Metadata{SIGTYPE=HMAC, PERSONALIZATION=VIN, CHALLENGE=uuid} ‖ 0xFF ‖ session_info\nstatic const tlb_g_sihmac g_sihmac_cases[] = {\n${hsRows.join('\n')}\n};`);
  }

  // ---- 端到端加密命令（元数据 → AAD → GCM → RoutableMessage）
  {
    const rows = [];
    const mk = (nm, o) => {
      const session = { key: KEY, epoch: EPOCH, counter: o.counter, anchor: o.anchor };
      const r = aeadMod.encryptCommand({
        domain: o.domain, vin: VIN, session, publicKey: PK, payload: o.payload,
        flags: o.flags, expiresInSeconds: o.expiresIn, routingAddress: ROUTING, uuid: UUID,
        nonce: NONCE, now: o.now,
      });
      if (r.counter !== o.counter + 1) throw new Error('counter 落地异常');
      const w = cbytes('cmd_want', r.bytes);
      const tlv = cbytes('cmd_tlv', r.tlv);
      const aad = cbytes('cmd_aad', r.aad);
      const ct = cbytes('cmd_ct', r.ciphertext);
      const tag = cbytes('cmd_tag', r.tag);
      const plain = cbytes('cmd_plain', r.plaintext);
      return `    { "${nm}", ${o.domain}, ${(o.flags || 0) >>> 0}, ${r.counter >>> 0}, ${r.expiresAt >>> 0}, ${bt(KEY, 'cmd_key')}, ${bt(EPOCH, 'cmd_epoch')}, ${bt(NONCE, 'cmd_nonce')}, ${bt(ROUTING, 'cmd_routing')}, ${bt(UUID, 'cmd_uuid')}, ${bt(PK, 'cmd_pk')}, ${plain.id}, ${plain.len}, ${tlv.id}, ${tlv.len}, ${aad.id}, ${aad.len}, ${ct.id}, ${ct.len}, ${tag.id}, ${w.id}, ${w.len}, ${o.now}, ${o.anchor} },`;
    };
    const NOW = 1700000000;
    rows.push(mk('unlock', { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, counter: 0, flags: 0, expiresIn: 5, now: NOW, anchor: NOW, payload: codec.encodeUnsignedMessage({ RKEAction: 0 }) }));
    rows.push(mk('remote_drive_encrypt_response', { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, counter: 41, flags: 3, expiresIn: 5, now: NOW, anchor: NOW, payload: codec.encodeUnsignedMessage({ RKEAction: 20 }) }));
    // expires_at == 0：pb.js 的 fx 字段等于默认值且不在 oneof 里 → 整个字段消失
    rows.push(mk('zero_expires_at', { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, counter: 0xFFFFFFFD, flags: 2, expiresIn: 0, now: NOW, anchor: NOW, payload: codec.encodeUnsignedMessage({ RKEAction: 1 }) }));
    rows.push(mk('clock_behind', { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, counter: 9, flags: 0, expiresIn: 5, now: NOW, anchor: NOW + 3, payload: codec.encodeUnsignedMessage({ RKEAction: 30 }) }));
    rows.push(mk('long_payload', { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, counter: 100, flags: 1, expiresIn: 30, now: NOW, anchor: NOW, payload: prng(200, 940) }));
    sections.push(`// encryptCommand 全链路\nstatic const tlb_g_cmd g_cmd_cases[] = {\n${rows.join('\n')}\n};`);
  }

  // ---- 共享密钥派生：K = SHA1(ECDH 的 X 坐标)[:16]（native.go Exchange）
  {
    const rows = [];
    for (const [nm, len, seed] of [['x32', 32, 980], ['x32-allzero', 32, 0], ['x40-truncated', 40, 981]]) {
      const x = len === 32 && seed === 0 ? Buffer.alloc(32) : prng(len, seed);
      const want = createHash('sha1').update(x.subarray(0, 32)).digest().subarray(0, 16);
      const inb = cbytes('vk_in', x);
      const wb = cbytes('vk_want', want);
      rows.push(`    { "vkey/${nm}", ${inb.id}, ${inb.len}, ${wb.id}, ${wb.len}, 0 },`);
    }
    sections.push(`// 会话密钥派生（want = SHA1(输入前 32 字节) 的前 16 字节；C 侧固定只取 32 字节）\nstatic const tlb_g_bytes g_vkey_cases[] = {\n${rows.join('\n')}\n};`);
  }

  // ---- 握手参数采纳：applySessionInfo 的接受条件与失败语义
  {
    // 探针里 anchor/setAt 取本地墙上时钟，生成金标准时把时钟钉死，C 侧用显式 now 参数复现
    const realNow = Date.now;
    const NOW_S = 1700000123;
    const SI_CLOCK = 1700000000;
    const EPOCH_B = prng(16, 970);
    const mkTag = (enc, vin = VIN, ch = UUID) => handshake.sessionInfoHmac(KEY, vin, ch, enc);
    const siFull = encode(V3_SPEC, 'SessionInfo', { counter: 7, publicKey: PK, epoch: EPOCH, clock_time: SI_CLOCK });
    const siDecline = encode(V3_SPEC, 'SessionInfo', { counter: 2, publicKey: PK, epoch: EPOCH, clock_time: SI_CLOCK, status: 1 });
    const siEpochB = encode(V3_SPEC, 'SessionInfo', { counter: 1, publicKey: PK, epoch: EPOCH_B, clock_time: SI_CLOCK });
    const siNoClock = encode(V3_SPEC, 'SessionInfo', { counter: 4, publicKey: PK, epoch: EPOCH });
    const siShortEpoch = encode(V3_SPEC, 'SessionInfo', { publicKey: PK, epoch: prng(8, 971), clock_time: SI_CLOCK });
    const siBadPub = encode(V3_SPEC, 'SessionInfo', { publicKey: Uint8Array.from([0x04, ...prng(63, 972)]), epoch: EPOCH, clock_time: SI_CLOCK });
    const siHead2 = encode(V3_SPEC, 'SessionInfo', { publicKey: Uint8Array.from([0x02, ...prng(64, 973)]), epoch: EPOCH, clock_time: SI_CLOCK });
    const siNoPub = encode(V3_SPEC, 'SessionInfo', { epoch: EPOCH, clock_time: SI_CLOCK });
    // 非法 protobuf：field 2 声明 5 字节却只剩 1 字节，pb.js 与 C 都必须拒绝
    const siGarbage = Buffer.from([0x12, 0x05, 0x01]);

    const ERR = {
      TLB_OK: 0, TLB_ERR_PROTO: -2, TLB_ERR_CRYPTO: -3, TLB_ERR_STATE: -9, TLB_ERR_NO_KEY: -8,
    };
    const classify = (r) => {
      if (r.ok) return 'TLB_OK';
      const e = r.error || '';
      if (e.indexOf('还没有共享密钥') >= 0) return 'TLB_ERR_NO_KEY';
      if (e.indexOf('HMAC 校验不通过') >= 0) return 'TLB_ERR_CRYPTO';
      if (e.indexOf('时钟倒退') >= 0) return 'TLB_ERR_STATE';
      if (/没有 session_info|不是合法 protobuf|格式意外|epoch 长度应为 16/.test(e)) return 'TLB_ERR_PROTO';
      throw new Error('未分类的握手失败：' + e);
    };

    const cases = [
      ['first_handshake', { key: KEY }, siFull, VIN, UUID],
      ['same_epoch_clock_forward', { key: KEY, epoch: EPOCH, setTime: SI_CLOCK - 10 }, siFull, VIN, UUID],
      ['same_epoch_clock_back', { key: KEY, epoch: EPOCH, setTime: SI_CLOCK + 10 }, siFull, VIN, UUID],
      ['new_epoch_clock_back', { key: KEY, epoch: EPOCH_B, setTime: SI_CLOCK + 10 }, siFull, VIN, UUID],
      ['counter_regress', { key: KEY, counter: 50 }, siFull, VIN, UUID],
      ['counter_forward', { key: KEY, counter: 3 }, siFull, VIN, UUID],
      ['accept_epoch_b', { key: KEY }, siEpochB, VIN, UUID],
      ['no_clock_time', { key: KEY }, siNoClock, VIN, UUID],
      ['lowercase_vin', { key: KEY }, siFull, VIN.toLowerCase(), UUID],
      ['decline_status1', { key: KEY }, siDecline, VIN, UUID],
      ['bad_tag', { key: KEY, epoch: EPOCH }, siFull, VIN, UUID, (t) => { t[0] ^= 0x80; }],
      ['empty_encoded', { key: KEY }, new Uint8Array(0), VIN, UUID],
      ['empty_tag', { key: KEY }, siFull, VIN, UUID, () => new Uint8Array(0)],
      ['no_key', {}, siFull, VIN, UUID],
      ['short_epoch', { key: KEY }, siShortEpoch, VIN, UUID],
      ['pub_wrong_length', { key: KEY }, siBadPub, VIN, UUID],
      ['pub_wrong_prefix', { key: KEY }, siHead2, VIN, UUID],
      ['pub_missing', { key: KEY }, siNoPub, VIN, UUID],
      ['not_protobuf', { key: KEY }, siGarbage, VIN, UUID],
    ];

    const snap = (o) => JSON.stringify(
      ['epoch', 'vehiclePublicKey', 'setTime', 'anchor', 'clockTime', 'counter', 'ready'].map(
        (k) => (o[k] === undefined ? null : ArrayBuffer.isView(o[k]) ? Array.from(o[k]) : o[k])));

    const rows = [];
    Date.now = () => NOW_S * 1000;
    let parsed;
    try {
      for (const [nm, init, encoded, vin, challenge, mutate] of cases) {
        const session = Object.assign({}, init);
        let given = Uint8Array.from(mkTag(encoded, vin, challenge));
        if (mutate) given = mutate(given) || given;
        const before = snap(session);
        const r = handshake.applySessionInfo(session, { vin, challenge, encodedInfo: encoded, tag: given });
        parsed = classify(r);
        const errCode = ERR[parsed];
        if (errCode === undefined) throw new Error('金标准内部错误：未知分类 ' + parsed);
        // 失败时探针绝不改动会话；C 必须一样，用 JS 的返回前后快照交叉核对
        if (errCode !== 0 && snap(session) !== before) throw new Error(nm + '：失败却改动了会话');
        const cells = [
          `"${nm}"`, bt(init.key, 'ap_key'),
          bt(init.epoch, 'ap_init_epoch'), `${(init.counter || 0) >>> 0}`,
          `${init.setTime === undefined ? 0 : 1}`, `${(init.setTime || 0) >>> 0}`,
          `"${vin}"`, bt(challenge, 'ap_ch'), bt(encoded, 'ap_enc'), bt(given, 'ap_tag'),
          `${NOW_S}`, `${errCode}`,
          bt(session.epoch, 'ap_epoch'), bt(session.vehiclePublicKey, 'ap_pub'),
          `${(session.clockTime || 0) >>> 0}`, `${(session.setTime || 0) >>> 0}`,
          `${session.setTime === undefined ? 0 : 1}`,
          `${(session.anchor === undefined ? '0' : String(session.anchor))}`,
          `${(session.counter || 0) >>> 0}`, `${session.ready ? 1 : 0}`,
          `${(r.status === undefined ? 0 : r.status) >>> 0}`, `${r.notWhitelisted ? 1 : 0}`,
        ];
        rows.push(`    { ${cells.join(', ')} },`);
      }
    } finally {
      Date.now = realNow;
    }
    sections.push(`// tlb_v3_apply_session_info：接受条件（epoch 变化 / 时钟不倒退）、失败不污染会话、counter 只上调\n// err 取值：0=TLB_OK -2=TLB_ERR_PROTO -3=TLB_ERR_CRYPTO -8=TLB_ERR_NO_KEY -9=TLB_ERR_STATE\nstatic const tlb_g_apply g_apply_cases[] = {\n${rows.join('\n')}\n};`);
  }

  // ---- 响应解密：FLAG_ENCRYPT_RESPONSE 的 AES_GCM_Response_data
  {
    const RID = Uint8Array.from([SIGTYPE.SIGNATURE_TYPE_AES_GCM_PERSONALIZED, ...prng(16, 920)]);
    const vcOk = encode(V3_SPEC, 'FromVCSECMessage', { commandStatus: { operationStatus: 0 } });
    const ERR = { TLB_OK: 0, TLB_ERR_PROTO: -2, TLB_ERR_CRYPTO: -3 };

    const build = (nm, o) => {
      const meta = metaMod.responseMetadata({
        domain: o.domain, vin: o.vin, counter: o.metaCounter === undefined ? o.counter : o.metaCounter,
        flags: o.flags || 0, requestId: o.rid, fault: o.fault || 0,
      });
      const aad = meta.sha256();
      // 协议里密文与 tag 是分开的：密文进 protobuf_message_as_bytes，tag 进 AES_GCM_Response_data
      const c = createCipheriv('aes-128-gcm', KEY, o.nonce, { authTagLength: 16 });
      c.setAAD(aad);
      const ct = Buffer.concat([c.update(o.plain), c.final()]);
      const tag = Uint8Array.from(c.getAuthTag());
      if (o.tamperTag) tag[15] ^= 0x01;

      const msg = {};
      if (!o.noFrom) msg.from_destination = { domain: o.domain };
      msg.to_destination = { routing_address: o.toRouting };
      msg.protobuf_message_as_bytes = ct.length ? ct : new Uint8Array(0);
      if (o.fault || o.opStatus) {
        msg.signedMessageStatus = {};
        if (o.opStatus) msg.signedMessageStatus.operation_status = o.opStatus;
        if (o.fault) msg.signedMessageStatus.signed_message_fault = o.fault;
      }
      if (!o.noRespData) {
        msg.signature_data = { AES_GCM_Response_data: { nonce: o.nonce, counter: o.counter, tag } };
      }
      if (o.flags) msg.flags = o.flags;
      const bytes = encode(V3_SPEC, 'RoutableMessage', msg);

      const cells = [
        `"${nm}"`, bt(bytes, 'rs_bytes'), bt(KEY, 'rs_key'), `"${o.vin}"`,
        bt(o.rid, 'rs_rid'),
        // err 是有符号错误码（负数），不能用 >>>0
        `${o.errCode === undefined ? 0 : o.errCode}`,
        bt(o.plain.length ? o.plain : null, 'rs_plain'),
        `${(o.expectCounter === undefined ? o.counter : o.expectCounter) >>> 0}`,
      ];
      return `    { ${cells.join(', ')} },`;
    };

    const N1 = prng(12, 990), N2 = prng(12, 991), N3 = prng(12, 992);
    const RA = ROUTING;
    const rows = [
      build('vcsec_ack', { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, vin: VIN, counter: 7, flags: 2, rid: RID, nonce: N1, plain: vcOk, toRouting: RA }),
      build('no_request_id', { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, vin: VIN, counter: 7, flags: 2, rid: null, nonce: N1, plain: vcOk, toRouting: RA }),
      build('empty_plaintext', { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, vin: VIN, counter: 8, flags: 2, rid: RID, nonce: N2, plain: Buffer.alloc(0), toRouting: RA }),
      build('fault_and_error_status', { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, vin: VIN, counter: 9, flags: 2, rid: RID, nonce: N3, plain: vcOk, toRouting: RA, fault: 6, opStatus: 2 }),
      // 车辆没写 from_destination.domain：官方 getter 返回 0，绝不能回退成请求的域
      build('no_from_destination', { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, vin: VIN, counter: 10, flags: 0, rid: RID, nonce: N1, plain: vcOk, toRouting: RA, noFrom: true, errCode: -3 }),
      build('broadcast_domain_byte', { domain: DOMAIN.DOMAIN_BROADCAST, vin: VIN, counter: 10, flags: 0, rid: RID, nonce: N1, plain: vcOk, toRouting: RA, noFrom: true }),
      build('infotainment', { domain: DOMAIN.DOMAIN_INFOTAINMENT, vin: VIN, counter: 3, flags: 2, rid: RID, nonce: N2, plain: vcOk, toRouting: RA }),
      build('lowercase_vin', { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, vin: VIN.toLowerCase(), counter: 4, flags: 2, rid: RID, nonce: N3, plain: vcOk, toRouting: RA }),
      build('tampered_tag', { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, vin: VIN, counter: 5, flags: 2, rid: RID, nonce: N1, plain: vcOk, toRouting: RA, tamperTag: true, errCode: -3 }),
      build('counter_mismatch', { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, vin: VIN, counter: 6, metaCounter: 5, flags: 2, rid: RID, nonce: N2, plain: vcOk, toRouting: RA, errCode: -3 }),
      build('no_response_data', { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, vin: VIN, counter: 7, flags: 2, rid: RID, nonce: N3, plain: vcOk, toRouting: RA, noRespData: true, errCode: -2 }),
      build('counter_zero_omitted', { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, vin: VIN, counter: 0, flags: 2, rid: RID, nonce: N1, plain: vcOk, toRouting: RA, expectCounter: 0 }),
    ];
    sections.push(`// tlb_v3_decrypt_response（want 为空表示只验 tag，不产出明文）\n// err 取值：0=TLB_OK -2=TLB_ERR_PROTO -3=TLB_ERR_CRYPTO\nstatic const tlb_g_resp g_resp_cases[] = {\n${rows.join('\n')}\n};`);
  }

  // ---- 解码：RoutableMessage
  {
    const siBytes = encode(V3_SPEC, 'SessionInfo', { counter: 3, publicKey: PK, epoch: EPOCH, clock_time: 1700000000 });
    const siTag = handshake.sessionInfoHmac(KEY, VIN, UUID, siBytes);
    const respNonce = prng(12, 950);
    const respTag = prng(16, 951);
    const REQ_UUID = prng(16, 952);

    const row = (nm, obj, e) => {
      const bytes = encode(V3_SPEC, 'RoutableMessage', obj);
      const cells = [
        `"${nm}"`, bt(bytes, 'd_rm_bytes'), `${e.known}`,
        `${e.htd || 0}`, `${e.td || 0}`, `${e.hfd || 0}`, `${e.fd || 0}`,
        bt(e.from_routing, 'd_rm_ra'),
        bt(e.payload, 'd_rm_pl'), `${e.hp || 0}`,
        bt(e.si, 'd_rm_si'), `${e.hsi || 0}`,
        `${e.hs || 0}`, `${e.os || 0}`, `${e.fault || 0}`,
        bt(e.request_uuid, 'd_rm_ruuid'),
        bt(e.uuid, 'd_rm_uuid'), `${e.flags || 0}`,
        bt(e.signer_pk, 'd_rm_spk'), bt(e.si_tag, 'd_rm_sitag'),
        bt(e.gp_epoch, 'd_rm_e'), `${e.gp_has_counter || 0}`, `${e.gp_counter || 0}`,
        `${e.gp_has_expires || 0}`, `${e.gp_expires || 0}`, bt(e.gp_tag, 'd_rm_t'),
        bt(e.resp_nonce, 'd_rm_rn'), `${e.r_has_counter || 0}`, `${e.r_counter || 0}`,
        bt(e.resp_tag, 'd_rm_rt'),
      ];
      return `    { ${cells.join(', ')} },`;
    };

    const rows = [];
    // 1) 车辆握手回包
    rows.push(row('handshake_response', {
      to_destination: { routing_address: ROUTING },
      from_destination: { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY },
      session_info: siBytes,
      signature_data: { session_info_tag: { tag: siTag } },
      uuid: UUID,
    }, { known: 5, hfd: 1, fd: DOMAIN.DOMAIN_VEHICLE_SECURITY, si: siBytes, hsi: 1, si_tag: siTag, uuid: UUID }));
    // 2) 明文受理帧（payload 是 FromVCSECMessage{commandStatus{OK}}）
    const vcOk = encode(V3_SPEC, 'FromVCSECMessage', { commandStatus: { operationStatus: 0 } });
    rows.push(row('plain_ack', {
      from_destination: { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY },
      protobuf_message_as_bytes: vcOk,
      uuid: UUID,
    }, { known: 3, hfd: 1, fd: DOMAIN.DOMAIN_VEHICLE_SECURITY, payload: vcOk, hp: 1, uuid: UUID }));
    // 3) ENCRYPT_RESPONSE 加密回包
    rows.push(row('encrypted_ack', {
      from_destination: { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY },
      signedMessageStatus: { operation_status: 1, signed_message_fault: 6 },
      signature_data: { AES_GCM_Response_data: { nonce: respNonce, counter: 7, tag: respTag } },
      flags: 2,
    }, { known: 4, hfd: 1, fd: DOMAIN.DOMAIN_VEHICLE_SECURITY, hs: 1, os: 1, fault: 6, resp_nonce: respNonce, r_has_counter: 1, r_counter: 7, resp_tag: respTag, flags: 2 }));
    // 4) 我方命令的线格式回读（GCM_PERSONALIZED 全字段）
    const gpm = aeadMod.encryptCommand({
      domain: DOMAIN.DOMAIN_VEHICLE_SECURITY, vin: VIN, session: { key: KEY, epoch: EPOCH, counter: 0, anchor: 1700000000 },
      publicKey: PK, payload: codec.encodeUnsignedMessage({ RKEAction: 0 }), flags: 0, expiresInSeconds: 5,
      routingAddress: ROUTING, uuid: UUID, nonce: NONCE, now: 1700000000,
    });
    rows.push(row('own_command', {
      to_destination: { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY },
      from_destination: { routing_address: ROUTING },
      protobuf_message_as_bytes: gpm.ciphertext,
      signature_data: { signer_identity: { public_key: PK }, AES_GCM_Personalized_data: gpm.message.signature_data.AES_GCM_Personalized_data },
      uuid: UUID,
    }, { known: 5, htd: 1, td: DOMAIN.DOMAIN_VEHICLE_SECURITY, from_routing: ROUTING, payload: gpm.ciphertext, hp: 1, signer_pk: PK, gp_epoch: EPOCH, gp_has_counter: 1, gp_counter: gpm.counter, gp_has_expires: 1, gp_expires: gpm.expiresAt, gp_tag: gpm.tag, uuid: UUID }));
    // 5) signer_identity 与 session_info_tag 同时出现：解出的两个值都必须在（回归：曾用同一解析函数互相覆盖）
    let both = null;
    try {
      both = row('signer_and_tag', {
        from_destination: { domain: DOMAIN.DOMAIN_VEHICLE_SECURITY },
        signature_data: { signer_identity: { public_key: PK }, session_info_tag: { tag: siTag } },
        session_info: siBytes,
      }, { known: 3, hfd: 1, fd: DOMAIN.DOMAIN_VEHICLE_SECURITY, signer_pk: PK, si_tag: siTag, si: siBytes, hsi: 1 });
    } catch (e) {
      console.warn('[gen_goldens] 跳过 signer_and_tag（探针拒绝双 oneof 成员）：' + e.message);
    }
    if (both) rows.push(both);
    // 6) 只有 session_info（status=1 的拒绝帧在 frame 层的形态）
    const siDecline = encode(V3_SPEC, 'SessionInfo', { status: 1 });
    rows.push(row('decline_session_info', { session_info: siDecline }, { known: 1, si: siDecline, hsi: 1 }));
    // 7) 回指我方请求的 request_uuid：配对闸门与握手 challenge 的取值来源（探针 field 50）
    rows.push(row('request_uuid_pair', {
      from_destination: { domain: DOMAIN.DOMAIN_INFOTAINMENT },
      request_uuid: REQ_UUID,
      uuid: UUID,
    }, { known: 3, hfd: 1, fd: DOMAIN.DOMAIN_INFOTAINMENT, request_uuid: REQ_UUID, uuid: UUID }));
    sections.push(`// tlb_msg_decode_rm 用例\nstatic const tlb_g_decrm g_decrm_cases[] = {\n${rows.join('\n')}\n};`);
  }

  // ---- 解码：SessionInfo
  {
    const row = (nm, obj, e) => {
      const bytes = encode(V3_SPEC, 'SessionInfo', obj);
      const cells = [
        `"${nm}"`, bt(bytes, 'd_si_bytes'), `${e.known}`,
        `${e.counter === undefined ? 0 : e.counter >>> 0}`, `${e.has_counter || 0}`,
        bt(e.pk, 'd_si_pk'), bt(e.epoch, 'd_si_epoch'),
        `${e.clock === undefined ? 0 : e.clock >>> 0}`, `${e.has_clock || 0}`,
        `${e.status === undefined ? 0 : e.status >>> 0}`, `${e.has_status || 0}`,
        `${e.handle === undefined ? 0 : e.handle >>> 0}`, `${e.has_handle || 0}`,
      ];
      return `    { ${cells.join(', ')} },`;
    };
    const rows = [
      row('full', { counter: 7, publicKey: PK, epoch: EPOCH, clock_time: 1700000000, handle: 3 },
        { known: 5, counter: 7, has_counter: 1, pk: PK, epoch: EPOCH, clock: 1700000000, has_clock: 1, handle: 3, has_handle: 1 }),
      row('minimal', { epoch: EPOCH, publicKey: PK }, { known: 2, pk: PK, epoch: EPOCH }),
      row('not_whitelisted', { epoch: EPOCH, status: 1 }, { known: 2, epoch: EPOCH, status: 1, has_status: 1 }),
      row('counter_zero', { counter: 0, epoch: EPOCH }, { known: 1, epoch: EPOCH }),
      row('clock_zero_status_ok', { epoch: EPOCH, clock_time: 0, status: 0 }, { known: 1, epoch: EPOCH }),
    ];
    sections.push(`// tlb_msg_decode_session_info 用例（0 值在 oneof 外会被省略，has_* 必须为 0）\nstatic const tlb_g_decsi g_decsi_cases[] = {\n${rows.join('\n')}\n};`);
  }

  // ---- 解码：FromVCSECMessage（同时验证 rm_known == 0 的降级判据）
  {
    // e.bytes：直接给原始字节。FromVCSECMessage 整条是 oneof，探针 encode 会拒绝一次给两个成员，
    // 但车辆实际可能连发多条；「多字段 known 计数」只能靠手工拼接字节覆盖。
    const row = (nm, obj, e) => {
      const bytes = e.bytes !== undefined ? e.bytes : encode(V3_SPEC, 'FromVCSECMessage', obj);
      let rmKnown = 0;
      try {
        const o = decode(V3_SPEC, 'RoutableMessage', bytes);
        rmKnown = Object.keys(o).filter((k) => k.charAt(0) !== 'f').length;
      } catch (err) {
        rmKnown = 0;
      }
      const cells = [
        `"${nm}"`, bt(bytes, 'd_vc_bytes'), `${rmKnown}`, `${e.known}`,
        `${e.hcs || 0}`, `${e.os === undefined ? 0 : e.os}`, `${e.has_op || 0}`,
        `${e.sm_counter === undefined ? 0 : e.sm_counter}`, `${e.has_sm_counter || 0}`,
        `${e.smi === undefined ? 0 : e.smi}`, `${e.has_smi || 0}`,
        `${e.has_wl_status || 0}`, `${e.wl_info === undefined ? 0 : e.wl_info}`, `${e.has_wl_info || 0}`,
        `${e.wl_op === undefined ? 0 : e.wl_op}`, `${e.has_wl_op || 0}`,
        `${e.has_vehicle_status || 0}`, `${e.has_nominal_error || 0}`, `${e.nominal === undefined ? 0 : e.nominal}`,
      ];
      return `    { ${cells.join(', ')} },`;
    };
    const rows = [
      row('wait', { commandStatus: { operationStatus: 1 } }, { known: 1, hcs: 1, os: 1, has_op: 1 }),
      row('ok_empty', { commandStatus: {} }, { known: 1, hcs: 1 }),
      row('error_with_signed_status', { commandStatus: { operationStatus: 2, signedMessageStatus: { counter: 5, signedMessageInformation: 6 } } },
        { known: 1, hcs: 1, os: 2, has_op: 1, sm_counter: 5, has_sm_counter: 1, smi: 6, has_smi: 1 }),
      row('whitelist_final', { commandStatus: { whitelistOperationStatus: { whitelistOperationInformation: 3, operationStatus: 2, signerOfOperation: { publicKeySHA1: prng(20, 960) } } } },
        { known: 1, hcs: 1, has_wl_status: 1, wl_info: 3, has_wl_info: 1, wl_op: 2, has_wl_op: 1 }),
      row('whitelist_wait', { commandStatus: { operationStatus: 1, whitelistOperationStatus: {} } },
        { known: 1, hcs: 1, os: 1, has_op: 1, has_wl_status: 1 }),
      row('nominal_error', { nominalError: { genericError: 1 } }, { known: 1, has_nominal_error: 1, nominal: 1 }),
      row('vehicle_status', { vehicleStatus: { vehicleLockState: 2, closureStatuses: { frontDriverDoor: 1 } } },
        { known: 1, has_vehicle_status: 1 }),
      row('status_then_entry', null,
        { bytes: Buffer.concat([
            encode(V3_SPEC, 'FromVCSECMessage', { vehicleStatus: { vehicleLockState: 1 } }),
            encode(V3_SPEC, 'FromVCSECMessage', { whitelistEntryInfo: { keyId: { publicKeySHA1: prng(20, 961) } } }),
          ]),
          known: 2, has_vehicle_status: 1 }),
    ];
    sections.push(`// tlb_msg_decode_from_vcsec 用例；rm_known 是探针 parseFrame 用来决定「这不是 RoutableMessage」的判据\nstatic const tlb_g_decvc g_decvc_cases[] = {\n${rows.join('\n')}\n};`);
  }
}
await protocolSections();

// ---------------------------------------------------------------- 分帧
// 用探针的 FrameReassembler 本体产出期望值：把 Date.now 换成脚本时钟，
// 每一步的记录（切出的帧、丢弃次数、剩余缓冲）就是 C 侧必须复现的行为。
async function frameSections() {
  const url = (p) => new URL('file:///' + resolve(PROBE, p).replace(/\\/g, '/') + '').href;
  let fr;
  try {
    fr = await import(url('src/infra/ble/frame-codec.js'));
  } catch (e) {
    console.warn('[gen_goldens] 跳过分帧金标准：无法加载 frame-codec.js：' + e.message);
    return;
  }
  const { prependLength, FrameReassembler, RX_IDLE_MS, MAX_FRAME } = fr;

  const realNow = Date.now;
  const wire = (n, seed) => Buffer.from(prependLength(prng(n, seed)));
  const rows = [];
  let idx = 0;
  try {
    const script = (name, steps) => {
      let clock = 0;
      Date.now = () => clock;
      const frames = [];
      const re = new FrameReassembler({ onFrame: (f) => frames.push(Buffer.from(f)) });
      const ps = [];
      for (const [gap, chunk] of steps) {
        clock += gap;
        const c = cbytes('fr_in', chunk);
        ps.push(`{ ${c.id}, ${c.len}, ${clock} }`);
        re.push(chunk);
      }
      const blob = cbytes('fr_frames', Buffer.concat(frames));
      const lens = frames.map((f) => f.length).join(', ');
      const arrName = 'fr_' + idx + '_push';
      const lenName = 'fr_' + idx + '_len';
      decls.push(`static const tlb_g_frame_push ${arrName}[] = { ${ps.join(', ')} };`);
      decls.push(`static const size_t ${lenName}[] = { ${lens || '0'} };`);
      rows.push(
        `    { "${name}", ${arrName}, ${ps.length}, ${blob.id}, ${blob.len}, ${lenName}, ` +
          `${frames.length}, ${re.dropped}, ${re.buffer.length} },`
      );
      idx++;
    };

    // 1) 单包整帧 / 前缀切开 / 三包拼一帧
    script('single', [[0, wire(40, 1101)]]);
    script('split_prefix', [[0, wire(20, 1102).subarray(0, 1)], [5, wire(20, 1102).subarray(1)]]);
    const w33 = wire(33, 1103);
    script('three_pieces', [[0, w33.subarray(0, 1)], [3, w33.subarray(1, 6)], [3, w33.subarray(6)]]);
    // 2) 一次通知带来两帧完整数据
    script('two_in_one', [[0, Buffer.concat([wire(17, 1104), wire(29, 1105)])]]);
    // 3) 第一帧 + 第二帧的开头（发送方不清 buffer，必须继续拼）
    const A = wire(15, 1106), B = wire(41, 1107);
    script('frame_then_partial', [
      [0, Buffer.concat([A, B.subarray(0, 4)])],
      [7, B.subarray(4)],
    ]);
    // 4) 分包静默刚好等于 RX_IDLE_MS：不清（判据是严格大于）
    const C1 = wire(30, 1108);
    script('idle_boundary_exact', [
      [0, C1.subarray(0, 8)],
      [RX_IDLE_MS, Buffer.concat([C1.subarray(8), wire(12, 1109)])],
    ]);
    // 5) 分包静默超过 RX_IDLE_MS：残字节是垃圾，整块作废后重新对齐
    const D = wire(30, 1110);
    script('idle_timeout', [[0, D.subarray(0, 8)], [RX_IDLE_MS + 1, D.subarray(8)]]);
    // 6) 声明长度越界：整块丢弃并立即 return，绝不跳过 2 字节重新找头
    script('oversized_declared', [[0, Buffer.concat([Buffer.from([0x04, 0x01]), prng(20, 1111)])]]);
    script('declared_ffff', [[0, Buffer.from([0xff, 0xff])]]);
    // 7) 越界帧后面还跟着正常帧：探针不重新找头，所以正常帧也被一起丢掉
    script('oversized_then_valid', [[0, Buffer.concat([Buffer.from([0x08, 0x01]), wire(20, 1112)])]]);
    // 8) 零长度帧（协议上不该出现，但要锁住行为）
    script('zero_length_frame', [[0, Buffer.from([0x00, 0x00])]]);
    // 9) 空 chunk / 单字节 chunk
    script('empty_chunk', [[0, Buffer.alloc(0)], [1, Buffer.from([0x00])]]);
    // 10) 恰好 1024 字节的单帧（边界）+ 1025（越界）
    script('max_frame', [[0, wire(MAX_FRAME, 1113)]]);
    script('over_max_frame', [[0, wire(MAX_FRAME + 1, 1114)]]);
    // 11) 越界后紧接着的干净帧必须能重新收进来（重新对齐）
    script('resync_after_oversize', [
      [0, Buffer.from([0xff, 0xff])],
      [4, wire(24, 1115)],
    ]);
    // 12) 真实形态：握手响应 65 字节公钥拆成多包（MTU 20）
    {
      const w = wire(66, 1116);
      const steps = [];
      for (let off = 0; off < w.length; off += 20) steps.push([2, w.subarray(off, Math.min(off + 20, w.length))]);
      script('mtu20_multipart', steps);
    }
    sections.push(`// tlb_frame_push 用例（期望值取自探针 FrameReassembler；dropped 为丢弃事件数）\nstatic const tlb_g_frame g_frame_cases[] = {\n${rows.join('\n')}\n};`);

    // ---- prependLength / stripLength 纯函数
    const pRows = [];
    for (const n of [0, 1, 2, 20, 255, 256, MAX_FRAME]) {
      const m = prng(n, 1201 + n);
      const w = cbytes('fp_msg', m);
      const o = cbytes('fp_want', Buffer.from(prependLength(m)));
      pRows.push(`    { "prepend/${n}", ${w.id}, ${w.len}, ${o.id}, ${o.len} },`);
    }
    sections.push(`// prependLength：2 字节大端前缀\nstatic const tlb_g_prepend g_prepend_cases[] = {\n${pRows.join('\n')}\n};`);

    const sRows = [];
    const mk = (nm, buf, ok, want) => {
      const b = cbytes('fs_in', buf);
      const w = want === undefined ? { id: 'NULL', len: 0 } : cbytes('fs_want', want);
      sRows.push(`    { "${nm}", ${b.id}, ${b.len}, ${ok ? 1 : 0}, ${w.id}, ${w.len} },`);
    };
    {
      const m = prng(24, 1300);
      mk('exact', Buffer.from(prependLength(m)), true, m);
      mk('empty_body', Buffer.from(prependLength(Buffer.alloc(0))), true, Buffer.alloc(0));
      mk('too_short', Buffer.from([0x00]), false);
      mk('declared_long', Buffer.concat([Buffer.from([0x00, 0x05]), prng(2, 1301)]), false);
      mk('declared_short', Buffer.concat([Buffer.from([0x00, 0x01]), prng(3, 1302)]), false);
      mk('zero_prefix_extra', Buffer.concat([Buffer.from([0x00, 0x00]), prng(3, 1303)]), false);
    }
    sections.push(`// stripLength：长度前缀不符即「这一帧作废」\nstatic const tlb_g_strip g_strip_cases[] = {\n${sRows.join('\n')}\n};`);
  } finally {
    Date.now = realNow;
  }
}
await frameSections();

// ---------------------------------------------------------------- 调度层（tlb_dispatch）
// 下标必须与 tlb_dispatch.h 的枚举逐一对应；whitelistInfo / whitelistEntry 本核心不解析内层，
// 落到同一个 TLB_APP_OTHER=7（summary.js:101-113）。
const ACT_IDX = { pass: 0, busy: 1, resync: 2, fail: 3 };
const KIND_IDX = { empty: 0, refused: 1, whitelist: 2, signed: 3, command: 4, error: 5,
                   status: 6, other: 7, whitelistInfo: 7, whitelistEntry: 7 };
const SKIP_IDX = { none: 0, addr: 1, uuid: 2, domain: 3, decrypt: 4, parse: 5 };

// 生成器原先只产字节表；文案表需要 C 字面量。非 ASCII 一律走 3 位八进制转义，
// goldens.h 便与源文件编码无关，也不会踩 -Wmultichar。
function cesc(s) {
  let out = '"';
  const b = Buffer.from(String(s), 'utf8');
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c >= 0x20 && c < 0x7f) out += String.fromCharCode(c);
    else out += '\\' + c.toString(8).padStart(3, '0');
  }
  return out + '"';
}

async function dispatchSections() {
  const url = (p) => new URL('file:///' + resolve(PROBE, p).replace(/\\/g, '/') + '').href;
  let P, D, H;
  try {
    P = await import(url('src/protocol/index.js'));
    D = await import(url('src/domain/command-dispatcher.js'));
    H = await import(url('src/domain/response-hints.js'));
  } catch (e) {
    console.warn('[gen_goldens] 跳过调度层金标准（探针模块导入失败）：' + e.message);
    return;
  }
  const { encode, decode, inspect, V3_SPEC, DOMAIN, UM, label, summarizeVcsec } = P;
  const { protoOutcome, appOutcome, genericErrorHint, decodeFrame } = D;
  const FVM = 'FromVCSECMessage';
  const VC = DOMAIN.DOMAIN_VEHICLE_SECURITY, INFO = DOMAIN.DOMAIN_INFOTAINMENT;
  const GE = (k) => {
    const v = V3_SPEC.enums.GenericError_E[k];
    if (v === undefined) throw new Error('GenericError_E 没有 ' + k);
    return v;
  };
  const VIN = '5YJ3E1EA7KF000000'; // 假 VIN 夹具（上架脱敏）
  const CTX_ADDR = prng(16, 9001), CTX_UUID = prng(16, 9002), REQ_ID = prng(16, 9003);
  const OTHER_ADDR = prng(16, 9004), OTHER_UUID = prng(16, 9005), SES_KEY = prng(16, 9006);
  const CT = prng(20, 9007), R_NONCE = prng(12, 9008), R_TAG = prng(16, 9009), WL_SHA = prng(20, 9010);
  // 期望值一律从「探针把自己的编码回读一遍」的结果实算，避免 encode 省略 0 值时预期错位
  const rtv = (src) => {
    const b = encode(V3_SPEC, FVM, src);
    return { b, o: decode(V3_SPEC, FVM, b) };
  };

  // ---- 0) 配对闸门用的随机线索：C 侧构造 tlb_frame_ctx_t 必须取同样字节
  {
    const blobs = [['addr', CTX_ADDR], ['uuid', CTX_UUID], ['req', REQ_ID]];
    const rows = [];
    for (const [nm, b] of blobs) {
      const w = cbytes('gctx', b);
      rows.push(`    { "${nm}", ${w.id}, ${w.len} },`);
    }
    sections.push(`// 调度层用例上下文（顺序固定：路由地址 / request_uuid 模板 / 本次请求 id）\nstatic const tlb_g_blob g_dispatch_ctx[] = {\n${rows.join('\n')}\n};`);
  }

  // ---- 1) 协议层终态：tlb_proto_outcome
  {
    const faults = [0, 1, 2, 5, 6, 11, 15, 17, 20, 24, 25, 26, 99];
    const ops = [0, UM.OPERATIONSTATUS_WAIT, UM.OPERATIONSTATUS_ERROR];
    const rows = [];
    for (const f of faults) {
      for (const op of ops) {
        const r = protoOutcome(f, op);
        rows.push(`    { "p${f}o${op}", ${f}, ${op}, ${ACT_IDX[r.action]}, ${cesc(r.text || '')} },`);
      }
    }
    sections.push(`// tlb_proto_outcome（PASS 分支探针不带 text，期望值为空串）\nstatic const tlb_g_proto g_proto_cases[] = {\n${rows.join('\n')}\n};`);
  }

  // ---- 2) 应用层终态：tlb_app_outcome（入参是解码后的 FromVCSECMessage 字节）
  {
    const W = UM.OPERATIONSTATUS_WAIT, E = UM.OPERATIONSTATUS_ERROR;
    const cases = [
      ['a01_empty', {}, VC],
      ['a02_nominal_unauth', { nominalError: { genericError: GE('GENERICERROR_UNAUTHORIZED') } }, VC],
      ['a03_nominal_not_allowed', { nominalError: { genericError: GE('GENERICERROR_NOT_ALLOWED_OVER_TRANSPORT') } }, VC],
      ['a04_cmd_wait', { commandStatus: { operationStatus: W } }, VC],
      ['a05_cmd_error_bare', { commandStatus: { operationStatus: E } }, VC],
      ['a06_cmd_error_signed_status', { commandStatus: { operationStatus: E, signedMessageStatus: { counter: 5, signedMessageInformation: 6 } } }, VC],
      ['a07_cmd_error_wl_info3', { commandStatus: { operationStatus: E, whitelistOperationStatus: { whitelistOperationInformation: 3 } } }, VC],
      ['a08_cmd_error_wl_info0', { commandStatus: { operationStatus: E, whitelistOperationStatus: { whitelistOperationInformation: 0, operationStatus: 1 } } }, VC],
      ['a09_cmd_ok', { commandStatus: { operationStatus: 0 } }, VC],
      ['a10_nominal_info_domain', { nominalError: { genericError: GE('GENERICERROR_UNAUTHORIZED') } }, INFO],
      ['a11_cmd_wait_info_domain', { commandStatus: { operationStatus: W } }, INFO],
    ];
    const rows = [];
    for (const [nm, src, dom] of cases) {
      const { b, o } = rtv(src);
      const r = appOutcome(o, dom);
      const w = cbytes('ga_bytes', b);
      rows.push(`    { "${nm}", ${w.id}, ${w.len}, ${dom}, ${ACT_IDX[r.action]}, ${cesc(r.text || '')} },`);
    }
    sections.push(`// tlb_app_outcome（偏离：本核心非 VCSEC 域一律 PASS，与探针在 INFO 域读不到 actionStatus 的结果同义）\nstatic const tlb_g_appout g_appout_cases[] = {\n${rows.join('\n')}\n};`);
  }

  // ---- 3) 应用层文案：tlb_summarize_vcsec
  // 注意：vehicleStatus / whitelistInfo / whitelistEntryInfo 只给「空子消息」——
  // 本核心不解析其内层（C 文件头偏离 3），填了内层字段就成了两边不同的期望。
  {
    const cases = [
      ['s01_empty_object', {}],
      ['s02_command_error', { commandStatus: { operationStatus: UM.OPERATIONSTATUS_ERROR } }],
      ['s03_command_bare', { commandStatus: {} }],
      ['s04_signed_full', { commandStatus: { operationStatus: 1, signedMessageStatus: { counter: 7, signedMessageInformation: 3 } } }],
      ['s05_signed_bare', { commandStatus: { operationStatus: 2, signedMessageStatus: {} } }],
      ['s06_whitelist_full', { commandStatus: { operationStatus: 1, whitelistOperationStatus: { operationStatus: 2, whitelistOperationInformation: 3, signerOfOperation: { publicKeySHA1: WL_SHA } } } }],
      ['s07_whitelist_bare', { commandStatus: { whitelistOperationStatus: {} } }],
      ['s08_nominal_error', { nominalError: { genericError: GE('GENERICERROR_VEHICLE_NOT_IN_PARK') } }],
      ['s09_vehicle_status', { vehicleStatus: {} }],
      ['s10_whitelist_info', { whitelistInfo: {} }],
      ['s11_whitelist_entry', { whitelistEntryInfo: {} }],
    ];
    const rows = [];
    for (const [nm, src] of cases) {
      const { b, o } = rtv(src);
      const s = summarizeVcsec(o);
      const w = cbytes('gs_bytes', b);
      rows.push(`    { "${nm}", ${w.id}, ${w.len}, ${KIND_IDX[s.kind]}, ${s.status || 0},`
        + ` ${s.counter === undefined ? 0 : s.counter}, ${s.counter === undefined ? 0 : 1}, ${cesc(s.text)} },`);
    }
    sections.push(`// tlb_summarize_vcsec（kind 下标见 tlb_app_kind_t）\nstatic const tlb_g_sum g_sum_cases[] = {\n${rows.join('\n')}\n};`);
  }

  // ---- 4) GenericError 提示：tlb_generic_error_hint_text
  {
    const rows = [];
    const keys = Object.keys(H.GENERIC_ERROR_HINTS);
    keys.forEach((k, i) => {
      const inp = 'nominalError ' + label('GenericError_E', GE(k));
      rows.push(`    { "h${i}_${k}", ${cesc(inp)}, ${cesc(genericErrorHint(inp))} },`);
    });
    const extras = [
      ['h_empty', ''],
      ['h_none', 'nominalError ' + label('GenericError_E', 0)],
      ['h_unknown', 'nominalError 未知(99)'],
      ['h_other_branch', inspect(V3_SPEC, FVM, rtv({ commandStatus: { operationStatus: 2 } }).o)],
    ];
    for (const [nm, inp] of extras) {
      rows.push(`    { "${nm}", ${cesc(inp)}, ${cesc(genericErrorHint(inp))} },`);
    }
    sections.push(`// tlb_generic_error_hint_text（探针 genericErrorHint：按键序 indexOf 首个命中）\nstatic const tlb_g_hint g_hint_cases[] = {\n${rows.join('\n')}\n};`);
  }

  // ---- 5) 单帧判读：tlb_decode_frame
  {
    const fr = [];
    const rm = (o) => encode(V3_SPEC, 'RoutableMessage', o);
    const pushFrame = (nm, bytes, extra, sessionKey) => {
      const ctx = Object.assign({ name: 'UNLOCK', domain: VC, vin: VIN, routingAddress: CTX_ADDR,
                                  uuid: CTX_UUID, requestId: REQ_ID, session: null, previous: [] },
                                extra || {});
      if (sessionKey) ctx.session = { key: sessionKey };
      let r;
      try {
        r = decodeFrame(bytes, ctx);
      } catch (e) {
        console.warn(`[gen_goldens] 跳过帧用例 ${nm}（探针 decodeFrame 抛错）：${e.message}`);
        return;
      }
      const skipped = r.skipped === true;
      const t = r.text || '';
      let skip = 0;
      if (skipped) {
        if (t.indexOf('串台帧：路由地址 ') >= 0) skip = SKIP_IDX.addr;
        else if (t.indexOf('串台帧：request_uuid ') >= 0) skip = SKIP_IDX.uuid;
        else if (t.indexOf('串台帧：来自 ') >= 0) skip = SKIP_IDX.domain;
        else if (t.indexOf(' 响应解密失败：') >= 0) skip = SKIP_IDX.decrypt;
        // 「响应解析失败」带 pb.js 抛错原文，C 统一成固定串（C 文件头偏离 6）→ 该类用例不进金标准
        else { console.warn(`[gen_goldens] 跳过帧用例 ${nm}：skip 类别不在预期内（偏离 6）`); return; }
      }
      const marker = ' 响应解密失败：';
      const ia = t.indexOf(marker), ib = t.indexOf('（本帧 ');
      let text = t;
      if (skip === SKIP_IDX.decrypt) {
        if (ia < 0 || ib <= ia) { console.warn(`[gen_goldens] 跳过帧用例 ${nm}：解密失败文案结构不符预期`); return; }
        // 探针把「期望/实际 tag + 逐字段试算」都塞进 d.error（多行），C 只保留首行（偏离 5）
        text = t.slice(0, ia + marker.length) + t.slice(ia + marker.length, ib).split('\n')[0] + t.slice(ib);
      } else if (t.indexOf('\n') >= 0) {
        console.warn(`[gen_goldens] 跳过帧用例 ${nm}：期望文案含换行`);
        return;
      }
      const app = skipped ? null : r.app;
      const w = cbytes('gd_bytes', bytes);
      const k = sessionKey ? cbytes('gd_key', sessionKey) : { id: 'NULL', len: 0 };
      fr.push(`    { "${nm}", ${w.id}, ${w.len}, ${skipped ? 1 : 0}, ${skip}, ${r.refused === true ? 1 : 0},`
        + ` ${r.fault || 0}, ${r.opStatus || 0}, ${app ? KIND_IDX[app.kind] : 0}, ${app ? (app.status || 0) : 0},`
        + ` ${cesc(app ? app.text : '')}, ${cesc(text)}, ${k.id}, ${k.len} },`);
    };
    const PAY = encode(V3_SPEC, FVM, { commandStatus: { operationStatus: UM.OPERATIONSTATUS_ERROR } });
    const NPE = encode(V3_SPEC, FVM, { nominalError: { genericError: GE('GENERICERROR_VEHICLE_NOT_IN_PARK') } });

    // 1~2) 裸 FromVCSECMessage（加白名单 PRESENT_KEY 老路）：不是 RoutableMessage，直接判读
    pushFrame('f01_bare_nominal', encode(V3_SPEC, FVM, { nominalError: { genericError: GE('GENERICERROR_UNAUTHORIZED') } }));
    pushFrame('f02_bare_empty', Buffer.alloc(0));
    // 3~4) 明文响应：有载荷 / 空载荷（空载荷 = 受理但应用层无字段）
    pushFrame('f03_plain_payload', rm({ protobuf_message_as_bytes: PAY }));
    pushFrame('f04_empty_payload', rm({ protobuf_message_as_bytes: Buffer.alloc(0) }));
    // 5) 协议层错误帧：fault=25 且一个密文字节都没发 → 不试解密
    pushFrame('f05_proto_error_frame', rm({ signedMessageStatus: { signed_message_fault: 25 },
      signature_data: { AES_GCM_Response_data: { nonce: R_NONCE, counter: 1, tag: R_TAG } } }));
    // 6~8) 三道配对闸门
    pushFrame('f06_gate_addr', rm({ to_destination: { routing_address: OTHER_ADDR }, protobuf_message_as_bytes: PAY }));
    pushFrame('f07_gate_uuid', rm({ request_uuid: OTHER_UUID, protobuf_message_as_bytes: PAY }));
    pushFrame('f08_gate_domain', rm({ from_destination: { domain: INFO }, protobuf_message_as_bytes: PAY }));
    // 9) 闸门线索齐全且对得上 → 放行
    pushFrame('f09_gate_pass', rm({ to_destination: { routing_address: CTX_ADDR }, protobuf_message_as_bytes: NPE }));
    // 10) 密文解不开（tag 是随机的）→ skipped + 「响应解密失败」
    pushFrame('f10_decrypt_fail', rm({ protobuf_message_as_bytes: CT,
      signature_data: { AES_GCM_Response_data: { nonce: R_NONCE, counter: 3, tag: R_TAG } } }), null, SES_KEY);

    if (fr.length) {
      sections.push(`// tlb_decode_frame 单帧判读（key!=NULL 表示本次已有共享会话）\nstatic const tlb_g_dframe g_dframe_cases[] = {\n${fr.join('\n')}\n};`);
    } else {
      console.warn('[gen_goldens] 调度层单帧表为空（探针 decodeFrame 用例全部被跳过），不落盘');
    }
  }

  // ---- 6) 端到端重发循环：tlb_send_request
  // 桩 store/app-state.js 的 state（探针各模块都读同一个对象），让探针跑完真实的
  // sendRequest：期望文案全部由它自己产出，测试里不自证预期。
  // 时间：探针用真实 Date.now()，所以 maxMs 只取「100 / 2000 / 20000」这类与 sleep 粒度
  // （500 / 1000ms）差一个数量级的值，两侧分支判定必然一致。
  {
    const S = (await import(url('src/store/app-state.js'))).state;
    const { doneCommand, doneWhitelist } = D;
    const PRIV = prng(32, 9101);
    const PUB65 = Buffer.concat([Buffer.from([0x04]), prng(64, 9102)]);
    const rmE = (o) => encode(V3_SPEC, 'RoutableMessage', o);
    const GATE = encode(V3_SPEC, FVM, { commandStatus: { operationStatus: UM.OPERATIONSTATUS_ERROR } });
    const W = UM.OPERATIONSTATUS_WAIT;
    const FR = {
      ack: rmE({ protobuf_message_as_bytes: encode(V3_SPEC, FVM, { commandStatus: {} }) }),
      wait: rmE({ protobuf_message_as_bytes: encode(V3_SPEC, FVM, { commandStatus: { operationStatus: W } }) }),
      unauth: rmE({ protobuf_message_as_bytes: encode(V3_SPEC, FVM, { nominalError: { genericError: GE('GENERICERROR_UNAUTHORIZED') } }) }),
      f6: rmE({ signedMessageStatus: { signed_message_fault: 6 },
               signature_data: { AES_GCM_Response_data: { nonce: R_NONCE, counter: 1, tag: R_TAG } } }),
      f25: rmE({ signedMessageStatus: { signed_message_fault: 25 },
                 signature_data: { AES_GCM_Response_data: { nonce: R_NONCE, counter: 1, tag: R_TAG } } }),
      gaddr: rmE({ to_destination: { routing_address: OTHER_ADDR }, protobuf_message_as_bytes: GATE }),
      guuid: rmE({ request_uuid: OTHER_UUID, protobuf_message_as_bytes: GATE }),
      gdom: rmE({ from_destination: { domain: INFO }, protobuf_message_as_bytes: GATE }),
    };
    const PAY_B = Buffer.from([0x12, 0x34]);
    const PAY = cbytes('gsp_pay', PAY_B);
    const DONE_IDX = { always: 0, command: 1, whitelist: 2 };
    let sqi = 0;

    const mkBle = (queue, sticky, mtu, throwSend) => {
      let i = 0;
      const next = () => {
        if (i >= queue.length) {
          if (!sticky || !queue.length) return null;
          i = queue.length - 1;
        }
        return Uint8Array.from(queue[i++]);
      };
      const b = { connected: true, receive: async () => next() };
      b.send = throwSend ? async () => { throw new Error('链路错误'); } : async () => next();
      if (mtu !== undefined) b.mtu = mtu;
      return b;
    };

    const rows = [];
    const run = async (nm, opt) => {
      const queue = opt.queue || [];
      S.vin = opt.vin === undefined ? VIN : opt.vin;
      S.v3 = {};
      S.privateKey = opt.noKey ? null : PRIV;
      S.publicKey = opt.noKey ? null : PUB65;
      S.ble = opt.disconnected ? null : mkBle(queue, opt.sticky, opt.mtu, opt.throwSend);
      const domain = opt.domain === undefined ? VC : opt.domain;
      const done = opt.done === 'command' ? doneCommand : (opt.done === 'whitelist' ? doneWhitelist : undefined);
      let r = null, thrown = '';
      try {
        r = await D.sendRequest({ name: opt.name, domain, payload: Uint8Array.from(PAY_B), plain: !!opt.plain,
                                  maxMs: opt.maxMs, done });
      } catch (e) {
        thrown = (e && e.message) || String(e);
      }
      let mt = '';
      if (S.ble) { try { mt = H.mtuNote() || ''; } catch (e) { mt = ''; } }
      let qArr = 'NULL', qn = 0;
      if (queue.length) {
        const items = queue.map((b) => { const w = cbytes('gss_', b); return `{ NULL, ${w.id}, ${w.len} }`; });
        qArr = 'gss_' + (sqi++) + '_q';
        decls.push(`static const tlb_g_blob ${qArr}[] = { ${items.join(', ')} };`);
        qn = items.length;
      }
      rows.push(`    { "${nm}", ${cesc(opt.name || '')}, ${opt.plain ? 1 : 0}, ${domain}, `
        + `${DONE_IDX[opt.done || 'always']}, ${opt.maxMs || 0}, ${opt.sticky ? 1 : 0}, `
        + `${qArr}, ${qn}, ${PAY.id}, ${PAY.len}, ${opt.disconnected ? 0 : 1}, ${opt.noKey ? 0 : 1}, `
        + `${opt.vin === '' ? 0 : 1}, ${opt.throwSend ? 1 : 0}, ${r && r.ok ? 1 : 0}, ${r && r.timeout ? 1 : 0}, `
        + `${(r && r.fault) || 0}, ${mt ? cesc(mt) : 'NULL'}, ${cesc(r ? (r.text || '') : thrown)} },`);
    };
    // 1) 受理即终态（不传 done 的语义）
    await run('r01_done_ok', { plain: 1, queue: [FR.ack] });
    // 2) doneCommand 等不到「没有 commandStatus」的帧 → 最后一帧 inspect 形态
    await run('r02_notdone_last', { plain: 1, done: 'command', maxMs: 100, queue: [FR.ack] });
    // 3) 车辆一直回 WAIT：三次重发用尽（sticky = 队列取完重复末帧）
    await run('r03_busy_exhausted', { plain: 1, sticky: 1, queue: [FR.wait] });
    // 4) 协议层 fault=6 → 作废会话重新握手，第二帧才终态
    await run('r04_resync_then_ok', { plain: 1, queue: [FR.f6, FR.ack] });
    // 5) 应用层 nominalError → 被拒 + GenericError 下一步
    await run('r05_fail_app', { plain: 1, queue: [FR.unauth] });
    // 6) 协议层 fault=25（响应超 MTU）→ FAULT_HINT + MTU 注 + MayHaveSucceeded 注
    await run('r06_fail_mtu25', { plain: 1, mtu: 185, queue: [FR.f25] });
    // 7~8) 丢帧文案：两条不同 → 带「‖ 最后一帧」；两条相同 → 不带（sb_drop_text 的判据）
    await run('r07_drop_two_diff', { plain: 1, maxMs: 100, queue: [FR.gaddr, FR.guuid] });
    await run('r08_drop_two_same', { plain: 1, maxMs: 100, queue: [FR.gaddr, FR.gaddr] });
    // 9) 三次发送全无响应
    await run('r09_no_response', { plain: 1, queue: [] });
    // 10) 不传 name → 探针默认「V3 请求」
    await run('r10_default_name', { plain: 1, queue: [FR.ack] });
    // 11) 先丢一帧、再等一帧非终态、最后收不到 → 「最后一帧 + 已丢弃」复合文案
    await run('r11_drop_then_last', { plain: 1, done: 'command', maxMs: 2000, queue: [FR.gdom, FR.ack] });
    // 12) 白名单判据：只有 commandStatus 不算终态
    await run('r12_whitelist_wait', { plain: 1, done: 'whitelist', maxMs: 100, queue: [FR.wait] });
    // 13) 守卫：未连接 / VIN 空 / 无密钥（探针前两个抛异常，C 收成同文案 + 错误码）
    await run('r13_no_connection', { plain: 1, disconnected: true, queue: [FR.ack] });
    await run('r14_no_vin', { plain: 1, vin: '', queue: [FR.ack] });
    await run('r15_no_key', { plain: 0, noKey: true, queue: [FR.ack] });
    // 16) 发送即抛：探针「发送失败：<e.message>」，桩抛的正是 C 固定给的「链路错误」
    await run('r16_send_link_error', { plain: 1, throwSend: true, queue: [FR.ack] });
    // 17) 带名字的成功文案：name 前缀必须原样出现在「完成」那句里
    await run('r17_named_ok', { name: '解锁', plain: 1, queue: [FR.ack] });
    // 18) 带名字的 VIN 守卫：探针那句是 name + '：VIN 为空…'
    await run('r18_named_no_vin', { name: '开后备箱', plain: 1, vin: '', queue: [FR.ack] });

    if (rows.length) {
      sections.push(`// tlb_send_request 端到端（期望文案由探针 sendRequest 实算；max_ms=0 表示用默认 20000）\nstatic const tlb_g_send g_send_cases[] = {\n${rows.join('\n')}\n};`);
    } else {
      console.warn('[gen_goldens] 调度层端到端表为空，不落盘');
    }

    // ---- 7) 端到端握手：tlb_handshake（同一套桩）
    {
      const HS = (await import(url('src/domain/handshake-service.js'))).handshake;
      const SES = prng(16, 9103);
      const hrows = [];
      const runHs = async (nm, opt) => {
        S.vin = opt.vin === undefined ? VIN : opt.vin;
        S.v3 = opt.reuse ? { [opt.domain || VC]: { domain: opt.domain || VC, key: SES, counter: opt.counter,
                                                    epoch: CT, vehiclePublicKey: PUB65, clockTime: 0, setTime: 0,
                                                    anchor: 0, setAt: 0, ready: true } } : {};
        S.privateKey = opt.noKey ? null : PRIV;
        S.publicKey = opt.noKey ? null : PUB65;
        S.ble = opt.disconnected ? null : mkBle([], false);
        let r = null, thrown = '';
        try {
          r = await HS(!!opt.force, opt.domain === undefined ? VC : opt.domain);
        } catch (e) {
          thrown = (e && e.message) || String(e);
        }
        hrows.push(`    { "${nm}", ${opt.force ? 1 : 0}, ${opt.domain === undefined ? VC : opt.domain}, `
          + `${opt.disconnected ? 0 : 1}, ${opt.noKey ? 0 : 1}, ${opt.vin === '' ? 0 : 1}, ${opt.reuse ? 1 : 0}, `
          + `${opt.reuse ? (opt.counter || 0) : 0}, ${r && r.ok ? 1 : 0}, ${r && r.reused ? 1 : 0}, `
          + `${r && r.fatal ? 1 : 0}, ${r && r.notWhitelisted ? 1 : 0}, `
          + `${cesc(r ? (r.text || '') : thrown)} },`);
      };
      await runHs('hs01_no_connection', { disconnected: true });
      await runHs('hs02_no_key', { noKey: true });
      await runHs('hs03_no_vin', { vin: '' });
      await runHs('hs04_reuse_vc', { reuse: true, counter: 7 });
      await runHs('hs05_reuse_info', { reuse: true, counter: 0, domain: INFO });
      await runHs('hs06_force_no_response', { reuse: true, counter: 7, force: true });
      if (hrows.length) {
        sections.push(`// tlb_handshake 端到端（探针 handshake 实算；reuse=1 表示已有可复用会话）\nstatic const tlb_g_handshake g_handshake_cases[] = {\n${hrows.join('\n')}\n};`);
      }
    }

    // ---- 8) 端到端加白名单：tlb_probe_enrollment / tlb_bind_key
    // 探针的绑定循环里没有 sleep，时间唯一的前进源就是「等帧超时」，所以两侧必须用
    // 同一个虚拟钟 + 同一份带时间戳的帧队列：
    //   · 队首帧的 at <= 当前虚拟钟 → 立刻交出，时钟不动；
    //   · 否则不交帧，时钟 += 本次等待的时间片。
    // 裸数组模型在这里不可用：add-key 之后的 receive 是贪婪循环，会在探针之前就把队列抽干。
    {
      const EB = await import(url('src/domain/enrollment-service.js'));
      const HSh = await import(url('src/protocol/v3/handshake.js'));
      const PB = await import(url('src/infra/crypto/p256.js'));
      const VB = 1700000000000; // 整秒，令 localNow() = VB/1000 与 C 的 now_ms/1000 同值
      let vnow = VB;
      const realNow = Date.now;
      Date.now = () => vnow;

      const prows = [];
      const brows = [];
      let bqi = 0;
      try {
        // 真 P-256 密钥材料：JS 用 p256.js 实算，C 侧靠 tlb_host_set_ecdh_fixture 给出同一条 X
        const PRIV2 = Buffer.from(PB.normalizePrivateKey(prng(32, 9111)));
        const PUB2 = Buffer.from(PB.publicKeyFromPrivate(PRIV2));
        const VPUB = Buffer.from(PB.publicKeyFromPrivate(PB.normalizePrivateKey(prng(32, 9112))));
        const X2 = Buffer.from(PB.deriveSharedSecret(PRIV2, VPUB));
        const K2 = Buffer.from(HSh.sharedKeyOf(PRIV2, VPUB));
        const BK = [cbytes('gbk_priv', PRIV2), cbytes('gbk_pub', PUB2),
                    cbytes('gbk_vepub', VPUB), cbytes('gbk_x', X2)];
        decls.push(`static const tlb_g_blob g_bind_keys[] = { ${BK.map((k) => `{ NULL, ${k.id}, ${k.len} }`).join(', ')} };`);

        const CH = prng(16, 9113);      // 握手帧回显的 request_uuid（两侧用它当 challenge）
        const EPOCH = prng(16, 9114);
        const BADTAG = prng(32, 9115);
        const CLOCK = 1700000000;       // = VB/1000 → 预探针时刻 anchor=0
        const SI = encode(V3_SPEC, 'SessionInfo', { counter: 5, publicKey: VPUB, epoch: EPOCH, clock_time: CLOCK });
        const hsFrame = (tag) => rmE({ session_info: SI, request_uuid: CH,
                                       signature_data: { session_info_tag: { tag } } });
        const HSOK = hsFrame(HSh.sessionInfoHmac(K2, VIN, CH, SI));
        const HSBAD = hsFrame(BADTAG);
        const REJ = rmE({ session_info: encode(V3_SPEC, 'SessionInfo', { status: 1 }) });
        const ERR = rmE({ protobuf_message_as_bytes: GATE });
        const WL = (i) => rmE({ protobuf_message_as_bytes: encode(V3_SPEC, FVM, {
          commandStatus: { whitelistOperationStatus: { operationStatus: 2, whitelistOperationInformation: i } } }) });
        const T = (rel, b) => ({ at: VB + rel, b });

        const mkBleT = (items, failAt) => {
          const q = items.map((it) => ({ at: it.at, b: Uint8Array.from(it.b) }));
          let ex = 0;
          const pop = (ms) => {
            if (q.length && q[0].at <= vnow) return q.shift().b;
            vnow += ms;
            return null;
          };
          const b = { connected: true, receive: async (ms) => pop(ms) };
          b.send = async (_d, ms) => {
            ex++;
            if (ex === failAt) throw new Error('链路错误');
            return pop(ms);
          };
          return b;
        };

        const setup = (opt) => {
          vnow = VB;
          S.vin = opt.vin === undefined ? VIN : opt.vin;
          S.privateKey = opt.noKey ? null : PRIV2;
          S.publicKey = opt.noKey ? null : PUB2;
          S.v3 = opt.reuse ? { [VC]: { domain: VC, key: K2, counter: opt.counter || 0, epoch: EPOCH,
                                       vehiclePublicKey: VPUB, clockTime: CLOCK, setTime: CLOCK,
                                       anchor: 0, setAt: VB / 1000, ready: true } } : {};
          S.ble = opt.disconnected ? null : mkBleT(opt.queue || [], opt.failAt || 0);
        };

        const qdecl = (items) => {
          if (!items.length) return ['NULL', 0];
          const name = 'gbq_' + (bqi++);
          const body = items.map((it) => {
            const w = cbytes('gbf_', it.b);
            return `{ NULL, ${w.id}, ${w.len}, ${it.at}LL }`;
          });
          decls.push(`static const tlb_g_tw ${name}[] = { ${body.join(', ')} };`);
          return [name, items.length];
        };

        const runP = async (nm, opt) => {
          setup(opt);
          const [qArr, qn] = qdecl(opt.queue || []);
          let r = null, thrown = '';
          try {
            r = await EB.probeEnrollment({ force: !!opt.force });
          } catch (e) {
            thrown = (e && e.message) || String(e);
          }
          prows.push(`    { "${nm}", ${opt.force ? 1 : 0}, ${opt.disconnected ? 0 : 1}, ${opt.noKey ? 0 : 1}, `
            + `${opt.vin === '' ? 0 : 1}, ${opt.reuse ? 1 : 0}, ${opt.reuse ? (opt.counter || 0) : 0}, `
            + `${qArr}, ${qn}, ${r && r.ok ? 1 : 0}, ${r && r.paired ? 1 : 0}, ${r && r.reused ? 1 : 0}, `
            + `${r && r.notWhitelisted ? 1 : 0}, ${cesc(r ? (r.text || '') : thrown)} },`);
        };

        const runB = async (nm, opt) => {
          setup(opt);
          const [qArr, qn] = qdecl(opt.queue || []);
          const o = {};
          if (opt.window !== undefined) o.windowMs = opt.window;
          if (opt.receive !== undefined) o.receiveMs = opt.receive;
          if (opt.probeFirst !== undefined) o.probeFirstMs = opt.probeFirst;
          if (opt.probeInterval !== undefined) o.probeIntervalMs = opt.probeInterval;
          if (opt.ff !== undefined) o.formFactor = opt.ff;
          let r = null, thrown = '';
          try {
            r = await EB.bindKey(undefined, o);
          } catch (e) {
            thrown = (e && e.message) || String(e);
          }
          brows.push(`    { "${nm}", ${opt.ff === undefined ? 0 : opt.ff}, ${opt.ff === undefined ? 0 : 1}, `
            + `${opt.window || 0}LL, ${opt.receive || 0}LL, ${opt.probeFirst || 0}LL, ${opt.probeInterval || 0}LL, `
            + `${opt.disconnected ? 0 : 1}, ${opt.vin === '' ? 0 : 1}, ${opt.failAt || 0}, `
            + `${qArr}, ${qn}, ${r && r.ok ? 1 : 0}, ${r && r.paired ? 1 : 0}, ${r && r.already ? 1 : 0}, `
            + `${r && r.wait ? 1 : 0}, ${r && r.info !== undefined ? 1 : 0}, ${r && r.info !== undefined ? r.info : 0}, `
            + `${(r && r.probes) || 0}, ${cesc(r ? (r.text || '') : thrown)} },`);
        };

        // 「④ 探针确认」：守卫 → 复用现成会话 → 打一针的四种落点
        await runP('p01_no_connection', { disconnected: true });
        await runP('p02_no_key', { noKey: true });
        await runP('p03_no_vin', { vin: '' });
        await runP('p04_reuse', { reuse: true, counter: 7 });
        await runP('p05_force_ok', { force: true, reuse: true, counter: 7, queue: [T(0, HSOK)] });
        await runP('p06_rejected', { queue: [T(0, REJ)] });
        await runP('p07_no_response', { queue: [] });
        await runP('p08_hmac_bad', { queue: [T(0, HSBAD)] });

        // 主绑定路径：三段状态机的每一条出口
        await runB('b01_no_connection', { disconnected: true });
        await runB('b02_no_vin', { vin: '' });
        await runB('b03_already', { queue: [T(0, HSOK)] });
        await runB('b04_send_link_error', { queue: [T(0, REJ)], failAt: 2 });
        // WAIT → 时间片 → 第 8 秒探针命中（anchor 随虚拟钟变成 9）
        await runB('b05_wait_then_probe', { queue: [T(0, REJ), T(0, FR.wait), T(9000, HSOK)],
                                             window: 25000, receive: 3000, probeFirst: 8000, probeInterval: 5000 });
        await runB('b06_wl_denied_hint', { queue: [T(0, REJ), T(0, WL(3))] });
        await runB('b07_wl_denied_nohint', { queue: [T(0, REJ), T(0, WL(1))] });
        await runB('b08_wl_ok_probe_ok', { queue: [T(0, REJ), T(0, WL(0)), T(0, HSOK)] });
        await runB('b09_wl_ok_probe_miss', { queue: [T(0, REJ), T(0, WL(0))] });
        await runB('b10_app_error', { queue: [T(0, REJ), T(0, ERR)] });
        await runB('b11_wait_exhausted', { queue: [T(0, REJ), T(0, FR.wait)], window: 25000 });
        // 协议层 fault 只记日志、绝不重发 add-key：第三帧才是终态
        await runB('b12_fault_then_wl', { queue: [T(0, REJ), T(0, FR.f25), T(0, WL(3))], ff: 1 });
        await runB('b13_default_exhausted', { queue: [T(0, REJ)] });

        if (prows.length) {
          sections.push(`// tlb_probe_enrollment 端到端（探针 probeEnrollment 实算；queue 为空 = 一直等不到帧）\nstatic const tlb_g_probe g_probe_cases[] = {\n${prows.join('\n')}\n};`);
        }
        if (brows.length) {
          sections.push(`// tlb_bind_key 端到端（探针 bindKey 实算；*_ms=0 = 用 TLB_PAIR_*/TLB_PROBE_* 默认值）\nstatic const tlb_g_bind g_bind_cases[] = {\n${brows.join('\n')}\n};`);
        }
      } finally {
        Date.now = realNow;
      }
    }
  }
}
await dispatchSections();

// ---------------------------------------------------------------- 广播名 / 分包上限（设备层要用）
async function identitySections() {
  const url = (p) => new URL('file:///' + resolve(PROBE, p).replace(/\\/g, '/') + '').href;
  const ID = await import(url('src/protocol/identity.js'));
  const DM = await import(url('src/infra/ble/device-matcher.js'));
  const MT = await import(url('src/infra/ble/mtu-manager.js'));

  const MODE = { exact: 1, prefix: 2, loose: 3, 'loose-prefix': 4 };

  const VINS = [
    '5YJ3E1EA7KF000000',            // 常规 17 位
    '5yJ3e1ea7kf000000',            // 小写输入 → 大写归一
    '  LRDSADA1NA7007933  ',        // 首尾空白 → trim
    'ABC123',                       // 正好 6 位 → 两条规则都成立
    'ABCDE',                        // 5 位 → 只有 prefix
    '',                             // 空 → 两条都不成立
    '   ',                          // 全空白 → trim 后为空
    '5YJ3E1EA7KF000000ABCDEF',      // 23 位：落盘上界（TLB_VIN_MAX-1）
    'TGJE7BBC4JD111111',
    '1234567890ABCDEF1234567890ABCDEFGHIJKL', // 38 位：非 VIN 长度的脏输入，两边规则仍要一致
  ];

  // bleNamesForVin：exact / prefix 原文逐字比对
  {
    const rows = [];
    for (let i = 0; i < VINS.length; i++) {
      const v = VINS[i];
      const n = ID.bleNamesForVin(v);
      rows.push(`    { ${cesc(v)}, ${cesc((n.exact || [])[0] || '')}, ` +
                `${cesc((n.prefixes || [])[0] || '')} },`);
    }
    sections.push(`// bleNamesForVin（identity.js:13）\nstatic const tlb_g_names g_names_cases[] = {\n${rows.join('\n')}\n};`);
  }

  // normName：丢分隔符 + 转大写
  {
    const IN = ['', 'Tesla 000000', 'tesla_000000', '  TESLA-000000 ', '中文 Tesla 名',
      'sa1b2c3d4e5f6071', '0x0211', 'ÿSt0_2-11', '  ', 'AB'.repeat(19)];
    const rows = [];
    IN.forEach((s, i) => {
      const want = DM.normName(s);
      if (want.length > 39) {
        throw new Error('normName 金标准超出缓冲上界：' + want.length);
      }
      rows.push(`    { ${cesc('n' + i)}, ${cesc(s)}, ${cesc(want)} },`);
    });
    sections.push(`// normName（device-matcher.js:11）\nstatic const tlb_g_norm g_norm_cases[] = {\n${rows.join('\n')}\n};`);
  }

  // makeMatcher：四档顺序（原文 exact / 原文 prefix / 归一化 exact / 归一化 prefix）
  {
    const rows = [];
    let k = 0;
    const add = (vin, adv, tag) => {
      const names = ID.bleNamesForVin(vin);
      const m = DM.makeMatcher(names)(adv);
      rows.push(`    { ${cesc('m' + k + '_' + tag)}, ${cesc(vin)}, ${cesc(adv)}, ` +
                `${m ? MODE[m.mode] : 0}, ${cesc(m ? m.matched : '')} },`);
      k++;
    };
    const base = '5YJ3E1EA7KF000000';
    const bn = ID.bleNamesForVin(base);
    const hexp = (bn.prefixes || [])[0] || '';
    add(base, 'Tesla 000000', 'exact');
    add(base, 'TESLA 000000', 'loose-case');
    add(base, 'Tesla-000000', 'loose-sep');
    add(base, 'tesla000000', 'loose-lower');
    add(base, hexp, 'prefix-raw');
    add(base, hexp.toUpperCase(), 'loose-prefix');
    add(base, hexp.toUpperCase() + 'R', 'loose-prefix-tail');
    add(base, hexp.toUpperCase().slice(0, -1), 'loose-prefix-short');
    add(base, 'Tesla 00000', 'miss-short');
    add(base, 'Tesla 0000001', 'miss-long');
    add(base, 'SomeOtherCar', 'miss-other');
    add(base, '', 'miss-empty');
    add('ABCDE', 'Tesla ABCDE', 'miss-vin5');
    add('', 'Tesla 000000', 'miss-novin');
    add(' 5YJ3E1EA7KF000000 ', 'Tesla 000000', 'trim-in');
    add('5YJ3E1EA7KF000000', 'Tesla 000000X', 'miss-x-tail');
    sections.push(`// makeMatcher（device-matcher.js:27；mode 0=none 1=exact 2=prefix 3=loose 4=loose-prefix）\nstatic const tlb_g_match g_match_cases[] = {\n${rows.join('\n')}\n};`);
  }

  // hasTeslaService：单 UUID 判定（探针只认短格式前缀，全形式是既有行为）
  {
    const IN = ['0211', '0x0211', '00000211-b2d1-43f0-9b88-960cebf8b91e', '0211XYZ', '021',
      'FFF0', '', '12345678-0211-43f0-9b88-960cebf8b91e'];
    const rows = [];
    IN.forEach((u, i) => {
      const hit = DM.hasTeslaService({ advertisServiceUUIDs: [u] });
      rows.push(`    { ${cesc('s' + i)}, ${cesc(u)}, ${hit ? 1 : 0} },`);
    });
    sections.push(`// hasTeslaService（device-matcher.js:16）\nstatic const tlb_g_svc g_svc_cases[] = {\n${rows.join('\n')}\n};`);
  }

  // payloadCap：mtu || 23 → max(20, min(mtu, MAX_FRAME) - 3)
  {
    const IN = [0, 1, 20, 22, 23, 24, 27, 64, 128, 185, 247, 512, 517, 1023, 1024, 1025, 2048, -5];
    const rows = [];
    IN.forEach((m) => {
      rows.push(`    { "cap_${m}", ${m}, ${MT.payloadCap(m)} },`);
    });
    sections.push(`// payloadCap（mtu-manager.js:20）\nstatic const tlb_g_cap g_cap_cases[] = {\n${rows.join('\n')}\n};`);
  }
}
await identitySections();


// ---------------------------------------------------------------- 输出
const header = `// tests/host/goldens.h —— 由 tools/gen_goldens.mjs 生成，请勿手改。
// 重新生成： node tools/gen_goldens.mjs
#pragma once
#include <stddef.h>
#include <stdint.h>

typedef struct { const char *name; const uint8_t *in; size_t inlen; const uint8_t *want; size_t wantlen; size_t split; } tlb_g_bytes;
typedef struct { const char *name; const uint8_t *a; size_t alen; const uint8_t *b; size_t blen; const uint8_t *want; size_t wantlen; size_t split; } tlb_g_hmac;
typedef struct { const char *name; const uint8_t *key; size_t klen; const uint8_t *in; size_t inlen; const uint8_t *want; size_t wlen; } tlb_g_block;
typedef struct { const char *name; const uint8_t *key; size_t klen; const uint8_t *nonce; size_t nlen; const uint8_t *aad; size_t alen; const uint8_t *pt; size_t plen; const uint8_t *want; size_t wlen; } tlb_g_gcm;

// ---- 分帧
typedef struct { const uint8_t *data; size_t len; long long now_ms; } tlb_g_frame_push;
typedef struct { const char *name; const tlb_g_frame_push *pushes; size_t n_pushes;
                 const uint8_t *frames; size_t frames_len; const size_t *frame_lens;
                 size_t n_frames; size_t dropped; size_t buffered; } tlb_g_frame;
typedef struct { const char *name; const uint8_t *in; size_t in_len; const uint8_t *want; size_t want_len; } tlb_g_prepend;
typedef struct { const char *name; const uint8_t *in; size_t in_len; int ok; const uint8_t *want; size_t want_len; } tlb_g_strip;

// ---- 广播名 / 分包上限（identity.js + device-matcher.js + mtu-manager.js）
typedef struct { const char *vin; const char *exact; const char *prefix; } tlb_g_names;
typedef struct { const char *name; const char *in; const char *out; } tlb_g_norm;
typedef struct { const char *name; const char *vin; const char *adv; int mode; const char *matched; } tlb_g_match;
typedef struct { const char *name; const char *uuid; int hit; } tlb_g_svc;
typedef struct { const char *name; int mtu; long long cap; } tlb_g_cap;

// ---- 协议层（字段顺序必须与 gen_goldens.mjs 里各 row 的 cells 顺序严格一致）
typedef struct { const char *name; uint32_t action; const uint8_t *bytes; size_t bytes_len; } tlb_g_rke;
typedef struct { const char *name; uint32_t domain; const uint8_t *routing_address; size_t routing_address_len; const uint8_t *public_key; size_t public_key_len; const uint8_t *uuid; size_t uuid_len; const uint8_t *want; size_t want_len; } tlb_g_hs;
typedef struct { const char *name; const uint8_t *public_key; size_t public_key_len; uint32_t role; uint32_t form_factor; const uint8_t *payload; size_t payload_len; const uint8_t *env; size_t env_len; } tlb_g_addkey;
typedef struct { const char *name; uint32_t signature_type; uint32_t domain; const char *vin; const uint8_t *epoch; size_t epoch_len; uint32_t expires_at; uint32_t counter; uint32_t flags; const uint8_t *tlv; size_t tlv_len; const uint8_t *sha; } tlb_g_reqmeta;
typedef struct { const char *name; uint32_t domain; const char *vin; uint32_t counter; uint32_t flags; const uint8_t *request_id; size_t request_id_len; uint32_t fault; const uint8_t *tlv; size_t tlv_len; const uint8_t *sha; } tlb_g_resmeta;
typedef struct { const char *name; const uint8_t *key; size_t key_len; const char *label; const uint8_t *want; } tlb_g_subkey;
typedef struct { const char *name; const uint8_t *key; size_t key_len; const char *vin; const uint8_t *challenge; size_t challenge_len; const uint8_t *message; size_t message_len; const uint8_t *want; } tlb_g_sihmac;
typedef struct { const char *name; uint32_t domain; uint32_t flags; uint32_t counter; uint32_t expires_at;
                 const uint8_t *key; size_t key_len; const uint8_t *epoch; size_t epoch_len;
                 const uint8_t *nonce; size_t nonce_len; const uint8_t *routing_address; size_t routing_address_len;
                 const uint8_t *uuid; size_t uuid_len; const uint8_t *public_key; size_t public_key_len;
                 const uint8_t *plain; size_t plain_len; const uint8_t *tlv; size_t tlv_len;
                 const uint8_t *aad; size_t aad_len; const uint8_t *ct; size_t ct_len;
                 const uint8_t *tag; const uint8_t *want; size_t want_len;
                 long long now; long long anchor; } tlb_g_cmd;
typedef struct { const char *name; const uint8_t *key; size_t key_len;
                 const uint8_t *init_epoch; size_t init_epoch_len; uint32_t init_counter;
                 int has_set_time; uint32_t set_time;
                 const char *vin; const uint8_t *challenge; size_t challenge_len;
                 const uint8_t *encoded; size_t encoded_len; const uint8_t *tag; size_t tag_len;
                 long long now; int err;
                 const uint8_t *out_epoch; size_t out_epoch_len;
                 const uint8_t *out_pub; size_t out_pub_len;
                 uint32_t clock_time; uint32_t set_time_after; int has_set_time_after;
                 long long anchor; uint32_t counter; int ready; uint32_t status;
                 int not_whitelisted; } tlb_g_apply;
typedef struct { const char *name; const uint8_t *bytes; size_t bytes_len;
                 const uint8_t *key; size_t key_len; const char *vin;
                 const uint8_t *request_id; size_t request_id_len; int err;
                 const uint8_t *want; size_t want_len; uint32_t counter; } tlb_g_resp;
typedef struct { const char *name; const uint8_t *bytes; size_t bytes_len; size_t known;
                 int has_to_domain; uint32_t to_domain; int has_from_domain; uint32_t from_domain;
                 const uint8_t *from_routing; size_t from_routing_len;
                 const uint8_t *payload; size_t payload_len; int has_payload;
                 const uint8_t *si; size_t si_len; int has_si;
                 int has_status; uint32_t operation_status; uint32_t signed_message_fault;
                 const uint8_t *request_uuid; size_t request_uuid_len;
                 const uint8_t *uuid; size_t uuid_len; uint32_t flags;
                 const uint8_t *signer_pk; size_t signer_pk_len;
                 const uint8_t *si_tag; size_t si_tag_len;
                 const uint8_t *gp_epoch; size_t gp_epoch_len; int gp_has_counter; uint32_t gp_counter;
                 int gp_has_expires_at; uint32_t gp_expires_at; const uint8_t *gp_tag; size_t gp_tag_len;
                 const uint8_t *resp_nonce; size_t resp_nonce_len; int resp_has_counter; uint32_t resp_counter;
                 const uint8_t *resp_tag; size_t resp_tag_len; } tlb_g_decrm;
typedef struct { const char *name; const uint8_t *bytes; size_t bytes_len; size_t known;
                 uint32_t counter; int has_counter; const uint8_t *public_key; size_t public_key_len;
                 const uint8_t *epoch; size_t epoch_len; uint32_t clock_time; int has_clock_time;
                 uint32_t status; int has_status; uint32_t handle; int has_handle; } tlb_g_decsi;
typedef struct { const char *name; const uint8_t *bytes; size_t bytes_len; size_t rm_known; size_t known;
                 int has_command_status; uint32_t operation_status; int has_operation_status;
                 uint32_t sm_counter; int has_sm_counter; uint32_t smi; int has_smi;
                 int has_whitelist_status; uint32_t wl_information; int has_wl_information;
                 uint32_t wl_operation_status; int has_wl_operation_status;
                 int has_vehicle_status; int has_nominal_error; uint32_t nominal_error; } tlb_g_decvc;

// ---- 调度层（tlb_dispatch）
typedef struct { const char *name; const uint8_t *b; size_t len; } tlb_g_blob;
typedef struct { const char *name; uint32_t fault; uint32_t op_status; int action; const char *text; } tlb_g_proto;
typedef struct { const char *name; const uint8_t *bytes; size_t bytes_len; uint32_t domain; int action; const char *text; } tlb_g_appout;
typedef struct { const char *name; const uint8_t *bytes; size_t bytes_len; int kind; uint32_t status; uint32_t counter; int has_counter; const char *text; } tlb_g_sum;
typedef struct { const char *name; const char *in; const char *hint; } tlb_g_hint;
typedef struct { const char *name; const uint8_t *bytes; size_t bytes_len; int skipped; int skip; int refused;
                 uint32_t fault; uint32_t op_status; int app_kind; uint32_t app_status;
                 const char *app_text; const char *text; const uint8_t *key; size_t key_len; } tlb_g_dframe;
typedef struct { const char *name; const char *cmd; int plain; uint32_t domain; int done; long long max_ms;
                 int sticky; const tlb_g_blob *queue; size_t n_queue; const uint8_t *payload; size_t payload_len;
                 int connected; int has_key; int has_vin; int link_error;
                 int ok; int timeout; uint32_t fault; const char *mtu_note; const char *text; } tlb_g_send;
typedef struct { const char *name; int force; uint32_t domain; int connected; int has_key; int has_vin; int reuse;
                 uint32_t counter; int ok; int reused; int fatal; int not_whitelisted;
                 const char *text; } tlb_g_handshake;

// ---- 加白名单（tlb_probe_enrollment / tlb_bind_key）
typedef struct { const char *name; const uint8_t *b; size_t len; long long at; } tlb_g_tw;
typedef struct { const char *name; int force; int connected; int has_key; int has_vin; int reuse;
                 uint32_t counter; const tlb_g_tw *queue; size_t n_queue;
                 int ok; int paired; int reused; int not_whitelisted; const char *text; } tlb_g_probe;
typedef struct { const char *name; uint32_t form_factor; int has_form_factor;
                 long long window_ms; long long receive_ms; long long probe_first_ms; long long probe_interval_ms;
                 int connected; int has_vin; int fail_exchange_at; const tlb_g_tw *queue; size_t n_queue;
                 int ok; int paired; int already; int wait; int has_info; uint32_t info; int probes;
                 const char *text; } tlb_g_bind;

${decls.join('\n')}

${sections.join('\n\n')}

#define TLB_G_N(a) ((size_t)(sizeof(a) / sizeof((a)[0])))
`;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, header, 'utf8');
console.log('[gen_goldens] 写出 ' + OUT + '（' + decls.length + ' 组字节，' + sections.length + ' 个用例表）');
