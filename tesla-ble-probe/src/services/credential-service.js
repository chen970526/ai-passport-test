// 「清除本机档案」的组合动作。
//
// store 层只做自己那份数据（密钥 / V3 会话 / 绑定档案），domain 层只管连接与重连。
// 而原先的 forgetKey / forgetBind 一个顺手清了另一份档案、一个顺手取消了暂停并停掉退避
// 循环 —— 这种跨层组合只能放在 services，否则 store 会反向 import domain 而成环。
// 日志文案、执行顺序与原来逐字一致。

import { log } from '../infra/logging/log-bus.js';
import { clearKeys } from '../store/credential-store.js';
import { clearBind } from '../store/bind-profile.js';
import { clearVehicle } from '../store/vehicle-store.js';
import { suspendAutoConnect, stopAutoReconnectLoop } from '../domain/auto-reconnect.js';

export function forgetBindProfile() {
  suspendAutoConnect(false);
  stopAutoReconnectLoop('绑定档案已清除');
  clearBind();
  // 档案没了 = 不再声明「这台车是谁」，车辆状态也就无从对齐，留着只会指鹿为马
  clearVehicle('绑定档案已清除');
  log('warn', '绑定档案已清除（下次打开 App 不再自动连接，需要重新走「扫描并连接」）');
}

export function forgetEverything() {
  clearKeys();
  forgetBindProfile();
  log('warn', '本机密钥与所有域的 V3 会话（含 counter）已清除（下次绑定需要重新刷卡）');
}
