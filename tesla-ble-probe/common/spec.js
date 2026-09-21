// Tesla VCSEC protobuf 规格表（字段号 + 枚举值）
//
// 权威来源：
//   protos/VCSECv3.10.14.proto  (github.com/trifinite/vcsec-archive)
//   gist: VCSEC.proto pulled from Android app 3.10.13-469 (LexNastin/fc55736f...)
//   https://www.teslabtapi.com/docs/start , /docs/more/rke
//
// 只登记本项目用到的 message / enum；车辆若升级导致字段号变化，改这里即可（探针用法）。
//
// kind: 'int' | 'enum' | 'bool' | 'bytes' | 'string' | 'msg'

export const ENUMS = {
  SignatureType: {
    SIGNATURE_TYPE_AES_GCM: 0,
    SIGNATURE_TYPE_ECDSA: 1,
    SIGNATURE_TYPE_PRESENT_KEY: 2,
    SIGNATURE_TYPE_AES_GCM_TOKEN: 3,
    SIGNATURE_TYPE_UNSIGNED: 4
  },
  // 仅登记 v3.10.14 里确实存在的值（AUTO_SECURE_VEHICLE / WAKE_VEHICLE 属于更新固件，
  // 数值未经本项目核实，故不写入，避免误判）。
  RKEAction_E: {
    RKE_ACTION_UNLOCK: 0,
    RKE_ACTION_LOCK: 1,
    RKE_ACTION_OPEN_TRUNK: 2,
    RKE_ACTION_OPEN_FRUNK: 3,
    RKE_ACTION_OPEN_CHARGE_PORT: 4,
    RKE_ACTION_CLOSE_CHARGE_PORT: 5,
    RKE_ACTION_CANCEL_EXTERNAL_AUTHENTICATE: 6,
    RKE_ACTION_SINGLE_PRESS_TOP: 7,
    RKE_ACTION_DOUBLE_PRESS_TOP: 8,
    RKE_ACTION_TRIPLE_PRESS_TOP: 9,
    RKE_ACTION_HOLD_TOP: 10,
    RKE_ACTION_SINGLE_PRESS_BACK: 11,
    RKE_ACTION_DOUBLE_PRESS_BACK: 12,
    RKE_ACTION_TRIPLE_PRESS_BACK: 13,
    RKE_ACTION_HOLD_BACK: 14,
    RKE_ACTION_SINGLE_PRESS_FRONT: 15,
    RKE_ACTION_DOUBLE_PRESS_FRONT: 16,
    RKE_ACTION_TRIPLE_PRESS_FRONT: 17,
    RKE_ACTION_HOLD_FRONT: 18,
    RKE_ACTION_UNKNOWN: 19,
    RKE_ACTION_REMOTE_DRIVE: 20
  },
  InformationRequestType: {
    INFORMATION_REQUEST_TYPE_GET_STATUS: 0,
    INFORMATION_REQUEST_TYPE_GET_TOKEN: 1,
    INFORMATION_REQUEST_TYPE_GET_COUNTER: 2,
    INFORMATION_REQUEST_TYPE_GET_EPHEMERAL_PUBLIC_KEY: 3,
    INFORMATION_REQUEST_TYPE_GET_SESSION_DATA: 4,
    INFORMATION_REQUEST_TYPE_GET_WHITELIST_INFO: 5,
    INFORMATION_REQUEST_TYPE_GET_WHITELIST_ENTRY_INFO: 6,
    INFORMATION_REQUEST_TYPE_GET_VEHICLE_INFO: 7,
    INFORMATION_REQUEST_TYPE_GET_KEYSTATUS_INFO: 8,
    INFORMATION_REQUEST_TYPE_GET_ACTIVE_KEY: 9,
    INFORMATION_REQUEST_TYPE_GET_CAPABILITIES: 16
  },
  WhitelistKeyPermission_E: {
    WHITELISTKEYPERMISSION_ADD_TO_WHITELIST: 0,
    WHITELISTKEYPERMISSION_LOCAL_UNLOCK: 1,
    WHITELISTKEYPERMISSION_LOCAL_DRIVE: 2,
    WHITELISTKEYPERMISSION_REMOTE_UNLOCK: 3,
    WHITELISTKEYPERMISSION_REMOTE_DRIVE: 4,
    WHITELISTKEYPERMISSION_CHANGE_PERMISSIONS: 5,
    WHITELISTKEYPERMISSION_REMOVE_FROM_WHITELIST: 6,
    WHITELISTKEYPERMISSION_REMOVE_SELF_FROM_WHITELIST: 7,
    WHITELISTKEYPERMISSION_MODIFY_FLEET_RESERVED_SLOTS: 8,
    WHITELISTKEYPERMISSION_UNKNOWN: 31
  },
  KeyFormFactor: {
    KEY_FORM_FACTOR_UNKNOWN: 0,
    KEY_FORM_FACTOR_NFC_CARD: 1,
    KEY_FORM_FACTOR_3_BUTTON_BLE_CAR_KEYFOB: 2,
    KEY_FORM_FACTOR_BLE_DEVICE: 3,
    KEY_FORM_FACTOR_NFC_DEVICE: 4,
    KEY_FORM_FACTOR_BLE_AND_NFC_DEVICE: 5,
    KEY_FORM_FACTOR_IOS_DEVICE: 6,
    KEY_FORM_FACTOR_ANDROID_DEVICE: 7,
    KEY_FORM_FACTOR_3_BUTTON_BLE_CAR_KEYFOB_P60: 8
  },
  OperationStatus_E: {
    OPERATIONSTATUS_OK: 0,
    OPERATIONSTATUS_WAIT: 1,
    OPERATIONSTATUS_ERROR: 2
  },
  // 车辆对 SignedMessage 的判定结果；fault 细节直接编在枚举名里（这就是 FaultCode 的载体）
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
    SIGNEDMESSAGE_INFORMATION_FAULT_TOKEN_IS_INCORRECT_LENGTH: 14
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
    WHITELISTOPERATION_INFORMATION_PUBLIC_KEY_NOT_ON_WHITELIST: 12
  },
  AuthenticationLevel_E: {
    AUTHENTICATION_LEVEL_NONE: 0,
    AUTHENTICATION_LEVEL_UNLOCK: 1,
    AUTHENTICATION_LEVEL_DRIVE: 2
  },
  ClosureState_E: {
    CLOSURESTATE_CLOSED: 0,
    CLOSURESTATE_OPEN: 1,
    CLOSURESTATE_AJAR: 2,
    CLOSURESTATE_UNKNOWN: 3
  },
  VehicleLockState_E: {
    VEHICLELOCKSTATE_UNLOCKED: 0,
    VEHICLELOCKSTATE_LOCKED: 1,
    VEHICLELOCKSTATE_INTERNAL_LOCKED: 2,
    VEHICLELOCKSTATE_SELECTIVE_UNLOCKED: 3
  },
  NFCPresence: {
    NFC_PRESENCE_NOT_PRESENT: 0,
    NFC_PRESENCE_PRESENT_AT_B_PILLAR: 1,
    NFC_PRESENCE_PRESENT_AT_CENTER_CONSOLE: 2
  },
  BLEPresence: {
    BLE_PRESENCE_NOT_PRESENT: 0,
    BLE_PRESENCE_PRESENT: 1
  }
};

