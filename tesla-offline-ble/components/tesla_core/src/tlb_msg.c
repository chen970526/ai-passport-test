// components/tesla_core/src/tlb_msg.c
// 字段的「书写顺序」逐条对齐探针里的 JS 对象字面量（见各函数上方注释）。
// oneof 成员一律 force=true（0 值也写 tag），普通 singular 等于默认值时省略 —— 与 pb.js 一致。
#include "tesla_core/tlb_msg.h"

#include <string.h>

#include "tesla_core/tlb_pb.h"

// ---------------------------------------------------------------- 编码

size_t tlb_msg_encode_rke(uint32_t action, uint8_t *out, size_t cap)
{
    // encode(SPEC,'UnsignedMessage',{ RKEAction: action })  —— 字段 2 在 oneof sub_message 里
    tlb_wb_t w;
    tlb_wb_init(&w, out, cap);
    if (!tlb_wb_u32(&w, 2, action, true)) {
        return 0;
    }
    return tlb_wb_len(&w);
}

size_t tlb_msg_encode_closure(int lid, uint8_t *out, size_t cap)
{
    // encode(SPEC,'UnsignedMessage',{ closureMoveRequest: { frontTrunk|rearTrunk: OPEN } })
    // closureMoveRequest 是 oneof 字段 4（内层先写、外层再包 LEN）；lid 0=前备箱（frontTrunk 字段 6）、
    // 1=后备箱（rearTrunk 字段 5）。字段类型是 ClosureMoveType_E，OPEN=3 —— 不是 ClosureState_E 的 OPEN=1。
    // 产物（供核对）：lid=0 → 22 02 30 03；lid=1 → 22 02 28 03。
    uint8_t cmr_buf[16];
    tlb_wb_t cmr, w;
    tlb_wb_init(&cmr, cmr_buf, sizeof(cmr_buf));
    if (!tlb_wb_u32(&cmr, lid == 0 ? 6 : 5, TLB_CLOSURE_MOVE_OPEN, false)) {
        return 0;
    }
    tlb_wb_init(&w, out, cap);
    if (!tlb_wb_sub(&w, 4, &cmr)) { // oneof 成员：tlb_wb_sub 无条件写 tag+len
        return 0;
    }
    return tlb_wb_len(&w);
}

size_t tlb_msg_encode_status_query(uint8_t *out, size_t cap)
{
    // encode(SPEC,'UnsignedMessage',{ InformationRequest: {} })
    // informationRequestType = GET_STATUS = 0，proto3 省略 → 空子消息，产物 0A 00（供核对）。
    // 车辆回一条 FromVCSECMessage{vehicleStatus}。
    uint8_t ir_buf[8];
    tlb_wb_t ir, w;
    tlb_wb_init(&ir, ir_buf, sizeof(ir_buf));
    tlb_wb_init(&w, out, cap);
    if (!tlb_wb_sub(&w, 1, &ir)) { // InformationRequest 是 oneof 字段 1，空体也要写 tag+len0
        return 0;
    }
    return tlb_wb_len(&w);
}

// Destination{ domain(1 oneof) | routing_address(2 oneof) }
static bool encode_destination(tlb_wb_t *w, uint32_t field, bool has_domain, uint32_t domain,
                               const uint8_t *routing_address)
{
    uint8_t buf[40];
    tlb_wb_t d;
    tlb_wb_init(&d, buf, sizeof(buf));
    if (has_domain && !tlb_wb_u32(&d, 1, domain, true)) {
        return false;
    }
    // routing_address 固定 16 字节；NULL 表示 JS 里那个 key 不存在 → 写空的 Destination
    if (routing_address && !tlb_wb_bytes(&d, 2, routing_address, TLB_ADDR_LEN, true)) {
        return false;
    }
    return tlb_wb_sub(w, field, &d);
}

