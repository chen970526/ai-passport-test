// tests/host/test_core.c —— tesla_core 纯逻辑层主机测试（gcc/MSVC 均可编译，无 IDF 依赖）。
// 运行： powershell -File tests/host/run.ps1
#include <stdio.h>
#include <string.h>

#include "tesla_core/tlb_aes.h"
#include "tesla_core/tlb_bind.h"
#include "tesla_core/tlb_dispatch.h"
#include "tesla_core/tlb_frame.h"
#include "tesla_core/tlb_identity.h"
#include "tesla_core/tlb_meta.h"
#include "tesla_core/tlb_msg.h"
#include "tesla_core/tlb_sha.h"
#include "tesla_core/tlb_store.h"
#include "tesla_core/tlb_v3.h"

#include "goldens.h"

static int g_checks;
static int g_fails;

static void fail(const char *name, const uint8_t *got, size_t gl, const uint8_t *want,
                 size_t wl) {
    g_fails++;
    printf("FAIL %-36s\n", name);
    printf("     got :");
    for (size_t i = 0; i < gl && i < 32; i++) printf(" %02x", got[i]);
    printf("\n     want:");
    for (size_t i = 0; i < wl && i < 32; i++) printf(" %02x", want[i]);
    printf("\n");
}

static void eq(const char *name, const uint8_t *got, size_t gl, const uint8_t *want, size_t wl) {
    g_checks++;
    if (gl == wl && (gl == 0 || memcmp(got, want, gl) == 0)) return;
    fail(name, got, gl, want, wl);
}

// 按「用例/字段」两段命名比字节，和 chk_u / chk_b / chk_s 一个口径。
static void eq_f(const char *base, const char *fld, const uint8_t *got, size_t gl,
                 const uint8_t *want, size_t wl) {
    char nm[160];
    snprintf(nm, sizeof(nm), "%s/%s", base, fld);
    eq(nm, got, gl, want, wl);
}

// ------------------------------------------------------------------ SHA-256 / SHA-1
static void test_sha(const tlb_g_bytes *c, int is256) {
    uint8_t got[32];
    char nm[128];

    memset(got, 0xAA, sizeof(got));
    if (is256) tlb_sha256(c->in, c->inlen, got);
    else tlb_sha1(c->in, c->inlen, got);
    snprintf(nm, sizeof(nm), "%s/oneshot", c->name);
    eq(nm, got, c->wantlen, c->want, c->wantlen);

    if (!is256) return; // SHA-1 在协议里只做一次性 KDF，没有流式入口

    // 流式：每次 7 字节，覆盖所有分块与补位边界
    tlb_sha256_ctx ctx;
    tlb_sha256_init(&ctx);
    for (size_t off = 0; off < c->inlen; off += 7) {
        size_t n = c->inlen - off < 7 ? c->inlen - off : 7;
        tlb_sha256_update(&ctx, c->in + off, n);
    }
    memset(got, 0xAA, sizeof(got));
    tlb_sha256_final(&ctx, got);
    snprintf(nm, sizeof(nm), "%s/ctx", c->name);
    eq(nm, got, c->wantlen, c->want, c->wantlen);

    // 两段输入（AAD = TLV ‖ 0xFF ‖ msg 走的就是这条路径）
    const uint8_t *parts[2] = { c->in, c->in + c->split };
    const size_t lens[2] = { c->split, c->inlen - c->split };
    memset(got, 0xAA, sizeof(got));
    tlb_sha256_parts(parts, lens, 2, got);
    snprintf(nm, sizeof(nm), "%s/parts", c->name);
    eq(nm, got, c->wantlen, c->want, c->wantlen);
}

// ------------------------------------------------------------------ HMAC-SHA256
static void test_hmac(const tlb_g_hmac *c) {
    uint8_t got[32];
    char nm[128];

    tlb_hmac_sha256(c->a, c->alen, c->b, c->blen, got);
    snprintf(nm, sizeof(nm), "%s/oneshot", c->name);
    eq(nm, got, 32, c->want, c->wantlen);

    const uint8_t *parts[2] = { c->b, c->b + c->split };
    const size_t lens[2] = { c->split, c->blen - c->split };
    memset(got, 0xAA, sizeof(got));
    tlb_hmac_sha256_parts(c->a, c->alen, parts, lens, c->blen ? 2 : 0, got);
    snprintf(nm, sizeof(nm), "%s/parts", c->name);
    eq(nm, got, 32, c->want, c->wantlen);
}

// ------------------------------------------------------------------ AES-128 单块
static void test_block(const tlb_g_block *c) {
    uint8_t rk[TLB_AES_ROUNDS * TLB_AES_BLOCK];
    uint8_t got[16];
    char nm[128];

    tlb_aes128_expand(c->key, rk);
    memset(got, 0xAA, sizeof(got));
    tlb_aes128_encrypt_block_rk(rk, c->in, got);
    snprintf(nm, sizeof(nm), "%s/rk", c->name);
    eq(nm, got, 16, c->want, c->wlen);

    memset(got, 0xAA, sizeof(got));
    tlb_aes128_encrypt_block(c->key, c->in, got);
    snprintf(nm, sizeof(nm), "%s/direct", c->name);
    eq(nm, got, 16, c->want, c->wlen);
}

// ------------------------------------------------------------------ AES-128-GCM
static void test_gcm(const tlb_g_gcm *c) {
    uint8_t ct[256], tag[16], scratch[256];
    char nm[128];

    memset(ct, 0xAA, sizeof(ct));
    memset(tag, 0xAA, sizeof(tag));
    tlb_aes128_gcm_encrypt(c->key, c->nonce, c->nlen, c->aad, c->alen, c->pt, c->plen, ct, tag);
    snprintf(nm, sizeof(nm), "%s/ct", c->name);
    eq(nm, ct, c->plen, c->want, c->plen);
    snprintf(nm, sizeof(nm), "%s/tag", c->name);
    eq(nm, tag, 16, c->want + c->plen, 16);

    // 原地加密：in 与 out 同缓冲
    memmove(scratch, c->pt, c->plen);
    tlb_aes128_gcm_encrypt(c->key, c->nonce, c->nlen, c->aad, c->alen, scratch, c->plen, scratch,
                           tag);
    snprintf(nm, sizeof(nm), "%s/inplace", c->name);
    eq(nm, scratch, c->plen, c->want, c->plen);

    // 解密还原 + 回吐期望 tag
    memset(scratch, 0xAA, sizeof(scratch));
    memset(tag, 0xAA, sizeof(tag));
    tlb_aes128_gcm_decrypt(c->key, c->nonce, c->nlen, c->aad, c->alen, c->want, c->plen, scratch,
                           tag);
    snprintf(nm, sizeof(nm), "%s/dec-pt", c->name);
    eq(nm, scratch, c->plen, c->pt, c->plen);
    snprintf(nm, sizeof(nm), "%s/dec-tag", c->name);
    eq(nm, tag, 16, c->want + c->plen, 16);
}

// ---------------------------------------------------------------- 协议层公共断言
#define TEST_VIN "5YJ3E1EA7KF000000" // 假 VIN 夹具（上架脱敏：绝不用真实车辆 VIN）

static void chk(const char *name, long long got, long long want) {
    g_checks++;
    if (got == want) return;
    g_fails++;
    printf("FAIL %-44s got=%lld want=%lld\n", name, got, want);
}

static void chk_b(const char *base, const char *fld, int got, int want) {
    char nm[160];
    snprintf(nm, sizeof(nm), "%s/%s", base, fld);
    chk(nm, got ? 1 : 0, want ? 1 : 0);
}

static void chk_u(const char *base, const char *fld, unsigned long long got,
                  unsigned long long want) {
    char nm[160];
    snprintf(nm, sizeof(nm), "%s/%s", base, fld);
    chk(nm, (long long)got, (long long)want);
}

// 金标准里 len=0 的字段是占位数组，语义是「解码器不该给出任何内容」；
// 解出的字段还必须是输入缓冲里的视图（协议层全程零拷贝）。
static void eq_opt(const char *base, const char *fld, const uint8_t *in, size_t inlen,
                   const uint8_t *got, size_t gl, const uint8_t *want, size_t wl) {
    char nm[160];
    snprintf(nm, sizeof(nm), "%s/%s", base, fld);
    g_checks++;
    if (!(wl == 0 ? gl == 0 : (gl == wl && memcmp(got, want, wl) == 0))) {
        fail(nm, got, gl, want, wl);
        return;
    }
    if (gl != 0 && !(got >= in && got + gl <= in + inlen)) {
        g_fails++;
        printf("FAIL %-44s 指针越出输入缓冲\n", nm);
    }
}

// 文案比对：调度层给用户的每一条字符串都必须与探针逐字一致
static void chk_s(const char *base, const char *fld, const char *got, const char *want) {
    char nm[160];
    snprintf(nm, sizeof(nm), "%s/%s", base, fld);
    g_checks++;
    if (strcmp(got, want) == 0) return;
    g_fails++;
    printf("FAIL %-44s\n     got :%s\n     want:%s\n", nm, got, want);
}

// ---------------------------------------------------------------- 分帧
// 金标准给的是「切出来的帧依次拼接」+ 每帧长度，所以收集端也要同样记录长度序列，
// 否则「两帧各 10 字节」和「一帧 20 字节」在这种表示下无法区分。
typedef struct {
    uint8_t blob[4096];
    size_t len;
    size_t lens[16];
    size_t n;
} frame_sink_t;

static void frame_sink(void *ud, const uint8_t *body, size_t body_len) {
    frame_sink_t *s = (frame_sink_t *)ud;
    if (body_len > sizeof(s->blob) - s->len) {
        g_fails++;
        printf("FAIL frame sink 溢出\n");
        return;
    }
    memcpy(s->blob + s->len, body, body_len);
    s->len += body_len;
    if (s->n < 16) s->lens[s->n++] = body_len;
}

static void test_frame(const tlb_g_frame *c) {
    tlb_frame_t f;
    frame_sink_t s;
    char pre[192];

    snprintf(pre, sizeof(pre), "frame/%s", c->name);
    tlb_frame_reset(&f);
    memset(&s, 0, sizeof(s));
    for (size_t i = 0; i < c->n_pushes; i++) {
        tlb_frame_push(&f, c->pushes[i].data, c->pushes[i].len, c->pushes[i].now_ms, frame_sink,
                       &s);
    }
    chk(pre, (long long)s.n, (long long)c->n_frames);
    eq(pre, s.blob, s.len, c->frames, c->frames_len);
    for (size_t i = 0; i < c->n_frames && i < 16; i++) {
        chk_u(pre, "frame_len", s.lens[i], c->frame_lens[i]);
    }
    chk_u(pre, "dropped", f.dropped, c->dropped);
    chk_u(pre, "buffered", f.len, c->buffered);
}

static void test_prepend(const tlb_g_prepend *c) {
    uint8_t out[TLB_FRAME_BUF];
    size_t out_len = 0;
    char nm[192];

    snprintf(nm, sizeof(nm), "prepend/%s", c->name);
    memset(out, 0xAA, sizeof(out));
    chk(nm, tlb_frame_prepend(c->in, c->in_len, out, sizeof(out), &out_len) ? 1 : 0, 1);
    eq(nm, out, out_len, c->want, c->want_len);
}

static void test_strip(const tlb_g_strip *c) {
    const uint8_t *body = NULL;
    size_t body_len = 999;
    char nm[192];

    snprintf(nm, sizeof(nm), "strip/%s", c->name);
    chk(nm, tlb_frame_strip(c->in, c->in_len, &body, &body_len) ? 1 : 0, c->ok);
    if (!c->ok) return;
    eq(nm, body, body_len, c->want, c->want_len);
    g_checks++;
    if (body_len != 0 && !(body >= c->in && body + body_len <= c->in + c->in_len)) {
        g_fails++;
        printf("FAIL %-44s 指针越出输入缓冲\n", nm);
    }
}

