// components/tesla_core/src/tlb_v3.c
// V3 会话层实现。语义必须与探针 src/protocol/v3/{handshake,aead}.js 一致，
// 由 tests/host 的金标准逐字节锁死。
#include <string.h>

#include "tesla_core/tlb_aes.h"
#include "tesla_core/tlb_meta.h"
#include "tesla_core/tlb_sha.h"
#include "tesla_core/tlb_v3.h"

#define LABEL_SESSION_INFO "session info"
#define LABEL_MESSAGE_AUTH "authenticated command"

void tlb_v3_session_reset(tlb_v3_session_t *s) { memset(s, 0, sizeof(*s)); }

bool tlb_v3_shared_key(const uint8_t *shared, size_t shared_len, uint8_t out[TLB_KEY_LEN]) {
    uint8_t digest[20];
    if (!shared || shared_len < TLB_SHARED_LEN || !out) return false;
    tlb_sha1(shared, TLB_SHARED_LEN, digest);
    memcpy(out, digest, TLB_KEY_LEN);
    return true;
}

bool tlb_v3_derive_key(const uint8_t priv[TLB_PRIV_LEN], const uint8_t pub[TLB_PUB_LEN],
                       uint8_t out[TLB_KEY_LEN]) {
    uint8_t shared[TLB_SHARED_LEN];
    if (!tlb_port_ecdh(priv, pub, shared)) return false;
    return tlb_v3_shared_key(shared, sizeof(shared), out);
}

void tlb_v3_subkey(const uint8_t *key, size_t klen, const char *label, uint8_t out[32]) {
    tlb_hmac_sha256(key, klen, (const uint8_t *)label, strlen(label), out);
}

void tlb_v3_session_info_hmac(const uint8_t key[TLB_KEY_LEN], const char *vin,
                              const uint8_t *challenge, size_t challenge_len,
                              const uint8_t *encoded, size_t encoded_len, uint8_t out[32]) {
    tlb_meta_t m;
    uint8_t sub[32];
    uint8_t vin_buf[TLB_VIN_MAX];
    size_t vin_len = tlb_meta_upper_vin(vin, vin_buf, sizeof(vin_buf));

    tlb_meta_init(&m);
    tlb_meta_add_byte(&m, TLB_TAG_SIGNATURE_TYPE, TLB_SIG_HMAC);
    tlb_meta_add(&m, TLB_TAG_PERSONALIZATION, vin_buf, vin_len);
    // 对应 JS 的 Metadata.add(tag, null)：challenge 缺失时整段不写，而不是写 [06][00]
    tlb_meta_add_opt(&m, TLB_TAG_CHALLENGE, challenge, challenge_len);
    tlb_v3_subkey(key, TLB_KEY_LEN, LABEL_SESSION_INFO, sub);
    tlb_meta_hmac(&m, sub, sizeof(sub), encoded, encoded_len, out);
}