size_t tlb_msg_encode_handshake_request(uint32_t domain, const uint8_t *routing_address,
                                       const uint8_t *public_key, const uint8_t *uuid, uint8_t *out,
                                       size_t cap)
{
    // buildSessionInfoRequest：to_destination{domain}
    //                         → from_destination{routing_address}
    //                         → session_info_request{public_key}
    //                         → uuid
    uint8_t sir_buf[80];
    tlb_wb_t sir, w;
    tlb_wb_init(&sir, sir_buf, sizeof(sir_buf));
    if (!tlb_wb_bytes(&sir, 1, public_key, TLB_PUB_LEN, false)) { // SessionInfoRequest.public_key
        return 0;
    }

    tlb_wb_init(&w, out, cap);
    if (!encode_destination(&w, 6, true, domain, NULL)) {
        return 0;
    }
    if (!encode_destination(&w, 7, false, 0, routing_address)) {
        return 0;
    }
    if (!tlb_wb_sub(&w, 14, &sir)) { // session_info_request 是 payload oneof 成员
        return 0;
    }
    if (!tlb_wb_bytes(&w, 51, uuid, TLB_ADDR_LEN, false)) {
        return 0;
    }
    return tlb_wb_len(&w);
}

size_t tlb_msg_encode_command(const tlb_cmd_wire_t *c, uint8_t *out, size_t cap)
{
    // encryptCommand 的 message 字面量顺序；内层先写、外层再包 LEN
    uint8_t gcm_buf[128];
    uint8_t ki_buf[80];
    uint8_t sig_buf[256];
    tlb_wb_t gcm, ki, sig, w;

    if (!c) {
        return 0;
    }

    // AES_GCM_Personalized_Signature_Data: epoch(1) nonce(2) counter(3) expires_at(4 fixed32) tag(5)
    tlb_wb_init(&gcm, gcm_buf, sizeof(gcm_buf));
    if (!tlb_wb_bytes(&gcm, 1, c->epoch, c->epoch_len, false)) {
        return 0;
    }
    if (!tlb_wb_bytes(&gcm, 2, c->nonce, c->nonce_len, false)) {
        return 0;
    }
    if (!tlb_wb_u32(&gcm, 3, c->counter, false)) {
        return 0;
    }
    if (!tlb_wb_fixed32(&gcm, 4, c->expires_at, false)) {
        return 0;
    }
    if (!tlb_wb_bytes(&gcm, 5, c->tag, c->tag_len, false)) {
        return 0;
    }

    // KeyIdentity 整条就是 oneof identity_type，public_key 即使为空也要写（等价 JS 的空 LEN 字段）
    tlb_wb_init(&ki, ki_buf, sizeof(ki_buf));
    if (!tlb_wb_bytes(&ki, 1, c->signer_public_key, c->signer_public_key_len, true)) {
        return 0;
    }

    // SignatureData: signer_identity(1) → AES_GCM_Personalized_data(5, oneof)
    tlb_wb_init(&sig, sig_buf, sizeof(sig_buf));
    if (!tlb_wb_sub(&sig, 1, &ki)) {
        return 0;
    }
    if (!tlb_wb_sub(&sig, 5, &gcm)) {
        return 0;
    }

    tlb_wb_init(&w, out, cap);
    if (!encode_destination(&w, 6, true, c->domain, NULL)) {
        return 0;
    }
    if (!encode_destination(&w, 7, false, 0, c->routing_address)) {
        return 0;
    }
    if (!tlb_wb_bytes(&w, 10, c->payload, c->payload_len, false)) {
        return 0;
    }
    if (!tlb_wb_sub(&w, 13, &sig)) { // signature_data 是 sub_sigData oneof 成员
        return 0;
    }
    if (!tlb_wb_bytes(&w, 51, c->uuid, c->uuid_len, false)) {
        return 0;
    }
    if (!tlb_wb_u32(&w, 52, c->flags, false)) { // JS: if (flags > 0) message.flags = flags
        return 0;
    }
    return tlb_wb_len(&w);
}

size_t tlb_msg_encode_plain(uint32_t domain, const uint8_t *routing_address, const uint8_t *payload,
                           size_t payload_len, const uint8_t *uuid, size_t uuid_len, uint32_t flags,
                           uint8_t *out, size_t cap)
{
    // buildPlainRequest：to_destination{domain} → from_destination{routing_address}
    //                   → protobuf_message_as_bytes → uuid → flags(仅 >0)
    tlb_wb_t w;
    tlb_wb_init(&w, out, cap);
    if (!encode_destination(&w, 6, true, domain, NULL)) {
        return 0;
    }
    if (!encode_destination(&w, 7, false, 0, routing_address)) {
        return 0;
    }
    if (!tlb_wb_bytes(&w, 10, payload, payload_len, false)) {
        return 0;
    }
    if (!tlb_wb_bytes(&w, 51, uuid, uuid_len, false)) {
        return 0;
    }
    if (!tlb_wb_u32(&w, 52, flags, false)) {
        return 0;
    }
    return tlb_wb_len(&w);
}

