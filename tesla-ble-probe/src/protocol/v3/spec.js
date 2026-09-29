// Tesla V3（UniversalMessage / RoutableMessage）protobuf 规格表
//
// 权威来源：github.com/teslamotors/vehicle-command  pkg/protocol/protobuf/
//   universal_message.proto / signatures.proto / vcsec.proto / keys.proto / errors.proto
//   car_server.proto / vehicle.proto / common.proto      ← INFOTAINMENT（车机）侧三张表
// 以及 pkg/protocol/protocol.md（字段语义、TLV 元数据、测试向量）。
//
// 本项目只认这一套协议：
//   RoutableMessage + session_info 握手 + AES_GCM_Personalized_data + 12 字节 nonce + SHA256(TLV) AAD
//
// kind: 'int' | 'enum' | 'bool' | 'fixed32' | 'u64' | 'sint' | 'float' | 'double' | 'bytes' | 'string' | 'msg'
// 字段名一律照抄 .proto 原文（Universal/Signatures 用 snake_case，VCSEC 用 camelCase），
// 这样报文控制台里粘的 JSON 能和官方文档逐字对上。
//
// 第三个维度是 oneof：oo('<组名>', 字段) 表示该字段属于 .proto 里同名 oneof 的一个成员。
// protobuf 规定 oneof 成员一律是「显式存在」（explicit presence）——就算值是 0 / 空 bytes /
// 空 message 也必须写 tag，否则整条消息会退化成 0 字节（UNLOCK 就是栽在这里）。
// pb.js 编码时据此跳过「proto3 默认值省略」，并校验同一组最多只给一个成员。

const en = (name, num, enumName) => ({ name, num, kind: 'enum', enum: enumName });
const u32 = (name, num) => ({ name, num, kind: 'int' });
const fx = (name, num) => ({ name, num, kind: 'fixed32' });
const by = (name, num) => ({ name, num, kind: 'bytes' });
const ms = (name, num, msg) => ({ name, num, kind: 'msg', msg });
const oo = (group, f) => Object.assign({}, f, { oneof: group });
// ---- car_server / vehicle 侧常用类型
const bl = (name, num) => ({ name, num, kind: 'bool' });
const f32 = (name, num) => ({ name, num, kind: 'float' });
const u64 = (name, num) => ({ name, num, kind: 'u64' });
const sz = (name, num) => ({ name, num, kind: 'sint' });
const st = (name, num) => ({ name, num, kind: 'string' });
// vehicle.proto 里成百上千个字段写成 `oneof optional_<字段名> { T x = n; }`
// （proto3 `optional` 语法的展开形式），组名就是 optional_ + 字段名，逐字照抄。
const oT = (f) => oo('optional_' + f.name, f);
const ob = (name, num) => oT(bl(name, num));
const oi = (name, num) => oT(u32(name, num));
const of = (name, num) => oT(f32(name, num));
const ou = (name, num) => oT(u64(name, num));
const os = (name, num) => oT(st(name, num));
const oe = (name, num, enumName) => oT(en(name, num, enumName));
const om = (name, num, msg) => oT(ms(name, num, msg));
// 「伪枚举」：ShiftState / ChargingState / ChargePortLatchState 这类
//   message X { oneof type { Void A = 1; Void B = 2; } }
// 值靠「哪个字段存在」表达，解码结果形如 { P: {} }。
const okind = (name, num) => oo('type', ms(name, num, 'Void'));

