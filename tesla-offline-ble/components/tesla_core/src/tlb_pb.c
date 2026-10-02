// components/tesla_core/src/tlb_pb.c
#include "tesla_core/tlb_pb.h"

#include <string.h>

#define TLB_VARINT_MAX_BYTES 10

// ---------------------------------------------------------------- 写入侧

void tlb_wb_init(tlb_wb_t *w, uint8_t *buf, size_t cap)
{
    w->buf = buf;
    w->cap = cap;
    w->len = 0;
    w->failed = false;
}

size_t tlb_wb_len(const tlb_wb_t *w)
{
    return w->failed ? 0 : w->len;
}

bool tlb_wb_raw(tlb_wb_t *w, const uint8_t *data, size_t len)
{
    if (w->failed) {
        return false;
    }
    if (len > w->cap - w->len) {
        w->failed = true;
        return false;
    }
    if (len) {
        memcpy(w->buf + w->len, data, len);
        w->len += len;
    }
    return true;
}

bool tlb_wb_varint(tlb_wb_t *w, uint64_t v)
{
    uint8_t tmp[TLB_VARINT_MAX_BYTES];
    size_t n = 0;
    do {
        uint8_t b = (uint8_t)(v & 0x7f);
        v >>= 7;
        if (v) {
            b |= 0x80;
        }
        tmp[n++] = b;
    } while (v);
    return tlb_wb_raw(w, tmp, n);
}

bool tlb_wb_tag(tlb_wb_t *w, uint32_t field, uint32_t wire)
{
    // tag = field*8 + wire；字段号上限 536870911，不会溢出 uint32
    return tlb_wb_varint(w, (uint64_t)((uint64_t)field * 8u + (uint64_t)wire));
}

bool tlb_wb_u32(tlb_wb_t *w, uint32_t field, uint32_t v, bool force)
{
    if (v == 0 && !force) {
        return !w->failed;
    }
    return tlb_wb_tag(w, field, TLB_WIRE_VARINT) && tlb_wb_varint(w, v);
}

bool tlb_wb_bool(tlb_wb_t *w, uint32_t field, bool v, bool force)
{
    if (!v && !force) {
        return !w->failed;
    }
    return tlb_wb_tag(w, field, TLB_WIRE_VARINT) && tlb_wb_varint(w, v ? 1 : 0);
}

bool tlb_wb_fixed32(tlb_wb_t *w, uint32_t field, uint32_t v, bool force)
{
    if (v == 0 && !force) {
        return !w->failed;
    }
    uint8_t le[4] = { (uint8_t)(v & 0xff), (uint8_t)((v >> 8) & 0xff),
                     (uint8_t)((v >> 16) & 0xff), (uint8_t)((v >> 24) & 0xff) };
    return tlb_wb_tag(w, field, TLB_WIRE_FIXED32) && tlb_wb_raw(w, le, 4);
}

bool tlb_wb_bytes(tlb_wb_t *w, uint32_t field, const uint8_t *data, size_t len, bool force)
{
    if (!len && !force) {
        return !w->failed;
    }
    if (!tlb_wb_tag(w, field, TLB_WIRE_LEN)) {
        return false;
    }
    if (!tlb_wb_varint(w, len)) {
        return false;
    }
    if (!len) {
        return true;
    }
    return tlb_wb_raw(w, data, len);
}

// pb.js 的 case 'msg'：只要这个 key 出现在对象里就无条件写 tag+len，
// 空子消息也是 `tag + 长度0`（proto3 里「消息存在」本身就有意义）。
// 需要「按条件省略」的调用方，自己判断后再决定要不要调用本函数。
bool tlb_wb_sub(tlb_wb_t *w, uint32_t field, const tlb_wb_t *sub)
{
    if (!sub) {
        return tlb_wb_bytes(w, field, NULL, 0, true);
    }
    if (sub->failed) {
        w->failed = true;
        return false;
    }
    return tlb_wb_bytes(w, field, sub->buf, sub->len, true);
}

