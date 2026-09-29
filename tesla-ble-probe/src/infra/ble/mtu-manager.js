// MTU 协商：从 Android ATT 常见上限往下阶梯试探，一律以**回读到的实际值**为准。
//
// 依据：
//   官方 ble.go:349-356  只做一次 ExchangeMTU(库上限 MaxMTU)，失败退回 DefaultMTU-3
//   官方 ble.go:354       blockLength = min(txMtu, maxBLEMessageSize) - 3
//   0Bu ble_client.cpp:201、sdkconfig.defaults:61-62  把首选 MTU 钉在 247
//   0Bu ble_client.cpp:1024-1030                      用 BLE_GAP_EVENT_MTU 回读真实协商值
//
// 为什么不照抄官方的 517：那个数来自第三方 go ble 库的 MaxMTU，本仓库没有 vendor 它，
// 不自造常量；改成「517 起阶梯试探」，并且每次都以 success 回调 / onBLEMTUChange
// 回读到的值记账 —— 车辆完全可以只接受比请求更小的 MTU，按请求值分包会把响应截断。

import { bleApi } from './uni-ble-api.js';
import { MAX_FRAME } from './frame-codec.js';

export const MTU_DEFAULT = 23; // Android 未协商前的 ATT 默认值
export const MTU_STEPS = [517, 247, 185, 128, 64];

// 单包可承载的净荷：ATT 操作码 + 句柄占 3 字节
export function payloadCap(mtu) {
  return Math.max(20, Math.min(mtu || MTU_DEFAULT, MAX_FRAME) - 3);
}

// 车辆侧主动改 MTU 时（iOS 由系统协商、Android 也可能回一个更小的值）通知回来。
// 返回 false 表示平台没有这个回调，调用方靠 setBLEMTU 的 success 返回值兜底。
export function watchMtuChange(onChange) {
  if (typeof uni === 'undefined' || typeof uni.onBLEMTUChange !== 'function') return false;
  try {
    uni.onBLEMTUChange((res) => onChange(res));
    return true;
  } catch (e) {
    return false;
  }
}

// 逐个试探，成功即返回协商到的 MTU；全部失败返回 MTU_DEFAULT（不抛错）。
export async function negotiateMtu(opts) {
  const o = opts || {};
  const log = o.log || function () {};
  const steps = o.steps || MTU_STEPS;
  for (const m of steps) {
    try {
      const res = await bleApi('setBLEMTU', { deviceId: o.deviceId, mtu: m });
      const actual = Number(res && res.mtu) > 0 ? Number(res.mtu) : m;
      if (o.apply) o.apply(actual);
      log('ok', 'MTU 协商 = ' + actual + (actual === m ? '' : '（请求 ' + m + '，车辆给的值更小，按实际值分包）') +
        '，每包载荷上限 ' + payloadCap(actual) + ' 字节');
      return actual;
    } catch (e) {
      /* 换小一档再试 */
    }
  }
  log('warn', 'setBLEMTU 不可用（' +
    (typeof uni !== 'undefined' && typeof uni.setBLEMTU === 'function' ? '车辆拒绝' : '当前平台无此 API') +
    '），按 MTU=' + MTU_DEFAULT + ' 工作；超过 20 字节的响应可能被截断');
  return MTU_DEFAULT;
}