size_t tlb_msg_encode_add_key_payload(const uint8_t *public_key, size_t public_key_len, uint32_t role,
                                     uint32_t form_factor, uint8_t *out, size_t cap)
{
    // buildAddKeyPayload：UnsignedMessage{16} → WhitelistOperation{5, 6}
    //   → PermissionChange{key: PublicKey{PublicKeyRaw}, keyRole} + KeyMetadata{keyFormFactor}
    uint8_t key_buf[80];
    uint8_t pc_buf[128];
    uint8_t md_buf[16];
    uint8_t wo_buf[192];
    tlb_wb_t key, pc, md, wo, w;

    tlb_wb_init(&key, key_buf, sizeof(key_buf));
    if (!tlb_wb_bytes(&key, 1, public_key, public_key_len, false)) {
        return 0;
    }

    tlb_wb_init(&pc, pc_buf, sizeof(pc_buf));
    if (!tlb_wb_sub(&pc, 1, &key)) {
        return 0;
    }
    if (!tlb_wb_u32(&pc, 4, role, false)) {
        return 0;
    }

    tlb_wb_init(&md, md_buf, sizeof(md_buf));
    if (!tlb_wb_u32(&md, 1, form_factor, false)) {
        return 0;
    }

    tlb_wb_init(&wo, wo_buf, sizeof(wo_buf));
    if (!tlb_wb_sub(&wo, 5, &pc)) { // addKeyToWhitelistAndAddPermissions（oneof 成员）
        return 0;
    }
    if (!tlb_wb_sub(&wo, 6, &md)) { // metadataForKey 在 oneof 外，但 JS 里这个 key 恒存在
        return 0;
    }

    tlb_wb_init(&w, out, cap);
    if (!tlb_wb_sub(&w, 16, &wo)) {
        return 0;
    }
    return tlb_wb_len(&w);
}

size_t tlb_msg_encode_add_key_envelope(const uint8_t *public_key, size_t public_key_len, uint32_t role,
                                      uint32_t form_factor, uint8_t *out, size_t cap)
{
    // buildAddKeyEnvelope：ToVCSECMessage{ signedMessage{ protobufMessageAsBytes(2),
    //                                                     signatureType(3)=PRESENT_KEY } }
    uint8_t payload_buf[224];
    uint8_t sm_buf[256];
    tlb_wb_t sm, w;
    size_t payload_len = tlb_msg_encode_add_key_payload(public_key, public_key_len, role, form_factor,
                                                       payload_buf, sizeof(payload_buf));
    if (!payload_len) {
        return 0;
    }

    tlb_wb_init(&sm, sm_buf, sizeof(sm_buf));
    if (!tlb_wb_bytes(&sm, 2, payload_buf, payload_len, false)) {
        return 0;
    }
    if (!tlb_wb_u32(&sm, 3, TLB_VSEC_SIG_PRESENT_KEY, false)) {
        return 0;
    }

    tlb_wb_init(&w, out, cap);
    if (!tlb_wb_sub(&w, 1, &sm)) {
        return 0;
    }
    return tlb_wb_len(&w);
}

// ---------------------------------------------------------------- 解码
// 每个字段都先验 wire type；不匹配就按「未知字段」跳过且不计入 known（对齐 pb.js 的降级）。

