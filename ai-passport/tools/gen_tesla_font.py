#!/usr/bin/env python3
"""为“特斯拉钥匙”界面生成 LVGL 中文子集字体。

用法:
    python3 tools/gen_tesla_font.py --font /path/to/NotoSansSC.ttf [--weight 400]

做法（对齐 docs/development/engineering/lvgl-chinese-fonts.zh_CN.md）:
  1. 只从 main/tesla_*.c / main/tesla_*.h 的**字符串字面量**里收集码点（注释与
     ESP_LOGx 文案不参与，否则会白白把整套文档/日志用字烧进固件）。
  2. 用 fontTools 核对源字体是否覆盖这些码点，缺字直接失败，避免真机上出现“豆腐块”。
  3. 调 lv_font_conv 生成 assets/fonts/tesla_font_20.c / tesla_font_14.c。
  4. 生成清单 assets/fonts/tesla_font_symbols.txt，便于 diff 与复核。

字形清单与界面文案同源：改了 tesla_ui.c / tesla_state.c / tesla_wizard.c 里的中文，
必须重跑本脚本，否则新字在设备上渲染不出来。
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = sorted((ROOT / "main").glob("tesla_*.[ch]"))
OUT_DIR = ROOT / "assets" / "fonts"

# 需要的字号与生成的变量名；与 tesla_ui.c 里的 LV_FONT_DECLARE 一一对应。
SIZES = {20: "tesla_font_20", 14: "tesla_font_14"}
BPP = "4"

# 界面固定要用到的 ASCII：车牌大写字母与数字、电量百分号、步骤“1/4”、冒号等。
ALWAYS_ASCII = set(range(0x20, 0x7F))

STRING_RE = re.compile(
    r'"(?:[^"\\\n]|\\.|\\\n)*"',
    re.MULTILINE,
)
# ESP_LOGx 的文案只进串口，不上屏，不该占字形。
LOG_CALL_RE = re.compile(r"\bESP_LOG[A-Z]+\s*\([^;]*;")


def strip_comments(text: str) -> str:
    """去掉 // 与 /* */ 注释，保留字符串字面量原样。"""
    out: list[str] = []
    i = 0
    n = len(text)
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
    return re.sub(r"\\([\\'\"ntrfa?v0x])", lambda m: {"n": "\n", "r": "\r", "t": "\t",
                                                      "0": "\0", "\\": "\\", "'": "'",
                                                      '"': '"'}.get(m.group(1), " "),
                  body)


def collect_codepoints() -> tuple[set[int], list[Path]]:
    cps: set[int] = set(ALWAYS_ASCII)
    used: list[Path] = []
    for path in SOURCES:
        text = LOG_CALL_RE.sub(";", strip_comments(path.read_text(encoding="utf-8")))
        literals = STRING_RE.findall(text)
        hit = False
        for literal in literals:
            for ch in unescape(literal):
                cp = ord(ch)
                if cp < 0x20:  # 换行等控制符不是字形
                    continue
                cps.add(cp)
                hit = True
        if hit:
            used.append(path)
    return cps, used


def resolve_source_font(font_path: Path, weight: int, work_dir: Path) -> Path:
    """变体字体（Variable Font）默认实例往往是 Thin，240x320 小屏上细到看不清。

    所以先按 --weight 把 wght 轴固化为静态字体再交给 lv_font_conv。
    """
    from fontTools.ttLib import TTFont

    font = TTFont(font_path, fontNumber=0, lazy=False)
    fvar = font.get("fvar")
    axis = next((a for a in (fvar.axes if fvar else []) if a.axisTag == "wght"), None)
    if axis is None:
        font.close()
        return font_path
    if int(round(axis.defaultValue)) == weight:
        font.close()
        return font_path

    from fontTools.varLib.instancer import instantiateVariableFont

    pinned = max(axis.minValue, min(axis.maxValue, float(weight)))
    print(f"源字体是变体字体（wght {axis.minValue:.0f}-{axis.maxValue:.0f}，"
          f"默认 {axis.defaultValue:.0f}），固化为 {pinned:.0f} 再转换")
    instantiateVariableFont(font, {"wght": pinned}, inplace=True)
    work_dir.mkdir(parents=True, exist_ok=True)
    out = work_dir / f"{font_path.stem}-{int(pinned)}.ttf"
    font.save(out)
    font.close()
    return out


def check_coverage(cps: set[int], font_path: Path) -> list[int]:
    from fontTools.ttLib import TTFont  # 只在需要时导入，便于给出清晰报错

    font = TTFont(font_path, fontNumber=0, lazy=True)
    cmap = font.getBestCmap()
    font.close()
    return sorted(cp for cp in cps if cp not in cmap)


