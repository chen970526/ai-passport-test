// components/tesla_core/src/tlb_text.c
// 枚举表与提示文案，逐字照抄探针：
//   src/protocol/v3/spec.js            → V3_ENUMS
//   src/protocol/v3/summary.js         → label() 的三种输出形状
//   src/domain/response-hints.js       → FAULT_HINT / GENERIC_ERROR_HINTS
#include "tesla_core/tlb_text.h"

#include <stdio.h>
#include <string.h>

typedef struct {
    const char *name;
    uint32_t value;
} tlb_enum_item_t;

typedef struct {
    const char *name;
    const tlb_enum_item_t *items;
    size_t count;
} tlb_enum_table_t;

static const tlb_enum_item_t E_DOMAIN[] = {
    {"DOMAIN_BROADCAST", 0},
    {"DOMAIN_VEHICLE_SECURITY", 2},
    {"DOMAIN_INFOTAINMENT", 3},
};

static const tlb_enum_item_t E_OP_STATUS[] = {
    {"OPERATIONSTATUS_OK", 0},
    {"OPERATIONSTATUS_WAIT", 1},
    {"OPERATIONSTATUS_ERROR", 2},
};

static const tlb_enum_item_t E_FAULT[] = {
    {"MESSAGEFAULT_ERROR_NONE", 0},
    {"MESSAGEFAULT_ERROR_BUSY", 1},
    {"MESSAGEFAULT_ERROR_TIMEOUT", 2},
    {"MESSAGEFAULT_ERROR_UNKNOWN_KEY_ID", 3},
    {"MESSAGEFAULT_ERROR_INACTIVE_KEY", 4},
    {"MESSAGEFAULT_ERROR_INVALID_SIGNATURE", 5},
    {"MESSAGEFAULT_ERROR_INVALID_TOKEN_OR_COUNTER", 6},
    {"MESSAGEFAULT_ERROR_INSUFFICIENT_PRIVILEGES", 7},
    {"MESSAGEFAULT_ERROR_INVALID_DOMAINS", 8},
    {"MESSAGEFAULT_ERROR_INVALID_COMMAND", 9},
    {"MESSAGEFAULT_ERROR_DECODING", 10},
    {"MESSAGEFAULT_ERROR_INTERNAL", 11},
    {"MESSAGEFAULT_ERROR_WRONG_PERSONALIZATION", 12},
    {"MESSAGEFAULT_ERROR_BAD_PARAMETER", 13},
    {"MESSAGEFAULT_ERROR_KEYCHAIN_IS_FULL", 14},
    {"MESSAGEFAULT_ERROR_INCORRECT_EPOCH", 15},
    {"MESSAGEFAULT_ERROR_IV_INCORRECT_LENGTH", 16},
    {"MESSAGEFAULT_ERROR_TIME_EXPIRED", 17},
    {"MESSAGEFAULT_ERROR_NOT_PROVISIONED_WITH_IDENTITY", 18},
    {"MESSAGEFAULT_ERROR_COULD_NOT_HASH_METADATA", 19},
    {"MESSAGEFAULT_ERROR_TIME_TO_LIVE_TOO_LONG", 20},
    {"MESSAGEFAULT_ERROR_REMOTE_ACCESS_DISABLED", 21},
    {"MESSAGEFAULT_ERROR_REMOTE_SERVICE_ACCESS_DISABLED", 22},
    {"MESSAGEFAULT_ERROR_COMMAND_REQUIRES_ACCOUNT_CREDENTIALS", 23},
    {"MESSAGEFAULT_ERROR_REQUEST_MTU_EXCEEDED", 24},
    {"MESSAGEFAULT_ERROR_RESPONSE_MTU_EXCEEDED", 25},
    {"MESSAGEFAULT_ERROR_REPEATED_COUNTER", 26},
    {"MESSAGEFAULT_ERROR_INVALID_KEY_HANDLE", 27},
    {"MESSAGEFAULT_ERROR_REQUIRES_RESPONSE_ENCRYPTION", 28},
};

