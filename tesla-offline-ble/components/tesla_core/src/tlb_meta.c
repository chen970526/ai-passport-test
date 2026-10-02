// components/tesla_core/src/tlb_meta.c
#include "tesla_core/tlb_meta.h"

#include <string.h>

#include "tesla_core/tlb_aes.h"
#include "tesla_core/tlb_sha.h"

#define TLB_END_TAG 0xFFu

void tlb_meta_init(tlb_meta_t *m)
{
    m->len = 0;
    m->last_tag = -1;
    m->failed = false;
}

bool tlb_meta_ok(const tlb_meta_t *m)
{
    return !m->failed;
}

size_t tlb_meta_len(const tlb_meta_t *m)
{
    return m->failed ? 0 : m->len;
}

bool tlb_meta_add(tlb_meta_t *m, uint8_t tag, const uint8_t *v, size_t vlen)
{
    if (m->failed) {
        return false;
    }
    if (vlen > 255) {
        m->failed = true;
        return false;
    }
    if ((int)tag <= m->last_tag) {
        m->failed = true; // tag 必须严格递增
        return false;
    }
    if (vlen > TLB_META_MAX - m->len - 2) {
        m->failed = true;
        return false;
    }
    m->last_tag = tag;
    m->tlv[m->len++] = tag;
    m->tlv[m->len++] = (uint8_t)vlen;
    if (vlen) {
        if (!v) {
            m->failed = true;
            return false;
        }
        memcpy(m->tlv + m->len, v, vlen);
        m->len += vlen;
    }
    return true;
}

bool tlb_meta_add_opt(tlb_meta_t *m, uint8_t tag, const uint8_t *v, size_t vlen)
{
    if (!v) {
        return !m->failed;
    }
    return tlb_meta_add(m, tag, v, vlen);
}

bool tlb_meta_add_byte(tlb_meta_t *m, uint8_t tag, uint8_t v)
{
    return tlb_meta_add(m, tag, &v, 1);
}

bool tlb_meta_add_u32(tlb_meta_t *m, uint8_t tag, uint32_t v)
{
    uint8_t be[4] = { (uint8_t)(v >> 24), (uint8_t)(v >> 16), (uint8_t)(v >> 8), (uint8_t)v };
    return tlb_meta_add(m, tag, be, 4);
}

bool tlb_meta_add_u32_opt(tlb_meta_t *m, uint8_t tag, uint32_t v, bool write)
{
    if (!write) {
        return !m->failed;
    }
    return tlb_meta_add_u32(m, tag, v);
}

static size_t meta_parts(const tlb_meta_t *m, const uint8_t *msg, size_t msglen,
                         const uint8_t *parts[3], size_t lens[3])
{
    parts[0] = m->tlv;
    lens[0] = m->len;
    static const uint8_t end_tag = TLB_END_TAG;
    parts[1] = &end_tag;
    lens[1] = 1;
    parts[2] = (msg && msglen) ? msg : NULL;
    lens[2] = (msg && msglen) ? msglen : 0;
    return msglen ? 3 : 2;
}

bool tlb_meta_sha256(const tlb_meta_t *m, const uint8_t *msg, size_t msglen, uint8_t out[32])
{
    const uint8_t *parts[3];
    size_t lens[3];
    if (m->failed) {
        return false;
    }
    size_t n = meta_parts(m, msg, msglen, parts, lens);
    tlb_sha256_parts(parts, lens, n, out);
    return true;
}

bool tlb_meta_hmac(const tlb_meta_t *m, const uint8_t *key, size_t keylen, const uint8_t *msg,
                   size_t msglen, uint8_t out[32])
{
    const uint8_t *parts[3];
    size_t lens[3];
    if (m->failed || !key || !keylen) {
        return false;
    }
    size_t n = meta_parts(m, msg, msglen, parts, lens);
    tlb_hmac_sha256_parts(key, keylen, parts, lens, n, out);
    return true;
}

size_t tlb_meta_render(const tlb_meta_t *m, const uint8_t *msg, size_t msglen, uint8_t *out,
                       size_t cap)
{
    const size_t need = m->len + 1 + msglen;
    if (m->failed || need > cap) {
        return 0;
    }
    memcpy(out, m->tlv, m->len);
    out[m->len] = TLB_END_TAG;
    if (msglen) {
        memcpy(out + m->len + 1, msg, msglen);
    }
    return need;
}

size_t tlb_meta_upper_vin(const char *vin, uint8_t *out, size_t cap)
{
    size_t n = 0;
    if (!vin) {
        return 0;
    }
    while (vin[n] && n < cap) {
        char c = vin[n];
        if (c >= 'a' && c <= 'z') {
            c = (char)(c - 'a' + 'A');
        }
        out[n] = (uint8_t)c;
        n++;
    }
    return n;
}

bool tlb_meta_build_request(tlb_meta_t *m, const tlb_req_meta_t *p)
{
    uint8_t vin[TLB_VIN_MAX];

    tlb_meta_init(m);
    if (p->expires_at > TLB_MAX_EPOCH_SECONDS) {
        m->failed = true;
        return false;
    }
    size_t vlen = tlb_meta_upper_vin(p->vin, vin, sizeof(vin));
    if (!tlb_meta_add_byte(m, TLB_TAG_SIGNATURE_TYPE, p->signature_type)) {
        return false;
    }
    if (!tlb_meta_add_byte(m, TLB_TAG_DOMAIN, p->domain)) {
        return false;
    }
    if (!tlb_meta_add(m, TLB_TAG_PERSONALIZATION, vin, vlen)) {
        return false;
    }
    if (!tlb_meta_add_opt(m, TLB_TAG_EPOCH, p->epoch, p->epoch_len)) {
        return false;
    }
    if (!tlb_meta_add_u32(m, TLB_TAG_EXPIRES_AT, p->expires_at)) {
        return false;
    }
    if (!tlb_meta_add_u32(m, TLB_TAG_COUNTER, p->counter)) {
        return false;
    }
    return tlb_meta_add_u32_opt(m, TLB_TAG_FLAGS, p->flags, p->flags > 0);
}

bool tlb_meta_build_response(tlb_meta_t *m, const tlb_resp_meta_t *p)
{
    uint8_t vin[TLB_VIN_MAX];

    tlb_meta_init(m);
    size_t vlen = tlb_meta_upper_vin(p->vin, vin, sizeof(vin));
    if (!tlb_meta_add_byte(m, TLB_TAG_SIGNATURE_TYPE, TLB_SIG_AES_GCM_RESPONSE)) {
        return false;
    }
    if (!tlb_meta_add_byte(m, TLB_TAG_DOMAIN, p->domain)) {
        return false;
    }
    if (!tlb_meta_add(m, TLB_TAG_PERSONALIZATION, vin, vlen)) {
        return false;
    }
    if (!tlb_meta_add_u32(m, TLB_TAG_COUNTER, p->counter)) {
        return false;
    }
    if (!tlb_meta_add_u32(m, TLB_TAG_FLAGS, p->flags)) {
        return false;
    }
    if (!tlb_meta_add_opt(m, TLB_TAG_REQUEST_HASH, p->request_id, p->request_id_len)) {
        return false;
    }
    return tlb_meta_add_u32(m, TLB_TAG_FAULT, p->fault);
}
