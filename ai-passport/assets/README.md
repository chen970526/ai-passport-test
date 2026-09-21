<p align="right">
  <a href="README.zh_CN.md">简体中文</a> · <strong>English</strong>
</p>

# Assets

This directory stores reusable fonts, images, music, and sound effects, organized by asset type.

Keep each asset in the matching subdirectory and document its destination, naming, integration method, and source/license. Do not mix binary assets with Markdown documentation.

## Fonts

Store reusable font files and generated font sources in `fonts/`.

- Use descriptive names that include the family, weight, size, and format when relevant.
- Document the source, license, character range, conversion command, and expected destination.
- Check Flash and internal-RAM impact before adding a font; the ESP32-C3 has no PSRAM.
- Do not commit fonts whose license does not permit redistribution.

### Tesla key Chinese subset

| File | Content and size | Use and source |
| --- | --- | --- |
| [`fonts/tesla_font_20.c`](fonts/tesla_font_20.c) | `tesla_font_20`, 20 px, 4 bpp, about 182 KiB of source | License-plate text, key labels and page titles on the fob screen; generated from Noto Sans SC. |
| [`fonts/tesla_font_14.c`](fonts/tesla_font_14.c) | `tesla_font_14`, 14 px, 4 bpp, about 125 KiB of source | Status line, wizard hints and management rows; same source. |
| [`fonts/tesla_font_symbols.txt`](fonts/tesla_font_symbols.txt) | Glyph inventory (242 glyphs, 147 of them Han ideographs) | Snapshot of the character set used at generation time, so two runs can be diffed. |
| [`fonts/LICENSE-NotoSansSC.txt`](fonts/LICENSE-NotoSansSC.txt) | SIL OFL 1.1 text | License and copyright notice of the upstream font, kept next to the generated output. |

- Source font: Noto Sans SC (`(c) 2014-2021 Adobe <http://www.adobe.com/>`, Reserved Font Name `Source`), licensed under the SIL Open Font License 1.1 (<https://scripts.sil.org/OFL>). The OFL permits embedding and redistribution, but a derivative must not keep the reserved name, hence the `tesla_font_*` naming.
- The upstream TTF is a variable font (`wght` 100-900, default 100 = Thin) and is not committed. The converter pins the weight to 400 first, because Thin is unreadable on a 240 x 320 panel.
- The character range is derived, not hand-written: `tools/gen_tesla_font.py` scans the string literals in `main/tesla_*.[ch]` and keeps only the glyphs the UI can actually render. Comments and `ESP_LOGx()` messages are stripped, since logs never reach the screen. **Regenerate the fonts whenever the on-screen wording in those files changes**, otherwise glyphs go missing.
- Conversion command: `python tools/gen_tesla_font.py --font <path-to-NotoSansSC.ttf>` (requires `lv_font_conv` and `fonttools`; the script verifies cmap coverage with fontTools and fails on any missing glyph).
- Destination: `assets/fonts/tesla_font_20.c` and `assets/fonts/tesla_font_14.c`, added to the target by `target_sources` in `main/CMakeLists.txt` and referenced from `main/tesla_ui.c` through `LV_FONT_DECLARE()`. Every icon on these screens is drawn with LVGL primitives instead of a symbol font, so the subset stays closed.
- Cost: the bitmap tables live in Flash as `const` arrays and only the `lv_font_t` descriptors touch internal RAM. The ESP32-C3 has no PSRAM, so no full TTF may be embedded through any other path.

## Images

Store reusable source images and generated display assets in `images/`.

| File | Dimensions and format | Use and source |
| --- | --- | --- |
| [`images/home.jpg`](images/home.jpg) | 3840 × 2160, JPEG | Product hero image embedded in both project README files to foreground AI Passport and its open, maker-oriented identity. |
| [`images/readme-hardware-specs.png`](images/readme-hardware-specs.png) | 2172 × 724, PNG RGBA | Optional technical infographic retained as a reference asset; it is no longer used as the homepage hero. Generated for this repository with the built-in image generation tool on 2026-09-17; the six labels and values were checked against the documented hardware contract. |
| [`images/logo-wordmark.png`](images/logo-wordmark.png) | 1648 × 336, PNG RGBA | Transparent black wordmark extracted from the repository's original `images/logo.png`; embedded in both project README files for light backgrounds. |
| [`images/logo-wordmark-dark.png`](images/logo-wordmark-dark.png) | 1648 × 336, PNG RGBA | White version of the extracted wordmark, used by the README `<picture>` element when GitHub is in dark mode. |

- Use descriptive names and document dimensions, pixel format, conversion steps, and destination.
- Prefer formats suitable for the 240 × 320 RGB565 display and account for Flash and internal RAM.
- Preserve editable sources where licensing permits, and record the source and license.
- Never commit device QR secrets, credentials, or personal data in images.

## Music and sound effects

Store reusable music and sound-effect sources in `music/`.

- Document the source, license, sample rate, bit depth, channels, conversion command, and destination.
- Prefer 16 kHz, 16-bit mono PCM when it matches the current BSP audio path.
- Check Flash and internal-RAM cost before embedding audio; stream or chunk long recordings.
- Do not commit media without redistribution permission.
