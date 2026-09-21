// 页面脚本语法自检：把 .vue 里的 <script> 抽出来，重写 @/ 别名后真正 import 一遍。
// 目的只有一个 —— HBuilder X 的报错定位很慢，先在 Node 里把「拼写错 / 少括号 / 引错导出名」筛掉。
// 用法：node tests/vue-check.mjs
// 说明：.vue 模板与样式不在检查范围（那部分只能靠 HBuilder X 编译）。

import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TMP = join(process.cwd(), 'tests', '.tmp-page');
mkdirSync(TMP, { recursive: true });
// pages/ 与 components/ 递归收集，另外加上根目录的 App.vue
const DIRS = [join(process.cwd(), 'pages'), join(process.cwd(), 'components')];
const EXTRA = [join(process.cwd(), 'App.vue')];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.vue')) out.push(p);
  }
  return out;
}

let failed = 0;
let files = [];
for (const d of DIRS) if (statSync(d).isDirectory()) files = files.concat(walk(d));
files = files.concat(EXTRA.filter((p) => existsSync(p)));
if (!files.length) {
  console.log('没有 .vue 文件（当前目录对吗？应在项目根目录运行）');
  process.exit(1);
}

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const m = src.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) {
    console.log('SKIP 无 <script> 块: ' + f);
    continue;
  }
  const code = m[1].replace(/@\//g, '../../');
  const tmp = join(TMP, f.replace(process.cwd(), '').replace(/[\\/]/g, '_') + '.mjs');
  writeFileSync(tmp, code, 'utf8');
  try {
    await import(pathToFileURL(tmp).href);
    console.log('PASS ' + f.replace(process.cwd() + '\\', ''));
  } catch (e) {
    failed++;
    console.log('FAIL ' + f + '\n     ' + ((e && e.message) || e).split('\n')[0]);
  } finally {
    unlinkSync(tmp);
  }
}

console.log(failed ? '页面脚本自检: ' + failed + ' 个文件有问题' : '页面脚本自检: 全部通过 (' + files.length + ' 个)');
process.exit(failed ? 1 : 0);
