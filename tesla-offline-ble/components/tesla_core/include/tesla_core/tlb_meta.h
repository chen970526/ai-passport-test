// components/tesla_core/include/tesla_core/tlb_meta.h
// V3 TLV 元数据（对应探针 src/protocol/v3/metadata.js / 官方 metadata.go）。
// 线上形态：每个字段 [tag u8][len u8][value]；tag 严格递增；len<=255。
// 注意：元数据里的 uint32 一律大端；protobuf 的 fixed32 才是小端，别混。
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "tesla_core/tlb_types.h"

#define TLB_META_MAX 160 // TLV 串上限：本项目最长约 105 字节
// authentication.epochLength：expires_at 超过它，车辆一律判为非法 token
#define TLB_MAX_EPOCH_SECONDS (1u << 30)

typedef struct {
    uint8_t tlv[TLB_META_MAX];
    size_t len;
    int last_tag; // 递增校验；-1 表示还没写过
    bool failed;
} tlb_meta_t;

void tlb_meta_init(tlb_meta_t *m);
bool tlb_meta_ok(const tlb_meta_t *m);
size_t tlb_meta_len(const tlb_meta_t *m);

// 必写（vlen 允许 0，此时写出 [tag][00]）
bool tlb_meta_add(tlb_meta_t *m, uint8_t tag, const uint8_t *v, size_t vlen);
// v == NULL 静默跳过，对应 JS 的 add(tag, null)
bool tlb_meta_add_opt(tlb_meta_t *m, uint8_t tag, const uint8_t *v, size_t vlen);
bool tlb_meta_add_byte(tlb_meta_t *m, uint8_t tag, uint8_t v);
bool tlb_meta_add_u32(tlb_meta_t *m, uint8_t tag, uint32_t v);
// write == false 时整个字段不出现（请求侧 flags 仅当 >0 才写进哈希）
bool tlb_meta_add_u32_opt(tlb_meta_t *m, uint8_t tag, uint32_t v, bool write);

// 哈希输入 = TLV ‖ 0xFF ‖ msg（多段直传，不复制大缓冲）
// AAD 用 sha256；HMAC 的 keylen 由调用方决定：
//   GCM 加密用会话密钥本身（16 字节 K），HMAC tag 用子密钥（32 字节）。
bool tlb_meta_sha256(const tlb_meta_t *m, const uint8_t *msg, size_t msglen, uint8_t out[32]);
bool tlb_meta_hmac(const tlb_meta_t *m, const uint8_t *key, size_t keylen, const uint8_t *msg,
                   size_t msglen, uint8_t out[32]);
// 展开成连续字节，仅供日志与主机金标准比对
size_t tlb_meta_render(const tlb_meta_t *m, const uint8_t *msg, size_t msglen, uint8_t *out,
                       size_t cap);

// ---------------------------------------------------------------- 组好的请求/响应元数据

typedef struct {
    uint8_t signature_type; // SignatureType
    uint8_t domain;
    const char *vin;        // 可为 NULL；内部按 ASCII 大写处理
    const uint8_t *epoch;   // NULL = 跳过该 tag
    size_t epoch_len;
    uint32_t expires_at;
    uint32_t counter;
    uint32_t flags;         // 0 = 不写
} tlb_req_meta_t;

// 失败（VIN 过长 / TLV 溢出 / expires_at 越界）返回 false
bool tlb_meta_build_request(tlb_meta_t *m, const tlb_req_meta_t *p);

typedef struct {
    uint8_t domain;         // 来自响应 from_destination.domain，缺失即 0
    const char *vin;
    uint32_t counter;
    uint32_t flags;         // 恒含
    const uint8_t *request_id; // NULL = 跳过 REQUEST_HASH
    size_t request_id_len;
    uint32_t fault;
} tlb_resp_meta_t;

bool tlb_meta_build_response(tlb_meta_t *m, const tlb_resp_meta_t *p);

// VIN 转 ASCII 大写后写入 out，返回实际长度（截断到 cap）
size_t tlb_meta_upper_vin(const char *vin, uint8_t *out, size_t cap);
