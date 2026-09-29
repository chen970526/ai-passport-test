// ---------------------------------------------------------------- 图标表（纯内联 SVG）
//
// 界面上所有图标都是这里的一行 path，运行时编成 data:image/svg+xml 交给 <image>：
// 不引图片文件、不引字体图标，省掉 App 打包漏静态资源那一类坑，也保证 H5 / App 同一份代码。
// 画法和 components/car-icon 一样遵循「一套 24×24 栅格 + 描边」，只有两张车辆线稿例外
// （car-side / car-top 是首页与控制页的主视觉，用各自的 viewBox）。
//
// 约定：
//   vb —— viewBox，缺省 '0 0 24 24'
//   s  —— 描边图形（fill=none，颜色给 stroke）
//   f  —— 实心图形（颜色给 fill）
//   sw —— 描边宽度覆盖值，只在需要更粗的线稿上写
// 颜色一律写成 {c}，由 iconSvg() 替换；SVG 内部属性只用单引号，编码时就不必转义双引号。

const CAR_SIDE_BODY =
  "M22 104 L26 88 C30 78 40 72 52 70 L86 66 L116 44 C126 37 138 34 152 34 " +
  "L198 36 C214 37 228 43 240 53 L262 70 L292 76 C302 79 308 86 308 96 L308 104 " +
  "C308 108 305 110 300 110 L30 110 C25 110 22 108 22 104 Z";

const CAR_TOP_BODY =
  "M110 12 C132 12 150 26 158 48 L170 86 C180 96 186 110 186 128 L186 236 " +
  "C186 262 180 284 168 300 L160 316 C156 326 146 332 134 332 L86 332 " +
  "C74 332 64 326 60 316 L52 300 C40 284 34 262 34 236 L34 128 " +
  "C34 110 40 96 50 86 L62 48 C70 26 88 12 110 12 Z";

