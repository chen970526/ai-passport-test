// components/tesla_core/include/tesla_core/tlb_types.h
// 特斯拉离线 BLE：与 ESP-IDF / LVGL 无关的公共类型与平台钩子。
// 本头文件声明的东西必须能被主机测试（MSVC/gcc）与设备固件同时编译。
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define TLB_PRIV_LEN 32   // P-256 私钥标量（大端 32 字节）
#define TLB_PUB_LEN 65    // 未压缩公钥点 0x04 || X || Y
#define TLB_SHARED_LEN 32 // ECDH X 坐标
#define TLB_KEY_LEN 16    // K = SHA1(X)[0:16]
#define TLB_EPOCH_LEN 16
#define TLB_NONCE_LEN 12
#define TLB_TAG_LEN 16
#define TLB_ADDR_LEN 16   // routing_address / uuid / challenge 一律 16 字节
#define TLB_VIN_MAX 24
#define TLB_FRAME_MAX 1024 // 车辆侧单帧上限（超过即整块丢弃重新对齐）

// universal_message.Distribution_DOMAIN（只保留本项目用得上的三档）
enum {
    TLB_DOMAIN_BROADCAST = 0,
    TLB_DOMAIN_VCSEC = 2,
    TLB_DOMAIN_INFOTAINMENT = 3
};

// signatures.SignatureType
enum {
    TLB_SIG_AES_GCM = 0,
    TLB_SIG_AES_GCM_PERSONALIZED = 5,
    TLB_SIG_HMAC = 6,
    TLB_SIG_HMAC_PERSONALIZED = 8,
    TLB_SIG_AES_GCM_RESPONSE = 9
};

// signatures.Tag —— TLV 元数据标签，写入顺序必须严格递增
enum {
    TLB_TAG_SIGNATURE_TYPE = 0,
    TLB_TAG_DOMAIN = 1,
    TLB_TAG_PERSONALIZATION = 2,
    TLB_TAG_EPOCH = 3,
    TLB_TAG_EXPIRES_AT = 4,
    TLB_TAG_COUNTER = 5,
    TLB_TAG_CHALLENGE = 6,
    TLB_TAG_FLAGS = 7,
    TLB_TAG_REQUEST_HASH = 8,
    TLB_TAG_FAULT = 9,
    TLB_TAG_END = 255
};

// universal_message.Flags 是「位」而不是枚举值
enum {
    TLB_FLAG_USER_COMMAND = 0,
    TLB_FLAG_ENCRYPT_RESPONSE = 1
};
#define TLB_FLAGS_ENCRYPT_RESPONSE (1u << TLB_FLAG_ENCRYPT_RESPONSE)

// vcsec.ToVCSECMessage 里的 signatures.SignatureType（加白名单裸信封只用到 PRESENT_KEY）
enum {
    TLB_VSEC_SIG_NONE = 0,
    TLB_VSEC_SIG_PRESENT_KEY = 2
};

// vcsec.SessionInfo_Status（握手回包 status，非 0 表示钥匙不在白名单）
enum {
    TLB_SI_STATUS_OK = 0,
    TLB_SI_STATUS_KEY_NOT_ON_WHITELIST = 1
};

// universal_message.OperationStatus_E 与 vcsec.VCOperationStatus_E（取值相同）
enum {
    TLB_OP_OK = 0,
    TLB_OP_WAIT = 1,
    TLB_OP_ERROR = 2
};

// universal_message.MessageFault_E（只列本项目会判读的取值）
typedef enum {
    TLB_FAULT_NONE = 0,
    TLB_FAULT_BUSY = 1,
    TLB_FAULT_TIMEOUT = 2,
    TLB_FAULT_UNKNOWN_KEY_ID = 3,
    TLB_FAULT_INACTIVE_KEY = 4,
    TLB_FAULT_INVALID_SIGNATURE = 5,
    TLB_FAULT_INVALID_TOKEN_OR_COUNTER = 6,
    TLB_FAULT_INSUFFICIENT_PRIVILEGES = 7,
    TLB_FAULT_INCORRECT_EPOCH = 15,
    TLB_FAULT_IV_INCORRECT_LENGTH = 16,
    TLB_FAULT_TIME_EXPIRED = 17,
    TLB_FAULT_RESPONSE_MTU_EXCEEDED = 25,
    TLB_FAULT_REPEATED_COUNTER = 26,
    TLB_FAULT_REQUIRES_RESPONSE_ENCRYPTION = 28
} tlb_fault_t;

// vcsec.RKEAction_E（节选）—— 与 tlb_text.c 的 E_RKE 表逐条对应，缺一个就会漏白名单。
// 探针 rke.js:KNOWN_RKE = [0,1,20,29,30]，设备侧的白名单以这五个值为准。
enum {
    TLB_RKE_UNLOCK = 0,
    TLB_RKE_LOCK = 1,
    TLB_RKE_REMOTE_DRIVE = 20,
    TLB_RKE_AUTO_SECURE = 29,
    TLB_RKE_WAKE_VEHICLE = 30
};

