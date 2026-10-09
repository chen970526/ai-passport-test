// components/tesla_core/src/tlb_bind.c
// 入白名单（绑定钥匙）实现。
//
// 权威依据（逐字对齐，用户可见文案不许改写）：
//   探针 src/domain/enrollment-service.js —— probeOnce / probeEnrollment / pairVerdict / bindKey
//   探针 src/domain/response-hints.js      —— PAIR_HINTS / TAP_HINT
//   探针 src/domain/dispatch-policy.js     —— 四个绑定时序常量与 pick()
//   探针 src/domain/v3-context.js          —— teslaKeyId()
//   探针 src/store/v3-session-store.js     —— invalidateV3Session 的文案与「不落盘」语义
//
// 本文件不引用 tlb_dispatch.c 的任何 static 助手：那些全是文件私有的，为了不动已通过金标准
// 回归的调度层（id6），这里自带一份**逐字节相同**的最小副本（字符串构造器 / dlog /
// now_ms_of / invalidate_session）。改动其中任何一句文案时，两处必须一起改。
//
// 栈预算（gcc -O1 -fstack-usage 实测，见 id7 收尾复测）：
//   tlb_bind_key 自身帧最大，最深链 bind_key → probe_once → tlb_handshake_once
//   仍低于 send_request → handshake 那条既有链，设备任务栈沿用 24KB。
#include <string.h>

#include "tesla_core/tlb_bind.h"
#include "tesla_core/tlb_sha.h"
#include "tesla_core/tlb_text.h"

// ---------------------------------------------------------------- 文案构造器（dispatch 同族副本）
typedef struct {
    char *buf;
    size_t cap;
    size_t len;
} sb_t;

static const char HEXD[] = "0123456789abcdef";
static const char HEXU[] = "0123456789ABCDEF";

static void sb_init(sb_t *sb, char *buf, size_t cap)
{
    sb->buf = buf;
    sb->cap = cap;
    sb->len = 0;
    if (cap > 0) {
        buf[0] = '\0';
    }
}

// 满了静默丢弃；sb->len 恒 <= cap-1，所以末尾写 '\0' 不会越界
static void sb_putn(sb_t *sb, const char *s, size_t n)
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

static void sb_put(sb_t *sb, const char *s)
{
    if (s) {
        sb_putn(sb, s, strlen(s));
    }
}

static void sb_char(sb_t *sb, char c) { sb_putn(sb, &c, 1); }

static void sb_u64(sb_t *sb, uint64_t v)
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

static void sb_u32(sb_t *sb, uint32_t v) { sb_u64(sb, (uint64_t)v); }

static void sb_i64(sb_t *sb, int64_t v)
{
    if (v < 0) {
        sb_char(sb, '-');
        sb_u64(sb, (uint64_t)(-(v + 1)) + 1ULL);
    } else {
        sb_u64(sb, (uint64_t)v);
    }
}

static void sb_hex(sb_t *sb, const uint8_t *p, size_t n)
{
    size_t i;
    for (i = 0; i < n; i++) {
        sb_char(sb, HEXD[p[i] >> 4]);
        sb_char(sb, HEXD[p[i] & 15]);
    }
}

// 探针里的 label() 最长的一条枚举名（WL info 的 85 字节名）+ '(42)'，192 足够
static void sb_label(sb_t *sb, const char *tbl, uint32_t v)
{
    char tmp[192];
    tlb_label(tbl, v, tmp, sizeof(tmp));
    sb_put(sb, tmp);
}

// ---------------------------------------------------------------- 钩子包装（dispatch 同族副本）
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