export const V3_ENUMS = {
  // ---- UniversalMessage
  Domain: {
    DOMAIN_BROADCAST: 0,
    DOMAIN_VEHICLE_SECURITY: 2,
    DOMAIN_INFOTAINMENT: 3
  },
  UMOperationStatus_E: {
    OPERATIONSTATUS_OK: 0,
    OPERATIONSTATUS_WAIT: 1,
    OPERATIONSTATUS_ERROR: 2
  },
  MessageFault_E: {
    MESSAGEFAULT_ERROR_NONE: 0,
    MESSAGEFAULT_ERROR_BUSY: 1,
    MESSAGEFAULT_ERROR_TIMEOUT: 2,
    MESSAGEFAULT_ERROR_UNKNOWN_KEY_ID: 3,
    MESSAGEFAULT_ERROR_INACTIVE_KEY: 4,
    MESSAGEFAULT_ERROR_INVALID_SIGNATURE: 5,
    MESSAGEFAULT_ERROR_INVALID_TOKEN_OR_COUNTER: 6,
    MESSAGEFAULT_ERROR_INSUFFICIENT_PRIVILEGES: 7,
    MESSAGEFAULT_ERROR_INVALID_DOMAINS: 8,
    MESSAGEFAULT_ERROR_INVALID_COMMAND: 9,
    MESSAGEFAULT_ERROR_DECODING: 10,
    MESSAGEFAULT_ERROR_INTERNAL: 11,
    MESSAGEFAULT_ERROR_WRONG_PERSONALIZATION: 12,
    MESSAGEFAULT_ERROR_BAD_PARAMETER: 13,
    MESSAGEFAULT_ERROR_KEYCHAIN_IS_FULL: 14,
    MESSAGEFAULT_ERROR_INCORRECT_EPOCH: 15,
    MESSAGEFAULT_ERROR_IV_INCORRECT_LENGTH: 16,
    MESSAGEFAULT_ERROR_TIME_EXPIRED: 17,
    MESSAGEFAULT_ERROR_NOT_PROVISIONED_WITH_IDENTITY: 18,
    MESSAGEFAULT_ERROR_COULD_NOT_HASH_METADATA: 19,
    MESSAGEFAULT_ERROR_TIME_TO_LIVE_TOO_LONG: 20,
    MESSAGEFAULT_ERROR_REMOTE_ACCESS_DISABLED: 21,
    MESSAGEFAULT_ERROR_REMOTE_SERVICE_ACCESS_DISABLED: 22,
    MESSAGEFAULT_ERROR_COMMAND_REQUIRES_ACCOUNT_CREDENTIALS: 23,
    MESSAGEFAULT_ERROR_REQUEST_MTU_EXCEEDED: 24,
    MESSAGEFAULT_ERROR_RESPONSE_MTU_EXCEEDED: 25,
    MESSAGEFAULT_ERROR_REPEATED_COUNTER: 26,
    MESSAGEFAULT_ERROR_INVALID_KEY_HANDLE: 27,
    MESSAGEFAULT_ERROR_REQUIRES_RESPONSE_ENCRYPTION: 28
  },
  // 注意：这两个是「位」，不是枚举值；flags 字段本身是 uint32 位掩码。
  Flags: {
    FLAG_USER_COMMAND: 0, // 1 << 0
    FLAG_ENCRYPT_RESPONSE: 1 // 1 << 1
  },
  // ---- Signatures
  Tag: {
    TAG_SIGNATURE_TYPE: 0,
    TAG_DOMAIN: 1,
    TAG_PERSONALIZATION: 2,
    TAG_EPOCH: 3,
    TAG_EXPIRES_AT: 4,
    TAG_COUNTER: 5,
    TAG_CHALLENGE: 6,
    TAG_FLAGS: 7,
    TAG_REQUEST_HASH: 8,
    TAG_FAULT: 9,
    TAG_END: 255
  },
  SignatureType: {
    SIGNATURE_TYPE_AES_GCM: 0,
    SIGNATURE_TYPE_AES_GCM_PERSONALIZED: 5,
    SIGNATURE_TYPE_HMAC: 6,
    SIGNATURE_TYPE_HMAC_PERSONALIZED: 8,
    SIGNATURE_TYPE_AES_GCM_RESPONSE: 9
  },
  Session_Info_Status: {
    SESSION_INFO_STATUS_OK: 0,
    SESSION_INFO_STATUS_KEY_NOT_ON_WHITELIST: 1
  },
  // ---- VCSEC（现行版本）
  VcsecSignatureType: {
    SIGNATURE_TYPE_NONE: 0,
    SIGNATURE_TYPE_PRESENT_KEY: 2
  },
  KeyFormFactor: {
    KEY_FORM_FACTOR_UNKNOWN: 0,
    KEY_FORM_FACTOR_NFC_CARD: 1,
    KEY_FORM_FACTOR_IOS_DEVICE: 6,
    KEY_FORM_FACTOR_ANDROID_DEVICE: 7,
    KEY_FORM_FACTOR_CLOUD_KEY: 9
  },
  Role: {
    ROLE_NONE: 0,
    ROLE_SERVICE: 1,
    ROLE_OWNER: 2,
    ROLE_DRIVER: 3,
    ROLE_FM: 4,
    ROLE_VEHICLE_MONITOR: 5,
    ROLE_CHARGING_MANAGER: 6,
    ROLE_GUEST: 8
  },
  InformationRequestType: {
    INFORMATION_REQUEST_TYPE_GET_STATUS: 0,
    INFORMATION_REQUEST_TYPE_GET_WHITELIST_INFO: 5,
    INFORMATION_REQUEST_TYPE_GET_WHITELIST_ENTRY_INFO: 6
  },
  RKEAction_E: {
    RKE_ACTION_UNLOCK: 0,
    RKE_ACTION_LOCK: 1,
    RKE_ACTION_REMOTE_DRIVE: 20,
    RKE_ACTION_AUTO_SECURE_VEHICLE: 29,
    RKE_ACTION_WAKE_VEHICLE: 30
  },
  ClosureMoveType_E: {
    CLOSURE_MOVE_TYPE_NONE: 0,
    CLOSURE_MOVE_TYPE_MOVE: 1,
    CLOSURE_MOVE_TYPE_STOP: 2,
    CLOSURE_MOVE_TYPE_OPEN: 3,
    CLOSURE_MOVE_TYPE_CLOSE: 4
  },
  ClosureState_E: {
    CLOSURESTATE_CLOSED: 0,
    CLOSURESTATE_OPEN: 1,
    CLOSURESTATE_AJAR: 2,
    CLOSURESTATE_UNKNOWN: 3,
    CLOSURESTATE_FAILED_UNLATCH: 4,
    CLOSURESTATE_OPENING: 5,
    CLOSURESTATE_CLOSING: 6
  },
  VehicleLockState_E: {
    VEHICLELOCKSTATE_UNLOCKED: 0,
    VEHICLELOCKSTATE_LOCKED: 1,
    VEHICLELOCKSTATE_INTERNAL_LOCKED: 2,
    VEHICLELOCKSTATE_SELECTIVE_UNLOCKED: 3
  },
  VehicleSleepStatus_E: {
    VEHICLE_SLEEP_STATUS_UNKNOWN: 0,
    VEHICLE_SLEEP_STATUS_AWAKE: 1,
    VEHICLE_SLEEP_STATUS_ASLEEP: 2
  },
  UserPresence_E: {
    VEHICLE_USER_PRESENCE_UNKNOWN: 0,
    VEHICLE_USER_PRESENCE_NOT_PRESENT: 1,
    VEHICLE_USER_PRESENCE_PRESENT: 2
  },
  SignedMessage_information_E: {
    SIGNEDMESSAGE_INFORMATION_NONE: 0,
    SIGNEDMESSAGE_INFORMATION_FAULT_UNKNOWN: 1,
    SIGNEDMESSAGE_INFORMATION_FAULT_NOT_ON_WHITELIST: 2,
    SIGNEDMESSAGE_INFORMATION_FAULT_IV_SMALLER_THAN_EXPECTED: 3,
    SIGNEDMESSAGE_INFORMATION_FAULT_INVALID_TOKEN: 4,
    SIGNEDMESSAGE_INFORMATION_FAULT_TOKEN_AND_COUNTER_INVALID: 5,
    SIGNEDMESSAGE_INFORMATION_FAULT_AES_DECRYPT_AUTH: 6,
    SIGNEDMESSAGE_INFORMATION_FAULT_ECDSA_INPUT: 7,
    SIGNEDMESSAGE_INFORMATION_FAULT_ECDSA_SIGNATURE: 8,
    SIGNEDMESSAGE_INFORMATION_FAULT_LOCAL_ENTITY_START: 9,
    SIGNEDMESSAGE_INFORMATION_FAULT_LOCAL_ENTITY_RESULT: 10,
    SIGNEDMESSAGE_INFORMATION_FAULT_COULD_NOT_RETRIEVE_KEY: 11,
    SIGNEDMESSAGE_INFORMATION_FAULT_COULD_NOT_RETRIEVE_TOKEN: 12,
    SIGNEDMESSAGE_INFORMATION_FAULT_SIGNATURE_TOO_SHORT: 13,
    SIGNEDMESSAGE_INFORMATION_FAULT_TOKEN_IS_INCORRECT_LENGTH: 14,
    SIGNEDMESSAGE_INFORMATION_FAULT_INCORRECT_EPOCH: 15,
    SIGNEDMESSAGE_INFORMATION_FAULT_IV_INCORRECT_LENGTH: 16,
    SIGNEDMESSAGE_INFORMATION_FAULT_TIME_EXPIRED: 17,
    SIGNEDMESSAGE_INFORMATION_FAULT_NOT_PROVISIONED_WITH_IDENTITY: 18,
    SIGNEDMESSAGE_INFORMATION_FAULT_COULD_NOT_HASH_METADATA: 19
  },
  WhitelistOperation_information_E: {
    WHITELISTOPERATION_INFORMATION_NONE: 0,
    WHITELISTOPERATION_INFORMATION_UNDOCUMENTED_ERROR: 1,
    WHITELISTOPERATION_INFORMATION_NO_PERMISSION_TO_REMOVE_ONESELF: 2,
    WHITELISTOPERATION_INFORMATION_KEYFOB_SLOTS_FULL: 3,
    WHITELISTOPERATION_INFORMATION_WHITELIST_FULL: 4,
    WHITELISTOPERATION_INFORMATION_NO_PERMISSION_TO_ADD: 5,
    WHITELISTOPERATION_INFORMATION_INVALID_PUBLIC_KEY: 6,
    WHITELISTOPERATION_INFORMATION_NO_PERMISSION_TO_REMOVE: 7,
    WHITELISTOPERATION_INFORMATION_NO_PERMISSION_TO_CHANGE_PERMISSIONS: 8,
    WHITELISTOPERATION_INFORMATION_ATTEMPTING_TO_ELEVATE_OTHER_ABOVE_ONESELF: 9,
    WHITELISTOPERATION_INFORMATION_ATTEMPTING_TO_DEMOTE_SUPERIOR_TO_ONESELF: 10,
    WHITELISTOPERATION_INFORMATION_ATTEMPTING_TO_REMOVE_OWN_PERMISSIONS: 11,
    WHITELISTOPERATION_INFORMATION_PUBLIC_KEY_NOT_ON_WHITELIST: 12,
    WHITELISTOPERATION_INFORMATION_ATTEMPTING_TO_ADD_KEY_THAT_IS_ALREADY_ON_THE_WHITELIST: 13,
    WHITELISTOPERATION_INFORMATION_NOT_ALLOWED_TO_ADD_UNLESS_ON_READER: 14,
    WHITELISTOPERATION_INFORMATION_FM_MODIFYING_OUTSIDE_OF_F_MODE: 15,
    WHITELISTOPERATION_INFORMATION_FM_ATTEMPTING_TO_ADD_PERMANENT_KEY: 16,
    WHITELISTOPERATION_INFORMATION_FM_ATTEMPTING_TO_REMOVE_PERMANENT_KEY: 17,
    WHITELISTOPERATION_INFORMATION_KEYCHAIN_WHILE_FS_FULL: 18,
    WHITELISTOPERATION_INFORMATION_ATTEMPTING_TO_ADD_KEY_WITHOUT_ROLE: 19,
    WHITELISTOPERATION_INFORMATION_ATTEMPTING_TO_ADD_KEY_WITH_SERVICE_ROLE: 20,
    WHITELISTOPERATION_INFORMATION_NON_SERVICE_KEY_ATTEMPTING_TO_ADD_SERVICE_TECH: 21,
    WHITELISTOPERATION_INFORMATION_SERVICE_KEY_ATTEMPTING_TO_ADD_SERVICE_TECH_OUTSIDE_SERVICE_MODE: 22,
    WHITELISTOPERATION_INFORMATION_COULD_NOT_START_LOCAL_ENTITY_AUTH: 23,
    WHITELISTOPERATION_INFORMATION_LOCAL_ENTITY_AUTH_FAILED_UI_DENIED: 24,
    WHITELISTOPERATION_INFORMATION_LOCAL_ENTITY_AUTH_FAILED_TIMED_OUT_WAITING_FOR_TAP: 25,
    WHITELISTOPERATION_INFORMATION_LOCAL_ENTITY_AUTH_FAILED_TIMED_OUT_WAITING_FOR_UI_ACK: 26,
    WHITELISTOPERATION_INFORMATION_LOCAL_ENTITY_AUTH_FAILED_VALET_MODE: 27,
    WHITELISTOPERATION_INFORMATION_LOCAL_ENTITY_AUTH_FAILED_CANCELLED: 28
  },
  VCOperationStatus_E: {
    OPERATIONSTATUS_OK: 0,
    OPERATIONSTATUS_WAIT: 1,
    OPERATIONSTATUS_ERROR: 2
  },
  GenericError_E: {
    GENERICERROR_NONE: 0,
    GENERICERROR_UNKNOWN: 1,
    GENERICERROR_CLOSURES_OPEN: 2,
    GENERICERROR_ALREADY_ON: 3,
    GENERICERROR_DISABLED_FOR_USER_COMMAND: 4,
    GENERICERROR_VEHICLE_NOT_IN_PARK: 5,
    GENERICERROR_UNAUTHORIZED: 6,
    GENERICERROR_NOT_ALLOWED_OVER_TRANSPORT: 7
  },
  // ---- car_server（INFOTAINMENT）
  // car_server.proto:160-164 —— 注意这张表只有 OK/ERROR，没有 WAIT。
  // UniversalMessage 的 OPERATIONSTATUS_WAIT 属于 UMOperationStatus_E，两套枚举
  // 数值同名但语义不同，判读时千万别混用（车机侧的回包不会有「稍后重发」这一档）。
  CSOperationStatus_E: {
    OPERATIONSTATUS_OK: 0,
    OPERATIONSTATUS_ERROR: 1
  },
  // common.proto:48-53（被 ClimateState.steering_wheel_heat_level 引用）
  StwHeatLevel: {
    StwHeatLevel_Unknown: 0,
    StwHeatLevel_Off: 1,
    StwHeatLevel_Low: 2,
    StwHeatLevel_High: 3
  },
  // vehicle.proto:555-559
  CabinOverheatProtection_E: {
    CabinOverheatProtectionOff: 0,
    CabinOverheatProtectionOn: 1,
    CabinOverheatProtectionFanOnly: 2
  }
};

