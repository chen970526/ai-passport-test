// components/tesla_core/include/tesla_core/tlb_identity.h
// 车辆 BLE 广播名规则与匹配（对齐探针 src/protocol/identity.js + src/infra/ble/device-matcher.js）。
// 纯字符串逻辑，主机与设备共用一份；金标准由探针实算导出（tools/gen_goldens.mjs）。
//
// 已知偏离（都在注释里标了 DEFER）：
//   · 探针用 UTF-16 语义数 VIN 长度（v.length >= 6），C 里按 UTF-8 字节数。
//     VIN 是 ASCII 集，非 ASCII 输入本身就是脏数据，不为它造转码层。
#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "tesla_core/tlb_types.h"

// 广播名上限：车端实际最长的是 "S" + 16 hex = 17，留一倍余量给车主自改的名字。
#define TLB_ADV_NAME_MAX 32
// 服务 UUID 字符串形式（128 位全写 36 字符 + 结尾；短格式 4 字符）
#define TLB_UUID_STR_MAX 40

typedef struct {
    // 新车型："Tesla " + VIN 后 6 位。长度不足 6 时为空串 = 这条规则不成立。
    char exact[TLB_ADV_NAME_MAX];
    // 老车型："S" + SHA1(VIN) 十六进制前 16 位（探针 toHex 出的是小写）。空串 = 不成立。
    char prefix[TLB_ADV_NAME_MAX];
} tlb_ble_names_t;

// bleNamesForVin(vin)：先 trim + 转大写，再算两条规则。vin 为 NULL/空白 → 两条都不成立。
void tlb_ble_names_for_vin(const char *vin, tlb_ble_names_t *out);

// normName(s)：转大写 + 只保留 0-9A-Z（丢掉分隔符与大小写差异）。返回写入长度（不含结尾）。
size_t tlb_norm_name(const char *s, char *out, size_t cap);

// 命中方式（mode 只进日志，用于判断「到底靠什么认出来的」）
typedef enum {
    TLB_MATCH_NONE = 0,
    TLB_MATCH_EXACT,        // 原文精确相等
    TLB_MATCH_PREFIX,       // 原文前缀
    TLB_MATCH_LOOSE,        // 归一化后相等
    TLB_MATCH_LOOSE_PREFIX  // 归一化后前缀
} tlb_match_mode_t;

// makeMatcher(names)(n)：四档依次判定，顺序与探针一致（原文两档先、归一化两档后）。
// matched 非 NULL 时写入探针 res.matched：原文两档是规则本身，归一化两档是归一化后的规则。
tlb_match_mode_t tlb_match_adv_name(const tlb_ble_names_t *names, const char *adv_name,
                                    char *matched, size_t cap);

// hasTeslaService(d) 的单个 UUID 版：归一化后等于或以 "0211" 开头。
// DEFER: 探针只匹配前缀，128 位全形式（"00000211-..."）归一化后以 "00000211" 开头 → 判 false。
// 这是探针既有行为，照抄不改；无名广播兜底因此只在回短格式时生效。
bool tlb_uuid_is_tesla_service(const char *uuid);

// 广播里是否带了特斯拉 VCSEC 服务（任一 UUID 命中即为真）
bool tlb_has_tesla_service(const char *const *uuids, size_t n);
