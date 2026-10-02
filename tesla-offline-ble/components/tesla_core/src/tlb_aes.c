// components/tesla_core/src/tlb_aes.c
// AES-128 + AES-128-GCM 的可移植实现。
//
// S 盒在首次使用时按 FIPS-197 定义算出（GF(2^8) 求逆 + 仿射变换），
// 不手抄 256 字节常量表；正确性由主机测试的标准向量与探针金标准逐字节把关。
#include "tesla_core/tlb_aes.h"

#include <string.h>

#define POLY 0x1b

static uint8_t SBOX[256];

static inline uint8_t ror8(uint8_t v, int k) { return (uint8_t)((v >> k) | (v << (8 - k))); }

static void build_sbox(void) {
    if (SBOX[1] != 0) return; // 已初始化：标准 S 盒里 SBOX[1] == 0x7c
    uint8_t exp_t[256], log_t[256], inv[256];
    uint8_t x = 1;
    for (int i = 0; i < 255; i++) {
        exp_t[i] = x;
        log_t[x] = (uint8_t)i;
        // x *= 3（0x03 是 GF(256)* 的本原元）：x ^ xtime(x)
        x = (uint8_t)(x ^ (uint8_t)(((x << 1) & 0xff) ^ ((x & 0x80) ? POLY : 0)));
    }
    for (int a = 1; a < 256; a++) inv[a] = exp_t[(255 - log_t[a]) % 255];
    inv[0] = 0;
    for (int a = 0; a < 256; a++) {
        uint8_t y = inv[a];
        // FIPS-197 4.2.1：b_i = a_i ^ a_{i+4} ^ a_{i+5} ^ a_{i+6} ^ a_{i+7} ^ 0x63
        SBOX[a] = (uint8_t)(y ^ ror8(y, 4) ^ ror8(y, 5) ^ ror8(y, 6) ^ ror8(y, 7) ^ 0x63);
    }
}

static uint8_t gmul2(uint8_t v) {
    uint8_t shifted = (uint8_t)(v << 1);
    return (uint8_t)(((v & 0x80) ? (shifted ^ POLY) : shifted));
}

void tlb_aes128_expand(const uint8_t key[16], uint8_t rk[TLB_AES_ROUNDS * TLB_AES_BLOCK]) {
    build_sbox();
    uint32_t w[44];
    for (int i = 0; i < 4; i++) {
        w[i] = ((uint32_t)key[4 * i] << 24) | ((uint32_t)key[4 * i + 1] << 16) |
               ((uint32_t)key[4 * i + 2] << 8) | (uint32_t)key[4 * i + 3];
    }
    uint8_t rcon = 1;
    for (int i = 4; i < 44; i++) {
        uint32_t t = w[i - 1];
        if (i % 4 == 0) {
            t = (t << 8) | (t >> 24); // RotWord
            t = ((uint32_t)SBOX[(t >> 24) & 0xff] << 24) | ((uint32_t)SBOX[(t >> 16) & 0xff] << 16) |
                ((uint32_t)SBOX[(t >> 8) & 0xff] << 8) | (uint32_t)SBOX[t & 0xff]; // SubWord
            t ^= (uint32_t)rcon << 24;
            rcon = gmul2(rcon);
        }
        w[i] = w[i - 4] ^ t;
    }
    for (int i = 0; i < 44; i++) {
        rk[4 * i] = (uint8_t)(w[i] >> 24);
        rk[4 * i + 1] = (uint8_t)(w[i] >> 16);
        rk[4 * i + 2] = (uint8_t)(w[i] >> 8);
        rk[4 * i + 3] = (uint8_t)w[i];
    }
}

