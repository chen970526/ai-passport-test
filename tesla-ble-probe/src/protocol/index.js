// 协议层统一出口：上层（domain / services / 页面）只需要 import 这一个文件。
//
// 旧版「VCSEC 直连 + counter 当 nonce」那一套已经删除，车辆固件只认 V3 了。
// 这里刻意用具名再导出（不用 export *），依赖面一眼可见；协议字节的权威依据注释
// 跟着各自函数待在 v3/ 下的模块里（总述见 v3/metadata.js 文件头）。

import { V3_SPEC } from './v3/spec.js';
import { encode, decode, inspect } from './pb.js';
import { toHex, equalBytes } from '../infra/bytes.js';
// 长度前缀属于传输层，与协议版本无关：统一由 infra/ble/frame-codec.js 提供，协议层不再实现一遍
import { prependLength, stripLength } from '../infra/ble/frame-codec.js';

export { newKeyPair, keyIdOf, bleNamesForVin } from './identity.js';

export {
  DOMAIN,
  TAG,
  SIGTYPE,
  FLAGS,
  FAULT,
  UM,
  DEFAULT_EXPIRES_IN,
  MAX_EPOCH_SECONDS,
  ADDR_LEN,
  NONCE_LEN,
  LABEL_SESSION_INFO,
  LABEL_MESSAGE_AUTH,
  localNow,
  newRoutingAddress,
  newUuid
} from './v3/constants.js';

export { Metadata, requestMetadata, responseMetadata } from './v3/metadata.js';

export { sharedKeyOf, subkey, buildSessionInfoRequest, sessionInfoHmac, applySessionInfo } from './v3/handshake.js';

export {
  buildPlainRequest,
  encryptCommand,
  authorizeHmacCommand,
  requestIdOf,
  responseDomainByte,
  decryptResponse
} from './v3/aead.js';

export {
  parseFrame,
  encodeUnsignedMessage,
  decodeFromVcsec,
  buildAddKeyPayload,
  buildAddKeyEnvelope,
  buildCarServerAction,
  decodeFromCarServer
} from './v3/codec.js';

export { label, summarize, summarizeVcsec, summarizeCarServer } from './v3/summary.js';

export { V3_SPEC, encode, decode, inspect, toHex, equalBytes, prependLength, stripLength };
