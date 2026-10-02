// components/tesla_core/include/tesla_core/tlb_aes.h
// AES-128 分组加密 + AES-GCM（12 字节 nonce 的快捷路径 + SP 800-38D 通用路径）。
// 与探针 JS 实现同源，主机与设备共用同一份代码，逐字节可比对。
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define TLB_AES_BLOCK 16
#define TLB_AES_ROUNDS 11 // 16 字节轮密钥 x 11 = 176 字节

// 展开 16 字节密钥为 176 字节轮密钥
void tlb_aes128_expand(const uint8_t key[16], uint8_t rk[TLB_AES_ROUNDS * TLB_AES_BLOCK]);

// 单块加密
void tlb_aes128_encrypt_block_rk(const uint8_t rk[TLB_AES_ROUNDS * TLB_AES_BLOCK],
                                 const uint8_t in[16], uint8_t out[16]);
void tlb_aes128_encrypt_block(const uint8_t key[16], const uint8_t in[16], uint8_t out[16]);

// AES-128-GCM：ct 与 pt 可以为同一块缓冲（原地）。tag 恒为 16 字节。
// 加密：调用方给出的 aad/pt 长度必须与 len 一致；pt==NULL 表示空明文（只算 tag）。
void tlb_aes128_gcm_encrypt(const uint8_t key[16], const uint8_t *nonce, size_t nlen,
                            const uint8_t *aad, size_t alen, const uint8_t *pt, size_t len,
                            uint8_t *ct, uint8_t tag[16]);

// 解密并给出期望 tag，由调用方比对（协议里 tag 不符只记日志、不崩溃）
void tlb_aes128_gcm_decrypt(const uint8_t key[16], const uint8_t *nonce, size_t nlen,
                            const uint8_t *aad, size_t alen, const uint8_t *ct, size_t len,
                            uint8_t *pt, uint8_t tag_expected[16]);

// 恒定时间比较（这里只是把「比 tag」这件事收进 core，避免各调用点各写一份）
bool tlb_const_equal(const uint8_t *a, const uint8_t *b, size_t len);
