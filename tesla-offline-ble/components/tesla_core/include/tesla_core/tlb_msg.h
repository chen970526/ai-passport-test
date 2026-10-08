// components/tesla_core/include/tesla_core/tlb_msg.h
// V3 报文的组包 / 解包（只覆盖本项目用到的字段子集）。
// 组的字节必须与探针 src/protocol/v3/{aead,handshake,codec}.js 逐字节一致，
// 因此各编码函数内部的字段书写顺序是硬约束，不要按字段号重排。
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "tesla_core/tlb_types.h"

// ---------------------------------------------------------------- 编码

// UnsignedMessage{RKEAction}：整条消息就是一个 oneof，
// UNLOCK=0 也必须写 tag，否则报文退化成 0 字节，车辆只会回 WAIT。
size_t tlb_msg_encode_rke(uint32_t action, uint8_t *out, size_t cap);

// UnsignedMessage{closureMoveRequest}：lid 0=前备箱（frontTrunk 字段 6）、1=后备箱（rearTrunk 字段 5），
// 移动类型 ClosureMoveType_E.OPEN=3。整条同样是 oneof，tag 必写。
size_t tlb_msg_encode_closure(int lid, uint8_t *out, size_t cap);

// UnsignedMessage{InformationRequest{}}：GET_STATUS=0 按 proto3 省略 → 空子消息 0A 00，
// 车辆回一条 FromVCSECMessage{vehicleStatus}。
size_t tlb_msg_encode_status_query(uint8_t *out, size_t cap);

// session_info 握手请求：to_destination → from_destination → session_info_request → uuid
size_t tlb_msg_encode_handshake_request(uint32_t domain, const uint8_t *routing_address,
                                       const uint8_t *public_key, const uint8_t *uuid, uint8_t *out,
                                       size_t cap);

// 加密命令的 RoutableMessage（AES_GCM_PERSONALIZED）
// 书写顺序：to_destination → from_destination → protobuf_message_as_bytes
//           → signature_data{signer_identity, AES_GCM_Personalized_data} → uuid → flags(仅 >0)
typedef struct {
    uint32_t domain; // to_destination.domain
    const uint8_t *routing_address; // from_destination.routing_address，协议固定 16 字节
    const uint8_t *payload; // 已加密的密文（不是明文）
    size_t payload_len;
    const uint8_t *signer_public_key;
    size_t signer_public_key_len;
    const uint8_t *epoch;
    size_t epoch_len;
    const uint8_t *nonce;
    size_t nonce_len;
    uint32_t counter;
    uint32_t expires_at; // fixed32（小端）
    const uint8_t *tag;
    size_t tag_len;
    const uint8_t *uuid;
    size_t uuid_len;
    uint32_t flags; // 0 = 不写
} tlb_cmd_wire_t;

size_t tlb_msg_encode_command(const tlb_cmd_wire_t *c, uint8_t *out, size_t cap);

// 明文请求（buildPlainRequest）：不带 signature_data，字段顺序与加密命令一致
size_t tlb_msg_encode_plain(uint32_t domain, const uint8_t *routing_address, const uint8_t *payload,
                           size_t payload_len, const uint8_t *uuid, size_t uuid_len, uint32_t flags,
                           uint8_t *out, size_t cap);

// 加白名单：无会话时走裸信封 ToVCSECMessage{signedMessage{PRESENT_KEY}}
// payload = UnsignedMessage{WhitelistOperation{addKeyToWhitelistAndAddPermissions{key,keyRole},
//                                                metadataForKey{keyFormFactor}}}
size_t tlb_msg_encode_add_key_payload(const uint8_t *public_key, size_t public_key_len,
                                     uint32_t role, uint32_t form_factor, uint8_t *out, size_t cap);
size_t tlb_msg_encode_add_key_envelope(const uint8_t *public_key, size_t public_key_len,
                                      uint32_t role, uint32_t form_factor, uint8_t *out,
                                      size_t cap);

// ---------------------------------------------------------------- 解码

typedef struct {
    bool present;
    const uint8_t *signer_pubkey;
    size_t signer_pubkey_len;
    uint32_t signer_handle;
    bool has_signer_handle;
    // signature_data 的 oneof 只会命中一个
    bool has_gcm_personalized;
    const uint8_t *gp_epoch;
    size_t gp_epoch_len;
    const uint8_t *gp_nonce;
    size_t gp_nonce_len;
    uint32_t gp_counter;
    bool gp_has_counter;
    uint32_t gp_expires_at;
    bool gp_has_expires_at;
    const uint8_t *gp_tag;
    size_t gp_tag_len;
    const uint8_t *session_info_tag; // HMAC_Signature_Data.tag
    size_t session_info_tag_len;
    bool has_session_info_tag;
    bool has_response_data; // AES_GCM_Response_data
    const uint8_t *resp_nonce;
    size_t resp_nonce_len;
    uint32_t resp_counter;
    bool resp_has_counter;
    const uint8_t *resp_tag;
    size_t resp_tag_len;
} tlb_sigdata_t;