static bool decode_destination(tlb_rb_t *r, uint32_t *domain, bool *has_domain, const uint8_t **addr,
                              size_t *addr_len)
{
    uint32_t f, w;
    while (tlb_rb_next(r, &f, &w)) {
        switch (f) {
        case 1:
            if (w != TLB_WIRE_VARINT) {
                if (!tlb_rb_skip(r, w)) {
                    return false;
                }
                break;
            }
            {
                uint32_t v;
                if (!tlb_rb_u32(r, &v)) {
                    return false;
                }
                if (domain) {
                    *domain = v;
                }
                if (has_domain) {
                    *has_domain = true;
                }
            }
            break;
        case 2:
            if (w != TLB_WIRE_LEN) {
                if (!tlb_rb_skip(r, w)) {
                    return false;
                }
                break;
            }
            {
                // to_destination 里也可能带 routing_address，调用方不需要时必须丢弃而不是写空指针
                const uint8_t *p;
                size_t n;
                if (!tlb_rb_bytes(r, &p, &n)) {
                    return false;
                }
                if (addr && addr_len) {
                    *addr = p;
                    *addr_len = n;
                }
            }
            break;
        default:
            if (!tlb_rb_skip(r, w)) {
                return false;
            }
        }
    }
    return !r->failed;
}

static bool decode_key_identity(tlb_rb_t *r, tlb_sigdata_t *s)
{
    uint32_t f, w;
    while (tlb_rb_next(r, &f, &w)) {
        if (f == 1 && w == TLB_WIRE_LEN) {
            if (!tlb_rb_bytes(r, &s->signer_pubkey, &s->signer_pubkey_len)) {
                return false;
            }
        } else if (f == 3 && w == TLB_WIRE_VARINT) {
            if (!tlb_rb_u32(r, &s->signer_handle)) {
                return false;
            }
            s->has_signer_handle = true;
        } else if (!tlb_rb_skip(r, w)) {
            return false;
        }
    }
    return !r->failed;
}

static bool decode_gcm_personalized(tlb_rb_t *r, tlb_sigdata_t *s)
{
    uint32_t f, w;
    s->has_gcm_personalized = true;
    while (tlb_rb_next(r, &f, &w)) {
        if ((f == 1 || f == 2 || f == 5) && w == TLB_WIRE_LEN) {
            const uint8_t *p;
            size_t n;
            if (!tlb_rb_bytes(r, &p, &n)) {
                return false;
            }
            if (f == 1) {
                s->gp_epoch = p;
                s->gp_epoch_len = n;
            } else if (f == 2) {
                s->gp_nonce = p;
                s->gp_nonce_len = n;
            } else {
                s->gp_tag = p;
                s->gp_tag_len = n;
            }
        } else if (f == 3 && w == TLB_WIRE_VARINT) {
            if (!tlb_rb_u32(r, &s->gp_counter)) {
                return false;
            }
            s->gp_has_counter = true;
        } else if (f == 4 && w == TLB_WIRE_FIXED32) {
            if (!tlb_rb_fixed32(r, &s->gp_expires_at)) {
                return false;
            }
            s->gp_has_expires_at = true;
        } else if (!tlb_rb_skip(r, w)) {
            return false;
        }
    }
    return !r->failed;
}

static bool decode_gcm_response(tlb_rb_t *r, tlb_sigdata_t *s)
{
    uint32_t f, w;
    s->has_response_data = true;
    while (tlb_rb_next(r, &f, &w)) {
        if ((f == 1 || f == 3) && w == TLB_WIRE_LEN) {
            const uint8_t *p;
            size_t n;
            if (!tlb_rb_bytes(r, &p, &n)) {
                return false;
            }
            if (f == 1) {
                s->resp_nonce = p;
                s->resp_nonce_len = n;
            } else {
                s->resp_tag = p;
                s->resp_tag_len = n;
            }
        } else if (f == 2 && w == TLB_WIRE_VARINT) {
            if (!tlb_rb_u32(r, &s->resp_counter)) {
                return false;
            }
            s->resp_has_counter = true;
        } else if (!tlb_rb_skip(r, w)) {
            return false;
        }
    }
    return !r->failed;
}

// HMAC_Signature_Data{ tag(bytes,1) } —— session_info_tag 用的就是这一层。
// 不能复用 decode_key_identity：那样会把 signer_identity 的字段一起改掉。
static bool decode_hmac_signature_data(tlb_rb_t *r, tlb_sigdata_t *s)
{
    uint32_t f, w;
    s->has_session_info_tag = true;
    while (tlb_rb_next(r, &f, &w)) {
        if (f == 1 && w == TLB_WIRE_LEN) {
            if (!tlb_rb_bytes(r, &s->session_info_tag, &s->session_info_tag_len)) {
                return false;
            }
        } else if (!tlb_rb_skip(r, w)) {
            return false;
        }
    }
    return !r->failed;
}

