// ---------------------------------------------------------------- 绑定档案
//
// 一次完整绑定 = 生成密钥（已落盘）+ 刷钥匙卡把公钥写进车辆白名单 + 连上某台车的蓝牙。
// 只有把「哪台车」也记住，重启 App 才能直接自动连回去，而不是每次重新扫描手选。
//
// keyId / boundAt 只在 add-key 真正成功时写；deviceId / name 只要连上过就记 ——
// 自动重连的准入条件是「本机有私钥 + 至少连上过一台车」，因为此时钥匙大概率已在车上，
// 万一没成，命令会被车辆拒绝，日志里看得清清楚楚。
//
// 本模块只管这份数据本身。「清除档案」在这里是纯数据版（字段归零 + 删存储键），
// 原先混在里面的「取消 autoSuspended + 停止退避循环」上移到
// services/credential-service.js 的 forgetBindProfile()，免得 store 反向依赖 domain。

import { writeValue, readValue, removeValue } from '../infra/storage/local-store.js';
import { log } from '../infra/logging/log-bus.js';
import { BIND_STORE } from '../config/index.js';
import { state } from './app-state.js';

export const bind = { vin: '', deviceId: '', name: '', keyId: '', boundAt: 0, connectedAt: 0 };

export function hasBind() {
  return !!(bind.deviceId || bind.keyId);
}

export function saveBind(patch) {
  let changed = false;
  for (const k of Object.keys(bind)) {
    if (patch && patch[k] !== undefined && patch[k] !== '' && patch[k] !== null) {
      bind[k] = patch[k];
      changed = true;
    }
  }
  if (changed) writeValue(BIND_STORE, Object.assign({}, bind));
  return bind;
}

export function loadBind() {
  const raw = readValue(BIND_STORE);
  if (!raw || typeof raw !== 'object') return false;
  Object.assign(bind, raw);
  if (bind.vin && !state.vin) state.vin = bind.vin;
  if (hasBind()) {
    log('info', '已加载绑定档案：' + describeBind());
    return true;
  }
  return false;
}

export function clearBind() {
  bind.vin = '';
  bind.deviceId = '';
  bind.name = '';
  bind.keyId = '';
  bind.boundAt = 0;
  bind.connectedAt = 0;
  removeValue(BIND_STORE);
}

export function describeBind() {
  if (!hasBind()) return '无绑定档案';
  const when = (t) => (t ? new Date(t).toLocaleString() : '未记录');
  return (
    (bind.name || '(无名)') + ' / ' + (bind.deviceId ? String(bind.deviceId).slice(-14) : '未记录设备') +
    (bind.vin ? ' VIN…' + String(bind.vin).slice(-6) : '') +
    (bind.keyId ? ' keyId=' + bind.keyId.slice(0, 8) + '… 绑定于 ' + when(bind.boundAt) : ' 钥匙未登记') +
    (bind.connectedAt ? ' 上次连接 ' + when(bind.connectedAt) : '')
  );
}

// 绑定成功（钥匙进白名单）时调用：把本机 keyId 记进档案
export function markBound(keyId) {
  const id = keyId || state.keyId;
  saveBind({ vin: state.vin, keyId: id, boundAt: Date.now() });
  log('ok', '绑定档案已更新：这台车已登记本机钥匙 keyId=' + id);
}
