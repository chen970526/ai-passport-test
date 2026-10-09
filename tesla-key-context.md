# FoloToy AI Passport —— 特斯拉离线 BLE 钥匙：项目上下文卡

> **用法**：新开对话时，把本文件整体贴给 AI 作为首条消息的上下文，再说一句需求即可。
> AI 读完本文件应当不需要重新通读全部源码就能定位到该改哪里、该怎么验证。
> 本文件就在**仓库根**（与各工程目录同级），已随 `f35655d` 入库；旧机时代「放在仓库之外」的约定已作废。**路径口径见 §2：全文一律用相对仓库根的路径、不写盘符 —— 换电脑、换盘符都不用改命令。**
> **当前阶段：项目收尾 —— 实车加密链路全通，用户改为自行手动烧录（§7.8）。剩余：鲁棒性（§7.3 步骤 8）、BLE 层 bond、UI 优化。**

---

## 0. 一句话现状（每次改动后必须更新本节）

| 项 | 当前值 |
| --- | --- |
| 主工程 | `tesla-offline-ble\`（ESP-IDF v5.5.3 / ESP32-C3，**2026-10-03 起 = 车钥匙整机：BLE 链路 + LVGL 屏幕界面 + 三按键 + 2 秒固定轮询**） |
| Git | 仓库根 = 本文件所在目录（**不写盘符，见 §2 相对路径口径**），remote `https://github.com/chen970526/ai-passport-test.git`，分支 `feature/tesla-offline-ble`，HEAD `6ca45cf 提交md文档`；**工作区有未提交改动**（`README.md`、`application/main/{CMakeLists.txt, app_main.c, key_ui.c, tlb_app.c}`、`tlb_ble.h`、`tlb_bind.h/.c`、`sdkconfig.defaults`、`tests/host/goldens.h`、**新增 `vin_cfg.c/.h`、`flash.ps1`、`flash.bat`、`peek.py`**、本文件），按 §8.1 **不 commit** |
| ESP-IDF 构建 | **PASS（2026-10-09 实跑，VIN 配网热点版）**：`build\tesla-offline-ble.bin` = **1,823,376 B（`0x1BD290`**，factory 0x7f0000，约 78% free）。历史：车钥匙化后 1,140,240 B → 2026-10-08 重构建 1,303,056 B → 本版链接进 Wi-Fi SoftAP + esp_http_server + DNS 门户（`vin_cfg.c`）再涨。体积从 691,776 涨到 ~1.11 MB 的原因：链接进 LVGL 9.6 + esp_lvgl_port + iot_button + bsp 显示/按键 + 两个中文子集字体（非压缩，双字库：key_font_20 107 KiB / key_font_14 416 KiB，见 §7.7）。**已烧录（第 7~22 次，均分件刷 app @0x10000、0x9000 未动、hash 校验过）**。**板上现行 = 第二十八次（引导页布局修复 + 遮挡排查，2026-10-09）**，历史：第 7 次=车钥匙整机首版 → 第 8 次=字体/几何自检诊断版 → 第 9 次=**字库去压缩修复版（文字恢复显示）** → 第 10 次=ADC 采样诊断版（证实右三 603 mV 正常） → 第 11 次=按键屏幕反馈版 → 第 12 次=屏幕诊断版（长按右三切换 ADC/事件计数/RAM/连接显示；同日经用户授权执行 `wipe_legacy` 清 `trae_cfg` 并复验绑定完好）→ 第 13 次=日志页版（页2 双行小字显示最近两条，因遮挡被用户否决）→ 第 14 次=**全屏日志页版**（vprintf 钩子 tee 进 8×160B 静态环形缓冲；页2 整屏一次一条日志自动换行，右三单击逐条翻看，底部 N/8；页1 增加「启=重启原因」中文）→ 第 15 次=**安全边距版**（`UI_MARGIN=10` 物理像素应对壳子圆角，全部界面元素与日志页统一缩进）→ 第 16 次=自动进诊断版（电池态排障临时）→ 第 17 次=**app_button 分叉驱动版**（application/main 自带一份 bsp_button 源码：ADC 读失败重试 3 次/真实错误码上屏/自愈重 init）→ 第 18 次=init 自检读+NimBLE 日志降 WARNING（同步进 sdkconfig.defaults）→ 第 19 次=init 失败也粘存错误码+每 5 秒自愈重试（ui_tick 驱动）→ 第 20 次=**按键 init 挪到 console 之前**+自动翻页（排障临时）→ 第 21 次=诊断页1 加「阶=N」启动阶段打点 → 第 22 次=删除全部排障临时逻辑，诊断恢复纯手动（用户电池实机复验通过：ADC=2921mV、三键正常，根因定案见 §7.7）→ 第 23 次=**前备箱/后备箱开盖**（closureMoveRequest 编码器 + vehicleStatus 内层解析 + 右三单击=前备箱/双击=后备箱 + 首页矢量俯视车）→ 第 24 次=**按 `UI_SPEC.md` 推翻重做首页**（TESLA/Model Y 品牌区+连接状态点+car 图标 88px+锁车/解锁/前备箱三卡片+check 反馈 600ms；8 个 48×48 PNG 转 L8 遮罩图标约 18KB，tools\gen_key_icons.py 生成；旧硬件测试首页元素全删；诊断页1/页2 与阶段打点原样保留为 DEBUG）→ 第 25 次=**VIN 配网热点首版** → 第 26 次=**配网页 pattern 漏 S~Y 修复**（用户手机实测保存成功）→ 第 27 次=**引导页加 VIN 行、底部提示删减** → 第 28 次=**现行：布局修复（卡片 135→142、状态行 115→117）+ 遮挡排查确认 set_onb_visible 已含 s_onb_vin + 非 Tesla 设备超时属正常行为**。更早（第六次及以前）：基线 625,616 → 690,080 → 690,112 → 690,144 → 691,776 |
| 主机测试（金标准/对抗） | **PASS（2026-10-09 实跑 `tests\host\run.ps1`）：2547 checks, 0 failed**（覆盖本轮 `tlb_bind` 改动与重生成 `goldens.h`；旧「NOT RUN / 2533 checks」记录作废） |
| **2026-10-09 VIN 配网热点（已实现 + 真机串口验证 PASS）** | 无 VIN 开机 = **纯配网模式**：只留「屏幕提示页 + SoftAP + DHCP + DNS 门户 + httpd」，**蓝牙栈/worker/link 任务全不启动**（C3 内存实测 BLE 栈吃 ~105 KB，BLE+WiFi 共存必死，见 §1）。SSID `AI-PASSPORT-TSL` / 密码 `87654321` / 网关 **192.168.4.2**（特意避开另一固件占用的 4.1）；门户弹窗 = DNS 劫持（UDP:53 全应答 4.2）+ DHCP 选项 114 + 10 个探测路径 302 到 `/`。网页保存 VIN → 写 NVS → 2 秒后 `esp_restart()` 进正常模式（开蓝牙、热点不再开）；**不做运行中热切换**。sdkconfig 已关 `ESP_WIFI_IRAM_OPT`/`RX_IRAM_OPT`（C3 上 IRAM=DRAM，省 ~70 KB）。新增文件 `application\main\vin_cfg.c/.h`，`tlb_app.c` 以 `s_cfg_mode` 分流；串口 REPL `vin` 保留为开发通道。实测日志：`开热点前堆: 空闲内部=97812 最大内部块=86016` → softAP 起 → `DHCP server started ... IP: 192.168.4.2` → `DNS 已监听 :53` → `配网热点已开启：AI-PASSPORT-TSL`，无警告。**已用户手机实测 PASS（2026-10-09 第 26/27 次刷写）**：真车 VIN `LRWYGCEJ0TC723591` 经网页保存成功、重启后串口回显「本机记录的 VIN=LRWYGCEJ0TC723591」、热点不再开。踩坑两处：① 配网页 input `pattern` 曾写成 `[A-HJ-NPRZ0-9]`（R-Z 少横杠 → S~Y 全被误拒，Chrome 弹「请与所请求的格式保持一致」），已修正为 `[A-HJ-NPR-Z0-9]`；② 绑定引导页改版（用户口径）：底部「青色=疑似你的车/其他设备也可选中绑定/双击右三重扫·长按右三诊断」全删，步骤与列表之间新增 VIN 行（快照新字段 `onb_vin[18]`，来自 `active_vin()`），列表下移到 y=135，底部仅配对阶段留「右三=已确认，立即验证」。**第 28 次（用户实机反馈 + 修复）**：① 选了非 Tesla 设备（`220Fb16f`）→ 连接后服务发现超时（非 bug：非 Tesla 无 0211/0212/0213 服务，`GATT_PROC_MS=8000`），状态行显示「失败:服务发现超时」。车没广播 VCSEC 时列表里**没有**青色圆点标记，扫描结果里所有设备都是灰色——属正常行为，绑定时务必等车唤醒（坐进车内）且列表出现青色疑似车再选（见 §7.3 绑定前 checklist）。② 布局修复：卡片 y=135→142、状态行 y=115→117，VIN 行（y=97，底 113）与状态行（y=117-135）差 4px，状态行与卡片顶（y=142）差 7px，不再视觉拥挤。③ 可见性链复核：`set_onb_visible()` 数组已含 `s_onb_vin`（L294），诊断页1（长按右三）/全屏日志页（右三单击翻页）/出厂重置提示均正确隐藏引导页全部 6 元素 |
| 真机测试 | **PASS：步骤 1-7（2026-10-03 实车 + 实体 NFC 卡在场）**。扫描命中 → 连接 → 停扫 → 服务 `0211`/订阅 `0213` INDICATE/MTU **247** → **绑定成功**（车端直接回终态 `WHITELISTOPERATION_INFORMATION_NONE(0)`）→ **两域 V3 握手全部 `SESSION_INFO_STATUS_OK`** → **RKE 三个动作号全部实机受理**（第六次刷写后逐条授权连发）：`rke 1`=LOCK 明文`1001` 车 counter=3、`rke 0`=UNLOCK 明文`1000` 车 counter=4（**首次实机，§7.5 项 4 就此关闭**）、`rke 20`=REMOTE_DRIVE 明文`1014` 车 counter=5，三次均 `[ok] 空响应（车辆已受理）`、无任何 `FAULT_*`/`GENERICERROR_*`。步骤 4（BLE 层 bond）仍失败、步骤 8 **部分验**（重启 counter 不回退已定论，拉黑距离/断电重连与重复绑定幂等未验）；详见 §7.3 |
| NVS 内容清点（2026-10-03 只读解析 `nvs-before-flash6-*.bin`，用 IDF `nvs_partition_tool/nvs_tool.py -d all`） | **4 个命名空间**：① `phy`（`cal_data`/`cal_mac`/`cal_version`，ESP-IDF 系统 PHY 校准，**该留**）；② **`trae_cfg`（`profile` blob 245 B，内含 `FoloToy`/`NETRUNNER`/`avatar-01`）= 旧 ai-passport 应用的配置，就是用户说的"旧东西"**；③ `tesla_ble`（`vin`=`5YJ3E1EA7KF000000` ✓、`key` 128 B 密钥对、`bind` 152 B、`v3_info`/`v3_session` 各 112 B = **当前可用绑定，清掉就要回车里刷实体 NFC 卡重绑**）；④ `nimble_bond`（`local_irk_1` 23 B）。另：NVS 里能搜到 `FAKEVIN000000001`/`FAKEVIN000000002`/`11:22:33:44:55:66` 等**别辆车**的 VIN/MAC，但它们全在状态为 `Erased`（被后续写覆盖）的历史条目里，**不是活数据**，压缩后即消失。<br>**固件本体已证实是纯的**：map 文件里 `liblvgl__lvgl.a(` / `esp_lvgl_port` / `esp_codec_dev` / `button` 的**被链接对象数 = 0**（只在链接器 LOAD 行出现），`application/main/CMakeLists.txt` 只 `REQUIRES tesla_ble tesla_core` → 691,776 B 里没有一行 GUI/音频代码。`managed_components\` 里的 lvgl 等目录只是**仓库残留**，不进产物 |
| 刷机期修复 | ① `ble_att_set_preferred_mtu(517)` 早于 `nimble_port_init()` → 开机 Load access fault（`tlb_ble.c`）；② `tlb_nvs_init()` 漏 `nvs_flash_init()` → NVS 全程未初始化（`tlb_nvs_store.c`）；③ `bind` 崩 `tlb_worker` 栈（`MCAUSE 0x1b` 栈保护）→ `xTaskCreate` 栈 **12288 → 24576**（`app_main.c`/`tlb_app.c`，实测最深链 ≈12.0 KB，**16 KB 不够**）；④ **ECDH 一律 `-0x4f80`** → mbedTLS 3.x `mbedtls_ecp_mul_restartable` 入口硬守卫 `f_rng == NULL` 直接返回 `BAD_INPUT_DATA`，`tlb_port_ecdh()` 传 `tlb_rng` 修复（详见 §5.7）。**四处都只有真机才暴露** |
| 串口文案事故 | `tlb_console.c` 的 rke 帮助文案凭印象写成「1=解锁 20=上锁」，导致按「上锁」取得授权后**实发了 `RKE_ACTION_REMOTE_DRIVE(20)`**（明文 `1014`），车端已受理。文案已按 `tlb_text.c`/`tlb_types.h` 权威枚举改正（`0=解锁 1=上锁 20=驾驶授权 29=自动落锁 30=唤醒`），**修复版已于 2026-10-03 经授权烧录上板（690,144 B），并在板上实跑 `rke`（无参）核对新文案 + 逐条授权后补发正确的 `rke 1`（LOCK）成功**。教训见 §5.7-B：权威口径只认 `tlb_text.c` 的 `E_RKE` 与 `tlb_types.h` 枚举，帮助文案绝不凭印象 |
| 新增能力 | `application\main\tlb_console.c`：esp_console REPL（USB-Serial-JTAG，提示符 `tlb> `），14 条命令一一映射 `tlb_app_post`/直接 NVS 操作，见 §7.6 |
| **2026-10-03 车钥匙化（已实机验证，第 7~11 次刷写，详见 §7.7 结果）** | 用户口径：整块板子 = 特斯拉真车钥匙，左上角=开机（硬件电源键，软件读不到），右一=上锁，右二=解锁+启动，右三=暂不绑定；2 秒固定轮询（省电）；界面先最小可用。落地：① `tlb_app.c` 退避档位删除 → `TLB_AUTO_SCAN_MS=2000`（定向/全量扫描窗口都缩到 2 s）+ `TLB_RETRY_DELAY_MS=2000` 恒定，新增 `tlb_app_ui_snapshot()` 原子快照（connected/tries/ever_connected/rke_*）供 UI 只读；② 新增 `key_ui.c/.h`：LVGL 最小界面（标题+spinner+主状态+副行+按键提示，150 ms lv_timer），文案「正在连接车机…/已连上车机/车机已断开/车辆已上锁/车辆已解锁/启动已授权/指令发送失败」等；③ `app_main.c` 按键映射：`BTN_RIGHT1=BSP_BTN_UP`→RKE 1、`BTN_RIGHT2=BSP_BTN_DOWN`→RKE 0→20（worker 串行保序）、`BTN_RIGHT3=BSP_BTN_OK`→无操作，每次按键串口打全事件日志 + **屏幕亮键名 1.2 s**（**映射实机已确认三键全对**，右三无动作系设计如此）；④ 中文字库：`tools/gen_key_font.py` 扫 `key_ui.c` 字面量 → lv_font_conv@1.5.3 + simhei.ttf 生成 `key_font_20/14`（现 137 字形，**必须 `--no-compress`**，压缩坑见 §7.7）；⑤ `sdkconfig.defaults` 补 LVGL 段（**旧 sdkconfig `CONFIG_LV_MEM_SIZE_KILOBYTES=0` 是真机必崩的坑**，已删 sdkconfig 重配，现值 24）；⑥ `wipe_legacy` 命令（见 §7.2 清除定案）。详见 §7.7 |
| 2026-10-03 四项优化（第五次刷写，均已实机验证） | ① **RKE 白名单硬闸门**：[tlb_types.h](tesla-offline-ble/components/tesla_core/include/tesla_core/tlb_types.h) 新增 `tlb_rke_action_known()` 作单一事实源，`tlb_app.c:handle_rke()` 对表外动作号**直接拒发并 return**（旧版只 WARN 照发），console 层再拦一次给即时反馈，并在下发前打审计行「即将下发 X 明文=12 01」；② **连接路径修正**：删掉 `tlb_app.c` 内置目标车常量与「无档案即播种」逻辑（身份一律来自 NVS），定向扫描地址类型改传 `TLB_BLE_ADDR_TYPE_ANY`（真车是 public type 0，写死 type 1 令这条扫描永不命中）→ 实测**开机 t≈0.3 s 就按 MAC 命中并发起连接**（旧版白等 20 s 全量扫描再改名匹配档）；③ **错误码可读化**：`tlb_ble.c:rc_text()` 补 SMP 段映射，`1283 = 0x503 = BLE_HS_ERR_SM_PEER_BASE + BLE_SM_ERR_AUTHREQ` → 打印「车辆拒绝配对：认证要求无法满足(Authentication Requirement) errCode=10008」；④ **counter 可观测性**：会话行追加「（盘上counter=N）」，据此定论 §7.5 项 8。<br>**行为变更（重要）**：无档案且 NVS 里没有手输 VIN 时 `active_vin()` 返回**空串**（不再兜底内置 VIN），必须先 `vin <VIN>` 或 `connect <VIN>` |
| NVS 备份 | ⚠ **仓库里没有任何 NVS 备份文件**（`nvs-backups\` 尚未创建）—— 旧机上那批 `nvs-20261002-134822.bin`、`nvs-after-fix.bin`、`nvs-before-car.bin`、`nvs-before-flash6-20261003-022401.bin`（第六次刷写前 = 最完整的可用绑定快照）都没迁过来，**别指望历史快照**。**→ 手动烧录前必须现做一份：§7.8 步骤 4 落到仓库内 `nvs-backups\`**（相对位置固定；文件不入库，换机要手动拷）。**⚠ 板内 NVS 现况（据旧机记录，尚未复核）：NVS 里有「本车绑定成功的密钥 + 会话 counter + 档案 deviceId」，第六次刷写后 `keyId=DE:AD:BE:EF`、deviceId、counter 全部保留（分件刷写不碰 0x9000 已六次实证）。当前盘上 counter：VCSEC=4、车机域=0。再刷任何固件若动到 NVS 就要重新拿实体 NFC 卡绑；刷前仍按 §7.2 备份 + 复述风险** |
| 旁支探针 | `tesla-ble-probe\`（uni-app 纯 JS，未重跑） |
| 参考仓容器测试 | **未开始**：`ref-repos\` **已在仓库内**（2026-10-08 复核，§10 旧「整目录缺失」记录作废）→ `test_tlb_message_builders.cpp` 可以创建；但**当前机器无 docker**（`docker` 不识别；换机先 `docker version` 自查）→ 容器 gtest 仍跑不了 |
| **下一步** | **车钥匙整机全部核心功能实车达标（2026-10-03）**：连车、上锁、解锁、启动授权用户确认均正常（§7.7）；`wipe_legacy` 已执行复验（§7.2）；屏幕诊断版现行可用。剩余按序：⑬ **电池态按键失灵已修复并经用户实机复验**（第 16~22 次刷写；根因=电池态 `tlb_console_start()` 无 USB 主机时阻塞主任务，按键初始化排其后永不执行→挪到其前；诊断恢复纯手动：长按右三切换、单击右三翻页）；⑭ **UI 优化**（用户口径允许延后，现在可以开始）；旧待办不变：⑦ §7.3 步骤 8 余下项（拉黑距离/断电重连、重复绑定幂等）；⑧ 补跑 §6.2 主机金标准（在仓库根跑 `powershell -ExecutionPolicy Bypass -File tesla-offline-ble\tests\host\run.ps1`）；⑨ §7.5 项 6：BLE bond 被 `BLE_SM_ERR_AUTHREQ(0x03)` 拒，是否动 `sm_io_cap`/`sm_bonding` 由用户定；⑩ 待验动作号 29、30 —— 每条单独授权（§8.3）。**烧录授权口径（2026-10-03 用户更新）：用户在场时烧录无需逐次授权，但分件刷 app 不碰 0x9000 + 刷前 NVS 备份的红线不变**；**2026-10-08 起改为用户自行手动烧录（照 §7.8 一步步走），AI 不再代刷**。**按键操作口径（实测教训）：动作只认单击，按住 >2 s 变长按不触发；带板测试务必快速轻按**。**2026-10-09 新增待办**：手机实测 VIN 配网页全流程（连热点 → 门户弹窗/手动开 http://192.168.4.2 → 填 VIN → 保存重启；无线部分 AI 无法代测） |
| **环境与手动烧录（2026-10-08）** | **路径口径已统一为「相对仓库根、不写盘符」（§2）—— 换电脑、换盘符都不用改命令**。IDF 装在哪只影响「激活那一行」，端口每次按 §7.8 步骤 1 现查（机器上可能挂着别的串口，别凭记忆抄号）。2026-10-08 复核：HEAD 已是 `f35655d 完成开锁上锁，前后备箱功能`（工作区仅 zip/`UI_SPEC.md.localbak` 等杂项，源码干净）；`ref-repos\` 四个参考仓已到位、gcc 已可用 → §6.2/§6.4 的「缺失/无 gcc」阻塞解除；重新构建 **PASS**：`tesla-offline-ble\build\tesla-offline-ble.bin` = **1,303,056 B（`0x13e210`**，factory 0x7f0000，84% free）。`tlb_cmd.py`/`probe_console.py` 不在仓库内（旧机散落脚本）→ 手动流程用 `idf.py monitor`。**用户自行一步步手动烧录的完整 SOP 见 §7.8**（端口现查、NVS 备份、分件刷 app、monitor 自检、故障处置表） |

---

## 1. 硬件与运行时约束（不可协商）

| 主题 | 事实 | 依据 |
| --- | --- | --- |
| SoC | ESP32-C3（riscv32），**无 PSRAM**、仅 BLE（无经典蓝牙） | `ai-passport/AGENTS.md` L31 |
| Flash | 8 MB，`dio / 80m` | `sdkconfig.defaults` L5 |
| 分区 | `nvs@0x9000/0x6000`、`phy_init@0xf000/0x1000`、`factory@0x10000/0x7f0000`（与 ai-passport 同布局，merge-bin 可从 0x0 整片刷） | `tesla-offline-ble/partitions.csv` |
| 控制台 | **USB-Serial-JTAG（C3 原生 USB，GPIO18/19）**；不能用 UART0（默认 TX=GPIO21 与背光冲突） | `sdkconfig.defaults` L11-13 |
| BLE 栈 | NimBLE **central-only**（`ROLE_PERIPHERAL/BROADCASTER=n`），`MAX_CONNECTIONS=1`，`ATT_PREFERRED_MTU=247`，host 任务栈 5120，`NVS_PERSIST=y`（配对/bond 落 NVS） | `sdkconfig.defaults` L18-29 |
| 加密 | mbedTLS 开 `ECP_C + SECP256R1`（P-256 ECDH 握手） | `sdkconfig.defaults` L31-33 |
| 时钟 | `CONFIG_FREERTOS_HZ=1000`（600 ms 等延时精度） | `sdkconfig.defaults` L16 |
| **任务栈** | **`tlb_worker` 必须 24576 B（16 KB 不够）**：`gcc -fstack-usage` 实测 `tlb_send_request 6240B` / `tlb_handshake 5936B` / `tlb_decode_frame 5632B`，最深链 ≈12.0 KB + 调用帧。12288 B 时 `bind` 必崩 `MCAUSE 0x1b`（栈保护 fault），现场可见 `0xa5a5a5a5` 空闲填充 | 真机崩溃现场 + `.su` 实测 |
| 板级其余 | **2026-10-03 起已使用**：面板 ST7789P3 240×320 RGB565 SPI + 背光 GPIO21（`key_ui.c` 经 bsp 点亮，背光 80%）、GPIO0 三键共用一路 ADC 分压（`BSP_BTN_MV_TABLE`：UP={0,150}mV / DOWN={150,447}mV / OK={447,1900}mV，`iot_button` 驱动）；电池未读取。「左上角开机」是硬件电源键，软件读不到。`EXTRA_COMPONENT_DIRS` 挂 `../ai-passport/components` 复用 bsp（**只复用，不改 ai-passport 仓**）；`managed_components\` 已随工程就位（LVGL 9.5 / esp_lvgl_port 2.9.0 / iot_button 4.2.0），构建无需联网 | `tesla-offline-ble/CMakeLists.txt`、`ai-passport/components/bsp`、`key_ui.c`/`app_main.c` |
| LVGL 配置 | `sdkconfig.defaults` 新增段：`CONFIG_LV_COLOR_DEPTH_16=y`、montserrat 14/20、**`CONFIG_LV_MEM_SIZE_KILOBYTES=24`**。⚠ 坑：旧 `sdkconfig` 里该值为 **0**（LVGL 对象池为零，`lv_obj_create` 真机必崩）→ 已删 `sdkconfig` 重配重编，生成的 `build\config\sdkconfig.h` 实测 =24 | `tesla-offline-ble/sdkconfig.defaults` |
| **Wi-Fi 共存内存（2026-10-09 实测钉死）** | **BLE+WiFi 装不下**：BLE 栈（controller + NimBLE host + worker 24 KB + link 8 KB 栈）吃掉 ~105 KB，界面就绪后空闲 111,600 B → 热点启动前仅剩 6,004 B（最大块 4,096 B），`esp_wifi_init` 必 `ESP_ERR_NO_MEM`。对策=**配网模式根本不启蓝牙**（§0 2026-10-09 行），VIN 存好靠重启切换。另 sdkconfig 已关 `CONFIG_ESP_WIFI_IRAM_OPT`/`CONFIG_ESP_WIFI_RX_IRAM_OPT` —— C3 上 IRAM 与 DRAM 是同一块物理 RAM，这两项吃 ~70 KB，是 `alloc pm_beacon_offset fail` 主因 | 堆探针实测 + 真机串口日志 |

---

## 2. 本地环境：全部路径与命令（Windows / PowerShell）

> **📌 路径口径（2026-10-08 定）：本文件所在目录就是仓库根，本文所有路径都是相对它的相对路径，不写盘符。** 换电脑、换盘符，命令一个字都不用改。
> 开工只有两步：① 在仓库根（本文件所在目录）打开 PowerShell；② 激活 ESP-IDF。激活后 `idf.py` / `python` / `esptool.py` 都在 PATH 里，**IDF 装在哪、哪个盘、Python 3.11 还是 3.13，都不需要写进任何命令**。

**环境引导（每个新窗口一次）**

```powershell
. <你的 IDF 目录>\export.ps1
```

- 报「找不到工具链」时先补一句：`$env:IDF_TOOLS_PATH = '<你的 IDF 目录>\tools'`（这套环境不是默认的 `~\.espressif`）。
- 自检：`idf.py --version` → `ESP-IDF v5.5.3`（tarball 平铺安装会显示 `v5.5.3-dirty`，属正常）；`esptool.py version` → `4.12.0`。

固定路径（**全部相对仓库根**）：

| 用途 | 路径 |
| --- | --- |
| 主工程 | `tesla-offline-ble\` |
| 构建目录 | `tesla-offline-ble\build\`（增量） |
| 主机测试脚本 | `tesla-offline-ble\tests\host\run.ps1` |
| 基线仓（只读禁区） | `ai-passport\`（`main/**` 绝不可动；`components/bsp` 被本工程复用） |
| 探针 | `tesla-ble-probe\` |
| 参考项目 | `ref-repos\{tesla-ble, vehicle-command, esphome-tesla-ble, tesla-key-esp32}` |
| **NVS 备份目录** | `nvs-backups\`（仓库内，已加 `.gitignore`；§7.8 步骤 0 有 mkdir） |
| 串口日志留档 | `logs\`（`.gitignore` 已忽略 `*.log`）。⚠ 正文作为历史证据引用的 `logs\*.log` 是旧机产物、不在仓库里，只当文字证据看 |
| ESP-IDF | **不在仓库内**，各机自装，版本必须 v5.5.3（工具链、Python venv 位置一律由 `export.ps1` 自己解析，别写进命令） |
| 串口会话脚本 | `tlb_cmd.py` / `probe_console.py` 是旧机散落脚本、**不在仓库内** → 手动流程一律用 `idf.py monitor` 人肉敲命令（§7.8 步骤 7）；要留档用 monitor 的 `Ctrl+T` `F` |

**国内镜像方案（GitHub 直连不通/极慢时的可用组合，已实证产物与基线逐字节一致）：**

1. IDF 主仓：克隆 Gitee 镜像 `https://gitee.com/EspressifSystems/esp-idf.git`（tag `v5.5.3`）；
2. submodule：Gitee 镜像缺多数子模块，改跑 `fetch-submodules.ps1`（历史脚本，不在仓库内），逐个从 `https://download.gitcode.com/github_archive/...` 或 `codeload.github.com/<owner>/<repo>/tar.gz/<sha>` 取 tarball 平铺进目录；
3. 工具与预编译 gcc：设 `$env:IDF_GITHUB_ASSETS = "dl.espressif.com/github_assets"` 后再 `install.ps1 esp32c3`，idf_tools.py 会把 github.com 前缀替换成 Espressif 自有 CDN。

**铁律（给 AI / 自动化工具看）：工具每次调用都是全新 shell，「激活 + idf.py」必须拼在同一条命令里**（人在自己的 PowerShell 窗口里不用拼，跑一次环境引导即可）：

```powershell
$env:IDF_TOOLS_PATH='<你的 IDF 目录>\tools'; . '<你的 IDF 目录>\export.ps1' | Out-Null; idf.py -C tesla-offline-ble build
```

其余动作把上面的 `build` 换成 `flash` / `app-flash` / `monitor` 即可（刷写要先按 §7.8 步骤 1 查到端口，拼成 `-p COMx`）。2026-10-08 实测构建 PASS：产物 `tesla-offline-ble\build\tesla-offline-ble.bin` = 1,303,056 B / `0x13e210`，factory 0x7f0000，84% free。

merge-bin（**唯一必须给绝对路径的地方**：esptool 的工作目录已经是 `build/`，相对 `-o` 会落到 `build\build\`。用 `$PWD` 现算，任何机器都不用改）：

```powershell
idf.py -C tesla-offline-ble merge-bin -o "$PWD\tesla-offline-ble\build\tesla-offline-ble-full.bin"
```

其它坑：本工具禁止 `cmd /c`；分件刷写偏移直接看 `tesla-offline-ble\build\flash_args`（0x0 bootloader / 0x8000 partition-table / 0x10000 app，`--flash_mode dio --flash_freq 80m --flash_size 8MB`）；`idf.py monitor` 与 `flash` 都独占串口，一次只能开一个；**`idf.py list-ports` 在本工程不可用**（2026-10-08 实测：它被转成 ninja 目标 `list-ports` → `ninja: error: unknown target`，还会顺带触发一次 CMake 重配），查端口用 §7.8 步骤 1 的一行式。

---

## 3. 固件架构（tesla-offline-ble）

```
application/main
  ├─ app_main.c   入口：key_ui_start() → tlb_app_init() → tlb_console_start() → bsp_button_init()；
  │               按键映射表：右一=BSP_BTN_UP→RKE 1（上锁）、右二=BSP_BTN_DOWN→RKE 0→20（解锁+启动授权，
  │               worker 串行消费保序）、右三=BSP_BTN_OK→无操作；每次点击串口打「按下键=UP/DOWN/OK」供实机核对物理顺序
  ├─ key_ui.c/.h  LVGL 最小车钥匙界面（标题+spinner+主状态+副行+按键提示，150 ms lv_timer）。
  │               唯一数据源 = tlb_app_ui_snapshot()（原子量），绝不碰 BLE 状态机；LV_FONT_DECLARE(key_font_20/14)
  ├─ tlb_console.c esp_console REPL（USB-Serial-JTAG），命令→tlb_app_post 的薄映射层 + wipe_legacy 直操 NVS，见 §7.6
  ├─ vin_cfg.c/.h 无 VIN 时的配网热点（2026-10-09）：SoftAP（AI-PASSPORT-TSL / 87654321 / 192.168.4.2）+ 配网页（esp_http_server，
  │               12 URI，max_uri_handlers=16/栈 3072）+ DNS 门户（自建 UDP:53 全劫持 + DHCP 选项 114 + 10 个探测路径 302）；
  │               保存 VIN → 写 NVS → 延时 2 秒 esp_restart()；**配网模式蓝牙栈不启动**（内存所限，见 §1 Wi-Fi 共存内存行）
  └─ tlb_app.c    （~1260 行）worker 任务 + 命令队列 + 独立 link 自动重连任务；**2026-10-03 起固定 2 秒轮询**：
                  定向扫描 2 s → 全量扫描 2 s → 等 2 s 再下一轮（退避档位 k_retry_steps_ms 已删）；
                  connect → 停扫 → delay(600) → 发现服务 → 订阅 0x0213(INDICATE) → 协商 MTU；TIB（BLE security initiate + NVS bond）；
                  新增 tlb_app_ui_snapshot() + s_ever_connected/s_rke_* 快照量；探针全部中文文案逐字复现；
                  **2026-10-09 配网分流**：tlb_app_init 无 VIN 时置 s_cfg_mode、只 vin_cfg_start() 后直接 return（不启 BLE 栈/worker/link），
                  VIN 存 NVS 后重启进正常模式；AP 失败上屏「AP启动失败 见串口」
assets/fonts/key_font_20.c / key_font_14.c —— tools/gen_key_font.py 生成（lv_font_conv@1.5.3 + simhei.ttf，136 字形子集）
components/tesla_ble     —— IDF 侧
  ├─ tlb_ble.c           NimBLE central 主机（扫描/连接/GATT/帧收发，2460 行）
  ├─ tlb_nvs_store.c     档案 + counter + bond 的 NVS 持久化（340 行）
  └─ tlb_port_esp.c      端口适配：延时/随机数（esp_random.h）/日志
components/tesla_core    —— 纯 C，零 IDF 依赖，主机可测（13 模块）
  ├─ tlb_sha / tlb_aes / tlb_identity   密码学原语 + P-256 密钥身份
  ├─ tlb_pb / tlb_msg                   手写 protobuf wire 编解码 + 报文构造/解析（金标准对象）
  ├─ tlb_v3 / tlb_frame                 V3 会话（AES-GCM-Personalized）+ 2B 大端长度帧
  ├─ tlb_bind                           白名单绑定流程
  ├─ tlb_dispatch                       命令派发/重试（RETRY_STEPS_MS）/KNOWN_RKE={0,1,20,29,30}
  └─ tlb_store / tlb_text / tlb_meta    存储抽象 / 中文文案表 / 元数据
```

**修改红线**：应用区只允许动 `application\main\{CMakeLists.txt, tlb_app.c, tlb_console.c, app_main.c, key_ui.c, key_ui.h, vin_cfg.c, vin_cfg.h}`、`assets\fonts\key_font_*.c`（由 `tools\gen_key_font.py` 再生成，勿手改）与 `components\**` 的必要定点小修；**绝不碰** `ai-passport\main\**`（bsp 只复用不修改）；探针与 ref-repos 只读。

**日志规则**：BLE 失败**只以中文文本呈现，绝不出现数字错误码**；所有文案逐字来自探针（`tlb_text.c` 为文案表）。

---

## 4. 车辆连接参数（内置目标车常量已于 2026-10-03 删除）

| 项 | 值 |
| --- | --- |
| ~~VIN / MAC / 地址类型~~ | **已从代码删除**（原 `tlb_app.c` 的 `TLB_TARGET_VIN / TLB_TARGET_MAC / TLB_TARGET_ADDR_TYPE` = `FAKEVIN000000001` / `11:22:33:44:55:66` / type 1）。三个值都是**别辆车**的占位数据；旧逻辑「NVS 无档案就播种一份内置目标车」会把假身份写进 NVS，污染 `active_vin()` 与广播名匹配。现在**身份一律来自 NVS**（绑定档案 + 手输 VIN），播种分支已删 |
| GATT | Service `00000211-b2d1-43f0-9b88-960cebf8b91e`；写 `0212`；**INDICATE** `0213`；读通信版本 `0214` |
| 帧格式 | **2 字节大端长度前缀 + protobuf 报文**，收包必须按前缀做粘包/半包重组 |
| 换车 | `vin <新 VIN>`（或 `connect <新 VIN>`）写进 NVS 即可，**不需要改代码重刷**；代价是无 VIN 时 `active_vin()` 返回空串（见 §0 行为变更） |

### 4.1 实测在场车辆（2026-10-03 真机；与旧硬编码值不一致 → 已据此删除常量）

| 项 | 实测值 |
| --- | --- |
| VIN | **`5YJ3E1EA7KF000000`** |
| 广播名 | **`See13c959535a3b7dC`** —— 老车规则 `S`+SHA1(VIN)hex 前 16 位，尾缀 `C`；命中档位为 **loose-prefix**（非 exact/prefix 原文） |
| `peer_addr` | **`AA:BB:CC:DD:EE:FF`**，`peer_addr_type=`**`0`（public）** |
| MTU | 协商到 **247**（单包载荷上限 244 B，实测 RKE 帧 183 B 一包放下） |
| 扫描参数 | `scan_itvl=288 scan_window=96`（单位 0.625 ms） |
| 板端设备密钥 | `keyId=deadbeefcafebabe0123456789abcdef01234567`，串口显示 **`keyId=DE:AD:BE:EF`**（= SHA1(公钥) 前 4 字节） |

**结论（2026-10-03 已按此改代码）：本车广播用 public 地址（type 0），而旧固件所有按 MAC 的定向扫描都写死 type=1，因此 `TLB_CMD_CONNECT_AUTO` 对本车**永不命中**——每轮自动重连都白等一次 20 s 全量扫描，再退回广播名匹配（`handle_connect_vin`，[tlb_app.c](tesla-offline-ble/application/main/tlb_app.c)）。现在 `tlb_ble_scan_mac()` 支持哨兵 `TLB_BLE_ADDR_TYPE_ANY`（只认 MAC、不认地址类型，连接时用广播里实测到的类型），`auto_once()` 第 1 步改传该哨兵 → 实测开机 **t≈0.3 s 就按 NVS 档案里的 deviceId 命中并发起连接**（`logs\opt-verify-2.log`），自动重连从「≈30 s」缩到「≈1 s」。**仍未定论**：车辆 MAC 会不会轮换（§7.5 项 7）——一旦轮换 deviceId 直连失效，届时仍靠 `connect <VIN>` 名匹配兜底，所以名匹配路径不能删。

---

## 5. 已钉死的 wire 格式事实（字节级，勿再翻资料）

### 5.1 proto3 默认值省略（本项目最大的坑）
- singular 标量为 `0/false/空` 时不编码；但 **oneof 成员即使值为 0 也必须写 tag**。
- `UnsignedMessage.RKEAction` 是 **字段 2（oneof 成员）** → tag `0x10`，`UNLOCK=0` 的正确输出是 **`10 00`（2 字节）**，我方 `tlb_msg.c` L17 `tlb_wb_u32(&w, 2, action, true)` 与此一致，**2533 项主机金标准已覆盖，无 0x08 疑点**。
- `08 XX` 是 `CommandStatus.operationStatus`（字段 1）等别处样例，别混。

### 5.2 RoutableMessage（universal_message.proto）字段/tag
`to_destination=6(0x32)`、`from_destination=7(0x3a)`、oneof payload{`protobuf_message_as_bytes=10(0x52)`、`session_info_request=14(0x72)`、`session_info=15(0x7a)`}、`signedMessageStatus=12(0x62)`、oneof signature{`signature_data=13(0x6a)`}、`request_uuid=50(0x92 0x03)`、`uuid=51(0x9a 0x03)`、`flags=52(UINT32 0xa0 0x03)`。
书写顺序硬约束：**to→from→payload→signature_data→uuid→flags**（与 nanopb FIELDLIST 声明序一致，tlb_msg.c 已对齐）。
`Destination` oneof：`domain=1(UENUM)` / `routing_address=2(bytes 16)`；`Domain{VEHICLE_SECURITY=2, INFOTAINMENT=3}`；`SessionInfoRequest{public_key=1(≤65B), challenge=2(≤32B，我方不写)}`。

### 5.3 signatures.proto
- `SignatureData`：`signer_identity=1(msg)`；oneof：`AES_GCM_Personalized=5`、`session_info_tag=6`、`HMAC_Personalized=8`、`AES_GCM_Response=9`。
- `AES_GCM_Personalized_Signature_Data`：`epoch=1(FIXED16)`、`nonce=2(FIXED12)`、`counter=3(varint)`、`expires_at=4(fixed32 0x25)`、`tag=5(FIXED16 0x2a)` → 内层字节 `0x0a 16B / 0x12 12B / 0x18 varint / 0x25 4B / 0x2a 16B`。
- `KeyIdentity`：`public_key=1(bytes ≤65)`、`handle=3`。
- `SessionInfo`：`counter=1`、`publicKey=2(≤65)`、`epoch=3(FIXED16)`、`clock_time=4(fixed32)`、`status=5(UENUM：OK=0, KEY_NOT_ON_WHITELIST=1)`、`handle=6`；`GetSessionInfoRequest{key_identity=1}`。

### 5.4 vcsec.proto（绑定与 RKE 内层）
- `ToVCSECMessage.signedMessage=1(0x0a)`；`SignedMessage{protobufMessageAsBytes=2(0x12), signatureType=3(0x18)}`；`SIGNATURE_TYPE_PRESENT_KEY=2`。
- `UnsignedMessage` oneof：`InformationRequest=1`、`RKEAction=2`、`closureMoveRequest=4`、`WhitelistOperation=16(0x82 0x01)`。
- `WhitelistOperation` oneof：`addKeyToWhitelistAndAddPermissions=5(0x2a)`、`metadataForKey=6(0x32, KeyMetadata{keyFormFactor=1})`。
- `PermissionChange{key=1(VCSEC_PublicKey{PublicKeyRaw=1 bytes 65}), secondsToBeActive=3, keyRole=4}`；`Keys_Role{SERVICE=1, OWNER=2, DRIVER=3, GUEST=8}`；`KeyFormFactor{NFC_CARD=1, IOS=6, ANDROID=7, CLOUD=9}`。
- `RKEAction_E{UNLOCK=0, LOCK=1, REMOTE_DRIVE=20, AUTO_SECURE_VEHICLE=29, WAKE_VEHICLE=30}`（29/30 与车辆固件版本相关）。**明文载荷（真机已验，探针 `run.mjs` L767-774 同源）：`UNLOCK(0)→1000`、`LOCK(1)→1001`、`REMOTE_DRIVE(20)→1014`。⚠ 20 是「驾驶授权」，不是上锁；解锁后挂不上挡要靠它，与 UNLOCK 是两条独立命令。**
- `FromVCSECMessage` oneof：`vehicleStatus=1, commandStatus=4, whitelistInfo=16, whitelistEntryInfo=17, nominalError=46`；`WhitelistOperation.status{signerOfOperation=2(KeyIdentifier{publicKeySHA1=1}), operationStatus=3}`。
- `PermissionChange.permission` 是 packed repeated：`10 04 02 01 04 03`（LOCAL_DRIVE=2, LOCAL_UNLOCK=1, REMOTE_DRIVE=4, REMOTE_UNLOCK=3）。

### 5.5 会话/加密与 counter
- V3 加密命令：`AES-128-GCM(key = SHA1(ECDH_x)[:16] 派生体系, 密文进 protobuf_message_as_bytes, tag 进 signature_data.AES_GCM_Personalized)`——权威细节以 `ref-repos/tesla-ble/src/{crypto_context,message_builders}.cpp` 与主机金标准为准。
- **counter 单调递增、不可回退**：nonce/counter 倒退触发 `FAULT_IV_SMALLER_THAN_EXPECTED` / `FAULT_TOKEN_AND_COUNTER_INVALID`，对同一把已绑定 key **永久性**，只能重新绑定 → **刷机清 NVS = 必须重新绑卡**（见 §7.2 风险）。
- **真机已验（2026-10-03）**：同一会话内 `握手 counter=0 → RKE counter=1` 车端接受并回加密响应（GCM tag 校验通过）；第二次会话（复位后重新握手）`RKE counter=2` 同样被接受，**全程未出现 `FAULT_IV_SMALLER_THAN_EXPECTED`**。跨复位后**绑定态**确认保住（`keyId`/白名单不变）；**counter 的跨会话基线口径尚未定论，勿据此改持久化逻辑**（见 §7.5 项 8）。

### 5.6 BLE 三条铁律（已在 tlb_app.c/tlb_ble.c 实现）
A. 连上立刻停扫；B. 所有 write 串行队列（绝不在回调里再 write）；C. MTU 抬到 ≥ 帧长+3（247 优先）。

### 5.7 真机钉死的两条口径（2026-10-03，勿再翻资料）

**A. mbedTLS 3.x 的 `mbedtls_ecp_mul` 绝不允许 `f_rng == NULL`。**
`components/mbedtls/mbedtls/library/ecp.c` 里 `mbedtls_ecp_mul_restartable()` **入口**就是：

```c
if (f_rng == NULL) {
    return MBEDTLS_ERR_ECP_BAD_INPUT_DATA;   // -0x4F80
}
```

`mbedtls_ecp_mul()` 只是转调它（`rs_ctx=NULL`）。所以只要传 NULL RNG，**连纯量乘法都不会开始**，一律 `-0x4F80` —— 与私钥是否 `≥ n`、对端点是否合法**无关**（那两类失败发生在进入内部实现之后，返回 `INVALID_KEY = -0x4F60`）。ECDH 盲因子只做侧信道随机化，归一化后的仿射 X 逐字节不变，因此补 `f_rng` **不改变任何输出**，与 JS 探针 `p256.js:deriveSharedSecret` 仍然一致。
据此：`tlb_port_esp.c` 的 `tlb_port_ecdh()` 现传 `tlb_rng`（ESP 硬件随机）；`tlb_port_keygen()` 本来就带 `tlb_rng`，一直能成功——这正是当初定位根因的反证。
另两条已被排除的猜想（别再试）：`R == P` 原地乘在 **非 restartable** 配置下安全（`ecp_mul_comb` 先用 P 预算 T 表再覆写 R，且 `should_free_R = (ret != 0)`）；本工程 `sdkconfig` 为 `# CONFIG_MBEDTLS_ECP_RESTARTABLE is not set` + `CONFIG_MBEDTLS_MPI_USE_INTERRUPT=y`。
`tlb_dispatch.c` L1315 那句「对端公钥不在 P-256 曲线上」是**刻意**对齐探针 `e.message` 的偏离文案，别改（改了破坏金标准）；真实原因看 port 层的 `ECDH 点乘失败 -0x%04x`。

**B. 串口帮助文案必须逐字来自权威枚举表，绝不凭印象写。**
`tlb_console.c` 曾把 rke 动作写成「1=解锁 20=上锁 29=开后备箱 30=充电口」，全部错误。权威口径只有两处：[tlb_text.c](tesla-offline-ble/components/tesla_core/src/tlb_text.c#L137-L144) 的 `E_RKE` 与 [tlb_types.h](tesla-offline-ble/components/tesla_core/include/tesla_core/tlb_types.h#L96-L102)。
**后果不是文案问题**：我照着它向用户出题「rke 20（上锁）」，取得授权后实发了 `REMOTE_DRIVE` —— 一次被污染的授权。凡对外报「将执行什么动作」，必须回查枚举表与载荷十六进制（`1014` ≠ 上锁），并以车端回显的 `RKE_ACTION_*` 名称为准。
**闭环状态**：修复版已在 2026-10-03 经授权烧录上板（`0xa87e0` = 690,144 B），板上实跑 `rke`（无参）回显 `0=解锁 1=上锁 20=驾驶授权(RemoteDrive) 29=自动落锁 30=唤醒`，与 `tlb_text.c`/`tlb_types.h` 逐字一致；随后按正确语义补发 `rke 1`（车端回显 `RKE_ACTION_LOCK(1)`、明文密文段解出 `1001`）并受理成功。

**C. 表外 RKE 动作号一律硬拒（2026-10-03 加，已实机验证）。**
闸门有两道，语义相同：console 层 `cmd_rke` 先拦（即时反馈，`tlb_console.c`），`tlb_app.c:handle_rke()` 再拦（**权威闸门**：不在表内直接 ERROR + `return`，旧版只 WARN 却照发）。单一事实源是 [tlb_rke_action_known()](tesla-offline-ble/components/tesla_core/include/tesla_core/tlb_types.h)，新增动作号只改这一处（`tlb_console.c`/`handle_rke` 都调它，别再抄字面量）。同时 `handle_rke` 在下发前打**审计行**「即将下发 <枚举名> 明文=<hex>」，LOCK 的明文帧就是 `1201`。刻意**不提供 force 逃生开关**：表外值本无官方定义，加开关只会扩大误发面。实测 `rke 7` → `rke: 7 不在官方 RKEAction_E 白名单(0/1/20/29/30)，已拒绝下发`，且串口之后无任何 BLE 写入。

**D. `1283` 不是「未知蓝牙栈错误」，是车端拒绝配对。**
`1283 = 0x503 = BLE_HS_ERR_SM_PEER_BASE(0x500) + BLE_SM_ERR_AUTHREQ(0x03)`（`host/ble_hs.h` 的错误码分段 + `host/ble_sm.h` 的 SMP 枚举，两者都是 IDF 头文件里的权威定义）。即 **SMP 对端（车辆）以「Authentication Requirements」为由拒绝**。`tlb_ble.c:rc_text()` 现按分段解码并输出中文，实机日志：`[warn] 配对/加密未成功: 车辆拒绝配对：认证要求无法满足(Authentication Requirement) errCode=10008`（>64 字节，两处 `char t[]` 已提到 160 才不被截断）。**判读要点**：新文案只含 `errCode=10008`，不含 `property not support`/`errcode=10007`，因此不会误触 `is_property_reject` 的换写法分支。

---

## 6. 验证：跑什么、怎么跑

### 6.1 ESP-IDF 固件构建（2026-10-08 实跑 PASS）
§2 首条命令。全量约 2063 个目标；已知良性警告仅 1 条：`tlb_ble.c` L105 `#define LINE_MAX 2600` 与 newlib 重定义 —— 无害勿动。

### 6.2 主机金标准/对抗测试（**2026-10-09 实跑 PASS：2547 checks / 0 failed**）
```powershell
powershell -ExecutionPolicy Bypass -File tesla-offline-ble\tests\host\run.ps1   # 相对仓库根；可加 -Regen 重生成 goldens
```
（脚本用 `$PSScriptRoot` 自定位、不依赖绝对路径，任何机器可直接跑。）
- `tools\gen_goldens.mjs`（Node）生成 `tests\host\goldens.h`；`test_core.c` + `tlb_port_host.c` 与全部 `tesla_core/src/*.c` 用 gcc `-std=c11 -Wall -Wextra -Werror` 编译。
- **改了 `tesla_core` 任何编解码必须重跑此测试**；改动报文格式时先 `-Regen` 核对金标准来源。
- 本轮改动只涉及 `tesla_ble`（IDF 侧，含 `tlb_port_esp.c` 的 ECDH `f_rng` 修复）与 `application\main`，`tests\host` 不编译 `tlb_nvs_store.c`/`tlb_ble.c`/`tlb_port_esp.c`（主机侧 ECDH 走 `tlb_port_host.c` 自己的实现，不经 mbedTLS）→ **金标准不受影响**，但收尾前应补跑一次（gcc 已就位，无需再装）。

### 6.3 探针 JS 自测（历史实测；node 可用，未重跑）
```powershell
cd tesla-ble-probe        # 相对仓库根
node tests\run.mjs        # 519 passed, 0 failed
node tests\vue-check.mjs  # 页面脚本自检 全部通过 (17 个)
```

### 6.4 参考仓 C++ gtest（遗留任务，当前跑不了）
- 目标：在 `ref-repos\tesla-ble\tests\` 增 `test_tlb_message_builders.cpp`（用 nanopb `pb_encode` 钉 §5 金标准）并追加进 `tests\CMakeLists.txt` 的 `TEST_FILES`（旧机上该表列 17 个文件且磁盘齐全）。
- **阻塞现状（2026-10-08 更新）**：`ref-repos\` **已在仓库内**（§10 的「缺失」记录作废），源码可翻；真正缺的是 docker（见下条）→ 本节容器 gtest 仍属「未开始」。
- 容器 `test_tesla_ble`（repo 挂载 `/workspace`）内：`cmake -B build -DCMAKE_MESSAGE_LOG_LEVEL=ERROR && cmake --build build -j`，`cd build && ctest -j`。
- **阻塞**：`docker` 命令不存在。要么装 Docker Desktop 后继续，要么此项降级为「已由 §6.2 主机金标准覆盖」直接放弃。

### 6.5 ai-passport 旧仓门禁
`tools/validate.sh` 在当前环境不可用（WSL 无发行版、无 gcc），等价用 MSVC `cl /W4 /WX`；旧 UI 测试（state 10 / wizard 11 / layout 5 组）属于历史阶段，现阶段与 BLE 固件无关，**不要去动那个仓**。

---

## 7. 硬件调试（当前阶段 —— 操作手册）

### 7.1 设备与串口现状
- **板子身份**（MAC `98:c3:77:f4:9e:04`，QFN32 rev v1.1，8 MB XMC flash，40 MHz 晶振）：PnP 里叫 `USB JTAG/serial debug unit`，实例 ID `USB\VID_303A&PID_1001...`。**认设备靠这个 VID/MAC，不靠端口号** —— 端口号随电脑、随插入的 USB 口而变（历史见过 COM3、COM4），机器上还可能挂着别的串口（例如手机调制解调器）。**所以本文命令一律写 `COMx`，每次按 §7.8 步骤 1 现查再填，绝不凭记忆抄号。**
- 板子**未插 USB 时一个串口都不会枚举**（实测：`[System.IO.Ports.SerialPort]::GetPortNames()` 返回空，PnP 里设备状态 `Unknown`）→ 烧录前先插数据线（不是纯充电线）。
- USB-Serial-JTAG 下 esptool.py v4.12.0 用 `--before=default_reset --after=hard_reset` **自动复位，全程无需按 BOOT 键**（C3 原生 USB，没有 UART 桥，也就不存在「按住 BOOT 再上电」那套）。
- `flash` 与 `monitor` 都吃同一个 `COMx`：**同一时刻只能有一个占用**，脚本化驱动 REPL 时先停掉 monitor。
- 分区实测：`nvs@0x9000/0x6000`、`phy_init@0xf000/0x1000`、`factory@0x10000/0x7f0000`。

### 7.2 刷机流程（**未经用户明确授权绝不烧录**；用户自己动手的逐步 SOP 见 §7.8）
1. §2 激活命令拼好 `-p COMx flash`（分件刷写，偏移见 `tesla-offline-ble\build\flash_args`）。注意 `monitor` 与 §7.6 的 pyserial 脚本互斥 —— 都独占同一个 `COMx`，一次只能用一个。
2. **风险告知（必须向用户复述）**：整片/擦除刷写会清 NVS → **已绑定的车钥匙白名单条目、会话 counter、bond 全部作废**；counter 不可回退意味着刷回旧固件会从「重新绑卡」重来（需实体 NFC 卡在场）。
3. **刷前先只读备份 NVS**（`nvs@0x9000`，长 `0x6000`）：

```powershell
python -m esptool --chip esp32c3 -p COMx --baud 921600 --before default_reset --after hard_reset read_flash 0x9000 0x6000 "nvs-backups\nvs-<时间戳>.bin"
```

4. 交付报告分四段：Build / Host tests / Device tests / Unverified。

**历史执行记录**：首次刷写前已备份 `nvs-20261002-134822.bin`（内容为 ai-passport 旧数据，无任何特斯拉钥匙/bond/counter）；修复后二次备份 `nvs-after-fix.bin` 出现 `tesla_ble` 命名空间，证明落盘成功且旧命名空间未被擦除。分件刷写只覆盖 0x0/0x8000/0x10000，**不动 0x9000 的 NVS**。

**第三次刷写（2026-10-03，`Wrote 690112 bytes`，修 ECDH `f_rng`）**同样走分件刷写，**已实机反证 NVS 未被破坏**：刷写前完成的本车绑定条目在刷后依然有效（串口回显 `keyId=DE:AD:BE:EF`、`probe` 判「已在白名单」、握手两域 `OK` 且 counter 从 0 递增到 1 未回退）。→ 结论：**只要不用 `erase-flash`/整片 `write_flash 0x0`，分件刷 app 不会丢钥匙**。

**第四次刷写（2026-10-03，`Wrote 690144 bytes (386309 compressed)`，`tlb_console.c` 文案修复）**再次走同一条分件命令（擦除区间仅 `0x0-0x5fff`、`0x8000-0x8fff`、`0x10000-0xb8fff`，**`0x9000` 的 NVS 未被触碰**）。刷后串口会话实测：`keyId=DE:AD:BE:EF` 仍正确、档案 deviceId 自动重连命中 `See13c959535a3b7dC`、新 help 文案生效 → **连续两次分件刷写均无损绑定态，§7.2 第 2 条的「风险复述」对分件刷 app 可简化为「NVS 不动，但刷前照旧备份」**。

**第五次刷写（2026-10-03，`Wrote 691776 bytes`，四项优化：RKE 白名单闸门 / deviceId 直连 / SMP 错误码可读化 / counter 可观测性）**同一条分件命令，擦除区间依旧不含 `0x9000`。刷后两次串口会话实测：`keyId=DE:AD:BE:EF` 与档案 deviceId 完整保留、`盘上counter=1`（VCSEC）/`0`（车机域）与 boot 的 `已恢复 VCSEC 会话 counter=1` 一致 → **连续三次分件刷写无损绑定态与 counter，§7.2 第 2 条的风险复述对「只刷 app」可固定为一句话：不碰 0x9000，刷前照旧备份。**

**第六次刷写（2026-10-03，已授权，`Wrote 691776 bytes (387076 compressed) @0x10000`）**：修 SMP 中文文案被 `char t[64]` 截断（`tlb_ble.c` 两处 → `t[160]`），产物字节数与第五次相同（只改栈缓冲）。走 `idf.py -p COM3 flash`（只写 `0x0`/`0x8000`/`0x10000`，**`0x9000` 的 NVS 未被触碰**）。刷前备份 `nvs-before-flash6-20261003-022401.bin`。刷后实机核对：`配对/加密未成功: 车辆拒绝配对：认证要求无法满足(Authentication Requirement) errCode=10008 —— 继续按未加密链路尝试` **完整不截断**，且 `keyId=DE:AD:BE:EF`、档案 deviceId、`盘上counter=1` 全部保留 → **连续四次分件刷写无损绑定态**。日志：`nvs-backup-flash6.log`、`flash-opt-2.log`、`opt-verify-3.log`。

**⚠ 关于「清除硬件上的旧东西」（2026-10-03 只读勘查结论，尚未执行任何破坏性操作）**：

- 旧东西**只有一处是真的**：NVS 里的 `trae_cfg` 命名空间（`profile` blob 245 B，内容含 `FoloToy`/`NETRUNNER`/`avatar-01`）—— 旧 ai-passport 应用的配置。我们的固件从不读它，**功能上完全无害**，属卫生问题。
- **固件本体不含旧代码**（指第六次刷写的 691,776 B 无头版）：map 文件证实 lvgl / esp_lvgl_port / esp_codec_dev / button 四个组件**被链接进产物的对象数 = 0**，691,776 B 全是特斯拉链路代码。`managed_components\` 里的这些目录当时只是仓库残留（不影响产物）。⚠ 2026-10-03 车钥匙化起 LVGL/esp_lvgl_port/iot_button/bsp **被刻意链接**进新产物（1,135,040 B），本条仅对第六次刷写成立。
- NVS 里搜到的别辆车 VIN/MAC 全在状态 `Erased` 的历史条目里，不是活数据。
- **代价（必须让用户知道）**：`erase_flash` 或擦 `0x9000` 都会一并销毁 `tesla_ble:key`(128 B 密钥对)/`bind`/`v3_*`/`vin` → **设备立刻不再是已绑定钥匙，必须回到车边、带实体 NFC 卡重新 `bind`**（§7.3 步骤 5 流程，已验证可做，但需要人和卡在场）。而且车端白名单里会**留下旧 keyId `DE:AD:BE:EF` 的失效条目**（`forget` 只清本地 NVS，删不掉车端记录），反复重绑会在车上堆积僵尸钥匙项。
- ~~因此推荐时序：等下次人和 NFC 卡都在车边时，再一次性做「整片擦除 → 重刷 → 重绑 → 复验」~~
- **2026-10-03 定案+已执行（用户拍板：不清除整片，定向清除）**：用户判断车端蓝牙白名单有数量上限、重绑会堆僵尸条目 → **否决整片擦除**。改为**定向清除**：固件 `wipe_legacy` 命令（`tlb_console.c`），只 `nvs_open("trae_cfg") → nvs_erase_all → nvs_commit`，**绝不碰 `tesla_ble`/`nimble_bond`/`phy`**；幂等可重跑。**2026-10-03 22:39 已执行成功**（第 12 次刷写后、板子插电脑时经用户确认）：回显「已清除 trae_cfg（旧 AI工牌配置）；tesla_ble 绑定与配对信息未动」；执行前备份 NVS `nvs-backups\nvs-before-wipe-20261003-223921.bin`（24576 B）；冷启动复验 keyId `deadbeef…`/档案/VIN…000000 全部完好。**至此「只保留特斯拉的程序」达成：旧固件本体已被覆盖 + 唯一残留 `trae_cfg` 已清。**

### 7.3 上机验证顺序（Device checklist，照此推进）

**进度（2026-10-03，实车 `5YJ3E1EA7KF000000` + 实体 NFC 卡在场）：1-3、5-7 PASS；4 FAIL（BLE 层加密链路未通，不影响应用层）；8 部分验（重启 counter 不回退已定论，见 §7.5 项 8）。**

**2026-10-09 配网热点冒烟（第 25 次刷写后，串口实测 PASS）**：无 VIN 开机 → 纯配网模式（蓝牙栈未启动）→ `开热点前堆: 空闲内部=97812 最大内部块=86016` → softAP 起 → `DHCP server started ... IP: 192.168.4.2` → `DNS 已监听 :53` → `配网热点已开启：AI-PASSPORT-TSL` → REPL 就绪，无 panic/警告（日志：`logs\peek.log`）。**手机侧「门户弹窗 → 填 VIN → 保存重启」全流程待用户实测**。

**四项优化实机复验（第五次刷写，2026-10-03）**：①RKE 白名单闸门 —— `rke 7` 被 console 层拒绝、零 BLE 写入；②deviceId 直连 —— 复位后 t≈0.3 s 按 MAC 命中并发起连接；③SMP 错误码可读化 —— 新文案生效（但 64 B 栈缓冲截断，已修待第六次刷写）；④counter 可观测性 —— `status` 回显盘上 counter。证据：`logs\opt-verify-1.log`、`opt-verify-2.log`。

> **⚠ 顺序纠正：本车实测必须「先 `bind` 后 `handshake`」**（原卡把会话握手写在绑定之前，是错的）。未绑定时握手拿不到可用会话，`probe` 也只会报「没有 session_info_tag」；绑定成功后再握手才两域全 `OK`。

| # | 步骤 | 实机结论 |
| --- | --- | --- |
| 1 | 冒烟 | **PASS**。启动日志正常、无 panic；`tlb_worker` 栈 24576 后 bind 全程 150 s 窗口零崩溃 |
| 2 | 扫描 | **PASS**。VIN 名匹配命中 `See13c959535a3b7dC`（loose-prefix 档）；**deviceId 直连现已可用** —— 第五次刷写把连接判据改成 `TLB_BLE_ADDR_TYPE_ANY` 后，复位后 t≈0.3 s 就按 NVS deviceId（`AA:BB:CC:DD:EE:FF`，type 0）命中并发起连接（旧「硬编码 MAC 路径对本车无效」的结论已随常量删除而失效，§4.1） |
| 3 | 连接 | **PASS**。connect → 停扫 → 服务发现 `0211` → 订阅 `0213` INDICATE → MTU **247**；粘包按 2B 大端前缀重组正常（车辆连推 `320208003a0208025203e00201` 等状态帧均正确解出） |
| 4 | TIB/bond | **FAIL（未阻塞主线）**。security initiate 报 `蓝牙栈错误 1283 errCode=10008`（第五次刷写后改为可读文案：`车辆拒绝配对：认证要求无法满足(Authentication Requirements) —— 继续按未加密链路尝试`，判读见 §5.7D：`1283 = 0x503 = BLE_HS_ERR_SM_PEER_BASE + BLE_SM_ERR_AUTHREQ`），全程走未加密 BLE 链路；V3 应用层加密照常工作 → 记录为后续项，别把它当握手前提 |
| 5 | 绑定 | **PASS**。明文 `WhitelistOperation(addKey, PRESENT_KEY)` → 车端**直接回终态** `WHITELISTOPERATION_INFORMATION_NONE(0)`（没经过 `WAIT(1)`），同时车辆主动上报帧含 `12060a04deadbeef`（= 板端 keyId 前 4 字节）；绑后 `probe` 给出正确结论：`本机已有可用 V3 会话（counter=0），说明钥匙已在白名单` |
| 6 | 会话握手 | **PASS**。修 ECDH（§5.7A）后两域全成功：`DOMAIN_VEHICLE_SECURITY(2)` epoch `9b0b15d65644a8054b22793f13ae2f82`、`DOMAIN_INFOTAINMENT(3)` epoch `2728d126ad1d16d4eae4879575c67645`，均 `SESSION_INFO_STATUS_STATUS_OK(0)`；`status` = `BLE=connected \| keyId=DE:AD:BE:EF \| VCSEC=1@ready \| 车机=0@ready` |
| 7 | RKE | **PASS（2026-10-03 二次复验，动作号正确）**。发 `rke 1` → 车端回显 `RKE_ACTION_LOCK(1)`，密文段 2 B 解出明文 `1001`（= LOCK），发 183 B 加密帧（`counter=2`、nonce `5086bb68a36b01b2affe552f`）→ 车回 83 B **加密响应** → GCM 校验通过、解密为空 payload → `[ok] 完成：空响应（车辆已受理）`，随后车辆连推状态帧 `320208003a0208025203e00201`/`…e00202`。**首次尝试（`rke 20`）因 console 文案错误实为 `REMOTE_DRIVE`/`1014`，事故与闭环见 §5.7B** |
| 8 | 鲁棒性 | **部分 PASS**。「重启 → counter 不回退」**已定论**（NVS 持久 counter 跨刷写与复位都不回退，双证见 §7.5 项 8）；断电/拉黑距离 → 自动重连、重复绑定幂等 **仍未验** |

**RKE 三个动作号的实机往返（2026-10-03 02:27-02:30，第六次刷写后，逐条单独授权 §8.3）**：

| 命令 | 审计行 | 明文 | 车端 counter | 结果 |
| --- | --- | --- | --- | --- |
| `rke 1` | `即将下发 RKE_ACTION_LOCK(1) 明文=1001` | `10 01` | 3 | `[ok] 空响应（车辆已受理）` |
| `rke 0` | `即将下发 RKE_ACTION_UNLOCK(0) 明文=1000` | `10 00` | 4 | `[ok] 空响应（车辆已受理）` —— **首次实机** |
| `rke 20` | `即将下发 RKE_ACTION_REMOTE_DRIVE(20) 明文=1014` | `10 14` | 5 | `[ok] 空响应（车辆已受理）` |

三条都是「未握手 → 自动补一次 VCSEC 握手 → 发指令」，握手响应恒为 `SESSION_INFO_STATUS_OK(0)`，epoch 始终是 `9b0b15d65644a805…`（**同一会话 epoch 未变，车辆公钥 `04aec8cf46b1fdfb…` 三次一致 → §7.5 项 2「车辆公钥是否轮换」本轮仍无变化证据**）。盘上 counter 随之 1→2→3→4 递增并落 NVS。无任何 `FAULT_*`/`GENERICERROR_*`。日志：`rke-lock-3.log`、`rke-unlock-1.log`、`rke-drivenote-1.log`。

日志留档（全在 `logs\`）：`handshake-2.log`（时序抢跑，非固件 bug）、`handshake-3.log`（两域握手成功）、`rke-lock.log`（实为 REMOTE_DRIVE 往返）、`rke-lock-2.log`（真正的 `LOCK(1)` 往返 + 新 help 文案生效）、`build-opt-1.log` / `build-opt-2.log`（四项优化与截断修复的构建）、`flash-opt-1.log` / `flash-opt-2.log`（第五、六次刷写）、`opt-verify-1.log`（① RKE 闸门 + ④ counter）、`opt-verify-2.log`（② 直连 + ③ SMP 文案，含 boot 全日志）、`opt-verify-3.log`（第六次刷写后截断修复复验）、`rke-lock-3.log` / `rke-unlock-1.log` / `rke-drivenote-1.log`（三条 RKE 实机往返）、`nvs-backup-flash6.log` + `nvs-dump-flash6.txt`（第六次刷写前备份与 NVS 全量清点）。

实机新观察（两条，写代码时要知道）：

- **`rke` 在会话 `未握手` 时会自动补做一次 VCSEC 握手再发指令**（日志顺序：`V3 握手 session_info_request` → `SESSION_INFO_STATUS_OK` counter=1 → `RKE_ACTION_LOCK(1)` counter=2）。即 console 层已内建「先握手后发」，不必强依赖人工顺序；但**车端未报 `FAULT_IV_SMALLER_THAN_EXPECTED`** 说明重新握手后的 counter 基线仍被车辆接受，跨会话口径见 §7.5。
- **复位后 BLE 连接态会靠 NVS deviceId 自动恢复，但 V3 会话清空** —— `status` 显示 `BLE=connected \| VCSEC=0@未握手`。所以「已连接」不等于「可直接发指令」。（注意：**打开串口并不总复位**，见 §7.6 铁律 2 修正。）

推进要点（**执行顺序**如下，与上表步骤号不一一对应；按 2026-10-03 实测更正，换车/换会话照此重跑）：

- **冒烟**：上电串口出现启动日志、`tlb_app_init` 无 ERROR；观察 heap/任务是否正常。
- **扫描 + 连接**：复位后自动重连**实测 ≈1 s 即连上**（不再需要 `sleep 40` 干等；保险起见脚本里放 `sleep 5~10` 足够），再 `status` 确认 `BLE=connected`。未自动连上就用 `connect <VIN>`（名匹配）**或直接 `connect` 走 deviceId**（第五次刷写后 `TLB_CMD_CONNECT_AUTO` 已对本车可用）→ 停扫 → 600 ms → 服务发现 → 订阅 0x0213（**INDICATE**）→ MTU 协商逐段看日志。扫不到先排查：车辆蓝牙钥匙页是否开、官方 App 是否在线占坑（车辆 BLE 钥匙连接数通常限 3，**测前杀掉官方 App 后台并断开其蓝牙**）。
- **绑定（必须前置于握手）**：明文 WhitelistOperation(addKey, PRESENT_KEY) → **刷实体 NFC 钥匙卡** → 看 `whitelistOperationStatus`。**本车实测直接回终态 `NONE(0)`，不经过 `WAIT(1)`**，别死等 `WAIT`。
- **会话握手**：绑定成功后再 `handshake`（两域各强制一次，对照 §5.3 字段）；未绑定就握手拿不到可用会话，`probe` 只会报「响应没有 session_info_tag」。
- **BLE 层 bond（非阻塞）**：security initiate 板端恒报 `蓝牙栈错误 1283`，未加密链路 + V3 应用层加密照常可用。
- **RKE**：`rke` 自带「未握手就先握手」，但**发指令前仍要按 §5.7/§8.3 核对动作号与明文载荷，逐条取得授权**。已验 `LOCK(1)/1001`；待验 `UNLOCK(0)/1000` 与 29/30（依车辆固件版本可能不支持，失败文案要可读）。
- **鲁棒性**：拉黑距离/断电 → 观察自动重连；重启 → counter 不回退；重复绑定请求的幂等。

**绑定前 checklist（引导页扫码侧，第 28 次用户实机选非 Tesla 设备超时教训）**：
1. **关手机蓝牙**：车辆 BLE 钥匙连接数通常限 3，手机蓝牙开着会占掉一个槽位，设备连不上或被挤掉
2. **坐进车内唤醒车机**：车休眠时**不广播** VCSEC 服务 UUID（`0211`/`0212`/`0213`），引导页扫描结果里全是灰色、**没有任何青色疑似车标记**（因为 `tesla=false`）
3. **等扫描出青色圆点再选**：青色圆点 = 该广播带 Tesla VCSEC UUID（不是靠名字匹配），这是唯一可靠的 Tesla 标识；如果扫了 10 秒还没有青色圆点，说明车没广播 VCSEC，回到第 2 步
4. **非 Tesla 设备选了必超时**：服务发现超时（8 秒，`GATT_PROC_MS=8000`）是**正常行为**——非 Tesla 设备根本没有 0211 服务，设备找不到就显示「失败:服务发现超时」
5. **车广播名不带 "Tesla " 前缀是正常的**：新版固件用哈希名（如 `S4adfe3eacbdb58b7C`）或车主自定义名，不以 "Tesla " 开头也能扫到青色圆点；只有老版固件广播名才是 `Tesla ABC123` 格式

### 7.4 判读资料
`FAULT_*`、`OperationStatus_E`、`WhitelistOperation_information_E` 三张判读表：`tesla-ble-probe\README.md` §4（含「出现时该怎么办」）。固件日志全中文、无数字错误码——与探针文案逐字一致，可直接套用该判读表。

### 7.5 已知不确定项（真机才能定论）
1. ~~NimBLE 对 0x0213 **INDICATE** 订阅 + 2B 大端长度前缀粘包的实测时序~~ → **2026-10-03 已定论：可用**。订阅成功、MTU 实测 247、指示帧与车辆主动上报均按前缀正确重组（§7.3 步骤 3）。
2. 车辆临时公钥是否轮换（过期表现为解密校验失败类文案，重新握手即可）——**仍未验，但已跨三次独立串口会话复验**：`rke 1`/`rke 0`/`rke 20` 分属三个会话，每次重新握手拿到的 epoch 都是 `9b0b15d65644a805…`、车辆公钥都是 `04aec8cf46b1fdfb…`，约 3 分钟内无变化。仍需**跨小时/跨熄火**才能定论。
3. ~~压缩点：车辆若发 33 字节压缩公钥，我方 P-256 解点未实现~~ → **已定论：本车发 65 字节未压缩点**（`tlb_port_ecdh` 的 `pub[0]!=0x04` 早退未触发，握手两域全 OK）。其它车型仍需保留该早退分支。
4. RKE 29/30 动作号与车辆固件版本相关 —— **仍未验**。`1`（`LOCK`/`1001`）、**`0`（`UNLOCK`/`1000`）**、`20`（`REMOTE_DRIVE`/`1014`）**均已于 2026-10-03 实机受理**（§7.3 三条往返表）；只剩 29（`AUTO_SECURE_VEHICLE`）与 30（`WAKE_VEHICLE`）未发出，且每次都要逐条授权（§8.3）。
5. 官方 App / 其它手机钥匙占坑导致连接被拒的文案与恢复路径 —— **仍未验**。注：`errCode=10008`（已经有连接尝试在进行）板端由**自身自动重连**引起，不是占坑（见 §7.6 时序窗口）。
6. **新增**：BLE 层 security initiate 恒定 `蓝牙栈错误 1283`，未加密链路是否会被某些车辆/固件版本拒绝 —— 未验。**语义已可读化（第五次刷写）**：`1283 = 0x503 = BLE_HS_ERR_SM_PEER_BASE(0x500) + BLE_SM_ERR_AUTHREQ(0x03)`，即**车端 SMP 以「认证要求无法满足」拒绝配对**（我方 `sm_io_cap` / `sm_bonding` 的组合车端不接受）。是否要改 `sm_io_cap`/`sm_bonding` 试探配对 —— **由用户决定，属 BLE 链路层改动，不影响 V3 应用层加密主线**。
7. **新增**：车辆 BLE MAC 是否轮换（实测 `AA:BB:CC:DD:EE:FF` / type 0，与卡上硬编码值不同）—— **仍未验**。第五次刷写后 deviceId 直连（`TLB_BLE_ADDR_TYPE_ANY`）已对本车生效，但**若车端轮换 MAC，deviceId 路径会静默失效**（表现为 boot 日志里「开始扫描（按 MAC …）」一直不命中）；此时改走 `connect <VIN>` 名匹配即可恢复，故**名匹配路径不能删**。
8. **~~counter 跨会话基线口径未定论~~** → **2026-10-03 已定论（§7.3 步骤 8）：NVS 持久 counter 跨刷写与复位都不回退**。双证：boot 日志 `已恢复 VCSEC 会话 counter=1` 与 `status` 的 `VCSEC=1@未握手 …（盘上counter=1）` 完全一致；车机域为 `（盘上counter=0）`。即上一轮 `rke 1` 递增到的 1 已落 NVS，复位/重刷不丢。→ 之前「自动重新握手后 counter 回到 1」的疑点解释为**续用 NVS 值，而非按 epoch 重起算**；§5.5「counter 单调不可回退」的表述成立，且第四次优化（counter 可观测性）就是为定论此点而加的打印。

### 7.6 串口命令行（`tlb_console.c`，本仓新增）
提示符 `tlb> `，走 USB-Serial-JTAG（与日志同一个 COM）。**所有命令只入队**（`tlb_app_post` / `tlb_app_post_vin`），结果由 worker/link 任务稍后打印 —— 与探针按钮语义一一对应，绝不在 REPL 回调里做 BLE 动作。

| 命令 | 映射 | 备注 |
| --- | --- | --- |
| `scan` | `TLB_CMD_SCAN_LIST` | 20 s 全部广播列表（实测板端已扫到周围设备） |
| `connect [VIN]` | 带 VIN→`TLB_CMD_CONNECT_VIN`，否则 `TLB_CMD_CONNECT_AUTO` | **第五次刷写后 AUTO 路径已对本车可用**（按 NVS deviceId + `ADDR_TYPE_ANY` 命中，§4.1）；无档案且 NVS 无 VIN 时 `active_vin()` 返回空串，需先 `vin <VIN>` |
| `vin [17位]` | 读/写 `tlb_nvs_vin_save` | 单独一格，换车、清档案都不丢。**2026-10-09 配网热点上线后**：无 VIN 开机走网页配网为主通道（保存 → 写 NVS → 2 秒后自动重启进正常模式），REPL `vin` 保留为开发通道（正常模式下落盘即生效，不重启） |
| `handshake` | `TLB_CMD_HANDSHAKE` | 两域各强制握手一次 |
| `bind` | `TLB_CMD_BIND` | 未连接时直接报「还没连上车辆，先按扫描并连接」 |
| `probe` / `version` | `TLB_CMD_PROBE` / `TLB_CMD_VERSION` | 只读 |
| `rke <0\|1\|20\|29\|30>` | `TLB_CMD_RKE(arg)` | **表外动作号直接拒绝下发（console + `handle_rke` 双闸门，§5.7C），不再是只 WARN**。实测 `rke 7` → `不在官方 RKEAction_E 白名单(0/1/20/29/30)，已拒绝下发` + `Command returned non-zero error code: 0x1 (ERROR)`，之后零 BLE 写入。**`0=解锁 1=上锁 20=驾驶授权 29=自动落锁 30=唤醒`**（§5.7B 事故后修正，**当前板上 691,776 B 固件已是正确文案**，旧版 help 错误已随第四次刷写消除）。实测：会话未握手时该命令会**自动先做一次 VCSEC 握手**（§7.3 实机新观察） |
| `status` | `TLB_CMD_STATUS` | 一行设备状态（实测 `BLE=connected \| keyId=DE:AD:BE:EF \| VCSEC=1@ready \| 车机=0@ready`）。**第五次刷写起每域额外回显 `epoch=<hex>` 与 `（盘上counter=N）`**（§7.5 项 8 就是靠这条定论的） |
| `disconnect` / `resume` | 对应命令 | disconnect 会置 `s_auto_suspended` |
| `loop start\|stop` | `TLB_CMD_LOOP_START/STOP` | 自动轮询循环开关（2026-10-03 起为**固定约 2 秒一轮**，退避档位已删） |
| `forget [--all]` | `TLB_CMD_FORGET(1/0)` | `--all` 连密钥+counter 一起清，**需重新刷卡** |
| `wipe_legacy` | 直接 NVS 操作（不入队） | **只删旧「AI工牌」残留的 `trae_cfg` 命名空间**（`nvs_erase_all`+`commit`），幂等；绝不碰 `tesla_ble`/`nimble_bond`/`phy`。定案见 §7.2，**2026-10-03 已执行并复验通过** |
| `help` | `esp_console_register_help_command` | |

驱动方式（`idf.py monitor` 只能看，不能脚本化输入）—— **历史做法**是用散落的 `tlb_cmd.py`（会话内批量下发）。⚠ **该脚本与 `probe_console.py` 都不在仓库里**，因此**当前手动流程请直接用 `idf.py -C tesla-offline-ble -p COMx monitor` 人肉敲命令（§7.8 步骤 7）**。下面的写法只作为「将来把脚本拷回来时」的参考（路径已按 §2 口径改成相对路径）：

```powershell
# 需要 tlb_cmd.py（不在仓库内）；python 用激活 IDF 后的那个（venv 随 IDF 安装，勿写死全路径）
python tlb_cmd.py COMx <总秒数> "cmd1|sleep N|cmd2" 2>&1 | Tee-Object -FilePath logs\xxx.log
```

- `"sleep N"` 是脚本本地的**占位伪命令**（`c.lower().startswith("sleep ")`），可以放在列表开头；每条真命令下发后脚本只额外 drain 1 s，**后续输出靠紧随其后的 `sleep` 收**（所以每条命令后面都要配足 sleep）。
- **`reset` 是 2026-10-03 新增的本地伪指令**：按 esptool 的硬复位时序拉一次 RTS（DTR 保持 0，不进下载模式）让目标芯片冷启动，并清空/收拢随后的启动日志。**想看 boot 日志（验证扫描/连接/握手恢复路径）必须在列表开头显式写 `reset`**，例：`"reset|sleep 55|status"`。
- 原始串口流最后一次性 `sys.stderr.write(text)` 落盘；PowerShell 侧用 `2>&1 | Tee-Object` 才可靠（`2>` 直接重定向出现过空文件）。
- 另一支旧脚本 `probe_console.py`（交互/单发）同样不在仓库内；批量流程历史上用 `tlb_cmd.py`，现在用手敲（§7.8 步骤 7）。

**⚠ 时序窗口（铁律 2 已按 2026-10-03 实测修正）：pyserial 打开串口（`COMx`）并「不总」复位板子 —— 是否冷启动取决于上一轮 esptool / 上一个会话留在 DTR、RTS 上的电平。** 实测两种情形都出现过：一次会话打开端口后**完全没有 boot 日志**（板子一直在跑，`status` 立刻 `BLE=connected`），另一次则正常冷启动。结论与操作口径：

1. **要看冷启动日志（验证扫描/连接/会话恢复）→ 必须在命令列表开头显式写 `reset`**，别赌 open 端口会复位（否则 ②③ 这类只在 boot 阶段体现的改动根本无从验证）。
2. **自动重连时间已从 ≈30 s 降到 ≈1 s**（deviceId 直连修正后）：boot 后 `t≈224 ms` 开始 GAP 扫描 → 立即按 MAC 命中（`rssi=-41`）→ `t≈255 ms` 发起连接。因此旧口径「`sleep 40` 干等」已过时，`sleep 5~10` 足够。
3. **不要一上来就发 `connect`** —— 仍会与自动重连撞车，报 `已经有连接尝试在进行 errCode=10008`，随后 `handshake` 因「还没连上车辆」失败（`handshake-2.log` 就是这个）。先发 `status` 确认连接态，没连上再 `connect`。
4. 会话结束**关闭端口即可能复位**（也可能不复位），别指望下一条命令接得上一次会话的连接态；V3 会话在任何情况下都要靠 `rke`/`handshake` 重建（§7.3 实机新观察）。

**⚠ 命令顺序：先 `bind`（未绑定/需刷实体 NFC 卡时）→ 再 `handshake` → 才 `probe`/`rke`。** 见 §7.3。

### 7.7 车钥匙整机（UI / 按键 / 2 秒轮询 / 字库）—— 2026-10-03 **实车全功能达标**；2026-10-04 **电池态按键失灵修复定案**（第 7~22 次刷写，现行=第 22 次纯手动诊断+启动阶段打点版）

用户口径：整块板子 = 特斯拉真车钥匙；「左上角开机」是硬件电源键（软件读不到，上电即自动轮询）；界面先最小可用（开机动画+几行状态文案），功能完成后再优化 UI。

- **2 秒固定轮询**（`tlb_app.c`）：`TLB_AUTO_SCAN_MS=2000`（定向扫描窗口）+ 全量扫描窗口 2 s + 一轮不中固定再等 `TLB_RETRY_DELAY_MS=2000`。退避升档（`k_retry_steps_ms[5]`、`s_loop_step`）已整体删除。探针 auto-reconnect 的其余结构保真：deviceId 直连 → 全量扫描 → 四档挑选、单飞位、disconnected 下降沿立即重武装。
- **UI 与 BLE 解耦**：屏幕只读 `tlb_app_ui_snapshot()`（`tlb_ble.h` 里的 `tlb_app_ui_t`：connected/trying/tries/ever_connected/rke_action/rke_pending/rke_ok/rke_at，全是 volatile 原子量），不碰状态机。`key_ui.c` 的 150 ms `lv_timer` 跑在 LVGL 任务内，回调里操作对象**不需要** `bsp_lvgl_lock`；本文件之外的线程一律不许动这些对象。
- **文案状态机**（`key_ui.c:ui_tick`）：RKE 回执窗口 3 s 内显示「正在上锁…/正在解锁…/正在启动…/指令发送中…」→「车辆已上锁/车辆已解锁/启动已授权/车辆已受理」（绿）/「指令发送失败」（红）；否则 connected→「已连上车机」（绿）、ever_connected 断开→「车机已断开」+「重连中…」（黄）、首连→「正在连接车机…」+「第 N 次尝试」（蓝）。`key_ui_start()` 失败只降级（关界面、BLE 照常），不致命。
- **按键映射**（`app_main.c`，**实机已确认全部正确**）：右一=`BSP_BTN_UP`→`tlb_app_post(TLB_CMD_RKE,1)`；右二=`BSP_BTN_DOWN`→ 连发 RKE 0、20（worker 串行天然保序「先解锁后驾驶授权」）；右三=`BSP_BTN_OK`→**按设计无动作**（用户口径「右三暂不操作」，此前"右三没反应"即此因，非硬件/映射故障：ADC 实测右三≈603 mV，稳在 OK 窗口 {447,1900} 内）。串口现打「按键 UP/DOWN/OK 按下/单击/双击/长按」全事件。**经按键发 RKE 同样受 §8.3 逐条授权红线约束**。
- **屏幕按键反馈**（第 11 次刷写起）：任意按键事件（不论长短按）经 `key_ui_notify_btn()`（只写 volatile，button 任务安全）在屏幕主行下方亮黄字「右一(UP)/右二(DOWN)/右三(OK)」1.2 s——用户可直接肉眼核对"按下的是哪个键"，不再依赖串口窗口同步。注意：iot_button 默认长按阈值下，按住 >2 s 只会出 LONG 事件、**不触发 CLICK 动作**；动作只认单击。
- **字库（2026-10-03 起双字库方案）**：`tools/gen_key_font.py` 两套码点——**20px 界面库**只扫 `key_ui.c` 字面量并剔除 ESP_LOGx（153 字形 / 107 KiB，保持精简）；**14px 日志库**全量扫 `application/main` + `components/tesla_ble` + `components/tesla_core` + `../ai-passport/components/bsp` 且保留 ESP_LOGx（689 字形 / 416 KiB，保证日志页能渲染任意固件中文日志）。node 直跑本地安装的 lv_font_conv（v1.5.3，`npx lv_font_conv` 亦可）+ 系统中文字体 `%WINDIR%\Fonts\simhei.ttf`（**工具与字体随各机环境而定、与工程无关——不要写死安装路径**），`--size 20/14 --bpp 4 --format lvgl --no-compress` → `assets/fonts/key_font_20.c` / `key_font_14.c`。清单留档 `assets/fonts/key_font_symbols.txt`（=14px 全量集；改界面文案后须重跑脚本）。**⚠ 血泪坑（第 7~9 次刷写间的"文字完全不显示"故障根因）：lv_font_conv 默认输出压缩字体（`bitmap_format=1`），而本工程 `CONFIG_LV_USE_FONT_COMPRESSED` 未开 → LVGL 取字形位图直接 `return NULL`，所有文字（含 ASCII）一个像素都画不出，只有不依赖字体的 spinner 能动；且 `lv_font_get_glyph_dsc` 查表仍返回 ok=1，极具迷惑性。定论：改文案重跑脚本即可，`--no-compress` 绝不能删。**
- **实机验证清单结果**（第 7~12 次刷写 + 实车）：① 屏幕点亮/背光/中文渲染 **PASS**（修字库压缩坑后全部文案正常显示，用户目视确认）；② 按键物理映射 **PASS**（屏幕反馈三键全对：右一(UP)/右二(DOWN)/右三(OK)，用户确认）；③ 2 秒轮询节奏 **PASS**（boot 日志时间戳 2 s 步进跑满多轮无崩溃）；④ 按键触发 RKE 全链路 **PASS（实车）**——用户实车确认上锁、解锁、启动授权均正常执行；此前"车边按键没反应"经屏幕诊断定位为**按压时长超长按阈值不触发单击**（非硬件/映射/供电故障，右三 ADC 实测 603 mV 正常）；⑤ `wipe_legacy` **已执行**（22:39，备份+回显+冷启动复验三证齐全，见 §7.2）；⑥ 稳定性 **PASS**——多轮 boot+长时间轮询+实车使用无看门狗/无 panic；"神秘重启"证实为 **pyserial 开 COM 口脉冲 DTR/RTS 复位板子**（§7.3 既有记载），非固件问题。
- **屏幕诊断模式**（第 12 次起，长期保留；第 13~14 次加日志页，第 15 次加安全边距，第 21 次加阶段打点，第 22 次起**纯手动**——5 秒自动进诊断与 6 秒自动翻页两个排障临时逻辑已删）：**长按右三**切换，两页结构：
  - **页1（电压页）**：副行=`ADC=<实时电压>mV 键=<开机以来按键事件数>`（一次轻按计 2：按下+单击；长按计 2：按下+长按；读失败时变 `ADC失败:<粘存esp_err名> 键=N`，「无」=驱动从未初始化），反馈行=`RAM=<剩余堆> 连=<0/1> 启=<上次重启原因中文> 阶=N`（启=上电/外部/软件/崩溃/看门狗/掉电/深睡/其他，崩溃/看门狗/掉电=出过事；阶=启动阶段打点：1=界面就绪 2=BLE核心就绪 3=按键初始化返回 4=控制台已启动——**电池态停在 3 属正常**，console 无主机不返回，见下方事故记录）。判读：按键时 ADC 应跳到 ≈0/300/600 且计数上涨；ADC 不动=按键线没被拉下；ADC 跳但计数不涨=窗口没接住。诊断模式下黄字键名被 RAM 行覆盖（设计如此）。
  - **页2（全屏日志页，第 14 次起）**：**诊断内单击右三**进入——隐藏全部常规元素，整屏一次显示**一条**完整固件日志（14px 自动换行，绝不遮挡；第 13 次双行小字版因遮挡被用户否决），底部 `N/8` 位置指示；继续单击右三在环形缓冲里逐条翻看（最新→最旧→回最新）；长按右三退出诊断回正常界面。
  - **日志钩子**（`key_ui.c`）：`esp_log_set_vprintf(log_tee)` 把每条日志 tee 进 **8×160 B 静态环形缓冲**（不占堆；portMUX 自旋锁保护；剥 ANSI 转义；截断处回退到完整 UTF-8 码点防乱码）。串口日志照常透传。
  - **安全边距**（第 15 次起）：外壳圆角遮挡区，`UI_MARGIN=10`（240×320 物理像素），全部界面元素与日志页统一缩进 10px。
- **电池态按键失灵事故记录**（2026-10-04，第 16~22 次刷写，**已闭环**）：现象=纯电池开机三键全死、诊断页1 `ADC失败:无 键=0`（=驱动从未初始化），插 USB 按键立刻复活且不重启。根因=`tlb_console_start()` 走 USB-Serial-JTAG，**无主机时永久阻塞不返回**，旧 app_main 把按键初始化排在 console 之后→永远轮不到。修复=按键初始化挪到 console 之前（第 20 次）；第 21 次「阶=N」打点实证：电池态阶停 3、按键全正常；用户电池开机复验 ADC=2921mV（松开态）、三键可用（第 22 次）。配套加固长期保留：`app_button.c` = bsp_button 分叉副本（ADC 读失败重试 3 次/真实 esp_err 粘存上屏/ui_tick 每 5 秒自愈 re-init/校准失败线性兜底）。**教训：C3 上任何必须开机就绪的初始化，绝不能排在 USB console 启动之后。**
- **已知风险**：LVGL 任务与 NimBLE host 任务的堆/RAM 争用未经真机检验（C3 无 PSRAM）；若实机出现分配失败，优先调小 `CONFIG_LV_MEM_SIZE_KILOBYTES` 或减 spinner 动画，而不是动 BLE 配置。

### 7.8 手动烧录 SOP（**用户自己一步步执行**，2026-10-08 逐步校准）

> 之前 24 次刷写都由 AI 代跑，本节是给「第一次自己动手刷」写的可照抄清单。**命令全部相对仓库根，任何电脑、任何盘符都一样**；只有两处要现场确定：步骤 2 的 IDF 安装目录（激活那一行）和步骤 1 查到的端口 `COMx`。
> **最短路径 = 步骤 2 → 3 → 4 → 5 → 7**（第一次建议先只跑 1~4 熟悉一遍，不写 flash 也不会弄坏任何东西）。

**动手前必须记住的三条红线**

1. **只做分件刷 app**：写 `0x0` / `0x8000` / `0x10000` 三个区间，**擦除范围不碰 `0x9000`（NVS）** → 绑定密钥、会话 counter、bond 全部保住（已四次实证无损）。
2. **绝不要执行**：`erase-flash`、`erase-region 0x9000`、`write_flash 0x0 <整片 bin>`。这些清 NVS = 设备立刻不再是已绑定钥匙，**必须人和实体 NFC 卡都在车边重新 `bind`**，而且车端白名单会留下失效的僵尸 keyId（§7.2 定案：要清旧东西只用固件命令 `wipe_legacy` 定向清）。
3. **刷前备份 NVS**（步骤 4）——这是唯一后悔药，30 秒的事，别省。

> **本节命令全是相对路径，换电脑、换盘符一个字都不用改**；唯一要现场确定的是步骤 1 查到的串口号，下文一律写作 `COMx`。

**步骤 0：在仓库根打开终端 + 建目录（一次性；`nvs-backups\`、`logs\` 已在 `.gitignore` 里）**

「仓库根」= 本文件所在目录。在编辑器里对它开终端（或 `cd` 到它），然后：

```powershell
New-Item -ItemType Directory -Force -Path nvs-backups | Out-Null
New-Item -ItemType Directory -Force -Path logs | Out-Null
```

**从这里往下所有命令都不含盘符**（都在仓库根里执行）。

**步骤 1：插板 + 现查端口**

```powershell
[System.IO.Ports.SerialPort]::GetPortNames()
Get-PnpDevice | Where-Object { $_.InstanceId -match 'VID_303A' } | Select-Object Status,FriendlyName,InstanceId | Format-Table -AutoSize
```

- 判读：应看到 `USB JTAG/serial debug unit`（`USB\VID_303A&PID_1001`，MAC `98:C3:77:F4:9E:04`），它的端口就是本次要用的 `COMx`。**别凭记忆抄端口**：机器上可能同时挂着别的串口（例如手机调制解调器），抄错就把命令打到别的设备上；换 USB 口还会变号。
- 列表为空 = 板子没插好 / 插的是纯充电线 → 换数据线或换 USB 口。

**步骤 2：激活 IDF（环境变量不跨窗口，每开一个新窗口都要重跑）**

```powershell
. <你的 IDF 目录>\export.ps1
```

- 报「找不到工具链」时先补一句：`$env:IDF_TOOLS_PATH = '<你的 IDF 目录>\tools'`（这套环境的工具链不在默认的 `~\.espressif`）。
- 成功标志：`Activating ESP-IDF 5.5` + `Setting IDF_PATH ...` + 各 `Checking ... OK`。
- 自检：`idf.py --version` → `ESP-IDF v5.5.3`；`esptool.py version` → `4.12.0`。
- **后面所有步骤都在同一个窗口里跑**，别关。

**步骤 3：构建**

```powershell
idf.py -C tesla-offline-ble build
```

- 成功标志：`Project build complete.` + `binary size 0x... bytes. Smallest app partition is 0x7f0000 bytes. ... (84%) free`。
- 2026-10-08 实测基线：`tesla-offline-ble\build\tesla-offline-ble.bin` = **1,303,056 B（`0x13e210`）**。刷前核对一下产物是新的（防止刷进旧 bin）：

```powershell
Get-ChildItem tesla-offline-ble\build\tesla-offline-ble.bin | Select-Object Length,LastWriteTime
```

- 已知良性噪音（别慌）：`tlb_ble.c` L105 `LINE_MAX` 重定义警告；首次运行会打印 `Missing kconfig option. Re-run the build process` 并自己重跑一次 CMake（约 25 s）。
- 报 `idf.py : 无法将idf.py项识别为 cmdlet` = 这个窗口没激活 IDF → 回步骤 2；报 `Could not find directory of ESP-IDF` = `export.ps1` 那行的 IDF 目录写错了。

**步骤 4：备份 NVS（必做）**

```powershell
python -m esptool --chip esp32c3 -p COMx --baud 921600 --before default_reset --after hard_reset read_flash 0x9000 0x6000 "nvs-backups\nvs-before-$(Get-Date -Format yyyyMMdd-HHmmss).bin"
```

- 成功标志：`Wrote 24576 bytes` + `Leaving...` + `Hard resetting via RTS pin...`；文件大小必须是 **24576 B**（= `0x6000`）。
- ⚠ 这条命令会顺带**复位板子一次**（正常，不是故障）。备份落在仓库内 `nvs-backups\`，已被 `.gitignore` 忽略，不会误提交；**换电脑时这个目录不会自动跟过去**（含设备私钥，绝不入库、也不进云盘），要么拷走、要么在新机器上重做本步。

**步骤 5：烧录（分件，只写三个区间）**

```powershell
idf.py -C tesla-offline-ble -p COMx flash
```

- 它照 `tesla-offline-ble\build\flash_args` 写：`0x0 bootloader.bin` / `0x8000 partition-table.bin` / `0x10000 tesla-offline-ble.bin`，参数 `--flash_mode dio --flash_freq 80m --flash_size 8MB`。想自己确认没写 0x9000：`Get-Content tesla-offline-ble\build\flash_args`。
- 成功标志（**三个文件都要有** `Hash of data verified.`）：

```
Wrote ... bytes ... to flash 0x000000 ... / 0x00008000 ... / 0x00010000 ...
Hash of data verified.      ← 出现 3 次
Leaving...
Hard resetting via RTS pin...
```

- 卡在 `Connecting........_____.....` 反复：端口被占（另一个 monitor / 串口助手 / 上一次会话没退）→ 关掉再重跑；或重插 USB。**全程不需要按 BOOT 键**（C3 原生 USB-Serial-JTAG 自动进下载模式）。

**步骤 6（可选）：只刷应用、不动 bootloader/分区表**

```powershell
idf.py -C tesla-offline-ble -p COMx app-flash
```

- 只写 `0x10000`，日常改应用代码用这条更快。改了 `partitions.csv` 或 sdkconfig 里的 flash 相关项，则必须回到步骤 5 的 `flash`。

**步骤 7：串口自检（监视 + REPL）**

```powershell
idf.py -C tesla-offline-ble -p COMx monitor
```

- **退出 = `Ctrl + ]`**（`Ctrl+C` 只是暂停，不是退出）。留档：`Ctrl+T` 再按 `F` 开日志落盘，或整段重定向到 `logs\monitor-<时间戳>.log`。
- 判读要点（对照 §7.3 / §7.7）：启动日志无 panic、无看门狗；`阶=1/2/3` 阶段打点走到位；t≈0.3 s 按 MAC 命中并发起连接；`status` 回显 `BLE=connected | keyId=DE:AD:BE:EF | VCSEC=N@ready | 车机=N@ready`。
- monitor 里可直接敲 REPL（提示符 `tlb> `，命令表见 §7.6）。**只读安全**：`status` / `probe` / `version` / `help` / `scan`。**有副作用，敲前自己确认**：`bind`（要刷实体 NFC 卡）、`rke <n>`（对真车发指令，动作号必须回查 §5.7：`0=解锁 1=上锁 20=驾驶授权 29=自动落锁 30=唤醒`）、`forget`、`wipe_legacy`、`disconnect`。
- `monitor` 与 `flash` 互斥（都独占同一个 `COMx`）：要再刷，先 `Ctrl+]` 退出。

**步骤 8：整机复验（车钥匙功能，不在电脑边也要做）**

- 屏幕：点亮 + 中文正常渲染（若整屏一个像素文字都没有、只有 spinner 在转 → §7.7 字库压缩坑，`--no-compress` 被删了）。
- 按键：**只认快速轻按**（按住 >2 s 变长按事件、不触发动作）。长按右三进诊断页；页1 看 `ADC= / 键= / RAM= / 连= / 启= / 阶=`；诊断内单击右三翻到日志页。
- 实车：右一=上锁、右二=解锁+驾驶授权、右三=无动作（设计如此）。

**出问题怎么办**

| 现象 | 处理 |
| --- | --- |
| `idf.py` 不识别 / `export.ps1` 报错 | 同一窗口重跑步骤 2（IDF 目录写对）；工具链找不到时补 `$env:IDF_TOOLS_PATH = '<你的 IDF 目录>\tools'` |
| `could not open port 'COMx'` | 端口号变了 → 回步骤 1 现查并更新 `COMx`；或被别的程序占用 → 关掉 |
| 换电脑后「找不到备份」 | 备份在仓库内 `nvs-backups\`，**文件不会自己跟过去**（含设备私钥，绝不入库、也不进云盘）。要么手动拷过去，要么在新机器上重做步骤 4 现备一份 |
| `Connecting...` 一直超时 | 关掉另一个 monitor/串口助手、重插 USB、再跑步骤 5 |
| 刷完反复重启 / 看门狗 | 别急着重刷，先用 `monitor` 抓完整 boot 日志，按 `阶=N` 定位卡在哪一步（§7.7），必要时走 `passport-debug` |
| 刷完 `keyId` 变了 / 握手报 `KEY_NOT_ON_WHITELIST` | 说明 NVS 被动过 → 用步骤 4 的备份写回：`python -m esptool --chip esp32c3 -p COMx --baud 921600 --before default_reset --after hard_reset write_flash 0x9000 "nvs-backups\<刚才的备份>.bin"`，写回后仍要走 §7.3 绑定流程（**人和实体 NFC 卡必须在车边**） |
| 想「清空板子重来」 | 不推荐。`erase-flash` 连 NVS 一起毁且不可回退（counter 单调）。定案做法：只刷 app + 需要清旧数据时用固件命令 `wipe_legacy` 定向清 `trae_cfg`（§7.2） |

---

## 8. 流程红线（仍然有效）

1. **不 commit、不 push**，除非用户明确要求（HEAD 已到 `f35655d 完成开锁上锁，前后备箱功能`，其前为 `6ca45cf 提交md文档`；刷机阶段的新工作区改动一律留在本地）。
2. **未经授权绝不烧录**；检测到手设备 ≠ 授权；刷 NVS 破坏性必须事先说明（§7.2）。**2026-10-08 起用户改为自行手动烧录：AI 不再代刷，只负责把 §7.8 的步骤与风险讲清楚**（红线不变：分件刷 app 不碰 `0x9000` + 刷前备份 NVS）。
3. **对真车发任何动作指令（RKE/绑定/遗忘）逐条单独授权**，且授权前必须回查权威枚举表把「动作号 → 中文语义 → 明文载荷」三者对齐（§5.7）。2026-10-03 因沿用错误 help 文案，把 `REMOTE_DRIVE(20/1014)` 当「上锁」取得授权并实发 —— **不得重犯**；一旦发现有误立即停手、向用户披露、不再追加指令。
4. 探针 `tesla-ble-probe\` 与 `ref-repos\` 全部**只读**；`ai-passport\main\**` 禁区。
5. 相关 skill 按需调用：`passport-device-test`（刷机与验收流程）、`passport-debug`（运行时故障诊断：reboot/断言/看门狗/无日志）。
6. 交付按四段报告；本文件 §0 每轮收尾更新。

---

## 9. 维护本文档（硬性要求）

- 新功能/新页面/新按键语义/新依赖/新工具脚本/新环境路径/新未验证项 → 同步更新对应小节；§0 快照（分支、提交、产物大小、四类测试结果）收尾必改。
- **路径写法（2026-10-08 定案）**：正文一律写**相对仓库根**（本文件所在目录）的相对路径，不写盘符。需要现场填的只有两处：§2 激活行的 `<你的 IDF 目录>`、以及每次按 §7.8 步骤 1 现查的 `COMx`。**可执行命令里禁止出现盘符、固定 COM 号或任何机器专属路径**（历史刷写日志中当时的 COM 号仅作事实记录保留）。换电脑、换盘符：除这两处现场填写，命令一字不改。
- 换 USB 端口 / 换 IDF 安装位置 / 新的构建产物尺寸基线 → 更新 §2 表、§7.1、§7.8 步骤 3 的字节数。**别在正文其它地方另抄一份命令**（历史上就是这么长出满篇旧机路径的）。
- 新确认/推翻的字段号、枚举、加密口径 → 写回 §5，避免二次调研。
- 硬件调试每完成一步 checklist（§7.3）→ 把结果记入 §0「真机测试」行（如 `PART: 1-5 PASS, 6 待 NFC 卡`）。
- 与仓库文档冲突时以 `AGENTS.md` 路由表指向的权威文档为准，并回来修正本文件。

---

## 10. 参考项目与文档（按角色用 —— **2026-10-08 复核：ref-repos 已到位**）

> **⚠ 本节旧结论「`ref-repos\` 整个目录不存在」已作废**：2026-10-08 实测 `ref-repos\` 下四个目录都在（`tesla-ble`、`vehicle-command`、`esphome-tesla-ble`、`tesla-key-esp32`；各仓内部文件完整度在需要用时再现场核对）。wire 金标准的交叉验证**可以**直接翻参考仓源码，不必只靠 §5 与 `tests\host\goldens.h`。

> **外层 git 仓**：仓库根（= 本文件所在目录）整目录是一个 git 仓，远端 `https://github.com/chen970526/ai-passport-test.git`（`tesla-offline-ble\`、`tesla-ble-probe\`、`ai-passport\`、`ref-repos\` 都是它的子目录，没有各自独立的 remote）。**下表「本地路径」列全部是相对仓库根的路径**（§2 口径），任何电脑、任何盘符都适用。

| 项目 | git 仓库地址 | 本地路径（相对仓库根） | 角色 | 关键入口 |
| --- | --- | --- | --- | --- |
| **tesla-ble**（C++/nanopb） | `https://github.com/wilonz/tesla-ble` | `ref-repos\tesla-ble\` —— **已在仓库内** | **wire 格式金标准**（唯一权威参考实现） | `generated\include\{universal_message,signatures,vcsec,keys}.pb.h`（字段号/tag 全表）、`src\message_builders.cpp` / `crypto_context.cpp`（构造/加密）、`tests\CMakeLists.txt`（17 个 gtest 文件）、`AGENTS.md`（4 空格/同例行花括号/clang-format 风格） |
| **vehicle-command**（Go） | `https://github.com/teslamotors/vehicle-command` | `ref-repos\vehicle-command\` —— **已在仓库内** | Tesla 官方系 VCSEC 协议的 Go 实现，交叉验证派生/签名细节 | `pkg\protocol\key.go`、`pkg\vehicle\vcsec.go`、`examples\ble\main.go` |
| **esphome-tesla-ble** | `https://github.com/yoziru/esphome-tesla-ble` | `ref-repos\esphome-tesla-ble\` —— **已在仓库内** | ESPHome 封装的 BLE 钥匙组件，ESP 侧集成参考 | `packages\`、`AGENTS.md` |
| **tesla-key-esp32** | `https://github.com/0Bu/tesla-key-esp32` | `ref-repos\tesla-key-esp32\` —— **已在仓库内** | 完整 ESP32 C++ 工程（BLE client/NVS/crash 诊断），**调试手法可借鉴**（`diag_crash`、`stack_watch`、`heap_trend`） | `main\ble_client.cpp`、`docs\ARCHITECTURE.md`、`docs\SECURITY.md` |
| **tesla-ble-probe**（uni-app） | 随外层仓 `https://github.com/chen970526/ai-passport-test.git` | `tesla-ble-probe\` | **文案与协议判定的来源**（我方逐字节移植对象） | `src\protocol\v3\{spec,codec,handshake,aead}.js`、`README.md` §4 判读表、`tests\run.mjs` |
| **ai-passport**（硬件基线） | 上游 `https://gitee.com/FoloToy/ai-passport`（FoloToy 官方）；副本随外层仓 | `ai-passport\` | 板级组件 `components\bsp` 提供者；硬件文档权威（`docs\hardware-design\`、`AGENTS.md`）；**main/** 禁区 | `components\bsp\include\bsp_pins.h`、`docs\development\ai-guide.zh_CN.md` |
| **ESP-IDF**（工具链） | `https://github.com/espressif/esp-idf`（国内克隆用 Gitee 镜像 `https://gitee.com/EspressifSystems/esp-idf.git`） | **不在仓库内**（各机自装，tag v5.5.3；位置只影响 §2 的激活那一行） | 固件构建框架 | 见 §2 环境搭建三条 |

外部权威来源（引用过，别再翻）：

| 来源 | 用途 |
| --- | --- |
| `https://github.com/trifinite/vcsec-archive` → `VCSECv3.10.14.proto` | 字段号、枚举数值权威表（ref-repos/tesla-ble 的 proto/ 与之同源） |
| gist `https://gist.github.com/LexNastin/fc55736f…`（完整 ID 见探针 README §10） | 端到端绑定 + 加密指令样例报文逐字节核对 |
| `teslabtapi.com/docs/start`、`/docs/more/rke` | GATT、长度前缀、BLE 命名规则、RKE 枚举 |
| BLE 广播名规则 | 新车 `Tesla ` + VIN 后 6 位；老车 `S`+`SHA1(VIN)`hex 前 16 位+`C|R|D|P`（我方按 MAC 直扫，不用名字） |

---

## 11. 历史阶段存档（简）

前一阶段交付过 **ai-passport 仓内的 LVGL 钥匙 UI 应用**（`feature/tesla-key`，提交 `60461f1`，UI 状态机/绑定向导/Noto 中文字体子集管线），主机测试全过、同样未上真机。该应用与本 BLE 固件是两条线：**当前调试对象是 §0 的 tesla-offline-ble（headless），UI 应用不在本次范围内**。涉及 UI 的历史细节（字体再生成命令、UI 布局规范）见 ai-passport 仓 `main\tesla_*` 与 git 历史，勿在本工程里复刻。