static bool decode_signature_data(tlb_rb_t *r, tlb_sigdata_t *s)
{
    uint32_t f, w;
    s->present = true;
    while (tlb_rb_next(r, &f, &w)) {
        tlb_rb_t sub;
        if (w != TLB_WIRE_LEN) {
            if (!tlb_rb_skip(r, w)) {
                return false;
            }
            continue;
        }
        if (!tlb_rb_sub(r, &sub)) {
            return false;
        }
        switch (f) {
        case 1: // signer_identity
            if (!decode_key_identity(&sub, s)) {
                return false;
            }
            break;
        case 5: // AES_GCM_Personalized_data
            if (!decode_gcm_personalized(&sub, s)) {
                return false;
            }
            break;
        case 6: // session_info_tag = HMAC_Signature_Data{ tag(1) }
            if (!decode_hmac_signature_data(&sub, s)) {
                return false;
            }
            break;
        case 9: // AES_GCM_Response_data（车辆对 ENCRYPT_RESPONSE 请求的加密回包）
            if (!decode_gcm_response(&sub, s)) {
                return false;
            }
            break;
        default:
            // 8 = HMAC_Personalized（本项目不用 HMAC 认证命令）；未知字段忽略
            break;
        }
    }
    return !r->failed;
}

static bool decode_message_status(tlb_rb_t *r, uint32_t *operation_status, uint32_t *fault)
{
    uint32_t f, w;
    while (tlb_rb_next(r, &f, &w)) {
        if ((f == 1 || f == 2) && w == TLB_WIRE_VARINT) {
            if (!tlb_rb_u32(r, f == 1 ? operation_status : fault)) {
                return false;
            }
        } else if (!tlb_rb_skip(r, w)) {
            return false;
        }
    }
    return !r->failed;
}

bool tlb_msg_decode_rm(const uint8_t *data, size_t len, tlb_rm_t *out)
{
    tlb_rb_t r, sub;
    uint32_t f, w;

    if (!out) {
        return false;
    }
    memset(out, 0, sizeof(*out));
    tlb_rb_init(&r, data, len);
    while (tlb_rb_next(&r, &f, &w)) {
        switch (f) {
        case 6: // to_destination
            if (w != TLB_WIRE_LEN) {
                if (!tlb_rb_skip(&r, w)) {
                    return false;
                }
                break;
            }
            if (!tlb_rb_sub(&r, &sub) ||
                !decode_destination(&sub, &out->to_domain, &out->has_to_domain,
                                    &out->to_routing_address, &out->to_routing_address_len)) {
                return false;
            }
            out->known++;
            break;
        case 7: // from_destination
            if (w != TLB_WIRE_LEN) {
                if (!tlb_rb_skip(&r, w)) {
                    return false;
                }
                break;
            }
            if (!tlb_rb_sub(&r, &sub) ||
                !decode_destination(&sub, &out->from_domain, &out->has_from_domain,
                                    &out->from_routing_address, &out->from_routing_address_len)) {
                return false;
            }
            out->known++;
            break;
        case 10: // protobuf_message_as_bytes
            if (w != TLB_WIRE_LEN) {
                if (!tlb_rb_skip(&r, w)) {
                    return false;
                }
                break;
            }
            if (!tlb_rb_bytes(&r, &out->payload, &out->payload_len)) {
                return false;
            }
            out->has_payload = true;
            out->known++;
            break;
        case 12: // signedMessageStatus
            if (w != TLB_WIRE_LEN) {
                if (!tlb_rb_skip(&r, w)) {
                    return false;
                }
                break;
            }
            if (!tlb_rb_sub(&r, &sub) || !decode_message_status(&sub, &out->operation_status, &out->signed_message_fault)) {
                return false;
            }
            out->has_status = true;
            out->known++;
            break;
        case 13: // signature_data
            if (w != TLB_WIRE_LEN) {
                if (!tlb_rb_skip(&r, w)) {
                    return false;
                }
                break;
            }
            if (!tlb_rb_sub(&r, &sub) || !decode_signature_data(&sub, &out->sig)) {
                return false;
            }
            out->known++;
            break;
        case 15: // session_info（原文，交给 tlb_msg_decode_session_info）
            if (w != TLB_WIRE_LEN) {
                if (!tlb_rb_skip(&r, w)) {
                    return false;
                }
                break;
            }
            if (!tlb_rb_bytes(&r, &out->session_info, &out->session_info_len)) {
                return false;
            }
            out->has_session_info = true;
            out->known++;
            break;
        case 50: // request_uuid
            if (w != TLB_WIRE_LEN) {
                if (!tlb_rb_skip(&r, w)) {
                    return false;
                }
                break;
            }
            if (!tlb_rb_bytes(&r, &out->request_uuid, &out->request_uuid_len)) {
                return false;
            }
            out->known++;
            break;
        case 51: // uuid
            if (w != TLB_WIRE_LEN) {
                if (!tlb_rb_skip(&r, w)) {
                    return false;
                }
                break;
            }
            if (!tlb_rb_bytes(&r, &out->uuid, &out->uuid_len)) {
                return false;
            }
            out->known++;
            break;
        case 52: // flags
            if (w != TLB_WIRE_VARINT) {
                if (!tlb_rb_skip(&r, w)) {
                    return false;
                }
                break;
            }
            if (!tlb_rb_u32(&r, &out->flags)) {
                return false;
            }
            out->known++;
            break;
        default:
            // 14 = session_info_request（只有我方发出的请求才带），其余按未知字段跳过；都不计入 known
            if (!tlb_rb_skip(&r, w)) {
                return false;
            }
            break;
        }
    }
    return !r.failed;
}

