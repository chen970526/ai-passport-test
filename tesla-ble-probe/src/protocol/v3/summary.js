// V3 摘要文案（给 UI / 日志用的人话）：RoutableMessage、FromVCSECMessage、car_server.Response。
//
// 只读 protobuf 结果拼字符串，不产生任何上线字节。

import { V3_SPEC } from './spec.js';
import { inspect } from '../pb.js';
import { toHex } from '../../infra/bytes.js';
import { FLAGS } from './constants.js';

// ---------------------------------------------------------------- 摘要（UI 文案）

export function label(enumName, value) {
  if (value === undefined || value === null) return '(默认0)';
  const map = V3_SPEC.enums[enumName];
  if (!map) return String(value);
  for (const k of Object.keys(map)) {
    if (map[k] === value) return k + '(' + value + ')';
  }
  return '未知(' + value + ')';
}

function flagsText(flags) {
  const bits = [];
  if (flags & (1 << FLAGS.FLAG_USER_COMMAND)) bits.push('USER_COMMAND');
  if (flags & (1 << FLAGS.FLAG_ENCRYPT_RESPONSE)) bits.push('ENCRYPT_RESPONSE');
  return bits.length ? bits.join('|') : '0';
}

// 协议层（RoutableMessage）摘要
export function summarize(rm) {
  if (!rm) return { kind: 'none', text: '(空)' };
  if (rm.session_info_request) {
    const pk = rm.session_info_request.public_key;
    return { kind: 'handshakeRequest', text: 'session_info_request public_key=' + (pk ? pk.length + 'B' : '缺') + (rm.uuid ? ' uuid=' + toHex(rm.uuid) : '') };
  }
  if (rm.session_info) {
    const st = rm.session_info.status === undefined ? 0 : rm.session_info.status;
    const tag = rm.signature_data && rm.signature_data.session_info_tag ? rm.signature_data.session_info_tag.tag : null;
    return {
      kind: 'handshake',
      status: st,
      text: 'session_info ' + label('Session_Info_Status', st) +
        ' counter=' + (rm.session_info.counter === undefined ? 0 : rm.session_info.counter) +
        ' clock_time=' + (rm.session_info.clock_time === undefined ? 0 : rm.session_info.clock_time) +
        ' request_uuid=' + (rm.request_uuid ? toHex(rm.request_uuid) : '缺') +
        ' tag=' + (tag ? toHex(tag) : '缺')
    };
  }
  const fault = rm.signedMessageStatus ? rm.signedMessageStatus.signed_message_fault : undefined;
  const sd = rm.signature_data || {};
  const bits = [];
  if (fault !== undefined && fault !== 0) bits.push('fault=' + label('MessageFault_E', fault));
  if (rm.flags) bits.push('flags=' + flagsText(rm.flags));
  if (rm.protobuf_message_as_bytes) bits.push('payload=' + rm.protobuf_message_as_bytes.length + 'B');
  if (sd.AES_GCM_Response_data) bits.push('响应已加密 counter=' + (sd.AES_GCM_Response_data.counter === undefined ? 0 : sd.AES_GCM_Response_data.counter));
  if (sd.AES_GCM_Personalized_data) bits.push('请求 tag=' + toHex(sd.AES_GCM_Personalized_data.tag).slice(0, 16) + '…');
  return {
    kind: fault === undefined || fault === 0 ? 'message' : 'fault',
    fault: fault === undefined ? 0 : fault,
    text: 'RoutableMessage' + (bits.length ? ' ' + bits.join(' ') : ' (无 payload)')
  };
}

