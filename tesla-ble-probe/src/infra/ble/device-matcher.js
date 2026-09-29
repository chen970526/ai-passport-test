// 广播匹配与排序：把「一堆广播」收敛成「哪一条最可能是我要的那台车」。
//
// 现实里这里最容易踩的坑：不同固件 / 不同系统对分隔符和大小写不一致
// （Tesla 723591 / Tesla_723591 / tesla723591），以及车主改过蓝牙名。
// 所以匹配器除了精确 / 前缀，还兜一层「只留字母数字并转大写」的宽松比较；
// 名字被系统缓存吃掉时，再用广播里的服务 UUID（0211）兜底。

import { TESLA_SERVICE_SHORT } from './gatt.js';

// 归一化：丢掉分隔符差异与大小写差异
export function normName(s) {
  return String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

// 广播里是否带了特斯拉 VCSEC 服务；uni 可能回短格式（0211）也可能回 128 位全形式
export function hasTeslaService(d) {
  const su = (d && d.advertisServiceUUIDs) || [];
  for (const u of su) {
    const n = normName(u);
    if (n === normName(TESLA_SERVICE_SHORT) || n.indexOf(normName(TESLA_SERVICE_SHORT)) === 0) return true;
  }
  return false;
}

// names: { exact: [], prefixes: [] }
// 命中返回 { matched, mode }（mode 只进日志，用于判断「到底靠什么认出来的」），没命中返回 null。
export function makeMatcher(names) {
  const exact = (names && names.exact) || [];
  const prefixes = (names && names.prefixes) || [];
  const exactN = exact.map(normName);
  const prefixN = prefixes.map(normName);
  return (n) => {
    const s = String(n || '');
    for (const e of exact) if (s === e) return { matched: e, mode: 'exact' };
    for (const p of prefixes) if (p && s.indexOf(p) === 0) return { matched: p, mode: 'prefix' };
    const nn = normName(s);
    for (const e of exactN) if (nn === e) return { matched: e, mode: 'loose' };
    for (const p of prefixN) if (p && nn.indexOf(p) === 0) return { matched: p, mode: 'loose-prefix' };
    return null;
  };
}

// 手选列表的排序：命中 VIN → 广播了 0211 → 有名字 → 无名，同级按信号强弱（RSSI 越接近 0 越强）
export function sortAdv(list) {
  const rank = (e) => (e.hit ? 0 : e.tesla ? 1 : e.name ? 2 : 3);
  const r = (e) => (typeof e.rssi === 'number' && e.rssi ? e.rssi : -999);
  return (list || []).slice().sort(
    (a, b) => rank(a) - rank(b) || r(b) - r(a) || String(a.name || '').localeCompare(String(b.name || ''))
  );
}