bool tlb_msg_decode_session_info(const uint8_t *data, size_t len, tlb_session_info_t *out)
{
    tlb_rb_t r;
    uint32_t f, w;

    if (!out) {
        return false;
    }
    memset(out, 0, sizeof(*out));
    tlb_rb_init(&r, data, len);
    while (tlb_rb_next(&r, &f, &w)) {
        if ((f == 2 || f == 3) && w == TLB_WIRE_LEN) {
            if (!tlb_rb_bytes(&r, f == 2 ? &out->public_key : &out->epoch,
                              f == 2 ? &out->public_key_len : &out->epoch_len)) {
                return false;
            }
            out->known++;
        } else if ((f == 1 || f == 5 || f == 6) && w == TLB_WIRE_VARINT) {
            uint32_t v;
            if (!tlb_rb_u32(&r, &v)) {
                return false;
            }
            if (f == 1) {
                out->counter = v;
                out->has_counter = true;
            } else if (f == 5) {
                out->status = v;
                out->has_status = true;
            } else {
                out->handle = v;
                out->has_handle = true;
            }
            out->known++;
        } else if (f == 4 && w == TLB_WIRE_FIXED32) {
            if (!tlb_rb_fixed32(&r, &out->clock_time)) {
                return false;
            }
            out->has_clock_time = true;
            out->known++;
        } else if (!tlb_rb_skip(&r, w)) {
            return false;
        }
    }
    return !r.failed;
}

static bool decode_signed_message_status(tlb_rb_t *r, tlb_vcsec_t *out)
{
    uint32_t f, w;
    while (tlb_rb_next(r, &f, &w)) {
        if ((f == 1 || f == 2) && w == TLB_WIRE_VARINT) {
            uint32_t v;
            if (!tlb_rb_u32(r, &v)) {
                return false;
            }
            if (f == 1) {
                out->sm_counter = v;
                out->has_sm_counter = true;
            } else {
                out->signed_message_information = v;
                out->has_smi = true;
            }
        } else if (!tlb_rb_skip(r, w)) {
            return false;
        }
    }
    return !r->failed;
}

