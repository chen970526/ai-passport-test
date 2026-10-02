// components/tesla_core/src/tlb_sha.c
// SHA-1 / SHA-256 / HMAC-SHA256（FIPS 180-4 / RFC 2104）的可移植实现。
// 主机与设备共用同一份代码，因此优先选择直白、可审计的写法；
// 常量表由 FIPS 180-4 定义（前若干个质数平方根/立方根小数的前 32 位）用精确整数
// 运算离线推出，再由主机测试的标准向量把关，不靠手抄。
#include "tesla_core/tlb_sha.h"

#include <string.h>

// ---------------------------------------------------------------- SHA-256

// K[i] = floor(2^32 * frac(cbrt(prime_i)))，前 64 个质数
static const uint32_t K256[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
    0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
    0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
    0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
    0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
    0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u};

static inline uint32_t ror32(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

static void sha256_block(tlb_sha256_ctx *c, const uint8_t *p) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++) {
        w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) |
               ((uint32_t)p[i * 4 + 2] << 8) | (uint32_t)p[i * 4 + 3];
    }
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = ror32(w[i - 15], 7) ^ ror32(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = ror32(w[i - 2], 17) ^ ror32(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = c->h[0], b = c->h[1], cc = c->h[2], d = c->h[3];
    uint32_t e = c->h[4], f = c->h[5], g = c->h[6], hh = c->h[7];
    for (int i = 0; i < 64; i++) {
        uint32_t S1 = ror32(e, 6) ^ ror32(e, 11) ^ ror32(e, 25);
        uint32_t ch = (e & f) ^ ((~e) & g);
        uint32_t t1 = hh + S1 + ch + K256[i] + w[i];
        uint32_t S0 = ror32(a, 2) ^ ror32(a, 13) ^ ror32(a, 22);
        uint32_t mj = (a & b) ^ (a & cc) ^ (b & cc);
        uint32_t t2 = S0 + mj;
        hh = g;
        g = f;
        f = e;
        e = d + t1;
        d = cc;
        cc = b;
        b = a;
        a = t1 + t2;
    }
    c->h[0] += a; c->h[1] += b; c->h[2] += cc; c->h[3] += d;
    c->h[4] += e; c->h[5] += f; c->h[6] += g; c->h[7] += hh;
}

void tlb_sha256_init(tlb_sha256_ctx *c) {
    // H[i] = floor(2^32 * frac(sqrt(prime_i)))，前 8 个质数
    static const uint32_t H0[8] = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                                   0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};
    memcpy(c->h, H0, sizeof(H0));
    c->total = 0;
    c->buflen = 0;
}

void tlb_sha256_update(tlb_sha256_ctx *c, const uint8_t *msg, size_t len) {
    c->total += len;
    while (len > 0) {
        size_t take = 64 - c->buflen;
        if (take > len) take = len;
        memcpy(c->buf + c->buflen, msg, take);
        c->buflen += take;
        msg += take;
        len -= take;
        if (c->buflen == 64) {
            sha256_block(c, c->buf);
            c->buflen = 0;
        }
    }
}

void tlb_sha256_final(tlb_sha256_ctx *c, uint8_t out[32]) {
    uint64_t bits = c->total * 8u;
    uint8_t pad[72];
    size_t n = 1;
    pad[0] = 0x80;
    while ((c->buflen + n) % 64 != 56) pad[n++] = 0;
    for (int i = 0; i < 8; i++) pad[n++] = (uint8_t)(bits >> (56 - i * 8));
    tlb_sha256_update(c, pad, n);
    for (int i = 0; i < 8; i++) {
        out[i * 4] = (uint8_t)(c->h[i] >> 24);
        out[i * 4 + 1] = (uint8_t)(c->h[i] >> 16);
        out[i * 4 + 2] = (uint8_t)(c->h[i] >> 8);
        out[i * 4 + 3] = (uint8_t)c->h[i];
    }
}

void tlb_sha256(const uint8_t *msg, size_t len, uint8_t out[32]) {
    tlb_sha256_ctx c;
    tlb_sha256_init(&c);
    tlb_sha256_update(&c, msg, len);
    tlb_sha256_final(&c, out);
}

void tlb_sha256_parts(const uint8_t *const *parts, const size_t *lens, size_t nparts,
                      uint8_t out[32]) {
    tlb_sha256_ctx c;
    tlb_sha256_init(&c);
    for (size_t i = 0; i < nparts; i++) tlb_sha256_update(&c, parts[i], lens[i]);
    tlb_sha256_final(&c, out);
}

// ---------------------------------------------------------------- SHA-1

typedef struct {
    uint32_t h[5];
    uint64_t total;
    uint8_t buf[64];
    size_t buflen;
} sha1_ctx;

