# 特斯拉离线 BLE 车钥匙（FoloToy AI Passport）

在 FoloToy AI Passport 开发板（ESP32-C3）上实现的特斯拉离线蓝牙钥匙：不依赖手机和网络，直接与车辆 BLE 通信，完成绑定、会话握手与 RKE（上锁 / 解锁 / 驾驶授权）。已实车验证可用。

> 完整的项目上下文、协议金标准与逐条操作 SOP 见 [tesla-key-context.md](tesla-key-context.md)。
> 本文所有路径都**相对仓库根（本文件所在目录）**，不含盘符 —— 换电脑、换盘符，命令一字不改。

## 目录结构

| 目录 | 状态 | 说明 |
| --- | --- | --- |
| `tesla-offline-ble\` | **已实现** | ESP-IDF 固件（本项目的主体），刷机说明见下 |
| `tesla-ble-probe\` | **已实现** | uni-app 手机探针（协议文案与判定的来源），用 HBuilder X 调试 |
| `ai-passport\` | 参考基线 | FoloToy AI Passport 官方仓副本：板级组件 `components\bsp` 的提供者、硬件文档权威；**只读，`main\` 是禁区** |
| `ref-repos\` | 参考资料 | 四个特斯拉 BLE 协议参考开源仓，逐个见下文 |
| `tesla-key-context.md` | 文档 | 项目上下文 / 操作手册（环境、协议、验证记录、手动烧录 SOP §7.8） |

---

## 一、tesla-offline-ble（固件）与刷机说明

ESP-IDF v5.5.3 工程（目标芯片 ESP32-C3，8 MB flash）。源码位于 `application\main\`（应用与 UI）、`components\tesla_core\`（协议/加密，主机测试金标准）、`components\tesla_ble\`（NimBLE 链路）、`tools\`（字库生成等脚本）。

### 刷机前提

1. 本机已安装 **ESP-IDF v5.5.3**（不在仓库内，各机自装；`https://github.com/espressif/esp-idf`，国内可用 Gitee 镜像 `https://gitee.com/EspressifSystems/esp-idf.git`）。
2. 用**数据线**把板子插到电脑 USB 口。板子走原生 USB-Serial-JTAG（`USB\VID_303A&PID_1001`），**全程不需要按 BOOT 键**。
3. 在**仓库根**打开 PowerShell。

### 三条红线（动手前必须记住）

1. **只做分件刷 app**：只写 `0x0`（bootloader）、`0x8000`（分区表）、`0x10000`（app）三个区间，**擦除范围不碰 `0x9000`（NVS）** —— NVS 里存着本车绑定密钥、会话 counter 和 bond，动了它设备就立刻不再是已绑定钥匙，必须人和实体 NFC 卡都在车边重新绑定。
2. **绝不执行** `erase-flash`、`erase-region 0x9000`、`write_flash 0x0 <整片 bin>`。
3. **每次刷前先备份 NVS**（下面步骤 3）—— 唯一后悔药，30 秒的事。

### 刷机步骤

以下命令都在仓库根执行；`COMx` 用步骤 0 现查到的端口号替换，`<你的 IDF 目录>` 换成你机器上 ESP-IDF 的安装位置。

**步骤 0：现查串口**（端口号随电脑和 USB 口变化，别凭记忆抄）

```powershell
[System.IO.Ports.SerialPort]::GetPortNames()
Get-PnpDevice | Where-Object { $_.InstanceId -match 'VID_303A' } | Select-Object Status,FriendlyName,InstanceId | Format-Table -AutoSize
```

看到 `USB JTAG/serial debug unit` 对应的端口即本次的 `COMx`。

**步骤 1：激活 IDF**（每个新窗口都要跑一次）

```powershell
. <你的 IDF 目录>\export.ps1
```

报「找不到工具链」时先补一句：`$env:IDF_TOOLS_PATH = '<你的 IDF 目录>\tools'`。
自检：`idf.py --version` 应输出 `ESP-IDF v5.5.3`。后面步骤都在同一个窗口里跑。

**步骤 2：构建**

```powershell
idf.py -C tesla-offline-ble build
```

成功标志：`Project build complete.`。刷前核对产物是新的：

```powershell
Get-ChildItem tesla-offline-ble\build\tesla-offline-ble.bin | Select-Object Length,LastWriteTime
```

**步骤 3：备份 NVS（必做）**

```powershell
python -m esptool --chip esp32c3 -p COMx --baud 921600 --before default_reset --after hard_reset read_flash 0x9000 0x6000 "nvs-backups\nvs-before-$(Get-Date -Format yyyyMMdd-HHmmss).bin"
```