static const tlb_enum_item_t E_SMI[] = {
    {"SIGNEDMESSAGE_INFORMATION_NONE", 0},
    {"SIGNEDMESSAGE_INFORMATION_FAULT_UNKNOWN", 1},
    {"SIGNEDMESSAGE_INFORMATION_FAULT_NOT_ON_WHITELIST", 2},
    {"SIGNEDMESSAGE_INFORMATION_FAULT_IV_SMALLER_THAN_EXPECTED", 3},
    {"SIGNEDMESSAGE_INFORMATION_FAULT_INVALID_TOKEN", 4},
    {"SIGNEDMESSAGE_INFORMATION_FAULT_TOKEN_AND_COUNTER_INVALID", 5},
    {"SIGNEDMESSAGE_INFORMATION_FAULT_AES_DECRYPT_AUTH", 6},
    {"SIGNEDMESSAGE_INFORMATION_FAULT_ECDSA_INPUT", 7},
    {"SIGNEDMESSAGE_INFORMATION_FAULT_ECDSA_SIGNATURE", 8},
    {"SIGNEDMESSAGE_INFORMATION_FAULT_LOCAL_ENTITY_START", 9},
    {"SIGNEDMESSAGE_INFORMATION_FAULT_LOCAL_ENTITY_RESULT", 10},
    {"SIGNEDMESSAGE_INFORMATION_FAULT_COULD_NOT_RETRIEVE_KEY", 11},
    {"SIGNEDMESSAGE_INFORMATION_FAULT_COULD_NOT_RETRIEVE_TOKEN", 12},
    {"SIGNEDMESSAGE_INFORMATION_FAULT_SIGNATURE_TOO_SHORT", 13},
    {"SIGNEDMESSAGE_INFORMATION_FAULT_TOKEN_IS_INCORRECT_LENGTH", 14},
    {"SIGNEDMESSAGE_INFORMATION_FAULT_INCORRECT_EPOCH", 15},
    {"SIGNEDMESSAGE_INFORMATION_FAULT_IV_INCORRECT_LENGTH", 16},
    {"SIGNEDMESSAGE_INFORMATION_FAULT_TIME_EXPIRED", 17},
    {"SIGNEDMESSAGE_INFORMATION_FAULT_NOT_PROVISIONED_WITH_IDENTITY", 18},
    {"SIGNEDMESSAGE_INFORMATION_FAULT_COULD_NOT_HASH_METADATA", 19},
};

static const tlb_enum_item_t E_WL_INFO[] = {
    {"WHITELISTOPERATION_INFORMATION_NONE", 0},
    {"WHITELISTOPERATION_INFORMATION_UNDOCUMENTED_ERROR", 1},
    {"WHITELISTOPERATION_INFORMATION_NO_PERMISSION_TO_REMOVE_ONESELF", 2},
    {"WHITELISTOPERATION_INFORMATION_KEYFOB_SLOTS_FULL", 3},
    {"WHITELISTOPERATION_INFORMATION_WHITELIST_FULL", 4},
    {"WHITELISTOPERATION_INFORMATION_NO_PERMISSION_TO_ADD", 5},
    {"WHITELISTOPERATION_INFORMATION_INVALID_PUBLIC_KEY", 6},
    {"WHITELISTOPERATION_INFORMATION_NO_PERMISSION_TO_REMOVE", 7},
    {"WHITELISTOPERATION_INFORMATION_NO_PERMISSION_TO_CHANGE_PERMISSIONS", 8},
    {"WHITELISTOPERATION_INFORMATION_ATTEMPTING_TO_ELEVATE_OTHER_ABOVE_ONESELF", 9},
    {"WHITELISTOPERATION_INFORMATION_ATTEMPTING_TO_DEMOTE_SUPERIOR_TO_ONESELF", 10},
    {"WHITELISTOPERATION_INFORMATION_ATTEMPTING_TO_REMOVE_OWN_PERMISSIONS", 11},
    {"WHITELISTOPERATION_INFORMATION_PUBLIC_KEY_NOT_ON_WHITELIST", 12},
    {"WHITELISTOPERATION_INFORMATION_ATTEMPTING_TO_ADD_KEY_THAT_IS_ALREADY_ON_THE_WHITELIST", 13},
    {"WHITELISTOPERATION_INFORMATION_NOT_ALLOWED_TO_ADD_UNLESS_ON_READER", 14},
    {"WHITELISTOPERATION_INFORMATION_FM_MODIFYING_OUTSIDE_OF_F_MODE", 15},
    {"WHITELISTOPERATION_INFORMATION_FM_ATTEMPTING_TO_ADD_PERMANENT_KEY", 16},
    {"WHITELISTOPERATION_INFORMATION_FM_ATTEMPTING_TO_REMOVE_PERMANENT_KEY", 17},
    {"WHITELISTOPERATION_INFORMATION_KEYCHAIN_WHILE_FS_FULL", 18},
    {"WHITELISTOPERATION_INFORMATION_ATTEMPTING_TO_ADD_KEY_WITHOUT_ROLE", 19},
    {"WHITELISTOPERATION_INFORMATION_ATTEMPTING_TO_ADD_KEY_WITH_SERVICE_ROLE", 20},
    {"WHITELISTOPERATION_INFORMATION_NON_SERVICE_KEY_ATTEMPTING_TO_ADD_SERVICE_TECH", 21},
    {"WHITELISTOPERATION_INFORMATION_SERVICE_KEY_ATTEMPTING_TO_ADD_SERVICE_TECH_OUTSIDE_SERVICE_MODE", 22},
    {"WHITELISTOPERATION_INFORMATION_COULD_NOT_START_LOCAL_ENTITY_AUTH", 23},
    {"WHITELISTOPERATION_INFORMATION_LOCAL_ENTITY_AUTH_FAILED_UI_DENIED", 24},
    {"WHITELISTOPERATION_INFORMATION_LOCAL_ENTITY_AUTH_FAILED_TIMED_OUT_WAITING_FOR_TAP", 25},
    {"WHITELISTOPERATION_INFORMATION_LOCAL_ENTITY_AUTH_FAILED_TIMED_OUT_WAITING_FOR_UI_ACK", 26},
    {"WHITELISTOPERATION_INFORMATION_LOCAL_ENTITY_AUTH_FAILED_VALET_MODE", 27},
    {"WHITELISTOPERATION_INFORMATION_LOCAL_ENTITY_AUTH_FAILED_CANCELLED", 28},
};