// ---------------------------------------------------------------- UnsignedMessage{RKEAction}
static void test_rke(const tlb_g_rke *c) {
    uint8_t buf[64], tiny[1];
    char nm[160];

    memset(buf, 0xAA, sizeof(buf));
    size_t n = tlb_msg_encode_rke(c->action, buf, sizeof(buf));
    snprintf(nm, sizeof(nm), "rke/%s", c->name);
    eq(nm, buf, n, c->bytes, c->bytes_len);

    // 缓冲不够必须返回 0，不能截断半帧发出去
    snprintf(nm, sizeof(nm), "rke/%s/trunc", c->name);
    chk(nm, (long long)tlb_msg_encode_rke(c->action, tiny, sizeof(tiny)), 0);
}

// ---------------------------------------------------------------- 握手请求
static void test_hs(const tlb_g_hs *c) {
    uint8_t buf[256];

    memset(buf, 0xAA, sizeof(buf));
    size_t n = tlb_msg_encode_handshake_request(c->domain, c->routing_address, c->public_key,
                                                c->uuid, buf, sizeof(buf));
    char nm[160];
    snprintf(nm, sizeof(nm), "hs/%s", c->name);
    eq(nm, buf, n, c->want, c->want_len);
}

// ---------------------------------------------------------------- 加白名单裸信封
static void test_addkey(const tlb_g_addkey *c) {
    uint8_t p[256], e[256];
    char nm[160];

    memset(p, 0xAA, sizeof(p));
    size_t pn = tlb_msg_encode_add_key_payload(c->public_key, c->public_key_len, c->role,
                                               c->form_factor, p, sizeof(p));
    snprintf(nm, sizeof(nm), "addkey/%s/payload", c->name);
    eq(nm, p, pn, c->payload, c->payload_len);

    memset(e, 0xAA, sizeof(e));
    size_t en = tlb_msg_encode_add_key_envelope(c->public_key, c->public_key_len, c->role,
                                                c->form_factor, e, sizeof(e));
    snprintf(nm, sizeof(nm), "addkey/%s/env", c->name);
    eq(nm, e, en, c->env, c->env_len);
    // 外层必须是 ToVCSECMessage{signedMessage} = field 1，否则车辆直接不回
    snprintf(nm, sizeof(nm), "addkey/%s/env_tag", c->name);
    chk(nm, en > 0 ? e[0] : 0, 0x0a);
}

// ---------------------------------------------------------------- 请求侧元数据
static void test_reqmeta(const tlb_g_reqmeta *c) {
    tlb_req_meta_t p;
    tlb_meta_t m;
    uint8_t out[TLB_META_MAX + 1], sha[32];
    char nm[160];

    memset(&p, 0, sizeof(p));
    p.signature_type = (uint8_t)c->signature_type;
    p.domain = (uint8_t)c->domain;
    p.vin = c->vin;
    p.epoch = c->epoch;
    p.epoch_len = c->epoch_len;
    p.expires_at = c->expires_at;
    p.counter = c->counter;
    p.flags = c->flags;

    memset(out, 0xAA, sizeof(out));
    memset(sha, 0xAA, sizeof(sha));
    if (!tlb_meta_build_request(&m, &p)) {
        g_checks++;
        g_fails++;
        printf("FAIL reqmeta/%s build=false\n", c->name);
        return;
    }
    snprintf(nm, sizeof(nm), "reqmeta/%s/tlv", c->name);
    eq(nm, out, tlb_meta_render(&m, NULL, 0, out, sizeof(out)), c->tlv, c->tlv_len);
    g_checks++;
    if (!tlb_meta_sha256(&m, NULL, 0, sha)) {
        g_fails++;
        printf("FAIL reqmeta/%s sha=false\n", c->name);
    }
    snprintf(nm, sizeof(nm), "reqmeta/%s/sha", c->name);
    eq(nm, sha, 32, c->sha, 32);

    // 超过 epochLength 必须拒绝：车辆只会当成非法 token
    tlb_req_meta_t bad = p;
    bad.expires_at = TLB_MAX_EPOCH_SECONDS + 1;
    snprintf(nm, sizeof(nm), "reqmeta/%s/over_range", c->name);
    chk(nm, tlb_meta_build_request(&m, &bad) ? 1 : 0, 0);
}

// ---------------------------------------------------------------- 响应侧元数据
static void test_resmeta(const tlb_g_resmeta *c) {
    tlb_resp_meta_t p;
    tlb_meta_t m;
    uint8_t out[TLB_META_MAX + 1], sha[32];
    char nm[160];

    memset(&p, 0, sizeof(p));
    p.domain = (uint8_t)c->domain;
    p.vin = c->vin;
    p.counter = c->counter;
    p.flags = c->flags;
    p.request_id = c->request_id;
    p.request_id_len = c->request_id_len;
    p.fault = c->fault;

    memset(out, 0xAA, sizeof(out));
    memset(sha, 0xAA, sizeof(sha));
    if (!tlb_meta_build_response(&m, &p)) {
        g_checks++;
        g_fails++;
        printf("FAIL resmeta/%s build=false\n", c->name);
        return;
    }
    snprintf(nm, sizeof(nm), "resmeta/%s/tlv", c->name);
    eq(nm, out, tlb_meta_render(&m, NULL, 0, out, sizeof(out)), c->tlv, c->tlv_len);
    g_checks++;
    if (!tlb_meta_sha256(&m, NULL, 0, sha)) {
        g_fails++;
        printf("FAIL resmeta/%s sha=false\n", c->name);
    }
    snprintf(nm, sizeof(nm), "resmeta/%s/sha", c->name);
    eq(nm, sha, 32, c->sha, 32);
}

// ---------------------------------------------------------------- 子密钥派生
static void test_subkey(const tlb_g_subkey *c) {
    uint8_t got[32];
    char nm[160];

    memset(got, 0xAA, sizeof(got));
    tlb_hmac_sha256(c->key, c->key_len, (const uint8_t *)c->label, strlen(c->label), got);
    snprintf(nm, sizeof(nm), "subkey/%s", c->name);
    eq(nm, got, 32, c->want, 32);
}

// ---------------------------------------------------------------- session_info HMAC
static void test_sihmac(const tlb_g_sihmac *c) {
    uint8_t sub[32], vin[TLB_VIN_MAX], got[32];
    tlb_meta_t m;
    char nm[160];

    // 与探针 handshake.sessionInfoHmac 同构：子密钥 + sigtype/VIN/challenge 三段必写元数据
    tlb_hmac_sha256(c->key, c->key_len, (const uint8_t *)"session info", 12, sub);
    tlb_meta_init(&m);
    if (!tlb_meta_add_byte(&m, TLB_TAG_SIGNATURE_TYPE, TLB_SIG_HMAC)
        || !tlb_meta_add(&m, TLB_TAG_PERSONALIZATION, vin,
                         tlb_meta_upper_vin(c->vin, vin, sizeof(vin)))
        || !tlb_meta_add(&m, TLB_TAG_CHALLENGE, c->challenge, c->challenge_len)) {
        g_checks++;
        g_fails++;
        printf("FAIL sihmac/%s meta=false\n", c->name);
        return;
    }
    memset(got, 0xAA, sizeof(got));
    g_checks++;
    if (!tlb_meta_hmac(&m, sub, sizeof(sub), c->message, c->message_len, got)) {
        g_fails++;
        printf("FAIL sihmac/%s hmac=false\n", c->name);
        return;
    }
    snprintf(nm, sizeof(nm), "sihmac/%s", c->name);
    eq(nm, got, 32, c->want, 32);
}

// ---------------------------------------------------------------- 端到端加密命令
static void test_cmd(const tlb_g_cmd *c) {
    uint8_t dtag[16];
    tlb_req_meta_t mp;
    tlb_meta_t m;
    tlb_cmd_wire_t w;
    tlb_rm_t rm;
    uint8_t tlv[TLB_META_MAX + 1], aad[32], ct[512], tag[16], wire[1024], back[512];
    char nm[160];

    // 1) 元数据：AAD = SHA256(TLV ‖ 0xFF)
    memset(&mp, 0, sizeof(mp));
    mp.signature_type = TLB_SIG_AES_GCM_PERSONALIZED;
    mp.domain = (uint8_t)c->domain;
    mp.vin = TEST_VIN;
    mp.epoch = c->epoch;
    mp.epoch_len = c->epoch_len;
    mp.expires_at = c->expires_at;
    mp.counter = c->counter;
    mp.flags = c->flags;
    memset(tlv, 0xAA, sizeof(tlv));
    memset(aad, 0xAA, sizeof(aad));
    if (!tlb_meta_build_request(&m, &mp) || !tlb_meta_sha256(&m, NULL, 0, aad)) {
        g_checks++;
        g_fails++;
        printf("FAIL cmd/%s meta=false\n", c->name);
        return;
    }
    snprintf(nm, sizeof(nm), "cmd/%s/tlv", c->name);
    eq(nm, tlv, tlb_meta_render(&m, NULL, 0, tlv, sizeof(tlv)), c->tlv, c->tlv_len);
    snprintf(nm, sizeof(nm), "cmd/%s/aad", c->name);
    eq(nm, aad, 32, c->aad, c->aad_len);

    // 2) GCM：进线的是密文，明文只参与加密
    memset(ct, 0xAA, sizeof(ct));
    memset(tag, 0xAA, sizeof(tag));
    tlb_aes128_gcm_encrypt(c->key, c->nonce, c->nonce_len, aad, 32, c->plain, c->plain_len, ct,
                           tag);
    snprintf(nm, sizeof(nm), "cmd/%s/ct", c->name);
    eq(nm, ct, c->plain_len, c->ct, c->ct_len);
    snprintf(nm, sizeof(nm), "cmd/%s/tag", c->name);
    eq(nm, tag, 16, c->tag, 16);

    // 3) 线格式组包（字段书写顺序是硬约束）
    memset(&w, 0, sizeof(w));
    w.domain = c->domain;
    w.routing_address = c->routing_address;
    w.payload = ct;
    w.payload_len = c->plain_len;
    w.signer_public_key = c->public_key;
    w.signer_public_key_len = c->public_key_len;
    w.epoch = c->epoch;
    w.epoch_len = c->epoch_len;
    w.nonce = c->nonce;
    w.nonce_len = c->nonce_len;
    w.counter = c->counter;
    w.expires_at = c->expires_at;
    w.tag = tag;
    w.tag_len = 16;
    w.uuid = c->uuid;
    w.uuid_len = c->uuid_len;
    w.flags = c->flags;
    memset(wire, 0xAA, sizeof(wire));
    size_t n = tlb_msg_encode_command(&w, wire, sizeof(wire));
    snprintf(nm, sizeof(nm), "cmd/%s/wire", c->name);
    eq(nm, wire, n, c->want, c->want_len);

    // 4) 自己组的帧必须原样解回来（收/发共用一套字段语义）
    memset(&rm, 0, sizeof(rm));
    snprintf(nm, sizeof(nm), "cmd/%s/roundtrip", c->name);
    chk(nm, tlb_msg_decode_rm(c->want, c->want_len, &rm) ? 1 : 0, 1);
    eq_opt("cmd", "rt.payload", c->want, c->want_len, rm.payload, rm.payload_len, c->ct,
           c->ct_len);
    chk_u("cmd", "rt.counter", rm.sig.gp_counter, c->counter);
    chk_b("cmd", "rt.has_counter", rm.sig.gp_has_counter, 1);
    // expires_at==0 时 fixed32 等于默认值且不在 oneof 里 → 整个字段消失
    chk_b("cmd", "rt.has_expires", rm.sig.gp_has_expires_at, c->expires_at == 0 ? 0 : 1);
    chk_u("cmd", "rt.expires", rm.sig.gp_expires_at, c->expires_at);
    eq_opt("cmd", "rt.tag", c->want, c->want_len, rm.sig.gp_tag, rm.sig.gp_tag_len, c->tag, 16);
    chk_u("cmd", "rt.flags", rm.flags, c->flags);

    // 5) 用同一份 AAD 解密回明文，确认 counter/nonce/aad 自洽
    memset(back, 0xAA, sizeof(back));
    memset(dtag, 0xAA, sizeof(dtag));
    tlb_aes128_gcm_decrypt(c->key, c->nonce, c->nonce_len, aad, 32, c->ct, c->ct_len, back, dtag);
    snprintf(nm, sizeof(nm), "cmd/%s/dec", c->name);
    eq(nm, back, c->ct_len, c->plain, c->plain_len);
    snprintf(nm, sizeof(nm), "cmd/%s/dec_tag", c->name);
    eq(nm, dtag, 16, c->tag, 16);
}