void tlb_aes128_encrypt_block_rk(const uint8_t rk[TLB_AES_ROUNDS * TLB_AES_BLOCK],
                                 const uint8_t in[16], uint8_t out[16]) {
    uint8_t s[16], t[16];
    for (int i = 0; i < 16; i++) s[i] = (uint8_t)(in[i] ^ rk[i]);
    for (int round = 1; round <= 10; round++) {
        // SubBytes + ShiftRows（状态按列存放：元素 (r, c) 在 4*c + r）
        for (int c = 0; c < 4; c++) {
            for (int r = 0; r < 4; r++) t[4 * c + r] = SBOX[s[4 * ((r + c) % 4) + r]];
        }
        memcpy(s, t, 16);
        if (round != 10) {
            for (int c = 0; c < 4; c++) {
                int o = 4 * c;
                uint8_t a0 = s[o], a1 = s[o + 1], a2 = s[o + 2], a3 = s[o + 3];
                s[o] = (uint8_t)(gmul2(a0) ^ (uint8_t)(gmul2(a1) ^ a1) ^ a2 ^ a3);
                s[o + 1] = (uint8_t)(a0 ^ (uint8_t)(gmul2(a2) ^ a2) ^ gmul2(a1) ^ a3);
                s[o + 2] = (uint8_t)(a0 ^ a1 ^ (uint8_t)(gmul2(a3) ^ a3) ^ gmul2(a2));
                s[o + 3] = (uint8_t)((uint8_t)(gmul2(a0) ^ a0) ^ a1 ^ a2 ^ gmul2(a3));
            }
        }
        for (int i = 0; i < 16; i++) s[i] = (uint8_t)(s[i] ^ rk[16 * round + i]);
    }
    memcpy(out, s, 16);
}

void tlb_aes128_encrypt_block(const uint8_t key[16], const uint8_t in[16], uint8_t out[16]) {
    uint8_t rk[TLB_AES_ROUNDS * TLB_AES_BLOCK];
    tlb_aes128_expand(key, rk);
    tlb_aes128_encrypt_block_rk(rk, in, out);
}

// ------------------------------------------------------ GF(2^128) / GHASH

// GCM 定义：byte0 的 MSB 是最高次项（bit 0），多项式约减常量 R = 0xe1 ‖ 0^120
static void gf128_mul(uint8_t acc[16], const uint8_t H[16]) {
    uint8_t z[16], v[16];
    memset(z, 0, 16);
    memcpy(v, H, 16); // V 是被反复右移的那一侧，X = acc 保持不动
    for (int i = 0; i < 128; i++) {
        if ((acc[i >> 3] >> (7 - (i & 7))) & 1) {
            for (int j = 0; j < 16; j++) z[j] = (uint8_t)(z[j] ^ v[j]);
        }
        uint8_t lsb = (uint8_t)(v[15] & 1);
        for (int j = 15; j > 0; j--)
            v[j] = (uint8_t)((v[j] >> 1) | (uint8_t)((v[j - 1] & 1) << 7));
        v[0] = (uint8_t)(v[0] >> 1);
        if (lsb) v[0] = (uint8_t)(v[0] ^ 0xe1);
    }
    memcpy(acc, z, 16);
}

// 把 data 按 16 字节补零分块累加进 acc
static void ghash_update(uint8_t acc[16], const uint8_t H[16], const uint8_t *data, size_t len) {
    for (size_t off = 0; off < len; off += 16) {
        uint8_t blk[16];
        size_t n = len - off < 16 ? len - off : 16;
        memset(blk, 0, 16);
        if (data) memcpy(blk, data + off, n);
        for (int j = 0; j < 16; j++) acc[j] = (uint8_t)(acc[j] ^ blk[j]);
        gf128_mul(acc, H);
    }
}

static void put_bits64(uint8_t out[16], int base, size_t byte_len) {
    uint64_t x = (uint64_t)byte_len * 8u;
    for (int i = base + 7; i >= base; i--) {
        out[i] = (uint8_t)x;
        x >>= 8;
    }
}

static void compute_j0(const uint8_t H[16], uint8_t j0[16], const uint8_t *nonce, size_t nlen) {
    if (nlen == 12) {
        memcpy(j0, nonce, 12);
        j0[12] = 0;
        j0[13] = 0;
        j0[14] = 0;
        j0[15] = 1;
        return;
    }
    // SP 800-38D §7.1：J0 = GHASH_H(nonce || 0^(s+64) || [len(nonce)]_64)
    uint8_t acc[16];
    memset(acc, 0, 16);
    ghash_update(acc, H, nonce, nlen);
    // A 侧长度与补齐为 0，再喂一整块 [0]^8 || bits64
    uint8_t tail[16];
    memset(tail, 0, 16);
    put_bits64(tail, 8, nlen);
    ghash_update(acc, H, tail, 16);
    memcpy(j0, acc, 16);
}