static const tlb_enum_item_t E_GENERIC[] = {
    {"GENERICERROR_NONE", 0},
    {"GENERICERROR_UNKNOWN", 1},
    {"GENERICERROR_CLOSURES_OPEN", 2},
    {"GENERICERROR_ALREADY_ON", 3},
    {"GENERICERROR_DISABLED_FOR_USER_COMMAND", 4},
    {"GENERICERROR_VEHICLE_NOT_IN_PARK", 5},
    {"GENERICERROR_UNAUTHORIZED", 6},
    {"GENERICERROR_NOT_ALLOWED_OVER_TRANSPORT", 7},
};

static const tlb_enum_item_t E_SI_STATUS[] = {
    {"SESSION_INFO_STATUS_OK", 0},
    {"SESSION_INFO_STATUS_KEY_NOT_ON_WHITELIST", 1},
};

// spec.js V3_ENUMS.RKEAction_E（L147-153）：探针 sendRke 的 label('RKEAction_E', action) 全靠它
static const tlb_enum_item_t E_RKE[] = {
    {"RKE_ACTION_UNLOCK", 0},
    {"RKE_ACTION_LOCK", 1},
    {"RKE_ACTION_REMOTE_DRIVE", 20},
    {"RKE_ACTION_AUTO_SECURE_VEHICLE", 29},
    {"RKE_ACTION_WAKE_VEHICLE", 30},
};

#define TLB_TABLE(nm, arr) { nm, arr, sizeof(arr) / sizeof(arr[0]) }

static const tlb_enum_table_t TABLES[] = {
    TLB_TABLE(TLB_EN_DOMAIN, E_DOMAIN),
    TLB_TABLE(TLB_EN_UM_OP, E_OP_STATUS),
    TLB_TABLE(TLB_EN_VC_OP, E_OP_STATUS),
    TLB_TABLE(TLB_EN_FAULT, E_FAULT),
    TLB_TABLE(TLB_EN_SMI, E_SMI),
    TLB_TABLE(TLB_EN_WL_INFO, E_WL_INFO),
    TLB_TABLE(TLB_EN_GENERIC, E_GENERIC),
    TLB_TABLE(TLB_EN_SI_STATUS, E_SI_STATUS),
    TLB_TABLE(TLB_EN_RKE, E_RKE),
};
#undef TLB_TABLE

static const tlb_enum_table_t *find_table(const char *enum_name)
{
    size_t i;
    for (i = 0; i < sizeof(TABLES) / sizeof(TABLES[0]); i++) {
        if (strcmp(TABLES[i].name, enum_name) == 0) {
            return &TABLES[i];
        }
    }
    return NULL;
}

void tlb_label(const char *enum_name, uint32_t value, char *out, size_t cap)
{
    const tlb_enum_table_t *t;
    size_t i;

    if (!out || cap == 0) {
        return;
    }
    out[0] = '\0';
    t = enum_name ? find_table(enum_name) : NULL;
    if (!t) {
        snprintf(out, cap, "%lu", (unsigned long)value);
        return;
    }
    for (i = 0; i < t->count; i++) {
        if (t->items[i].value == value) {
            snprintf(out, cap, "%s(%lu)", t->items[i].name, (unsigned long)value);
            return;
        }
    }
    snprintf(out, cap, "未知(%lu)", (unsigned long)value);
}

void tlb_label_opt(const char *enum_name, uint32_t value, bool present, char *out, size_t cap)
{
    if (!out || cap == 0) {
        return;
    }
    if (!present) {
        snprintf(out, cap, "%s", "(默认0)");
        return;
    }
    tlb_label(enum_name, value, out, cap);
}

