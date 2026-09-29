// Android 运行时权限：按「基座实际的 targetSdkVersion」决定申请哪一套。
//
// 编译期已在 manifest 声明了 legacy(BLUETOOTH/ADMIN) + 新模型(SCAN/CONNECT) 两套，
// 但运行时该申请哪一套取决于基座，而不是我们的期望值：
//   targetSdk <= 30 → 只申请定位，申请 SCAN/CONNECT 会被判「永久拒绝」反而误导；
//   targetSdk >= 31 → 必须申请 SCAN/CONNECT，定位则不再是 BLE 的硬要求。
// 这段是 JS，改完热更新即可，不需要重新打包 —— 所以这里做运行时探测而不是写死。

import { errText } from '../ble/uni-ble-api.js';

export const PERM_LOCATION = 'android.permission.ACCESS_FINE_LOCATION';
export const PERM_SCAN = 'android.permission.BLUETOOTH_SCAN';
export const PERM_CONNECT = 'android.permission.BLUETOOTH_CONNECT';

// Android API Level；拿不到就按老模型走
export function sdkInt() {
  try {
    const VERSION = plus.android.importClass('android.os.Build$VERSION');
    return Number(VERSION.SDK_INT) || 0;
  } catch (e) {
    return 0;
  }
}

// Android 12（API 31）起 BLE 走新权限模型
export function usesNewBlePermissions() {
  return sdkInt() >= 31;
}

// 永远 resolve，不 reject：权限被拒是正常业务分支，调用方看 granted / denied 决定怎么提示。
export function ensureAndroidPermissions() {
  return new Promise((resolve) => {
    if (typeof plus === 'undefined' || !plus.android || typeof plus.android.requestPermissions !== 'function') {
      resolve({ needed: false, granted: true, perms: [] });
      return;
    }
    const perms = [PERM_LOCATION];
    if (usesNewBlePermissions()) perms.push(PERM_SCAN, PERM_CONNECT);
    plus.android.requestPermissions(
      perms,
      (e) => {
        const denied = (e.deniedAlways || []).concat(e.deniedPresent || []);
        resolve({ needed: true, granted: denied.length === 0, denied, perms });
      },
      (e) => resolve({ needed: true, granted: false, denied: [errText(e)], perms })
    );
  });
}
