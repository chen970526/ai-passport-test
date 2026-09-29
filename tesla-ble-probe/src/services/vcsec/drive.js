// VCSEC 域功能接口：驾驶授权（Remote Drive）—— 解锁之后能不能挂挡，靠的是这一条**独立**命令。
//
// 取证（本地副本 ref-repos/vehicle-command，commit f61e29e，逐行核过）：
//   pkg/vehicle/vcsec.go:173-193  executeRKEAction(ctx, action)：Unlock / Lock / RemoteDrive /
//       AutoSecure / Wake 全都从这一个出口走 —— 同一个 VCSEC 域、同一份 v.authMethod、
//       同一条 UnsignedMessage{ RKEAction: action } 载荷形状；
//   pkg/vehicle/vcsec.go:200-202  RemoteDrive(ctx) = executeRKEAction(RKE_ACTION_REMOTE_DRIVE)，
//       函数体就一行，没有任何 transport 判断 —— SDK 侧不存在「REMOTE_DRIVE 禁止走 BLE」的分支；
//   cmd/tesla-control/commands.go:311-318  "drive"（help: Remote start vehicle）与 "unlock"/"lock" 同级：
//       requiresAuth: true / requiresFleetAPI: false / 不设 domain；configureFlags 在 --ble 下
//       只拒绝 requiresFleetAPI 的命令，drive 不在其中 —— 官方 CLI 明确允许 drive 走 BLE；
//   pkg/proxy/command.go:207-208  Fleet 的 remote_start_drive 转调的还是同一个 RemoteDrive(ctx)，
//       两条通道最终发到车上的字节完全一样。
//
// 真机验证（本项目）：解锁后单独发这条，车辆接受、可以挂挡走人 —— 所以「BLE 发不了驾驶授权」
// 这个顾虑已经被排除。但**本文件仍然不把它并进 Unlock**：它是协议上独立的一条 RKEAction，
// 有自己的回执和自己的失败原因。串发发生在上层 vehicle-api.unlockAndDrive()，
// 那里能同时看到两条命令各自的台账；在这里偷偷夹带只会让「解锁成功、授权被拒」变成一坨。
//
// 成不成只认车端回执：GenericError_E 的处置建议由 command-dispatcher.genericErrorHint()
// 统一追加（这样锁车 / 解锁被拒时同样看得到下一步），本层只补一条人话警告。
// 绝不替车辆「模拟一个启动成功」。

import { RKE } from '../../domain/index.js';
import { log } from '../../infra/logging/log-bus.js';
import { sendRke } from './rke.js';

export async function requestDrive() {
  const r = await sendRke(RKE.RKE_ACTION_REMOTE_DRIVE, 'REMOTE_DRIVE');
  if (r && !r.ok) log('warn', '车辆没接受驾驶授权：先确认挡位在 P，再看上一行的拒绝原因');
  return r;
}
