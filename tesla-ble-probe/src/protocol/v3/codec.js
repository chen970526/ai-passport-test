// V3 帧分类 + 各域载荷编解码（VCSEC 域、裸 ToVCSECMessage 加白名单、car_server/INFOTAINMENT 域）。
//
// 权威依据：
//   internal/dispatcher/receiver.go                —— 收到的帧先按消息类型分流
//   pkg/vehicle/security.go:338 SendAddKeyRequestWithRole —— 加白名单走裸信封
//   pkg/vehicle/infotainment.go:19-50              —— car_server Action / Response

import { V3_SPEC } from './spec.js';
import { encode, decode, inspect } from '../pb.js';
import { toHex } from '../../infra/bytes.js';

// 帧分类：BLE 上可能同时出现 RoutableMessage（V3）和裸 FromVCSECMessage（加白名单那条老路）
export function parseFrame(body) {
  let rm = null;
  try {
    const obj = decode(V3_SPEC, 'RoutableMessage', body);
    const keys = Object.keys(obj);
    // 未知字段会被记成 f<n>；若全是 f* 说明这压根不是 RoutableMessage
    if (keys.length && keys.some((k) => k.charAt(0) !== 'f')) rm = obj;
  } catch (e) {
    rm = null;
  }
  if (rm) return { kind: 'routable', rm, text: inspect(V3_SPEC, 'RoutableMessage', rm) };
  let vcsec = null;
  let text = '';
  try {
    vcsec = decode(V3_SPEC, 'FromVCSECMessage', body);
    text = inspect(V3_SPEC, 'FromVCSECMessage', vcsec);
  } catch (e) {
    text = '(两种规格都解不出来) ' + toHex(body);
  }
  return { kind: 'vcsec', vcsec, text };
}

// ---------------------------------------------------------------- VCSEC 载荷

export function encodeUnsignedMessage(obj) {
  return encode(V3_SPEC, 'UnsignedMessage', obj);
}

export function decodeFromVcsec(bytes) {
  if (!bytes || !bytes.length) return { obj: {}, text: '(空 payload = 命令已受理)' };
  const obj = decode(V3_SPEC, 'FromVCSECMessage', bytes);
  return { obj, text: inspect(V3_SPEC, 'FromVCSECMessage', obj) };
}

// 加白名单的内层载荷：VCSEC.UnsignedMessage{WhitelistOperation{addKeyToWhitelistAndAddPermissions}}
// 对应官方 security.go addKeyPayload()。注意现行 proto 里已经没有 permission 数组，
// 权限改由 keyRole 表达（PermissionChange 只剩 key / secondsToBeActive / keyRole）。
export function buildAddKeyPayload(publicKey, role, formFactor) {
  return encode(V3_SPEC, 'UnsignedMessage', {
    WhitelistOperation: {
      addKeyToWhitelistAndAddPermissions: { key: { PublicKeyRaw: publicKey }, keyRole: role },
      metadataForKey: { keyFormFactor: formFactor }
    }
  });
}

// 加白名单：裸 ToVCSECMessage{signedMessage{PRESENT_KEY}}。
// 对应官方 security.go:338 SendAddKeyRequestWithRole —— 此刻还没有会话，
// 所以不走 RoutableMessage，直接把这个老式信封交给 BLE 层（首字节 0x0a 而不是 0x12）。
// 车辆会先回 operationStatus=WAIT 表示等刷卡，刷完再回 whitelistOperationStatus 终态。
export function buildAddKeyEnvelope(publicKey, role, formFactor) {
  const payload = buildAddKeyPayload(publicKey, role, formFactor);
  return encode(V3_SPEC, 'ToVCSECMessage', {
    signedMessage: { protobufMessageAsBytes: payload, signatureType: V3_SPEC.enums.VcsecSignatureType.SIGNATURE_TYPE_PRESENT_KEY }
  });
}

// ---------------------------------------------------------------- car_server（INFOTAINMENT）载荷
//
// 官方 pkg/vehicle/infotainment.go:19-50：
//   proto.Marshal(car_server.Action) → v.Send(DOMAIN_INFOTAINMENT, payload, auth) →
//   解 car_server.Response；result==OPERATIONSTATUS_ERROR 时把 result_reason.plain_text 报给用户。
// C++ 参考实现同构：tesla-ble/src/vehicle.cpp:1410/1414 → send_infotainment_action_ →
//   client.cpp:799 build_car_server_vehicle_action_message，:713 encrypt_payload=true。
// 两边都**不签名**（universal_message.proto:87-91 的 payload oneof 只有
// protobuf_message_as_bytes / session_info_request / session_info），
// 但域是 INFOTAINMENT、用的是 INFOTAINMENT 那份会话，见 src/store/v3-session-store.js 的分域会话表。

// actionName 必须是 src/protocol/v3/spec.js 里 VehicleAction 登记过的成员名，写错会在 encode 时抛错
export function buildCarServerAction(actionName, fields) {
  return encode(V3_SPEC, 'Action', { vehicleAction: { [actionName]: fields || {} } });
}

export function decodeFromCarServer(bytes) {
  if (!bytes || !bytes.length) return { obj: {}, text: '(空 payload = 车机已受理)' };
  const obj = decode(V3_SPEC, 'Response', bytes);
  return { obj, text: inspect(V3_SPEC, 'Response', obj) };
}
