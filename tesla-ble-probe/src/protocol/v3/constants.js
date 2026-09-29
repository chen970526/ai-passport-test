// V3 协议的枚举别名与官方常量、会话标签、随机寻址/时钟小工具。
//
// 枚举全部取自 v3/spec.js 的规格表，本文件不再抄第二份数字。

import { V3_SPEC } from './spec.js';
import { randomBytes } from '../../infra/crypto/aes.js';

export const DOMAIN = V3_SPEC.enums.Domain;
export const TAG = V3_SPEC.enums.Tag;
export const SIGTYPE = V3_SPEC.enums.SignatureType;
export const FLAGS = V3_SPEC.enums.Flags;
export const FAULT = V3_SPEC.enums.MessageFault_E;
export const UM = V3_SPEC.enums.UMOperationStatus_E;

// 官方常量（internal/dispatcher/session.go, internal/authentication/crypto.go）
export const DEFAULT_EXPIRES_IN = 5; // dispatcher.defaultExpiration = 5s
export const MAX_EPOCH_SECONDS = 1 << 30; // authentication.epochLength
export const ADDR_LEN = 16; // receiver.go: addressLength / uuidLength / challengeLength
export const NONCE_LEN = 12; // gcm.NonceSize()

// 会话标签（native.go 里的 labelSessionInfo / labelMessageAuth）
export const LABEL_SESSION_INFO = 'session info';
export const LABEL_MESSAGE_AUTH = 'authenticated command';

export function localNow() {
  return Math.floor(Date.now() / 1000);
}

export function newRoutingAddress() {
  return randomBytes(ADDR_LEN);
}

export function newUuid() {
  return randomBytes(ADDR_LEN); // uuidLength == addressLength == 16
}
