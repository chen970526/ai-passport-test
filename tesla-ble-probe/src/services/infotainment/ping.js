// 车机域的功能接口：Ping 探针。
//
// 一个功能接口一个文件：本文件只装 pingInfotainment，发包统一走同目录的 car-action.js。

import { sendCarAction } from './car-action.js';

// 车机在线 + 认钥匙的探针：infotainment.go:59-70 Ping（官方注释「authenticated no-op」）。
// ping_id 取 1，和官方同一个值（"Responses are disambiguated on the protocol later"）。
export function pingInfotainment() {
  return sendCarAction('ping', { ping_id: 1 }, 'Ping（车机探针）');
}
