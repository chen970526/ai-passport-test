// components/tesla_core/include/tesla_core/tlb_text.h
// 判读文案：枚举名与中文提示。
// 权威依据：探针 src/protocol/v3/spec.js（枚举表）、summary.js（label 规则）、
// src/domain/response-hints.js（FAULT_HINT / GENERIC_ERROR_HINTS）。
// 文案必须与探针逐字一致，否则日志比对会出假差异。
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// 枚举表名（与 spec.js V3_ENUMS 的键一一对应）
#define TLB_EN_DOMAIN "Domain"
#define TLB_EN_UM_OP "UMOperationStatus_E"
#define TLB_EN_VC_OP "VCOperationStatus_E"
#define TLB_EN_FAULT "MessageFault_E"
#define TLB_EN_SMI "SignedMessage_information_E"
#define TLB_EN_WL_INFO "WhitelistOperation_information_E"
#define TLB_EN_GENERIC "GenericError_E"
#define TLB_EN_SI_STATUS "Session_Info_Status"
#define TLB_EN_RKE "RKEAction_E"

// label(enumName, value)：命中 → "NAME(value)"，未命中 → "未知(value)"
// out 容量不足时截断但仍返回 out（文案只用于人读，不参与判读）
void tlb_label(const char *enum_name, uint32_t value, char *out, size_t cap);
// 对应 JS 里 value === undefined 的一档："(默认0)"
void tlb_label_opt(const char *enum_name, uint32_t value, bool present, char *out, size_t cap);

// pb.js:enumLabel —— inspect() 用的另一套形状：命中 "NAME(v)"，未命中 "?(v)"，无表 "v"
void tlb_enum_label(const char *enum_name, uint32_t value, char *out, size_t cap);

// domainText(domain) = label('Domain', domain)
void tlb_domain_text(uint32_t domain, char *out, size_t cap);

// Fault → 下一步提示（只覆盖 24 / 25，其余返回空串）
const char *tlb_fault_hint(uint32_t fault);

// appOutcome 渲染出的 "GENERICERROR_XXX(n)" → 下一步提示；按枚举名子串匹配，无命中返回空串
const char *tlb_generic_error_hint(const char *text);

// response-hints.js:TAP_HINT —— 白名单被拒 / 会话未加白时的刷卡提示（原文，用于拼接）
const char *tlb_tap_hint(void);