// ---------------------------------------------------------------- 解码：RoutableMessage
static void test_decrm(const tlb_g_decrm *c) {
    tlb_rm_t rm;
    char pre[192];

    snprintf(pre, sizeof(pre), "decrm/%s", c->name);
    memset(&rm, 0, sizeof(rm));
    chk(pre, tlb_msg_decode_rm(c->bytes, c->bytes_len, &rm) ? 1 : 0, 1);
    chk_u(pre, "known", rm.known, c->known);
    chk_b(pre, "has_to_domain", rm.has_to_domain, c->has_to_domain);
    chk_b(pre, "has_from_domain", rm.has_from_domain, c->has_from_domain);
    chk_b(pre, "has_payload", rm.has_payload, c->has_payload);
    chk_b(pre, "has_si", rm.has_session_info, c->has_si);
    chk_b(pre, "has_status", rm.has_status, c->has_status);
    chk_u(pre, "to_domain", rm.to_domain, c->to_domain);
    chk_u(pre, "from_domain", rm.from_domain, c->from_domain);
    chk_u(pre, "op_status", rm.operation_status, c->operation_status);
    chk_u(pre, "sm_fault", rm.signed_message_fault, c->signed_message_fault);
    chk_u(pre, "flags", rm.flags, c->flags);

    eq_opt(pre, "from_routing", c->bytes, c->bytes_len, rm.from_routing_address,
           rm.from_routing_address_len, c->from_routing, c->from_routing_len);
    eq_opt(pre, "payload", c->bytes, c->bytes_len, rm.payload, rm.payload_len, c->payload,
           c->payload_len);
    eq_opt(pre, "si", c->bytes, c->bytes_len, rm.session_info, rm.session_info_len, c->si,
           c->si_len);
    eq_opt(pre, "uuid", c->bytes, c->bytes_len, rm.uuid, rm.uuid_len, c->uuid, c->uuid_len);
    eq_opt(pre, "request_uuid", c->bytes, c->bytes_len, rm.request_uuid, rm.request_uuid_len,
           c->request_uuid, c->request_uuid_len);
    eq_opt(pre, "signer_pk", c->bytes, c->bytes_len, rm.sig.signer_pubkey,
           rm.sig.signer_pubkey_len, c->signer_pk, c->signer_pk_len);
    eq_opt(pre, "si_tag", c->bytes, c->bytes_len, rm.sig.session_info_tag,
           rm.sig.session_info_tag_len, c->si_tag, c->si_tag_len);
    eq_opt(pre, "gp_epoch", c->bytes, c->bytes_len, rm.sig.gp_epoch, rm.sig.gp_epoch_len,
           c->gp_epoch, c->gp_epoch_len);
    eq_opt(pre, "gp_tag", c->bytes, c->bytes_len, rm.sig.gp_tag, rm.sig.gp_tag_len, c->gp_tag,
           c->gp_tag_len);
    eq_opt(pre, "resp_nonce", c->bytes, c->bytes_len, rm.sig.resp_nonce, rm.sig.resp_nonce_len,
           c->resp_nonce, c->resp_nonce_len);
    eq_opt(pre, "resp_tag", c->bytes, c->bytes_len, rm.sig.resp_tag, rm.sig.resp_tag_len,
           c->resp_tag, c->resp_tag_len);

    chk_u(pre, "gp_has_counter", rm.sig.gp_has_counter, c->gp_has_counter);
    chk_u(pre, "gp_counter", rm.sig.gp_counter, c->gp_counter);
    chk_u(pre, "gp_has_expires", rm.sig.gp_has_expires_at, c->gp_has_expires_at);
    chk_u(pre, "gp_expires", rm.sig.gp_expires_at, c->gp_expires_at);
    chk_u(pre, "resp_has_counter", rm.sig.resp_has_counter, c->resp_has_counter);
    chk_u(pre, "resp_counter", rm.sig.resp_counter, c->resp_counter);

    // signature_data 的 oneof 只可能命中一个；命中位由期望值反推
    int expect_present = c->signer_pk_len || c->si_tag_len || c->gp_tag_len || c->resp_tag_len;
    chk_b(pre, "sig_present", rm.sig.present, expect_present);
    chk_b(pre, "has_gcm_personalized", rm.sig.has_gcm_personalized, c->gp_tag_len ? 1 : 0);
    chk_b(pre, "has_session_info_tag", rm.sig.has_session_info_tag, c->si_tag_len ? 1 : 0);
    chk_b(pre, "has_response_data", rm.sig.has_response_data, c->resp_tag_len ? 1 : 0);
    g_checks++;
    if ((rm.sig.has_gcm_personalized ? 1 : 0) + (rm.sig.has_session_info_tag ? 1 : 0)
        + (rm.sig.has_response_data ? 1 : 0) > 1) {
        g_fails++;
        printf("FAIL %s/oneof 命中了多个签名类型\n", pre);
    }
}

// ---------------------------------------------------------------- 解码：SessionInfo
static void test_decsi(const tlb_g_decsi *c) {
    tlb_session_info_t si;
    char pre[192];

    snprintf(pre, sizeof(pre), "decsi/%s", c->name);
    memset(&si, 0, sizeof(si));
    chk(pre, tlb_msg_decode_session_info(c->bytes, c->bytes_len, &si) ? 1 : 0, 1);
    chk_u(pre, "known", si.known, c->known);
    chk_b(pre, "has_counter", si.has_counter, c->has_counter);
    chk_u(pre, "counter", si.counter, c->counter);
    chk_b(pre, "has_clock", si.has_clock_time, c->has_clock_time);
    chk_u(pre, "clock_time", si.clock_time, c->clock_time);
    chk_b(pre, "has_status", si.has_status, c->has_status);
    chk_u(pre, "status", si.status, c->status);
    chk_b(pre, "has_handle", si.has_handle, c->has_handle);
    chk_u(pre, "handle", si.handle, c->handle);
    eq_opt(pre, "public_key", c->bytes, c->bytes_len, si.public_key, si.public_key_len,
           c->public_key, c->public_key_len);
    eq_opt(pre, "epoch", c->bytes, c->bytes_len, si.epoch, si.epoch_len, c->epoch, c->epoch_len);
}

// ---------------------------------------------------------------- 解码：FromVCSECMessage
static void test_decvc(const tlb_g_decvc *c) {
    tlb_vcsec_t v;
    tlb_rm_t rm;
    char pre[192];

    snprintf(pre, sizeof(pre), "decvc/%s", c->name);

    // 降级判据：这类帧解成 RoutableMessage 必须一个已知字段都不命中
    memset(&rm, 0, sizeof(rm));
    if (tlb_msg_decode_rm(c->bytes, c->bytes_len, &rm)) {
        chk_u(pre, "rm_known", rm.known, c->rm_known);
    } else {
        chk_u(pre, "rm_known", c->rm_known == 0 ? 0 : 1, 0);
    }

    memset(&v, 0, sizeof(v));
    chk(pre, tlb_msg_decode_from_vcsec(c->bytes, c->bytes_len, &v) ? 1 : 0, 1);
    chk_u(pre, "known", v.known, c->known);
    chk_b(pre, "command_status", v.has_command_status, c->has_command_status);
    chk_b(pre, "op_status", v.has_operation_status, c->has_operation_status);
    chk_u(pre, "operation_status", v.operation_status, c->operation_status);
    chk_b(pre, "sm_counter", v.has_sm_counter, c->has_sm_counter);
    chk_u(pre, "sm_counter", v.sm_counter, c->sm_counter);
    chk_b(pre, "smi", v.has_smi, c->has_smi);
    chk_u(pre, "smi", v.signed_message_information, c->smi);
    // 空 whitelistOperationStatus{} 也要置位：这是「已受理、等实体卡」的唯一判据
    chk_b(pre, "wl_status", v.has_whitelist_status, c->has_whitelist_status);
    chk_b(pre, "wl_info", v.has_wl_information, c->has_wl_information);
    chk_u(pre, "wl_info", v.wl_information, c->wl_information);
    chk_b(pre, "wl_op", v.has_wl_operation_status, c->has_wl_operation_status);
    chk_u(pre, "wl_op", v.wl_operation_status, c->wl_operation_status);
    chk_b(pre, "vehicle_status", v.has_vehicle_status, c->has_vehicle_status);
    chk_b(pre, "nominal_error", v.has_nominal_error, c->has_nominal_error);
    chk_u(pre, "nominal", v.nominal_error, c->nominal_error);
}

// ------------------------------------------------------------------ 会话密钥派生
static void test_vkey(const tlb_g_bytes *c) {
    uint8_t got[TLB_KEY_LEN];
    char nm[160];

    memset(got, 0xAA, sizeof(got));
    chk(c->name, tlb_v3_shared_key(c->in, c->inlen, got) ? 1 : 0, 1);
    snprintf(nm, sizeof(nm), "%s/key", c->name);
    eq(nm, got, TLB_KEY_LEN, c->want, c->wantlen);
}

// ------------------------------------------------------------------ 采纳 session_info
// out_* 一列是「调用之后的完整会话快照」：失败用例里它等于初始值，
// 因此无论成功失败都逐字段比对，等价于探针里的 snap() 前后交叉校验。
static void test_apply(const tlb_g_apply *c) {
    tlb_v3_session_t s;
    tlb_v3_hs_info_t info;
    tlb_err_t r;
    char pre[192];

    snprintf(pre, sizeof(pre), "apply/%s", c->name);

    tlb_v3_session_reset(&s);
    if (c->key_len) {
        memcpy(s.key, c->key, c->key_len);
        s.has_key = true;
    }
    if (c->init_epoch_len) {
        memcpy(s.epoch, c->init_epoch, c->init_epoch_len);
        s.epoch_len = c->init_epoch_len;
    }
    s.counter = c->init_counter;
    s.has_set_time = c->has_set_time != 0;
    s.set_time = c->set_time;

    memset(&info, 0, sizeof(info));
    r = tlb_v3_apply_session_info(&s, c->vin, c->challenge, c->challenge_len, c->encoded,
                                  c->encoded_len, c->tag, c->tag_len, (int64_t)c->now, &info);

    chk(pre, (long long)r, (long long)c->err);
    eq(pre, s.epoch, s.epoch_len, c->out_epoch, c->out_epoch_len);
    eq(pre, s.vehicle_pub, s.vehicle_pub_len, c->out_pub, c->out_pub_len);
    chk_u(pre, "clock_time", s.clock_time, c->clock_time);
    chk_u(pre, "set_time", s.set_time, c->set_time_after);
    chk_b(pre, "has_set_time", s.has_set_time, c->has_set_time_after);
    chk(pre, (long long)s.anchor, (long long)c->anchor);
    chk_u(pre, "counter", s.counter, c->counter);
    chk_b(pre, "ready", s.ready, c->ready);
    chk_u(pre, "info.status", info.status, c->status);
    chk_b(pre, "info.not_whitelisted", info.key_not_whitelisted, c->not_whitelisted);
}