def lv_font_conv_cmd() -> list[str]:
    """返回可安全传中文参数的调用前缀。

    Windows 上 npm 生成的是 .CMD 包装脚本，经 cmd.exe 传参会把“>”“&”等字符
    当命令解析，所以优先用 node 直接跑包里的 lv_font_conv.js。
    """
    node = shutil.which("node")
    if node:
        for candidate in (
            Path(sys.executable).parent / "node_modules" / "lv_font_conv" / "lv_font_conv.js",
            Path(sys.executable).parent / ".." / "node_modules" / "lv_font_conv" / "lv_font_conv.js",
        ):
            if candidate.is_file():
                return [node, str(candidate.resolve())]
        # npm 全局根目录（npm root -g）；Windows 上 npm 是 .CMD，必须经 shell 调用
        try:
            probe = subprocess.run("npm root -g", shell=True, capture_output=True,
                                   text=True, check=True)
        except (OSError, subprocess.CalledProcessError):
            probe = None
        if probe is not None and probe.stdout.strip():
            candidate = Path(probe.stdout.strip()) / "lv_font_conv" / "lv_font_conv.js"
            if candidate.is_file():
                return [node, str(candidate)]
    tool = shutil.which("lv_font_conv") or shutil.which("lv_font_conv.cmd")
    if tool is None:
        raise SystemExit(
            "找不到 lv_font_conv。请先安装固定版本："
            " npm install -g lv_font_conv@1.5.3"
        )
    return [tool]


def run_lv_font_conv(font_path: Path, symbols: str, size: int, name: str, out: Path) -> None:
    cmd = lv_font_conv_cmd() + [
        "--font", str(font_path),
        "--size", str(size),
        "--bpp", BPP,
        "--symbols", symbols,
        "--format", "lvgl",
        "--lv-font-name", name,
        # 默认生成的是 `#include "lvgl/lvgl.h"`，ESP-IDF 的托管组件目录是
        # managed_components/lvgl__lvgl，这个相对路径不存在；本仓库统一用 "lvgl.h"。
        "--lv-include", "lvgl.h",
        "--output", str(out),
    ]
    print("$ " + " ".join(cmd[:1]) + f" --size {size} --symbols <{len(set(symbols))} glyphs>")
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.stdout.strip():
        print(result.stdout.strip())
    if result.returncode != 0:
        raise SystemExit(f"lv_font_conv 生成 {name} 失败:\n{result.stderr}")


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 tesla_ui 的 LVGL 中文子集字体")
    parser.add_argument("--font", required=True, help="源 TTF/OTF 路径（需含所需字形）")
    parser.add_argument("--weight", type=int, default=400,
                        help="源字体为变体字体时固化的 wght 值（默认 400 Regular）")
    parser.add_argument("--work-dir", default=str(ROOT / "build" / "fontsrc"),
                        help="固化变体字体后的中间产物目录（默认 build/fontsrc，已被忽略）")
    args = parser.parse_args()

    font_path = Path(args.font).resolve()
    if not font_path.is_file():
        raise SystemExit(f"源字体不存在: {font_path}")
    if not SOURCES:
        raise SystemExit("找不到 main/tesla_*.c，无法确定字形清单")

    font_path = resolve_source_font(font_path, args.weight, Path(args.work_dir).resolve())

    cps, used = collect_codepoints()
    print("扫描字面量的源文件:")
    for path in used:
        print(f"  - main/{path.name}")
    missing = check_coverage(cps, font_path)
    if missing:
        for cp in missing[:20]:
            print(f"ERROR: U+{cp:04X} {chr(cp)!r} 不在源字体里", file=sys.stderr)
        raise SystemExit(f"源字体缺少 {len(missing)} 个字形，请换字体或调整文案")

    # 按码点排序，输出稳定，方便 review diff。
    symbols = "".join(chr(cp) for cp in sorted(cps))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "tesla_font_symbols.txt").write_text(symbols + "\n", encoding="utf-8")
    print(f"共 {len(cps)} 个字形（中文 {sum(1 for c in cps if c > 0x2E80)} 个）")

    for size, name in SIZES.items():
        out = OUT_DIR / f"{name}.c"
        run_lv_font_conv(font_path, symbols, size, name, out)
        # 生成物默认带 lv_font_conv 的时间戳注释，这里只确认可用的声明名。
        text = out.read_text(encoding="utf-8", errors="replace")
        if f"const lv_font_t {name} = {{" not in text:
            raise SystemExit(f"{out.name} 里找不到 lv_font_t {name}，生成结果不可用")
        print(f"  -> {out.relative_to(ROOT)}  {out.stat().st_size // 1024} KiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