export const ICONS = {
  // ---------------------------------------------------------------- 车控
  lock: { s: "<path d='M7 10V7a5 5 0 0 1 10 0v3'/><rect x='4.5' y='10' width='15' height='10.5' rx='2.5'/>" },
  unlock: { s: "<path d='M7 10V7a5 5 0 0 1 9.6-2'/><rect x='4.5' y='10' width='15' height='10.5' rx='2.5'/><path d='M12 14v2.5'/>" },
  // 前/后备箱：同一副侧视轮廓，把「掀起的那一端」镜像出去，两个图标天然对称
  frunk: {
    s: "<path d='M3.5 18.5h17'/><path d='M5.5 18.5v-2.5l3-3.5h7l3 3.5v2.5'/><circle cx='9' cy='19.5' r='1.5'/><circle cx='15.5' cy='19.5' r='1.5'/><path d='M5.5 12.5 L4 8.5h5.5'/>"
  },
  trunk: {
    vb: '0 0 24 24',
    s: "<path d='M20.5 18.5h-17'/><path d='M18.5 18.5v-2.5l-3-3.5h-7l-3 3.5v2.5'/><circle cx='15' cy='19.5' r='1.5'/><circle cx='8.5' cy='19.5' r='1.5'/><path d='M18.5 12.5 L20 8.5h-5.5'/>"
  },
  charge: { f: "<path d='M13.6 2.4 5.4 13.6h4.4L8.4 21.6l9.2-11.8h-4.6z'/>" },
  chargeport: {
    s: "<ellipse cx='12' cy='12' rx='6' ry='8.5'/><path d='M13.2 7.6 10 12.4h2.6l-.8 4 3.4-5h-2.6z' fill='{c}' stroke='none'/>"
  },
  flash: { s: "<path d='M3.5 14a4.5 4.5 0 0 1 4.5-4.5h1v9H8a4.5 4.5 0 0 1-4.5-4.5z'/><path d='M13 9.5 17 7'/><path d='M13.5 14h5'/><path d='M13 18.5 17 21'/>" },
  horn: { s: "<path d='M4 10v4h3l4.5 3.5V6.5L7 10H4z'/><path d='M15 9.5a4 4 0 0 1 0 5'/><path d='M18 6.5a8 8 0 0 1 0 11'/>" },
  power: { s: "<path d='M12 3.5V11'/><path d='M7.2 6.4a7 7 0 1 0 9.6 0'/>" },
  vent: { s: "<path d='M3 8.5h10.5a3 3 0 1 0-3-3'/><path d='M3 14h13.5a3 3 0 1 1-3 3'/><path d='M3 19.5h7'/>" },
  car: { s: "<path d='M3 15.5h18'/><path d='M5 15.5v-2.5l3-4h8l3 4v2.5'/><circle cx='8.5' cy='17' r='1.7'/><circle cx='15.5' cy='17' r='1.7'/>", vb: '0 0 24 24' },

  // ---------------------------------------------------------------- 温度 / 舒适
  thermo: { s: "<path d='M12 4.2a2.2 2.2 0 0 1 2.2 2.2v7.2a4.2 4.2 0 1 1-4.4 0V6.4A2.2 2.2 0 0 1 12 4.2z'/><path d='M12 9v5.5'/>" },
  heat: { s: "<circle cx='12' cy='12' r='4'/><path d='M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8'/>" },
  cool: { s: "<path d='M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9'/><path d='M9.5 5 12 3l2.5 2M9.5 19 12 21l2.5-2'/>" },
  fan: { s: "<circle cx='12' cy='12' r='1.8'/><path d='M12 10.2C12 6 10.6 4 8.4 4 6 4 5 6.6 6.6 8.6'/><path d='M13.8 12c4.2 0 6.2-1.4 6.2-3.6 0-2.4-2.6-3.4-4.6-1.8'/><path d='M12 13.8c0 4.2 1.4 6.2 3.6 6.2 2.4 0 3.4-2.6 1.8-4.6'/><path d='M10.2 12C6 12 4 13.4 4 15.6c0 2.4 2.6 3.4 4.6 1.8'/>" },

  // ---------------------------------------------------------------- 信息 / 位置
  pin: { s: "<path d='M12 21.2c4.4-4.6 6.8-7.8 6.8-10.7A6.8 6.8 0 0 0 5.2 10.5c0 2.9 2.4 6.1 6.8 10.7z'/><circle cx='12' cy='10.2' r='2.4'/>" },
  gauge: { s: "<path d='M4.2 17.5a8.5 8.5 0 1 1 15.6 0'/><path d='M12 17.5 15.8 11'/><circle cx='12' cy='17.9' r='1.2' fill='{c}' stroke='none'/>" },
  tire: { s: "<circle cx='12' cy='12' r='8'/><circle cx='12' cy='12' r='3.2'/><path d='M12 4v3M12 17v3M4 12h3M17 12h3'/>" },
  calendar: { s: "<rect x='4' y='6' width='16' height='14' rx='2.5'/><path d='M4 10.5h16M8.5 3.5V7M15.5 3.5V7'/>" },
  shield: { s: "<path d='M12 3.2 19 6v5.2c0 4.4-2.9 7.8-7 9.6-4.1-1.8-7-5.2-7-9.6V6z'/><path d='M9 12l2.2 2.2L15.2 10'/>" },
  battery: { s: "<rect x='2.5' y='8' width='16.5' height='8.5' rx='2.2'/><path d='M21.5 11v2.5'/><path d='M5.5 10.5h4v3.5h-4z' fill='{c}' stroke='none'/>" },
  info: { s: "<circle cx='12' cy='12' r='8.6'/><path d='M12 11v5'/><circle cx='12' cy='7.8' r='1' fill='{c}' stroke='none'/>" },
  pulse: { s: "<path d='M3 12.5h3.6L9 5.5l3.6 13 2.4-6h5'/>" },
  key: { s: "<circle cx='8.2' cy='12' r='3.4'/><path d='M11.6 12H21'/><path d='M17.5 12v3.4'/><path d='M20.6 12v2.4'/>" },
  bluetooth: { s: "<path d='M7.2 7.4 16.8 16.6 12 20.4V3.6l4.8 3.8L7.2 16.6'/>" },
  wrench: { s: "<path d='M14.6 6.4a4.6 4.6 0 0 0 5.6 6l-2.6-2.6-2.4 2.4 2.6 2.6a4.6 4.6 0 0 1-6-5.6L8 13 5 10z'/>" },

  // ---------------------------------------------------------------- 通用
  chevron: { s: "<path d='M9.5 5.5 16 12l-6.5 6.5'/>" },
  chevronDown: { s: "<path d='M5.5 9.5 12 16l6.5-6.5'/>" },
  refresh: { s: "<path d='M20 12a8 8 0 1 1-2.4-5.7'/><path d='M20.4 4.4v4.2h-4.2'/>" },
  close: { s: "<path d='M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6'/>" },
  check: { s: "<path d='M5 12.8 9.6 17.4 19 7'/>" },
  warn: { s: "<path d='M12 3.6 21.2 19.6H2.8z'/><path d='M12 9.4v4.2'/><circle cx='12' cy='16.4' r='1' fill='{c}' stroke='none'/>" },
  plus: { s: "<path d='M12 5v14M5 12h14'/>" },
  minus: { s: "<path d='M5 12h14'/>" },

  // ---------------------------------------------------------------- 主视觉线稿
  'car-side': {
    vb: '0 0 330 130',
    sw: 3,
    s: `<path d='${CAR_SIDE_BODY}'/><path d='M96 66 120 47 C128 41 138 39 150 39 L196 41 C208 42 218 46 226 54 L242 66 Z'/><circle cx='92' cy='110' r='15'/><circle cx='92' cy='110' r='5'/><circle cx='238' cy='110' r='15'/><circle cx='238' cy='110' r='5'/><path d='M30 96h20'/>`
  },
  'car-top': {
    vb: '0 0 220 344',
    sw: 3,
    s: `<path d='${CAR_TOP_BODY}'/><path d='M56 92 C80 82 140 82 164 92'/><path d='M62 112 C80 100 140 100 158 112'/><path d='M70 152 L150 152'/><path d='M62 244 C80 256 140 256 158 244'/><path d='M34 118 18 128 M186 118 202 128'/><path d='M60 300 L160 300'/>`
  }
};