// ------------------------------------------------------------------ 解密车辆响应
static void test_resp(const tlb_g_resp *c) {
    tlb_v3_session_t s;
    tlb_rm_t rm;
    uint8_t out[256];
    size_t out_len = 0;
    uint32_t counter = 0;
    tlb_err_t r;
    char pre[192];

    snprintf(pre, sizeof(pre), "resp/%s", c->name);

    tlb_v3_session_reset(&s);
    memcpy(s.key, c->key, c->key_len);
    s.has_key = true;

    memset(&rm, 0, sizeof(rm));
    chk(pre, tlb_msg_decode_rm(c->bytes, c->bytes_len, &rm) ? 1 : 0, 1);

    memset(out, 0xAA, sizeof(out));
    r = tlb_v3_decrypt_response(&s, &rm, c->vin, c->request_id, c->request_id_len, out,
                                sizeof(out), &out_len, &counter);
    chk(pre, (long long)r, (long long)c->err);
    if (c->err != 0) return; // 失败时明文/counter 无定义，只锁错误码
    eq(pre, out, out_len, c->want, c->want_len);
    chk_u(pre, "counter", counter, c->counter);
}

// ------------------------------------------------------------------ 调度层：协议层终态
static void test_proto(const tlb_g_proto *c) {
    char pre[192];
    char text[TLB_TEXT_MAX];
    tlb_action_t a;

    snprintf(pre, sizeof(pre), "proto/%s", c->name);
    text[0] = '\0';
    a = tlb_proto_outcome(c->fault, c->op_status, text, sizeof(text));
    chk_u(pre, "action", (unsigned long long)a, (unsigned long long)c->action);
    chk_s(pre, "text", text, c->text);
}

// ---------------------------------------------------------------- 调度层：应用层终态
static void test_appout(const tlb_g_appout *c) {
    tlb_vcsec_t v;
    char pre[192];
    char text[TLB_TEXT_MAX];
    tlb_action_t a;

    snprintf(pre, sizeof(pre), "appout/%s", c->name);
    memset(&v, 0, sizeof(v));
    chk(pre, tlb_msg_decode_from_vcsec(c->bytes, c->bytes_len, &v) ? 1 : 0, 1);
    text[0] = '\0';
    a = tlb_app_outcome(&v, c->domain, text, sizeof(text));
    chk_u(pre, "action", (unsigned long long)a, (unsigned long long)c->action);
    chk_s(pre, "text", text, c->text);
}

// ------------------------------------------------------ 调度层：应用层摘要（summarizeVcsec）
static void test_sum(const tlb_g_sum *c) {
    tlb_vcsec_t v;
    tlb_app_t app;
    char pre[192];

    snprintf(pre, sizeof(pre), "sum/%s", c->name);
    memset(&v, 0, sizeof(v));
    chk(pre, tlb_msg_decode_from_vcsec(c->bytes, c->bytes_len, &v) ? 1 : 0, 1);
    memset(&app, 0xAA, sizeof(app));
    tlb_summarize_vcsec(&v, &app);
    chk_u(pre, "kind", (unsigned long long)app.kind, (unsigned long long)c->kind);
    chk_u(pre, "status", app.status, c->status);
    chk_b(pre, "has_counter", app.has_counter, c->has_counter);
    chk_u(pre, "counter", app.counter, c->counter);
    chk_s(pre, "text", app.text, c->text);
}

// ----------------------------------------------------- 调度层：GenericError 下一步提示
static void test_hint(const tlb_g_hint *c) {
    char pre[192];
    char out[TLB_TEXT_MAX];

    snprintf(pre, sizeof(pre), "hint/%s", c->name);
    out[0] = '\0';
    tlb_generic_error_hint_text(c->in, out, sizeof(out));
    chk_s(pre, "hint", out, c->hint);
}

// ------------------------------------------------------- 调度层：单帧判读（decodeFrame）
static void test_dframe(const tlb_g_dframe *c) {
    tlb_v3_session_t s;
    tlb_frame_ctx_t ctx;
    tlb_frame_out_t out;
    static tlb_dispatch_scratch_t sc; // 约 4KB，放 static 免得压栈
    char pre[192];

    snprintf(pre, sizeof(pre), "dframe/%s", c->name);

    tlb_v3_session_reset(&s);
    if (c->key) {
        memcpy(s.key, c->key, c->key_len);
        s.has_key = true;
    }

    memset(&ctx, 0, sizeof(ctx));
    ctx.name = "UNLOCK";
    ctx.domain = TLB_DOMAIN_VCSEC;
    ctx.vin = TEST_VIN;
    ctx.session = c->key ? &s : NULL;
    ctx.routing_address = g_dispatch_ctx[0].b; // 闸门一：车辆的 to
    ctx.uuid = g_dispatch_ctx[1].b;            // 闸门二：本次 request_uuid 模板
    ctx.request_id = g_dispatch_ctx[2].b;
    ctx.request_id_len = g_dispatch_ctx[2].len;
    ctx.ops = NULL;

    memset(&out, 0xAA, sizeof(out));
    tlb_decode_frame(c->bytes, c->bytes_len, &ctx, &sc, &out);

    chk_b(pre, "skipped", out.skipped, c->skipped);
    chk_u(pre, "skip", (unsigned long long)out.skip, (unsigned long long)c->skip);
    chk_b(pre, "refused", out.refused, c->refused);
    chk_u(pre, "fault", out.fault, c->fault);
    chk_u(pre, "op_status", out.op_status, c->op_status);
    chk_u(pre, "app.kind", (unsigned long long)out.app.kind, (unsigned long long)c->app_kind);
    chk_u(pre, "app.status", out.app.status, c->app_status);
    chk_s(pre, "app.text", out.app.text, c->app_text);
    chk_s(pre, "text", out.text, c->text);
}

// ------------------------------------------- 调度层：端到端桩（假 ops + 虚拟时钟）
// 桩的行为完全照抄探针 tools/gen_goldens.mjs 里的 mkBle()/state：
//   · send 与 receive 共用一个队列游标（探针 ble().send 返回第一片响应，后续帧走 receive）
//   · 队列取完后 sticky 重复末帧，否则返回「超时无响应」
//   · 时钟只由 sleep_ms 推进；探针用真实时钟，故 maxMs 只取与 sleep 粒度差一个数量级的值
static long long g_fk_now;
static const tlb_g_blob *g_fk_queue;
static size_t g_fk_n_queue;
static int g_fk_seq, g_fk_sticky, g_fk_link_error, g_fk_connected, g_fk_has_key;
static const char *g_fk_mtu;
static uint8_t fk_priv[32];
static uint8_t fk_pub[65];

// 加白名单（探针 / 绑定）用的「带时间戳帧队列」桩 —— 与探针 gen_goldens 里的 mkBleT 同构：
//   · 队首帧的 at <= 虚拟钟 → 立刻交出，时钟不动；
//   · 否则不交帧，时钟 += 本次等待的时间片。
// 绑定循环里没有 sleep，时间唯一的前进源就是等帧超时，所以裸数组模型在这里不成立
// （add-key 之后的 receive 是贪婪循环，会在探针之前就把队列抽干）。
static const tlb_g_tw *g_fk_tw;
static size_t g_fk_n_tw, g_fk_tw_seq;
static int g_fk_use_tw, g_fk_fail_exchange_at, g_fk_exchanges;

static int64_t fk_now_ms(void *ud)
{
    (void)ud;
    return (int64_t)g_fk_now;
}

static void fk_sleep(void *ud, int64_t ms)
{
    (void)ud;
    g_fk_now += ms;
}

static bool fk_connected(void *ud)
{
    (void)ud;
    return g_fk_connected != 0;
}

static bool fk_has_key(void *ud)
{
    (void)ud;
    return g_fk_has_key != 0;
}

static int fk_pop_timed(uint8_t *out, size_t cap, int64_t timeout_ms)
{
    const tlb_g_tw *f;

    if (g_fk_tw_seq < g_fk_n_tw) {
        f = &g_fk_tw[g_fk_tw_seq];
        if (f->at <= g_fk_now) {
            g_fk_tw_seq++;
            if (f->len > cap) return -1;
            memcpy(out, f->b, f->len);
            return (int)f->len;
        }
    }
    g_fk_now += timeout_ms; // 这一片时间内没帧可交：时钟独自前进
    return 0;
}

static int fk_pop(uint8_t *out, size_t cap)
{
    const tlb_g_blob *f;

    if ((size_t)g_fk_seq >= g_fk_n_queue) {
        if (!g_fk_sticky || g_fk_n_queue == 0) return 0;
        g_fk_seq = (int)g_fk_n_queue - 1;
    }
    f = &g_fk_queue[(size_t)g_fk_seq++];
    if (f->len > cap) return -1;
    memcpy(out, f->b, f->len);
    return (int)f->len;
}

static int fk_exchange(void *ud, const uint8_t *frame, size_t frame_len, int64_t timeout_ms,
                       bool keep_queue, uint8_t *out, size_t cap)
{
    (void)ud;
    (void)frame;
    (void)frame_len;
    (void)keep_queue;
    if (g_fk_use_tw) { // 探针 ble().send：先数第几针，再决定抛不抛「链路错误」
        g_fk_exchanges++;
        if (g_fk_fail_exchange_at != 0 && g_fk_exchanges == g_fk_fail_exchange_at) return -1;
        return fk_pop_timed(out, cap, timeout_ms);
    }
    if (g_fk_link_error) return -1; // 探针 ble().send 抛异常
    return fk_pop(out, cap);
}

static int fk_receive(void *ud, uint8_t *out, size_t cap, int64_t timeout_ms)
{
    (void)ud;
    if (g_fk_use_tw) return fk_pop_timed(out, cap, timeout_ms);
    return fk_pop(out, cap);
}

static const char *fk_mtu_note(void *ud)
{
    (void)ud;
    return g_fk_mtu;
}

static void fk_ops(tlb_dispatch_ops_t *ops, int connected, int has_key, int link_error, int sticky,
                   const tlb_g_blob *queue, size_t n_queue, const char *mtu_note)
{
    memset(ops, 0, sizeof(*ops));
    ops->now_ms = fk_now_ms;
    ops->sleep_ms = fk_sleep;
    ops->connected = fk_connected;
    ops->has_key = fk_has_key;
    ops->exchange = fk_exchange;
    ops->receive = fk_receive;
    ops->signer_priv = fk_priv;
    ops->signer_pub = fk_pub;
    ops->signer_pub_len = sizeof(fk_pub);
    ops->mtu_note = fk_mtu_note;

    g_fk_now = 0;
    g_fk_seq = 0;
    g_fk_use_tw = 0;
    g_fk_tw = NULL;
    g_fk_n_tw = 0;
    g_fk_tw_seq = 0;
    g_fk_fail_exchange_at = 0;
    g_fk_exchanges = 0;
    g_fk_connected = connected;
    g_fk_has_key = has_key;
    g_fk_link_error = link_error;
    g_fk_sticky = sticky;
    g_fk_queue = queue;
    g_fk_n_queue = n_queue;
    g_fk_mtu = mtu_note;
}

// 探针 / 绑定用例的时钟原点：整秒，让 localNow() = 原点/1000 在两侧同值
#define FK_BIND_BASE_MS 1700000000000LL

// 换成「带时间戳帧队列」桩；fail_exchange_at != 0 表示第 N 次 exchange 抛链路错误。
// 必须在 fk_ops 之后调用（它会清零时钟）。密钥材料 / ECDH 夹具一并注入。
static void fk_bind(const tlb_g_tw *tw, size_t n_tw, int fail_exchange_at)
{
    g_fk_use_tw = 1;
    g_fk_tw = tw;
    g_fk_n_tw = n_tw;
    g_fk_tw_seq = 0;
    g_fk_fail_exchange_at = fail_exchange_at;
    g_fk_exchanges = 0;
    g_fk_now = FK_BIND_BASE_MS;
}