static bool decode_whitelist_operation_status(tlb_rb_t *r, tlb_vcsec_t *out)
{
    uint32_t f, w;
    while (tlb_rb_next(r, &f, &w)) {
        if ((f == 1 || f == 3) && w == TLB_WIRE_VARINT) {
            uint32_t v;
            if (!tlb_rb_u32(r, &v)) {
                return false;
            }
            if (f == 1) {
                out->wl_information = v;
                out->has_wl_information = true;
            } else {
                out->wl_operation_status = v;
                out->has_wl_operation_status = true;
            }
        } else if (f == 2 && w == TLB_WIRE_LEN) {
            // KeyIdentifier{ publicKeySHA1(1) }
            tlb_rb_t kid;
            uint32_t kf, kw;
            if (!tlb_rb_sub(r, &kid)) {
                return false;
            }
            while (tlb_rb_next(&kid, &kf, &kw)) {
                if (kf == 1 && kw == TLB_WIRE_LEN) {
                    if (!tlb_rb_bytes(&kid, &out->wl_signer, &out->wl_signer_len)) {
                        return false;
                    }
                    out->has_wl_signer = true;
                } else if (!tlb_rb_skip(&kid, kw)) {
                    return false;
                }
            }
            if (kid.failed) {
                return false;
            }
        } else if (!tlb_rb_skip(r, w)) {
            return false;
        }
    }
    return !r->failed;
}

static bool decode_command_status(tlb_rb_t *r, tlb_vcsec_t *out)
{
    uint32_t f, w;
    while (tlb_rb_next(r, &f, &w)) {
        if (f == 1 && w == TLB_WIRE_VARINT) {
            if (!tlb_rb_u32(r, &out->operation_status)) {
                return false;
            }
            out->has_operation_status = true;
        } else if ((f == 2 || f == 3) && w == TLB_WIRE_LEN) {
            tlb_rb_t sub;
            if (!tlb_rb_sub(r, &sub)) {
                return false;
            }
            if (f == 2) {
                // 空子消息同样算「车辆给了 signedMessageStatus」，与探针 cs.signedMessageStatus  truthy 对齐
                out->has_signed_message_status = true;
                if (!decode_signed_message_status(&sub, out)) {
                    return false;
                }
            } else {
                // 空子消息也算「命令已受理，正在等实体卡」，必须有标志位可判
                out->has_whitelist_status = true;
                if (!decode_whitelist_operation_status(&sub, out)) {
                    return false;
                }
            }
        } else if (!tlb_rb_skip(r, w)) {
            return false;
        }
    }
    return !r->failed;
}

// ClosureStatuses{frontDriverDoor(1) frontPassengerDoor(2) rearDriverDoor(3) rearPassengerDoor(4)
//                 rearTrunk(5) frontTrunk(6) chargePort(7) tonneau(8)}，全部 ClosureState_E。
// state8 下标 0..7 与字段号 1..8 一一对应；未出现的字段保持调用方预置值（0=CLOSED，proto3 语义）。
static bool decode_closure_statuses(tlb_rb_t *r, uint8_t *state8)
{
    uint32_t f, w;
    while (tlb_rb_next(r, &f, &w)) {
        if (f >= 1 && f <= 8 && w == TLB_WIRE_VARINT) {
            uint32_t v;
            if (!tlb_rb_u32(r, &v)) {
                return false;
            }
            state8[f - 1] = (uint8_t)v;
        } else if (!tlb_rb_skip(r, w)) {
            return false;
        }
    }
    return !r->failed;
}

// VehicleStatus{closureStatuses(1) vehicleLockState(2) vehicleSleepStatus(3) userPresence(4)
//               detailedClosureStatus(5)} —— 只解析前三个，其余按未知字段跳过。
static bool decode_vehicle_status(tlb_rb_t *r, tlb_vcsec_t *out)
{
    uint32_t f, w;
    while (tlb_rb_next(r, &f, &w)) {
        if (f == 1 && w == TLB_WIRE_LEN) {
            tlb_rb_t cs;
            if (!tlb_rb_sub(r, &cs)) {
                return false;
            }
            if (!decode_closure_statuses(&cs, out->closure_state)) {
                return false;
            }
            out->has_closure_status = true;
        } else if ((f == 2 || f == 3) && w == TLB_WIRE_VARINT) {
            uint32_t v;
            if (!tlb_rb_u32(r, &v)) {
                return false;
            }
            if (f == 2) {
                out->vehicle_lock_state = v;
                out->has_vehicle_lock_state = true;
            } else {
                out->vehicle_sleep_status = v;
                out->has_vehicle_sleep_status = true;
            }
        } else if (!tlb_rb_skip(r, w)) {
            return false;
        }
    }
    return !r->failed;
}

