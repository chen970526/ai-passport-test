# FoloToy AI Passport —— 特斯拉离线钥匙：项目上下文卡

> **用法**：新开对话时，把本文件整体贴给 AI 作为首条消息的上下文，再说一句需求即可。
> AI 读完本文件应当不需要重新通读 `AGENTS.md` / `docs/README.md` / 全部源码就能定位到该改哪里。
> 本文件位于仓库之外（`f:\Desktop\test\`），刻意不进仓库：仓库要求每个 `.md` 都要有配对的 `.zh_CN.md`
> （`AGENTS.md` 第 47 行），放进仓库会导致 `tools/check_repo.py` 门禁失败并翻倍文档体积。

---

## 0. 一句话现状（每次改动后必须更新本节）

| 项 | 当前值 |
| --- | --- |
| 仓库 | `https://gitee.com/FoloToy/ai-passport`，本地 `F:\Desktop\test\ai-passport` |
| 分支 | `feature/tesla-key`（基线 `dcaeae1`） |
| 最新提交 | `60461f1 feat(main): add offline Tesla key app` |
| 构建 | PASS，0 error / 0 warning；app 687,520 B / factory 8,323,072 B（占用 8%） |
| 交付固件 | `build/FoloToy-AI-Passport-full.bin`，753,056 B，**0x0 起整片可刷** |
| full.bin SHA256 | `8329a3a0425bb1045693608149ff2e58b75afba6f7d04d0bd1ac99967a92c3f0` |
| 归档 | `build/firmware/8329a3a0…c3f0/`，`archive_firmware.py verify` = PASS |
| 主机测试 | PASS（MSVC `/W4 /WX` 等价执行，见 §7 环境限制） |
| 真机测试 | **NOT RUN**（设备未到货，无串口区） |
| 未提交改动 | 无 |
| 旁支探针 | `f:\Desktop\test\tesla-ble-probe\`（uni-app 纯 JS 协议栈，Node 自测 98 passed / 0 failed，**未上真机**）见 §10 |

---

## 1. 硬件与运行时约束（不可协商）

| 主题 | 事实 | 依据 |
| --- | --- | --- |
| SoC | ESP32-C3（riscv32），**无 PSRAM**、仅 BLE（无经典蓝牙） | `AGENTS.md` L31 |
| Flash | 8 MB，`dio / 80m` | `sdkconfig.defaults` L7 |
| 分区 | `nvs@0x9000/0x6000`、`phy_init@0xf000/0x1000`、`factory@0x10000/0x7f0000` | `partitions.csv` |
| 面板 | ST7789P3 **240×320**，四角圆角 `BSP_LVGL_SCREEN_RADIUS = 30` → 文字禁止贴四角，安全边距 6px | `bsp_pins.h` / `tesla_layout.h` |
| 按键 | **三键共用在 GPIO0 的 ADC 分压**：UP / DOWN / OK，事件 PRESS / CLICK / DOUBLE / LONG | `bsp_button.h` |
| LVGL | 9.5.0 + `esp_lvgl_port` 2.9.0 + `espressif/button` 4.2.0 + `esp_codec_dev` 1.6.2 | `components/bsp/idf_component.yml` |
| 内存 | `CONFIG_LV_MEM_SIZE_KILOBYTES=24`（LVGL 独立静态池，不与系统堆共享）；LCD DMA 单缓冲 240×20 | `sdkconfig.defaults` L26 |
| 控制台 | USB-Serial-JTAG（GPIO18/19）。**不能用 UART0**：默认 TX=GPIO21 与背光冲突 | `sdkconfig.defaults` L15-18 |
| 线程 | LVGL 非线程安全：非 LVGL 任务访问对象必须 `bsp_lvgl_lock()`；按键回调只入队，慢操作进 worker task | `AGENTS.md` L41-43 |
| 中文 | 默认 Montserrat **没有中文字形**；UTF-8 编译通过 ≠ 能显示 | `AGENTS.md` L42 |
| UI 复用 | 二次开发**必须自研界面**，禁止复用基线 demo 菜单/外壳（改名换色不算重新设计） | `AGENTS.md` L40 |
| BSP 复用 | 可复用的板级逻辑放 `components/bsp`；页面、状态机、动画、应用任务放 `main` | `AGENTS.md` L39 |
| 硬件事实优先级 | 产品规格/实测 → `bsp_pins.h` → BSP 头与实现 → 硬件指南 → README/demo | `AGENTS.md` L38 |

---

## 2. 本地环境（Windows / PowerShell）

固定路径：

| 用途 | 路径 |
| --- | --- |
| ESP-IDF v5.5.3 | `F:\esp\esp-idf-v5.5.3` |
| IDF 工具链根 | `F:\esp\tools` |
| Python | 3.13.5（`C:\Users\Administrator\AppData\Local\Programs\Python\Python313\python.exe`） |
| Node | `C:\nvm4w\nodejs\node.exe`，全局 `lv_font_conv`（`npm root -g` → `C:\nvm4w\nodejs\node_modules`） |
| fontTools | 4.60.1 |
| MSVC（主机测试用） | `C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\Tools\Launch-VsDevShell.ps1` |
| 中文字体源件 | `F:\Desktop\test\NotoSansSC.ttf`（SIL OFL 1.1；TTF 不入仓库，只入生成物 + 许可） |
| 已安装 Skill | `C:\Users\Administrator\.trae-cn\skills\passport-*`（5 个） |

**必须先设 `IDF_TOOLS_PATH` 再 export**，否则 export 会去找 `C:\Users\Administrator\.espressif\...` 报错；每个终端环境独立，**export 和 `idf.py` 必须写在同一条命令里**：

```powershell
$env:IDF_TOOLS_PATH="F:\esp\tools"
& "F:\esp\esp-idf-v5.5.3\export.ps1" > $null
idf.py -C F:\Desktop\test\ai-passport build
```

 merge-bin 的输出**必须给绝对路径**（esptool 的工作目录已经是 `build/`，相对路径会被二次拼接而 `FileNotFoundError`）：

```powershell
idf.py merge-bin -o F:\Desktop\test\ai-passport\build\FoloToy-AI-Passport-full.bin
```

其它坑：本工具禁止 `cmd /c`（MSVC 用 `Launch-VsDevShell.ps1 -Arch amd64 -SkipAutomaticLocation | Out-Null`）；`bash tools/validate.sh` 不可用（见 §7）。

---

## 3. 仓库强制流程（AI 必做项）

1. **五个必需 Skill**：`passport-develop` / `passport-setup` / `passport-build` / `passport-device-test` / `passport-debug`，源在 `skills/`。开工前 AI 必须自行检查已安装、缺失就自行选方式安装并**验证可用**，不得声称未成功为成功。
   - 仓库自带 `tools/install_passport_skills.py` 用**目录符号链接**安装（→ `<repo>/.agents/skills/`）；Windows 非管理员会 `WinError 1314` 建不出来 → 本机改为**整目录复制**到 `C:\Users\Administrator\.trae-cn\skills\<name>\`（每个含 `SKILL.md` + `SKILL.zh_CN.md`）。
2. **保留用户已有改动**：起手 `git status --short --branch`，绝不 clean/覆盖无关文件；应用开发从 `main` 新建 `feature/*` 分支。
3. **验证与交付**：迭代跑最小检查，交付前跑完整门禁 `./tools/validate.sh --static` / `--firmware` / 全量。构建成功 ≠ 硬件验证。
4. **交付必须分四段报告**：`Build / Host tests / Device tests / Unverified`（PASS/FAIL/NOT RUN）。
5. **交付 0x0 可刷的合并固件**，并按 `passport-build` 生成内容寻址归档 + `archive_firmware.py verify`。
6. **每次完整实现固件改动后，主动询问是否上机刷机测试**；检测到手设备 ≠ 授权，**未经确认绝不烧录**。整片刷写可能重置设备已有 NVS/配对数据，需说明。
7. **提交/推送只在用户要求时做**；commit 用英文祈使句 + Conventional Commit（`type(scope): description`，≤72 字符、结尾不加句号）；普通功能/文档提交**禁止改 `docs/CHANGELOG*.md`**；不得提交固件、凭证、二维码 `s`/`k` 密钥、未脱敏日志。
8. 文档双语：仓库内 `.md`（英文，默认路径）+ 配对 `.zh_CN.md`；本上下文卡例外地放在仓库外。

关键文档路由（按需再读，不必通读）：

| 任务 | 先读 |
| --- | --- |
| 任何代码改动 | `docs/development/ai-guide.zh_CN.md` |
| BSP/引脚/屏/音频/电池 | `docs/hardware-design/AI_HARDWARE_DEVELOPMENT_GUIDE.zh_CN.md`、`components/bsp/include/bsp_pins.h` |
| 中文字体 | `docs/development/engineering/lvgl-chinese-fonts.zh_CN.md` |
| 构建/分区 | `docs/development/engineering/build-and-test.zh_CN.md`、`firmware-layout.zh_CN.md` |
| 提交/PR | `docs/contribution/commit-and-pr.zh_CN.md` |
| 编码规范（含字体清单） | `docs/development/engineering/coding-conventions.zh_CN.md` |

---

## 4. 应用架构（分层与可测性）

```
main.c ── 启动/并发骨架（esp_timer 回调 → 队列 → tesla_input 任务 → tesla_ui_key）
  ├─ tesla_ui.c      LVGL 页面 + 按键翻译（唯一持有 LVGL 的对象；不含业务判断）
  ├─ tesla_layout.h  纯整数几何（所有矩形；主机可测）
  ├─ tesla_state.c/h 车控规则 + 车牌编辑 + 编解码（无 IDF/LVGL 依赖）
  ├─ tesla_wizard.c/h 绑定向导规则（无 IDF/LVGL 依赖）
  └─ tesla_store.c/h NVS I/O（唯一接触 nvs_flash；规则不在此）
```

原则：状态迁移、校验、计时、布局全部与 ESP-IDF/LVGL 解耦并有主机测试；I/O 层只搬运数据、不复制判断。

---

## 5. 功能清单（逐条，当前已实现）

### 5.1 启动与骨架（`main/main.c`）

1. 上电打印 `特斯拉钥匙启动`；若为休眠唤醒，额外打印唤醒原因（`esp_sleep_get_wakeup_cause`）。
2. `bsp_i2c_init()` + `bsp_i2c_scan()`。
3. `bsp_display_init()` + `bsp_lvgl_init()` 任一失败 → 打印含 SPI 引脚号（MOSI/SCLK/CS/DC/BL）的错误并**停止**（无界面不继续）。
4. 背光 `bsp_display_backlight(100)`。
5. `bsp_battery_init()` 失败**只告警**，右上角电量降级为 `--`，不阻塞启动。
6. `tesla_ui_prepare()` 读 NVS 档案；失败也继续，界面以「未绑定」进向导。
7. 建输入通道：深度 8 的队列 + `tesla_input` 任务（栈 4096、优先级 5）；随后 `bsp_button_init(on_key)`。任一失败则回收任务/队列并打日志。
8. 按键回调 `on_key` 运行在 esp_timer 共享任务上，**仅 `xQueueSend(...,0)`**，绝不阻塞。
9. 取 `bsp_lvgl_lock(1000)` 后 `tesla_ui_enter()`，解锁；就绪日志打印 `页面/已绑定/输入可用`。
10. 输入就绪标志 `s_input_ready` 只在按键初始化成功后置位，避免无界面时吞按键。

### 5.2 车控状态机（`tesla_state.c/h`，主机测试 10 组）

11. 车型枚举 5 项且**顺序被持久化**，禁止中间插入：`MODEL 3 / MODEL Y / MODEL S / MODEL X / CYBERTRUCK`（`tesla_model_ascii()` 给 ASCII 名）。
12. 锁状态 `LOCKED / UNLOCKED`；盖状态 `CLOSED / MOVING / OPEN`（`MOVING` 供动画与「忙」判定）。
13. 四条指令：`LOCK / UNLOCK / FRUNK / TRUNK`；任务态 `IDLE / SENDING / ACCEPTED`。
14. **拒绝规则**（`tesla_state_dispatch()` 返回 false，并把原因写入 `deny`，绝不覆盖正在处理中的任务）：
    - 未绑定 → `TESLA_DENY_NOT_BOUND`
    - 忙（`SENDING` 或任一盖 `MOVING`）→ `TESLA_DENY_BUSY`
    - 未解锁时开前/后备箱 → `TESLA_DENY_LOCKED`
15. **时序常量**：`TESLA_ACK_MS=900`（下发→回执）、`TESLA_PORT_MOVE_MS=700`（MOVING 动画）、`TESLA_DENY_MS=1500`（提示自动消失）。
16. `tesla_state_step()` 到时迁移（`uint32` 差值比较，**对 tick 回绕安全**）：
    - `LOCK`：置 `LOCKED`，并把当前 `OPEN` 的盖改为 `MOVING`（方向标记为「关」）。
    - `UNLOCK`：置 `UNLOCKED`。
    - `FRUNK/TRUNK`：已 `OPEN` → 立刻 `CLOSED`；否则进入 `MOVING`（方向「开」）。
    - `MOVING` 到时后按 `moving_closing` 位掩码（`TESLA_CLOSING_FRUNK/TRUNK`）落到 `OPEN` 或 `CLOSED`。
    - 到时的 `deny` 自动清除。返回「是否有变化」供界面决定是否重画。
17. `tesla_state_ack_done()`：UI 展示回执后把 `ACCEPTED → IDLE` 并清 `deny`。
18. **车牌规则**：最多 8 码点（新能源牌）；位置 0 仅允许省份简称集合，其余位置为大写字母 + 数字；`tesla_plate_cycle()` 在集合内 ±1 循环；`append/pop/clear/valid`（绑定要求 ≥2 位）；`tesla_plate_to_utf8()` 缓冲不足返回 0。
19. 省份简称集合提供 UTF-8 字面量 `tesla_plate_charset_position_utf8()`，**顺序与码点数组逐位一致**，字体子集就是照这份取字形。
20. UTF-8 工具 `tesla_utf8_decode()`（码点数截断到 max）。
21. **持久化编解码**：`TESLA_STATE_VERSION=1`、`TESLA_BLOB_SIZE=96`；`encode` 校验枚举越界、`bound` 与车牌/昵称一致性，非法返回 0；**`MOVING` 按方向收敛为静态值后写盘**（断电重启不会卡在动画中间态）；`decode` 任何不一致返回 false 且**不部分写入**；`blob_looks_valid()` 只读判据。
22. 瞬时态（`deny_ms`、`moving_since_ms`、`job_*`、`last_ok_*`）不落盘。

### 5.3 绑定向导（`tesla_wizard.c/h`，主机测试 11 组）

23. 四步顺序：`MODEL（选车型）→ PLATE（编辑车牌）→ NICK（选预置昵称）→ CONFIRM（复核并写入）`。
24. 向导按键语义（全局统一，且在界面底部逐字显示）：
    - `UP/DOWN`：改当前步的值（车型列表 / 光标位字符 / 昵称列表）
    - `OK 单击`：接受当前值并前进一步
    - `OK 双击`：撤销 —— 车牌步删末位；确认步回到开头
    - `OK 长按`：后退一步；首步表示取消
25. `tesla_wiz_handle()` 返回 UI 动作：`NONE`（重画当前步）/ `DENY`（闪错误文案）/ `DONE`（UI 负责 bind + 落盘 + 回主控页）/ `CANCEL`（已绑定回主控页，未绑定留首步）。
26. 输入错误：`PLATE_SHORT`（不足 2 位不能前进）、`PLATE_FULL`（满 8 位需先删一位再改，光标钳位在 `0..7`）；提示 `TESLA_WIZ_ERR_MS=1200` 后由 `tesla_wiz_tick()` 自动清除（回绕安全）。
27. 预置昵称 `TESLA_WIZ_NICK_COUNT=5`，`tesla_wiz_nick_utf8()` 越界返回空串（绝不 NULL）、`tesla_wiz_nick()` 解码成 `tesla_nick_t`（最长 15 码点）。
28. `tesla_wiz_begin(w, st, now)`：`st` 可为 NULL（全新设备）；**已绑定时用现有机型/车牌/昵称预填**，让「换绑」从最省事状态开始；`w==NULL` 或按键越界时返回 `NONE` 且无副作用。

### 5.4 持久化（`tesla_store.c/h`）

29. NVS：namespace `tesla_key`、key `profile`、blob 存 `tesla_state_encode()` 产物；`init()` 可重复调用。
30. `load()` 三态：`ESP_OK` 成功恢复 / `ESP_ERR_NOT_FOUND` 无存档（已复位为未绑定）/ 其它错误 = 读失败或档案损坏（**同样复位为未绑定**，界面照常启动）。
31. `save()` 对非法状态返回 `ESP_ERR_INVALID_STATE` 且**不写盘**；`erase()` 用于解绑。

### 5.5 界面（`tesla_ui.c`，三页；`TESLA_UI_NONE/FOB/WIZARD/MANAGE`）

32. 三页共用同一页眉/底部提示坐标，**切页视觉不跳动**：标题 `(6,2,140,26)` @20px、电量 `(152,8,80,16)` @14px、按键提示 `(6,300,228,16)` @14px 居中。
33. **钥匙主控页**：车辆牌 `(6,30,228,64)` 内三行（昵称 14px / 车牌 20px / 车型 14px）；下方 **2×2 四把钥匙卡**（上锁 / 解锁 / 前备箱 / 后备箱），单卡 `112×84`、横向步距 120、纵向步距 90，卡内 = 名称 20px + 状态 14px + 选中指示条 `(40,68,32,5)`；状态条 `(6,276,228,22)`。
34. 交互：`UP/DOWN` 在四把钥匙间循环焦点；`OK 单击` 执行选中钥匙（`tesla_state_dispatch`）；`OK 长按` 进车辆管理页。回执/拒绝文案来自状态机的 `job/deny/last_ok_cmd`，由 `on_tick` 每拍驱动 `tesla_state_step()` 刷新（定时器回调运行在 LVGL 任务内，不额外加锁）。
35. **绑定向导页**：步骤行 `(6,32,228,18)`、**车牌 8 格**（单格 `26×32` @y=58，间距 3，总宽 `8*26+7*3=229` → 收敛到 x=235 内）、当前值 `(6,96,228,28)`、明细 `(6,126,228,18)`、确认摘要 `(6,148,228,46)`、错误提示 `(6,200,228,18)`；标题按模式显示「绑定车辆」/「换绑车辆」，底部提示逐字对应 §5.3 第 24 条。
36. **车辆管理页**：2 个条目（`换绑` / `解绑`），条目矩形 `(6, 40+idx*54, 228, 48)`，内含名称 `(0,2,228,26)` + 说明 `(0,29,228,17)`；`UP/DOWN` 循环焦点，`OK 长按` 回主控页。
37. 换绑：置 `s_rebinding` 后带现有档案进向导（预填）；解绑：先 `tesla_store_erase()`（失败仅告警），再 `tesla_state_unbind()` + 进向导（`st=NULL`）。
38. 向导 `DONE`：`tesla_wiz_nick()` → `tesla_state_bind()` → 焦点归零 → `tesla_store_save()`（失败只 W 日志，不回滚界面）→ 提示「已保存」→ 回主控页。
39. 生命周期与线程安全：`prepare()` 不持锁读 NVS；`enter()/exit()` 持锁；`tesla_ui_key()` **内部自行取放锁**；`exit()` **先 `lv_timer_delete` 再 `lv_obj_delete` 屏幕**（满足「demo 必须先停掉一切能碰 UI 的任务/定时器/回调再删屏」的仓库硬规定）并置空指针，幂等。
40. 页面切换用 `show_page()` = `destroy_page()` + 建新屏 + `lv_screen_load()`。

### 5.6 布局与字体（可测性/中文）

41. `tesla_layout.h` 只有纯整数：`TESLA_UI_W/H=240/320`、`MARGIN=6`、`KEY_COUNT=4`、`SLOT_W=26`、`SLOT_GAP=3`，加 `tesla_rect_inside()` / `tesla_rect_overlap()`（**边框相切不算重叠**）判据，UI 只消费这些矩形。
42. 主机布局测试 5 组：屏幕几何、四卡互不重叠且不与状态条/提示相撞、子控件不超父容器、车牌格连续且不越界、rect 工具本身。
43. 中文字体：`tools/gen_tesla_font.py --font F:\Desktop\test\NotoSansSC.ttf`
    - 只从 `main/tesla_*.[ch]` 的**字符串字面量**收集码点（注释、`ESP_LOGx` 文案被剔除，避免白烧字形）；
    - 恒含 ASCII 0x20-0x7E；
    - 先用 fontTools 核对源字体 cmap，**缺字直接失败**；
    - 源 TTF 是变体字体（wght 100-900，默认 100）→ **先固化 400** 再转换；
    - 生成 `assets/fonts/tesla_font_20.c`（≈181 KiB）/ `tesla_font_14.c`（≈124 KiB），4 bpp，当前 242 字形（含中文 147），并写清单 `tesla_font_symbols.txt` 便于 diff；
    - **必须带 `--lv-include lvgl.h`**：托管组件 include 根是 `managed_components/lvgl__lvgl`，生成默认的 `lvgl/lvgl.h` 会直接编译失败；
    - 产物以 `SRCS "../assets/fonts/tesla_font_20.c"` 形式注册进 `main/CMakeLists.txt`（规范：生成的 .c 加入使用方组件的 `SRCS`）。
44. 许可：Noto Sans SC，SIL OFL 1.1；衍生字体不得沿用保留名称，故命名 `tesla_font_*`；许可正文随生成物入 `assets/fonts/LICENSE-NotoSansSC.txt`。

### 5.7 明确未实现 / 未接线（做之前先问用户）

45. **蜂鸣/音频反馈**、**BLE 与真实车辆通信**、**Wi-Fi 配网**、**休眠唤醒策略**、**OTA**：均未实现。基线的 `demo_*.c`（音频/BLE/Wi-Fi/低功耗示例）仍在 `main/CMakeLists.txt` 的 `SRCS` 里编译，但 `main.c` **不引用**、不在启动路径上。
46. `tesla_state.h` 顶部注释提到 `tesla_tone` / `tesla_ble` 两个模块，**实际文件不存在**（属于对未来的分层约定，勿当作已有能力引用）。
47. 车控全部是**本地模拟**（时序状态机），没有真实车辆回执来源。
48. 「BLE 与真实车辆通信」的**协议可行性已另起 uni-app 探针验证到字节级**（见 §10）；固件侧仍未接线，接线时直接移植 §10 已确认的字段号/枚举/加密口径，不要重新查资料。

---

## 6. 改动影响速查

| 你要做的 | 必须连带 |
| --- | --- |
| 改 `main/tesla_*.[ch]` 里任何**上屏中文/文案** | 重跑 `python tools/gen_tesla_font.py --font F:\Desktop\test\NotoSansSC.ttf`，再 `idf.py build`；否则新字在设备上变豆腐块 |
| 改屏幕几何/新控件 | 改 `tesla_layout.h` 并补 `tests/test_tesla_ui_layout.c`（禁止把坐标硬写进 `tesla_ui.c`） |
| 改车控/向导规则 | 改纯逻辑 + 补对应 `tests/test_tesla_{state,wizard}.c`，再上屏 |
| 改 `tesla_state_t` 持久化字段 | 递增 `TESLA_STATE_VERSION`、保证 `decode` 兼容或明确不兼容、更新 §5 与归档哈希 |
| 动车型枚举顺序 | 禁止中间插入（索引已持久化） |
| 加新依赖/组件 | 改 `components/bsp/idf_component.yml` 或 `main/CMakeLists.txt` 的 `REQUIRES`，并更新本文件 §1/§2 |
| 交付前 | `idf.py build` → `merge-bin`（绝对路径）→ `python tools/verify_firmware.py build` → `python tools/archive_firmware.py create build --archive-root build/firmware` → `… verify <dir>` → 更新 §0 |

---

## 7. 验证：跑什么、怎么跑、跑不了什么

**门禁清单**（`tools/validate.sh` 登记的特斯拉钥匙相关部分）：
- `tests/test_tesla_state.c` + `main/tesla_state.c`
- `tests/test_tesla_wizard.c` + `main/tesla_wizard.c` + `main/tesla_state.c`
- `tests/test_tesla_ui_layout.c`（`-Imain`，只用 `tesla_layout.h`）
- 编译口径：`-std=c11 -Wall -Wextra -Werror`
- Python 侧：`tools/check_repo.py`（当前 PASS，254 文本文件）、`tools/verify_firmware.py`、`tools/tests/test_{verify_firmware,deep_sleep_contract,archive_firmware}.py`

**本机等价执行方式**（`./tools/validate.sh` **跑不了**：`bash.exe` 是无发行版的 WSL，`gcc/cc/clang` 全部缺失）：

```powershell
& "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\Tools\Launch-VsDevShell.ps1" -Arch amd64 -SkipAutomaticLocation | Out-Null
cl /nologo /W4 /WX /utf-8 /std:c11 /Fo:F:\Desktop\test\hosttest\ /Fe:F:\Desktop\test\hosttest\test_state.exe `
   ai-passport\tests\test_tesla_state.c ai-passport\main\tesla_state.c
```

注意：在 PowerShell 循环里用变量塞多个源文件会误报 COMPILE FAIL —— 逐条展开、文件列表写死。中间产物（`*.obj`/`*.exe`）用完清理。

**已知与本次改动无关的环境限制**：
- `tests/test_check_repo.py` 有 5 处 FAIL：用例按正斜杠拼路径，Windows 反斜杠导致断言失败。
- `tests/test_install_passport_skills.py` 有 3 处 FAIL：`WinError 1314`（非管理员建不了目录符号链接），脚本自身已提示该情形。

**当前测试结果**：三套 C 测试全 PASS（state 10 组 / wizard 11 组 / layout 5 组）；`check_repo.py` PASS；`verify_firmware.py` = Firmware layout PASS + Merged firmware PASS；`archive_firmware.py verify` PASS。

---

## 8. 交付物与刷写（未经批准不得执行）

- 分区口径：app 687,520 / 8,323,072 B（`factory` @0x10000，**占用 8%**）。
- 合并固件（推荐交付形态）：`build/FoloToy-AI-Passport-full.bin` = 753,056 B，**从 0x0 一次刷完**（内含 bootloader@0x0、partition-table@0x8000、app@0x10000）。
- 归档（`passport-build` 要求，含调试件）：`build/firmware/<full.bin 的 sha256>/`，内含 `FoloToy-AI-Passport.elf/.map/.bin`、`-full.bin`、`bootloader/`、`partition_table/`、`flash_args`、`manifest.json`；交接前 `archive_firmware.py verify <dir>` 并报告归档路径、full-image hash、manifest 中匹配的 ELF。
- 可追溯性：固件内 `app_descriptor.version` = 当前提交号。**先提交再构建归档**，否则版本号是 `<基线>-dirty`，无法追溯到提交（本次已因此重建并重归档，旧归档删除）。
- 分件刷写等价命令（来自 `flash_args`）：
  `--flash_mode dio --flash_freq 80m --flash_size 8MB`；`0x0 bootloader.bin`、`0x8000 partition-table.bin`、`0x10000 FoloToy-AI-Passport.bin`。
- **整片刷写会重置设备上的既有数据**（含 NVS，即车辆档案），刷写前必须说明并取得批准；检测到手设备 ≠ 授权。

### 真机待验证清单（Device tests: NOT RUN 时照抄）

1. ST7789P3 上中文字形实际清晰度、圆角区是否压字、24 KB LVGL 池下的内存峰值/是否绘制卡死。
2. GPIO0 三键 ADC 分压的真实键值与事件识别（单击/双击/长按是否互相误判）。
3. NVS `tesla_key/profile` 断电重启回读；人为损坏 blob 时的降级路径。
4. 长时间运行下 `on_tick` 计时精度（900/700/1200/1500 ms 各提示的实际观感）。
5. 功耗与发热；休眠/唤醒行为（本应用未主动实现）。

---

## 9. 维护本文档（硬性要求）

**任何新功能、新页面、新按键语义、新依赖、新组件、新工具脚本、新的环境路径/版本、新的未验证项，都必须同步更新本文件对应小节**，并在收尾时把 §0 快照（分支、提交号、固件大小与 SHA256、归档路径、四类测试结果）改成最新值。

- 新增/删除源文件 → 更新 §4 架构与 §5 功能清单（功能逐条编号，不要合并成段落）。
- 改了交互（尤其按键语义）→ 同时更新 §5.3/§5.5 与 §6 速查表。
- 引入新第三方组件/字体/工具 → 记录版本、路径、许可，并补 §1/§2/§5.6。
- 已知限制被解决或新增 → 更新 §7；设备到货并测过 → 把 §5.7/§8 的未验证项挪到「已验证」并写实测结果。
- 文档变长时优先删冗余描述，**不要删功能条目**；与仓库文档冲突时以 `AGENTS.md` 路由表指向的权威文档为准，并回来修正本文件。
- §10（旁支探针）与固件仓库无关，但**协议事实是共用的**：任何在 §10 里新确认/推翻的字段号、枚举数值、加密口径，必须同步写回 §10 的「已确认」清单，避免固件侧接线时二次调研。

---

## 10. 旁支工程：`tesla-ble-probe`（uni-app 特斯拉 BLE 离线钥匙可行性探针）

> 位置：`f:\Desktop\test\tesla-ble-probe\`（**独立目录，不属于 ai-passport 仓库，不受双语门禁约束**）。
> 目的：用户不确定「特斯拉开放的 BLE 离线钥匙方案」能否在非官方客户端上跑通，先用最低成本做一版可点按钮的 App 验证；只做**绑定车辆 + 上锁 + 解锁**，UI 不管美观。

### 10.1 可行性判定（已给出，无需重问）

**可行**，但仅限 **App / Android 真机**：
- 加密全部纯 JS 自研（SHA-1 / AES-128-GCM / P-256 ECDH），**不依赖 BigInt**（HBuilder X 的 JSCore 可能没有 BigInt，protobuf varint 用 double + `scale *= 128` 累加，安全上界 2^53）。
- **不需要任何第三方原生插件**，但 `uni.openBluetoothAdapter` 属于 5+ 的 **Bluetooth 模块**，必须在 `manifest.json → app-plus.modules.Bluetooth` 声明，并且**必须打进自定义调试基座**（标准基座/HBuilder app 未编译该模块，点蓝牙会弹 `打包时未添加bluetooth模块`，改 manifest 无效）。代价是云打包 1 次；此后改 JS 走热更新不再占次数。
- `0x2902` 描述符只能靠 `notifyBLECharacteristicValueChange` 打开，属唯一硬不确定项（见 §10.5）。
- H5 / 小程序拿不到 GATT → 代码里 `typeof uni === 'undefined'` 或环境不对时直接抛「只能在 App 真机上运行」。

### 10.2 模块清单

| 文件 | 职责 |
| --- | --- |
| `common/{sha1,aes,p256,bytes}.js` | 密码学与字节工具（`aes.js` 用 xoshiro128** 做持久 PRNG 补 `randomBytes`） |
| `common/pb.js` | 手写 protobuf wire 编解码；`asBytes` 接受 `Uint8Array/Array/Buffer/hex 字符串` |
| `common/spec.js` | **字段号与枚举全表**（`ENUMS` + `MESSAGES` + `SPEC`），头注释标了权威来源 |
| `common/vcsec.js` | GATT UUID、`bleNamesForVin`、`prependLength/stripLength`、`newKeyPair/keyIdOf/sharedKeyOf`、四类帧构造、`decodeResponse/summarize` |
| `common/tesla-ble.js` | uni BLE 封装（§10.4 三条铁律固化在此） |
| `common/session.js` | 全局会话：密钥对与 counter 落盘、日志总线（上限 400 条）、`connectTo(vin)` |
| `common/actions.js` | 页面动作层：`bindKey / requestEphemeralKey / sendRke / checkWhitelisted / statusText` |
| `pages/{index,rke,debug}` + `components/log-box` | ① 扫描连接绑定 ② 上锁解锁 ③ 手工组包与原始帧收发 |
| `tests/run.mjs` | Node 侧与 `crypto` 对拍自测 |
| `tests/vue-check.mjs` | 抽 `.vue` 的 `<script>`、重写 `@/`→`../../`、落到 `tests/.tmp-page/` 真 `import` 一遍（进 HBuilder X 前筛掉拼写/导出名错误） |

### 10.3 已确认的协议事实（字节级验证过，固件接线可直接复用）

1. GATT：Service `00000211-b2d1-43f0-9b88-960cebf8b91e`，写 `0212`，收（**INDICATE**）`0213`，读通信版本 `0214`。
2. 帧 = **2 字节大端长度前缀 + protobuf 报文**；收包必须按前缀做粘包/半包重组。
3. BLE 广播名：新车 `Tesla ` + VIN 后 6 位；老车 `S` + `SHA1(VIN)`hex 前 16 位 + `C|R|D|P`（末位未知 → 必须前缀匹配）。
4. **proto3 默认值省略是本项目最大的坑**：singular 标量为 `0/false/空` 时不编码。
   - `RKE_ACTION_UNLOCK = 0` → 整个 `UnsignedMessage` 编成**空字节串**，车辆按默认 0 解释。
   - `OPERATIONSTATUS_OK = 0` 同样被省略（所以「刷卡成功」的样例只有 `1a 08 12 06 0a 04 …`）。
   - `UnsignedMessage.RKEAction` 是**字段 2** → tag `= 2*8 = 0x10`，`LOCK=1` 的正确内层字节是 **`10 01`**（`08 01` 来自 `CommandStatus.operationStatus` 字段 1 的另一个样例 `22 02 08 01`，两者别混）。
5. `PermissionChange.permission` 是 **packed repeated** → `10 04 02 01 04 03`（LOCAL_DRIVE=2, LOCAL_UNLOCK=1, REMOTE_DRIVE=4, REMOTE_UNLOCK=3）。
6. 绑定→协商→RKE 全流程：明文 `WhitelistOperation`（`signatureType = SIGNATURE_TYPE_PRESENT_KEY = 2`）→ 车辆回 `OPERATIONSTATUS_WAIT(1)` → **刷实体 NFC 钥匙卡** → 回 `whitelistOperationStatus = OK` + `signerOfOperation.publicKeySHA1`；
   再 `GET_EPHEMERAL_PUBLIC_KEY = 3`（**走顶层 `unsignedMessage = 2`，不加密**）→ `sessionInfo.publicKey`（65 B，`04||X||Y`）→ **`sharedKey = SHA1(ECDH 共享 X 坐标)[:16]`**；
   RKE 用 `AES-128-GCM(key = sharedKey, nonce = beBytes(counter, 4), aad = 空)`，**16 B GCM tag 放 `signature` 字段**。
7. counter **单调递增、不可回退**：nonce 复用会触发 `FAULT_IV_SMALLER_THAN_EXPECTED` / `FAULT_TOKEN_AND_COUNTER_INVALID`，且对同一把已绑定 key 是**永久性**的，只能重新绑定 → counter 必须落盘且只增不减，车辆响应里的 counter **只用于向上纠偏**。

### 10.4 BLE 三条硬规则（写在 `tesla-ble.js` 头注释，勿改）

- **A** 连上立刻 `stopBluetoothDevicesDiscovery`（边扫边连必掉连接）。
- **B** 所有 write 走 **Promise 链串行队列**，绝不在 BLE 回调里再 write（安卓栈会吞包）。
- **C** 必须 `setBLEMTU` 抬到 ≥ 帧长 + 3（依次试 247/185/128/64），否则 65 B 临时公钥响应被截。
- 另：连上后 `send()` 前**清空接收缓冲**保证一问一答对齐；写前若超 `mtu-3` 只告警不分片（特斯拉不接受分包写）。

### 10.5 已知不确定项（真机才能定论）

1. `notifyBLECharacteristicValueChange` 能否打开 `0213` 的 CCC —— **uni 没有暴露手写 `0x2902` 的能力**，这是整个探针唯一的原生能力赌注；代码已埋「关键阻塞」日志，失败时提示改用 nRF Connect 手动 Enable indicate 或换支持描述符写入的原生插件。
2. `deriveSharedSecret` **明确拒绝 33 字节压缩点**（`throw '暂不支持压缩点'`）；若车辆真发压缩点需补模平方根开点。
3. `AUTO_SECURE_VEHICLE` / `WAKE_VEHICLE` 等动作编号**与固件版本相关**，未核实 → 页面只放 0–5 这些跨版本稳定值，其余用自定义输入试。
4. 临时公钥是否轮换未定（现实现为协商一次一直用；若过期表现为 `FAULT_AES_DECRYPT_AUTH`，重新协商即可）。
5. 车辆 BLE 钥匙连接数有限（通常 3 台），**特斯拉官方 App 在线会占坑** → 测试前须杀掉其后台并断开其蓝牙。
6. 私钥明文存 App 沙箱（`tesla_probe_key_v1`）= 探针够用，**产品不可用**，正式方案必须 Android Keystore / iOS Keychain。

### 10.6 判读表在哪 / 怎么跑自测

三张判读表（`OperationStatus_E` 3 值、`SignedMessage_information_E` 0–14 含全部 `FAULT_*`、`WhitelistOperation_information_E` 0–12，每条都带「出现时该怎么办」）在 `f:\Desktop\test\tesla-ble-probe\README.md` §4；HBuilder X 真机步骤、Android 权限说明（只运行时申请 `ACCESS_FINE_LOCATION`，targetSdk=30 下申请 `BLUETOOTH_SCAN/CONNECT` 会被判「永久拒绝」误导排障）、替代方案在 README §3/§8。

```powershell
cd f:\Desktop\test\tesla-ble-probe
node tests\run.mjs        # 当前: 98 passed, 0 failed
node tests\vue-check.mjs  # 当前: 页面脚本自检 全部通过 (3 个)
```

**注意**：`tests/run.mjs` 里 `eqHex('stripLength', body, fromHex('22020801'))`（约 L228）的 `22020801` 是**合法期望值**，不要跟 §10.3 第 4 条那个改错的 `0801` 混为一谈去「修」它。

### 10.7 权威来源（引用过，别再翻）

| 来源 | 用途 |
| --- | --- |
| `protos/VCSECv3.10.14.proto`（GitHub `trifinite/vcsec-archive`） | 字段号、枚举数值权威表 |
| gist `LexNastin/fc55736f…` | 端到端绑定 + 加密指令样例报文的字节级核对 |
| `teslabtapi.com/docs/start` | GATT、长度前缀、BLE 命名规则 |
| `teslabtapi.com/docs/more/rke` | RKE 动作枚举、AES-GCM 的 key/nonce/aad 推导 |