// ------------------------------------------------- 调度层：tlb_send_request 端到端
static void test_send_request(const tlb_g_send *c)
{
    tlb_dispatch_ops_t ops;
    tlb_request_t req;
    tlb_request_result_t res;
    static tlb_dispatch_scratch_t sc; // 约 4KB，放 static 免得压栈
    static tlb_v3_session_t s;
    char pre[192];

    snprintf(pre, sizeof(pre), "send/%s", c->name);
    fk_ops(&ops, c->connected, c->has_key, c->link_error, c->sticky, c->queue, c->n_queue,
           c->mtu_note);

    memset(&req, 0, sizeof(req));
    req.name = (c->cmd && c->cmd[0] != '\0') ? c->cmd : NULL;
    req.domain = c->domain;
    req.vin = c->has_vin ? TEST_VIN : "";
    req.plain = c->plain != 0;
    req.payload = c->payload;
    req.payload_len = c->payload_len;
    req.max_ms = c->max_ms;
    req.done = (tlb_done_t)c->done;

    tlb_v3_session_reset(&s);
    memset(&res, 0xAA, sizeof(res));
    (void)tlb_send_request(&req, &s, &ops, &sc, &res);

    chk_b(pre, "ok", res.ok, c->ok);
    chk_b(pre, "timeout", res.timeout, c->timeout);
    chk_u(pre, "fault", res.fault, c->fault);
    chk_s(pre, "text", res.text, c->text);
}

// ---------------------------------------------------- 调度层：tlb_handshake 端到端
static void test_handshake(const tlb_g_handshake *c)
{
    tlb_dispatch_ops_t ops;
    tlb_handshake_result_t res;
    static tlb_dispatch_scratch_t sc;
    static tlb_v3_session_t s;
    char pre[192];

    snprintf(pre, sizeof(pre), "hs/%s", c->name);
    fk_ops(&ops, c->connected, c->has_key, 0, 0, NULL, 0, NULL); // 探针握手桩：队列恒空

    tlb_v3_session_reset(&s);
    if (c->reuse) { // 已有可复用会话（桩字段照探针 S.v3[domain]）
        memset(s.key, 0x5A, sizeof(s.key));
        s.has_key = true;
        memset(s.epoch, 0x11, sizeof(s.epoch));
        s.epoch_len = sizeof(s.epoch);
        memcpy(s.vehicle_pub, fk_pub, sizeof(s.vehicle_pub));
        s.vehicle_pub_len = sizeof(s.vehicle_pub);
        s.has_anchor = true;
        s.anchor = 0;
        s.has_set_time = true;
        s.set_time = 0;
        s.clock_time = 0;
        s.counter = c->counter;
        s.ready = true;
    }

    memset(&res, 0xAA, sizeof(res));
    (void)tlb_handshake(c->force != 0, c->domain, c->has_vin ? TEST_VIN : "", &s, &ops, &sc, NULL,
                        &res);

    chk_b(pre, "ok", res.ok, c->ok);
    chk_b(pre, "reused", res.reused, c->reused);
    chk_b(pre, "fatal", res.fatal, c->fatal);
    chk_b(pre, "not_whitelisted", res.not_whitelisted, c->not_whitelisted);
    chk_s(pre, "text", res.text, c->text);
}

// ---------------------------------------- 加白名单：密钥材料 + 复用会话预置
// g_bind_keys = { 本机私钥, 本机公钥, 车辆公钥, ECDH X 坐标 }，与探针 p256.js 实算同源。
extern void tlb_host_set_ecdh_fixture(const uint8_t *priv, const uint8_t *pub, const uint8_t *x);

#define FK_BIND_CLOCK 1700000000u // = FK_BIND_BASE_MS / 1000，令 anchor 在预探针时刻为 0

static void fk_bind_setup(tlb_dispatch_ops_t *ops, const tlb_g_tw *queue, size_t n_queue,
                          int connected, int has_key, int fail_exchange_at)
{
    fk_ops(ops, connected, has_key, 0, 0, NULL, 0, NULL);
    fk_bind(queue, n_queue, fail_exchange_at);
    memcpy(fk_priv, g_bind_keys[0].b, sizeof(fk_priv));
    memcpy(fk_pub, g_bind_keys[1].b, sizeof(fk_pub));
    tlb_host_set_ecdh_fixture(g_bind_keys[0].b, g_bind_keys[2].b, g_bind_keys[3].b);
}

static void fk_bind_reuse(tlb_v3_session_t *s, uint32_t counter)
{
    tlb_v3_session_reset(s);
    memset(s->key, 0x5A, sizeof(s->key)); // 只有「有没有 key」参与判定，值不参与文案
    s->has_key = true;
    memset(s->epoch, 0x11, sizeof(s->epoch));
    s->epoch_len = sizeof(s->epoch);
    memcpy(s->vehicle_pub, g_bind_keys[2].b, g_bind_keys[2].len);
    s->vehicle_pub_len = (size_t)g_bind_keys[2].len;
    s->clock_time = FK_BIND_CLOCK;
    s->has_set_time = true;
    s->set_time = FK_BIND_CLOCK;
    s->has_anchor = true;
    s->anchor = 0;
    s->counter = counter;
    s->ready = true;
}

// ---------------------------------------------- 加白名单：tlb_probe_enrollment
static void test_probe_enrollment(const tlb_g_probe *c)
{
    tlb_dispatch_ops_t ops;
    tlb_bind_opts_t o;
    tlb_bind_result_t res;
    static tlb_dispatch_scratch_t sc;
    static tlb_v3_session_t s;
    char pre[192];
    tlb_err_t e;

    snprintf(pre, sizeof(pre), "probe/%s", c->name);
    fk_bind_setup(&ops, c->queue, c->n_queue, c->connected, c->has_key, 0);
    if (c->reuse) {
        fk_bind_reuse(&s, c->counter);
    } else {
        tlb_v3_session_reset(&s);
    }

    memset(&o, 0, sizeof(o));
    o.force = c->force != 0;

    memset(&res, 0xAA, sizeof(res));
    e = tlb_probe_enrollment(c->has_vin ? TEST_VIN : "", &o, &s, &ops, &sc, &res);

    chk_b(pre, "ok", res.ok, c->ok);
    chk_b(pre, "paired", res.paired, c->paired);
    chk_b(pre, "reused", res.reused, c->reused);
    chk_b(pre, "not_whitelisted", res.not_whitelisted, c->not_whitelisted);
    chk_b(pre, "err==TLB_OK", e == TLB_OK, c->ok);
    chk_s(pre, "text", res.text, c->text);
}

// ----------------------------------------------------- 加白名单：tlb_bind_key
static void test_bind_key(const tlb_g_bind *c)
{
    tlb_dispatch_ops_t ops;
    tlb_bind_opts_t o;
    tlb_bind_result_t res;
    static tlb_dispatch_scratch_t sc;
    static tlb_v3_session_t s;
    char pre[192];

    snprintf(pre, sizeof(pre), "bind/%s", c->name);
    fk_bind_setup(&ops, c->queue, c->n_queue, c->connected, 1, c->fail_exchange_at);
    tlb_v3_session_reset(&s);

    memset(&o, 0, sizeof(o));
    o.window_ms = c->window_ms;
    o.receive_ms = c->receive_ms;
    o.probe_first_ms = c->probe_first_ms;
    o.probe_interval_ms = c->probe_interval_ms;
    o.form_factor = c->form_factor;
    o.has_form_factor = c->has_form_factor != 0;

    memset(&res, 0xAA, sizeof(res));
    (void)tlb_bind_key(c->has_vin ? TEST_VIN : "", &o, &s, &ops, &sc, &res);

    chk_b(pre, "ok", res.ok, c->ok);
    chk_b(pre, "paired", res.paired, c->paired);
    chk_b(pre, "already", res.already, c->already);
    chk_b(pre, "wait", res.wait, c->wait);
    chk_b(pre, "has_info", res.has_info, c->has_info);
    chk_u(pre, "info", res.info, c->info);
    chk_u(pre, "probes", (unsigned long long)res.probes, (unsigned long long)c->probes);
    chk_s(pre, "text", res.text, c->text);
}

// ------------------------------------------------------------------ 辅助
static void test_const_equal(void) {
    static const uint8_t a[8] = { 1, 2, 3, 4, 5, 6, 7, 8 };
    static const uint8_t b[8] = { 1, 2, 3, 4, 5, 6, 7, 9 };
    g_checks += 2;
    if (!tlb_const_equal(a, a, 8)) { g_fails++; printf("FAIL const_equal/same\n"); }
    if (tlb_const_equal(a, b, 8)) { g_fails++; printf("FAIL const_equal/diff\n"); }
}

// ------------------------------------------------------------------ 持久化抽象
// 探针落盘走 uni storage 的 JSON，C 侧走定长 blob：格式对不上也没必要对上，
// 锁的是字段集合、恢复语义，以及「坏档绝不半截加载」。NVS 在这里用 RAM 后端顶替
// （槽位 1/2/3 → 下标 0/1/2）。
static uint8_t s_ram[3][TLB_STORE_BLOB_MAX];
static size_t s_ram_len[3];
static int s_ram_bad; // 位掩码：1=读失败 2=写失败 4=抹除失败

static int ram_idx(uint32_t slot) {
    if (slot < TLB_STORE_SLOT_KEY || slot > TLB_STORE_SLOT_INFOTAINMENT) return -1;
    return (int)slot - (int)TLB_STORE_SLOT_KEY;
}

static int ram_read(void *ud, uint32_t slot, uint8_t *out, size_t cap) {
    int i = ram_idx(slot);
    (void)ud;
    if (i < 0 || (s_ram_bad & 1) != 0) return -1;
    if (s_ram_len[i] == 0) return 0;
    if (s_ram_len[i] > cap) return -1; // 宁可报错，也不能截断成一份坏档
    memcpy(out, s_ram[i], s_ram_len[i]);
    return (int)s_ram_len[i];
}

static int ram_write(void *ud, uint32_t slot, const uint8_t *blob, size_t len) {
    int i = ram_idx(slot);
    (void)ud;
    if (i < 0 || (s_ram_bad & 2) != 0 || len > sizeof(s_ram[0])) return -1;
    memcpy(s_ram[i], blob, len);
    s_ram_len[i] = len;
    return 0;
}

static int ram_erase(void *ud, uint32_t slot) {
    int i = ram_idx(slot);
    (void)ud;
    if (i < 0 || (s_ram_bad & 4) != 0) return -1;
    memset(s_ram[i], 0, sizeof(s_ram[i])); // 抹干净，别让旧字节留下影子
    s_ram_len[i] = 0;
    return 0;
}

static const tlb_store_backend_t s_be = { NULL, ram_read, ram_write, ram_erase };

static void ram_reset(void) {
    memset(s_ram, 0, sizeof(s_ram));
    memset(s_ram_len, 0, sizeof(s_ram_len));
    s_ram_bad = 0;
}

// 读回长度越过 cap 的流氓后端：只有它能验证「超长当失败，不当截断」
static int rogue_read(void *ud, uint32_t slot, uint8_t *out, size_t cap) {
    (void)ud;
    (void)slot;
    (void)out;
    return (int)cap + 1;
}
static const tlb_store_backend_t s_rogue = { NULL, rogue_read, NULL, NULL };
static const tlb_store_backend_t s_noop = { NULL, NULL, NULL, NULL };

// 校验和重算（FNV-1a，与 tlb_store.c 同一套）。测试要用它把「改了一个字段」的 blob
// 重新封好，这样拒掉 blob 的才可能是字段校验，而不是先被校验和挡下。
static uint32_t t_fnv(const uint8_t *p, size_t n) {
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < n; i++) {
        h ^= p[i];
        h *= 16777619u;
    }
    return h;
}