static void sha1_block(sha1_ctx *c, const uint8_t *p) {
    uint32_t w[80];
    for (int i = 0; i < 16; i++) {
        w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) |
               ((uint32_t)p[i * 4 + 2] << 8) | (uint32_t)p[i * 4 + 3];
    }
    for (int i = 16; i < 80; i++) {
        uint32_t v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
        w[i] = (v << 1) | (v >> 31);
    }
    uint32_t a = c->h[0], b = c->h[1], cc = c->h[2], d = c->h[3], e = c->h[4];
    for (int i = 0; i < 80; i++) {
        uint32_t f, k;
        if (i < 20) {
            f = (b & cc) | ((~b) & d);
            k = 0x5A827999u;
        } else if (i < 40) {
            f = b ^ cc ^ d;
            k = 0x6ED9EBA1u;
        } else if (i < 60) {
            f = (b & cc) | (b & d) | (cc & d);
            k = 0x8F1BBCDCu;
        } else {
            f = b ^ cc ^ d;
            k = 0xCA62C1D6u;
        }
        uint32_t t = ((a << 5) | (a >> 27)) + f + e + k + w[i];
        e = d;
        d = cc;
        cc = (b << 30) | (b >> 2);
        b = a;
        a = t;
    }
    c->h[0] += a; c->h[1] += b; c->h[2] += cc; c->h[3] += d; c->h[4] += e;
}

static void sha1_update(sha1_ctx *c, const uint8_t *msg, size_t len) {
    c->total += len;
    while (len > 0) {
        size_t take = 64 - c->buflen;
        if (take > len) take = len;
        memcpy(c->buf + c->buflen, msg, take);
        c->buflen += take;
        msg += take;
        len -= take;
        if (c->buflen == 64) {
            sha1_block(c, c->buf);
            c->buflen = 0;
        }
    }
}

static void sha1_final(sha1_ctx *c, uint8_t out[20]) {
    uint64_t bits = c->total * 8u;
    uint8_t pad[72];
    size_t n = 1;
    pad[0] = 0x80;
    while ((c->buflen + n) % 64 != 56) pad[n++] = 0;
    for (int i = 0; i < 8; i++) pad[n++] = (uint8_t)(bits >> (56 - i * 8));
    sha1_update(c, pad, n);
    for (int i = 0; i < 5; i++) {
        out[i * 4] = (uint8_t)(c->h[i] >> 24);
        out[i * 4 + 1] = (uint8_t)(c->h[i] >> 16);
        out[i * 4 + 2] = (uint8_t)(c->h[i] >> 8);
        out[i * 4 + 3] = (uint8_t)c->h[i];
    }
}

void tlb_sha1(const uint8_t *msg, size_t len, uint8_t out[20]) {
    sha1_ctx c;
    static const uint32_t H0[5] = {0x67452301u, 0xEFCDAB89u, 0x98BADCFEu, 0x10325476u,
                                   0xC3D2E1F0u};
    memcpy(c.h, H0, sizeof(H0));
    c.total = 0;
    c.buflen = 0;
    sha1_update(&c, msg, len);
    sha1_final(&c, out);
}

// ---------------------------------------------------------------- HMAC-SHA256

static void hmac_prep(const uint8_t *key, size_t klen, uint8_t ipad[64], uint8_t opad[64]) {
    uint8_t kb[32];
    if (klen > 64) {
        tlb_sha256(key, klen, kb);
        key = kb;
        klen = sizeof(kb);
    }
    for (int i = 0; i < 64; i++) {
        uint8_t b = i < (int)klen ? key[i] : 0;
        ipad[i] = b ^ 0x36;
        opad[i] = b ^ 0x5c;
    }
}

void tlb_hmac_sha256_parts(const uint8_t *key, size_t klen, const uint8_t *const *parts,
                           const size_t *lens, size_t nparts, uint8_t out[32]) {
    uint8_t ipad[64], opad[64], inner[32];
    hmac_prep(key, klen, ipad, opad);

    tlb_sha256_ctx c;
    tlb_sha256_init(&c);
    tlb_sha256_update(&c, ipad, 64);
    for (size_t i = 0; i < nparts; i++) tlb_sha256_update(&c, parts[i], lens[i]);
    tlb_sha256_final(&c, inner);

    tlb_sha256_init(&c);
    tlb_sha256_update(&c, opad, 64);
    tlb_sha256_update(&c, inner, 32);
    tlb_sha256_final(&c, out);
}

void tlb_hmac_sha256(const uint8_t *key, size_t klen, const uint8_t *msg, size_t mlen,
                     uint8_t out[32]) {
    const uint8_t *parts[1] = {msg};
    size_t lens[1] = {mlen};
    tlb_hmac_sha256_parts(key, klen, parts, lens, msg ? 1u : 0u, out);
}