export const V3_MESSAGES = {
  // ---- UniversalMessage
  // universal_message.proto:16-21 —— 整条 Destination 就是一个 oneof sub_destination
  Destination: [
    oo('sub_destination', en('domain', 1, 'Domain')),
    oo('sub_destination', by('routing_address', 2))
  ],
  MessageStatus: [
    en('operation_status', 1, 'UMOperationStatus_E'),
    en('signed_message_fault', 2, 'MessageFault_E')
  ],
  SessionInfoRequest: [by('public_key', 1), by('challenge', 2)],
  // universal_message.proto:80-101 —— payload = {10, 14, 15}，sub_sigData = {13}
  RoutableMessage: [
    ms('to_destination', 6, 'Destination'),
    ms('from_destination', 7, 'Destination'),
    oo('payload', by('protobuf_message_as_bytes', 10)),
    ms('signedMessageStatus', 12, 'MessageStatus'),
    oo('sub_sigData', ms('signature_data', 13, 'SignatureData')),
    oo('payload', ms('session_info_request', 14, 'SessionInfoRequest')),
    oo('payload', by('session_info', 15)),
    by('request_uuid', 50),
    by('uuid', 51),
    u32('flags', 52)
  ],
  // ---- Signatures
  // signatures.proto:33-39 —— 整条 KeyIdentity 就是一个 oneof identity_type
  KeyIdentity: [oo('identity_type', by('public_key', 1)), oo('identity_type', u32('handle', 3))],
  AES_GCM_Personalized_Signature_Data: [
    by('epoch', 1),
    by('nonce', 2),
    u32('counter', 3),
    fx('expires_at', 4),
    by('tag', 5)
  ],
  AES_GCM_Response_Signature_Data: [by('nonce', 1), u32('counter', 2), by('tag', 3)],
  HMAC_Signature_Data: [by('tag', 1)],
  HMAC_Personalized_Signature_Data: [
    by('epoch', 1),
    u32('counter', 2),
    fx('expires_at', 3),
    by('tag', 4)
  ],
  // signatures.proto:66-75 —— sig_type = {5, 6, 8, 9}，signer_identity 在 oneof 外
  SignatureData: [
    ms('signer_identity', 1, 'KeyIdentity'),
    oo('sig_type', ms('AES_GCM_Personalized_data', 5, 'AES_GCM_Personalized_Signature_Data')),
    oo('sig_type', ms('session_info_tag', 6, 'HMAC_Signature_Data')),
    oo('sig_type', ms('HMAC_Personalized_data', 8, 'HMAC_Personalized_Signature_Data')),
    oo('sig_type', ms('AES_GCM_Response_data', 9, 'AES_GCM_Response_Signature_Data'))
  ],
  GetSessionInfoRequest: [ms('key_identity', 1, 'KeyIdentity')],
  SessionInfo: [
    u32('counter', 1),
    by('publicKey', 2),
    by('epoch', 3),
    fx('clock_time', 4),
    en('status', 5, 'Session_Info_Status'),
    u32('handle', 6)
  ],
  // ---- VCSEC（现行版本：内层只剩 UnsignedMessage / FromVCSECMessage）
  SignedMessage: [by('protobufMessageAsBytes', 2), en('signatureType', 3, 'VcsecSignatureType')],
  ToVCSECMessage: [ms('signedMessage', 1, 'SignedMessage')],
  KeyIdentifier: [by('publicKeySHA1', 1)],
  KeyMetadata: [en('keyFormFactor', 1, 'KeyFormFactor')],
  PublicKey: [by('PublicKeyRaw', 1)],
  WhitelistInfo: [
    u32('numberOfEntries', 1),
    { name: 'whitelistEntries', num: 2, kind: 'msg', msg: 'KeyIdentifier', rep: true },
    u32('slotMask', 3)
  ],
  WhitelistEntryInfo: [
    ms('keyId', 1, 'KeyIdentifier'),
    ms('publicKey', 2, 'PublicKey'),
    ms('metadataForKey', 4, 'KeyMetadata'),
    u32('slot', 6),
    en('keyRole', 7, 'Role')
  ],
  // vcsec.proto:67-74 —— key = {2, 3, 4}；informationRequestType 是 oneof 外的普通枚举，
  // 值为 0（GET_STATUS）时仍按 proto3 省略，这是官方行为，别误标成 oneof。
  InformationRequest: [
    en('informationRequestType', 1, 'InformationRequestType'),
    oo('key', ms('keyId', 2, 'KeyIdentifier')),
    oo('key', by('publicKey', 3)),
    oo('key', u32('slot', 4))
  ],
  ClosureMoveRequest: [
    en('frontDriverDoor', 1, 'ClosureMoveType_E'),
    en('frontPassengerDoor', 2, 'ClosureMoveType_E'),
    en('rearDriverDoor', 3, 'ClosureMoveType_E'),
    en('rearPassengerDoor', 4, 'ClosureMoveType_E'),
    en('rearTrunk', 5, 'ClosureMoveType_E'),
    en('frontTrunk', 6, 'ClosureMoveType_E'),
    en('chargePort', 7, 'ClosureMoveType_E'),
    en('tonneau', 8, 'ClosureMoveType_E')
  ],
  PermissionChange: [
    ms('key', 1, 'PublicKey'),
    u32('secondsToBeActive', 3),
    en('keyRole', 4, 'Role')
  ],
  // vcsec.proto:110-119 —— keyToReplace = {1, 2}
  ReplaceKey: [
    oo('keyToReplace', ms('publicKeyToReplace', 1, 'PublicKey')),
    oo('keyToReplace', u32('slotToReplace', 2)),
    ms('keyToAdd', 3, 'PublicKey'),
    en('keyRole', 4, 'Role'),
    { name: 'impermanent', num: 5, kind: 'bool' }
  ],
  // vcsec.proto:121-136 —— sub_message 覆盖除 metadataForKey(6) 之外的全部字段
  WhitelistOperation: [
    oo('sub_message', ms('addPublicKeyToWhitelist', 1, 'PublicKey')),
    oo('sub_message', ms('removePublicKeyFromWhitelist', 2, 'PublicKey')),
    oo('sub_message', ms('addPermissionsToPublicKey', 3, 'PermissionChange')),
    oo('sub_message', ms('removePermissionsFromPublicKey', 4, 'PermissionChange')),
    oo('sub_message', ms('addKeyToWhitelistAndAddPermissions', 5, 'PermissionChange')),
    ms('metadataForKey', 6, 'KeyMetadata'),
    oo('sub_message', ms('updateKeyAndPermissions', 7, 'PermissionChange')),
    oo('sub_message', ms('addImpermanentKey', 8, 'PermissionChange')),
    oo('sub_message', ms('addImpermanentKeyAndRemoveExisting', 9, 'PermissionChange')),
    oo('sub_message', { name: 'removeAllImpermanentKeys', num: 16, kind: 'bool' }),
    oo('sub_message', ms('replaceKey', 17, 'ReplaceKey'))
  ],
  WhitelistOperation_status: [
    en('whitelistOperationInformation', 1, 'WhitelistOperation_information_E'),
    ms('signerOfOperation', 2, 'KeyIdentifier'),
    en('operationStatus', 3, 'VCOperationStatus_E')
  ],
  SignedMessage_status: [
    u32('counter', 1),
    en('signedMessageInformation', 2, 'SignedMessage_information_E')
  ],
  // vcsec.proto:215-221 —— sub_message = {2, 3}；operationStatus(1) 是普通枚举，OK=0 会被省略
  CommandStatus: [
    en('operationStatus', 1, 'VCOperationStatus_E'),
    oo('sub_message', ms('signedMessageStatus', 2, 'SignedMessage_status')),
    oo('sub_message', ms('whitelistOperationStatus', 3, 'WhitelistOperation_status'))
  ],
  // vcsec.proto:224-232 —— 整条 UnsignedMessage 就是 oneof sub_message。
  // 这是 UNLOCK 的落点：RKE_ACTION_UNLOCK = 0，若不写 tag，整条报文就退化成 0 字节，
  // 车辆分不清这是解锁还是「什么都没请求」，只会一直回 WAIT。
  UnsignedMessage: [
    oo('sub_message', ms('InformationRequest', 1, 'InformationRequest')),
    oo('sub_message', en('RKEAction', 2, 'RKEAction_E')),
    oo('sub_message', ms('closureMoveRequest', 4, 'ClosureMoveRequest')),
    oo('sub_message', ms('WhitelistOperation', 16, 'WhitelistOperation'))
  ],
  ClosureStatuses: [
    en('frontDriverDoor', 1, 'ClosureState_E'),
    en('frontPassengerDoor', 2, 'ClosureState_E'),
    en('rearDriverDoor', 3, 'ClosureState_E'),
    en('rearPassengerDoor', 4, 'ClosureState_E'),
    en('rearTrunk', 5, 'ClosureState_E'),
    en('frontTrunk', 6, 'ClosureState_E'),
    en('chargePort', 7, 'ClosureState_E'),
    en('tonneau', 8, 'ClosureState_E')
  ],
  DetailedClosureStatus: [u32('tonneauPercentOpen', 1)],
  VehicleStatus: [
    ms('closureStatuses', 1, 'ClosureStatuses'),
    en('vehicleLockState', 2, 'VehicleLockState_E'),
    en('vehicleSleepStatus', 3, 'VehicleSleepStatus_E'),
    en('userPresence', 4, 'UserPresence_E'),
    ms('detailedClosureStatus', 5, 'DetailedClosureStatus')
  ],
  NominalError: [en('genericError', 1, 'GenericError_E')],
  // vcsec.proto:286-295 —— 整条 FromVCSECMessage 也是 oneof sub_message（只影响组包，
  // 本项目只解不编，标记它纯粹是让规格表和 .proto 原文一一对上）
  FromVCSECMessage: [
    oo('sub_message', ms('vehicleStatus', 1, 'VehicleStatus')),
    oo('sub_message', ms('commandStatus', 4, 'CommandStatus')),
    oo('sub_message', ms('whitelistInfo', 16, 'WhitelistInfo')),
    oo('sub_message', ms('whitelistEntryInfo', 17, 'WhitelistEntryInfo')),
    oo('sub_message', ms('nominalError', 46, 'NominalError'))
  ],

  // ===============================================================
  // car_server（INFOTAINMENT 域）—— 充电盖板 / 车辆信息 / Ping
  // ===============================================================
  //
  // 权威来源：car_server.proto / vehicle.proto / common.proto（逐字核对，行号见各条注释）。
  // 官方调用链：pkg/vehicle/infotainment.go:19-50
  //             → executeCarServerAction → proto.Marshal(Action)
  //             → v.Send(DOMAIN_INFOTAINMENT, payload) → 解 car_server.Response
  //
  // ⚠ 这些消息走的是 INFOTAINMENT 域的会话，密钥、counter、epoch 都和 VCSEC 那套
  //   相互独立（pkg/protocol/domains.go:7 “Each Domain manages its own key pair”）。
  //   用 VCSEC 的 counter 去签车机命令，轻则 INVALID_TOKEN_OR_COUNTER，
  //   重则在车辆侧留下永久的 IV 空洞（IV_SMALLER_THAN_EXPECTED）。
  //
  // 下面只登记 UI / 测试页真正用到的字段。未登记的字段解码成 f<号>，
  // 那是 pb.js 的正常降级（见 wireMatches 注释），不是协议错。

  // google.protobuf.Timestamp
  Timestamp: [u32('seconds', 1), u32('nanos', 2)],
  // common.proto:14
  LatLong: [f32('latitude', 1), f32('longitude', 2)],
  // common.proto:8 —— 空占位；伪枚举靠「哪个 key 存在」表达
  Void: [],

  // car_server.proto:13-18
  Action: [oo('action_msg', ms('vehicleAction', 2, 'VehicleAction'))],
  // car_server.proto:20-86 的 vehicle_action_msg oneof（只取本项目用到的成员）
  VehicleAction: [
    oo('vehicle_action_msg', ms('getVehicleData', 1, 'GetVehicleData')),
    // car_server.proto:209-212 —— 空调一键启动（官方 StartHvac 走的就是它）
    oo('vehicle_action_msg', ms('hvacAutoAction', 10, 'HvacAutoAction')),
    // :43-44 —— 闪灯 / 鸣笛：都是空 message，寻车用
    oo('vehicle_action_msg', ms('vehicleControlFlashLightsAction', 26, 'VehicleControlFlashLightsAction')),
    oo('vehicle_action_msg', ms('vehicleControlHonkHornAction', 27, 'VehicleControlHonkHornAction')),
    // :401-408 —— 车窗：oneof action { unknown=2 / vent=3 / close=4 }，字段 1 已 reserved
    oo('vehicle_action_msg', ms('vehicleControlWindowAction', 34, 'VehicleControlWindowAction')),
    oo('vehicle_action_msg', ms('ping', 46, 'Ping')),
    // :494 / :497 —— 空 message，编码结果就是 tag + len=0：关闭 = 61(EA 03)，打开 = 62(F2 03)
    oo('vehicle_action_msg', ms('chargePortDoorClose', 61, 'ChargePortDoorClose')),
    oo('vehicle_action_msg', ms('chargePortDoorOpen', 62, 'ChargePortDoorOpen'))
  ],
  // car_server.proto:209-212。power_on=false 是 proto3 默认值会被省略，
  // 但外层 hvacAutoAction 仍然写 tag+len —— 「关掉空调」和「没带这个动作」在车上是两回事。
  HvacAutoAction: [bl('power_on', 1), bl('manual_override', 2)],
  VehicleControlFlashLightsAction: [],
  VehicleControlHonkHornAction: [],
  VehicleControlWindowAction: [
    oo('action', ms('unknown', 2, 'Void')),
    oo('action', ms('vent', 3, 'Void')),
    oo('action', ms('close', 4, 'Void'))
  ],
  ChargePortDoorClose: [],
  ChargePortDoorOpen: [],
  // car_server.proto:428-432
  Ping: [u32('ping_id', 1), ms('local_timestamp', 2, 'Timestamp'), ms('last_remote_timestamp', 3, 'Timestamp')],
  // car_server.proto:88-103 —— 这 12 个开关都在 oneof 外，但「显式设置成空 message」
  // 仍然会编成 tag+00（pb.js 的 msg 分支不省略），这正是官方语义。
  GetVehicleData: [
    ms('getChargeState', 2, 'GetChargeState'),
    ms('getClimateState', 3, 'GetClimateState'),
    ms('getDriveState', 4, 'GetDriveState'),
    ms('getLocationState', 7, 'GetLocationState'),
    ms('getClosuresState', 8, 'GetClosuresState'),
    ms('getTirePressureState', 14, 'GetTirePressureState')
  ],
  GetChargeState: [],
  GetClimateState: [],
  GetDriveState: [],
  GetLocationState: [],
  GetClosuresState: [],
  GetTirePressureState: [],
  // car_server.proto:145-170
  Response: [
    ms('actionStatus', 1, 'ActionStatus'),
    oo('response_msg', ms('vehicleData', 2, 'VehicleData')),
    // 复用 signatures.proto 那张 SessionInfo（本项目握手用的就是它）
    oo('response_msg', ms('getSessionInfoResponse', 3, 'SessionInfo')),
    oo('response_msg', ms('ping', 9, 'Ping'))
  ],
  ActionStatus: [en('result', 1, 'CSOperationStatus_E'), ms('result_reason', 2, 'ResultReason')],
  ResultReason: [oo('reason', st('plain_text', 1))],

  // ---- vehicle.proto:14-27
  VehicleData: [
    ms('charge_state', 3, 'ChargeState'),
    ms('climate_state', 4, 'ClimateState'),
    ms('drive_state', 5, 'DriveState'),
    ms('location_state', 8, 'LocationState'),
    ms('closures_state', 9, 'ClosuresState'),
    ms('tire_pressure_state', 19, 'TirePressureState')
  ],
  // vehicle.proto:29-101
  ClosuresState: [
    ob('door_open_driver_front', 101),
    ob('door_open_driver_rear', 102),
    ob('door_open_passenger_front', 103),
    ob('door_open_passenger_rear', 104),
    // trunk_front = 前备箱（frunk），trunk_rear = 后备箱
    ob('door_open_trunk_front', 105),
    ob('door_open_trunk_rear', 106),
    ob('window_open_driver_front', 107),
    ob('window_open_passenger_front', 108),
    ob('window_open_driver_rear', 109),
    ob('window_open_passenger_rear', 110),
    ms('sun_roof_state', 11, 'SunRoofState'),
    oi('sun_roof_percent_open', 112),
    ob('locked', 113),
    ob('is_user_present', 114),
    ms('center_display_state', 15, 'DisplayState'),
    ob('remote_start', 116),
    ob('valet_mode', 117),
    ob('valet_pin_needed', 118),
    ms('sentry_mode_state', 19, 'SentryModeState'),
    ob('sentry_mode_available', 120),
    ms('speed_limit_mode', 22, 'SpeedLimitMode'),
    // :96 用的是 VCSEC.ClosureState_E，和上面 VCSEC 那张枚举表同源，直接复用
    oe('tonneau_state', 23, 'ClosureState_E'),
    oi('tonneau_percent_open', 24),
    ob('tonneau_in_motion', 25),
    ms('timestamp', 2000, 'Timestamp')
  ],
  SunRoofState: [okind('Unknown', 1), okind('Calibrating', 2), okind('Closed', 3), okind('Open', 4), okind('Moving', 5), okind('Vent', 6)],
  DisplayState: [
    okind('Off', 1),
    okind('Dim', 2),
    okind('Accessory', 3),
    okind('On', 4),
    okind('Driving', 5),
    okind('Charging', 6),
    okind('Lock', 7),
    okind('Sentry', 8),
    okind('Dog', 9),
    okind('Entertainment', 10)
  ],
  SentryModeState: [okind('Off', 1), okind('Idle', 2), okind('Armed', 3), okind('Aware', 4), okind('Panic', 5), okind('Quiet', 6)],
  // vehicle.proto:121-127
  SpeedLimitMode: [ob('active', 103), ob('pin_code_set', 104), of('max_limit_mph', 106), of('min_limit_mph', 107), of('current_limit_mph', 108)],
  // vehicle.proto:195-405
  ChargeState: [
    ms('charging_state', 1, 'ChargingState'),
    ms('fast_charger_type', 2, 'ChargerType'),
    ms('fast_charger_brand', 3, 'ChargerBrand'),
    oi('charge_limit_soc', 104),
    oi('charge_limit_soc_std', 105),
    oi('charge_limit_soc_min', 106),
    oi('charge_limit_soc_max', 107),
    ob('fast_charger_present', 110),
    of('battery_range', 111),
    of('est_battery_range', 112),
    of('ideal_battery_range', 113),
    oi('battery_level', 114),
    oi('usable_battery_level', 115),
    of('charge_energy_added', 116),
    oi('charger_voltage', 119),
    oi('charger_actual_current', 121),
    oi('charger_power', 122),
    oi('minutes_to_full_charge', 123),
    oi('minutes_to_charge_limit', 142),
    oi('charge_rate_mph', 126),
    of('charge_rate_mph_float', 156),
    ob('charge_port_door_open', 127),
    ms('conn_charge_cable', 28, 'CableType'),
    ou('scheduled_charging_start_time', 129),
    ms('charge_port_latch', 35, 'ChargePortLatchState'),
    oi('charge_current_request', 137),
    oi('charge_current_request_max', 138),
    sz('scheduled_charging_start_time_app', 153),
    ms('timestamp', 44, 'Timestamp')
  ],
  ChargingState: [
    okind('Unknown', 1),
    okind('Disconnected', 2),
    okind('NoPower', 3),
    okind('Starting', 4),
    okind('Charging', 5),
    okind('Complete', 6),
    okind('Stopped', 7),
    okind('Calibrating', 8)
  ],
  ChargerType: [
    okind('SNA', 1),
    okind('Supercharger', 2),
    okind('Chademo', 3),
    okind('Gb', 4),
    okind('ACSingleWireCAN', 5),
    okind('Combo', 6),
    okind('MCSingleWireCAN', 7),
    okind('Other', 8),
    okind('Tesla', 9)
  ],
  ChargerBrand: [okind('Tesla', 1), okind('SNA', 2)],
  CableType: [okind('SNA', 1), okind('IEC', 2), okind('SAE', 3), okind('GB_AC', 4), okind('GB_DC', 5)],
  // common.proto:19-25
  ChargePortLatchState: [okind('SNA', 1), okind('Disengaged', 2), okind('Engaged', 3), okind('Blocking', 4)],
  // vehicle.proto:531-647
  ClimateState: [
    of('inside_temp_celsius', 101),
    of('outside_temp_celsius', 102),
    of('driver_temp_setting', 103),
    of('passenger_temp_setting', 104),
    oi('left_temp_direction', 105),
    oi('right_temp_direction', 106),
    ob('is_front_defroster_on', 107),
    ob('is_rear_defroster_on', 108),
    oi('fan_status', 109),
    ob('is_climate_on', 110),
    of('min_avail_temp_celsius', 111),
    of('max_avail_temp_celsius', 112),
    oi('seat_heater_left', 113),
    oi('seat_heater_right', 114),
    oi('seat_heater_rear_left', 115),
    oi('seat_heater_rear_right', 116),
    ob('battery_heater', 122),
    ob('steering_wheel_heater', 125),
    ob('side_mirror_heaters', 127),
    ob('is_preconditioning', 128),
    ms('climate_keeper_mode', 30, 'ClimateKeeperMode'),
    ms('timestamp', 33, 'Timestamp'),
    ob('bioweapon_mode_on', 134),
    ms('defrost_mode', 35, 'DefrostMode'),
    ob('is_auto_conditioning_on', 136),
    ob('auto_seat_climate_left', 137),
    ob('auto_seat_climate_right', 138),
    ob('allow_cabin_overheat_protection', 141),
    oe('cabin_overheat_protection', 143, 'CabinOverheatProtection_E'),
    oe('steering_wheel_heat_level', 148, 'StwHeatLevel')
  ],
  ClimateKeeperMode: [okind('Unknown', 1), okind('Off', 2), okind('On', 3), okind('Dog', 4), okind('Party', 5)],
  DefrostMode: [okind('Off', 1), okind('Normal', 2), okind('Max', 3)],
  // vehicle.proto:173-193
  DriveState: [
    ms('shift_state', 1, 'ShiftState'),
    oi('speed', 102),
    oi('power', 103), // int32，可为负（动能回收）→ pb.js normInt 归一
    ms('timestamp', 4, 'Timestamp'),
    oi('odometer_in_hundredths_of_a_mile', 105),
    of('speed_float', 106),
    os('active_route_destination', 7),
    of('active_route_minutes_to_arrival', 8),
    of('active_route_miles_to_arrival', 9),
    ms('active_route_coordinates', 12, 'LatLong')
  ],
  // vehicle.proto:695-704
  ShiftState: [okind('Invalid', 1), okind('P', 2), okind('R', 3), okind('N', 4), okind('D', 5), okind('SNA', 6)],
  // vehicle.proto:487-521
  LocationState: [
    of('latitude', 101),
    of('longitude', 102),
    oi('heading', 103),
    ou('gps_as_of', 104),
    ob('native_location_supported', 105),
    of('native_latitude', 106),
    of('native_longitude', 107),
    ms('native_type', 8, 'GPSCoordinateType'),
    of('corrected_latitude', 109),
    of('corrected_longitude', 110),
    ms('timestamp', 11, 'Timestamp'),
    os('location_name', 113),
    of('geo_latitude', 114),
    of('geo_longitude', 115),
    ob('estimated_gps_valid', 119),
    of('estimated_to_raw_distance', 120)
  ],
  GPSCoordinateType: [okind('GCJ', 1), okind('WGS', 2)],
  // vehicle.proto:649-671 —— 注意这张表的 timestamp 是字段 1，不是别处的 2000
  TirePressureState: [
    ms('timestamp', 1, 'Timestamp'),
    of('tpms_pressure_fl', 2),
    of('tpms_pressure_fr', 3),
    of('tpms_pressure_rl', 4),
    of('tpms_pressure_rr', 5),
    ms('tpms_last_seen_pressure_time_fl', 6, 'Timestamp'),
    ms('tpms_last_seen_pressure_time_fr', 7, 'Timestamp'),
    ms('tpms_last_seen_pressure_time_rl', 8, 'Timestamp'),
    ms('tpms_last_seen_pressure_time_rr', 9, 'Timestamp'),
    ob('tpms_hard_warning_fl', 10),
    ob('tpms_hard_warning_fr', 11),
    ob('tpms_hard_warning_rl', 12),
    ob('tpms_hard_warning_rr', 13),
    ob('tpms_soft_warning_fl', 14),
    ob('tpms_soft_warning_fr', 15),
    ob('tpms_soft_warning_rl', 16),
    ob('tpms_soft_warning_rr', 17),
    of('tpms_rcp_front_value', 18),
    of('tpms_rcp_rear_value', 19)
  ]
};

export const V3_SPEC = { messages: V3_MESSAGES, enums: V3_ENUMS };

export default V3_SPEC;
