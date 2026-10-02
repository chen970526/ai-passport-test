// components/tesla_core/src/tlb_identity.c
// 广播名规则与匹配：逐字对齐探针 identity.js:13-19 与 device-matcher.js:11-41。
#include <stdio.h>
#include <string.h>

#include "tesla_core/tlb_identity.h"
#include "tesla_core/tlb_sha.h"

// gatt.js:14 TESLA_SERVICE_SHORT
#define TLB_SERVICE_SHORT "0211"

// identity.js:14 的 trim() 只处理 ASCII 空白（0x09-0x0D、0x20）；
// JS 还会去掉 NBSP 等，C 里不追 —— VIN 不会出现这些字符。
static bool is_space(char c)
{
    return c == ' ' || (c >= 0x09 && c <= 0x0d);
}

static char up(char c)
{
    return (c >= 'a' && c <= 'z') ? (char)(c - 'a' + 'A') : c;
}

static bool kept(char c)
{
    return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z');
}

// normName 的完整语义：*total 是「不截断时应该有多少个保留字符」，返回值是实际写进 buf 的个数。
// 匹配必须看 total，否则一条超长广播名截断后会和短规则假等。
static size_t norm_full(const char *s, char *buf, size_t cap, size_t *total)
{
    size_t n = 0;
    size_t w = 0;
    for (; s && *s; s++) {
        char c = up(*s);
        if (!kept(c)) {
            continue;
        }
        n++;
        if (w + 1 < cap) {
            buf[w++] = c;
        }
    }
    buf[w] = '\0';
    if (total) {
        *total = n;
    }
    return w;
}

size_t tlb_norm_name(const char *s, char *out, size_t cap)
{
    if (cap == 0) {
        return 0;
    }
    return norm_full(s, out, cap, NULL);
}

// identity.js:16-17 的 v.length 是 UTF-16 码元数；C 按字节。VIN 是 ASCII，两种数法一致。
void tlb_ble_names_for_vin(const char *vin, tlb_ble_names_t *out)
{
    char v[64]; // 探针不限长；这里给 63 字节上限（VIN 实际 17，落盘校验 24，见 tlb_store.h）
    size_t lo = 0, hi = 0, n = 0;
    size_t i;

    if (!out) {
        return;
    }
    out->exact[0] = '\0';
    out->prefix[0] = '\0';
    if (!vin) {
        return;
    }
    for (hi = 0; vin[hi] != '\0'; hi++) {
    }
    while (lo < hi && is_space(vin[lo])) {
        lo++;
    }
    while (hi > lo && is_space(vin[hi - 1])) {
        hi--;
    }
    n = hi - lo;
    if (n > sizeof(v) - 1) {
        n = sizeof(v) - 1; // 超长截断：只可能是脏输入，不为此上动态内存
    }
    for (i = 0; i < n; i++) {
        v[i] = up(vin[lo + i]);
    }
    v[n] = '\0';

    // if (v.length >= 6) exact.push('Tesla ' + v.slice(-6))
    if (n >= 6) {
        snprintf(out->exact, sizeof(out->exact), "Tesla %.6s", v + n - 6);
    }
    // if (v.length) prefixes.push('S' + toHex(sha1(utf8(v))).slice(0, 16))
    if (n > 0) {
        uint8_t dg[20];
        char hex[41];
        size_t j;
        tlb_sha1((const uint8_t *)v, n, dg);
        for (j = 0; j < sizeof(dg); j++) {
            static const char digits[] = "0123456789abcdef"; // toHex 出小写
            hex[j * 2] = digits[dg[j] >> 4];
            hex[j * 2 + 1] = digits[dg[j] & 0xf];
        }
        hex[sizeof(dg) * 2] = '\0';
        snprintf(out->prefix, sizeof(out->prefix), "S%.16s", hex);
    }
}

// device-matcher.js:32-40 的四档顺序：原文 exact → 原文 prefix → 归一化 exact → 归一化 prefix。
tlb_match_mode_t tlb_match_adv_name(const tlb_ble_names_t *names, const char *adv_name,
                                    char *matched, size_t cap)
{
    char nn[TLB_ADV_NAME_MAX];
    size_t n_total = 0;
    const char *s = adv_name ? adv_name : "";

    if (!names) {
        return TLB_MATCH_NONE;
    }
    norm_full(s, nn, sizeof(nn), &n_total);

    if (names->exact[0] != '\0' && strcmp(s, names->exact) == 0) {
        if (matched) {
            snprintf(matched, cap, "%s", names->exact);
        }
        return TLB_MATCH_EXACT;
    }
    if (names->prefix[0] != '\0' && strncmp(s, names->prefix, strlen(names->prefix)) == 0) {
        if (matched) {
            snprintf(matched, cap, "%s", names->prefix);
        }
        return TLB_MATCH_PREFIX;
    }

    if (names->exact[0] != '\0') {
        char en[TLB_ADV_NAME_MAX];
        size_t e_total = norm_full(names->exact, en, sizeof(en), NULL);
        if (e_total == n_total && e_total < sizeof(en) && memcmp(nn, en, e_total) == 0) {
            // 探针 loose 两档回的是归一化后的规则（exactN/prefixN），日志要靠它认出档位
            if (matched) {
                snprintf(matched, cap, "%s", en);
            }
            return TLB_MATCH_LOOSE;
        }
    }
    if (names->prefix[0] != '\0') {
        char pn[TLB_ADV_NAME_MAX];
        size_t p_total = norm_full(names->prefix, pn, sizeof(pn), NULL);
        if (p_total > 0 && n_total >= p_total && p_total < sizeof(nn) &&
            memcmp(nn, pn, p_total) == 0) {
            if (matched) {
                snprintf(matched, cap, "%s", pn);
            }
            return TLB_MATCH_LOOSE_PREFIX;
        }
    }
    return TLB_MATCH_NONE;
}

bool tlb_uuid_is_tesla_service(const char *uuid)
{
    char nn[TLB_UUID_STR_MAX];
    size_t n_total;
    size_t p_total = norm_full(TLB_SERVICE_SHORT, nn, sizeof(nn), &n_total);
    char un[TLB_UUID_STR_MAX];
    size_t u_total;

    norm_full(uuid, un, sizeof(un), &u_total);
    if (u_total == n_total) {
        return memcmp(un, nn, n_total) == 0;
    }
    // JS: nn.indexOf('0211') === 0
    return u_total > n_total && p_total < sizeof(un) && memcmp(un, nn, p_total) == 0;
}

bool tlb_has_tesla_service(const char *const *uuids, size_t n)
{
    size_t i;
    for (i = 0; i < n; i++) {
        if (tlb_uuid_is_tesla_service(uuids[i])) {
            return true;
        }
    }
    return false;
}
