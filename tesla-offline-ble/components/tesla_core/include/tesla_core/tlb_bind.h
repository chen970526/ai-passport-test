// components/tesla_core/include/tesla_core/tlb_bind.h
// 入白名单（绑定钥匙）：会话探针 + 裸 PRESENT_KEY 配对状态机。
// 权威依据：探针 src/domain/enrollment-service.js（其上游是官方
// pkg/vehicle/security.go:324/338 与 0Bu main/vehicle_pairing.cpp:240-301）。
//
// 本文件里所有「返回给用户看的字符串」必须与探针逐字一致：现场是靠这些文案定位的。
// 只有纯日志行允许简化（见 tlb_bind.c 各函数注释里标了「偏离」的地方）。
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "tesla_core/tlb_dispatch.h"
#include "tesla_core/tlb_types.h"
#include "tesla_core/tlb_v3.h"

// 绑定时序常量 —— 探针 dispatch-policy.js:63-66
// 这四个值在探针里可以用 opts 覆盖，只为把「探针命中 / 窗口耗尽」两条慢路径
// 压进秒级做离线回归；默认值不改变任何协议字节。
#define TLB_PAIR_WINDOW_MS 150000LL  // 整个绑定窗口（含人刷卡 + 车机屏幕确认的动手时间）
#define TLB_PAIR_RECEIVE_MS 2500LL   // 每一片「只收不发」的时间片
#define TLB_PROBE_FIRST_MS 8000LL    // 发完请求后先等 8 秒再打第一针
#define TLB_PROBE_INTERVAL_MS 5000LL // 之后每 5 秒一针

// 绑定结果文案：窗口耗尽那条分支 = 固定排查清单（约 1.2KB）+ 最后一次探针原文（TLB_TEXT_MAX）
#define TLB_BIND_TEXT_MAX 2560
// 探针文案 = 握手 msg（TLB_TEXT_MAX）+ 「会话已建立（…）」的包裹
#define TLB_PROBE_TEXT_MAX (TLB_TEXT_MAX + 64)

// 车机钥匙列表里显示的名字（用户定案社区品牌名；旧值「AddKey（刷卡配对）」
// 仅探针参考实现用过，无任何协议/服务依赖此字面量，改名安全）。
#define TLB_BIND_NAME "AI-passport"

// 探针 pick()：只接受「有限正数」，否则回落默认值 —— C 侧等价判据是 opts==NULL || v<=0
typedef struct {
    int64_t window_ms;
    int64_t receive_ms;
    int64_t probe_first_ms;
    int64_t probe_interval_ms;
    uint32_t form_factor; // has_form_factor=false 时用 TLB_FF_ANDROID_DEVICE
    bool has_form_factor;
    bool force; // 仅 probe_enrollment：忽略现成会话，强行打一针
    // 引导页「我已确认」按钮（设备层注入，消费式：按下后首次调用返回 true 并清标志）。
    // bindKey 等待循环每个时间片检查：按下 → 立即打一针 —— 通过马上成功返回；
    // 未通过立即结束等待返回可读失败，不再空耗剩余窗口（用户可贴卡后再按重试）。
    bool (*user_confirm)(void);
} tlb_bind_opts_t;

// 探针 probeOnce 的返回形状
typedef struct {
    bool paired;
    bool not_whitelisted;
    bool retryable;
    char text[TLB_PROBE_TEXT_MAX];
} tlb_probe_t;

// 探针 bindKey / probeEnrollment 的返回形状（各分支只会置用得到的那几个）
typedef struct {
    bool ok;
    bool paired;
    bool reused;         // probeEnrollment：直接复用现成会话
    bool already;        // bindKey 阶段 0：早就绑好了
    bool wait;           // bindKey：窗口耗尽，既没终态也建不起会话
    bool not_whitelisted;
    bool has_info;
    uint32_t info;       // whitelistOperationInformation
    int probes;          // 打了几针
    char text[TLB_BIND_TEXT_MAX];
} tlb_bind_result_t;

// 探针 v3-context.js:teslaKeyId —— SHA1(65 字节未压缩公钥) 前 4 字节的大写冒号十六进制
// 无密钥（JS 里 myKeyId() 长度不足 8）时出 "-"
void tlb_tesla_key_id(const tlb_dispatch_ops_t *ops, char *out, size_t cap);

// 探针 enrollment-service.js:probeOnce
// 先作废会话（绝不留半成品 K），再打一次 handshakeOnce；成功即视为「钥匙已在白名单」。
void tlb_probe_once(const char *vin, uint32_t domain, tlb_v3_session_t *s,
                    const tlb_dispatch_ops_t *ops, tlb_dispatch_scratch_t *sc, tlb_probe_t *res);

// 探针 enrollment-service.js:pairVerdict —— 把「探针第 N 次确认」写成人话收尾
void tlb_pair_verdict(const tlb_probe_t *p, int attempt, const tlb_dispatch_ops_t *ops,
                      tlb_bind_result_t *res);

// 探针 enrollment-service.js:probeEnrollment —— 页面上的「④ 探针确认」
// 偏离：JS 的 mustConnect()/mustKey() 抛异常，C 侧按调度层既有口径收成 res->text + 错误码
tlb_err_t tlb_probe_enrollment(const char *vin, const tlb_bind_opts_t *opts, tlb_v3_session_t *s,
                               const tlb_dispatch_ops_t *ops, tlb_dispatch_scratch_t *sc,
                               tlb_bind_result_t *res);

// 探针 enrollment-service.js:bindKey —— 主绑定路径（官方 security.go:338）
// 三段状态机：0 预探针（已绑则绝不再发 add-key）→ 1 发且仅发一次裸 PRESENT_KEY
// → 2 「收回执 2.5s 一片」与「每 5s 一针会话探针」交替，谁先来算谁。
// WAIT 只记日志，**绝不重发**（重发会把配对窗口重新开始计时）。
// 偏离：JS 里 vin 只用于 ensureKey，实际发送用 state.vin；C 只有一个 vin 入参，两者同源。
tlb_err_t tlb_bind_key(const char *vin, const tlb_bind_opts_t *opts, tlb_v3_session_t *s,
                       const tlb_dispatch_ops_t *ops, tlb_dispatch_scratch_t *sc,
                       tlb_bind_result_t *res);
