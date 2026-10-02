// components/tesla_core/src/tlb_dispatch.c
// 调度层实现：单帧判读 + 协议/应用终态 + session_info 握手 + 发一条 V3 请求的重发循环。
//
// 权威依据（逐字对齐，用户可见文案不许改写）：
//   探针 src/domain/command-dispatcher.js  —— decodeFrame / protoOutcome / appOutcome / sendRequest
//   探针 src/domain/handshake-service.js   —— handshakeOnce / handshake / applyPiggyback
//   探针 src/protocol/v3/{summary,handshake,codec}.js
//   探针 src/store/v3-session-store.js     —— invalidateV3Session 的文案与「不落盘」语义
//
// 栈预算（本机 gcc -O1 -fstack-usage 实测，含被内联的 static 子函数，供 id9 设备任务栈规划）：
//   tlb_send_request 6240B、tlb_handshake 5936B（tlb_handshake_once 已内联）、
//   tlb_decode_frame 5632B（apply_piggyback 已内联）、invalidate_session 992B
//   最深调用链 send_request → handshake ≈ 12.0KB，send_request → decode_frame ≈ 11.6KB，
//   加上调用方自身帧与 NimBLE 回调余量 —— 设备侧任务栈按 24KB 给（16KB 不够）。
//   收发/明文大缓冲一律走 tlb_dispatch_scratch_t（调用方持有，约 4.1KB），
//   tlb_send_request 的日志行借用 sc->tx，握手返回后它就没人要了。
#include <string.h>

#include "tesla_core/tlb_aes.h"
#include "tesla_core/tlb_dispatch.h"
#include "tesla_core/tlb_text.h"

// ---------------------------------------------------------------- 判读集合
// 探针 dispatch-policy.js：数值由 spec.js 的 MessageFault_E 实测确定
static const uint32_t RESYNC_FAULTS[] = {6, 15, 17, 26};
static const uint32_t RETRYABLE_FAULTS[] = {1, 2, 5, 6, 11, 15, 17, 20};
static const uint32_t MAY_HAVE_SUCCEEDED[] = {0, 25};