tlb_err_t tlb_v3_apply_session_info(tlb_v3_session_t *s, const char *vin,
                                    const uint8_t *challenge, size_t challenge_len,
                                    const uint8_t *encoded, size_t encoded_len,
                                    const uint8_t *tag, size_t tag_len, int64_t now,
                                    tlb_v3_hs_info_t *info) {
    uint8_t expect[32];
    tlb_session_info_t si;
    uint32_t clock_time, status, counter;
    bool accept;

    if (!s->has_key) return TLB_ERR_NO_KEY; // 还没有共享密钥，无法校验握手
    if (!encoded || encoded_len == 0) return TLB_ERR_PROTO; // 响应里没有 session_info
    if (!tag || tag_len == 0) return TLB_ERR_PROTO; // 响应里没有 session_info_tag

    tlb_v3_session_info_hmac(s->key, vin, challenge, challenge_len, encoded, encoded_len, expect);
    if (!tlb_const_equal(expect, tag, tag_len)) return TLB_ERR_CRYPTO;

    if (!tlb_msg_decode_session_info(encoded, encoded_len, &si)) return TLB_ERR_PROTO;
    if (si.public_key_len != TLB_PUB_LEN || si.public_key[0] != 0x04) return TLB_ERR_PROTO;
    if (si.epoch_len != TLB_EPOCH_LEN) return TLB_ERR_PROTO;

    clock_time = si.has_clock_time ? si.clock_time : 0;
    status = si.has_status ? si.status : 0;
    counter = si.has_counter ? si.counter : 0;

    // signer.go UpdateSessionInfo：epoch 变了，或车辆时钟没倒退，才接受新的会话参数
    accept = s->epoch_len != TLB_EPOCH_LEN || memcmp(s->epoch, si.epoch, TLB_EPOCH_LEN) != 0 ||
             !s->has_set_time || s->set_time <= clock_time;
    if (!accept) return TLB_ERR_STATE; // 同一 epoch 且车辆时钟倒退：整份握手当作没收到

    if (info) {
        info->counter = counter;
        info->clock_time = clock_time;
        info->status = status;
        info->key_not_whitelisted = (status == TLB_SI_STATUS_KEY_NOT_ON_WHITELIST);
    }

    memcpy(s->epoch, si.epoch, TLB_EPOCH_LEN);
    s->epoch_len = TLB_EPOCH_LEN;
    memcpy(s->vehicle_pub, si.public_key, TLB_PUB_LEN);
    s->vehicle_pub_len = TLB_PUB_LEN;
    s->clock_time = clock_time;
    s->set_time = clock_time;
    s->has_set_time = true;
    s->anchor = now - (int64_t)clock_time;
    s->has_anchor = true;
    if (counter > s->counter) s->counter = counter; // counter 只上调
    s->ready = (status == TLB_SI_STATUS_OK);
    return TLB_OK;
}

tlb_err_t tlb_v3_encrypt_command(tlb_v3_session_t *s, const tlb_v3_cmd_t *c, uint8_t *scratch,
                                 size_t scratch_len, uint8_t *out, size_t cap,
                                 tlb_v3_cmd_out_t *res) {
    tlb_meta_t m;
    tlb_req_meta_t rm;
    tlb_cmd_wire_t cw;
    uint32_t counter, expires_at;
    uint8_t tag[TLB_TAG_LEN];

    if (!res) return TLB_ERR_PROTO;
    if (!s->has_key || !s->epoch_len || !s->has_anchor) return TLB_ERR_NO_KEY;
    if (!c->routing_address || !c->uuid || !c->signer_pub || !c->vin) return TLB_ERR_PROTO;
    if (scratch_len < c->payload_len) return TLB_ERR_RANGE;
    if (cap < c->payload_len + TLB_V3_FRAME_OVERHEAD) return TLB_ERR_RANGE;

    counter = s->counter + 1;
    // 0xFFFFFFFF 是官方保留的 counterMax 哨兵，永远不能发出去
    if (counter >= 0xffffffffu) return TLB_ERR_RANGE;
    expires_at = (uint32_t)((int64_t)c->now - s->anchor + (int64_t)c->expires_in);

    memset(&rm, 0, sizeof(rm));
    rm.signature_type = TLB_SIG_AES_GCM_PERSONALIZED;
    rm.domain = (uint8_t)c->domain;
    rm.vin = c->vin;
    rm.epoch = s->epoch;
    rm.epoch_len = s->epoch_len;
    rm.expires_at = expires_at;
    rm.counter = counter;
    rm.flags = c->flags;
    if (!tlb_meta_build_request(&m, &rm)) return TLB_ERR_PROTO;
    if (!tlb_meta_sha256(&m, NULL, 0, res->aad)) return TLB_ERR_PROTO;

    if (c->nonce) {
        if (c->nonce_len != TLB_NONCE_LEN) return TLB_ERR_PROTO;
        memcpy(res->nonce, c->nonce, TLB_NONCE_LEN);
    } else {
        tlb_port_random(res->nonce, TLB_NONCE_LEN);
    }

    tlb_aes128_gcm_encrypt(s->key, res->nonce, TLB_NONCE_LEN, res->aad, 32, c->payload,
                           c->payload_len, scratch, tag);
    memcpy(res->tag, tag, TLB_TAG_LEN);

    memset(&cw, 0, sizeof(cw));
    cw.domain = c->domain;
    cw.routing_address = c->routing_address;
    cw.payload = scratch;
    cw.payload_len = c->payload_len;
    cw.signer_public_key = c->signer_pub;
    cw.signer_public_key_len = c->signer_pub_len;
    cw.epoch = s->epoch;
    cw.epoch_len = s->epoch_len;
    cw.nonce = res->nonce;
    cw.nonce_len = TLB_NONCE_LEN;
    cw.counter = counter;
    cw.expires_at = expires_at;
    cw.tag = tag;
    cw.tag_len = TLB_TAG_LEN;
    cw.uuid = c->uuid;
    cw.uuid_len = TLB_ADDR_LEN;
    cw.flags = c->flags;

    res->frame_len = tlb_msg_encode_command(&cw, out, cap);
    if (res->frame_len == 0) return TLB_ERR_PROTO;

    // 整帧组好才落地：上面任何一步失败等于这个 counter 没被用掉
    res->counter = counter;
    res->expires_at = expires_at;
    res->ciphertext_len = c->payload_len;
    res->request_id[0] = TLB_SIG_AES_GCM_PERSONALIZED;
    memcpy(res->request_id + 1, tag, TLB_TAG_LEN);
    res->request_id_len = 1 + TLB_TAG_LEN;
    s->counter = counter;
    return TLB_OK;
}