成功标志：`Wrote 24576 bytes`。备份落在仓库内 `nvs-backups\`（已被 `.gitignore` 忽略，含设备私钥，绝不入库）。这条命令会顺带复位板子一次，属正常。

**步骤 4：烧录**

```powershell
idf.py -C tesla-offline-ble -p COMx flash
```

成功标志：三个区间各出现一次 `Hash of data verified.`（共 3 次）。日常只改应用代码时可用更快的 `idf.py -C tesla-offline-ble -p COMx app-flash`（只写 `0x10000`）；改了分区表或 flash 相关配置则必须走完整 `flash`。

**步骤 5：串口自检**

```powershell
idf.py -C tesla-offline-ble -p COMx monitor
```

- 退出按 `Ctrl + ]`；`monitor` 与 `flash` 互斥（独占同一串口），要再刷先退出。
- 判读：启动日志无 panic / 看门狗；开机 t≈0.3 s 按 MAC 命中并发起连接；提示符 `tlb> ` 可敲 REPL，只读安全命令：`status` / `probe` / `version` / `help` / `scan`。
- **有副作用的命令**（`bind`、`rke <n>`、`forget`、`wipe_legacy`、`disconnect`）敲前自己确认 —— `rke` 是对真车发指令，动作号必须回查 [tesla-key-context.md](tesla-key-context.md) §5.7（`0=解锁 1=上锁 20=驾驶授权 29=自动落锁 30=唤醒`）。

**出问题怎么办**：端口打不开 → 回步骤 0 现查；`Connecting...` 超时 → 关掉占用串口的程序、重插 USB；刷完 `keyId` 变了 → 用步骤 3 的备份 `write_flash 0x9000` 写回。完整故障处置表见 [tesla-key-context.md](tesla-key-context.md) §7.8。

---

## 二、tesla-ble-probe（uni-app 探针）

uni-app 纯 JS 工程，是固件协议文案与判定的来源（`src\protocol\v3\{spec,codec,handshake,aead}.js` 为逐字节移植对象）。

**本项目不在这里写它的操作说明**：该程序需配合 **HBuilder X** 调试（真机/模拟器运行 uni-app），直接用 HBuilder X 打开 `tesla-ble-probe\` 目录即可。

---

## 三、ref-repos（参考仓）

四个特斯拉 BLE 钥匙相关的开源参考仓，**全部只读**，仅作协议交叉验证与实现参考：

| 项目 | git 地址 | 内容与用途 |
| --- | --- | --- |
| **tesla-ble**（C++/nanopb） | `https://github.com/wilonz/tesla-ble` | **wire 格式金标准**（唯一权威参考实现）。proto 生成的字段号/tag 全表在 `generated\include\`（universal_message / signatures / vcsec / keys），报文构造与加密见 `src\message_builders.cpp`、`src\crypto_context.cpp`，另有 17 个 gtest 文件的测试工程。 |
| **vehicle-command**（Go） | `https://github.com/teslamotors/vehicle-command` | Tesla 官方系 VCSEC 协议的 Go 实现。用于交叉验证密钥派生与签名细节，关键入口 `pkg\protocol\key.go`、`pkg\vehicle\vcsec.go`、`examples\ble\main.go`。 |
| **esphome-tesla-ble** | `https://github.com/yoziru/esphome-tesla-ble` | ESPHome 封装的特斯拉 BLE 钥匙组件，ESP 侧集成方式的参考。 |
| **tesla-key-esp32** | `https://github.com/0Bu/tesla-key-esp32` | 完整的 ESP32 C++ 车钥匙工程（BLE client / NVS 存储 / crash 诊断）。调试手法可借鉴：`diag_crash`、`stack_watch`、`heap_trend`（见 `main\ble_client.cpp`、`docs\ARCHITECTURE.md`、`docs\SECURITY.md`）。 |

---

## 四、其它

- `ai-passport\`：FoloToy 官方硬件基线（上游 `https://gitee.com/FoloToy/ai-passport`），提供板级 BSP 组件与硬件文档；本工程只引用其 `components\bsp`，**不改它的 `main\`**。
- 本目录整体是一个 git 仓（远端 `https://github.com/chen970526/ai-passport-test.git`），上述子目录都是它的普通子目录。
- `nvs-backups\`、`logs\`、`build\` 等产物目录已在 `.gitignore` 中忽略；NVS 备份含设备私钥，**绝不入库、不进云盘**。
