// uni 本地存储的唯一薄封装。
//
// 「Node 里没有 uni」是常态（离线自测、H5 预览），所以这里一律静默返回而不是抛错 ——
// 上层的所有落盘 / 读取路径因此可以在无 uni 环境下原样跑通。

export function writeValue(key, value) {
  if (typeof uni === 'undefined' || !uni.setStorageSync) return;
  uni.setStorageSync(key, value);
}

export function readValue(key) {
  if (typeof uni === 'undefined' || !uni.getStorageSync) return null;
  const v = uni.getStorageSync(key);
  return v === '' || v === undefined ? null : v;
}

// 抹掉一个键：与 writeValue(key, null) 完全等价（原来就是 store(KEY, null) 这么写的）
export function removeValue(key) {
  writeValue(key, null);
}