static void t_reseal(uint8_t *blob, size_t len) {
    uint32_t h = t_fnv(blob, len - 4);
    blob[len - 4] = (uint8_t)(h >> 24);
    blob[len - 3] = (uint8_t)(h >> 16);
    blob[len - 2] = (uint8_t)(h >> 8);
    blob[len - 1] = (uint8_t)h;
}

// 两份只差一个字段的 blob → 那个字节的偏移；差 0 处或多于 1 处一律视为定位失败。
// 用「求差」而不是硬编码偏移，测试就不必跟着布局抄一遍。
static size_t t_diff_off(const uint8_t *a, const uint8_t *b, size_t len) {
    size_t off = (size_t)-1;
    for (size_t i = 0; i + 4 < len; i++) {
        if (a[i] == b[i]) continue;
        if (off != (size_t)-1) return (size_t)-1;
        off = i;
    }
    return off;
}

static void mk_key(tlb_store_key_t *k, const char *vin) {
    memset(k, 0, sizeof(*k));
    for (size_t i = 0; i < TLB_PRIV_LEN; i++) k->priv[i] = (uint8_t)(0x10 + i);
    k->pub[0] = 0x04;
    for (size_t i = 1; i < TLB_PUB_LEN; i++) k->pub[i] = (uint8_t)(0x40 + (i & 0x3F));
    k->has_pub = true;
    snprintf(k->vin, sizeof(k->vin), "%s", vin);
}

static void mk_ses(tlb_store_session_t *r) {
    memset(r, 0, sizeof(*r));
    r->counter = 0x01020304u;
    for (size_t i = 0; i < TLB_EPOCH_LEN; i++) r->epoch[i] = (uint8_t)(0x20 + i);
    r->has_epoch = true;
    r->vehicle_pub[0] = 0x04;
    for (size_t i = 1; i < TLB_PUB_LEN; i++) r->vehicle_pub[i] = (uint8_t)(0x80 + (i & 0x3F));
    r->has_pub = true;
    r->clock_time = 1700000000u;
    r->has_set_time = true;
    r->set_time = 1700000123u;
    r->has_anchor = true;
    r->anchor = -42; // 走一遍符号位：本地秒比车辆时钟慢时 anchor 是负数
    r->ready = true;
}

// 解不动的档必须整块作废，一个字节都不许漏进结构体。半截会话（counter 新、epoch 旧）
// 比没有会话可怕得多 —— 探针用 try/catch 兜住 fromHex 抛错，这里必须同样干脆。
static void chk_key_dead(const char *base, const uint8_t *blob, size_t len) {
    tlb_store_key_t p, q;
    memset(&p, 0x5A, sizeof(p)); // 只按字节比较，不读那些被写坏的布尔位
    q = p;
    chk_b(base, "reject", tlb_store_decode_key(&p, blob, len) ? 1 : 0, 0);
    chk_b(base, "no_partial_write", memcmp(&p, &q, sizeof(p)) == 0 ? 1 : 0, 1);
}

static void chk_ses_dead(const char *base, uint32_t domain, const uint8_t *blob, size_t len) {
    tlb_store_session_t p, q;
    memset(&p, 0x5A, sizeof(p));
    q = p;
    chk_b(base, "reject", tlb_store_decode_session(domain, &p, blob, len) ? 1 : 0, 0);
    chk_b(base, "no_partial_write", memcmp(&p, &q, sizeof(p)) == 0 ? 1 : 0, 1);
}

