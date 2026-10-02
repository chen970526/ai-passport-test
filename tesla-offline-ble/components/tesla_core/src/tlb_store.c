// components/tesla_core/src/tlb_store.c
// 密钥与会话的持久化抽象。字段集合与恢复语义照抄探针
// src/store/{credential-store,v3-session-store}.js；blob 布局是本模块自己的契约，
// 因此带版本号 + 槽位 + 长度 + 校验和四道判据，decode 不过就整块作废。
#include <string.h>

#include "tesla_core/tlb_store.h"

// 头部：版本 1 字节 ‖ 槽位 1 字节；尾部：FNV-1a 32 位 4 字节（大端）。
#define HDR_LEN 2u
#define CRC_LEN 4u
#define KEY_PAYLOAD_LEN (TLB_PRIV_LEN + TLB_PUB_LEN + 1u + TLB_VIN_MAX)
#define SES_PAYLOAD_LEN (4u + 1u + TLB_EPOCH_LEN + 1u + TLB_PUB_LEN + 4u + 1u + 4u + 1u + 8u + 1u)
#define KEY_BLOB_LEN (HDR_LEN + KEY_PAYLOAD_LEN + CRC_LEN)
#define SES_BLOB_LEN (HDR_LEN + SES_PAYLOAD_LEN + CRC_LEN)

static uint32_t fnv1a(const uint8_t *p, size_t len)
{
    uint32_t h = 2166136261u;
    size_t i;
    for (i = 0; i < len; i++) {
        h ^= p[i];
        h *= 16777619u;
    }
    return h;
}

static size_t put_u32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v >> 24);
    p[1] = (uint8_t)(v >> 16);
    p[2] = (uint8_t)(v >> 8);
    p[3] = (uint8_t)v;
    return 4u;
}

static uint32_t get_u32(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}

static size_t put_u64(uint8_t *p, uint64_t v)
{
    put_u32(p, (uint32_t)(v >> 32));
    put_u32(p + 4, (uint32_t)v);
    return 8u;
}

static uint64_t get_u64(const uint8_t *p)
{
    return ((uint64_t)get_u32(p) << 32) | get_u32(p + 4);
}

// 封尾：写头、算校验。调用方保证 payload 已经摆在 blob + HDR_LEN 处。
static size_t seal(uint8_t *blob, size_t cap, uint32_t slot, size_t payload_len)
{
    size_t total = HDR_LEN + payload_len + CRC_LEN;
    uint32_t h;

    if (cap < total) {
        return 0;
    }
    blob[0] = (uint8_t)TLB_STORE_VERSION;
    blob[1] = (uint8_t)slot;
    h = fnv1a(blob, HDR_LEN + payload_len);
    put_u32(blob + HDR_LEN + payload_len, h);
    return total;
}

// 揭尾：四道判据全过才返回 true；*payload/*plen 只在成功时有意义。
static bool unseal(uint32_t slot, const uint8_t *blob, size_t len, size_t payload_len,
                   const uint8_t **payload)
{
    size_t total = HDR_LEN + payload_len + CRC_LEN;

    if (!blob || len != total) {
        return false; // 长度必须分毫不差：多一字节也当损坏，不做「尽力解析」
    }
    if (blob[0] != (uint8_t)TLB_STORE_VERSION || blob[1] != (uint8_t)slot) {
        return false;
    }
    if (get_u32(blob + HDR_LEN + payload_len) != fnv1a(blob, HDR_LEN + payload_len)) {
        return false;
    }
    *payload = blob + HDR_LEN;
    return true;
}

static bool session_slot_ok(uint32_t domain)
{
    return domain == TLB_DOMAIN_VCSEC || domain == TLB_DOMAIN_INFOTAINMENT;
}

// 布尔位只认 0/1；其它值意味着偏移错位，整块判损坏，绝不做「非零即真」的尽力解析。
static bool get_flag(uint8_t byte, bool *out)
{
    if (byte > 1u) {
        return false;
    }
    *out = (byte != 0u);
    return true;
}

size_t tlb_store_encode_key(const tlb_store_key_t *k, uint8_t *blob, size_t cap)
{
    size_t vin_len;
    uint8_t *p;

    if (!k || !blob) {
        return 0;
    }
    // 只在 24 字节里找结尾（不用 strlen：调用方塞满 24 字节时它会读越界）。
    // 找不到结尾 = VIN 超长，宁可拒写，也不能截断成另一台车。
    for (vin_len = 0; vin_len < TLB_VIN_MAX && k->vin[vin_len] != '\0'; vin_len++) {
    }
    if (vin_len >= TLB_VIN_MAX) {
        return 0;
    }
    p = blob + HDR_LEN;
    memcpy(p, k->priv, TLB_PRIV_LEN);
    p += TLB_PRIV_LEN;
    memcpy(p, k->pub, TLB_PUB_LEN);
    p += TLB_PUB_LEN;
    *p++ = k->has_pub ? 1u : 0u;
    memset(p, 0, TLB_VIN_MAX);
    memcpy(p, k->vin, vin_len);
    return seal(blob, cap, TLB_STORE_SLOT_KEY, KEY_PAYLOAD_LEN);
}