static bool in_set(const uint32_t *set, size_t n, uint32_t v)
{
    size_t i;
    for (i = 0; i < n; i++) {
        if (set[i] == v) {
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------- 文案构造器
// 全程不用 snprintf：可变长格式串在 -Wformat-truncation 下会告警，而这里的串全是拼出来的。
static const char HEXD[] = "0123456789abcdef";

typedef struct {
    char *buf;
    size_t cap;
    size_t len;
} tlb_sb_t;

static void tlb_sb_init(tlb_sb_t *sb, char *buf, size_t cap)
{
    sb->buf = buf;
    sb->cap = cap;
    sb->len = 0;
    if (cap > 0) {
        buf[0] = '\0';
    }
}

// 满了静默丢弃；sb->len 恒 <= cap-1，所以末尾写 '\0' 不会越界
static void sb_putn(tlb_sb_t *sb, const char *s, size_t n)
{
    size_t room;
    if (!sb->buf || sb->cap == 0 || n == 0) {
        return;
    }
    room = sb->cap - 1 - sb->len;
    if (room == 0) {
        return;
    }
    if (n > room) {
        n = room;
    }
    memcpy(sb->buf + sb->len, s, n);
    sb->len += n;
    sb->buf[sb->len] = '\0';
}

static void sb_put(tlb_sb_t *sb, const char *s)
{
    if (s) {
        sb_putn(sb, s, strlen(s));
    }
}

static void sb_char(tlb_sb_t *sb, char c) { sb_putn(sb, &c, 1); }

static void sb_u64(tlb_sb_t *sb, uint64_t v)
{
    char tmp[21];
    int i = 0;
    do {
        tmp[i++] = (char)('0' + (int)(v % 10));
        v /= 10;
    } while (v);
    while (i > 0) {
        sb_char(sb, tmp[--i]);
    }
}

static void sb_u32(tlb_sb_t *sb, uint32_t v) { sb_u64(sb, (uint64_t)v); }

static void sb_i64(tlb_sb_t *sb, int64_t v)
{
    if (v < 0) {
        sb_char(sb, '-');
        sb_u64(sb, (uint64_t)(-(v + 1)) + 1ULL);
    } else {
        sb_u64(sb, (uint64_t)v);
    }
}

static void sb_hex(tlb_sb_t *sb, const uint8_t *p, size_t n)
{
    size_t i;
    for (i = 0; i < n; i++) {
        sb_char(sb, HEXD[p[i] >> 4]);
        sb_char(sb, HEXD[p[i] & 15]);
    }
}

// JS 的 slice(0, max_cp) 按码点截：停在第 max_cp+1 个码点的首字节上
static void sb_putn_cp(tlb_sb_t *sb, const char *s, size_t max_cp)
{
    size_t i = 0;
    size_t cp = 0;
    if (!s) {
        return;
    }
    while (s[i] != '\0') {
        if (((unsigned char)s[i] & 0xC0) != 0x80) {
            if (cp >= max_cp) {
                break;
            }
            cp++;
        }
        i++;
    }
    sb_putn(sb, s, i);
}

// 最长枚举名（WHITELISTOPERATION_INFORMATION_ATTEMPTING_TO_ADD_KEY_THAT_IS_ALREADY_ON_THE_WHITELIST）
// 85 字节 + '(42)' 尾缀，192 足够
static void sb_label(tlb_sb_t *sb, const char *tbl, uint32_t v)
{
    char tmp[192];
    tlb_label(tbl, v, tmp, sizeof(tmp));
    sb_put(sb, tmp);
}

// label() 的 undefined 档：JS 里 value === undefined 才出 "(默认0)"，C 用显式的 present 位
static void sb_label_opt(tlb_sb_t *sb, const char *tbl, uint32_t v, bool present)
{
    char tmp[192];
    tlb_label_opt(tbl, v, present, tmp, sizeof(tmp));
    sb_put(sb, tmp);
}

static void sb_enum_label(tlb_sb_t *sb, const char *tbl, uint32_t v)
{
    char tmp[192];
    tlb_enum_label(tbl, v, tmp, sizeof(tmp));
    sb_put(sb, tmp);
}

// ---------------------------------------------------------------- 钩子包装
// 钩子为 NULL 时按「最保守」处理：没有时钟就当场作废，没有收发就报链路错误

static int64_t now_ms_of(const tlb_dispatch_ops_t *ops)
{
    if (ops->now_ms) {
        return ops->now_ms(ops->ud);
    }
    return -((int64_t)1 << 60);
}

static void dlog(const tlb_dispatch_ops_t *ops, const char *text)
{
    if (ops && ops->log && text) {
        ops->log(ops->ud, text);
    }
}

static void do_sleep(const tlb_dispatch_ops_t *ops, tlb_trace_t *tr, int64_t ms)
{
    if (tr) {
        if (tr->n_sleeps < TLB_DISPATCH_TRACE_MAX) {
            tr->sleeps[tr->n_sleeps] = ms;
        }
        tr->n_sleeps++;
    }
    if (ops->sleep_ms) {
        ops->sleep_ms(ops->ud, ms);
    }
}

static int do_receive(const tlb_dispatch_ops_t *ops, tlb_trace_t *tr, uint8_t *out, size_t cap,
                      int64_t ms)
{
    if (tr) {
        if (tr->n_receives < TLB_DISPATCH_TRACE_MAX) {
            tr->receives[tr->n_receives] = ms;
        }
        tr->n_receives++;
    }
    if (!ops->receive) {
        return -1;
    }
    return ops->receive(ops->ud, out, cap, ms);
}

// 探针 v3-session-store.js:invalidateV3Session
// 「只清 key/ready、counter 保留、不落盘」—— 所以绝不调用 session_stored；
// 而且只有原本真有共享密钥时才打这一行日志。
static void invalidate_session(tlb_v3_session_t *s, uint32_t domain, const char *why,
                               const tlb_dispatch_ops_t *ops)
{
    char buf[TLB_TEXT_MAX];
    tlb_sb_t sb;
    char who[128];

    if (!s->has_key) {
        return;
    }
    tlb_domain_text(domain, who, sizeof(who));
    tlb_sb_init(&sb, buf, sizeof(buf));
    sb_put(&sb, who);
    sb_put(&sb, " 共享密钥已作废");
    if (why && why[0] != '\0') {
        sb_put(&sb, "（");
        sb_put(&sb, why);
        sb_put(&sb, "）");
    }
    dlog(ops, buf);
    s->has_key = false;
    s->ready = false;
    if (ops->session_cleared) {
        ops->session_cleared(ops->ud, domain);
    }
}

// ---------------------------------------------------------------- 组包/解密错误文案
// tlb_v3_encrypt_command 只会返回 NO_KEY / PROTO / RANGE 三档
static const char *encrypt_err_text(tlb_err_t e)
{
    switch (e) {
    case TLB_ERR_NO_KEY:
        return "本机没有共享密钥，无法签署命令";
    case TLB_ERR_PROTO:
        return "会话参数不全（epoch / 公钥 / 时钟锚点缺失）";
    case TLB_ERR_RANGE:
        return "密文长度超过暂存区";
    default:
        return "加密失败";
    }
}

// tlb_v3_decrypt_response 先判 has_response_data 再判 has_key，返回码覆盖四档
static const char *decrypt_err_text(tlb_err_t e)
{
    switch (e) {
    case TLB_ERR_CRYPTO:
        return "响应 GCM tag 不符（元数据或密钥对不上）";
    case TLB_ERR_NO_KEY:
        return "本机没有共享密钥，无法解密响应";
    case TLB_ERR_PROTO:
        return "响应没有 AES_GCM_Response_data（车辆没启用响应加密）";
    case TLB_ERR_RANGE:
        return "响应长度超过暂存区";
    default:
        return "响应解密失败";
    }
}

// 注意：VIN 的大写归一在 tlb_v3_session_info_hmac / tlb_meta_build_* 内部已经用
// tlb_meta_upper_vin 做过，调度层**绝不能再预大写一遍**（否则双重归一虽无害，但白占栈）。

// ---------------------------------------------------------------- 文案渲染（公开）

// pb.js:inspect(V3_SPEC,'FromVCSECMessage',obj)
// 偏离（已核对）：
//   1) 按字段号升序渲染，而不是 JS 的「线上出现顺序」—— 单 oneof 报文里只会有一个已知字段，
//      差异只在同时带多个 sub_message 的病帧上出现，金标准不构造这种帧。
//   2) nominalError 里 genericError=0 与「空 nominalError」在 C 结构里无法区分，
//      这里只在非 0 时渲染内层，0 时渲染 nominalError{}。
//   3) vehicleStatus / whitelistInfo / whitelistEntryInfo 的内层字段本核心不解析，渲染成空对象。
void tlb_inspect_vcsec(const tlb_vcsec_t *obj, char *out, size_t cap)
{
    tlb_sb_t sb;
    bool first = true;
    size_t i;

    tlb_sb_init(&sb, out, cap);
    if (!obj) {
        return;
    }
#define SEP()                                                                                  \
    do {                                                                                       \
        if (first) {                                                                           \
            first = false;                                                                     \
        } else {                                                                               \
            sb_char(&sb, ' ');                                                                 \
        }                                                                                      \
    } while (0)

    if (obj->has_vehicle_status) {
        SEP();
        sb_put(&sb, "vehicleStatus{}");
    }
    if (obj->has_command_status) {
        SEP();
        sb_put(&sb, "commandStatus{");
        first = true;
        if (obj->has_operation_status) {
            SEP();
            sb_put(&sb, "operationStatus=");
            sb_enum_label(&sb, TLB_EN_VC_OP, obj->operation_status);
        }
        if (obj->has_signed_message_status) {
            SEP();
            sb_put(&sb, "signedMessageStatus{");
            first = true;
            if (obj->has_sm_counter) {
                SEP();
                sb_put(&sb, "counter=");
                sb_u32(&sb, obj->sm_counter);
            }
            if (obj->has_smi) {
                SEP();
                sb_put(&sb, "signedMessageInformation=");
                sb_enum_label(&sb, TLB_EN_SMI, obj->signed_message_information);
            }
            sb_char(&sb, '}');
        }
        if (obj->has_whitelist_status) {
            SEP();
            sb_put(&sb, "whitelistOperationStatus{");
            first = true;
            if (obj->has_wl_information) {
                SEP();
                sb_put(&sb, "whitelistOperationInformation=");
                sb_enum_label(&sb, TLB_EN_WL_INFO, obj->wl_information);
            }
            if (obj->has_wl_signer) {
                SEP();
                sb_put(&sb, "signerOfOperation{");
                if (obj->wl_signer != NULL && obj->wl_signer_len > 0) {
                    sb_put(&sb, "publicKeySHA1=");
                    sb_hex(&sb, obj->wl_signer, obj->wl_signer_len);
                }
                sb_char(&sb, '}');
            }
            if (obj->has_wl_operation_status) {
                SEP();
                sb_put(&sb, "operationStatus=");
                sb_enum_label(&sb, TLB_EN_VC_OP, obj->wl_operation_status);
            }
            sb_char(&sb, '}');
        }
        sb_char(&sb, '}');
    }
    if (obj->has_whitelist_info) {
        SEP();
        sb_put(&sb, "whitelistInfo{}");
    }
    if (obj->has_whitelist_entry_info) {
        SEP();
        sb_put(&sb, "whitelistEntryInfo{}");
    }
    if (obj->has_nominal_error) {
        SEP();
        sb_put(&sb, "nominalError{");
        if (obj->nominal_error != 0) {
            sb_put(&sb, "genericError=");
            sb_enum_label(&sb, TLB_EN_GENERIC, obj->nominal_error);
        }
        sb_char(&sb, '}');
    }
    for (i = 0; i < obj->n_unknown; i++) {
        const tlb_unk_t *u = &obj->unknown[i];
        SEP();
        sb_put(&sb, "f");
        sb_u32(&sb, u->field);
        sb_char(&sb, '=');
        if (u->is_varint) {
            // pb.js:mapFields 的降级：varint 直接写数字
            sb_u64(&sb, u->value);
        } else {
            // LEN 写成 "<hex>"，引号和尖括号都是原文里有的
            sb_char(&sb, '"');
            sb_char(&sb, '<');
            sb_hex(&sb, u->bytes, u->bytes_len);
            sb_char(&sb, '>');
            sb_char(&sb, '"');
        }
    }
#undef SEP
}

// summary.js:summarize(rm)
// 偏离：
//   1) tlb_rm_t 没有 session_info_request 字段，kind:'handshakeRequest' 分支不实现。
//   2) session_info(15) 在线上就是 bytes，JS 里 rm.session_info.status/.counter/.clock_time
//      恒为 undefined —— 探针永远输出固定那一串，所以这里不解码 session_info，直接照抄。
//   3) JS 用「payload 指针」判 payload=，C 用 has_payload（0 字节仍渲染 payload=0B）。
//   4) kind 判不出「只有 operation_status 没有 fault」的档（C 里 signed_message_fault
//      与 operation_status 都落到同一个 has_status 位）；该位只被 FAULT 分支消费，
//      与探针 protoOutcome 的入参一致，不影响判读。
tlb_proto_kind_t tlb_summarize_rm(const tlb_rm_t *rm, char *out, size_t cap)
{
    tlb_sb_t sb;
    bool sep = false;
    uint32_t fault;

    tlb_sb_init(&sb, out, cap);
    if (!rm) {
        sb_put(&sb, "(空)");
        return TLB_PROTO_NONE;
    }
    if (rm->has_session_info) {
        sb_put(&sb, "session_info ");
        sb_label(&sb, TLB_EN_SI_STATUS, 0);
        sb_put(&sb, " counter=0 clock_time=0 request_uuid=");
        if (rm->request_uuid != NULL) {
            sb_hex(&sb, rm->request_uuid, rm->request_uuid_len);
        } else {
            sb_put(&sb, "缺");
        }
        sb_put(&sb, " tag=");
        if (rm->sig.present && rm->sig.has_session_info_tag && rm->sig.session_info_tag != NULL) {
            sb_hex(&sb, rm->sig.session_info_tag, rm->sig.session_info_tag_len);
        } else {
            sb_put(&sb, "缺");
        }
        return TLB_PROTO_HS;
    }

    fault = rm->has_status ? rm->signed_message_fault : 0;
#define BIT()                                                                                  \
    do {                                                                                       \
        if (sep) {                                                                             \
            sb_char(&sb, ' ');                                                                 \
        } else {                                                                               \
            sb_put(&sb, "RoutableMessage ");                                                   \
        }                                                                                      \
        sep = true;                                                                            \
    } while (0)

    if (fault != 0) {
        BIT();
        sb_put(&sb, "fault=");
        sb_label(&sb, TLB_EN_FAULT, fault);
    }
    if (rm->flags != 0) {
        BIT();
        sb_put(&sb, "flags=");
        if (rm->flags & (1u << TLB_FLAG_USER_COMMAND)) {
            sb_put(&sb, "USER_COMMAND");
            if (rm->flags & (1u << TLB_FLAG_ENCRYPT_RESPONSE)) {
                sb_char(&sb, '|');
            }
        }
        if (rm->flags & (1u << TLB_FLAG_ENCRYPT_RESPONSE)) {
            sb_put(&sb, "ENCRYPT_RESPONSE");
        }
    }
    if (rm->has_payload) {
        BIT();
        sb_put(&sb, "payload=");
        sb_u64(&sb, (uint64_t)rm->payload_len);
        sb_put(&sb, "B");
    }
    if (rm->sig.has_response_data) {
        BIT();
        sb_put(&sb, "响应已加密 counter=");
        sb_u32(&sb, rm->sig.resp_has_counter ? rm->sig.resp_counter : 0);
    }
    if (rm->sig.has_gcm_personalized) {
        size_t n = rm->sig.gp_tag_len < 8 ? rm->sig.gp_tag_len : 8;
        BIT();
        sb_put(&sb, "请求 tag=");
        // 偏离：gp_tag 缺失（有 AES_GCM_Personalized_data 但没带 field5）时 JS 会抛异常，
        // 这里渲染空 hex 后照样加省略号
        if (rm->sig.gp_tag != NULL) {
            sb_hex(&sb, rm->sig.gp_tag, n);
        }
        sb_put(&sb, "…");
    }
    if (!sep) {
        sb_put(&sb, "RoutableMessage (无 payload)");
    }
#undef BIT
    return fault != 0 ? TLB_PROTO_FAULT : TLB_PROTO_MESSAGE;
}

// summary.js:summarizeVcsec(obj)
void tlb_summarize_vcsec(const tlb_vcsec_t *obj, tlb_app_t *out)
{
    tlb_sb_t sb;
    uint32_t st;

    memset(out, 0, sizeof(*out));
    tlb_sb_init(&sb, out->text, sizeof(out->text));
    if (!obj) {
        out->kind = TLB_APP_EMPTY;
        sb_put(&sb, "空响应（payload 为 0 字节 = 成功）");
        return;
    }
    if (obj->has_command_status) {
        st = obj->has_operation_status ? obj->operation_status : 0;
        if (obj->has_whitelist_status) {
            out->kind = TLB_APP_WHITELIST;
            out->status = obj->has_wl_operation_status ? obj->wl_operation_status : st;
            sb_put(&sb, "白名单操作 status=");
            sb_label_opt(&sb, TLB_EN_VC_OP, obj->wl_operation_status, obj->has_wl_operation_status);
            sb_put(&sb, " info=");
            sb_label_opt(&sb, TLB_EN_WL_INFO, obj->wl_information, obj->has_wl_information);
            sb_put(&sb, " 签署者=");
            // JS 的判据是 `w.signerOfOperation && w.signerOfOperation.publicKeySHA1`：
            // 0 字节的 bytes 在 JS 里仍是 truthy，所以照样渲染「签署者=」（后面没有 hex）
            if (obj->has_wl_signer && obj->wl_signer != NULL) {
                sb_hex(&sb, obj->wl_signer, obj->wl_signer_len);
            } else {
                sb_put(&sb, "-");
            }
            return;
        }
        if (obj->has_signed_message_status) {
            out->kind = TLB_APP_SIGNED;
            out->status = st;
            sb_put(&sb, "签名报文 status=");
            sb_label(&sb, TLB_EN_VC_OP, st);
            sb_put(&sb, " info=");
            sb_label_opt(&sb, TLB_EN_SMI, obj->signed_message_information, obj->has_smi);
            if (obj->has_sm_counter) {
                sb_put(&sb, " 车辆期望 counter=");
                sb_u32(&sb, obj->sm_counter);
                out->counter = obj->sm_counter;
                out->has_counter = true;
            }
            return;
        }
        out->kind = TLB_APP_COMMAND;
        out->status = st;
        sb_put(&sb, "status=");
        sb_label(&sb, TLB_EN_VC_OP, st);
        return;
    }
    if (obj->has_nominal_error) {
        out->kind = TLB_APP_ERROR;
        out->status = 2;
        sb_put(&sb, "nominalError ");
        sb_label(&sb, TLB_EN_GENERIC, obj->nominal_error);
        return;
    }
    if (obj->has_vehicle_status) {
        out->kind = TLB_APP_STATUS;
        // pb.js:inspect 对「空对象」返回空串（parts 为空、pad 为空），
        // 而本核心不解析 VehicleStatus 的内层字段，所以这里恒等于「车辆状态 」带一个尾空格。
        sb_put(&sb, "车辆状态 ");
        return;
    }
    // 偏离：本核心不解析 whitelistInfo / whitelistEntryInfo 的内层，
    // 下面两串是忠实复现 JS 对「空子消息」的取值结果（? / undefined / (默认0) / -）
    if (obj->has_whitelist_info) {
        out->kind = TLB_APP_OTHER;
        sb_put(&sb, "白名单条目数=? []");
        return;
    }
    if (obj->has_whitelist_entry_info) {
        out->kind = TLB_APP_OTHER;
        sb_put(&sb, "条目 slot=undefined role=(默认0) 公钥=-");
        return;
    }
    out->kind = TLB_APP_OTHER;
    sb_put(&sb, "(未识别) ");
    tlb_inspect_vcsec(obj, sb.buf ? sb.buf + sb.len : NULL, sb.cap - sb.len);
}

// ---------------------------------------------------------------- 终态判读

// command-dispatcher.js:protoOutcome —— 先看 fault，再看 operation_status
// text 出参：PASS 时是空串（JS 的 pass 分支不带 text），其余分支是「为什么」的原文。
tlb_action_t tlb_proto_outcome(uint32_t fault, uint32_t op_status, char *text, size_t cap)
{
    tlb_sb_t sb;

    tlb_sb_init(&sb, text, cap);
    if (fault != 0) {
        sb_label(&sb, TLB_EN_FAULT, fault);
        if (in_set(RESYNC_FAULTS, sizeof(RESYNC_FAULTS) / sizeof(RESYNC_FAULTS[0]), fault)) {
            return TLB_ACTION_RESYNC;
        }
        if (in_set(RETRYABLE_FAULTS, sizeof(RETRYABLE_FAULTS) / sizeof(RETRYABLE_FAULTS[0]), fault)) {
            return TLB_ACTION_BUSY;
        }
        return TLB_ACTION_FAIL;
    }
    if (op_status == TLB_OP_WAIT) {
        sb_put(&sb, "operation_status=WAIT");
        return TLB_ACTION_BUSY;
    }
    if (op_status == TLB_OP_ERROR) {
        sb_put(&sb, "operation_status=ERROR");
        return TLB_ACTION_FAIL;
    }
    return TLB_ACTION_PASS;
}

// command-dispatcher.js:appOutcome
// 偏离：INFOTAINMENT 域看的是 car_server.Response.actionStatus，本核心不解析该消息，
// 所以非 VCSEC 域一律 PASS（车机侧的错误只会体现在 raw 文本里）。
tlb_action_t tlb_app_outcome(const tlb_vcsec_t *obj, uint32_t domain, char *text, size_t cap)
{
    tlb_sb_t sb;
    uint32_t st;

    tlb_sb_init(&sb, text, cap);
    if (obj == NULL || domain != TLB_DOMAIN_VCSEC) {
        return TLB_ACTION_PASS;
    }
    if (obj->has_nominal_error) {
        sb_put(&sb, "nominalError ");
        sb_label(&sb, TLB_EN_GENERIC, obj->nominal_error);
        return TLB_ACTION_FAIL;
    }
    if (!obj->has_command_status) {
        return TLB_ACTION_PASS;
    }
    st = obj->has_operation_status ? obj->operation_status : 0;
    if (st == TLB_OP_WAIT) {
        sb_put(&sb, "commandStatus=WAIT");
        return TLB_ACTION_BUSY;
    }
    if (st == TLB_OP_ERROR) {
        if (obj->has_whitelist_status && obj->has_wl_information && obj->wl_information != 0) {
            sb_put(&sb, "白名单被拒：");
            sb_label(&sb, TLB_EN_WL_INFO, obj->wl_information);
            return TLB_ACTION_FAIL;
        }
        if (!obj->has_signed_message_status) {
            sb_put(&sb, "operationStatus=ERROR 且车辆没给原因");
            return TLB_ACTION_FAIL;
        }
    }
    return TLB_ACTION_PASS;
}

bool tlb_done_check(tlb_done_t kind, const tlb_vcsec_t *obj)
{
    if (kind == TLB_DONE_COMMAND) {
        return obj == NULL || !obj->has_command_status;
    }
    if (kind == TLB_DONE_WHITELIST) {
        return obj != NULL && obj->has_command_status && obj->has_whitelist_status;
    }
    return true;
}

void tlb_generic_error_hint_text(const char *text, char *out, size_t cap)
{
    tlb_sb_t sb;
    tlb_sb_init(&sb, out, cap);
    sb_put(&sb, tlb_generic_error_hint(text));
}

// ---------------------------------------------------------------- session_info 采纳
//
// 与 tlb_v3_apply_session_info 走的是同一套判据，但这里按探针 handshake.js 的**顺序**
// 逐步产生用户可见文案，并自己写会话（避免把 HMAC / decode 再跑一遍）。
// 返回 TLB_OK = 已采纳；非 0 时 msg 里有探针那句原文（code 只用于上层映射返回码，
// 探针本身不区分错误种类）。
static tlb_err_t apply_session_info(tlb_v3_session_t *s, const char *vin, const uint8_t *challenge,
                                   size_t challenge_len, const uint8_t *encoded, size_t encoded_len,
                                   const uint8_t *tag, size_t tag_len, int64_t now,
                                   tlb_v3_hs_info_t *info, char *msg, size_t cap)
{
    uint8_t expect[32];
    tlb_session_info_t si;
    uint32_t clock;
    uint32_t counter;
    uint32_t status;
    bool accept;
    size_t i;
    tlb_sb_t sb;

    tlb_sb_init(&sb, msg, cap);
    if (info) {
        memset(info, 0, sizeof(*info));
    }
    if (!s->has_key) {
        sb_put(&sb, "还没有共享密钥，无法校验握手");
        return TLB_ERR_NO_KEY;
    }
    if (encoded == NULL || encoded_len == 0) {
        sb_put(&sb, "响应里没有 session_info");
        return TLB_ERR_PROTO;
    }
    if (tag == NULL || tag_len == 0) {
        sb_put(&sb, "响应里没有 session_info_tag");
        return TLB_ERR_PROTO;
    }
    tlb_v3_session_info_hmac(s->key, vin, challenge, challenge_len, encoded, encoded_len, expect);
    // JS 的 equalBytes 先比长度；C 侧必须先自判长度，否则 const_equal 只比前 tag_len 字节
    if (tag_len != 32 || !tlb_const_equal(expect, tag, 32)) {
        sb_put(&sb, "session_info HMAC 校验不通过（握手 tag 不符：VIN 不对 / 密钥不同 / 握手包被"
                    "重放）\n  期望=");
        sb_hex(&sb, expect, 32);
        sb_put(&sb, "\n  实际=");
        sb_hex(&sb, tag, tag_len);
        return TLB_ERR_CRYPTO;
    }
    if (!tlb_msg_decode_session_info(encoded, encoded_len, &si)) {
        // 偏离：JS 抛的是 pb.js 的具体报错，C 拿不到 e.message，统一成固定串
        sb_put(&sb, "session_info 不是合法 protobuf: pb: 解码失败");
        return TLB_ERR_PROTO;
    }
    if (si.public_key_len != TLB_PUB_LEN ||
        (si.public_key != NULL && si.public_key[0] != 0x04)) {
        // 探针这一处的形状是「无 0x 前缀」，且 pk 存在但 0 字节时首字节是 undefined
        sb_put(&sb, "session_info.publicKey 格式意外（");
        if (si.public_key != NULL) {
            sb_u64(&sb, (uint64_t)si.public_key_len);
            sb_put(&sb, "B 首字节 ");
            if (si.public_key_len > 0) {
                sb_u32(&sb, si.public_key[0]);
            } else {
                sb_put(&sb, "undefined");
            }
        } else {
            sb_put(&sb, "缺失");
        }
        sb_put(&sb, "）");
        return TLB_ERR_PROTO;
    }
    if (si.epoch_len != TLB_ADDR_LEN) {
        sb_put(&sb, "session_info.epoch 长度应为 16，实际 ");
        sb_u64(&sb, (uint64_t)si.epoch_len);
        return TLB_ERR_PROTO;
    }
    clock = si.has_clock_time ? si.clock_time : 0;
    counter = si.has_counter ? si.counter : 0;
    status = si.has_status ? si.status : 0;

    // signer.go UpdateSessionInfo：epoch 变了，或车辆时钟没倒退，才接受新的会话参数
    accept = s->epoch_len != TLB_ADDR_LEN;
    if (!accept) {
        accept = true;
        for (i = 0; i < TLB_ADDR_LEN; i++) {
            if (s->epoch[i] != si.epoch[i]) {
                break;
            }
        }
        if (i == TLB_ADDR_LEN) {
            accept = !s->has_set_time || (s->set_time <= clock);
        }
    }
    if (!accept) {
        sb_put(&sb, "同一 epoch 且车辆时钟倒退（setTime=");
        sb_u32(&sb, s->set_time);
        sb_put(&sb, " > clock_time=");
        sb_u32(&sb, clock);
        sb_put(&sb, "），忽略本次握手");
        return TLB_ERR_STATE;
    }

    memcpy(s->epoch, si.epoch, TLB_ADDR_LEN);
    s->epoch_len = TLB_ADDR_LEN;
    memcpy(s->vehicle_pub, si.public_key, TLB_PUB_LEN);
    s->vehicle_pub_len = TLB_PUB_LEN;
    s->clock_time = clock;
    s->has_set_time = true;
    s->set_time = clock;
    s->has_anchor = true;
    s->anchor = now - (int64_t)clock;
    s->counter = counter > s->counter ? counter : s->counter;
    s->ready = (status == 0);
    if (info) {
        info->counter = s->counter;
        info->clock_time = clock;
        info->status = status;
        info->key_not_whitelisted = (status == TLB_SI_STATUS_KEY_NOT_ON_WHITELIST);
    }
    sb_put(&sb, "counter=");
    sb_u32(&sb, counter);
    sb_put(&sb, " clock_time=");
    sb_u32(&sb, clock);
    sb_put(&sb, " epoch=");
    sb_hex(&sb, si.epoch, TLB_ADDR_LEN);
    sb_put(&sb, " 车辆公钥=");
    sb_hex(&sb, si.public_key, 8); // JS：toHex(pk).slice(0, 16) == 前 8 字节
    sb_put(&sb, "… anchor(本地秒-clock)=");
    sb_i64(&sb, s->anchor);
    return TLB_OK;
}

// handshake-service.js:applyPiggyback —— 官方 checkForSessionUpdate 的三道闸
static void apply_piggyback(const tlb_rm_t *rm, const tlb_frame_ctx_t *ctx)
{
    char buf[TLB_TEXT_MAX];
    char logbuf[TLB_RESULT_TEXT_MAX];
    tlb_v3_hs_info_t info;
    tlb_sb_t sb;
    const uint8_t *tag;
    size_t tag_len;
    tlb_err_t e;

    if (ctx->session == NULL || !ctx->session->has_key) {
        dlog(ctx->ops, "响应带 session_info，但本机还没有共享密钥，按官方规则忽略");
        return;
    }
    if (now_ms_of(ctx->ops) - ctx->sent_at_ms > TLB_MAX_LATENCY_MS) {
        tlb_sb_init(&sb, logbuf, sizeof(logbuf));
        sb_put(&sb, "响应带 session_info，但距请求发出已超过 ");
        sb_i64(&sb, TLB_MAX_LATENCY_MS);
        sb_put(&sb, "ms，丢弃");
        dlog(ctx->ops, logbuf);
        return;
    }
    // 偏离（等价式）：sd.session_info_tag ? sd.session_info_tag.tag : null
    tag = (rm->sig.present && rm->sig.has_session_info_tag && rm->sig.session_info_tag != NULL)
              ? rm->sig.session_info_tag
              : NULL;
    tag_len = tag != NULL ? rm->sig.session_info_tag_len : 0;
    e = apply_session_info(ctx->session, ctx->vin, rm->request_uuid, rm->request_uuid_len,
                           rm->session_info, rm->session_info_len, tag, tag_len,
                           now_ms_of(ctx->ops) / 1000, &info, buf, sizeof(buf));
    if (e == TLB_OK) {
        if (ctx->ops->session_stored) {
            ctx->ops->session_stored(ctx->ops->ud, ctx->domain);
        }
        tlb_sb_init(&sb, logbuf, sizeof(logbuf));
        sb_put(&sb, "顺手刷新会话：");
        sb_put(&sb, buf);
        dlog(ctx->ops, logbuf);
    } else {
        tlb_sb_init(&sb, logbuf, sizeof(logbuf));
        sb_put(&sb, "响应里的 session_info 未采用：");
        sb_put(&sb, buf);
        dlog(ctx->ops, logbuf);
    }
}

// ---------------------------------------------------------------- 单帧判读
//
// 偏离（已核对，均为纯日志行或结构体无法承载的差异）：
//   1) tlb_frame_out_t 没有 hint 字段：这里把 refused 记下来，由 sendRequest 用
//      tlb_fault_hint(fault) 复现 r.hint。
//   2) JS 的 parseFrame 判 routable 用「键名有不以 f 开头的」，而 from_destination / flags
//      恰好也以 f 开头 —— 只带这两个字段的帧在 JS 里算裸帧、在 C 里算 routable。
//      保留 C 的 known > 0 判据，金标准不构造这种帧。
//   3) 非 VCSEC 域的应用层解码（car_server.Response）本核心不做：payload 为空时照抄
//      codec.js 那句「(空 payload = 车机已受理)」，非空则 obj/text 留空走 empty 分支。
//   4) JS 的 decryptResponse 在「本机没有密钥」时抛异常走「响应解析失败」；
//      C 返回 TLB_ERR_NO_KEY，因此落进「响应解密失败：<本机没有共享密钥…>」。
//   5) d.error + d.detail 两行诊断合并成一行（核心不做逐字段试算）。
//   6) JS 的「响应解析失败」带 pb.js 的抛错原文（pb: varint 读取越界 / pb: length 字段越界 /
//      pb: 不支持的 wire type 3 …），C 统一成 `pb: 解码失败`。金标准不构造该类帧。
//   7) JS 在没有会话时会直接 TypeError（解引用 opts.session），C 显式返回 TLB_ERR_NO_KEY
//      走「响应解密失败：<本机没有共享密钥…>」；见解密分支里的 NULL 保护。
void tlb_decode_frame(const uint8_t *body, size_t body_len, const tlb_frame_ctx_t *ctx,
                      tlb_dispatch_scratch_t *sc, tlb_frame_out_t *out)
{
    tlb_rm_t rm;
    tlb_vcsec_t obj;
    tlb_sb_t sb;
    bool routable = false;
    bool bare = false;
    bool decrypted = false;
    uint32_t fault;
    uint32_t op_status;
    uint32_t dcounter = 0;
    const uint8_t *theirs;
    const uint8_t *plain;
    size_t plain_len = 0;
    tlb_err_t e;
    char proto[TLB_FRAME_TEXT_MAX];
    char whytext[192];
    char line[TLB_RESULT_TEXT_MAX];
    char da[128];
    char db[128];

    memset(out, 0, sizeof(*out));
    memset(&obj, 0, sizeof(obj));
    memset(&rm, 0, sizeof(rm));

    routable = (body != NULL && tlb_msg_decode_rm(body, body_len, &rm) && rm.known > 0);
    if (!routable) {
        memset(&rm, 0, sizeof(rm));
        // JS 对空 buffer 解 FromVCSECMessage 不抛异常、返回 {}，所以 0 字节 = 裸帧成功零字段
        bare = (body != NULL && (body_len == 0 || tlb_msg_decode_from_vcsec(body, body_len, &obj)));
        if (!bare) {
            memset(&obj, 0, sizeof(obj));
        }
    }

    if (!routable) {
        // decodeFrame L27-31：裸帧就是本次请求的正解，**不置 skipped**，fault/opStatus 恒 0
        tlb_summarize_vcsec(&obj, &out->app);
        if (bare) {
            tlb_inspect_vcsec(&obj, out->text, sizeof(out->text));
        } else {
            tlb_sb_init(&sb, out->text, sizeof(out->text));
            sb_put(&sb, "(两种规格都解不出来) ");
            sb_hex(&sb, body, body_len);
        }
        tlb_sb_init(&sb, line, sizeof(line));
        sb_put(&sb, ctx->name);
        sb_put(&sb, " 裸 ");
        sb_put(&sb, (ctx->domain == TLB_DOMAIN_VCSEC) ? "VCSEC" : "CAR_SERVER");
        sb_put(&sb, " 帧：");
        sb_put(&sb, out->app.text);
        sb_char(&sb, '\n');
        sb_put(&sb, out->text);
        dlog(ctx->ops, line);
        return;
    }

    // ---- 三道配对闸门（官方 receiverKey = {domain, address, uuid}，只在线索真存在时否决）
    theirs = rm.to_routing_address;
    if (ctx->routing_address != NULL && theirs != NULL &&
        rm.to_routing_address_len == TLB_ADDR_LEN &&
        !tlb_const_equal(theirs, ctx->routing_address, TLB_ADDR_LEN)) {
        tlb_sb_init(&sb, out->text, sizeof(out->text));
        sb_put(&sb, "串台帧：路由地址 ");
        sb_hex(&sb, theirs, rm.to_routing_address_len);
        sb_put(&sb, " 不是本次请求");
        tlb_sb_init(&sb, line, sizeof(line));
        sb_put(&sb, ctx->name);
        sb_put(&sb, " 帧的路由地址不是本次请求（本帧 ");
        sb_hex(&sb, theirs, rm.to_routing_address_len);
        sb_put(&sb, "，本次 ");
        sb_hex(&sb, ctx->routing_address, TLB_ADDR_LEN);
        sb_put(&sb, "），按官方丢掉不解密");
        dlog(ctx->ops, line);
        out->skipped = true;
        out->skip = TLB_SKIP_ADDR;
        return;
    }
    if (ctx->uuid != NULL && rm.request_uuid != NULL && rm.request_uuid_len > 0 &&
        !(rm.request_uuid_len == TLB_ADDR_LEN &&
          tlb_const_equal(rm.request_uuid, ctx->uuid, TLB_ADDR_LEN))) {
        tlb_sb_init(&sb, out->text, sizeof(out->text));
        sb_put(&sb, "串台帧：request_uuid ");
        sb_hex(&sb, rm.request_uuid, rm.request_uuid_len);
        sb_put(&sb, " 不是本次请求");
        tlb_sb_init(&sb, line, sizeof(line));
        sb_put(&sb, ctx->name);
        sb_put(&sb, " 帧的 request_uuid 不是本次请求（本帧 ");
        sb_hex(&sb, rm.request_uuid, rm.request_uuid_len);
        sb_put(&sb, "，本次 ");
        sb_hex(&sb, ctx->uuid, TLB_ADDR_LEN);
        sb_put(&sb, "），按官方丢掉不解密");
        dlog(ctx->ops, line);
        out->skipped = true;
        out->skip = TLB_SKIP_UUID;
        return;
    }
    if (ctx->domain != 0u && rm.has_from_domain && rm.from_domain != ctx->domain) {
        tlb_domain_text(rm.from_domain, da, sizeof(da));
        tlb_domain_text(ctx->domain, db, sizeof(db));
        tlb_sb_init(&sb, out->text, sizeof(out->text));
        sb_put(&sb, "串台帧：来自 ");
        sb_put(&sb, da);
        sb_put(&sb, "，不是本次请求的 ");
        sb_put(&sb, db);
        tlb_sb_init(&sb, line, sizeof(line));
        sb_put(&sb, ctx->name);
        sb_put(&sb, " 帧来自 ");
        sb_put(&sb, da);
        sb_put(&sb, "，本次请求发往 ");
        sb_put(&sb, db);
        sb_put(&sb, "，按官方丢掉不解密");
        dlog(ctx->ops, line);
        out->skipped = true;
        out->skip = TLB_SKIP_DOMAIN;
        return;
    }

    fault = rm.has_status ? rm.signed_message_fault : 0;
    op_status = rm.has_status ? rm.operation_status : 0;
    (void)tlb_summarize_rm(&rm, proto, sizeof(proto));
    tlb_sb_init(&sb, line, sizeof(line));
    sb_put(&sb, ctx->name);
    sb_put(&sb, " 协议层：");
    sb_put(&sb, proto);
    dlog(ctx->ops, line);
    if (rm.has_session_info) {
        apply_piggyback(&rm, ctx);
    }

    // ---- 协议层错误帧：车辆已经给了终态结论，而且一个密文字节都没发
    if ((fault != 0 || op_status == TLB_OP_ERROR) && rm.sig.has_response_data &&
        !(rm.has_payload && rm.payload_len > 0)) {
        const char *hint = tlb_fault_hint(fault);
        (void)tlb_proto_outcome(fault, op_status, whytext, sizeof(whytext));
        out->refused = true;
        out->fault = fault;
        out->op_status = op_status;
        out->app.kind = TLB_APP_REFUSED;
        out->app.status = 2;
        tlb_sb_init(&sb, out->app.text, sizeof(out->app.text));
        sb_put(&sb, "车辆拒绝返回响应体：");
        sb_put(&sb, whytext);
        if (hint != NULL && hint[0] != '\0') {
            sb_put(&sb, "。");
            sb_put(&sb, hint);
        }
        tlb_sb_init(&sb, out->text, sizeof(out->text));
        sb_put(&sb, whytext);
        tlb_sb_init(&sb, line, sizeof(line));
        sb_put(&sb, ctx->name);
        sb_put(&sb, " 车辆回的是协议层错误帧（没有响应体），不再拿它试解密：");
        sb_put(&sb, whytext);
        dlog(ctx->ops, line);
        return;
    }

    out->fault = fault;
    out->op_status = op_status;

    if (rm.sig.has_response_data) {
        // 偏离 7：JS 的 decryptResponse 直接解引用 opts.session，无会话时抛异常走「响应解析失败」；
        // C 在这里显式认作 TLB_ERR_NO_KEY，与 tlb_v3_decrypt_response 内部的 has_key 判据同义。
        e = (ctx->session == NULL)
                ? TLB_ERR_NO_KEY
                : tlb_v3_decrypt_response(ctx->session, &rm, ctx->vin, ctx->request_id,
                                          ctx->request_id_len, sc->clear, sizeof(sc->clear),
                                          &plain_len, &dcounter);
        if (e != TLB_OK) {
            tlb_sb_init(&sb, line, sizeof(line));
            sb_put(&sb, ctx->name);
            sb_put(&sb, " 响应解密诊断：");
            sb_put(&sb, decrypt_err_text(e));
            dlog(ctx->ops, line); // 偏离 5：JS 的 d.detail 逐字段试算不产出
            tlb_sb_init(&sb, out->text, sizeof(out->text));
            sb_put(&sb, ctx->name);
            sb_put(&sb, " 响应解密失败：");
            sb_put(&sb, decrypt_err_text(e));
            sb_put(&sb, "（本帧 ");
            sb_u64(&sb, (uint64_t)body_len);
            sb_put(&sb, "B，request_uuid=");
            if (rm.request_uuid != NULL) {
                sb_hex(&sb, rm.request_uuid, rm.request_uuid_len);
            } else {
                sb_put(&sb, "无");
            }
            sb_put(&sb, "，to=");
            sb_put(&sb, (rm.to_routing_address != NULL) ? "有" : "无");
            sb_put(&sb, "，from=");
            if (rm.has_from_domain) {
                tlb_domain_text(rm.from_domain, da, sizeof(da));
                sb_put(&sb, da);
            } else {
                sb_put(&sb, "无");
            }
            sb_put(&sb, "）");
            out->skipped = true;
            out->skip = TLB_SKIP_DECRYPT;
            return;
        }
        decrypted = true;
        plain = sc->clear;
    } else {
        plain = rm.payload;
        plain_len = rm.has_payload ? rm.payload_len : 0;
    }

    // codec.decode：空载荷先回固定串，VCSEC 域再试 protobuf
    if (plain_len == 0) {
        tlb_sb_init(&sb, out->text, sizeof(out->text));
        sb_put(&sb, (ctx->domain == TLB_DOMAIN_VCSEC) ? "(空 payload = 命令已受理)"
                                                      : "(空 payload = 车机已受理)");
    } else if (ctx->domain != TLB_DOMAIN_VCSEC) {
        tlb_sb_init(&sb, out->text, sizeof(out->text));
    } else if (!tlb_msg_decode_from_vcsec(plain, plain_len, &obj)) {
        tlb_sb_init(&sb, out->text, sizeof(out->text));
        sb_put(&sb, ctx->name);
        sb_put(&sb, " 响应解析失败：pb: 解码失败");
        out->skipped = true;
        out->skip = TLB_SKIP_PARSE;
        return;
    } else {
        tlb_inspect_vcsec(&obj, out->text, sizeof(out->text));
    }

    tlb_sb_init(&sb, line, sizeof(line));
    sb_put(&sb, ctx->name);
    if (decrypted) {
        sb_put(&sb, " 解密后（车辆 counter=");
        sb_u32(&sb, dcounter);
        sb_put(&sb, "):\n");
    } else {
        sb_put(&sb, " 应用层:\n");
    }
    sb_put(&sb, out->text);
    dlog(ctx->ops, line);

    memcpy(&out->obj, &obj, sizeof(out->obj));
    if (obj.known == 0 && obj.n_unknown == 0) {
        out->app.kind = TLB_APP_EMPTY;
        out->app.status = 0;
        tlb_sb_init(&sb, out->app.text, sizeof(out->app.text));
        sb_put(&sb, "空响应（车辆已受理，应用层没有任何字段）");
    } else {
        tlb_summarize_vcsec(&obj, &out->app);
    }
}

// ========================================================================
//  握手与发送
// ========================================================================

// codec.js:parseFrame —— 握手路径需要「先分类再拿 rm」。
// 与 tlb_decode_frame 里内联的是同一套判据，改一处必须同步改另一处。
#define TLB_PF_ROUTABLE 0
#define TLB_PF_VCSEC 1
#define TLB_PF_GARBAGE 2

static int parse_frame(const uint8_t *body, size_t body_len, tlb_rm_t *rm, tlb_vcsec_t *obj,
                       char *text, size_t cap)
{
    tlb_sb_t sb;

    memset(rm, 0, sizeof(*rm));
    memset(obj, 0, sizeof(*obj));
    tlb_sb_init(&sb, text, cap);
    if (body != NULL && tlb_msg_decode_rm(body, body_len, rm) && rm->known > 0) {
        // 偏离：探针这里是 inspect(RoutableMessage)，本核心没有 RM 渲染器；
        // 握手路径只用 text 拼「响应不是 RoutableMessage：…」，routable 时不取用。
        return TLB_PF_ROUTABLE;
    }
    memset(rm, 0, sizeof(*rm));
    if (body != NULL && (body_len == 0 || tlb_msg_decode_from_vcsec(body, body_len, obj))) {
        tlb_inspect_vcsec(obj, text, cap);
        return TLB_PF_VCSEC;
    }
    memset(obj, 0, sizeof(*obj));
    sb_put(&sb, "(两种规格都解不出来) ");
    sb_hex(&sb, body, body_len);
    return TLB_PF_GARBAGE;
}

// ble().receive(Math.max(500, Math.min(3000, deadline - Date.now())))
static int64_t slice_ms(int64_t deadline, int64_t now)
{
    int64_t left = deadline - now;
    if (left > 3000) {
        left = 3000;
    }
    if (left < 500) {
        left = 500;
    }
    return left;
}

// sendRequest 的 dropText()。JS 里 dropFirst / dropLast 都是字符串：
//   if (!dropFirst) dropFirst = r.text;   dropLast = r.text;
//   dropLast && dropLast !== dropFirst ? ' ‖ 最后一帧：' + dropLast : ''
// 比的是**文案内容**，不是「丢了几片」——两片文案一模一样时探针不加后半句。
static void sb_drop_text(tlb_sb_t *sb, int dropped, const char *first, const char *last)
{
    sb_put(sb, "已丢弃 ");
    sb_u64(sb, (uint64_t)dropped);
    sb_put(sb, " 帧：");
    sb_put(sb, first);
    if (last[0] != '\0' && strcmp(last, first) != 0) {
        sb_put(sb, " ‖ 最后一帧：");
        sb_put(sb, last);
    }
}

// handshake-service.js:handshakeOnce —— 一次 session_info 握手。
// K 从「响应里带的车辆公钥」现算，所以必须先解出 session_info 再验它的 HMAC。
// 成功返回 TLB_OK，msg = 探针 applied.text；失败返回对应错误码，msg = 探针那句 error 原文。
tlb_err_t tlb_handshake_once(const char *vin, tlb_v3_session_t *s, uint32_t domain,
                             const tlb_dispatch_ops_t *ops, tlb_dispatch_scratch_t *sc,
                             bool *fatal, bool *not_whitelisted, char *msg, size_t cap)
{
    uint8_t uuid[TLB_ADDR_LEN];
    uint8_t addr[TLB_ADDR_LEN];
    uint8_t key[TLB_KEY_LEN];
    const uint8_t *tag;
    const uint8_t *pk;
    const uint8_t *ch;
    size_t chn;
    size_t n;
    int rc;
    int kind;
    uint32_t status;
    tlb_rm_t rm;
    tlb_vcsec_t obj;
    tlb_session_info_t si;
    tlb_v3_hs_info_t info;
    char text[TLB_FRAME_TEXT_MAX];
    char brief[TLB_FRAME_TEXT_MAX];
    char who[128];
    char line[TLB_RESULT_TEXT_MAX];
    tlb_sb_t sb;
    tlb_err_t e;

    *fatal = false;
    *not_whitelisted = false;
    msg[0] = '\0';

    tlb_port_random(uuid, sizeof(uuid));
    tlb_port_random(addr, sizeof(addr));
    n = tlb_msg_encode_handshake_request(domain, addr, ops->signer_pub, uuid, sc->tx,
                                        sizeof(sc->tx));
    if (n == 0) {
        // 偏离：探针的 encode 抛异常会一路逃出 handshake()/sendRequest()，这里判成一次可重试的失败
        tlb_sb_init(&sb, msg, cap);
        sb_put(&sb, "session_info_request 组包失败：pb: 编码失败");
        return TLB_ERR_PROTO;
    }
    tlb_domain_text(domain, who, sizeof(who));
    tlb_sb_init(&sb, line, sizeof(line));
    sb_put(&sb, "V3 握手 session_info_request（");
    sb_put(&sb, who);
    sb_put(&sb, "，明文，uuid=");
    sb_hex(&sb, uuid, sizeof(uuid));
    sb_put(&sb, "）\n");
    sb_hex(&sb, sc->tx, n); // 偏离：探针第二行是 inspect(RoutableMessage)，纯日志行按整帧 hex 给
    dlog(ops, line);

    if (!ops->exchange) {
        tlb_sb_init(&sb, msg, cap);
        sb_put(&sb, "BLE 发送失败：链路错误");
        return TLB_ERR_LINK;
    }
    rc = ops->exchange(ops->ud, sc->tx, n, TLB_FIRST_RESPONSE_MS, true, sc->rx, sizeof(sc->rx));
    if (rc < 0) {
        // 偏离：探针的 ble().send 抛异常同样逃出 handshake()，这里收成一帧可判读的失败
        tlb_sb_init(&sb, msg, cap);
        sb_put(&sb, "BLE 发送失败：链路错误");
        return TLB_ERR_LINK;
    }
    if (rc == 0) {
        // 探针原文的怪癖照抄：FIRST_RESPONSE_MS 是毫秒，拼进「秒」的文案里仍是 8000
        tlb_sb_init(&sb, msg, cap);
        sb_u64(&sb, (uint64_t)TLB_FIRST_RESPONSE_MS);
        sb_put(&sb, " 秒内没有响应（车辆休眠 / 没订阅成功）");
        return TLB_ERR_TIMEOUT;
    }

    kind = parse_frame(sc->rx, (size_t)rc, &rm, &obj, text, sizeof(text));
    if (kind != TLB_PF_ROUTABLE) {
        tlb_sb_init(&sb, msg, cap);
        sb_put(&sb, "响应不是 RoutableMessage：");
        sb_putn_cp(&sb, text, 120);
        return TLB_ERR_PROTO;
    }
    (void)tlb_summarize_rm(&rm, brief, sizeof(brief));
    tlb_sb_init(&sb, line, sizeof(line));
    sb_put(&sb, "握手响应：");
    sb_put(&sb, brief); // 偏离：探针再拼一行 inspect(RoutableMessage)，本核心没有该渲染器
    dlog(ops, line);

    if (!rm.has_session_info || rm.session_info_len == 0) {
        tlb_sb_init(&sb, msg, cap);
        sb_put(&sb, "响应里没有 session_info（");
        sb_put(&sb, brief);
        sb_put(&sb, "）");
        return TLB_ERR_PROTO;
    }
    if (!tlb_msg_decode_session_info(rm.session_info, rm.session_info_len, &si)) {
        tlb_sb_init(&sb, msg, cap);
        sb_put(&sb, "session_info 解不开：pb: 解码失败");
        return TLB_ERR_PROTO;
    }
    status = si.has_status ? si.status : 0;
    if (status != 0) {
        tlb_sb_init(&sb, msg, cap);
        sb_put(&sb, "车辆拒绝建立会话：");
        sb_label(&sb, TLB_EN_SI_STATUS, status);
        if (status == TLB_SI_STATUS_KEY_NOT_ON_WHITELIST) {
            sb_put(&sb, " —— 这把钥匙还没进白名单。先按「③ 绑定（刷钥匙卡）」，踩一脚刹车唤醒车机，");
            sb_put(&sb, tlb_tap_hint());
            *not_whitelisted = true;
        }
        *fatal = true; // 确定性拒绝，重试没有意义
        return *not_whitelisted ? TLB_ERR_NOT_PAIRED : TLB_ERR_DENIED;
    }
    // 偏离（等价式）：sd.session_info_tag ? sd.session_info_tag.tag : null
    tag = (rm.sig.present && rm.sig.has_session_info_tag && rm.sig.session_info_tag != NULL)
              ? rm.sig.session_info_tag
              : NULL;
    if (tag == NULL) {
        tlb_sb_init(&sb, msg, cap);
        sb_put(&sb, "响应没有 session_info_tag（官方会当成 unauthenticated 直接丢弃）");
        return TLB_ERR_PROTO;
    }
    pk = si.public_key;
    if (pk == NULL || si.public_key_len != TLB_PUB_LEN || pk[0] != 0x04) {
        tlb_sb_init(&sb, msg, cap);
        sb_put(&sb, "session_info.publicKey 格式意外（");
        if (pk != NULL) {
            // 探针这一处带 0x 前缀但按十进制拼 pk[0]，且 0 字节时是 undefined（与 applySessionInfo 不同）
            sb_u64(&sb, (uint64_t)si.public_key_len);
            sb_put(&sb, "B 首字节 0x");
            if (si.public_key_len > 0) {
                sb_u32(&sb, pk[0]);
            } else {
                sb_put(&sb, "undefined");
            }
        } else {
            sb_put(&sb, "缺失");
        }
        sb_put(&sb, "）");
        return TLB_ERR_PROTO;
    }
    if (!ops->signer_priv || !tlb_v3_derive_key(ops->signer_priv, pk, key)) {
        // 偏离：C 拿不到 e.message，取 p256.js 在这条路径上唯一可能的原文
        tlb_sb_init(&sb, msg, cap);
        sb_put(&sb, "ECDH 失败：对端公钥不在 P-256 曲线上（可能不是未压缩格式）");
        return TLB_ERR_CRYPTO;
    }
    memcpy(s->key, key, sizeof(key));
    s->has_key = true;

    // challenge = 车辆回显的 request_uuid；不带时用我们自己发的 uuid 兜底
    // （JS 的 `rm.request_uuid || uuid`：空数组同样 truthy，所以判据只看指针）
    ch = (rm.request_uuid != NULL) ? rm.request_uuid : uuid;
    chn = (rm.request_uuid != NULL) ? rm.request_uuid_len : TLB_ADDR_LEN;
    e = apply_session_info(s, vin, ch, chn, rm.session_info, rm.session_info_len, tag,
                           rm.sig.session_info_tag_len, now_ms_of(ops) / 1000, &info, msg, cap);
    if (e != TLB_OK) {
        s->has_key = false; // JS：session.key = null（ready 不动）
        return e;
    }
    *not_whitelisted = info.key_not_whitelisted;
    return TLB_OK;
}

// handshake-service.js:handshake
tlb_err_t tlb_handshake(bool force, uint32_t domain, const char *vin, tlb_v3_session_t *session,
                        const tlb_dispatch_ops_t *ops, tlb_dispatch_scratch_t *sc,
                        tlb_trace_t *trace, tlb_handshake_result_t *res)
{
    char msg[TLB_TEXT_MAX];
    char line[TLB_RESULT_TEXT_MAX];
    char who[128];
    tlb_sb_t sb;
    bool fatal = false;
    bool not_wl = false;
    tlb_err_t e = TLB_ERR_PROTO;
    int i;

    memset(res, 0, sizeof(*res));
    msg[0] = '\0';
    if (!ops->connected || !ops->connected(ops->ud)) {
        tlb_sb_init(&sb, res->text, sizeof(res->text));
        sb_put(&sb, "还没连上车辆，先按「扫描并连接」");
        return TLB_ERR_LINK;
    }
    if (!ops->has_key || !ops->has_key(ops->ud)) {
        tlb_sb_init(&sb, res->text, sizeof(res->text));
        sb_put(&sb, "还没有密钥，先做绑定");
        return TLB_ERR_NO_KEY;
    }
    if (vin == NULL || vin[0] == '\0') {
        tlb_sb_init(&sb, res->text, sizeof(res->text));
        sb_put(&sb, "VIN 为空，先在首页填 VIN 再连接");
        return TLB_ERR_STATE;
    }
    tlb_domain_text(domain, who, sizeof(who));
    if (!force && session->ready && session->has_key && session->epoch_len > 0 &&
        session->has_anchor) {
        res->ok = true;
        res->reused = true;
        tlb_sb_init(&sb, res->text, sizeof(res->text));
        sb_put(&sb, "复用 ");
        sb_put(&sb, who);
        sb_put(&sb, " 会话（counter=");
        sb_u32(&sb, session->counter);
        sb_put(&sb, "）");
        return TLB_OK;
    }

    for (i = 1; i <= 2; i++) {
        if (trace) {
            trace->n_handshakes++;
        }
        e = tlb_handshake_once(vin, session, domain, ops, sc, &fatal, &not_wl, msg, sizeof(msg));
        if (e == TLB_OK) {
            if (ops->session_stored) {
                ops->session_stored(ops->ud, domain);
            }
            tlb_sb_init(&sb, line, sizeof(line));
            sb_put(&sb, who);
            sb_put(&sb, " 握手成功 ");
            sb_put(&sb, msg);
            dlog(ops, line);
            if (not_wl) {
                dlog(ops, "车辆回了 KEY_NOT_ON_WHITELIST：这把钥匙还没进白名单，先做绑定再发命令");
                res->not_whitelisted = true;
                tlb_sb_init(&sb, res->text, sizeof(res->text));
                sb_put(&sb, "握手通过，但车辆说这把钥匙不在白名单里（先刷卡绑定）");
                return TLB_ERR_NOT_PAIRED;
            }
            res->ok = true;
            tlb_sb_init(&sb, res->text, sizeof(res->text));
            sb_put(&sb, who);
            sb_put(&sb, " 握手成功 ");
            sb_put(&sb, msg);
            return TLB_OK;
        }
        tlb_sb_init(&sb, line, sizeof(line));
        sb_put(&sb, who);
        sb_put(&sb, " 握手第 ");
        sb_u64(&sb, (uint64_t)i);
        sb_put(&sb, " 次失败：");
        sb_put(&sb, msg);
        dlog(ops, line);
        if (fatal) {
            invalidate_session(session, domain, "车辆拒绝握手", ops);
            res->fatal = true;
            res->not_whitelisted = not_wl;
            tlb_sb_init(&sb, res->text, sizeof(res->text));
            sb_put(&sb, who);
            sb_put(&sb, " 握手被拒：");
            sb_put(&sb, msg);
            return e;
        }
        if (i < 2) {
            do_sleep(ops, trace, 1000);
        }
    }
    invalidate_session(session, domain, "握手连续失败", ops);
    tlb_sb_init(&sb, res->text, sizeof(res->text));
    sb_put(&sb, who);
    sb_put(&sb, " 握手失败：");
    sb_put(&sb, msg);
    return (e != TLB_OK) ? e : TLB_ERR_PROTO;
}

// command-dispatcher.js:sendRequest —— 一条 V3 请求的完整重发循环。
//
// 偏离（已核对）：
//   1) 探针的 mustConnect()/mustKey() 是**抛异常**，C 一律收成 res->text + 错误码（同 tlb_handshake）。
//   2) 探针的 ble().send 抛异常 → 「发送失败：<e.message>」；C 拿不到 e.message，固定成「链路错误」。
//      ble().receive 不在 try 里（异常直接逃出 sendRequest），C 同样收成「接收失败：链路错误」。
//   3) built 的字节存在**局部** frame[]：握手会覆写 sc->tx，而车机域的重发必须复用同一份字节。
//      日志行借用 sc->tx（握手返回后它就没人要了），省下 1.5KB 任务栈；整帧 hex 因此会被截短，
//      属于纯日志行简化。
//   4) send_reuse 只比较**本次调用内**相邻两次上线字节（have_prev 每次调用清零）。
tlb_err_t tlb_send_request(const tlb_request_t *req, tlb_v3_session_t *session,
                           const tlb_dispatch_ops_t *ops, tlb_dispatch_scratch_t *sc,
                           tlb_request_result_t *res)
{
    uint8_t addr[TLB_ADDR_LEN];
    uint8_t uuid[TLB_ADDR_LEN];
    uint8_t frame[TLB_DISPATCH_FRAME_MAX];
    char last_text[TLB_FRAME_TEXT_MAX];
    char drop_first[TLB_FRAME_TEXT_MAX];
    char drop_last[TLB_FRAME_TEXT_MAX];
    char whytext[256];
    char aux[TLB_TEXT_MAX];
    char who[128];
    char *line = (char *)sc->tx; // 见偏离 3
    size_t linesz = sizeof(sc->tx);
    tlb_frame_out_t out;
    tlb_handshake_result_t h;
    tlb_frame_ctx_t ctx;
    tlb_v3_cmd_t cmd;
    tlb_v3_cmd_out_t enc;
    tlb_sb_t sb;
    const char *name;
    const char *vin;
    const char *mt;
    const char *fh;
    uint32_t domain;
    bool built = false;
    bool stale = false;
    bool resynced = false;
    bool have_prev = false;
    bool has_last = false;
    bool resign;
    size_t frame_len = 0;
    size_t prev_len = 0;
    int frames = 0;
    int attempt;
    int dropped;
    int rc;
    int64_t deadline;
    int64_t now;
    bool first;
    tlb_action_t action;
    tlb_err_t e;

    memset(res, 0, sizeof(*res));
    domain = req->domain;
    name = (req->name && req->name[0] != '\0') ? req->name : "V3 请求";
    tlb_domain_text(domain, who, sizeof(who));

    if (!ops->connected || !ops->connected(ops->ud)) {
        tlb_sb_init(&sb, res->text, sizeof(res->text));
        sb_put(&sb, "还没连上车辆，先按「扫描并连接」");
        return TLB_ERR_LINK;
    }
    vin = req->vin;
    if (vin == NULL || vin[0] == '\0') {
        tlb_sb_init(&sb, res->text, sizeof(res->text));
        sb_put(&sb, name);
        sb_put(&sb, "：VIN 为空，先在首页填 VIN 再连接");
        return TLB_ERR_STATE;
    }
    if (!req->plain && (!ops->has_key || !ops->has_key(ops->ud))) {
        tlb_sb_init(&sb, res->text, sizeof(res->text));
        sb_put(&sb, "还没有密钥，先做绑定");
        return TLB_ERR_NO_KEY;
    }

    tlb_port_random(addr, sizeof(addr));
    tlb_port_random(uuid, sizeof(uuid));
    deadline = now_ms_of(ops) + ((req->max_ms > 0) ? req->max_ms : TLB_DEFAULT_MAX_MS);
    // 结论 2.4：VCSEC 每次重发都重新签一份，车机域复用同一份已编码字节
    resign = (!req->plain && domain == TLB_DOMAIN_VCSEC);

    for (attempt = 1;; attempt++) {
        res->attempts = attempt;

        if (!req->plain) {
            e = tlb_handshake(false, domain, vin, session, ops, sc, &res->trace, &h);
            if (!h.ok) {
                tlb_sb_init(&sb, res->text, sizeof(res->text));
                sb_put(&sb, name);
                sb_put(&sb, "：");
                sb_put(&sb, h.text);
                return (e != TLB_OK) ? e : TLB_ERR_PROTO;
            }
        }
        if (stale || resign) {
            built = false;
            stale = false;
        }

        if (!built) {
            // 第二份及以后的帧换一组路由地址 / uuid（官方 dispatcher.go:392-413）
            if (frames > 0) {
                tlb_port_random(addr, sizeof(addr));
                tlb_port_random(uuid, sizeof(uuid));
            }
            aux[0] = '\0';
            if (req->plain) {
                frame_len = tlb_msg_encode_plain(domain, addr, req->payload, req->payload_len, uuid,
                                                 TLB_ADDR_LEN, TLB_REQUEST_FLAGS, frame,
                                                 sizeof(frame));
                if (frame_len == 0) {
                    tlb_sb_init(&sb, aux, sizeof(aux));
                    sb_put(&sb, "pb: 编码失败"); // 偏离：C 拿不到 e.message
                } else {
                    built = true;
                }
            } else {
                memset(&cmd, 0, sizeof(cmd));
                cmd.domain = domain;
                cmd.vin = vin;
                cmd.signer_pub = ops->signer_pub;
                cmd.signer_pub_len = ops->signer_pub_len;
                cmd.payload = req->payload;
                cmd.payload_len = req->payload_len;
                cmd.routing_address = addr;
                cmd.uuid = uuid;
                cmd.flags = TLB_REQUEST_FLAGS;
                cmd.expires_in = TLB_V3_DEFAULT_EXPIRES_IN;
                cmd.now = now_ms_of(ops) / 1000;
                e = tlb_v3_encrypt_command(session, &cmd, sc->rx, sizeof(sc->rx), frame,
                                           sizeof(frame), &enc);
                if (e == TLB_OK) {
                    frame_len = enc.frame_len;
                    built = true;
                } else {
                    tlb_sb_init(&sb, aux, sizeof(aux));
                    sb_put(&sb, encrypt_err_text(e));
                }
            }
            if (!built) {
                if (!req->plain && attempt < TLB_MAX_ATTEMPTS) {
                    tlb_sb_init(&sb, line, linesz);
                    sb_put(&sb, name);
                    sb_put(&sb, " 组包失败（");
                    sb_put(&sb, aux);
                    sb_put(&sb, "），作废");
                    sb_put(&sb, who);
                    sb_put(&sb, "会话后重新握手");
                    dlog(ops, line);
                    invalidate_session(session, domain, "组包时会话参数不全", ops);
                    do_sleep(ops, &res->trace, 1000);
                    continue;
                }
                tlb_sb_init(&sb, res->text, sizeof(res->text));
                sb_put(&sb, name);
                sb_put(&sb, " 组包失败：");
                sb_put(&sb, aux);
                return TLB_ERR_PROTO;
            }

            frames++;
            res->n_frames = frames;
            memset(&ctx, 0, sizeof(ctx));
            ctx.name = name;
            ctx.domain = domain;
            ctx.vin = vin;
            ctx.session = session;
            ctx.routing_address = addr;
            ctx.uuid = uuid;
            // 偏离（等价式）：requestIdOf(built.message) —— 明文帧没有 GCM 签名，request_id 恒空
            ctx.request_id = req->plain ? NULL : enc.request_id;
            ctx.request_id_len = req->plain ? 0 : enc.request_id_len;
            ctx.sent_at_ms = now_ms_of(ops);
            ctx.ops = ops;

            tlb_sb_init(&sb, line, linesz);
            sb_put(&sb, name);
            if (req->plain) {
                sb_put(&sb, " 明文请求 ");
            } else {
                sb_put(&sb, " ");
                sb_put(&sb, who);
                sb_put(&sb, " counter=");
                sb_u32(&sb, enc.counter);
                sb_put(&sb, " nonce=");
                sb_hex(&sb, enc.nonce, TLB_NONCE_LEN);
                sb_put(&sb, " 密文=");
                sb_u64(&sb, (uint64_t)enc.ciphertext_len);
                sb_put(&sb, "B ");
            }
            sb_hex(&sb, frame, frame_len);
            dlog(ops, line);
        }

        if (!ops->exchange) {
            tlb_sb_init(&sb, res->text, sizeof(res->text));
            sb_put(&sb, name);
            sb_put(&sb, " 发送失败：链路错误");
            return TLB_ERR_LINK;
        }
        if (res->n_sends < TLB_DISPATCH_TRACE_MAX) {
            res->send_counters[res->n_sends] = req->plain ? 0u : enc.counter;
            res->send_reuse[res->n_sends] = (have_prev && prev_len == frame_len &&
                                             memcmp(frame, sc->last_tx, frame_len) == 0);
        }
        res->n_sends++;
        memcpy(sc->last_tx, frame, frame_len);
        prev_len = frame_len;
        have_prev = true;

        // 第一次发之前清掉残留帧；重发时保留队列（车机域的迟到回包可能正躺在队列里）
        rc = ops->exchange(ops->ud, frame, frame_len, TLB_FIRST_RESPONSE_MS, attempt > 1, sc->rx,
                           sizeof(sc->rx));
        if (rc < 0) {
            tlb_sb_init(&sb, res->text, sizeof(res->text));
            sb_put(&sb, name);
            sb_put(&sb, " 发送失败：链路错误");
            return TLB_ERR_LINK;
        }
        if (attempt > 1) {
            tlb_sb_init(&sb, line, linesz);
            sb_put(&sb, name);
            sb_put(&sb, " 第 ");
            sb_u64(&sb, (uint64_t)attempt);
            sb_put(&sb, "/");
            sb_u64(&sb, (uint64_t)TLB_MAX_ATTEMPTS);
            sb_put(&sb, " 次发送：");
            sb_put(&sb, resign ? "VCSEC 重新签一份（counter 必须前进）" : "复用同一份已编码字节");
            dlog(ops, line);
        }

        first = true;
        dropped = 0;
        drop_first[0] = '\0';
        drop_last[0] = '\0';
        has_last = false;
        last_text[0] = '\0';

        for (;;) {
            if (rc < 0) {
                tlb_sb_init(&sb, res->text, sizeof(res->text));
                sb_put(&sb, name);
                sb_put(&sb, " 接收失败：链路错误");
                return TLB_ERR_LINK;
            }
            if (rc == 0) {
                if (first) {
                    if (attempt < TLB_MAX_ATTEMPTS) {
                        tlb_sb_init(&sb, line, linesz);
                        sb_put(&sb, name);
                        sb_put(&sb, " 没收到响应，1 秒后重发（第 ");
                        sb_u64(&sb, (uint64_t)(attempt + 1));
                        sb_put(&sb, "/");
                        sb_u64(&sb, (uint64_t)TLB_MAX_ATTEMPTS);
                        sb_put(&sb, " 次）");
                        dlog(ops, line);
                        do_sleep(ops, &res->trace, 1000);
                        break;
                    }
                    res->timeout = true;
                    tlb_sb_init(&sb, res->text, sizeof(res->text));
                    sb_put(&sb, name);
                    sb_put(&sb, "：车辆 ");
                    sb_u64(&sb, (uint64_t)TLB_FIRST_RESPONSE_MS);
                    sb_put(&sb, " 秒内没有任何响应");
                    return TLB_ERR_TIMEOUT;
                }
                now = now_ms_of(ops);
                if (now >= deadline) {
                    res->timeout = true;
                    tlb_sb_init(&sb, res->text, sizeof(res->text));
                    sb_put(&sb, name);
                    sb_put(&sb, " 等待终态超时（最后一帧：");
                    sb_put(&sb, has_last ? last_text : "无");
                    if (dropped > 0) {
                        sb_put(&sb, "；");
                        sb_drop_text(&sb, dropped, drop_first, drop_last);
                    }
                    sb_put(&sb, "）");
                    return TLB_ERR_TIMEOUT;
                }
                do_sleep(ops, &res->trace, 1000);
                rc = do_receive(ops, &res->trace, sc->rx, sizeof(sc->rx),
                                slice_ms(deadline, now_ms_of(ops)));
                continue;
            }

            first = false;
            tlb_decode_frame(sc->rx, (size_t)rc, &ctx, sc, &out);
            if (out.skipped) {
                // 看不懂的帧只丢弃，继续等（官方 dispatcher.go:302-308）
                dropped++;
                res->n_dropped++;
                if (drop_first[0] == '\0') {
                    memcpy(drop_first, out.text, sizeof(drop_first));
                }
                memcpy(drop_last, out.text, sizeof(drop_last));
                has_last = false;
                now = now_ms_of(ops);
                if (now >= deadline) {
                    res->timeout = true;
                    tlb_sb_init(&sb, res->text, sizeof(res->text));
                    sb_put(&sb, name);
                    sb_put(&sb, " 等待终态超时（所有帧都解不开：");
                    sb_drop_text(&sb, dropped, drop_first, drop_last);
                    sb_put(&sb, "）");
                    return TLB_ERR_TIMEOUT;
                }
                do_sleep(ops, &res->trace, 500);
                rc = do_receive(ops, &res->trace, sc->rx, sizeof(sc->rx),
                                slice_ms(deadline, now_ms_of(ops)));
                continue;
            }
            has_last = true;
            memcpy(last_text, out.text, sizeof(last_text));

            if (out.fault != 0 || out.op_status != 0) {
                action = tlb_proto_outcome(out.fault, out.op_status, whytext, sizeof(whytext));
            } else {
                action = tlb_app_outcome(&out.obj, domain, whytext, sizeof(whytext));
            }

            if (action == TLB_ACTION_RESYNC && !resynced) {
                resynced = true;
                stale = true; // 旧帧是上一个 epoch 签的，重新握手后必须重新组包
                tlb_sb_init(&sb, line, linesz);
                sb_put(&sb, name);
                sb_put(&sb, " 车辆回 ");
                sb_put(&sb, whytext);
                sb_put(&sb, "，");
                sb_put(&sb, who);
                sb_put(&sb, " counter/epoch 疑似失步，重新握手");
                dlog(ops, line);
                tlb_sb_init(&sb, aux, sizeof(aux));
                sb_put(&sb, "车辆回 ");
                sb_put(&sb, whytext);
                invalidate_session(session, domain, aux, ops);
                do_sleep(ops, &res->trace, 1000);
                break;
            }
            if (action == TLB_ACTION_BUSY) {
                if (attempt < TLB_MAX_ATTEMPTS) {
                    tlb_sb_init(&sb, line, linesz);
                    sb_put(&sb, name);
                    sb_put(&sb, " ");
                    sb_put(&sb, whytext);
                    sb_put(&sb, "，1 秒后重发");
                    dlog(ops, line);
                    do_sleep(ops, &res->trace, 1000);
                    break;
                }
                res->fault = out.fault;
                tlb_sb_init(&sb, res->text, sizeof(res->text));
                sb_put(&sb, name);
                sb_put(&sb, " 车辆一直回 ");
                sb_put(&sb, whytext);
                return TLB_ERR_REFUSED;
            }
            if (action == TLB_ACTION_FAIL) {
                // 偏离：tlb_frame_out_t 没有 hint 字段，协议层错误帧才带 fault 提示（新事实 75）
                fh = out.refused ? tlb_fault_hint(out.fault) : "";
                mt = ops->mtu_note ? ops->mtu_note(ops->ud) : NULL;
                if (mt == NULL) {
                    mt = "";
                }
                res->fault = out.fault;
                tlb_sb_init(&sb, res->text, sizeof(res->text));
                sb_put(&sb, name);
                sb_put(&sb, " 被拒：");
                sb_put(&sb, whytext);
                if (fh != NULL && fh[0] != '\0') {
                    sb_char(&sb, '\n');
                    sb_put(&sb, fh);
                    sb_put(&sb, mt);
                }
                fh = tlb_generic_error_hint(whytext);
                if (fh != NULL && fh[0] != '\0') {
                    sb_char(&sb, '\n'); // 探针 [hintA, hintB].filter(Boolean).join('\n')：每段前都给换行
                    sb_put(&sb, fh);
                }
                if (in_set(MAY_HAVE_SUCCEEDED,
                           sizeof(MAY_HAVE_SUCCEEDED) / sizeof(MAY_HAVE_SUCCEEDED[0]),
                           out.fault)) {
                    sb_put(&sb, "\n注意：按官方口径（error.go:195-198），这种拒绝属于「命令可能已经"
                                "执行」—— 车收下了请求，只是不发答案。");
                }
                return TLB_ERR_REFUSED;
            }

            if (tlb_done_check(req->done, &out.obj)) {
                res->ok = true;
                res->obj = out.obj;
                res->app = out.app;
                memcpy(res->raw, out.text, sizeof(res->raw));
                tlb_sb_init(&sb, res->text, sizeof(res->text));
                sb_put(&sb, name);
                sb_put(&sb, " 完成：");
                sb_put(&sb, out.app.text);
                return TLB_OK;
            }
            now = now_ms_of(ops);
            if (now >= deadline) {
                res->timeout = true;
                tlb_sb_init(&sb, res->text, sizeof(res->text));
                sb_put(&sb, name);
                sb_put(&sb, " 等待终态超时（最后一帧：");
                sb_put(&sb, out.app.text);
                sb_put(&sb, "）");
                return TLB_ERR_TIMEOUT;
            }
            do_sleep(ops, &res->trace, 1000);
            rc = do_receive(ops, &res->trace, sc->rx, sizeof(sc->rx),
                            slice_ms(deadline, now_ms_of(ops)));
        }
        // break 到这里 = 整条重发
    }
}