const en = (name, num, enumName) => ({ name, num, kind: 'enum', enum: enumName });

export const MESSAGES = {
  ToVCSECMessage: [
    { name: 'signedMessage', num: 1, kind: 'msg', msg: 'SignedMessage' },
    { name: 'unsignedMessage', num: 2, kind: 'msg', msg: 'UnsignedMessage' }
  ],
  SignedMessage: [
    { name: 'token', num: 1, kind: 'bytes' },
    { name: 'protobufMessageAsBytes', num: 2, kind: 'bytes' },
    { name: 'signatureType', num: 3, kind: 'enum', enum: 'SignatureType' },
    { name: 'signature', num: 4, kind: 'bytes' },
    { name: 'keyId', num: 5, kind: 'bytes' },
    { name: 'counter', num: 6, kind: 'int' }
  ],
  UnsignedMessage: [
    { name: 'InformationRequest', num: 1, kind: 'msg', msg: 'InformationRequest' },
    { name: 'RKEAction', num: 2, kind: 'enum', enum: 'RKEAction_E' },
    { name: 'authenticationResponse', num: 3, kind: 'enum', enum: 'AuthenticationLevel_E' },
    { name: 'WhitelistOperation', num: 16, kind: 'msg', msg: 'WhitelistOperation' },
    { name: 'setMetaDataForKey', num: 22, kind: 'msg', msg: 'KeyMetadata' },
    { name: 'personalizationInformation', num: 25, kind: 'msg', msg: 'PersonalizationInformation' }
  ],
  FromVCSECMessage: [
    { name: 'vehicleStatus', num: 1, kind: 'msg', msg: 'VehicleStatus' },
    { name: 'sessionInfo', num: 2, kind: 'msg', msg: 'SessionInfo' },
    { name: 'authenticationRequest', num: 3, kind: 'msg', msg: 'AuthenticationRequest' },
    { name: 'commandStatus', num: 4, kind: 'msg', msg: 'CommandStatus' },
    { name: 'personalizationInformation', num: 5, kind: 'msg', msg: 'PersonalizationInformation' },
    { name: 'whitelistInfo', num: 16, kind: 'msg', msg: 'WhitelistInfo' },
    { name: 'whitelistEntryInfo', num: 17, kind: 'msg', msg: 'WhitelistEntryInfo' },
    { name: 'vehicleInfo', num: 18, kind: 'msg', msg: 'VehicleInfo' },
    { name: 'capabilities', num: 19, kind: 'msg', msg: 'Capabilities' },
    { name: 'externalAuthStatus', num: 20, kind: 'msg', msg: 'ExternalAuthStatus' },
    { name: 'keyStatusInfo', num: 21, kind: 'msg', msg: 'KeyStatusInfo' },
    { name: 'activeKey', num: 22, kind: 'msg', msg: 'ActiveKey' },
    { name: 'unknownKeyInfo', num: 23, kind: 'msg', msg: 'UnknownKeyInfo' },
    { name: 'unsecureNotification', num: 39, kind: 'msg', msg: 'UnsecureNotification' }
  ],
  InformationRequest: [
    { name: 'informationRequestType', num: 1, kind: 'enum', enum: 'InformationRequestType' },
    { name: 'keyId', num: 2, kind: 'msg', msg: 'KeyIdentifier' }
  ],
  KeyIdentifier: [{ name: 'publicKeySHA1', num: 1, kind: 'bytes' }],
  PublicKey: [{ name: 'PublicKeyRaw', num: 1, kind: 'bytes' }],
  KeyMetadata: [{ name: 'keyFormFactor', num: 1, kind: 'enum', enum: 'KeyFormFactor' }],
  PermissionChange: [
    { name: 'key', num: 1, kind: 'msg', msg: 'PublicKey' },
    { name: 'permission', num: 2, kind: 'enum', enum: 'WhitelistKeyPermission_E', rep: true },
    { name: 'secondsToBeActive', num: 3, kind: 'int' }
  ],
  WhitelistOperation: [
    { name: 'addPublicKeyToWhitelist', num: 1, kind: 'msg', msg: 'PublicKey' },
    { name: 'removePublicKeyFromWhitelist', num: 2, kind: 'msg', msg: 'PublicKey' },
    { name: 'addPermissionsToPublicKey', num: 3, kind: 'msg', msg: 'PermissionChange' },
    { name: 'removePermissionsFromPublicKey', num: 4, kind: 'msg', msg: 'PermissionChange' },
    { name: 'addKeyToWhitelistAndAddPermissions', num: 5, kind: 'msg', msg: 'PermissionChange' },
    { name: 'metadataForKey', num: 6, kind: 'msg', msg: 'KeyMetadata' },
    { name: 'updateKeyAndPermissions', num: 7, kind: 'msg', msg: 'PermissionChange' }
  ],
  PersonalizationInformation: [{ name: 'VIN', num: 1, kind: 'bytes' }],
  SessionInfo: [
    { name: 'token', num: 1, kind: 'bytes' },
    { name: 'counter', num: 2, kind: 'int' },
    { name: 'publicKey', num: 3, kind: 'bytes' }
  ],
  CommandStatus: [
    { name: 'operationStatus', num: 1, kind: 'enum', enum: 'OperationStatus_E' },
    { name: 'signedMessageStatus', num: 2, kind: 'msg', msg: 'SignedMessage_status' },
    { name: 'whitelistOperationStatus', num: 3, kind: 'msg', msg: 'WhitelistOperation_status' }
  ],
  SignedMessage_status: [
    { name: 'counter', num: 1, kind: 'int' },
    { name: 'signedMessageInformation', num: 2, kind: 'enum', enum: 'SignedMessage_information_E' }
  ],
  WhitelistOperation_status: [
    { name: 'whitelistOperationInformation', num: 1, kind: 'enum', enum: 'WhitelistOperation_information_E' },
    { name: 'signerOfOperation', num: 2, kind: 'msg', msg: 'KeyIdentifier' },
    { name: 'operationStatus', num: 3, kind: 'enum', enum: 'OperationStatus_E' }
  ],
  WhitelistInfo: [
    { name: 'numberOfEntries', num: 1, kind: 'int' },
    { name: 'whitelistEntries', num: 2, kind: 'msg', msg: 'KeyIdentifier', rep: true }
  ],
  WhitelistEntryInfo: [
    { name: 'keyId', num: 1, kind: 'msg', msg: 'KeyIdentifier' },
    { name: 'publicKey', num: 2, kind: 'msg', msg: 'PublicKey' },
    { name: 'permissions', num: 3, kind: 'enum', enum: 'WhitelistKeyPermission_E', rep: true },
    { name: 'metadataForKey', num: 4, kind: 'msg', msg: 'KeyMetadata' },
    { name: 'secondsEntryRemainsActive', num: 5, kind: 'int' }
  ],
  VehicleStatus: [
    { name: 'closureStatuses', num: 1, kind: 'msg', msg: 'ClosureStatuses' },
    { name: 'vehicleLockState', num: 2, kind: 'enum', enum: 'VehicleLockState_E' }
  ],
  ClosureStatuses: [
    en('frontDriverDoor', 1, 'ClosureState_E'),
    en('frontPassengerDoor', 2, 'ClosureState_E'),
    en('rearDriverDoor', 3, 'ClosureState_E'),
    en('rearPassengerDoor', 4, 'ClosureState_E'),
    en('rearTrunk', 5, 'ClosureState_E'),
    en('frontTrunk', 6, 'ClosureState_E'),
    en('chargePort', 7, 'ClosureState_E')
  ],
  VehicleInfo: [{ name: 'VIN', num: 1, kind: 'string' }],
  Capabilities: [
    { name: 'chargePortOpen', num: 1, kind: 'bool' },
    { name: 'chargePortClose', num: 2, kind: 'bool' }
  ],
  AuthenticationRequest: [
    { name: 'keyIdToAuth', num: 1, kind: 'msg', msg: 'KeyIdentifier' },
    { name: 'sessionInfo', num: 2, kind: 'msg', msg: 'SessionInfo' },
    { name: 'requestedLevel', num: 3, kind: 'enum', enum: 'AuthenticationLevel_E' }
  ],
  ExternalAuthStatus: [
    { name: 'active', num: 1, kind: 'bool' },
    { name: 'messageToBeSignedAsBytes', num: 2, kind: 'bytes' }
  ],
  KeyStatus: [
    { name: 'keyId', num: 1, kind: 'msg', msg: 'KeyIdentifier' },
    { name: 'nfcPresence', num: 2, kind: 'enum', enum: 'NFCPresence' },
    { name: 'blePresence', num: 3, kind: 'enum', enum: 'BLEPresence' }
  ],
  KeyStatusInfo: [{ name: 'keyStatuses', num: 1, kind: 'msg', msg: 'KeyStatus', rep: true }],
  ActiveKey: [{ name: 'activeKey', num: 1, kind: 'msg', msg: 'KeyIdentifier' }],
  UnknownKeyInfo: [
    { name: 'keyStatus', num: 1, kind: 'msg', msg: 'KeyStatus' },
    { name: 'publicKey', num: 2, kind: 'msg', msg: 'PublicKey' },
    { name: 'keyFormFactor', num: 3, kind: 'enum', enum: 'KeyFormFactor' }
  ],
  UnsecureNotification: [
    { name: 'notifyUser', num: 1, kind: 'bool' },
    { name: 'closureStatuses', num: 2, kind: 'msg', msg: 'ClosureStatuses' }
  ]
};

export const SPEC = { messages: MESSAGES, enums: ENUMS };