bool tlb_store_decode_key(tlb_store_key_t *k, const uint8_t *blob, size_t len)
{
    const uint8_t *p;
    tlb_store_key_t tmp;
    size_t i;

    if (!k || !unseal(TLB_STORE_SLOT_KEY, blob, len, KEY_PAYLOAD_LEN, &p)) {
        return false;
    }
    memset(&tmp, 0, sizeof(tmp));
    memcpy(tmp.priv, p, TLB_PRIV_LEN);
    p += TLB_PRIV_LEN;
    memcpy(tmp.pub, p, TLB_PUB_LEN);
    p += TLB_PUB_LEN;
    if (!get_flag(*p++, &tmp.has_pub)) {
        return false;
    }
    for (i = 0; i < TLB_VIN_MAX; i++) {
        if (p[i] == 0u) {
            break; // 找到结尾即可，后面必须整段补零
        }
        tmp.vin[i] = (char)p[i];
    }
    if (i >= TLB_VIN_MAX) {
        return false; // 24 字节里没有结尾 = 布局被改写
    }
    for (i++; i < TLB_VIN_MAX; i++) {
        if (p[i] != 0u) {
            return false;
        }
    }
    *k = tmp;
    return true;
}

size_t tlb_store_encode_session(uint32_t domain, const tlb_store_session_t *r, uint8_t *blob,
                                size_t cap)
{
    uint8_t *p;

    if (!r || !blob || !session_slot_ok(domain)) {
        return 0;
    }
    p = blob + HDR_LEN;
    p += put_u32(p, r->counter);
    *p++ = r->has_epoch ? 1u : 0u;
    memcpy(p, r->epoch, TLB_EPOCH_LEN);
    p += TLB_EPOCH_LEN;
    *p++ = r->has_pub ? 1u : 0u;
    memcpy(p, r->vehicle_pub, TLB_PUB_LEN);
    p += TLB_PUB_LEN;
    p += put_u32(p, r->clock_time);
    *p++ = r->has_set_time ? 1u : 0u;
    p += put_u32(p, r->set_time);
    *p++ = r->has_anchor ? 1u : 0u;
    p += put_u64(p, (uint64_t)r->anchor);
    *p++ = r->ready ? 1u : 0u;
    return seal(blob, cap, domain, SES_PAYLOAD_LEN);
}

bool tlb_store_decode_session(uint32_t domain, tlb_store_session_t *r, const uint8_t *blob,
                              size_t len)
{
    const uint8_t *p;
    tlb_store_session_t tmp;

    if (!r || !session_slot_ok(domain) ||
        !unseal(domain, blob, len, SES_PAYLOAD_LEN, &p)) {
        return false;
    }
    memset(&tmp, 0, sizeof(tmp));
    tmp.counter = get_u32(p);
    p += 4u;
    if (!get_flag(*p++, &tmp.has_epoch)) {
        return false;
    }
    memcpy(tmp.epoch, p, TLB_EPOCH_LEN);
    p += TLB_EPOCH_LEN;
    if (!get_flag(*p++, &tmp.has_pub)) {
        return false;
    }
    memcpy(tmp.vehicle_pub, p, TLB_PUB_LEN);
    p += TLB_PUB_LEN;
    tmp.clock_time = get_u32(p);
    p += 4u;
    if (!get_flag(*p++, &tmp.has_set_time)) {
        return false;
    }
    tmp.set_time = get_u32(p);
    p += 4u;
    if (!get_flag(*p++, &tmp.has_anchor)) {
        return false;
    }
    tmp.anchor = (int64_t)get_u64(p);
    p += 8u;
    if (!get_flag(*p, &tmp.ready)) {
        return false;
    }
    // 布尔位只认 0/1：出现其它值说明偏移已经错位，整块作废，绝不部分写入
    *r = tmp;
    return true;
}

void tlb_store_from_v3(tlb_store_session_t *r, const tlb_v3_session_t *s)
{
    if (!r || !s) {
        return;
    }
    memset(r, 0, sizeof(*r));
    r->counter = s->counter;
    if (s->epoch_len > 0) {
        memcpy(r->epoch, s->epoch, s->epoch_len <= TLB_EPOCH_LEN ? s->epoch_len : TLB_EPOCH_LEN);
        r->has_epoch = true;
    }
    if (s->vehicle_pub_len > 0) {
        memcpy(r->vehicle_pub, s->vehicle_pub,
               s->vehicle_pub_len <= TLB_PUB_LEN ? s->vehicle_pub_len : TLB_PUB_LEN);
        r->has_pub = true;
    }
    r->clock_time = s->clock_time;
    r->has_set_time = s->has_set_time;
    r->set_time = s->set_time;
    r->has_anchor = s->has_anchor;
    r->anchor = s->anchor;
    r->ready = s->ready;
}