typedef struct {
    size_t known; // 命中了几个已登记字段；0 表示这压根不是 RoutableMessage
    bool has_to_domain;
    uint32_t to_domain;
    // to_destination 也可能是 routing_address（oneof 二选一）：
    // 响应帧里的 to_destination.routing_address 就是配对闸门一要比对的东西
    const uint8_t *to_routing_address;
    size_t to_routing_address_len;
    bool has_from_domain;
    uint32_t from_domain;
    const uint8_t *from_routing_address;
    size_t from_routing_address_len;
    const uint8_t *payload; // protobuf_message_as_bytes
    size_t payload_len;
    bool has_payload;
    const uint8_t *session_info; // field 15 原文
    size_t session_info_len;
    bool has_session_info;
    bool has_status;
    uint32_t operation_status;
    uint32_t signed_message_fault;
    tlb_sigdata_t sig;
    const uint8_t *request_uuid; // field 50：车辆对我方请求的回指，配对闸门与握手 challenge 都靠它
    size_t request_uuid_len;
    const uint8_t *uuid;
    size_t uuid_len;
    uint32_t flags;
} tlb_rm_t;

// 只有整体 wire 解析失败才返回 false；未知字段按 pb.js 的降级语义跳过
bool tlb_msg_decode_rm(const uint8_t *data, size_t len, tlb_rm_t *out);

typedef struct {
    size_t known;
    uint32_t counter;
    bool has_counter;
    const uint8_t *public_key;
    size_t public_key_len;
    const uint8_t *epoch;
    size_t epoch_len;
    uint32_t clock_time;
    bool has_clock_time;
    uint32_t status;
    bool has_status;
    uint32_t handle;
    bool has_handle;
} tlb_session_info_t;

bool tlb_msg_decode_session_info(const uint8_t *data, size_t len, tlb_session_info_t *out);

// pb.js:mapFields 对未登记字段的降级写法：
//   varint → 数字本身；LEN → '<十六进制>'；渲染成键名 f<号>
#define TLB_UNK_MAX 8
typedef struct {
    uint32_t field;
    bool is_varint;
    uint64_t value; // is_varint 时的线上值
    const uint8_t *bytes;
    size_t bytes_len;
} tlb_unk_t;

// FromVCSECMessage{commandStatus}：明文回包（加白名单那条老路）与解密后的载荷共用
typedef struct {
    size_t known;
    bool has_command_status;
    uint32_t operation_status; // VCOperationStatus_E
    bool has_operation_status;
    uint32_t sm_counter;
    bool has_sm_counter;
    uint32_t signed_message_information;
    bool has_smi;
    // commandStatus.signedMessageStatus 本身存在与否（空子消息也算存在）：
    // 探针 appOutcome 用它判「operationStatus=ERROR 且车辆没给原因」
    bool has_signed_message_status;
    bool has_whitelist_status;
    uint32_t wl_information;
    bool has_wl_information;
    uint32_t wl_operation_status;
    bool has_wl_operation_status;
    // commandStatus.whitelistOperationStatus.signerOfOperation.publicKeySHA1：
    // 探针 summarizeVcsec 的「签署者=<hex>」靠它，缺失或 0 字节都渲染 '-'
    bool has_wl_signer;
    const uint8_t *wl_signer;
    size_t wl_signer_len;
    bool has_vehicle_status;
    // vehicleStatus 内层（本核心解析的三个字段）。内层解析失败时这几项清零、标志回 false，
    // 但 has_vehicle_status 不受影响 —— inspect/summarize 的文本逐字不变。
    bool has_closure_status;
    uint8_t closure_state[8]; // ClosureStatuses 字段 1..8：前左 前右 后左 后右 后备箱 前备箱 充电口 卷盖板
    bool has_vehicle_lock_state;
    uint32_t vehicle_lock_state; // VehicleLockState_E：UNLOCKED=0 LOCKED=1
    bool has_vehicle_sleep_status;
    uint32_t vehicle_sleep_status;
    // whitelistInfo/whitelistEntryInfo 内层仍不解析（偏离），但 inspect 的键名要有，只留存在位
    bool has_whitelist_info;
    bool has_whitelist_entry_info;
    bool has_nominal_error;
    uint32_t nominal_error;
    // 探针 pb.js 会把未登记字段记成 f<n> 键，因此 appOutcome 的
    // Object.keys(obj).length === 0 等价于 known==0 && n_unknown==0
    // 「未识别」分支要把 f<n>=… 原样渲染出来，未知字段按线上顺序留档（超出上限只留前 8 个）
    size_t n_unknown;
    tlb_unk_t unknown[TLB_UNK_MAX];
} tlb_vcsec_t;

bool tlb_msg_decode_from_vcsec(const uint8_t *data, size_t len, tlb_vcsec_t *out);
