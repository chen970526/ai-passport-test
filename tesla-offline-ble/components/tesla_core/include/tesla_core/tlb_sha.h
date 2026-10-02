// components/tesla_core/include/tesla_core/tlb_sha.h
// SHA-1 / SHA-256 / HMAC-SHA256：可移植实现，主机与设备共用同一份代码。
#pragma once

#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint32_t h[8];
    uint64_t total;
    uint8_t buf[64];
    size_t buflen;
} tlb_sha256_ctx;

void tlb_sha256_init(tlb_sha256_ctx *c);
void tlb_sha256_update(tlb_sha256_ctx *c, const uint8_t *msg, size_t len);
void tlb_sha256_final(tlb_sha256_ctx *c, uint8_t out[32]);

void tlb_sha256(const uint8_t *msg, size_t len, uint8_t out[32]);
void tlb_sha1(const uint8_t *msg, size_t len, uint8_t out[20]);

// 多段输入的 SHA-256：AAD 由 TLV ‖ 0xFF ‖ msg 拼成，不为了哈希再复制一份大缓冲
void tlb_sha256_parts(const uint8_t *const *parts, const size_t *lens, size_t nparts,
                      uint8_t out[32]);

// HMAC-SHA256（key 长度任意，内部按块长 64 处理）
void tlb_hmac_sha256(const uint8_t *key, size_t klen, const uint8_t *msg, size_t mlen,
                     uint8_t out[32]);

// 多段输入的 HMAC-SHA256：避免为了 AAD 再复制一份大缓冲
void tlb_hmac_sha256_parts(const uint8_t *key, size_t klen, const uint8_t *const *parts,
                           const size_t *lens, size_t nparts, uint8_t out[32]);
