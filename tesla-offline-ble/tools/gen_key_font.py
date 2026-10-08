#!/usr/bin/env python3
"""为车钥匙界面（application/main/key_ui.c）生成 LVGL 中文子集字体。

用法（本机 Windows）:
    python tools/gen_key_font.py

做法对齐 ai-passport/tools/gen_tesla_font.py，但产物落在本工程：
  1. 只从 key_ui.c 的字符串字面量收集码点（ESP_LOGx 只进串口，不上屏，剔除）。
  2. 调 lv_font_conv@1.5.3（npm 全局）用系统黑体 simhei.ttf 生成
     assets/fonts/key_font_20.c / key_font_14.c（变量名 key_font_20 / key_font_14）。
  3. 写清单 assets/fonts/key_font_symbols.txt。
改了 key_ui.c 的中文文案必须重跑本脚本，否则真机出“豆腐块”。
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# 扫描范围：界面源码 + 全部可能上屏的日志文案来源（屏幕诊断"日志页"要渲染
# 固件任意 ESP_LOG 中文文本，缺字就变豆腐块）。ESP_LOGx 剔除逻辑仍保留在
# key_ui.c 上（它的日志不上屏），但 tlb/bsp 的日志会上屏，所以那些目录全量扫。
SRC_DIRS = [
    ROOT / "application" / "main",
    ROOT / "components" / "tesla_ble",
    ROOT / "components" / "tesla_core",
    ROOT.parent / "ai-passport" / "components" / "bsp",
]
SRC = ROOT / "application" / "main" / "key_ui.c"
OUT_DIR = ROOT / "assets" / "fonts"
FONT_TTF = Path(r"C:\Windows\Fonts\simhei.ttf")
NODE = Path(r"C:\nvm4w\nodejs\node.exe")
LFC = Path(r"C:\nvm4w\nodejs\node_modules\lv_font_conv\lv_font_conv.js")

SIZES = {20: "key_font_20", 14: "key_font_14"}
BPP = "4"
ALWAYS_ASCII = set(range(0x20, 0x7F))

STRING_RE = re.compile(r'"(?:[^"\\\n]|\\.)*"', re.MULTILINE)
LOG_CALL_RE = re.compile(r"\bESP_LOG[A-Z]+\s*\([^;]*;")


def strip_comments(text: str) -> str:
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == '"':
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == '"':
                    j += 1
                    break
                j += 1
            out.append(text[i:j])
            i = j
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def unescape(literal: str) -> str:
    body = literal[1:-1]
    return re.sub(
        r"\\([\\'\"ntrfa?v0x])",
        lambda m: {"n": "\n", "r": "\r", "t": "\t", "0": "\0", "\\": "\\",
                   "'": "'", '"': '"'}.get(m.group(1), " "),
        body,
    )


def collect_text(all_dirs: bool) -> str:
    """all_dirs=False：只扫 key_ui.c 并剔除 ESP_LOGx（界面 20px 字库，保持精简）。
    all_dirs=True：全目录扫描且保留 ESP_LOGx（14px 日志页字库，渲染任意固件日志）。"""
    parts: list[str] = []
    files: list[Path] = []
    if all_dirs:
        for d in SRC_DIRS:
            if not d.is_dir():
                print(f"  跳过（不存在）: {d}")
                continue
            files.extend(sorted(d.rglob("*.c")))
    else:
        files = [SRC]
    for f in files:
        body = strip_comments(f.read_text(encoding="utf-8", errors="replace"))
        if not all_dirs or f == SRC:
            body = LOG_CALL_RE.sub(";", body)
        parts.append(body)
    return "\n".join(parts)


def cps_from(text: str) -> set[int]:
    cps = set(ALWAYS_ASCII)
    for literal in STRING_RE.findall(text):
        for ch in unescape(literal):
            if ord(ch) >= 0x20:
                cps.add(ord(ch))
    return cps


def main() -> int:
    if not FONT_TTF.is_file():
        raise SystemExit(f"源字体不存在: {FONT_TTF}")
    if not LFC.is_file():
        raise SystemExit("找不到 lv_font_conv，请先: npm install -g lv_font_conv@1.5.3")

    cps_ui = cps_from(collect_text(all_dirs=False))
    cps_all = cps_from(collect_text(all_dirs=True)) | cps_ui
    symbols_ui = "".join(chr(cp) for cp in sorted(cps_ui))
    symbols_all = "".join(chr(cp) for cp in sorted(cps_all))
    print(f"界面字库 {len(cps_ui)} 字形（中文 {sum(1 for c in cps_ui if c > 0x2E80)}）；"
          f"日志字库 {len(cps_all)} 字形（中文 {sum(1 for c in cps_all if c > 0x2E80)}）")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "key_font_symbols.txt").write_text(symbols_all + "\n", encoding="utf-8")

    for size, name in SIZES.items():
        symbols = symbols_ui if size == 20 else symbols_all
        out = OUT_DIR / f"{name}.c"
        # --no-compress：本工程未启用 LV_USE_FONT_COMPRESSED，压缩字体会导致
        # 字形位图解码失败、文字完全不显示（真机已踩坑，见上下文卡 §7.7）。
        cmd = [str(NODE), str(LFC), "--font", str(FONT_TTF), "--size", str(size),
               "--bpp", BPP, "--symbols", symbols, "--format", "lvgl", "--no-compress",
               "--lv-font-name", name, "--lv-include", "lvgl.h", "--output", str(out)]
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace")
        if r.stdout.strip():
            print(r.stdout.strip())
        if r.returncode != 0:
            raise SystemExit(f"lv_font_conv 生成 {name} 失败:\n{r.stderr}")
        body = out.read_text(encoding="utf-8", errors="replace")
        if f"const lv_font_t {name} = {{" not in body:
            raise SystemExit(f"{out.name} 里找不到 lv_font_t {name}")
        if "not found" in (r.stdout + r.stderr).lower():
            raise SystemExit("lv_font_conv 报告缺字形，请检查上面输出")
        print(f"  -> {out.relative_to(ROOT)}  {out.stat().st_size // 1024} KiB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