static void test_store(void) {
    uint8_t b1[TLB_STORE_BLOB_MAX], b2[TLB_STORE_BLOB_MAX], bb[TLB_STORE_BLOB_MAX];
    tlb_store_key_t k, k2, got;
    tlb_store_session_t r, r2;
    tlb_v3_session_t vs;
    const char *base;
    size_t len, len2, off;

    // ---- 1) 密钥：定长 + 全字段往返
    base = "store/key_roundtrip";
    ram_reset();
    mk_key(&k, "5YJ3E1EA7KF000000");
    len = tlb_store_encode_key(&k, b1, sizeof(b1));
    chk_u(base, "blob_len", len, 2u + TLB_PRIV_LEN + TLB_PUB_LEN + 1u + TLB_VIN_MAX + 4u);
    memset(&got, 0, sizeof(got));
    chk_b(base, "decode", tlb_store_decode_key(&got, b1, len) ? 1 : 0, 1);
    eq_f(base, "priv", got.priv, TLB_PRIV_LEN, k.priv, TLB_PRIV_LEN);
    eq_f(base, "pub", got.pub, TLB_PUB_LEN, k.pub, TLB_PUB_LEN);
    chk_b(base, "has_pub", got.has_pub, 1);
    chk_s(base, "vin", got.vin, "5YJ3E1EA7KF000000");

    // 后端往返（探针的 saveKeyPair / loadKey）
    chk_u(base, "save", tlb_store_save_key(&s_be, &k), TLB_STORE_OK);
    memset(&got, 0, sizeof(got));
    chk_u(base, "load", tlb_store_load_key(&s_be, &got), TLB_STORE_OK);
    chk_s(base, "loaded_vin", got.vin, "5YJ3E1EA7KF000000");
    eq_f(base, "loaded_priv", got.priv, TLB_PRIV_LEN, k.priv, TLB_PRIV_LEN);

    // ---- 2) pub 为空档：能加载出私钥，但 hasKey() 仍为 false（credential-store.js:36-44）
    base = "store/key_no_pub";
    k2 = k;
    k2.has_pub = false;
    memset(k2.pub, 0, sizeof(k2.pub));
    len2 = tlb_store_encode_key(&k2, b2, sizeof(b2));
    chk_u(base, "same_len", len2, len);
    memset(&got, 0, sizeof(got));
    chk_b(base, "decode", tlb_store_decode_key(&got, b2, len2) ? 1 : 0, 1);
    chk_b(base, "has_pub", got.has_pub, 0);
    eq_f(base, "priv", got.priv, TLB_PRIV_LEN, k.priv, TLB_PRIV_LEN);
    // 空 VIN 也合法：探针存 {priv,pub,vin:''} 时只保证有私钥，车辆靠绑定流程再补
    k2 = k;
    k2.vin[0] = '\0';
    len2 = tlb_store_encode_key(&k2, b2, sizeof(b2));
    memset(&got, 0, sizeof(got));
    chk_b(base, "empty_vin_decode", tlb_store_decode_key(&got, b2, len2) ? 1 : 0, 1);
    chk_s(base, "empty_vin", got.vin, "");

    // ---- 3) 超长 VIN 必须拒写（截断等于换成另一台车）
    base = "store/key_vin_too_long";
    k2 = k;
    memset(k2.vin, 'V', TLB_VIN_MAX); // 24 字节塞满，没有结尾
    chk_u(base, "encode", tlb_store_encode_key(&k2, b2, sizeof(b2)), 0);
    chk_u(base, "save", tlb_store_save_key(&s_be, &k2), TLB_STORE_INVALID);
    len2 = tlb_store_encode_key(&k, b2, sizeof(b2));
    chk_u(base, "nothing_written", s_ram_len[ram_idx(TLB_STORE_SLOT_KEY)], len2);
    chk_u(base, "cap_one_short", tlb_store_encode_key(&k, b2, len2 - 1), 0);
    // 边界：23 字符 + 结尾正好铺满 24 字节，必须写得下也读得回
    k2 = k;
    strcpy(k2.vin, "5YJ3E1EA7KF000000ABCDEF");
    chk_u(base, "vin_boundary_len", strlen(k2.vin) + 1, TLB_VIN_MAX);
    len2 = tlb_store_encode_key(&k2, b2, sizeof(b2));
    chk_b(base, "vin23_encode", len2 != 0, 1);
    memset(&got, 0, sizeof(got));
    chk_b(base, "vin23_decode", tlb_store_decode_key(&got, b2, len2) ? 1 : 0, 1);
    chk_s(base, "vin23", got.vin, "5YJ3E1EA7KF000000ABCDEF");

    // ---- 4) 密钥档的损坏判据：截断 / 多一字节 / 版本 / 槽位 / 校验和 / 字段
    base = "store/key_corrupt";
    memcpy(bb, b1, len);
    t_reseal(bb, len); // 原样重算必须仍然有效，否则测试自己的 FNV 就是错的
    chk_b(base, "reseal_identity", tlb_store_decode_key(&got, bb, len) ? 1 : 0, 1);
    chk_key_dead(base, b1, len - 1);
    memcpy(bb, b1, len);
    bb[len] = 0xAA;
    chk_key_dead(base, bb, len + 1);
    memcpy(bb, b1, len);
    bb[0] = (uint8_t)(TLB_STORE_VERSION + 1); // 改布局忘了升版本 → 旧档必须作废
    t_reseal(bb, len);
    chk_key_dead(base, bb, len);
    memcpy(bb, b1, len);
    bb[1] = (uint8_t)TLB_STORE_SLOT_VCSEC; // 密钥档冒充会话档
    t_reseal(bb, len);
    chk_key_dead(base, bb, len);
    memcpy(bb, b1, len);
    bb[len - 1] ^= 0x01; // 校验和被改：整块作废
    chk_key_dead(base, bb, len);
    memcpy(bb, b1, len);
    bb[2] ^= 0x80; // 载荷被改但没重算校验和
    chk_key_dead(base, bb, len);
    // has_pub 只认 0/1：其它值说明偏移错位
    k2 = k;
    k2.has_pub = false;
    len2 = tlb_store_encode_key(&k2, b2, sizeof(b2));
    off = t_diff_off(b1, b2, len);
    chk_u(base, "has_pub_offset", off != (size_t)-1, 1);
    if (off != (size_t)-1) {
        memcpy(bb, b1, len);
        bb[off] = 0x7F;
        t_reseal(bb, len);
        chk_key_dead(base, bb, len);
    }
    // VIN 区没有结尾 0 / 结尾后还有脏数据 → 布局被改写
    k2 = k;
    k2.vin[0] = 'A';
    k2.vin[1] = '\0';
    len2 = tlb_store_encode_key(&k2, b2, sizeof(b2));
    k2 = k;
    k2.vin[0] = 'B';
    k2.vin[1] = '\0';
    len2 = tlb_store_encode_key(&k2, bb, sizeof(bb));
    off = t_diff_off(b2, bb, len);
    chk_u(base, "vin_offset", off != (size_t)-1, 1);
    if (off != (size_t)-1) {
        memcpy(bb, b1, len);
        for (size_t i = 0; i < TLB_VIN_MAX; i++) bb[off + i] = 'C';
        t_reseal(bb, len);
        chk_key_dead(base, bb, len);
        memcpy(bb, b1, len);
        bb[off + 20] = 0x41; // 结尾之后混进非零字节
        t_reseal(bb, len);
        chk_key_dead(base, bb, len);
    }

    // ---- 5) 会话：定长 + 全字段往返（两个域各存一份）
    base = "store/ses_roundtrip";
    ram_reset();
    mk_ses(&r);
    len = tlb_store_encode_session(TLB_DOMAIN_VCSEC, &r, b1, sizeof(b1));
    chk_u(base, "blob_len", len,
          2u + 4u + 1u + TLB_EPOCH_LEN + 1u + TLB_PUB_LEN + 4u + 1u + 4u + 1u + 8u + 1u + 4u);
    chk_u(base, "fits", len <= TLB_STORE_BLOB_MAX, 1);
    memset(&r2, 0, sizeof(r2));
    chk_b(base, "decode", tlb_store_decode_session(TLB_DOMAIN_VCSEC, &r2, b1, len) ? 1 : 0, 1);
    chk_u(base, "counter", r2.counter, r.counter);
    eq_f(base, "epoch", r2.epoch, TLB_EPOCH_LEN, r.epoch, TLB_EPOCH_LEN);
    chk_b(base, "has_epoch", r2.has_epoch, 1);
    eq_f(base, "vehicle_pub", r2.vehicle_pub, TLB_PUB_LEN, r.vehicle_pub, TLB_PUB_LEN);
    chk_b(base, "has_pub", r2.has_pub, 1);
    chk_u(base, "clock_time", r2.clock_time, r.clock_time);
    chk_b(base, "has_set_time", r2.has_set_time, 1);
    chk_u(base, "set_time", r2.set_time, r.set_time);
    chk_b(base, "has_anchor", r2.has_anchor, 1);
    chk_u(base, "anchor", (unsigned long long)r2.anchor, (unsigned long long)r.anchor);
    chk_b(base, "ready", r2.ready, 1);
    chk_u(base, "save", tlb_store_save_session(&s_be, TLB_DOMAIN_INFOTAINMENT, &r), TLB_STORE_OK);
    memset(&r2, 0, sizeof(r2));
    chk_u(base, "load_infotainment",
          tlb_store_load_session(&s_be, TLB_DOMAIN_INFOTAINMENT, &r2), TLB_STORE_OK);
    chk_b(base, "loaded_ready", r2.ready, 1);
    chk_u(base, "vcsec_still_empty", tlb_store_load_session(&s_be, TLB_DOMAIN_VCSEC, &r2),
          TLB_STORE_NONE);

    // 各布尔位为假的组合：counter 照旧，其余保持「没有」
    memset(&r2, 0, sizeof(r2));
    r2.counter = 7;
    len2 = tlb_store_encode_session(TLB_DOMAIN_VCSEC, &r2, b2, sizeof(b2));
    memset(&r, 0xFF, sizeof(r));
    chk_b(base, "decode_bare", tlb_store_decode_session(TLB_DOMAIN_VCSEC, &r, b2, len2) ? 1 : 0, 1);
    chk_u(base, "bare_counter", r.counter, 7);
    chk_b(base, "bare_has_epoch", r.has_epoch, 0);
    chk_b(base, "bare_has_pub", r.has_pub, 0);
    chk_b(base, "bare_has_set_time", r.has_set_time, 0);
    chk_b(base, "bare_has_anchor", r.has_anchor, 0);
    chk_b(base, "bare_ready", r.ready, 0);

    // ---- 6) 会话档的损坏判据
    base = "store/ses_corrupt";
    mk_ses(&r);
    len = tlb_store_encode_session(TLB_DOMAIN_VCSEC, &r, b1, sizeof(b1));
    memset(&r2, 0, sizeof(r2));
    memcpy(bb, b1, len);
    t_reseal(bb, len);
    chk_b(base, "reseal_identity",
          tlb_store_decode_session(TLB_DOMAIN_VCSEC, &r2, bb, len) ? 1 : 0, 1);
    chk_ses_dead(base, TLB_DOMAIN_VCSEC, b1, len - 1);
    memcpy(bb, b1, len);
    bb[len] = 0x00;
    chk_ses_dead(base, TLB_DOMAIN_VCSEC, bb, len + 1);
    memcpy(bb, b1, len);
    bb[0] = 0;
    t_reseal(bb, len);
    chk_ses_dead(base, TLB_DOMAIN_VCSEC, bb, len);
    memcpy(bb, b1, len);
    bb[len - 4] = (uint8_t)(bb[len - 4] ^ 0xFF);
    chk_ses_dead(base, TLB_DOMAIN_VCSEC, bb, len);
    // 两域的档不能互相顶包：counter 各走各的，串了必须回退
    chk_ses_dead(base, TLB_DOMAIN_INFOTAINMENT, b1, len);
    memset(&r2, 0, sizeof(r2));
    chk_b(base, "right_domain", tlb_store_decode_session(TLB_DOMAIN_VCSEC, &r2, b1, len) ? 1 : 0, 1);
    // 五个布尔位逐个严格化：改成 0x7F 并修好校验和，仍须整块作废
    r2 = r;
    r2.has_epoch = false;
    len2 = tlb_store_encode_session(TLB_DOMAIN_VCSEC, &r2, b2, sizeof(b2));
    off = t_diff_off(b1, b2, len);
    chk_u(base, "has_epoch_offset", off != (size_t)-1, 1);
    if (off != (size_t)-1) {
        memcpy(bb, b1, len);
        bb[off] = 0x7F;
        t_reseal(bb, len);
        chk_ses_dead(base, TLB_DOMAIN_VCSEC, bb, len);
    }
    r2 = r;
    r2.ready = false;
    len2 = tlb_store_encode_session(TLB_DOMAIN_VCSEC, &r2, b2, sizeof(b2));
    off = t_diff_off(b1, b2, len);
    chk_u(base, "ready_offset", off != (size_t)-1, 1);
    if (off != (size_t)-1) {
        memcpy(bb, b1, len);
        bb[off] = 2;
        t_reseal(bb, len);
        chk_ses_dead(base, TLB_DOMAIN_VCSEC, bb, len);
    }
    r2 = r;
    r2.has_anchor = false;
    len2 = tlb_store_encode_session(TLB_DOMAIN_VCSEC, &r2, b2, sizeof(b2));
    off = t_diff_off(b1, b2, len);
    chk_u(base, "has_anchor_offset", off != (size_t)-1, 1);
    if (off != (size_t)-1) {
        memcpy(bb, b1, len);
        bb[off] = 3;
        t_reseal(bb, len);
        chk_ses_dead(base, TLB_DOMAIN_VCSEC, bb, len);
    }

    // ---- 7) v3 运行态 <-> 存档：共享密钥永不落盘，ready 还要 && epoch
    base = "store/v3_bridge";
    mk_ses(&r);
    r.has_epoch = false; // 病态档：ready 为真但没有 epoch
    memset(&vs, 0, sizeof(vs));
    vs.has_key = true;
    for (size_t i = 0; i < TLB_KEY_LEN; i++) vs.key[i] = 0x11;
    tlb_store_to_v3(&r, &vs);
    chk_b(base, "key_not_restored", vs.has_key, 0);
    int key_zero = 1;
    for (size_t i = 0; i < TLB_KEY_LEN; i++)
        if (vs.key[i] != 0) key_zero = 0;
    chk_b(base, "key_zeroed", key_zero, 1);
    chk_b(base, "ready_needs_epoch", vs.ready, 0);
    chk_u(base, "counter_kept", vs.counter, r.counter);
    chk_u(base, "epoch_len", vs.epoch_len, 0);
    chk_b(base, "anchor_kept", vs.has_anchor, 1);
    chk_u(base, "anchor_value", (unsigned long long)vs.anchor, (unsigned long long)r.anchor);
    r.has_epoch = true;
    tlb_store_to_v3(&r, &vs);
    chk_b(base, "ready_restored", vs.ready, 1);
    chk_u(base, "epoch_len_full", vs.epoch_len, TLB_EPOCH_LEN);
    eq_f(base, "epoch_bytes", vs.epoch, TLB_EPOCH_LEN, r.epoch, TLB_EPOCH_LEN);
    eq_f(base, "pub_bytes", vs.vehicle_pub, TLB_PUB_LEN, r.vehicle_pub, TLB_PUB_LEN);
    chk_u(base, "pub_len", vs.vehicle_pub_len, TLB_PUB_LEN);
    chk_u(base, "clock", vs.clock_time, r.clock_time);
    chk_u(base, "set_time", vs.set_time, r.set_time);
    chk_b(base, "has_set_time", vs.has_set_time, 1);
    // 抽取侧（等价 v3ToDisk 的输入）：epoch_len=0 必须翻成 has_epoch=false
    tlb_v3_session_reset(&vs);
    vs.counter = 99;
    vs.ready = true;
    tlb_store_from_v3(&r2, &vs);
    chk_u(base, "from_counter", r2.counter, 99);
    chk_b(base, "from_has_epoch", r2.has_epoch, 0);
    chk_b(base, "from_has_pub", r2.has_pub, 0);
    chk_b(base, "from_has_anchor", r2.has_anchor, 0);
    chk_b(base, "from_ready", r2.ready, 1);
    vs.epoch_len = TLB_EPOCH_LEN;
    vs.vehicle_pub_len = TLB_PUB_LEN;
    vs.has_anchor = true;
    vs.anchor = -1;
    tlb_store_from_v3(&r2, &vs);
    chk_b(base, "from_has_epoch2", r2.has_epoch, 1);
    chk_b(base, "from_has_pub2", r2.has_pub, 1);
    chk_u(base, "from_anchor2", (unsigned long long)r2.anchor, (unsigned long long)(-1));

    // ---- 8) 后端状态：没有档 / 坏档 / 读失败 / 写失败 / 槽位不合法
    base = "store/backend";
    ram_reset();
    chk_u(base, "load_key_none", tlb_store_load_key(&s_be, &got), TLB_STORE_NONE);
    chk_u(base, "load_ses_none", tlb_store_load_session(&s_be, TLB_DOMAIN_VCSEC, &r),
          TLB_STORE_NONE);
    chk_u(base, "save_key", tlb_store_save_key(&s_be, &k), TLB_STORE_OK);
    chk_u(base, "load_key_ok", tlb_store_load_key(&s_be, &got), TLB_STORE_OK);
    // 塞一份「长度对得上、头也对得上，只是内容读不懂」的垃圾 = 有档但损坏
    ram_reset();
    for (int row = 0; row < 3; row++) {
        for (size_t i = 0; i < TLB_STORE_BLOB_MAX; i++) s_ram[row][i] = (uint8_t)(i * 7u + 3u);
        s_ram[row][0] = (uint8_t)TLB_STORE_VERSION;
        s_ram[row][1] = (uint8_t)(row + 1);
        s_ram_len[row] = (row == 0)
                             ? (2u + TLB_PRIV_LEN + TLB_PUB_LEN + 1u + TLB_VIN_MAX + 4u)
                             : (2u + 4u + 1u + TLB_EPOCH_LEN + 1u + TLB_PUB_LEN + 4u + 1u + 4u +
                                1u + 8u + 1u + 4u);
    }
    chk_u(base, "load_key_corrupt", tlb_store_load_key(&s_be, &got), TLB_STORE_CORRUPT);
    chk_u(base, "load_ses_corrupt", tlb_store_load_session(&s_be, TLB_DOMAIN_VCSEC, &r),
          TLB_STORE_CORRUPT);
    chk_u(base, "load_ses_corrupt_info", tlb_store_load_session(&s_be, TLB_DOMAIN_INFOTAINMENT, &r),
          TLB_STORE_CORRUPT);
    // BROADCAST 不建会话（storeKeyOf 对它抛错）
    chk_u(base, "load_broadcast", tlb_store_load_session(&s_be, TLB_DOMAIN_BROADCAST, &r),
          TLB_STORE_BAD_SLOT);
    chk_u(base, "save_broadcast", tlb_store_save_session(&s_be, TLB_DOMAIN_BROADCAST, &r),
          TLB_STORE_BAD_SLOT);
    s_ram_bad = 4; // 抹除会失败：先验证槽位校验排在后端之前
    chk_u(base, "clear_broadcast", tlb_store_clear(&s_be, TLB_DOMAIN_BROADCAST), TLB_STORE_BAD_SLOT);
    s_ram_bad = 0;
    // 后端故障
    ram_reset();
    chk_u(base, "save_ok", tlb_store_save_key(&s_be, &k), TLB_STORE_OK);
    s_ram_bad = 1;
    chk_u(base, "read_fail", tlb_store_load_key(&s_be, &got), TLB_STORE_ERROR);
    chk_u(base, "read_fail_ses", tlb_store_load_session(&s_be, TLB_DOMAIN_VCSEC, &r),
          TLB_STORE_ERROR);
    s_ram_bad = 2;
    chk_u(base, "write_fail", tlb_store_save_key(&s_be, &k), TLB_STORE_ERROR);
    chk_u(base, "write_fail_ses", tlb_store_save_session(&s_be, TLB_DOMAIN_VCSEC, &r),
          TLB_STORE_ERROR);
    s_ram_bad = 4;
    chk_u(base, "erase_fail", tlb_store_clear(&s_be, TLB_STORE_SLOT_KEY), TLB_STORE_ERROR);
    s_ram_bad = 0;
    chk_u(base, "clear_ok", tlb_store_clear(&s_be, TLB_STORE_SLOT_KEY), TLB_STORE_OK);
    chk_u(base, "load_after_clear", tlb_store_load_key(&s_be, &got), TLB_STORE_NONE);
    chk_u(base, "ram_really_zeroed", s_ram_len[0], 0);
    // 后端缺函数指针 / 读回超长 / 传 NULL
    chk_u(base, "rogue_over_cap", tlb_store_load_key(&s_rogue, &got), TLB_STORE_ERROR);
    chk_u(base, "no_read", tlb_store_load_key(&s_noop, &got), TLB_STORE_ERROR);
    chk_u(base, "no_write", tlb_store_save_key(&s_noop, &k), TLB_STORE_ERROR);
    chk_u(base, "no_erase", tlb_store_clear(&s_noop, TLB_STORE_SLOT_KEY), TLB_STORE_ERROR);
    chk_u(base, "null_backend", tlb_store_load_key(NULL, &got), TLB_STORE_ERROR);
    // 会话 blob 冒充密钥 blob（版本号相同，槽位不同）
    ram_reset();
    mk_ses(&r);
    len = tlb_store_encode_session(TLB_DOMAIN_VCSEC, &r, b1, sizeof(b1));
    memcpy(s_ram[0], b1, len);
    s_ram_len[0] = len;
    chk_u(base, "slot_swap", tlb_store_load_key(&s_be, &got), TLB_STORE_CORRUPT);
    // 两个域各存一份：counter 独立，互不覆盖
    ram_reset();
    mk_ses(&r);
    r.counter = 11;
    chk_u(base, "save_vcsec", tlb_store_save_session(&s_be, TLB_DOMAIN_VCSEC, &r), TLB_STORE_OK);
    r.counter = 22;
    chk_u(base, "save_info", tlb_store_save_session(&s_be, TLB_DOMAIN_INFOTAINMENT, &r),
          TLB_STORE_OK);
    memset(&r2, 0, sizeof(r2));
    chk_u(base, "load_vcsec", tlb_store_load_session(&s_be, TLB_DOMAIN_VCSEC, &r2), TLB_STORE_OK);
    chk_u(base, "vcsec_counter", r2.counter, 11);
    memset(&r2, 0, sizeof(r2));
    chk_u(base, "load_info", tlb_store_load_session(&s_be, TLB_DOMAIN_INFOTAINMENT, &r2),
          TLB_STORE_OK);
    chk_u(base, "info_counter", r2.counter, 22);
    chk_u(base, "clear_vcsec", tlb_store_clear(&s_be, TLB_STORE_SLOT_VCSEC), TLB_STORE_OK);
    chk_u(base, "info_untouched", tlb_store_load_session(&s_be, TLB_DOMAIN_INFOTAINMENT, &r2),
          TLB_STORE_OK);
    chk_u(base, "vcsec_gone", tlb_store_load_session(&s_be, TLB_DOMAIN_VCSEC, &r2), TLB_STORE_NONE);
}

