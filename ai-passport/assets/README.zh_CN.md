<p align="right">
  <strong>简体中文</strong> · <a href="README.md">English</a>
</p>

# 资源目录（Assets）

本目录集中存放可复用的资源（字库、图片、音乐等），按资源类型分子目录管理。每个资源放在其类型对应的子目录，并记录放置路径、命名方式、集成方式与来源/许可。二进制资源（字体、图片、音频）不属于纯 markdown 文档，请勿与文档混放。涉及版权/授权的资源需注明来源与许可。

## 字库（fonts）

可复用的字库文件与生成的字库源码放在 `fonts/`。

- 命名要能反映字族、字重、字级与格式。
- 记录来源、许可、字符范围、转换命令与目标放置路径。
- 添加字库前评估 Flash 与内部 RAM 影响；ESP32-C3 无 PSRAM。
- 不提交许可不允许分发的字库。

### “特斯拉钥匙”中文子集

| 文件 | 内容与体积 | 用途与来源 |
| --- | --- | --- |
| [`fonts/tesla_font_20.c`](fonts/tesla_font_20.c) | `tesla_font_20`，20 px、4 bpp，约 182 KiB 源码 | 钥匙主控页的车牌、钥匙名称与标题；由 Noto Sans SC 生成。 |
| [`fonts/tesla_font_14.c`](fonts/tesla_font_14.c) | `tesla_font_14`，14 px、4 bpp，约 125 KiB 源码 | 状态行、向导说明与管理条目等次要文字；同一来源。 |
| [`fonts/tesla_font_symbols.txt`](fonts/tesla_font_symbols.txt) | 字形清单（242 个，其中中文 147 个） | 生成时使用的字符集合快照，用于比较两次生成的差异。 |
| [`fonts/LICENSE-NotoSansSC.txt`](fonts/LICENSE-NotoSansSC.txt) | SIL OFL 1.1 正文 | 源字体的许可声明，随生成物一并保留。 |

- 源字体：Noto Sans SC（`(c) 2014-2021 Adobe <http://www.adobe.com/>`，Reserved Font Name `Source`），许可为 SIL Open Font License 1.1（<https://scripts.sil.org/OFL>）。OFL 允许嵌入与再分发，但衍生字体不得沿用保留名称，因此生成物命名为 `tesla_font_*`。
- 源 TTF 是变体字体（`wght` 100–900，默认值 100 为 Thin），不入库；转换脚本会先把字重固化到 400，否则 240 × 320 小屏上几乎看不清。
- 字符范围不写死：由 `tools/gen_tesla_font.py` 扫描 `main/tesla_*.[ch]` 里的字符串字面量得到，只包含界面真正会显示的字符；注释与 `ESP_LOGx()` 文案会被剔除（日志只进串口）。因此**改动这些文件的界面文字后必须重新生成字体**，否则缺字。
- 转换命令：`python tools/gen_tesla_font.py --font <path-to-NotoSansSC.ttf>`（需要 `lv_font_conv` 与 `fonttools`；脚本会用 fontTools 的 cmap 校验覆盖率，缺字直接失败）。
- 目标放置路径：`assets/fonts/tesla_font_20.c`、`assets/fonts/tesla_font_14.c`，由 `main/CMakeLists.txt` 的 `target_sources` 引入，`main/tesla_ui.c` 以 `LV_FONT_DECLARE()` 引用。界面图标全部用 LVGL 图元自绘，不依赖符号字体，故子集完全可控。
- 成本：两套字体的位图数据放在 Flash（`const` 数组），内部 RAM 只在 `lv_font_t` 结构本身占用少量；ESP32-C3 无 PSRAM，禁止在此之外的路径引入全字库 TTF。

## 图片（images）

可复用的源图与生成的显示资产放在 `images/`。

| 文件 | 尺寸与格式 | 用途与来源 |
| --- | --- | --- |
| [`images/home.jpg`](images/home.jpg) | 3840 × 2160，JPEG | 嵌入中英文项目 README 的产品主图，突出 AI Passport 产品形象与开放、人人可创作的理念。 |
| [`images/readme-hardware-specs.png`](images/readme-hardware-specs.png) | 2172 × 724，PNG RGBA | 保留为可选技术参考图，不再用于首页主视觉。于 2026-09-17 使用内置图像生成工具为本仓库生成；已根据文档中的硬件能力契约核对图中的六项标签与参数。 |
| [`images/logo-wordmark.png`](images/logo-wordmark.png) | 1648 × 336，PNG RGBA | 从仓库原始 `images/logo.png` 中精确裁切并去除背景的黑色字标；用于中英文项目 README 的浅色主题。 |
| [`images/logo-wordmark-dark.png`](images/logo-wordmark-dark.png) | 1648 × 336，PNG RGBA | 提取字标的白色版本；README 使用 `<picture>` 在 GitHub 深色主题下显示。 |

- 使用描述性命名，并记录尺寸、像素格式、转换步骤与目标路径。
- 优先采用适合 240 × 320 RGB565 显示的格式，并纳入 Flash 与内部 RAM 考量。
- 许可允许时保留可编辑源文件，并记录来源与许可。
- 图片中不得包含设备二维码秘密、凭证或个人数据。

## 音乐与音效（music）

可复用的音乐与音效源码放在 `music/`。

- 记录来源、许可、采样率、位深、声道、转换命令与目标路径。
- 与当前 BSP 音频路径匹配时优先采用 16 kHz、16 位单声道 PCM。
- 嵌入音频前评估 Flash 与内部 RAM 成本；长录音应流式或分块。
- 无再分发许可不提交媒体文件。
