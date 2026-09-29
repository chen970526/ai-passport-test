// ---------------------------------------------------------------- 界面显示层小工具
//
// 只做「已经算好的值 → 界面上的字」这一件事，不碰任何协议字段。
// 车辆数据的语义（单位换算、未知口径）全在 src/store/vehicle-store.js，这里别重复实现一遍。

import { UNKNOWN } from '../store/vehicle-store.js';

const pad = (n) => (n < 10 ? '0' + n : '' + n);

// 24 小时制的时分秒（状态更新时间这类）；不带日期 —— 需要日期时界面直接用它拼，别再假设有别的函数
export function clock(ts) {
  if (!ts) return UNKNOWN;
  const d = new Date(ts);
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

// 「刚刚 / 45 秒前 / 3 分钟前 / 5 小时前 / 12 天前」——首页那行小字用，
// 断线后界面显示的是最后一次拉到的状态，必须让人看出那份数据有多旧。
export function ago(ts, now) {
  if (!ts) return UNKNOWN;
  const s = Math.max(0, Math.floor(((now || Date.now()) - ts) / 1000));
  if (s < 10) return '刚刚';
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}

// 数值 + 单位；null / undefined（车机没回这个字段）一律显示「未知」，绝不显示 0。
export function unit(v, u, digits) {
  if (typeof v !== 'number' || !isFinite(v)) return UNKNOWN;
  const n = typeof digits === 'number' ? v.toFixed(digits) : String(Math.round(v * 10) / 10);
  return n + (u || '');
}

// 布尔 → 中文三态：null 仍然是「未知」
export function yesNo(v, yes, no) {
  if (v === true) return yes || '是';
  if (v === false) return no || '否';
  return UNKNOWN;
}