bool tlb_msg_decode_from_vcsec(const uint8_t *data, size_t len, tlb_vcsec_t *out)
{
    tlb_rb_t r, sub;
    uint32_t f, w;

    if (!out) {
        return false;
    }
    memset(out, 0, sizeof(*out));
    tlb_rb_init(&r, data, len);
    while (tlb_rb_next(&r, &f, &w)) {
        switch (f) {
        case 1: // vehicleStatus
        case 16: // whitelistInfo
        case 17: // whitelistEntryInfo
            if (w != TLB_WIRE_LEN) {
                if (!tlb_rb_skip(&r, w)) {
                    return false;
                }
                break;
            }
            if (!tlb_rb_sub(&r, &sub)) {
                return false;
            }
            if (f == 1) {
                out->has_vehicle_status = true;
                // 内层解析 closureStatuses/vehicleLockState/vehicleSleepStatus。
                // 解析失败只清新增字段：has_vehicle_status 照旧为 true，
                // inspect/summarize 的输出文本因此逐字不变（金标准锁死）。
                if (!decode_vehicle_status(&sub, out)) {
                    out->has_closure_status = false;
                    out->has_vehicle_lock_state = false;
                    out->has_vehicle_sleep_status = false;
                    memset(out->closure_state, 0, sizeof(out->closure_state));
                }
            } else if (f == 16) {
                out->has_whitelist_info = true;
            } else {
                out->has_whitelist_entry_info = true;
            }
            out->known++;
            break;
        case 4: // commandStatus
            if (w != TLB_WIRE_LEN) {
                if (!tlb_rb_skip(&r, w)) {
                    return false;
                }
                break;
            }
            if (!tlb_rb_sub(&r, &sub) || !decode_command_status(&sub, out)) {
                return false;
            }
            out->has_command_status = true;
            out->known++;
            break;
        case 46: // nominalError{ genericError(1) }
            if (w != TLB_WIRE_LEN) {
                if (!tlb_rb_skip(&r, w)) {
                    return false;
                }
                break;
            }
            if (!tlb_rb_sub(&r, &sub)) {
                return false;
            }
            out->has_nominal_error = true;
            {
                uint32_t ef, ew;
                while (tlb_rb_next(&sub, &ef, &ew)) {
                    if (ef == 1 && ew == TLB_WIRE_VARINT) {
                        if (!tlb_rb_u32(&sub, &out->nominal_error)) {
                            return false;
                        }
                    } else if (!tlb_rb_skip(&sub, ew)) {
                        return false;
                    }
                }
                if (sub.failed) {
                    return false;
                }
            }
            out->known++;
            break;
        default: {
            // pb.js:mapFields 的降级分支：未登记字段记成 f<号> 键，既让「是不是空对象」
            // 判得准，也保证 (未识别) 帧能把原始字节摊出来。
            tlb_unk_t *u;
            uint64_t v = 0;
            const uint8_t *ptr = NULL;
            size_t plen = 0;
            size_t fixed = 0;
            if (out->n_unknown < TLB_UNK_MAX) {
                u = &out->unknown[out->n_unknown];
                memset(u, 0, sizeof(*u));
                u->field = f;
            } else {
                u = NULL;
            }
            if (w == TLB_WIRE_VARINT) {
                if (!tlb_rb_varint(&r, &v)) {
                    return false;
                }
            } else if (w == TLB_WIRE_LEN) {
                if (!tlb_rb_bytes(&r, &ptr, &plen)) {
                    return false;
                }
            } else if (w == TLB_WIRE_FIXED32 || w == TLB_WIRE_FIXED64) {
                // fixed 字段没有长度前缀，直接借出 4/8 字节再交给 skip 前进
                fixed = (w == TLB_WIRE_FIXED64) ? 8 : 4;
                if (tlb_rb_remaining(&r) < fixed || !tlb_rb_skip(&r, w)) {
                    return false;
                }
                ptr = r.p - fixed;
                plen = fixed;
            } else if (!tlb_rb_skip(&r, w)) {
                return false;
            }
            if (u) {
                if (w == TLB_WIRE_VARINT) {
                    u->is_varint = true;
                    u->value = v;
                } else {
                    u->bytes = ptr;
                    u->bytes_len = plen;
                }
                out->n_unknown++;
            }
            break;
        }
        }
    }
    return !r.failed;
}
