// components/tesla_core/include/tesla_core/tlb_v3.h
// V3 会话层：共享密钥派生、握手参数采纳、加密命令、请求 ID、响应解密。
// 权威依据：探针 src/protocol/v3/{handshake,aead}.js（对应官方
// internal/authentication/{native,peer,signer}.go）。
// 本文件只做纯计算，不碰 BLE、不碰 NVS、不读系统时钟 —— 时间一律由调用方传入，
// 随机数与 ECDH 走 tlb_types.h 里的平台钩子，这样主机测试能逐字节复现。
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "tesla_core/tlb_msg.h"
#include "tesla_core/tlb_types.h"

#define TLB_REQUEST_ID_MAX 17 // sigtype 1 字节 ‖ tag（GCM tag 16 / HMAC tag 截断到 16）
#define TLB_V3_DEFAULT_EXPIRES_IN 5u // dispatcher.defaultExpiration = 5s
// RoutableMessage 相对明文的固定开销：留足余量（各字段 tag/len + 公钥 65 + epoch/nonce/tag）
#define TLB_V3_FRAME_OVERHEAD 224u

typedef struct {
    uint8_t key[TLB_KEY_LEN]; // K = SHA1(ECDH)[:16]
    bool has_key;
    uint8_t epoch[TLB_EPOCH_LEN];
    size_t epoch_len; // 0 = 还没握手
    uint8_t vehicle_pub[TLB_PUB_LEN];
    size_t vehicle_pub_len;
    bool has_anchor; // 对应 JS 里 session.anchor === undefined 的判空
    int64_t anchor; // 本地秒 - 车辆 clock_time；expires_at = 本地秒 - anchor + 生命周期
    bool has_set_time; // 对应 JS 里 session.setTime === undefined
    uint32_t set_time;
    uint32_t clock_time;
    uint32_t counter; // 已经用掉的最大 counter；只增不减
    bool ready; // session_info.status == 0
} tlb_v3_session_t;

typedef struct {
    uint32_t counter; // 车辆给的 counter（写进会话时取 max）
    uint32_t clock_time;
    uint32_t status; // SessionInfo_Status
    bool key_not_whitelisted; // status == 1
} tlb_v3_hs_info_t;

void tlb_v3_session_reset(tlb_v3_session_t *s);

// K = SHA1(ECDH 私钥, 车辆公钥 的共享 X)[:16]
bool tlb_v3_derive_key(const uint8_t priv[TLB_PRIV_LEN], const uint8_t pub[TLB_PUB_LEN],
                       uint8_t out[TLB_KEY_LEN]);
// 已经拿到共享秘密时直接派生（主机测试不需要 ECDH）
bool tlb_v3_shared_key(const uint8_t *shared, size_t shared_len, uint8_t out[TLB_KEY_LEN]);

// 子密钥 = HMAC-SHA256(K, utf8(label))
void tlb_v3_subkey(const uint8_t *key, size_t klen, const char *label, uint8_t out[32]);
// 握手校验 tag 用的 HMAC（key 为 32 字节子密钥，输入为 TLV ‖ 0xFF ‖ session_info）
void tlb_v3_session_info_hmac(const uint8_t key[TLB_KEY_LEN], const char *vin,
                              const uint8_t *challenge, size_t challenge_len,
                              const uint8_t *encoded, size_t encoded_len, uint8_t out[32]);

// 校验并采纳车辆的 session_info。失败一律不污染已有会话（counter 只上调）。
// now：本地秒（由调用方提供，写进 anchor）。
// 返回 TLB_OK 表示已采纳；TLB_ERR_STATE 表示按官方口径忽略（同 epoch 且车辆时钟倒退）。
tlb_err_t tlb_v3_apply_session_info(tlb_v3_session_t *s, const char *vin,
                                    const uint8_t *challenge, size_t challenge_len,
                                    const uint8_t *encoded, size_t encoded_len,
                                    const uint8_t *tag, size_t tag_len, int64_t now,
                                    tlb_v3_hs_info_t *info);

// ---------------------------------------------------------------- 加密命令

typedef struct {
    uint32_t domain;
    const char *vin;
    const uint8_t *signer_pub; // 本机公钥（未压缩 65 字节）
    size_t signer_pub_len;
    const uint8_t *payload; // 明文应用层报文
    size_t payload_len;
    const uint8_t *routing_address; // 固定 16 字节，NULL 视为参数错误
    const uint8_t *uuid; // 固定 16 字节
    uint32_t flags; // 请求 flags（0 = 不写）
    uint32_t expires_in; // 生命周期秒
    int64_t now; // 本地秒
    const uint8_t *nonce; // NULL = 走 tlb_port_random（仅自测时传入固定值）
    size_t nonce_len;
} tlb_v3_cmd_t;

typedef struct {
    uint32_t counter;
    uint32_t expires_at;
    uint8_t nonce[TLB_NONCE_LEN];
    uint8_t tag[TLB_TAG_LEN];
    uint8_t aad[32];
    uint8_t request_id[TLB_REQUEST_ID_MAX];
    size_t request_id_len;
    size_t ciphertext_len;
    size_t frame_len;
} tlb_v3_cmd_out_t;

// scratch 至少 payload_len；out 至少 payload_len + TLB_V3_FRAME_OVERHEAD。
// 只有整帧组包成功才会推进 s->counter（与官方 Encrypt 的「抛错等于这号没发出去」等价）。
tlb_err_t tlb_v3_encrypt_command(tlb_v3_session_t *s, const tlb_v3_cmd_t *c, uint8_t *scratch,
                                 size_t scratch_len, uint8_t *out, size_t cap,
                                 tlb_v3_cmd_out_t *res);

// 从已解码的请求帧算 request_id（signer/peer.go RequestID）：
//   AES_GCM_PERSONALIZED → 0x05 ‖ tag（17 字节）
// 没有 GCM 签名的帧（明文请求 / 握手请求）返回 false —— 本项目不发 HMAC 命令。
bool tlb_v3_request_id(const tlb_rm_t *rm, uint8_t out[TLB_REQUEST_ID_MAX], size_t *out_len);

// 解密 FLAG_ENCRYPT_RESPONSE 的响应（signer.go Decrypt）。
// AAD 的 domain 字节取响应 from_destination.domain，缺失即 0 —— 不能回退成请求的域。
// TLB_ERR_PROTO = 这帧没有 AES_GCM_Response_data；TLB_ERR_CRYPTO = tag 不符。
tlb_err_t tlb_v3_decrypt_response(const tlb_v3_session_t *s, const tlb_rm_t *rm, const char *vin,
                                  const uint8_t *request_id, size_t request_id_len, uint8_t *out,
                                  size_t cap, size_t *out_len, uint32_t *counter_out);