// 应用层（FromVCSECMessage）摘要，形状和旧版 summarize 保持一致，方便页面复用判断
export function summarizeVcsec(obj) {
  if (!obj) return { kind: 'empty', status: 0, text: '空响应（payload 为 0 字节 = 成功）' };
  const cs = obj.commandStatus;
  if (cs) {
    const st = cs.operationStatus === undefined ? 0 : cs.operationStatus;
    if (cs.whitelistOperationStatus) {
      const w = cs.whitelistOperationStatus;
      const signer = w.signerOfOperation && w.signerOfOperation.publicKeySHA1 ? toHex(w.signerOfOperation.publicKeySHA1) : '-';
      return {
        kind: 'whitelist',
        status: w.operationStatus === undefined ? st : w.operationStatus,
        info: w.whitelistOperationInformation === undefined ? 0 : w.whitelistOperationInformation,
        text: '白名单操作 status=' + label('VCOperationStatus_E', w.operationStatus) +
          ' info=' + label('WhitelistOperation_information_E', w.whitelistOperationInformation) + ' 签署者=' + signer
      };
    }
    if (cs.signedMessageStatus) {
      const s = cs.signedMessageStatus;
      return {
        kind: 'signed',
        status: st,
        info: s.signedMessageInformation === undefined ? 0 : s.signedMessageInformation,
        counter: s.counter,
        text: '签名报文 status=' + label('VCOperationStatus_E', st) +
          ' info=' + label('SignedMessage_information_E', s.signedMessageInformation) +
          (s.counter !== undefined ? ' 车辆期望 counter=' + s.counter : '')
      };
    }
    return { kind: 'command', status: st, text: 'status=' + label('VCOperationStatus_E', st) };
  }
  if (obj.nominalError) {
    return { kind: 'error', status: 2, text: 'nominalError ' + label('GenericError_E', obj.nominalError.genericError) };
  }
  if (obj.vehicleStatus) {
    return { kind: 'status', status: 0, text: '车辆状态 ' + inspect(V3_SPEC, 'VehicleStatus', obj.vehicleStatus) };
  }
  if (obj.whitelistInfo) {
    const list = (obj.whitelistInfo.whitelistEntries || []).map((e) => toHex(e.publicKeySHA1));
    return { kind: 'whitelistInfo', status: 0, text: '白名单条目数=' + (obj.whitelistInfo.numberOfEntries === undefined ? '?' : obj.whitelistInfo.numberOfEntries) + ' [' + list.join(' ') + ']' };
  }
  if (obj.whitelistEntryInfo) {
    const k = obj.whitelistEntryInfo.publicKey && obj.whitelistEntryInfo.publicKey.PublicKeyRaw;
    return {
      kind: 'whitelistEntry',
      status: 0,
      text: '条目 slot=' + obj.whitelistEntryInfo.slot + ' role=' + label('Role', obj.whitelistEntryInfo.keyRole) +
        ' 公钥=' + (k ? toHex(k) : '-')
    };
  }
  return { kind: 'other', status: 0, text: '(未识别) ' + inspect(V3_SPEC, 'FromVCSECMessage', obj) };
}

// 车机侧应用层摘要。注意 car_server 的 OperationStatus_E 只有 OK/ERROR 两档
// （没有 VCSEC 那套 WAIT），别拿 UMOperationStatus_E 去套。
export function summarizeCarServer(obj) {
  if (!obj || !Object.keys(obj).length) return { kind: 'empty', status: 0, text: '空响应（车机已受理，没有 actionStatus）' };
  let status = 0;
  let text = '';
  const as = obj.actionStatus;
  if (as) {
    status = as.result === undefined ? 0 : as.result;
    const reason = as.result_reason && as.result_reason.plain_text ? ' 原因：' + as.result_reason.plain_text : '';
    text = 'actionStatus=' + label('CSOperationStatus_E', status) + reason;
  }
  if (obj.vehicleData) {
    return {
      kind: 'vehicleData',
      status,
      text: (text ? text + ' ' : '') + inspect(V3_SPEC, 'VehicleData', obj.vehicleData),
      data: obj.vehicleData
    };
  }
  if (obj.ping) return { kind: 'ping', status, text: (text ? text + ' ' : '') + inspect(V3_SPEC, 'Ping', obj.ping) };
  return { kind: 'action', status, text: text || '(无 actionStatus) ' + inspect(V3_SPEC, 'Response', obj) };
}
