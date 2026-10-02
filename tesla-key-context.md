# FoloToy AI Passport —— 特斯拉离线 BLE 钥匙：项目上下文卡

> **用法**：新开对话时，把本文件整体贴给 AI 作为首条消息的上下文，再说一句需求即可。
> AI 读完本文件应当不需要重新通读全部源码就能定位到该改哪里、该怎么验证。
> 本文件位于各仓库之外（`f:\Desktop\test\`），刻意不进任何仓库。
> **当前阶段：硬件调试（真机刷机 + 实车验证）。**

---

## 0. 一句话现状（每次改动后必须更新本节）

| 项 | 当前值 |
| --- | --- |
| 主工程 | `f:\Desktop\test\tesla-offline-ble\`（ESP-IDF v5.5.3 / ESP32-C3，无头 BLE 应用，无 UI） |
| Git | 仓库根 = `f:\Desktop\test`，remote `https://github.com/chen970526/ai-passport-test.git`，分支 `feature/tesla-offline-ble`，HEAD `4368fb4 测试硬件`，**与 origin 同步、工作区干净** |
| ESP-IDF 构建 | **PASS**：`build\tesla-offline-ble.bin` = 625,616 B（factory 0x7f0000，占用约 8%），`tlb_app.c` 编译零警告 |
| 主机测试（金标准/对抗） | **PASS**：`tests\host\run.ps1` → **2533 checks, 0 failed**（gcc 16.1.0 MinGW，本轮刚跑过） |
| 真机测试 | **NOT RUN —— 即当前阶段任务**；设备已见 `USB JTAG/serial debug unit`，但 `GetPortNames()` 当前枚举不到 COM（见 §7.1） |
| 旁支探针 | `f:\Desktop\test\tesla-ble-probe\`（uni-app 纯 JS，**本轮实测 519 passed / 0 failed**，17 个页面脚本自检全过；仍未上安卓真机） |
| 参考仓容器测试 | **未完成遗留**：`test_tlb_message_builders.cpp` 尚未创建；且本机 **docker 命令不存在**，容器 `test_tesla_ble` 当前无法在本机跑（见 §6.4） |
| 未提交改动 | 无（构建产物 `build/`、`managed_components/` 均被 .gitignore 覆盖） |

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
| 板级其余 | 面板 ST7789P3 240×320、GPIO0 三键 ADC、电池 —— **本应用未使用**（headless，只打串口日志）；`EXTRA_COMPONENT_DIRS` 仍挂 `../ai-passport/components` 供 bsp 编译，改 UI 前须回到 ai-passport 侧另行立项 | `tesla-offline-ble/CMakeLists.txt` |

---

## 2. 本地环境：全部路径与命令（Windows / PowerShell）

固定路径：

| 用途 | 路径 |
| --- | --- |
| 主工程 | `f:\Desktop\test\tesla-offline-ble\` |
| 构建目录 | `f:\Desktop\test\tesla-offline-ble\build\`（增量；`build\host\` 为主机测试产物） |
| ESP-IDF v5.5.3 | `F:\esp\esp-idf-v5.5.3` |
| **IDF 工具链根** | **`F:\esp\tools`**（非默认 `~\.espressif`，后者不存在；不设 `IDF_TOOLS_PATH` 直接 export 必失败） |
| 基线仓（只读禁区） | `f:\Desktop\test\ai-passport\`（`main/**` 绝不可动；`components/bsp` 被本工程复用） |
| 探针 | `f:\Desktop\test\tesla-ble-probe\` |
| 参考项目 | `f:\Desktop\test\ref-repos\{tesla-ble, vehicle-command, esphome-tesla-ble, tesla-key-esp32}`（见 §10） |
| Python / Node | 3.13.5（`C:\Users\Administrator\AppData\Local\Programs\Python\Python313\python.exe`）；Node `C:\nvm4w\nodejs\node.exe` |
| gcc（主机测试用） | MinGW-W64 **16.1.0**，已在 PATH |
| MSVC（备用） | `C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\...\Launch-VsDevShell.ps1` |
| 已安装 Skill | `C:\Users\Administrator\.trae-cn\skills\passport-*`（develop/setup/build/device-test/debug） |

**铁律：每个终端都是全新 shell，「设环境变量 + export + idf.py」必须拼在同一条命令里：**

```powershell
$env:IDF_TOOLS_PATH = 'F:\esp\tools'; . F:\esp\esp-idf-v5.5.3\export.ps1 | Out-Null; idf.py -B f:\Desktop\test\tesla-offline-ble\build build
```

刷机/监视（同一行规则同样适用，先激活再执行）：

```powershell
$env:IDF_TOOLS_PATH = 'F:\esp\tools'; . F:\esp\esp-idf-v5.5.3\export.ps1 | Out-Null; idf.py -B f:\Desktop\test\tesla-offline-ble\build -p COMx flash monitor
```

merge-bin（如需整片产物，输出必须给绝对路径，esptool 工作目录已是 build/）：

```powershell
idf.py -B f:\Desktop\test\tesla-offline-ble\build merge-bin -o f:\Desktop\test\tesla-offline-ble\build\tesla-offline-ble-full.bin
```

其它坑：本工具禁止 `cmd /c`；分件刷写偏移直接看 `build\flash_args`（0x0 bootloader / 0x8000 partition-table / 0x10000 app，`--flash_mode dio --flash_freq 80m --flash_size 8MB`）。

---

## 3. 固件架构（tesla-offline-ble）

```
application/main
  ├─ app_main.c   入口：只做 tlb_app_init()，失败 ESP_LOGE，不 abort
  └─ tlb_app.c    （1244 行）worker 任务 + 命令队列 + 独立 link 自动重连任务；
                  硬编码 MAC 定向扫描 → connect → 停扫 → delay(600) → 发现服务 →
                  订阅 0x0213(INDICATE) → 协商 MTU；TIB（BLE security initiate + NVS bond）；
                  探针全部中文文案逐字复现
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

**修改红线**：应用区只允许动 `application\main\{CMakeLists.txt, tlb_app.c, app_main.c}` 与 `components\**` 的必要定点小修；**绝不碰** `ai-passport\main\**`；探针与 ref-repos 只读。

**日志规则**：BLE 失败**只以中文文本呈现，绝不出现数字错误码**；所有文案逐字来自探针（`tlb_text.c` 为文案表）。

---

## 4. 车辆连接参数（硬编码于 tlb_app.c L52-54）

| 项 | 值 |
| --- | --- |
| VIN | `LRW3E7F35N0008186` |
| 车辆 BLE MAC | `84:16:5C:75:51:B9` |
| 地址类型 | **1（随机静态）**——车辆广播用的就是随机地址，填错永远扫不到 |
| GATT | Service `00000211-b2d1-43f0-9b88-960cebf8b91e`；写 `0212`；**INDICATE** `0213`；读通信版本 `0214` |
| 帧格式 | **2 字节大端长度前缀 + protobuf 报文**，收包必须按前缀做粘包/半包重组 |
| 换车 | 改 `TLB_TARGET_VIN / TLB_TARGET_MAC / TLB_TARGET_ADDR_TYPE` 后重刷 |

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
- `RKEAction_E{UNLOCK=0, LOCK=1, REMOTE_DRIVE=20, AUTO_SECURE_VEHICLE=29, WAKE_VEHICLE=30}`（29/30 与车辆固件版本相关）。
- `FromVCSECMessage` oneof：`vehicleStatus=1, commandStatus=4, whitelistInfo=16, whitelistEntryInfo=17, nominalError=46`；`WhitelistOperation.status{signerOfOperation=2(KeyIdentifier{publicKeySHA1=1}), operationStatus=3}`。
- `PermissionChange.permission` 是 packed repeated：`10 04 02 01 04 03`（LOCAL_DRIVE=2, LOCAL_UNLOCK=1, REMOTE_DRIVE=4, REMOTE_UNLOCK=3）。

### 5.5 会话/加密与 counter
- V3 加密命令：`AES-128-GCM(key = SHA1(ECDH_x)[:16] 派生体系, 密文进 protobuf_message_as_bytes, tag 进 signature_data.AES_GCM_Personalized)`——权威细节以 `ref-repos/tesla-ble/src/{crypto_context,message_builders}.cpp` 与主机金标准为准。
- **counter 单调递增、不可回退**：nonce/counter 倒退触发 `FAULT_IV_SMALLER_THAN_EXPECTED` / `FAULT_TOKEN_AND_COUNTER_INVALID`，对同一把已绑定 key **永久性**，只能重新绑定 → **刷机清 NVS = 必须重新绑卡**（见 §7.2 风险）。

### 5.6 BLE 三条铁律（已在 tlb_app.c/tlb_ble.c 实现）
A. 连上立刻停扫；B. 所有 write 串行队列（绝不在回调里再 write）；C. MTU 抬到 ≥ 帧长+3（247 优先）。

---

## 6. 验证：跑什么、怎么跑

### 6.1 ESP-IDF 固件构建（本轮 PASS）
§2 首条命令。全量约 2063 个目标；已知良性警告仅 1 条：`tlb_ble.c` L105 `#define LINE_MAX 2600` 与 newlib 重定义 —— 无害勿动。

### 6.2 主机金标准/对抗测试（本轮 PASS：2533 checks / 0 failed）
```powershell
powershell -ExecutionPolicy Bypass -File f:\Desktop\test\tesla-offline-ble\tests\host\run.ps1   # 可加 -Regen 重生成 goldens
```
- `tools\gen_goldens.mjs`（Node）生成 `tests\host\goldens.h`；`test_core.c` + `tlb_port_host.c` 与全部 `tesla_core/src/*.c` 用 gcc `-std=c11 -Wall -Wextra -Werror` 编译。
- **改了 `tesla_core` 任何编解码必须重跑此测试**；改动报文格式时先 `-Regen` 核对金标准来源。

### 6.3 探针 JS 自测（本轮实测）
```powershell
cd f:\Desktop\test\tesla-ble-probe
node tests\run.mjs        # 519 passed, 0 failed
node tests\vue-check.mjs  # 页面脚本自检 全部通过 (17 个)
```

### 6.4 参考仓 C++ gtest（遗留任务，当前本机跑不了）
- 目标：在 `ref-repos\tesla-ble\tests\` 增 `test_tlb_message_builders.cpp`（用 nanopb `pb_encode` 钉 §5 金标准）并追加进 `tests\CMakeLists.txt` 的 `TEST_FILES`（现列 17 个文件，磁盘齐全）。
- 容器 `test_tesla_ble`（repo 挂载 `/workspace`）内：`cmake -B build -DCMAKE_MESSAGE_LOG_LEVEL=ERROR && cmake --build build -j`，`cd build && ctest -j`。
- **阻塞**：本机 `docker` 命令不存在。要么装 Docker Desktop 后继续，要么此项降级为「已由 §6.2 主机金标准覆盖」直接放弃。

### 6.5 ai-passport 旧仓门禁
`tools/validate.sh` 本机不可用（WSL 无发行版、无 gcc），等价用 MSVC `cl /W4 /WX`；旧 UI 测试（state 10 / wizard 11 / layout 5 组）属于历史阶段，现阶段与 BLE 固件无关，**不要去动那个仓**。

---

## 7. 硬件调试（当前阶段 —— 操作手册）

### 7.1 设备与串口现状（本轮实测）
- PnP 枚举到 `USB JTAG/serial debug unit`（C3 原生 USB 控制器在总线上）；但 `[System.IO.Ports.SerialPort]::GetPortNames()` **当前返回空**，`USB 串行设备 (COM3)/(COM4)` 均为 Unknown 状态的幽灵项。
- 结论：**板子可能已插入但 CDC 口未枚举**。上机第一步：
  1. 确认是**数据线**（很多 C-C 线只能充电）；换口/换线；
  2. `Get-PnpDevice -Class Ports` 与 `GetPortNames()` 复查，出现 `COMx` 才继续；
  3. 若只有 `USB JTAG/serial debug unit` 无 COM：USB-Serial-JTAG 的 CDC 接口仍应出 COM；持续不出则可能固件未启动/晶振异常，记录现象回来分析（用 `passport-debug` skill 流程）。
- 控制台固定走 USB-Serial-JTAG，**无需 boot 键**即可反复 `flash + monitor`。

### 7.2 刷机流程（**未经用户明确授权绝不烧录**）
1. §2 激活命令拼好 `-p COMx flash monitor`（分件刷写，偏移见 `build\flash_args`）。
2. **风险告知（必须向用户复述）**：整片/擦除刷写会清 NVS → **已绑定的车钥匙白名单条目、会话 counter、bond 全部作废**；counter 不可回退意味着刷回旧固件会从「重新绑卡」重来（需实体 NFC 卡在场）。
3. 交付报告分四段：Build / Host tests / Device tests / Unverified。

### 7.3 上机验证顺序（Device checklist，照此推进）
1. **冒烟**：上电串口出现启动日志、`tlb_app_init` 无 ERROR；观察 heap/任务是否正常。
2. **扫描**：link 任务按 MAC `84:16:5C:75:51:B9`（随机静态, type=1）能否扫到 —— 扫不到先排查：车辆蓝牙钥匙页是否开、特斯拉官方 App 是否在线占坑（车辆 BLE 钥匙连接数通常限 3，**测前杀掉官方 App 后台并断开其蓝牙**）。
3. **连接**：connect → 停扫 → 600 ms → 服务发现 → 订阅 0x0213（**INDICATE**）→ MTU 协商逐段看日志。
4. **TIB/bond**：security initiate 是否触发、NVS 是否落 bond。
5. **会话握手**：SessionInfoRequest/SessionInfo 收发（对照 §5.3 字段）；`KEY_NOT_ON_WHITELIST(=1)` → 进入绑卡流程。
6. **绑定**：明文 WhitelistOperation(addKey, PRESENT_KEY) → 车回 `WAIT(1)` → **刷实体 NFC 钥匙卡** → `whitelistOperationStatus OK`。
7. **RKE**：LOCK/UNLOCK 加密信封；再试 20/29/30（29/30 依车辆固件版本可能不支持，失败文案要可读）。
8. **鲁棒性**：拉黑距离/断电 → 观察自动重连；重启 → counter 不回退；重复绑定请求的幂等。

### 7.4 判读资料
`FAULT_*`、`OperationStatus_E`、`WhitelistOperation_information_E` 三张判读表：`f:\Desktop\test\tesla-ble-probe\README.md` §4（含「出现时该怎么办」）。固件日志全中文、无数字错误码——与探针文案逐字一致，可直接套用该判读表。

### 7.5 已知不确定项（真机才能定论）
1. NimBLE 对 0x0213 **INDICATE** 订阅 + 2B 大端长度前缀粘包的实测时序（安卓上探针唯一硬赌注是 CCC 写入，ESP 侧能力存在，但 MTU=247 协商与 indicate 拥塞需实测）。
2. 车辆临时公钥是否轮换（过期表现为解密校验失败类文案，重新握手即可）。
3. 压缩点：车辆若发 33 字节压缩公钥，我方 P-256 解点未实现（探针同样拒绝）。
4. RKE 29/30 动作号与车辆固件版本相关。
5. 官方 App / 其它手机钥匙占坑导致连接被拒的文案与恢复路径。

---

## 8. 流程红线（仍然有效）

1. **不 commit、不 push**，除非用户明确要求（当前 HEAD `4368fb4` 已推送，工作区干净）。
2. **未经授权绝不烧录**；检测到手设备 ≠ 授权；刷 NVS 破坏性必须事先说明（§7.2）。
3. 探针 `tesla-ble-probe\` 与 `ref-repos\` 全部**只读**；`ai-passport\main\**` 禁区。
4. 相关 skill 按需调用：`passport-device-test`（刷机与验收流程）、`passport-debug`（运行时故障诊断：reboot/断言/看门狗/无日志）。
5. 交付按四段报告；本文件 §0 每轮收尾更新。

---

## 9. 维护本文档（硬性要求）

- 新功能/新页面/新按键语义/新依赖/新工具脚本/新环境路径/新未验证项 → 同步更新对应小节；§0 快照（分支、提交、产物大小、四类测试结果）收尾必改。
- 新确认/推翻的字段号、枚举、加密口径 → 写回 §5，避免二次调研。
- 硬件调试每完成一步 checklist（§7.3）→ 把结果记入 §0「真机测试」行（如 `PART: 1-5 PASS, 6 待 NFC 卡`）。
- 与仓库文档冲突时以 `AGENTS.md` 路由表指向的权威文档为准，并回来修正本文件。

---

## 10. 参考项目与文档（全部已就位，按角色用）

| 项目 | 路径 | 角色 | 关键入口 |
| --- | --- | --- | --- |
| **tesla-ble**（C++/nanopb） | `f:\Desktop\test\ref-repos\tesla-ble\` | **wire 格式金标准**（唯一权威参考实现） | `generated\include\{universal_message,signatures,vcsec,keys}.pb.h`（字段号/tag 全表）、`src\message_builders.cpp` / `crypto_context.cpp`（构造/加密）、`tests\CMakeLists.txt`（17 个 gtest 文件）、`AGENTS.md`（4 空格/同例行花括号/clang-format 风格） |
| **vehicle-command**（Go） | `f:\Desktop\test\ref-repos\vehicle-command\` | Tesla 官方系 VCSEC 协议的 Go 实现，交叉验证派生/签名细节 | `pkg\protocol\key.go`、`pkg\vehicle\vcsec.go`、`examples\ble\main.go` |
| **esphome-tesla-ble** | `f:\Desktop\test\ref-repos\esphome-tesla-ble\` | ESPHome 封装的 BLE 钥匙组件，ESP 侧集成参考 | `packages\`、`AGENTS.md` |
| **tesla-key-esp32** | `f:\Desktop\test\ref-repos\tesla-key-esp32\` | 完整 ESP32 C++ 工程（BLE client/NVS/crash 诊断），**调试手法可借鉴**（`diag_crash`、`stack_watch`、`heap_trend`） | `main\ble_client.cpp`、`docs\ARCHITECTURE.md`、`docs\SECURITY.md` |
| **tesla-ble-probe**（uni-app） | `f:\Desktop\test\tesla-ble-probe\` | **文案与协议判定的来源**（我方逐字节移植对象） | `src\protocol\v3\{spec,codec,handshake,aead}.js`、`README.md` §4 判读表、`tests\run.mjs` |
| **ai-passport**（基线仓） | `f:\Desktop\test\ai-passport\` | 板级组件 `components\bsp` 提供者；硬件文档权威（`docs\hardware-design\`、`AGENTS.md`）；**main/** 禁区 | `components\bsp\include\bsp_pins.h`、`docs\development\ai-guide.zh_CN.md` |

外部权威来源（引用过，别再翻）：

| 来源 | 用途 |
| --- | --- |
| `trifinite/vcsec-archive` → `VCSECv3.10.14.proto` | 字段号、枚举数值权威表（ref-repos/tesla-ble 的 proto/ 与之同源） |
| gist `LexNastin/fc55736f…` | 端到端绑定 + 加密指令样例报文逐字节核对 |
| `teslabtapi.com/docs/start`、`/docs/more/rke` | GATT、长度前缀、BLE 命名规则、RKE 枚举 |
| BLE 广播名规则 | 新车 `Tesla ` + VIN 后 6 位；老车 `S`+`SHA1(VIN)`hex 前 16 位+`C|R|D|P`（我方按 MAC 直扫，不用名字） |

---

## 11. 历史阶段存档（简）

前一阶段交付过 **ai-passport 仓内的 LVGL 钥匙 UI 应用**（`feature/tesla-key`，提交 `60461f1`，UI 状态机/绑定向导/Noto 中文字体子集管线），主机测试全过、同样未上真机。该应用与本 BLE 固件是两条线：**当前调试对象是 §0 的 tesla-offline-ble（headless），UI 应用不在本次范围内**。涉及 UI 的历史细节（字体再生成命令、UI 布局规范）见 ai-passport 仓 `main\tesla_*` 与 git 历史，勿在本工程里复刻。