export const ICON_DEFAULT_COLOR = '#e8eaed';

// 把图标编成 <image> 能直接吃的 data URI。
// 只做最小集转义：SVG 内部属性全部用单引号，所以不必处理双引号；
// 但 # 必须转（data URI 里 # 之后的内容会被当成 fragment，颜色值会整条截断）。
function enc(s) {
  return s
    .replace(/\s+/g, ' ')
    .replace(/%/g, '%25')
    .replace(/#/g, '%23')
    .replace(/&/g, '%26')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E');
}

// 生成一张图标的完整 SVG 文本（诊断页/单元测试会直接看这个字符串）。
export function iconSvg(name, color, weight) {
  const ic = ICONS[name];
  if (!ic) return '';
  const vb = ic.vb || '0 0 24 24';
  const c = color || ICON_DEFAULT_COLOR;
  const sw = ic.sw || weight || 1.7;
  const inner = (ic.s || ic.f || '').replace(/\{c\}/g, c);
  const style = ic.f
    ? `fill='${c}' stroke='none'`
    : `fill='none' stroke='${c}' stroke-width='${sw}' stroke-linecap='round' stroke-linejoin='round'`;
  return enc(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='${vb}' ${style}>${inner}</svg>`
  );
}

export function iconSrc(name, color, weight) {
  return 'data:image/svg+xml;charset=utf-8,' + iconSvg(name, color, weight);
}

export default ICONS;
