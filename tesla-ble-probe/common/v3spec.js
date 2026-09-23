// Tesla V3（UniversalMessage / RoutableMessage）protobuf 规格表
//
// 权威来源：github.com/teslamotors/vehicle-command  pkg/protocol/protobuf/
//   universal_message.proto / signatures.proto / vcsec.proto / keys.proto / errors.proto
// 以及 pkg/protocol/protocol.md（字段语义、TLV 元数据、测试向量）。
//
// 本项目只认这一套协议：
//   RoutableMessage + session_info 握手 + AES_GCM_Personalized_data + 12 字节 nonce + SHA256(TLV) AAD
//
// kind: 'int' | 'enum' | 'bool' | 'fixed32' | 'bytes' | 'string' | 'msg'
// 字段名一律照抄 .proto 原文（Universal/Signatures 用 snake_case，VCSEC 用 camelCase），
// 这样报文控制台里粘的 JSON 能和官方文档逐字对上。

const en = (name, num, enumName) => ({ name, num, kind: 'enum', enum: enumName });
const u32 = (name, num) => ({ name, num, kind: 'int' });
const fx = (name, num) => ({ name, num, kind: 'fixed32' });
const by = (name, num) => ({ name, num, kind: 'bytes' });
const ms = (name, num, msg) => ({ name, num, kind: 'msg', msg });

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
  }
};

export const V3_MESSAGES = {
  // ---- UniversalMessage
  Destination: [
    en('domain', 1, 'Domain'),
    by('routing_address', 2)
  ],
  MessageStatus: [
    en('operation_status', 1, 'UMOperationStatus_E'),
    en('signed_message_fault', 2, 'MessageFault_E')
  ],
  SessionInfoRequest: [by('public_key', 1), by('challenge', 2)],
  RoutableMessage: [
    ms('to_destination', 6, 'Destination'),
    ms('from_destination', 7, 'Destination'),
    by('protobuf_message_as_bytes', 10),
    ms('signedMessageStatus', 12, 'MessageStatus'),
    ms('signature_data', 13, 'SignatureData'),
    ms('session_info_request', 14, 'SessionInfoRequest'),
    by('session_info', 15),
    by('request_uuid', 50),
    by('uuid', 51),
    u32('flags', 52)
  ],
  // ---- Signatures
  KeyIdentity: [by('public_key', 1), u32('handle', 3)],
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
  SignatureData: [
    ms('signer_identity', 1, 'KeyIdentity'),
    ms('AES_GCM_Personalized_data', 5, 'AES_GCM_Personalized_Signature_Data'),
    ms('session_info_tag', 6, 'HMAC_Signature_Data'),
    ms('HMAC_Personalized_data', 8, 'HMAC_Personalized_Signature_Data'),
    ms('AES_GCM_Response_data', 9, 'AES_GCM_Response_Signature_Data')
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
  InformationRequest: [
    en('informationRequestType', 1, 'InformationRequestType'),
    ms('keyId', 2, 'KeyIdentifier'),
    by('publicKey', 3),
    u32('slot', 4)
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
  ReplaceKey: [
    ms('publicKeyToReplace', 1, 'PublicKey'),
    u32('slotToReplace', 2),
    ms('keyToAdd', 3, 'PublicKey'),
    en('keyRole', 4, 'Role'),
    { name: 'impermanent', num: 5, kind: 'bool' }
  ],
  WhitelistOperation: [
    ms('addPublicKeyToWhitelist', 1, 'PublicKey'),
    ms('removePublicKeyFromWhitelist', 2, 'PublicKey'),
    ms('addPermissionsToPublicKey', 3, 'PermissionChange'),
    ms('removePermissionsFromPublicKey', 4, 'PermissionChange'),
    ms('addKeyToWhitelistAndAddPermissions', 5, 'PermissionChange'),
    ms('metadataForKey', 6, 'KeyMetadata'),
    ms('updateKeyAndPermissions', 7, 'PermissionChange'),
    ms('addImpermanentKey', 8, 'PermissionChange'),
    ms('addImpermanentKeyAndRemoveExisting', 9, 'PermissionChange'),
    { name: 'removeAllImpermanentKeys', num: 16, kind: 'bool' },
    ms('replaceKey', 17, 'ReplaceKey')
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
  CommandStatus: [
    en('operationStatus', 1, 'VCOperationStatus_E'),
    ms('signedMessageStatus', 2, 'SignedMessage_status'),
    ms('whitelistOperationStatus', 3, 'WhitelistOperation_status')
  ],
  UnsignedMessage: [
    ms('InformationRequest', 1, 'InformationRequest'),
    en('RKEAction', 2, 'RKEAction_E'),
    ms('closureMoveRequest', 4, 'ClosureMoveRequest'),
    ms('WhitelistOperation', 16, 'WhitelistOperation')
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
  FromVCSECMessage: [
    ms('vehicleStatus', 1, 'VehicleStatus'),
    ms('commandStatus', 4, 'CommandStatus'),
    ms('whitelistInfo', 16, 'WhitelistInfo'),
    ms('whitelistEntryInfo', 17, 'WhitelistEntryInfo'),
    ms('nominalError', 46, 'NominalError')
  ]
};

export const V3_SPEC = { messages: V3_MESSAGES, enums: V3_ENUMS };

export default V3_SPEC;
