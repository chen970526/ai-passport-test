// 全站唯一的「给人看的提示」出口：一个带「关闭 / 复制」两个按钮的弹窗。
//
// 为什么不再用 uni.showToast：
//   1）toast 的 title 在 App 端只画得下一两行，车辆回执、protobuf 报错、原始 hex
//      这类长文本会被剪掉，而恰恰是这些内容最需要原样贴出来；
//   2）toast 会自动消失，来不及看也没法选中；
//   3）弹窗正文可滚动，且「复制」按钮复制的是**没截断的全文**。
//
// 约定：页面里所有 toast() 都转发到这里的 notify()，正文一律不许先 slice。

// 弹窗正文最多显示这么多字，超出只留头部并提示用「复制」取全文。
// 500 字足够放下「车辆回执 + 人话解释 + 下一步动作」这种多行提示。
export const NOTIFY_MAX = 500;
export const NOTIFY_TITLE = '提示';

// 长文本压成弹窗预览；全文由 notify() 自己留着给剪贴板。
export function preview(text, max) {
  const s = String(text === undefined || text === null ? '' : text);
  const cap = max === undefined ? NOTIFY_MAX : max;
  if (s.length <= cap) return s;
  return s.slice(0, cap) + '\n…（共 ' + s.length + ' 字，点「复制」取全文）';
}

// 复制原文。返回是否真的交给了剪贴板（不支持的环境返回 false）。
export function copyText(text, onDone) {
  const full = String(text === undefined || text === null ? '' : text);
  if (typeof uni === 'undefined' || !uni.setClipboardData) {
    if (onDone) onDone(false);
    return false;
  }
  uni.setClipboardData({
    data: full,
    success: () => {
      if (onDone) onDone(true);
    },
    fail: () => {
      if (onDone) onDone(false);
    }
  });
  return true;
}

// 弹一个「关闭 / 复制」窗；返回传入的全文，方便调用方顺手写进日志。
export function notify(text, title) {
  const full = String(text === undefined || text === null ? '' : text);
  if (typeof uni === 'undefined' || !uni.showModal) return full;
  uni.showModal({
    title: title || NOTIFY_TITLE,
    content: preview(full),
    showCancel: true,
    cancelText: '关闭',
    confirmText: '复制',
    success: (res) => {
      if (res && res.confirm) copyText(full);
    }
  });
  return full;
}