// 探针 v3-session-store.js:invalidateV3Session —— 与 tlb_dispatch.c 里的同名 static 完全一致。
// 「只清 key/ready、counter 保留、不落盘」，所以绝不调用 session_stored；
// 而且只有原本真有共享密钥时才打这一行日志。
static void invalidate_session(tlb_v3_session_t *s, uint32_t domain, const char *why,
                               const tlb_dispatch_ops_t *ops)
{
    char buf[TLB_TEXT_MAX];
    char who[128];
    sb_t sb;

    if (!s->has_key) {
        return;
    }
    tlb_domain_text(domain, who, sizeof(who));
    sb_init(&sb, buf, sizeof(buf));
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

// ---------------------------------------------------------------- PAIR_HINTS
// 探针 response-hints.js:29-43 —— 白名单操作回执 → 人话。只列配对场景真会遇到的码，
// 其余走枚举名原文（= 本表未命中时返回空串，由调用方跳过「\n + hint」那一段）。
typedef struct {
    uint32_t info;
    const char *hint;
} pair_hint_t;

static const pair_hint_t PAIR_HINTS[] = {
    { 0, "已加入白名单，可以回去试「查白名单」和开锁了" },
    { 3, "钥匙卡槽位已满，先移除一把不用的实体钥匙" },
    { 4, "白名单已满，先移除一把不用的钥匙" },
    { 5, "当前这把钥匙没有加钥匙的权限，需要用车主钥匙刷卡" },
    { 12, "用来签署这条请求的钥匙本身不在白名单里" },
    { 13, "本机公钥已经在白名单里了，直接试开锁即可" },
    { 14, "车辆要求先检测到钥匙卡在读卡区才允许添加：先把卡放上去再重按绑定" },
    { 23, "车机没能起本地授权流程，重新踩刹车唤醒车机再试" },
    { 24, "车机屏幕上点了「拒绝」" },
    { 25, "等刷卡超时：卡没贴 / 贴的位置不对 / 贴太晚" },
    { 26, "刷了卡但没在车机屏幕上点确认，超时了" },
    { 27, "车辆处于代客模式，不允许加钥匙" },
    { 28, "车机屏幕上取消了配对" }
};

static const char *pair_hint(uint32_t info)
{
    size_t i;
    for (i = 0; i < sizeof(PAIR_HINTS) / sizeof(PAIR_HINTS[0]); i++) {
        if (PAIR_HINTS[i].info == info) {
            return PAIR_HINTS[i].hint;
        }
    }
    return "";
}

// ---------------------------------------------------------------- 公共小件
void tlb_tesla_key_id(const tlb_dispatch_ops_t *ops, char *out, size_t cap)
{
    uint8_t digest[20];
    sb_t sb;
    size_t len;

    sb_init(&sb, out, cap);
    // JS: state.publicKey ? toHex(sha1(state.publicKey)) : ''，长度不足 8 才出 '-'。
    // 只要有公钥，SHA1 的 hex 恒 40 字符，所以「有 / 无公钥」两档就够。
    if (!ops || !ops->signer_pub) {
        sb_put(&sb, "-");
        return;
    }
    len = ops->signer_pub_len;
    tlb_sha1(ops->signer_pub, len, digest);
    // 取前 4 字节：slice(0,8).match(/../g).join(':').toUpperCase()
    {
        int i;
        for (i = 0; i < 4; i++) {
            if (i > 0) {
                sb_char(&sb, ':');
            }
            sb_char(&sb, HEXU[digest[i] >> 4]);
            sb_char(&sb, HEXU[digest[i] & 15]);
        }
    }
}

// 探针 pick(opts, key, dflt)：非「有限正数」一律回落默认值
static int64_t pick_ms(const tlb_bind_opts_t *opts, int64_t v, int64_t dflt)
{
    return (opts && v > 0) ? v : dflt;
}

// ---------------------------------------------------------------- 会话探针
void tlb_probe_once(const char *vin, uint32_t domain, tlb_v3_session_t *s,
                    const tlb_dispatch_ops_t *ops, tlb_dispatch_scratch_t *sc, tlb_probe_t *res)
{
    char msg[TLB_TEXT_MAX];
    bool fatal = false;
    bool not_wl = false;
    sb_t sb;
    tlb_err_t e;

    memset(res, 0, sizeof(*res));
    msg[0] = '\0';

    invalidate_session(s, domain, "探针要求重新协商", ops);
    e = tlb_handshake_once(vin, s, domain, ops, sc, &fatal, &not_wl, msg, sizeof(msg));
    if (e == TLB_OK) {
        if (ops->session_stored) {
            ops->session_stored(ops->ud, domain);
        }
        res->paired = true;
        sb_init(&sb, res->text, sizeof(res->text));
        sb_put(&sb, "会话已建立（");
        sb_put(&sb, msg);
        sb_put(&sb, "）");
        return;
    }
    if (not_wl) {
        res->not_whitelisted = true;
    } else {
        // 没响应 / 响应不是 RoutableMessage（例如正好把 add-key 的 WAIT 帧当成握手响应读走了）
        // 只说明这一针没打上，**不代表没绑上**，下一轮继续。
        res->retryable = true;
    }
    sb_init(&sb, res->text, sizeof(res->text));
    sb_put(&sb, msg);
}

// ---------------------------------------------------------------- 绑定结果收尾
void tlb_pair_verdict(const tlb_probe_t *p, int attempt, const tlb_dispatch_ops_t *ops,
                      tlb_bind_result_t *res)
{
    char kid[16];
    sb_t sb;

    memset(res, 0, sizeof(*res));
    tlb_tesla_key_id(ops, kid, sizeof(kid));
    res->ok = true;
    res->paired = true;
    sb_init(&sb, res->text, sizeof(res->text));
    sb_put(&sb, "绑定成功 —— 探针第 ");
    sb_i64(&sb, (int64_t)attempt);
    sb_put(&sb, " 次确认：");
    sb_put(&sb, p->text);
    sb_put(&sb, "\n判据：session_info_request(VCSEC) 拿到了 status=OK 的 SessionInfo"
                "（官方 security.go:324 与 0Bu 都用这条）。");
    sb_put(&sb, "\n本机 Tesla key id = ");
    sb_put(&sb, kid);
    sb_put(&sb, "，去车机 控制 > 安全 > 钥匙 里找那把 \"Unknown key\"。");
    sb_put(&sb, "\n下一步：到「上锁 / 解锁页」发 RKE 解锁验证");
}

// ---------------------------------------------------------------- 「④ 探针确认」
// 偏离：JS 的 mustConnect() / mustKey() 抛异常，C 按调度层既有口径收成 res->text + 错误码。
// 返回码只区分「在不在白名单」这一件事：未入白名单一律 TLB_ERR_NOT_PAIRED，
// 「明确拒绝」与「这一针没打上」由 res->not_whitelisted / res->paired 带着。
tlb_err_t tlb_probe_enrollment(const char *vin, const tlb_bind_opts_t *opts, tlb_v3_session_t *s,
                               const tlb_dispatch_ops_t *ops, tlb_dispatch_scratch_t *sc,
                               tlb_bind_result_t *res)
{
    char kid[16];
    tlb_probe_t p;
    sb_t sb;

    memset(res, 0, sizeof(*res));
    if (!ops->connected || !ops->connected(ops->ud)) {
        sb_init(&sb, res->text, sizeof(res->text));
        sb_put(&sb, "还没连上车辆，先按「扫描并连接」");
        return TLB_ERR_LINK;
    }
    if (!ops->has_key || !ops->has_key(ops->ud)) {
        sb_init(&sb, res->text, sizeof(res->text));
        sb_put(&sb, "还没有密钥，先做绑定");
        return TLB_ERR_NO_KEY;
    }
    if (vin == NULL || vin[0] == '\0') {
        sb_init(&sb, res->text, sizeof(res->text));
        sb_put(&sb, "VIN 为空，先在首页填 VIN 再连接");
        return TLB_ERR_STATE;
    }

    if (!(opts && opts->force) && s->ready && s->has_key) {
        res->ok = true;
        res->paired = true;
        res->reused = true;
        sb_init(&sb, res->text, sizeof(res->text));
        sb_put(&sb, "本机已有可用 V3 会话（counter=");
        sb_u32(&sb, s->counter);
        sb_put(&sb, "），说明钥匙已在白名单");
        return TLB_OK;
    }

    tlb_probe_once(vin, TLB_DOMAIN_VCSEC, s, ops, sc, &p);
    {
        char line[TLB_PROBE_TEXT_MAX + 8];
        sb_init(&sb, line, sizeof(line));
        sb_put(&sb, "探针：");
        sb_put(&sb, p.text);
        dlog(ops, line);
    }
    res->ok = p.paired;
    res->paired = p.paired;
    res->not_whitelisted = p.not_whitelisted;
    tlb_tesla_key_id(ops, kid, sizeof(kid));
    sb_init(&sb, res->text, sizeof(res->text));
    sb_put(&sb, p.paired ? "已入白名单：" : "尚未入白名单：");
    sb_put(&sb, p.text);
    sb_put(&sb, "\n本机 Tesla key id = ");
    sb_put(&sb, kid);
    sb_put(&sb, "（车机钥匙列表里通常显示为 Unknown key）");
    return p.paired ? TLB_OK : TLB_ERR_NOT_PAIRED;
}

// ---------------------------------------------------------------- 主绑定路径
//
// 官方 security.go:338 SendAddKeyRequestWithRole —— 裸 ToVCSECMessage{signedMessage
// {PRESENT_KEY}}，不带会话。三段状态机（照 0Bu vehicle_pairing.cpp:240-301，
// 判据换成官方也认可的会话探针）：
//   0. 先打一针。已经能建会话 = 早就绑好了，直接返回 —— **绝不再发 add-key**。
//   1. 发一次 whitelist-add。官方发完就 return；我们多等一会儿，因为 protocol.md:824 说
//      车端会先回 WAIT、刷完卡再回带 whitelistOperationStatus 的终态。
//   2. 交替进行：收车端回执（2.5 秒一片）+ 每 5 秒打一针会话探针，谁先来算谁。
//
// 偏离（已核对，均为纯日志行或 C 结构无法承载的差异）：
//   1) mustConnect() 抛异常 → res->text + TLB_ERR_LINK（同调度层）。
//   2) ensureKey() 生成密钥是设备层（id8/id9）的事，核心不生成；k.created 那行日志因此没有。
//   3) formFactor / role 走 label('KeyFormFactor'|'Role', n)，本核心没有这两张表：
//      该行是纯日志，改成直接打数字。
//   4) ble().send 抛异常 → 「发送失败：<e.message>」；C 拿不到 e.message，固定成「链路错误」。
//   5) ble().receive 不在 try 里（reject 会直接逃出 bindKey）；C 把 rc<0 当成「这一片没帧」，
//      由窗口耗尽兜底 —— 所以缺 receive / now_ms / exchange 钩子时直接判集成错误，
//      否则时间不前进会转不出来。
//   6) JS 里 vin 实参只喂给 ensureKey，真正发送用的是 state.vin（vinOrEmpty）；
//      C 只有一个 vin 入参，两处同源。
// 引导页「我已确认」检查（bindKey 等待循环内调用）。返回：0=没按下继续等；
// 1=按下且探针通过（res 已填成功收尾）；-1=按下但没绑上（res 已填排查指引）。
// 文案首行必须 ≤63 字节：设备层「失败:%s」按字节截断后上屏。
static int bind_user_confirm_check(const char *vin, const tlb_bind_opts_t *opts, tlb_v3_session_t *s,
                                   const tlb_dispatch_ops_t *ops, tlb_dispatch_scratch_t *sc,
                                   tlb_bind_result_t *res, int *probes) {
    tlb_probe_t p;
    sb_t sb;

    if (!opts || !opts->user_confirm || !opts->user_confirm()) {
        return 0;
    }
    (*probes)++;
    tlb_probe_once(vin, TLB_DOMAIN_VCSEC, s, ops, sc, &p);
    if (p.paired) {
        tlb_pair_verdict(&p, *probes, ops, res);
        return 1;
    }
    sb_init(&sb, res->text, sizeof(res->text));
    sb_put(&sb, "已确认，探针未通过：车端还没加白名单\n");
    sb_put(&sb, p.text);
    sb_put(&sb, "\n还要贴NFC钥匙卡：中控杯架前读卡区\n贴好后按右三立即验证；重新选车可再发起配对");
    return -1;
}

tlb_err_t tlb_bind_key(const char *vin, const tlb_bind_opts_t *opts, tlb_v3_session_t *s,
                       const tlb_dispatch_ops_t *ops, tlb_dispatch_scratch_t *sc,
                       tlb_bind_result_t *res) {
    char line[TLB_RESULT_TEXT_MAX];
    char last[TLB_PROBE_TEXT_MAX];
    char kid[16];
    tlb_probe_t pre;
    tlb_probe_t p;
    tlb_frame_out_t out;
    tlb_frame_ctx_t ctx;
    sb_t sb;
    uint32_t form_factor;
    int64_t window_ms;
    int64_t receive_ms;
    int64_t probe_first_ms;
    int64_t probe_interval_ms;
    int64_t deadline;
    int64_t next_probe;
    int64_t now;
    size_t n;
    int rc;
    int cc;
    int probes = 0;
    bool saw_wait = false;
    bool has_body;

    memset(res, 0, sizeof(*res));
    memset(&pre, 0, sizeof(pre));
    last[0] = '\0';

    if (!ops->connected || !ops->connected(ops->ud)) {
        sb_init(&sb, res->text, sizeof(res->text));
        sb_put(&sb, "还没连上车辆，先按「扫描并连接」");
        return TLB_ERR_LINK;
    }
    form_factor = (opts && opts->has_form_factor) ? opts->form_factor : TLB_FF_ANDROID_DEVICE;
    window_ms = pick_ms(opts, opts ? opts->window_ms : 0, TLB_PAIR_WINDOW_MS);
    receive_ms = pick_ms(opts, opts ? opts->receive_ms : 0, TLB_PAIR_RECEIVE_MS);
    probe_first_ms = pick_ms(opts, opts ? opts->probe_first_ms : 0, TLB_PROBE_FIRST_MS);
    probe_interval_ms = pick_ms(opts, opts ? opts->probe_interval_ms : 0, TLB_PROBE_INTERVAL_MS);
    if (!ops->exchange || !ops->receive || !ops->now_ms) {
        return TLB_ERR_STATE; // 见偏离 5
    }
    tlb_tesla_key_id(ops, kid, sizeof(kid));

    sb_init(&sb, line, sizeof(line));
    sb_put(&sb, TLB_BIND_NAME);
    sb_put(&sb, " 开始：formFactor=");
    sb_u32(&sb, form_factor);
    sb_put(&sb, " role=");
    sb_u32(&sb, TLB_ROLE_DRIVER);
    sb_put(&sb, " 本机 key id=");
    sb_put(&sb, kid);
    dlog(ops, line);

    // ---- 阶段 0：先确认是不是已经绑好了
    if (vin == NULL || vin[0] == '\0') {
        sb_init(&sb, res->text, sizeof(res->text));
        sb_put(&sb, TLB_BIND_NAME);
        sb_put(&sb, "：VIN 为空，先在首页填 VIN 再连接");
        return TLB_ERR_STATE;
    }
    tlb_probe_once(vin, TLB_DOMAIN_VCSEC, s, ops, sc, &pre);
    if (pre.paired) {
        res->ok = true;
        res->paired = true;
        res->already = true;
        sb_init(&sb, res->text, sizeof(res->text));
        sb_put(&sb, "不用绑定，这把钥匙早就在白名单里且会话可用：");
        sb_put(&sb, pre.text);
        sb_put(&sb, "\n直接去「上锁 / 解锁页」发指令即可");
        return TLB_OK;
    }
    sb_init(&sb, line, sizeof(line));
    sb_put(&sb, TLB_BIND_NAME);
    sb_put(&sb, " 预探针：");
    sb_put(&sb, pre.text);
    sb_put(&sb, " —— 继续发加白名单请求");
    dlog(ops, line);

    // ---- 阶段 1：发一次（且仅一次）whitelist-add
    n = tlb_msg_encode_add_key_envelope(ops->signer_pub, ops->signer_pub_len, TLB_ROLE_DRIVER,
                                        form_factor, sc->tx, sizeof(sc->tx));
    if (n > 0) {
        sb_init(&sb, line, sizeof(line));
        sb_put(&sb, TLB_BIND_NAME);
        sb_put(&sb, " PRESENT_KEY，不带会话 ");
        sb_hex(&sb, sc->tx, n); // 偏离：整帧 hex；探针这句本来就是 toHex(envelope)
        dlog(ops, line);
    } else {
        // 探针在这里会让 pb.js 的编码异常一路逃出 bindKey，C 收成一条可判读的失败
        sb_init(&sb, res->text, sizeof(res->text));
        sb_put(&sb, TLB_BIND_NAME);
        sb_put(&sb, " 组包失败：pb: 编码失败");
        return TLB_ERR_PROTO;
    }

    memset(&ctx, 0, sizeof(ctx));
    ctx.name = TLB_BIND_NAME;
    ctx.domain = TLB_DOMAIN_VCSEC;
    ctx.vin = vin;
    ctx.session = s;
    // 探针的 ctx 不带 routingAddress / uuid，三道路由闸门里只有域这一道真会生效
    ctx.routing_address = NULL;
    ctx.uuid = NULL;
    ctx.request_id = NULL;
    ctx.request_id_len = 0;
    ctx.sent_at_ms = now_ms_of(ops); // JS：ctx 在 send 之前构造，sentAt 读的是发送前的 Date.now()
    ctx.ops = ops;

    rc = ops->exchange(ops->ud, sc->tx, n, TLB_FIRST_RESPONSE_MS, true, sc->rx, sizeof(sc->rx));
    if (rc < 0) {
        sb_init(&sb, res->text, sizeof(res->text));
        sb_put(&sb, TLB_BIND_NAME);
        sb_put(&sb, " 发送失败：链路错误\n先确认 ② 还连着（车辆同时最多约 3 个 BLE 连接，"
                    "官方 Tesla App 在后台会占掉一个）");
        return TLB_ERR_LINK;
    }
    has_body = (rc > 0);

    // ---- 阶段 2：等回执 / 打探针，谁先来算谁
    now = now_ms_of(ops);
    deadline = now + window_ms;
    next_probe = now + probe_first_ms;

    for (;;) {
        while (has_body) {
            uint32_t st;
            uint32_t info;
            const char *hint;

            // 车端连发状态帧时也要看到用户的「我已确认」，不能被收帧循环饿死
            cc = bind_user_confirm_check(vin, opts, s, ops, sc, res, &probes);
            if (cc != 0) {
                return (cc > 0) ? TLB_OK : TLB_ERR_NOT_PAIRED;
            }
            tlb_decode_frame(sc->rx, (size_t)rc, &ctx, sc, &out);
            st = (out.obj.has_command_status && out.obj.has_operation_status) ? out.obj.operation_status : 0;

            // 车辆给了 whitelistOperationStatus —— protocol.md:836 认定这是唯一终态，
            // 它比探针权威（是车自己说的成 / 败），直接照它下结论。
            if (out.obj.has_command_status && out.obj.has_whitelist_status) {
                info = out.obj.has_wl_information ? out.obj.wl_information : 0;
                hint = pair_hint(info);
                res->has_info = true;
                res->info = info;
                if (info != 0) {
                    sb_init(&sb, res->text, sizeof(res->text));
                    sb_put(&sb, "车辆明确回执：");
                    sb_label(&sb, TLB_EN_WL_INFO, info);
                    if (hint[0] != '\0') {
                        sb_put(&sb, "\n");
                        sb_put(&sb, hint);
                    }
                    return TLB_ERR_DENIED;
                }
                // 车说加好了，再打一针拿会话（0Bu 的第 3 步；官方 security.go:324 同一件事）
                tlb_probe_once(vin, TLB_DOMAIN_VCSEC, s, ops, sc, &p);
                probes++;
                res->ok = true;
                res->paired = p.paired;
                sb_init(&sb, res->text, sizeof(res->text));
                sb_put(&sb, "车辆回执已加入白名单（");
                sb_label(&sb, TLB_EN_WL_INFO, 0);
                sb_put(&sb, "）");
                if (hint[0] != '\0') {
                    sb_put(&sb, "\n");
                    sb_put(&sb, hint);
                }
                sb_put(&sb, "\n会话探针：");
                sb_put(&sb, p.text);
                sb_put(&sb, "\n本机 Tesla key id = ");
                sb_put(&sb, kid);
                sb_put(&sb, "（车机钥匙列表里显示为 Unknown key）");
                sb_put(&sb, p.paired ? "\n下一步：到「上锁 / 解锁页」发 RKE 解锁验证"
                                     : "\n注意：车机可能还要几秒才同步完，稍后再按一次「④ 探针确认」");
                return TLB_OK;
            }

            // WAIT = 等刷卡，不是「忙」，绝不能重发（重发会把配对窗口重新开始计时）
            if (st == TLB_OP_WAIT) {
                if (!saw_wait) {
                    saw_wait = true;
                    sb_init(&sb, line, sizeof(line));
                    sb_put(&sb, "车辆已进入配对等待，");
                    sb_put(&sb, tlb_tap_hint());
                    dlog(ops, line);
                }
            } else if (st == TLB_OP_ERROR) {
                sb_init(&sb, res->text, sizeof(res->text));
                sb_put(&sb, TLB_BIND_NAME);
                sb_put(&sb, " 被车端拒绝：");
                sb_put(&sb, out.app.text);
                sb_put(&sb, "\n");
                sb_put(&sb, tlb_tap_hint());
                return TLB_ERR_DENIED;
            } else if (out.fault != 0) {
                sb_init(&sb, line, sizeof(line));
                sb_put(&sb, TLB_BIND_NAME);
                sb_put(&sb, " 收到协议层 fault：");
                sb_label(&sb, TLB_EN_FAULT, out.fault);
                sb_put(&sb, "（继续等，不重发 add-key）");
                dlog(ops, line);
            }
            rc = ops->receive(ops->ud, sc->rx, sizeof(sc->rx), receive_ms);
            has_body = (rc > 0);
        }

        cc = bind_user_confirm_check(vin, opts, s, ops, sc, res, &probes);
        if (cc != 0) {
            return (cc > 0) ? TLB_OK : TLB_ERR_NOT_PAIRED;
        }
        now = now_ms_of(ops);
        if (now >= deadline) {
            break;
        }
        if (now < next_probe) {
            int64_t left = deadline - now;
            int64_t ms;
            if (left < 200) {
                left = 200; // JS: Math.max(200, deadline - Date.now())
            }
            ms = (receive_ms < left) ? receive_ms : left; // JS: Math.min(receiveMs, ...)
            rc = ops->receive(ops->ud, sc->rx, sizeof(sc->rx), ms);
            has_body = (rc > 0);
            continue;
        }

        probes++;
        tlb_probe_once(vin, TLB_DOMAIN_VCSEC, s, ops, sc, &p);
        next_probe = now_ms_of(ops) + probe_interval_ms; // 探针之后再读
        if (p.paired) {
            tlb_pair_verdict(&p, probes, ops, res);
            return TLB_OK;
        }
        if (strcmp(p.text, last) != 0) {
            sb_init(&sb, last, sizeof(last));
            sb_put(&sb, p.text);
            sb_init(&sb, line, sizeof(line));
            sb_put(&sb, "探针第 ");
            sb_i64(&sb, (int64_t)probes);
            sb_put(&sb, " 次未通过：");
            sb_put(&sb, p.text);
            dlog(ops, line);
        } else {
            sb_init(&sb, line, sizeof(line));
            sb_put(&sb, "探针第 ");
            sb_i64(&sb, (int64_t)probes);
            sb_put(&sb, " 次结果同前");
            dlog(ops, line);
        }
        if (!saw_wait) {
            dlog(ops, "提示：车端始终没回 WAIT，可能根本没进入配对流程（车机屏幕有没有弹「添加钥匙」？"
                      "BLE 连接数是否已被官方 App 占满？）");
        }
        has_body = false; // 探针自己收走了响应，回到循环顶部按时间片继续等
    }

    res->wait = true;
    res->probes = probes;
    sb_init(&sb, res->text, sizeof(res->text));
    sb_put(&sb, TLB_BIND_NAME);
    sb_put(&sb, " 已发出并等待 ");
    sb_i64(&sb, (window_ms + 500) / 1000); // JS: Math.round(windowMs / 1000)
    sb_put(&sb, " 秒（探针 ");
    sb_i64(&sb, (int64_t)probes);
    sb_put(&sb, " 次），既没拿到车端 whitelistOperationStatus 终态，也建不起会话 "
                "—— 判「没绑上」。\n");
    sb_put(&sb, "最后一次探针：");
    sb_put(&sb, last[0] != '\0' ? last : "没打上");
    sb_put(&sb, "\n逐项排查：\n");
    sb_put(&sb, "1）车机屏幕有没有弹「添加钥匙 / Add key」并需要你点确认？没弹说明请求没进配对流程。\n");
    sb_put(&sb, "2）");
    sb_put(&sb, tlb_tap_hint());
    sb_put(&sb, "\n3）蓝牙连接数：一辆车同时最多约 3 个 BLE 连接（官方 Tesla App、手机钥匙、"
                "遥控钥匙共享）。请退出并杀掉官方 App 后台，或在 Tesla App > 安全 > 钥匙 "
                "里移除不用的钥匙。\n");
    sb_put(&sb, "4）车是不是睡了：踩一脚刹车让车机亮屏后，重新点「③ 绑定」——"
                "本函数每轮只发一次 add-key，重复点是为了让车机重新起配对流程。");
    return TLB_ERR_TIMEOUT;
}