bool tlb_v3_request_id(const tlb_rm_t *rm, uint8_t out[TLB_REQUEST_ID_MAX], size_t *out_len) {
    // 本项目所有请求都走 AES_GCM_PERSONALIZED（signer.go 的 encryptWithCounter），
    // 探针的 HMAC_Personalized_data 分支没有对应解码路径，这里不写无法验证的死代码。
    if (!rm->sig.has_gcm_personalized || rm->sig.gp_tag_len != TLB_TAG_LEN) return false;
    out[0] = TLB_SIG_AES_GCM_PERSONALIZED;
    memcpy(out + 1, rm->sig.gp_tag, TLB_TAG_LEN);
    *out_len = 1 + TLB_TAG_LEN;
    return true;
}

tlb_err_t tlb_v3_decrypt_response(const tlb_v3_session_t *s, const tlb_rm_t *rm, const char *vin,
                                  const uint8_t *request_id, size_t request_id_len, uint8_t *out,
                                  size_t cap, size_t *out_len, uint32_t *counter_out) {
    tlb_meta_t m;
    tlb_resp_meta_t p;
    uint8_t aad[32], expect_tag[TLB_TAG_LEN];
    uint32_t counter;
    const uint8_t *ct;
    size_t ct_len;

    if (!rm->sig.has_response_data) return TLB_ERR_PROTO;
    if (!s->has_key) return TLB_ERR_NO_KEY;

    // 官方 peer.go 用 GetFromDestination().GetDomain()，nil 安全 → 缺字段就是 0（BROADCAST）
    memset(&p, 0, sizeof(p));
    p.domain = rm->has_from_domain ? (uint8_t)(rm->from_domain & 0xff) : 0;
    p.vin = vin;
    p.counter = rm->sig.resp_has_counter ? rm->sig.resp_counter : 0;
    p.flags = rm->flags;
    p.request_id = request_id;
    p.request_id_len = request_id ? request_id_len : 0;
    p.fault = rm->signed_message_fault;
    counter = p.counter;

    if (!tlb_meta_build_response(&m, &p)) return TLB_ERR_PROTO;
    if (!tlb_meta_sha256(&m, NULL, 0, aad)) return TLB_ERR_PROTO;

    ct = rm->has_payload ? rm->payload : NULL;
    ct_len = rm->has_payload ? rm->payload_len : 0;
    if (ct_len > cap) return TLB_ERR_RANGE;

    tlb_aes128_gcm_decrypt(s->key, rm->sig.resp_nonce, rm->sig.resp_nonce_len, aad, 32, ct, ct_len,
                           out, expect_tag);
    if (rm->sig.resp_tag_len != TLB_TAG_LEN ||
        !tlb_const_equal(expect_tag, rm->sig.resp_tag, TLB_TAG_LEN))
        return TLB_ERR_CRYPTO;

    if (out_len) *out_len = ct_len;
    if (counter_out) *counter_out = counter;
    return TLB_OK;
}
