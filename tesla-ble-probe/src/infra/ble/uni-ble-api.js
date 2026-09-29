// uni-app 蓝牙 API 的 Promise 适配层。
//
// 为什么单独一个文件：uni 的蓝牙接口「传了回调就不再返回 Promise」，而且各端能力不齐
// （setBLEMTU 只有 Android 有、iOS 由系统自动协商；H5 / 小程序根本没有 plus.bluetooth）。
// 所有「这个环境到底有没有这个能力」的判断都收在这里，业务层只看到 Promise。

// 把 uni 的回调式 API 统一包成 Promise；环境缺能力时给出可判读的错，而不是 undefined 崩掉。
export function bleApi(name, opts) {
  return new Promise((resolve, reject) => {
    if (typeof uni === 'undefined' || typeof uni[name] !== 'function') {
      reject(new Error('当前运行环境没有 uni.' + name + '()：蓝牙只能在 App 真机上运行'));
      return;
    }
    uni[name](withCallbacks(opts || {}, resolve, reject));
  });
}

function withCallbacks(args, resolve, reject) {
  const out = {};
  for (const k in args) out[k] = args[k];
  out.success = (res) => resolve(res);
  out.fail = (e) => reject(new Error(errText(e)));
  return out;
}

// uni 的失败对象长得不统一：errMsg / errCode / 偶尔只有裸字符串。
// 这里必须把 errCode 带出来 —— 车库里排查时「10001 未连接」和「10007 特征不支持写」是两回事。
export function errText(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  const code = e.errCode !== undefined ? ' errCode=' + e.errCode : '';
  return (e.errMsg || e.message || JSON.stringify(e)) + code;
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------- ArrayBuffer 互转

export function abToBytes(buf) {
  return new Uint8Array(buf);
}

// 必须复制一份：直接 .buffer 会把视图偏移量一起带过去，Android 上表现为写进去的长度不对。
export function bytesToAb(bytes) {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out.buffer;
}

// ---------------------------------------------------------- UUID 归一化

export function uuidHex(u) {
  return String(u || '').replace(/-/g, '').toLowerCase();
}

// Android 会回全大写 128 位 UUID，iOS 有时回 4 位短形式，两边都得能匹配上。
export function matchUuid(u, target) {
  const a = uuidHex(u);
  const b = uuidHex(target);
  if (!a || !b) return false;
  if (a.length === b.length) return a === b;
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  return long.indexOf(short.length >= 8 ? short : short.padStart(8, '0')) === 0;
}