// pb.js:enumLabel —— inspect() 里枚举的渲染形状与 label() 不同（未命中是 "?"）
void tlb_enum_label(const char *enum_name, uint32_t value, char *out, size_t cap)
{
    const tlb_enum_table_t *t;
    size_t i;

    if (!out || cap == 0) {
        return;
    }
    out[0] = '\0';
    t = enum_name ? find_table(enum_name) : NULL;
    if (!t) {
        snprintf(out, cap, "%lu", (unsigned long)value);
        return;
    }
    for (i = 0; i < t->count; i++) {
        if (t->items[i].value == value) {
            snprintf(out, cap, "%s(%lu)", t->items[i].name, (unsigned long)value);
            return;
        }
    }
    snprintf(out, cap, "?(%lu)", (unsigned long)value);
}

void tlb_domain_text(uint32_t domain, char *out, size_t cap)
{
    tlb_label(TLB_EN_DOMAIN, domain, out, cap);
}

// response-hints.js:FAULT_HINT —— 只有两个 MTU 码带提示
const char *tlb_fault_hint(uint32_t fault)
{
    switch (fault) {
    case 24:
        return "请求体比协商的 MTU 还大，车辆压根没解析它：本项目已经做到一条 vehicleAction 一包、"
               "车辆信息每类一问，再撞上就看日志里 MTU 协商到了多少";
    case 25:
        return "答案太大、这一包装不下，所以车辆直接不发数据：车辆信息已经按「每类一条」拆开发问，"
               "单类仍超包说明这一类本身就装不进当前 MTU，只能把 MTU 谈高（见日志 MTU 行）或少问这一类";
    default:
        return "";
    }
}

// response-hints.js:TAP_HINT —— 逐字复制；探针在「车辆拒绝建立会话（status=1）」与
// 白名单被拒两处拼进返回值，金标准会逐字比对
const char *tlb_tap_hint(void)
{
    return "必须用 Tesla 实体钥匙卡（或钥匙遥控器），手机 NFC 贴读卡区无效——车端只读 RFID 卡，不做手机卡模拟。"
           "读卡区（官方说明）：Model 3/Y = 中控台杯架后方；Model S/X/Cybertruck = 左侧无线充电板顶部往下刷。"
           "刷卡后还要在车机屏幕点「确认」，官方文档要求两步齐全才会落库";
}

// response-hints.js:GENERIC_ERROR_HINTS —— 按枚举名子串匹配，顺序即匹配优先级
static const struct {
    const char *key;
    const char *hint;
} GENERIC_HINTS[] = {
    {"GENERICERROR_CLOSURES_OPEN",
     "有门 / 前备箱 / 后备箱没关严，车辆拒绝这个动作：先让所有开度归零再按（车主手册里「锁不上先检查门有没有关好」就是这个）"},
    {"GENERICERROR_ALREADY_ON",
     "车辆已经处于上电 / 驾驶授权状态：RemoteDrive 是「让车可以开走」的开关，重复请求会被这里挡下。"
     "反过来说，锁车撞上这个码通常是车还没从授权状态里退出来——先下车、挂 P、再锁；"
     "手机钥匙留在车内时车辆也会故意拒绝上锁（防止把手机锁在车里），这不是链路故障"},
    {"GENERICERROR_DISABLED_FOR_USER_COMMAND",
     "这条命令被车机里的用户开关关了：去车机「安全」/「手机 App 车控」一类设置里确认它没被禁用"},
    {"GENERICERROR_VEHICLE_NOT_IN_PARK",
     "车辆不在 P 挡：RemoteDrive 只给停稳挂 P 的车做驾驶授权，先把它停回 P 再按"},
    {"GENERICERROR_UNAUTHORIZED",
     "这把钥匙的权限不够（官方 protocol.md:187-198：能授权哪些命令由角色决定）。本项目按 ROLE_DRIVER 加白，"
     "仍被拒说明这台车对驾驶授权要求更高级别的钥匙（例如车主钥匙）"},
    {"GENERICERROR_NOT_ALLOWED_OVER_TRANSPORT",
     "车端明确不允许这条命令走当前 transport（官方 errors.proto:17 GENERICERROR_NOT_ALLOWED_OVER_TRANSPORT）。"
     "注意这不是 SDK 的限制：官方把同一个 RemoteDrive() 同时挂在 BLE CLI（commands.go:311 \"drive\"）和 Fleet "
     "命令（proxy/command.go:207 \"remote_start_drive\"）上，"
     "是这台车的策略只放其中一条。BLE 侧无解，改走 Wi-Fi/Internet + Tesla Fleet API 的 remote_start_drive 完成驾驶授权"},
};

const char *tlb_generic_error_hint(const char *text)
{
    size_t i;
    if (!text || !*text) {
        return "";
    }
    for (i = 0; i < sizeof(GENERIC_HINTS) / sizeof(GENERIC_HINTS[0]); i++) {
        if (strstr(text, GENERIC_HINTS[i].key)) {
            return GENERIC_HINTS[i].hint;
        }
    }
    return "";
}
