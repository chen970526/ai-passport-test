#!/usr/bin/env python3
"""把 UI 资源包里的 8 个 48×48 RGBA 白色线稿 PNG 转成 LVGL 9 的 C 图像数组。

用法（本机 Windows，需 Pillow）:
    python tools/gen_key_icons.py

管线（对齐 UI_SPEC.md「图标」节 + 无 PSRAM 约束）:
  - 白色线稿的 RGB 恒为白，形状信息全在 alpha 通道 → 只取 alpha 存成
    LV_COLOR_FORMAT_L8 遮罩（48×48×1B = 2.3KB/张，8 张约 18KB，进 .rodata）。
  - 显示端用 lv_image + style image_recolor 染任意色（默认染白），
    缩放用 style transform_scale（本工程 LVGL 9.6 已无 lv_image_set_zoom，
    256 = 100%）。
  - 产物 application/main/key_icons.c / key_icons.h，key_ui.c 直接引用。
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    raise SystemExit("缺少 Pillow，先执行: python -m pip install pillow")

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT.parent / "tesla_ai_passport_ui_assets" / "icons"
OUT_DIR = ROOT / "application" / "main"

ICONS = ["lock", "unlock", "frunk", "trunk", "bluetooth", "battery", "check"]
W = H = 48

# car.png 是用户提供的 219×375 竖版正前视角全彩渲染图（透明背景），
# 不是白色线稿：不走 L8 遮罩管线，LANCZOS 缩到 88×150（保持原图 0.584
# 宽高比，屏幕中央列显示的原生尺寸；换图/换尺寸改这里重跑脚本）后输出
# RGB565A8（像素面+alpha 面，88*150*3≈39KB 进 .rodata），显示端呈真实颜色。
CAR_W, CAR_H = 88, 150

def alpha_mask(png: Path) -> list[int]:
    im = Image.open(png)
    if im.size != (W, H):
        raise SystemExit(f"{png.name} 尺寸 {im.size}，期望 {(W, H)}")
    if im.mode != "RGBA":
        im = im.convert("RGBA")
    return list(im.getchannel("A").tobytes())

def fmt_array(name: str, px: list[int]) -> str:
    lines = []
    for y in range(H):
        row = px[y * W:(y + 1) * W]
        body = ",".join(f"0x{v:02X}" for v in row)
        lines.append(f"    {body},")
    return (
        f"static const uint8_t {name}_map[48 * 48] = {{\n"
        + "\n".join(lines).rstrip(",")
        + "\n};\n"
    )

def fmt_bytes(name: str, data: bytes, per_line: int = 32) -> str:
    lines = []
    for i in range(0, len(data), per_line):
        body = ",".join(f"0x{v:02X}" for v in data[i:i + per_line])
        lines.append(f"    {body},")
    return (
        f"static const uint8_t {name}[{len(data)}] = {{\n"
        + "\n".join(lines).rstrip(",")
        + "\n};\n"
    )

def car_rgb565a8(png: Path) -> tuple[bytes, bytes]:
    im = Image.open(png).convert("RGBA").resize((CAR_W, CAR_H), Image.LANCZOS)
    px = im.tobytes()
    rgb = bytearray()
    alp = bytearray(CAR_W * CAR_H)
    for i in range(0, len(px), 4):
        r, g, b, a = px[i:i + 4]
        v = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
        rgb += bytes((v & 0xFF, v >> 8))
        alp[i // 4] = a
    return bytes(rgb), bytes(alp)

def main() -> int:
    for f in ICONS + ["car"]:
        p = SRC_DIR / f"{f}.png"
        if not p.is_file():
            raise SystemExit(f"缺少源图标: {p}")

    c_parts, h_parts = [], []
    for f in ICONS:
        px = alpha_mask(SRC_DIR / f"{f}.png")
        sym = f"key_icon_{f}"
        c_parts.append(fmt_array(sym, px))
        c_parts.append(
            f"const lv_image_dsc_t {sym} = {{\n"
            f"    .header = {{\n"
            f"        .magic = LV_IMAGE_HEADER_MAGIC,\n"
            f"        .cf = LV_COLOR_FORMAT_L8,\n"
            f"        .flags = 0,\n"
            f"        .w = {W},\n"
            f"        .h = {H},\n"
            f"        .stride = {W},\n"
            f"        .reserved_2 = 0,\n"
            f"    }},\n"
            f"    .data_size = sizeof({sym}_map),\n"
            f"    .data = {sym}_map,\n"
            f"    .reserved = NULL,\n"
            f"}};\n"
        )
        h_parts.append(f"extern const lv_image_dsc_t {sym};")

    # —— car：全彩 RGB565A8（像素面 + alpha 面拼接）——
    rgb, alp = car_rgb565a8(SRC_DIR / "car.png")
    c_parts.append(fmt_bytes("key_icon_car_map", rgb + alp))
    c_parts.append(
        f"const lv_image_dsc_t key_icon_car = {{\n"
        f"    .header = {{\n"
        f"        .magic = LV_IMAGE_HEADER_MAGIC,\n"
        f"        .cf = LV_COLOR_FORMAT_RGB565A8,\n"
        f"        .flags = 0,\n"
        f"        .w = {CAR_W},\n"
        f"        .h = {CAR_H},\n"
        f"        .stride = {CAR_W * 2},\n"
        f"        .reserved_2 = 0,\n"
        f"    }},\n"
        f"    .data_size = sizeof(key_icon_car_map),\n"
        f"    .data = key_icon_car_map,\n"
        f"    .reserved = NULL,\n"
        f"}};\n"
    )
    h_parts.append("extern const lv_image_dsc_t key_icon_car;")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    c_path = OUT_DIR / "key_icons.c"
    h_path = OUT_DIR / "key_icons.h"
    c_path.write_text(
        "// 自动生成，勿手改 —— 源: tesla_ai_passport_ui_assets/icons/*.png，脚本: tools/gen_key_icons.py\n"
        "// 格式: 48×48 L8 alpha 遮罩（白色线稿只取 alpha 通道），显示时 style image_recolor 染色。\n"
        '#include "key_icons.h"\n\n'
        + "\n".join(c_parts),
        encoding="utf-8",
    )
    h_path.write_text(
        "// 自动生成，勿手改 —— 脚本: tools/gen_key_icons.py\n"
        "// 8 个 Tesla UI 图标（48×48 L8 alpha 遮罩）。用法见 key_ui.c：\n"
        "// lv_image_set_src(img, &key_icon_xxx) + lv_obj_set_style_image_recolor(...) 染白。\n"
        "#pragma once\n\n"
        '#include "lvgl.h"\n\n'
        + "\n".join(h_parts) + "\n",
        encoding="utf-8",
    )
    total = W * H * len(ICONS) + len(rgb) + len(alp)
    print(f"生成 {c_path.relative_to(ROOT)} / {h_path.relative_to(ROOT)}")
    print(f"线稿 {len(ICONS)} 张 × {W}×{H}px L8 + car {CAR_W}×{CAR_H}px RGB565A8"
          f" = {total} B 像素数据（约 {total // 1024} KB）")
    print(f"C 文件体积: {c_path.stat().st_size // 1024} KB（十六进制文本，编译后回落到二进制）")
    return 0

if __name__ == "__main__":
    sys.exit(main())