void tlb_store_to_v3(const tlb_store_session_t *r, tlb_v3_session_t *s)
{
    if (!r || !s) {
        return;
    }
    // 等价 v3Session() 的读盘分支：从 freshV3Session（全零）出发，共享密钥永远不带回来。
    tlb_v3_session_reset(s);
    s->counter = r->counter;
    if (r->has_epoch) {
        memcpy(s->epoch, r->epoch, TLB_EPOCH_LEN);
        s->epoch_len = TLB_EPOCH_LEN;
    }
    if (r->has_pub) {
        memcpy(s->vehicle_pub, r->vehicle_pub, TLB_PUB_LEN);
        s->vehicle_pub_len = TLB_PUB_LEN;
    }
    s->clock_time = r->clock_time;
    s->has_set_time = r->has_set_time;
    s->set_time = r->set_time;
    s->has_anchor = r->has_anchor;
    s->anchor = r->anchor;
    s->ready = r->ready && r->has_epoch; // v3-session-store.js:86
}

static tlb_store_status_t load_blob(const tlb_store_backend_t *b, uint32_t slot, uint8_t *blob,
                                    size_t cap, size_t *len)
{
    int n;

    if (!b || !b->read) {
        return TLB_STORE_ERROR;
    }
    n = b->read(b->ud, slot, blob, cap);
    if (n == 0) {
        return TLB_STORE_NONE;
    }
    if (n < 0 || (size_t)n > cap) {
        return TLB_STORE_ERROR;
    }
    *len = (size_t)n;
    return TLB_STORE_OK;
}

tlb_store_status_t tlb_store_load_key(const tlb_store_backend_t *b, tlb_store_key_t *k)
{
    uint8_t blob[TLB_STORE_BLOB_MAX];
    size_t len = 0;
    tlb_store_status_t st = load_blob(b, TLB_STORE_SLOT_KEY, blob, sizeof(blob), &len);

    if (st != TLB_STORE_OK) {
        return st;
    }
    return tlb_store_decode_key(k, blob, len) ? TLB_STORE_OK : TLB_STORE_CORRUPT;
}

tlb_store_status_t tlb_store_save_key(const tlb_store_backend_t *b, const tlb_store_key_t *k)
{
    uint8_t blob[TLB_STORE_BLOB_MAX];
    size_t len;

    if (!b || !b->write) {
        return TLB_STORE_ERROR;
    }
    len = tlb_store_encode_key(k, blob, sizeof(blob));
    if (len == 0) {
        return TLB_STORE_INVALID; // 记录本身不可持久化，没写盘
    }
    return b->write(b->ud, TLB_STORE_SLOT_KEY, blob, len) == 0 ? TLB_STORE_OK : TLB_STORE_ERROR;
}

tlb_store_status_t tlb_store_load_session(const tlb_store_backend_t *b, uint32_t domain,
                                          tlb_store_session_t *r)
{
    uint8_t blob[TLB_STORE_BLOB_MAX];
    size_t len = 0;
    tlb_store_status_t st;

    if (!session_slot_ok(domain)) {
        return TLB_STORE_BAD_SLOT;
    }
    st = load_blob(b, domain, blob, sizeof(blob), &len);
    if (st != TLB_STORE_OK) {
        return st;
    }
    return tlb_store_decode_session(domain, r, blob, len) ? TLB_STORE_OK : TLB_STORE_CORRUPT;
}

tlb_store_status_t tlb_store_save_session(const tlb_store_backend_t *b, uint32_t domain,
                                          const tlb_store_session_t *r)
{
    uint8_t blob[TLB_STORE_BLOB_MAX];
    size_t len;

    if (!b || !b->write) {
        return TLB_STORE_ERROR;
    }
    if (!session_slot_ok(domain)) {
        return TLB_STORE_BAD_SLOT;
    }
    len = tlb_store_encode_session(domain, r, blob, sizeof(blob));
    if (len == 0) {
        return TLB_STORE_INVALID;
    }
    return b->write(b->ud, domain, blob, len) == 0 ? TLB_STORE_OK : TLB_STORE_ERROR;
}

tlb_store_status_t tlb_store_clear(const tlb_store_backend_t *b, uint32_t slot)
{
    if (!b || !b->erase) {
        return TLB_STORE_ERROR;
    }
    if (slot != TLB_STORE_SLOT_KEY && !session_slot_ok(slot)) {
        return TLB_STORE_BAD_SLOT;
    }
    return b->erase(b->ud, slot) == 0 ? TLB_STORE_OK : TLB_STORE_ERROR;
}