// 官方现行 RKEAction_E 里被识别的动作号；不在表内的值一律不下发（见 tlb_app.c:handle_rke）。
static inline bool tlb_rke_action_known(int32_t action)
{
    return action == TLB_RKE_UNLOCK || action == TLB_RKE_LOCK ||
           action == TLB_RKE_REMOTE_DRIVE || action == TLB_RKE_AUTO_SECURE ||
           action == TLB_RKE_WAKE_VEHICLE;
}

// vcsec.ClosureMoveType_E（后备箱指令只用到 OPEN=3；注意与回包用的 ClosureState_E 不是一张表）
enum {
    TLB_CLOSURE_MOVE_NONE = 0,
    TLB_CLOSURE_MOVE_MOVE = 1,
    TLB_CLOSURE_MOVE_STOP = 2,
    TLB_CLOSURE_MOVE_OPEN = 3,
    TLB_CLOSURE_MOVE_CLOSE = 4
};

// vcsec.ClosureState_E（vehicleStatus.closureStatuses 的回包状态）
enum {
    TLB_CLOSURE_CLOSED = 0,
    TLB_CLOSURE_OPEN = 1,
    TLB_CLOSURE_AJAR = 2,
    TLB_CLOSURE_UNKNOWN = 3,
    TLB_CLOSURE_FAILED_UNLATCH = 4,
    TLB_CLOSURE_OPENING = 5,
    TLB_CLOSURE_CLOSING = 6
};

// vcsec.VehicleLockState_E（vehicleStatus.vehicleLockState；proto3 省略 0 = 解锁）
enum {
    TLB_VEHICLE_UNLOCKED = 0,
    TLB_VEHICLE_LOCKED = 1,
    TLB_VEHICLE_INTERNAL_LOCKED = 2,
    TLB_VEHICLE_SELECTIVE_UNLOCKED = 3
};

// keys.Role（绑定时写 PermissionChange.keyRole）
enum {
    TLB_ROLE_NONE = 0,
    TLB_ROLE_SERVICE = 1,
    TLB_ROLE_OWNER = 2,
    TLB_ROLE_DRIVER = 3,
    TLB_ROLE_FM = 4,
    TLB_ROLE_VEHICLE_MONITOR = 5,
    TLB_ROLE_CHARGING_MANAGER = 6,
    TLB_ROLE_GUEST = 8
};

// vcsec.KeyFormFactor
enum {
    TLB_FF_UNKNOWN = 0,
    TLB_FF_NFC_CARD = 1,
    TLB_FF_IOS_DEVICE = 6,
    TLB_FF_ANDROID_DEVICE = 7,
    TLB_FF_CLOUD_KEY = 9
};

// 统一的引擎返回码
typedef enum {
    TLB_OK = 0,
    TLB_ERR_LINK = -1,      // BLE 读写失败 / 未连接
    TLB_ERR_PROTO = -2,     // 报文解码失败
    TLB_ERR_CRYPTO = -3,    // ECDH / GCM tag 校验失败
    TLB_ERR_TIMEOUT = -4,   // 等待响应超时
    TLB_ERR_REFUSED = -5,   // 协议层 fault（非重试类）
    TLB_ERR_DENIED = -6,    // 应用层拒绝（车辆明确说不行）
    TLB_ERR_NOT_PAIRED = -7, // 钥匙不在白名单（SESSION_INFO_STATUS_KEY_NOT_ON_WHITELIST）
    TLB_ERR_NO_KEY = -8,    // 本机还没有密钥
    TLB_ERR_STATE = -9,     // 状态机顺序错误
    TLB_ERR_RANGE = -10     // counter 到顶等边界
} tlb_err_t;

// 日志钩子：core 里所有需要输出的地方都走这里，主机测试可注入收集器
typedef void (*tlb_log_fn)(void *ud, const char *text);

// ---------------------------------------------------------------- 平台钩子
// 由设备层（mbedTLS / esp_rng / FreeRTOS 时钟）或主机测试实现。
void tlb_port_random(uint8_t *out, size_t len);
bool tlb_port_ecdh(const uint8_t priv[TLB_PRIV_LEN], const uint8_t pub[TLB_PUB_LEN],
                   uint8_t out[TLB_SHARED_LEN]);
// 毫秒时钟：主机测试里可以是虚拟时间，设备上用 esp_timer_get_time()/1000
int64_t tlb_port_now_ms(void);

// 引擎对外的收发接口（设备层用 NimBLE 实现，主机测试用脚本回放实现）
typedef struct {
    void *ud;
    // 发出一个完整帧体（不含 2 字节长度前缀；由实现负责分包）
    bool (*write)(void *ud, const uint8_t *data, size_t len);
    // 收到一个完整帧体；timeout_ms 内没等到返回 <=0
    int (*read)(void *ud, uint8_t *out, size_t cap, int timeout_ms);
} tlb_io_t;