// ---------------------------------------------------------------- 读取侧

void tlb_rb_init(tlb_rb_t *r, const uint8_t *data, size_t len)
{
    r->p = data;
    r->end = data + len;
    r->failed = false;
}

bool tlb_rb_eof(const tlb_rb_t *r)
{
    return r->failed || r->p >= r->end;
}

uint64_t tlb_rb_remaining(const tlb_rb_t *r)
{
    return (uint64_t)(r->end - r->p);
}

static bool rb_take(tlb_rb_t *r, size_t n, const uint8_t **out)
{
    if (r->failed) {
        return false;
    }
    if ((uint64_t)(r->end - r->p) < (uint64_t)n) {
        r->failed = true;
        return false;
    }
    if (out) {
        *out = r->p;
    }
    r->p += n;
    return true;
}

bool tlb_rb_varint(tlb_rb_t *r, uint64_t *out)
{
    uint64_t v = 0;
    for (int i = 0; i < TLB_VARINT_MAX_BYTES; i++) {
        const uint8_t *b;
        if (!rb_take(r, 1, &b)) {
            return false;
        }
        v |= (uint64_t)(*b & 0x7f) << (7 * i);
        if (!(*b & 0x80)) {
            *out = v;
            return true;
        }
    }
    r->failed = true; // 超长 varint
    return false;
}

bool tlb_rb_next(tlb_rb_t *r, uint32_t *field, uint32_t *wire)
{
    uint64_t key;
    // 干净地读到结尾：返回 false 但不算格式错误（子消息解析循环靠这条退出）
    if (r->failed || r->p >= r->end) {
        return false;
    }
    if (!tlb_rb_varint(r, &key)) {
        return false;
    }
    *wire = (uint32_t)(key & 7u);
    *field = (uint32_t)(key >> 3);
    if (*field == 0) {
        r->failed = true;
        return false;
    }
    return true;
}

bool tlb_rb_u32(tlb_rb_t *r, uint32_t *out)
{
    uint64_t v;
    if (!tlb_rb_varint(r, &v)) {
        return false;
    }
    *out = (uint32_t)(v & 0xffffffffu);
    return true;
}

bool tlb_rb_bool(tlb_rb_t *r, bool *out)
{
    uint32_t v;
    if (!tlb_rb_u32(r, &v)) {
        return false;
    }
    *out = v != 0;
    return true;
}

bool tlb_rb_fixed32(tlb_rb_t *r, uint32_t *out)
{
    const uint8_t *p;
    if (!rb_take(r, 4, &p)) {
        return false;
    }
    *out = (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
    return true;
}

bool tlb_rb_bytes(tlb_rb_t *r, const uint8_t **ptr, size_t *len)
{
    uint64_t n;
    if (!tlb_rb_varint(r, &n)) {
        return false;
    }
    if (n > (uint64_t)(r->end - r->p)) {
        r->failed = true;
        return false;
    }
    *ptr = r->p;
    *len = (size_t)n;
    r->p += n;
    return true;
}

bool tlb_rb_sub(tlb_rb_t *r, tlb_rb_t *sub)
{
    const uint8_t *p;
    size_t n;
    if (!tlb_rb_bytes(r, &p, &n)) {
        return false;
    }
    tlb_rb_init(sub, p, n);
    return true;
}

bool tlb_rb_skip(tlb_rb_t *r, uint32_t wire)
{
    switch (wire) {
    case TLB_WIRE_VARINT: {
        uint64_t v;
        return tlb_rb_varint(r, &v);
    }
    case TLB_WIRE_FIXED64:
        return rb_take(r, 8, NULL);
    case TLB_WIRE_LEN: {
        const uint8_t *p;
        size_t n;
        return tlb_rb_bytes(r, &p, &n);
    }
    case TLB_WIRE_FIXED32:
        return rb_take(r, 4, NULL);
    default:
        r->failed = true;
        return false;
    }
}
