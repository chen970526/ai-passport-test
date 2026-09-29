// 运行环境自检与保屏。这两件事都不属于协议，也不属于蓝牙，是「App 跑在哪」的事实。

import { errText } from '../ble/uni-ble-api.js';

// 车库前最该先看的一行日志：基座到底是不是新打的那个、蓝牙模块到底进没进。
// plus.bluetooth 只有在基座编译了 Bluetooth 模块时才存在；缺它就一定会弹
// 「打包时未添加bluetooth模块」，跟 manifest 里写了什么无关（写的是源码，跑的是基座）。
export function logRuntimeEnv(log) {
  try {
    if (typeof plus === 'undefined' || !plus.runtime) {
      log('warn', '非 App 环境：无 plus.runtime，蓝牙不可用');
      return;
    }
    const r = plus.runtime;
    log('info', '基座: version=' + r.version + ' (code ' + (r.versionCode || '?') + ') appid=' + r.appid +
      (r.standalone ? ' 独立App' : ' 调试基座'));
    if (typeof plus.bluetooth === 'undefined') {
      log('error', '基座里没有 Bluetooth 模块（plus.bluetooth 不存在）—— 说明手机上装的还是旧基座，' +
        '或打包时 manifest 的 modules 被 HBuilderX 可视化界面回写清掉了。' +
        '请在 manifest.json「App模块配置」里确认 蓝牙(Bluetooth) 已勾选，并抬高 versionCode 重新打基座。');
    } else {
      log('ok', 'Bluetooth 模块已就绪（plus.bluetooth 存在）');
    }
  } catch (e) {
    log('warn', '读运行环境失败: ' + errText(e));
  }
}

// 绑定时要等 60 秒刷钥匙卡，锁屏就整轮作废；车库里这一点比什么都值钱。
export function keepScreenOn(on) {
  try {
    if (typeof uni !== 'undefined' && uni.setKeepScreenOn) uni.setKeepScreenOn({ keepScreenOn: !!on });
  } catch (e) { /* 无 WAKE_LOCK 时忽略 */ }
}