// ---------------------------------------------------------------- 广播名 / 分包上限
static void test_identity(void) {
    char base[96];
    char buf[64];
    size_t i;

    for (i = 0; i < TLB_G_N(g_names_cases); i++) {
        const tlb_g_names *c = &g_names_cases[i];
        tlb_ble_names_t n;
        snprintf(base, sizeof(base), "names[%zu]", i);
        memset(&n, 0x7F, sizeof(n));
        tlb_ble_names_for_vin(c->vin, &n);
        chk_s(base, "exact", n.exact, c->exact);
        chk_s(base, "prefix", n.prefix, c->prefix);
    }

    for (i = 0; i < TLB_G_N(g_norm_cases); i++) {
        const tlb_g_norm *c = &g_norm_cases[i];
        size_t want = strlen(c->out);
        size_t k;
        memset(buf, 0x7F, sizeof(buf));
        chk_u(c->name, "len", tlb_norm_name(c->in, buf, sizeof(buf)), want);
        chk_s(c->name, "out", buf, c->out);
        // 截断安全：缓冲只够 cap-1 个字符时也要以 \0 收尾，且一字节都不许多写
        for (k = 1; k <= want + 2; k++) {
            memset(buf, 0x7F, sizeof(buf));
            tlb_norm_name(c->in, buf, k);
            snprintf(base, sizeof(base), "%s.cut%zu", c->name, k);
            chk_u(base, "len", strlen(buf), (k - 1 < want) ? k - 1 : want);
            chk_u(base, "guard", buf[k], 0x7F);
        }
    }

    for (i = 0; i < TLB_G_N(g_match_cases); i++) {
        const tlb_g_match *c = &g_match_cases[i];
        tlb_ble_names_t n;
        char m[64];
        tlb_match_mode_t got;
        snprintf(base, sizeof(base), "match[%zu]", i);
        tlb_ble_names_for_vin(c->vin, &n);
        // 未命中时 matched 不被写（探针那边是返回 null），所以调用方自己清空再比对
        m[0] = '\0';
        got = tlb_match_adv_name(&n, c->adv, m, sizeof(m));
        chk_u(c->name, "mode", got, c->mode);
        chk_u(c->name, "matched_len", strlen(m), strlen(c->matched));
        chk_s(c->name, "matched", m, c->matched);
    }

    for (i = 0; i < TLB_G_N(g_svc_cases); i++) {
        const tlb_g_svc *c = &g_svc_cases[i];
        const char *one[1];
        const char *none[2];
        chk_b(c->name, "uuid", tlb_uuid_is_tesla_service(c->uuid), c->hit);
        one[0] = c->uuid;
        chk_b(c->name, "list1", tlb_has_tesla_service(one, 1), c->hit);
        none[0] = NULL;
        none[1] = c->uuid;
        chk_b(c->name, "list_null_first", tlb_has_tesla_service(none, 2), c->hit);
    }

    // 引导列表形状识别（fw36 修复老款哈希名车扫不进列表的回归锁）
    {
        static const struct {
            const char *name;
            const char *case_name;
            bool want;
        } shape_cases[] = {
            { "S0123456789abcdefC", "hash_old_suffix_C", true },   // 老款：S+16hex+尾缀（合成值，禁真名）
            { "See13c959535a3b7d", "hash_no_suffix", true },       // 老款：S+16hex 无尾缀（假VIN夹具）
            { "SEE13C959535A3B7DP", "hash_upper_P", true },        // 大写 hex + 尾缀 P
            { "Tesla 000000", "new_with_space", true },            // 新款：Tesla+空格+6位
            { "Tesla000000", "new_no_space", true },               // 新款变体：无空格
            { "tesla-000000", "new_dash_lower", true },            // 分隔符变体
            { "midea38:2F:B0", "midea", false },                   // 随机家电
            { "CFMOTO-072668", "cfmoto", false },                  // 随机车机
            { "S0123456789abcde", "hash_15hex", false },           // 只有 15 位 hex
            { "S0123456789abcdefZ", "hash_bad_suffix", false },    // 尾缀不在 CRDP 内
            { "X0123456789abcdefC", "bad_head", false },           // 头字母不是 S
            { "Tesla 00000", "new_5digits", false },               // 尾号不足 6 位
            { "", "empty", false },
            { NULL, "null", false },
        };
        for (i = 0; i < (int)(sizeof(shape_cases) / sizeof(shape_cases[0])); i++) {
            chk_b(shape_cases[i].case_name, "shape",
                  tlb_name_looks_like_tesla(shape_cases[i].name), shape_cases[i].want);
        }
    }

    for (i = 0; i < TLB_G_N(g_cap_cases); i++) {
        const tlb_g_cap *c = &g_cap_cases[i];
        chk_u(c->name, "cap", tlb_payload_cap(c->mtu), (unsigned long long)c->cap);
    }
    // mtu-manager.js:17 的阶梯是常量表，不在金标准里也要钉住（换 MTU 时按它试探）
    chk_u("mtu_steps[0]", "v", tlb_mtu_steps[0], 517);
    chk_u("mtu_steps[1]", "v", tlb_mtu_steps[1], 247);
    chk_u("mtu_steps[2]", "v", tlb_mtu_steps[2], 185);
    chk_u("mtu_steps[3]", "v", tlb_mtu_steps[3], 128);
    chk_u("mtu_steps[4]", "v", tlb_mtu_steps[4], 64);
}

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0); // 崩溃时也要能看到最后一条 FAIL
    for (size_t i = 0; i < TLB_G_N(g_sha256_cases); i++) test_sha(&g_sha256_cases[i], 1);
    for (size_t i = 0; i < TLB_G_N(g_sha1_cases); i++) test_sha(&g_sha1_cases[i], 0);
    for (size_t i = 0; i < TLB_G_N(g_hmac_cases); i++) test_hmac(&g_hmac_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_aes_block_cases); i++) test_block(&g_aes_block_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_gcm_cases); i++) test_gcm(&g_gcm_cases[i]);
    test_const_equal();

    for (size_t i = 0; i < TLB_G_N(g_frame_cases); i++) test_frame(&g_frame_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_prepend_cases); i++) test_prepend(&g_prepend_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_strip_cases); i++) test_strip(&g_strip_cases[i]);

    for (size_t i = 0; i < TLB_G_N(g_rke_cases); i++) test_rke(&g_rke_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_hs_cases); i++) test_hs(&g_hs_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_addkey_cases); i++) test_addkey(&g_addkey_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_reqmeta_cases); i++) test_reqmeta(&g_reqmeta_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_resmeta_cases); i++) test_resmeta(&g_resmeta_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_subkey_cases); i++) test_subkey(&g_subkey_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_sihmac_cases); i++) test_sihmac(&g_sihmac_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_cmd_cases); i++) test_cmd(&g_cmd_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_vkey_cases); i++) test_vkey(&g_vkey_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_apply_cases); i++) test_apply(&g_apply_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_resp_cases); i++) test_resp(&g_resp_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_decrm_cases); i++) test_decrm(&g_decrm_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_decsi_cases); i++) test_decsi(&g_decsi_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_decvc_cases); i++) test_decvc(&g_decvc_cases[i]);

    for (size_t i = 0; i < TLB_G_N(g_proto_cases); i++) test_proto(&g_proto_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_appout_cases); i++) test_appout(&g_appout_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_sum_cases); i++) test_sum(&g_sum_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_hint_cases); i++) test_hint(&g_hint_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_dframe_cases); i++) test_dframe(&g_dframe_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_send_cases); i++) test_send_request(&g_send_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_handshake_cases); i++) test_handshake(&g_handshake_cases[i]);
    // 加白名单两组用真 ECDH 夹具，放最后，避免污染前面「派生必须失败」的用例
    for (size_t i = 0; i < TLB_G_N(g_probe_cases); i++) test_probe_enrollment(&g_probe_cases[i]);
    for (size_t i = 0; i < TLB_G_N(g_bind_cases); i++) test_bind_key(&g_bind_cases[i]);
    // 持久化抽象不依赖金标准：锁的是「坏档绝不半截加载」和「共享密钥永不落盘」
    test_store();
    // 广播名/匹配/分包上限：设备层扫描过滤要用它，规则必须由探针实算锁死
    test_identity();

    printf("\n%d checks, %d failed\n", g_checks, g_fails);
    return g_fails ? 1 : 0;
}