static void inc32(uint8_t c[16]) {
    for (int i = 15; i >= 12; i--) {
        c[i] = (uint8_t)(c[i] + 1);
        if (c[i] != 0) return;
    }
}

static void gctr(const uint8_t rk[TLB_AES_ROUNDS * TLB_AES_BLOCK], uint8_t counter[16],
                 const uint8_t *in, size_t len, uint8_t *out) {
    uint8_t ks[16];
    for (size_t off = 0; off < len; off += 16) {
        tlb_aes128_encrypt_block_rk(rk, counter, ks);
        size_t n = len - off < 16 ? len - off : 16;
        for (size_t j = 0; j < n; j++) out[off + j] = (uint8_t)(in[off + j] ^ ks[j]);
        inc32(counter);
    }
}

static void gcm_tag(const uint8_t rk[TLB_AES_ROUNDS * TLB_AES_BLOCK], const uint8_t H[16],
                    const uint8_t j0[16], const uint8_t *aad, size_t alen, const uint8_t *ct,
                    size_t clen, uint8_t tag[16]) {
    uint8_t acc[16], lens[16], ej0[16];
    memset(acc, 0, 16);
    ghash_update(acc, H, aad, alen);
    ghash_update(acc, H, ct, clen);
    memset(lens, 0, 16);
    put_bits64(lens, 0, alen);
    put_bits64(lens, 8, clen);
    for (int j = 0; j < 16; j++) acc[j] = (uint8_t)(acc[j] ^ lens[j]);
    gf128_mul(acc, H);
    tlb_aes128_encrypt_block_rk(rk, j0, ej0);
    for (int i = 0; i < 16; i++) tag[i] = (uint8_t)(acc[i] ^ ej0[i]);
}

void tlb_aes128_gcm_encrypt(const uint8_t key[16], const uint8_t *nonce, size_t nlen,
                            const uint8_t *aad, size_t alen, const uint8_t *pt, size_t len,
                            uint8_t *ct, uint8_t tag[16]) {
    uint8_t rk[TLB_AES_ROUNDS * TLB_AES_BLOCK], H[16], j0[16], ctr[16];
    tlb_aes128_expand(key, rk);
    memset(H, 0, 16);
    tlb_aes128_encrypt_block_rk(rk, H, H);
    compute_j0(H, j0, nonce, nlen);
    memcpy(ctr, j0, 16);
    inc32(ctr);
    if (len) gctr(rk, ctr, pt, len, ct);
    gcm_tag(rk, H, j0, aad, alen, ct, len, tag);
}

void tlb_aes128_gcm_decrypt(const uint8_t key[16], const uint8_t *nonce, size_t nlen,
                            const uint8_t *aad, size_t alen, const uint8_t *ct, size_t len,
                            uint8_t *pt, uint8_t tag_expected[16]) {
    uint8_t rk[TLB_AES_ROUNDS * TLB_AES_BLOCK], H[16], j0[16], ctr[16];
    tlb_aes128_expand(key, rk);
    memset(H, 0, 16);
    tlb_aes128_encrypt_block_rk(rk, H, H);
    compute_j0(H, j0, nonce, nlen);
    memcpy(ctr, j0, 16);
    inc32(ctr);
    if (len) gctr(rk, ctr, ct, len, pt);
    gcm_tag(rk, H, j0, aad, alen, ct, len, tag_expected);
}

bool tlb_const_equal(const uint8_t *a, const uint8_t *b, size_t len) {
    uint8_t acc = 0;
    for (size_t i = 0; i < len; i++) acc = (uint8_t)(acc ^ (a[i] ^ b[i]));
    return acc == 0;
}
