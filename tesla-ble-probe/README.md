# Tesla BLE 离线钥匙可行性探针（uni-app）

**这个工程只做一件事：验证「特斯拉开放的 BLE 离线钥匙协议（VCSEC）」能不能在一台安卓手机上，用 uni-app + 其自带的原生蓝牙 API 跑通。**

跑通 = 能绑定车辆 → 能协商出会话密钥 → 能发出被车辆实际执行的**上锁 / 解锁**指令。

**解锁不等于能开走**：解开的是中央锁，挂挡要的是**驾驶授权（RemoteDrive）**，官方把它算作又一条独立命令（F24）。第四轮真机给出了答案 —— **这台车接受 BLE 发 `REMOTE_DRIVE`**，按完授权再上车就能挂挡。所以现在**解锁成功后会自动补发一条**（`vehicle-api.js:unlockAndDrive()`，F25），不用上车再点第二次；单独那颗按钮仍然保留（手册口径授权窗口约两分钟，窗口过了或那一次被拒时用它重试）。被拒时本项目原样上报车端回执（尤其 `GENERICERROR_NOT_ALLOWED_OVER_TRANSPORT(7)` → 只能改走 Fleet API 的 `remote_start_drive`），**绝不替车辆模拟一个「启动成功」**。

它不是产品：私钥明文存在 App 沙箱、UI 只有按钮和日志、错误提示直给。
**只在真机（App / Android）上有效**，H5 与小程序拿不到蓝牙 GATT，代码里会直接抛「只能在 App 真机上运行」。

两件事和初版不同，先记住：

- **只保留一套协议：V3（官方 vehicle-command 现行 `RoutableMessage`）**。早期那套「VCSEC 直连 + counter 当 nonce」的报文实测在这代车机上拿不到有效响应，已连同当年的 `actions.js`、`spec.js` 和启动选版本页一起删掉；现在各页面直接就是 V3 流程（§2.1、F12–F13、F18–F21）。
- **② 扫描连接改成「广播手选」**：车辆蓝牙名被车机或手机改过时（如 `Tesla Model Y 小米YU7`），按 VIN 算出来的名字必然匹配不上；现在会把 12 秒内扫到的广播全部列出来，按「命中VIN / 0211 服务 / dBm」排序让人点（F5.1）。
- **绑定过一次之后就再也不用手选，也不用重开 App**：③ 绑定成功当刻把「车辆蓝牙地址 + 广播名 + VIN + keyId」写进绑定档案（`tesla_probe_bind_v1`），`App.vue:onShow` 启动自动重连循环 —— 前台期间按 3 → 6 → 12 → 24 → 30 秒退避持续试连，走到车边那一轮自己就连上了（F22）。在此之前，每开一次 App 都要重走「扫描并连接」，等于这台探针每天不能用；而「打开时只试一次」同样不能用：人离车还有几十米就点开 App，那一次必然连不上。

**协议覆盖范围也已经扩了一次**：从「只有 VCSEC 域」变成 **VCSEC + INFOTAINMENT（车机 / `car_server`）两个域**，两边各有各的会话与 counter（F21）。页面随之分成两类：**日常用的是底部五个 tab（车辆 / 控制 / 温度 / 信息 / 诊断，由自定义组件 `tf-tabbar` 承担，见 F23）**，**「① 扫描连接 → ② 动作测试 → ③ 报文控制台」这套向导三件套是绑定与排障用的**（F21、§5）。

**命令侧也扩了一次**：VCSEC 域不再只有上锁 / 解锁 / 闭锁器 —— 「解锁后挂不上挡」要的是**驾驶授权（`RKE_ACTION_REMOTE_DRIVE = 20`）**。它在**协议层**始终是独立的一条（官方 SDK 与 CLI 都没有「unlock 顺带发 drive」的路径，F24）；在**交互层**，第四轮真机证明这台车接受 BLE 发它之后，本项目才把「解锁终态成功 → 紧跟着补发一条授权」串起来（`unlockAndDrive()`，F25）。同一轮还揪出并修掉了一个自家缺陷：**授权之后锁车要按两次才生效**，根因是 VCSEC 域的重发复用了同一份字节、counter 没前进（F18「按域分岔」+ F25）。

**当前真机进度（HW4/V3、2025.44、Model Y）**：① 收发通路 → ② 明文查询 → ③ **绑定成功** → ④ **上锁成功、前备箱成功**；解锁曾一直回 `operation_status=WAIT`，根因是 protobuf oneof 成员的编码（见 F13「protobuf 坑」与 §10 末尾），已修并等复测。**车机域（INFOTAINMENT）第三轮上车：`GetVehicleData` 六类各发一条，六类全部带回真实数据**（电量 59%、充电已充 61.1kWh、车外 32℃、档位 P、里程、GCJ 坐标「张槎街道古新路70号」、四轮胎压）。**前两轮拿不到数据的根因不同，且都已定位**：第一轮的 `响应解密失败：响应没有 payload` 死在我方（`decryptResponse` 发明了一条协议里不存在的约束，见 F13「响应侧」）；第二轮车辆自己写明原因 —— `fault=25 RESPONSE_MTU_EXCEEDED` + `密文=0B`（**答案太大，车机直接不发响应体**），因为我方把六个类别塞进了同一条 `GetVehicleData`。本轮按官方口径做了四件事：**每类一条独立请求再合并**（`state.go:70-82`，没有任何参考实现一次问多类）、**协议层错误帧判终态**（不再拿它试解密、不自动重发，`error.go:195-198` + `error_test.go:62-65`）、**响应归属三条闸门**（真机第二轮那条「成功：actionStatus=OK」其实是 VCSEC 的周期广播帧被当成了响应，`dispatcher.go:252-293`）、**先订阅再谈 MTU 并回读实际协商值**（`ble.go:345/349/354`，分包上限 `min(mtu,1024)-3`）。**四件事都被第三轮日志正面验证**：`fault=25` 再没出现；实际 MTU 反推 ≈247（`已有 244 / 需要 380` → `响应 378 字节`，即 380 字节帧跨两包正常重组，单帧 209~232 字节的五类不需重组）；该域的会话密钥**首次拿到正面证据**（连续 6 帧 GCM 解密成功、counter 12→17 有序）；收尾时又抓到一条 VCSEC 周期广播帧，这次被判成「无人等待的响应（车辆主动上报？）」而不是冒充响应。**第三轮同时暴露一个文案口径 bug 并已修**：结果行写成「6 类各发一条，**7** 类带回数据」，因为「带回数据」按**合并后的字段数**在算，而车辆回包 ① 问 `drive` 那一条会**顺带**塞回 `location_state`、② 每条 `vehicleData` 尾部都带一个官方 `vehicle.proto` 里没有的字段 999（值恒 1，本项目原样显示成 `f999=1`）；现在按**类别**计数。**车机域第一次「执行动作」成功：充电盖板真机开 / 关都成（盖真的动了）**，这条走的是 `car_server.VehicleAction{chargePortDoorOpen/Close}`（`1203f20300` / `1203ea0300`）。**只剩 `Ping` 仍未上车验证**（见 §11 第 8、9 条）。**第四轮真机（同车）新增两条现场结论**：① **驾驶授权（RemoteDrive）在 BLE 上被这台车接受** —— 按完之后上车能挂挡，于是解锁开始串发它（F25）；② 授权之后**锁车要按两次才生效**，查证是我方重发语义错了（VCSEC 域把同一份字节发了两遍，counter 没前进，车辆按 `protocol.md:547-549` 把重复 counter 的帧当旧包丢掉），已修并上回归锁（F18、F25）。

---

## 0. 给评审者（人或 AI）的一段话

请重点判断的不是「密码学对不对」（这部分已用 Node 原生 `crypto` 逐字节对拍，见 §6），而是下面 4 个**只有真机能回答**的问题：

| # | 待判定问题 | 卡在哪 | 如果不行，退路 |
| --- | --- | --- | --- |
| Q1 | `uni.notifyBLECharacteristicValueChange` 能否真正打开 0213 的 CCC 描述符（0x2902 = indicate） | uni 不暴露手写描述符 | 见 §9 三级方案 |
| Q2 | `uni.setBLEMTU` 能否把 MTU 谈到 ≥ 帧长+3（响应里有 65 字节临时公钥） | 部分栈只在连接瞬间允许一次 MTU 请求 | 同上 |
| Q3 | `uni.writeBLECharacteristicValue` 一次能否写完整帧（≈40–110B），不做 ATT 分片 | ~~特斯拉 VCSEC 不接受跨 ATT PDU 的分片写~~ **此假设已被官方 `ble.go` 推翻**：车端就是按 `min(MTU,1024)-3` 分片收、靠长度前缀重组 | 已按官方规则实现分包写（F7）；抬高 MTU 只对**读方向**仍是硬需求 |
| Q4 | Android 12+ 上，uni 的 BLE 全套 API 在运行时权限（SCAN/CONNECT）下的行为是否与 targetSdk 匹配 | 基座 targetSdk 由云打包决定，不一定等于 manifest 写的值 | 已改成运行时 `SDK_INT` 探测（§3 的 F2） |

**Q1–Q3 在第三轮真机（HW4/V3）里已经有了现场答案**：0213 的通知通道可用（一次 `GetVehicleData` 的 6 帧响应全部到达）、MTU 从分包反推 ≈247 且 **380 字节的响应跨两包重组成功**（`已有 244 / 需要 380` → `响应 378 字节`）、187 字节的请求**单帧写完**且全程无重发。Q2 里「谈到 ≥ 帧长+3」这个提法本身已被现场改成正确口径：**不需要**一包装下整帧，长度前缀 + 重组就够（见 F18「传输层配套」与 §11 第 9 条）。Q4 与 BLE 无关，仍未判定。

协议侧的风险点（与 uni 无关，属「方案本身」）：counter 单调递增不可回退、**且两域各一份不可混用**（见 F21）、白名单槽位有限（约 3 把 BLE 钥匙）、临时公钥是否轮换。见 §8。

---

## 1. 可行性判定标准（四档，出门测之前先记住）

| 档位 | 现象 | 结论 |
| --- | --- | --- |
| ① 弱证据 | 能扫到车、能 `createBLEConnection`、能枚举出 `0211/0212/0213/0214` | 只证明 uni 的 BLE **连接层**能用，协议还没开始 |
| ② 中通证据 | 连接后点「读 0214 版本」能读到字节；点「查白名单」能收到车辆回包并解出 `whitelistInfo` | 证明 **收发通路 + INDICATE 订阅 + 分帧重组**在 uni 下成立。这一步**不需要密钥、不需要刷卡、不占槽位** |
| ③ 强证据 | 「③ 绑定」发完加白名单请求、刷钥匙卡并用车机屏幕确认后，**点「④ 探针确认」能建起 VCSEC 会话**（车辆回 `SessionInfo.status = OK`）。拿到 `whitelistOperationStatus` 终态只是锦上添花——量产固件通常不回它 | 证明**协议实现被车辆接受**（组包、字段号、formFactor、权限表全对） |
| ④ 端到端 | 「协商临时公钥」拿到 65B 点 + 「解锁 / 上锁」回 `status=OK` **且车真的动了** | 方案成立，可以继续做产品化 |

**只有 ② 失败才是 uni 的能力问题；③/④ 失败一般是协议或业务状态问题**（判读表见 §7.3）。

---

## 2. 目录结构与分层

```
tesla-ble-probe/
├── main.js / App.vue / pages.json / manifest.json   uni-app 工程四件套（Vue3；pages.json 的 globalStyle 是深色 #0f1317）
├── pages/                      pages.json 按下面这个顺序注册 10 页，首页是 pages/home/home；**没有 tabBar 字段**
│   ├── home/home.vue            车辆（tab）：电量 / 续航 / 挡位 / 锁状态 + 功能列表 + 快捷动作
│   ├── control/control.vue      控制（tab）：俯视车身图 / 车锁与寻车 / 驾驶授权（F24）/ 前后备箱 / 充电盖板 A、B 对照 / 空调与车窗（F21）
│   ├── climate/climate.vue      温度（tab）：空调读数与一键启停
│   ├── info/info.vue            信息（tab）：里程 / 胎压 / 位置等只读读数
│   ├── diagnostics/diagnostics.vue  诊断（tab）：动作台账 + 盖板 A/B 只读对照 + 运行日志
│   ├── binding/binding.vue      绑定与钥匙：本机密钥 / 绑定档案 / VIN / 钥匙类型 / 绑定顺序（F11、F22；不是 tab，从首页列表进入）
│   ├── index/index.vue          ① 扫描连接（广播手选弹窗）+ 蓝牙就绪 + 排查按钮：旧的绑定向导三件套之一
│   ├── rke/rke.vue              ② 动作测试：握手 / RKE / 闭锁器 / 车机域动作 / 连发压测（由 ① 页按钮进入）
│   ├── debug/debug.vue          ③ 报文控制台：手工组包、原始帧收发、报文解析、规格速查（排障用）
│   └── car-control/car-control.vue  ④ 旧车控页：「控制」tab 的前身，动作与调用链相同、只有界面不同；入口在诊断页「界面对照」那一格
├── components/
│   ├── tf-tabbar/tf-tabbar.vue     底部导航（车辆 / 控制 / 温度 / 信息 / 诊断五个 tab），切页用 uni.reLaunch
│   ├── tf-icon/tf-icon.vue         按名取图标，唯一数据源是 src/ui/icons.js（内联 SVG 编成 data URI）
│   ├── log-box/log-box.vue         全局日志窗口（清空 / 复制 / 自动滚底），自己订阅日志总线、自己退订
│   ├── car-icon/car-icon.vue       纯 CSS 车辆图标（lock/unlock/frunk/trunk/charge/car/info），零静态资源；仍被 rke 与 car-control 用
│   ├── slide-confirm/slide-confirm.vue  滑动到底才触发的确认条（给「发出去收不回」的开盖动作）
│   └── confirm-dialog/confirm-dialog.vue  二次确认弹窗（倒计时走完才允许点确认）
├── src/
│   ├── config/index.js             全站常量：存储键（含 VIN_STORE = tesla_probe_vin_v1，binding 页与 index 页共用）、日志上限、退避阶梯、扫描超时
│   ├── infra/                      只认识平台与字节，完全不认识协议
│   │   ├── bytes.js                字节 / hex / 大端整数工具
│   │   ├── crypto/                 sha1.js sha256.js aes.js p256.js  纯 JS 密码学（不依赖 BigInt / 不依赖任何原生模块）
│   │   ├── ble/                    uni-ble-api.js（uni 蓝牙 API 薄封装）· gatt.js（GATT UUID）· frame-codec.js（2 字节长度前缀与收帧重组）· mtu-manager.js（MTU 阶梯、分包上限）· device-matcher.js（广播匹配与排序）· ble-transport.js（BleTransport：扫描、连接、订阅、分包写、收帧、超时）
│   │   ├── logging/                log-bus.js（日志总线与订阅）· action-tracer.js（动作分段）
│   │   ├── platform/               notify.js（全站唯一的提示出口：「关闭 / 复制」弹窗）· permissions.js（Android 运行时权限）· runtime.js（基座自检、保持亮屏）
│   │   └── storage/local-store.js  readValue / writeValue / removeValue —— 全站唯一碰 uni.*StorageSync 的地方
│   ├── protocol/                   纯报文层
│   │   ├── pb.js                   手写 protobuf wire 编码 + 解码 + 结构化打印
│   │   ├── identity.js             与协议版本无关的公共件：BLE 广播命名（bleNamesForVin）、密钥对（newKeyPair）、keyIdOf
│   │   └── v3/                     spec.js（V3 字段号与枚举表：UniversalMessage / vcsec + **car_server / vehicle_data**）· constants.js · metadata.js（TLV 元数据）· handshake.js（SessionInfoRequest 与会话密钥）· aead.js（AES-GCM 会话加密、响应解密与认证）· codec.js（add-key 载荷与信封、car_server 动作）· summary.js（报文摘要）
│   ├── domain/                     会话之上的业务规则：connection-service（BLE 生命周期）· command-dispatcher（sendRequest：**按域分岔的重发语义**，F18/F25）· handshake-service · enrollment-service · auto-reconnect（**前台自动重连循环，F22**）· session-status（statusText）· response-hints（TAP_HINT / PAIR_HINTS / FAULT_HINT / GENERIC_ERROR_HINTS（车端 nominalError → 下一步该干什么；上锁 / 解锁 / 驾驶授权任何一条被拒都从这里取文案，F24/F25）/ mtuNote）· dispatch-policy · v3-context；index.js 只做具名再导出
│   ├── services/                   页面这一层唯一的门面
│   │   ├── index.js                页面只 import 这里：全部具名再导出，禁用 export *
│   │   ├── vehicle-api.js          对外动作（握手 / 刷卡绑定 / 加密指令 / 闭锁器 / **驾驶授权** / **解锁并授权驾驶（串发编排 unlockAndDrive，F25）** / **车机域动作** / 查询 / 重发编排），每个动作都过 tracked()；另向 ③ 控制台交出 toolkit() 整套编解码工具
│   │   ├── credential-service.js   清除本机密钥 / 绑定档案的编排
│   │   ├── vcsec/                  index.js · rke.js · closure.js · **drive.js（RemoteDrive 独立命令；这一层永不并入 Unlock，串发只发生在上层 vehicle-api.js，F24/F25）**
│   │   └── infotainment/           index.js · car-action.js · charge-port.js · flash-horn.js · hvac-auto.js · window-action.js · vehicle-data.js · ping.js
│   ├── store/                      app-state · credential-store（密钥对）· **v3-session-store（per-domain V3 会话，VCSEC / INFOTAINMENT 各一份落盘）** · bind-profile · vehicle-store（车辆状态视图模型）· diagnostic-store（动作台账）
│   └── ui/                         icons.js（全站唯一图标源）· format.js（ago / clock / yesNo 等读数格式）
└── tests/
    ├── run.mjs                       算法与协议对拍自测（Node，503 条断言）
    └── vue-check.mjs                 把 .vue 的 <script> 真 import 一遍做语法自检（17 个文件）
```

**零 npm 依赖**：`src/` 下全是自研纯 JS，HBuilder X 里不需要 `npm install`，也不需要任何原生插件。

分层原则：**协议层（`src/protocol/`、`src/infra/crypto/`、`src/infra/bytes.js`）完全不认识 uni，传输层（`src/infra/ble/`）完全不认识协议**。
所以将来换 Kotlin / Flutter 重写传输层时，只有 `src/infra/ble/` 那几件需要替代。

### 2.1 为什么只剩 V3 一套

早期版本同时保留了「VCSEC 直连」（`ToVCSECMessage` + 用 counter 当 nonce + AAD 空）和「V3 `RoutableMessage`」两套报文，并在启动页让人选版本。真机结果：直连那套的加密指令一律拿不到可解析的响应，而 V3 一路走通到「车辆明确回 `session_info.status`」，所以直连实现连同选版本页一起删掉了。现在 `pages.json` 首页就是 `pages/home/home`（当年那个向导页 `pages/index/index` 仍在册，从「绑定与钥匙」页进入），**没有版本选择这一步**。

现行这一套的要点（对应官方 vehicle-command 源码，本地副本见 `.hosttest/vc`）：

| 环节 | 报文 | 官方出处 |
| --- | --- | --- |
| 刷卡绑定（还没有会话） | 裸 `ToVCSECMessage{signedMessage{PRESENT_KEY}}`，首字节 `0x0a` | `pkg/vehicle/security.go:338 SendAddKeyRequestWithRole` |
| 建立会话 | `RoutableMessage{session_info_request(14)}` ↔ `RoutableMessage{session_info(15), signature_data}` | `internal/dispatcher/`、`pkg/protocol/protocol.md` |
| 下指令 | `RoutableMessage{protobuf_message_as_bytes=SignedMessage(AES_GCM_Personalized_data)}`，`12B 随机 nonce` + `AAD = SHA256(TLV 元数据 ‖ 0xFF)`（官方 `signer.go:159` 传的是 `meta.Checksum(nil)` —— **明文不进 AAD**，只有 HMAC 那条路才把消息体拼进去） | `pkg/protocol/authentication.go` / `session.go` |
| 会话状态 | `sharedKey` + `epoch` + `anchor(timeZero)` + `counter`（只增不减）——**按域各存一份**：VCSEC 落 `tesla_probe_v3_session_v1`、INFOTAINMENT 落 `tesla_probe_v3_infotainment_v1` | `dispatcher.go:36 sessions [Domain_MAX]Session`、`pkg/protocol/domains.go:7-13`、tesla-ble `include/peer.h` |
| RKE 动作（VCSEC 域） | `RKEAction_E` 只剩 0/1/20/29/30；**`REMOTE_DRIVE(20)` 是解锁之外的一条独立命令**（官方 SDK 与 CLI 都没把它并进 unlock，见 F24）；后备箱 / 前备箱 / 充电口改走 `ClosureMoveRequest` | `pkg/protocol/protobuf/vcsec.proto` |
| 车机动作（INFOTAINMENT 域） | `car_server.Action{vehicleAction}` → `car_server.Response{actionStatus, vehicleData/ping}`：盖板关 61 / 开 62、Ping 46、GetVehicleData 1 | `pkg/vehicle/infotainment.go:19-45`、`pkg/vehicle/state.go:38-86`、`car_server.proto` |

**唯一的例外是绑定**：加白名单发生在「还没有会话」的时刻，官方也是直接把这个老式信封交给 BLE 层（首字节 `0x0a` 而不是 `0x12`），所以与协议版本无关的那几件公共件各自留在固定位置 —— 2 字节长度前缀（`prependLength / stripLength`）在 `src/infra/ble/frame-codec.js`，GATT UUID 表在 `src/infra/ble/gatt.js`，BLE 广播命名与密钥对、keyId（`bleNamesForVin / newKeyPair / keyIdOf`）在 `src/protocol/identity.js`。

---

## 3. 功能点全清单（每个功能点：入口 → 调用链 → 接口 → 实现方式 → 判据）

> 表里的「uni 接口」全部是 uni-app App 端自带 API（无需插件）；「纯 JS」列是本工程自研实现。
> 旧版协议已删除，**F1–F25 全文只描述 V3 这一套**；F11 的绑定帧是唯一的例外（它天生不带会话，见 §2.1）。

### F1 运行环境自检（基座对不对 / 蓝牙模块进没进）

| 项 | 内容 |
| --- | --- |
| UI 入口 | 无按钮，App 启动时自动跑（`App.vue` 的 `onLaunch`） |
| 调用链 | `App.vue:onLaunch` → `src/infra/platform/runtime.js:logRuntimeEnv(log)` → `src/infra/logging/log-bus.js:log()` |
| 用到接口 | `plus.runtime.version / versionCode / appid / standalone`、`typeof plus.bluetooth` |
| 实现方式 | `plus.bluetooth` **只有在基座编译了 Bluetooth 模块时才存在**，所以它是「基座是否为新基座」的权威探针；`plus.runtime.standalone` 用来区分独立 App / 调试基座 |
| 成功标志 | 日志 `Bluetooth 模块已就绪（plus.bluetooth 存在）` + 基座版本号 |
| 失败判读 | `基座里没有 Bluetooth 模块` → 手机上还是旧基座，或 `manifest.json` 的 `modules` 被 HBuilderX 可视化界面回写清掉了（见 §5） |

### F2 Android 运行时权限

| 项 | 内容 |
| --- | --- |
| UI 入口 | ① 页「① 蓝牙就绪」（`step1`） |
| 调用链 | `index.vue:step1` → `src/infra/platform/permissions.js:ensureAndroidPermissions()` → `ble().init()` |
| 用到接口 | `plus.android.requestPermissions(perms, okCb, errCb)`；内部用 `plus.android.importClass('android.os.Build$VERSION').SDK_INT` 决定申请哪一套 |
| 实现方式 | **运行时探测而非写死**：`SDK_INT >= 31` 时在 `ACCESS_FINE_LOCATION` 之外追加 `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT`；否则只申请定位（老模型下申请未声明的新权限会被判「永久拒绝」，误导排障）。两套权限在 `manifest.json` 里**全部声明**，所以无论基座 targetSdk 是多少都不缺 |
| 成功标志 | `运行时权限已授予: [...]` |
| 失败判读 | `权限被拒绝: [...]` → 系统弹窗里选了「拒绝/始终拒绝」；Android 12+ 上定位被拒不影响，Android 11- 上定位被拒 = 扫描恒空 |
| 为什么这段是 JS | 改它**不需要重新打包基座**（热更新即可），所以现场可以根据日志直接调 |

### F3 打开蓝牙适配器

| 项 | 内容 |
| --- | --- |
| UI 入口 | 「① 蓝牙就绪」；「列出周围广播」「② 扫描并连接」内部也会先调一次 |
| 调用链 | `src/domain/connection-service.js:ble()` 拿单例 → `BleTransport.init()` |
| 用到接口 | `uni.openBluetoothAdapter({mode:'central'})`（失败时降级再试一次 `{}`）、`uni.getBluetoothAdapterState()` |
| 实现方式 | `src/infra/ble/uni-ble-api.js` 里的 `bleApi(name, opts)` 把 uni 的回调式 API 转 Promise，并在 `typeof uni[name] !== 'function'` 时抛「只能在 App 真机上运行」，用于识别 H5/小程序环境 |
| 成功标志 | `蓝牙适配器已开启 available=true discovering=false` |
| 失败判读 | 弹窗 `打包时未添加bluetooth模块` → 跑在标准基座上；`蓝牙不可用` → 系统蓝牙没开 |

### F4 VIN → 广播名（识别自己的车）

| 项 | 内容 |
| --- | --- |
| UI 入口 | ① 页 VIN 输入框（`@blur="saveVin"`，落盘 `tesla_probe_vin_v1`） |
| 调用链 | `src/domain/connection-service.js:namesForVin(vin)` → `src/protocol/identity.js:bleNamesForVin(vin)` → `src/infra/bytes.js:utf8ToBytes/toHex` + `src/infra/crypto/sha1.js:sha1` |
| 用到接口 | 无（纯 JS） |
| 实现方式 | 返回 `{exact:[], prefixes:[]}` 两组：<br>`exact` = `Tesla ` + **VIN 后 6 位**（2023-06-21 起的新命名，只需后 6 位）<br>`prefixes` = `S` + `SHA1(完整 VIN 的 UTF-8)` 的十六进制**前 16 位**（老命名，末位 C/R/D/P 未知 → 只能做前缀匹配，**必须完整 VIN**） |
| 已核对样例 | VIN `LRWYGCEJ0TC723591` → `Tesla 723591` / `S4adfe3eacbdb58b7`（与 App 日志输出一致，`node crypto` 独立复算过） |
| 失败判读 | 只填后 6 位时老命名规则失效（`prefixes` 为空，只剩 `Tesla ` + 后 6 位这一条精确名）；VIN 完全留空时自动路径直接抛 `请先填写 VIN…`，此时走 F5.1 手选 |
| **规则失效的情形** | 车辆蓝牙名在车机里改过（如 `Tesla Model Y 小米YU7`）、或手机系统里已配对并被缓存成新名字 → **按 VIN 算出来的名字根本匹配不上**。这不是 bug，是命名规则本身被人为改掉了；对策见 F5.1 的手选弹窗 |

### F5 BLE 扫描并命中目标车辆

| 项 | 内容 |
| --- | --- |
| UI 入口 | 「② 扫描并连接（手选）」（`step2` → 打开弹窗 → `rescan` / `pick` / `autoConnect`）；「列出周围广播」（`allAdvs` → `scanAll`） |
| 调用链 | 自动路径：`index.vue:autoConnect` → `src/domain/connection-service.js:connectTo(vin)` → `BleTransport.scan(names, 20000)`（命中即停）<br>手选路径：`index.vue:rescan` → `BleTransport.discover(12000, names, onFound)`（全量收集）→ `index.vue:pick(d)` → `src/domain/connection-service.js:connectTo(vin, d)`（**跳过名字匹配，直连指定设备**） |
| 用到接口 | `uni.onBluetoothDeviceFound(cb)`、`uni.startBluetoothDevicesDiscovery({allowDuplicatesKey:false, powerLevel:'high', interval:0})`、`uni.stopBluetoothDevicesDiscovery()`、`uni.offBluetoothDeviceFound()`（老版本无此 API，已 try/catch） |
| 实现方式 | 匹配逻辑抽成 `src/infra/ble/device-matcher.js:makeMatcher(names)`（可离线断言），四级：<br>1) `exact` 精确等值；2) `prefixes` 前缀；3) `normName()`（去掉所有非字母数字并转大写）后的等值，吸收 `Tesla 723591` / `Tesla_723591` / `tesla723591`；<br>4) 归一化后的前缀（`s4-adfe3eacbdb58b7-extra` 这类带后缀的老命名）；<br>另有一条独立旁证：广播**无名字**但 `advertisServiceUUIDs` 里带 `0211`（VCSEC 服务）→ 认作疑似车辆（`hasTeslaService`）；<br>名字含 `TESLA` 但没命中期望名 → 单独打 `warn` 把**真实广播名 + rssi** 打出来 |
| 成功标志 | `发现车辆 name=... (exact/prefix/loose/loose-prefix 命中 X) id=...` |
| 失败判读 | `扫描 20000ms 未发现目标车辆` → 车没在广播（人不在车边 / 车机蓝牙被关闭 / 车辆深度睡眠导致广播间隔很长）或**名字被改过**。后者用 F5.1 手选 |
| 排查按钮 | 「列出周围广播」用 `scanAll(10000)` 只收集不匹配，输出 `名字 + deviceId`（无名设备用 `(无名) + deviceId 后 8 位`，不折叠），并对期望名标 `★命中` |

### F5.1 广播手选弹窗（车辆蓝牙名被改过时唯一能走通的路）

| 项 | 内容 |
| --- | --- |
| UI 入口 | 「② 扫描并连接（手选）」→ 全屏弹层「选择要连接的设备」 |
| 调用链 | `index.vue:step2` → `picker=true` → `rescan()` → `BleTransport.discover(SCAN_MS=12000, namesForVin(vin), onFound)` → 点某一条 → `pick(d)` → `connect(d)` → `src/domain/connection-service.js:connectTo(vin, d)` |
| 用到接口 | 同 F5（不新增 uni API）；`discover` 内部仍是 `onBluetoothDeviceFound` + `startBluetoothDevicesDiscovery` |
| 实现方式 | `discover()` 与 `scan()` 的**唯一区别是不做「命中即停」**：把 12 秒窗口里看到的每个 `deviceId` 聚合进 `Map`（`name` 取最新非空、`rssi` 取最新、`tesla`/`hit` 一旦为真就保留），每来一批广播就 `onFound(排序后的快照)` 回调 → **列表边扫边长，不用等超时**。排序由 `src/infra/ble/device-matcher.js:sortAdv()` 决定 |
| 排序规则 | 命中 VIN(0) → 广播了 `0211`(1) → 有名字(2) → 无名(3)；同一档内按 RSSI 越接近 0 越靠前；缺 RSSI 当最弱处理。原数组不被修改 |
| 每条显示什么 | 广播名（无名则 `(无名) + deviceId 后 8 位`）、`deviceId`、标签：`命中VIN <mode>` / `0211 服务` / `<rssi>dBm` |
| 现场怎么选 | ① 优先点标了「命中VIN」的；② 没有就点标了「0211 服务」的（那是特斯拉 VCSEC 服务的硬证据，比名字可靠）；③ 两个都没有，就按 dBm 点离你最近的那个，连不上再换下一条 |
| 底部三个按钮 | 「重新扫描」（清空重扫，`scanning` 期间 `loading` 防重点）、「按 VIN 自动连」（回到 F5 的命中即停路径，没改过名的车一键更快）、「关闭」 |
| 守卫 | 还在扫描时点条目 → 弹窗「还在扫描，等一下再点」；上一步未完成（`busy`）→ 弹窗「上一步还没结束」；`connectTo(vin, device)` 只要收到 `device` 参数就**完全跳过 `scan()`**（`src/domain/connection-service.js:connectTo`），因此手选路径下 VIN 留空也能连上；VIN 为空只在自动路径里报错 —— `请先填写 VIN（需要后 6 位才能匹配广播名），或在扫描列表里手选设备` |
| 一个诚实的提醒 | 手选解决的是「**匹配不上名字**」。若日志显示已经 `发现车辆 … connecting` 之后才 `disconnected` / `getBLEDeviceServices:fail no connection`，那失败点在**连接层之后**，与名字无关——按 §8.5（3 台钥匙上限、官方 App 抢连接）和 F6 的失败判读（车机休眠 / 距离）排查 |

### F6 GATT 连接 + 停扫 + 断连监听

| 项 | 内容 |
| --- | --- |
| 调用链 | `src/domain/connection-service.js:connectTo(vin, device)` → `src/infra/ble/ble-transport.js:BleTransport.connect(device)` |
| 用到接口 | `uni.createBLEConnection({deviceId})`、`uni.stopBluetoothDevicesDiscovery()`、`uni.onBLEConnectionStateChange(cb)` |
| 实现方式 | 三条来自实测经验的硬规则写死在 `src/infra/ble/ble-transport.js` 的头注释：<br>**A** 连上立刻停扫（Android 边扫边连会掉包/断连）；**B** 所有 write 排队串行，绝不在 BLE 回调里再 write；**C** 一次 ATT 通知只装一个 PDU，必须抬 MTU 否则 65B 响应收不全。<br>连上后 `delay(600)` 再枚举服务（Android 需要时间），然后依次 `discoverServices() → subscribe() → negotiateMtu()`。**这个顺序照官方**（`ble.go:345` 先 Subscribe、`:349` 才 ExchangeMTU）：先改包大小再订阅时，协商期间车辆推上来的第一帧会落在还没开 notify 的特征上，丢的半截要靠 2 字节长度前缀重新对齐，现场表现正是「已丢弃 N 帧 / 响应 GCM tag 不符 / 等待终态超时」 |
| 成功标志 | 状态机 `connecting → connected`（页顶 `BLE=connected`） |
| 失败判读 | `连接已断开（车辆 3 台钥匙上限 / 车机休眠 / 距离都可能是原因）`；`没找到特斯拉 VCSEC 服务 0211，实际服务: ...`（会把真实服务 UUID 全列出来） |

### F7 MTU 协商

| 项 | 内容 |
| --- | --- |
| 调用链 | `BleTransport.negotiateMtu()` → `src/infra/ble/mtu-manager.js:negotiateMtu()` |
| 用到接口 | `uni.setBLEMTU({deviceId, mtu})`（**只有 Android 有**，iOS 系统自动协商）、`uni.onBLEMTUChange(cb)`（车辆侧回读真实值） |
| 实现方式 | 从大到小依次试 `517 → 247 → 185 → 128 → 64`，任一成功即返回；全部失败只 warn，不抛（保证小包查询仍能跑）。**记的一定是实际值**：`setBLEMTU` 的 success 若带回 `mtu` 就用它，否则用请求值；另外 `onBLEMTUChange`（按 `deviceId` 过滤）任何时候都会覆盖 `this.mtu`。官方只做一次 `ExchangeMTU(库上限)`（`ble.go:349`），0Bu 把首选钉在 247（`ble_client.cpp:201`、`sdkconfig.defaults:61-62`）再用 `BLE_GAP_EVENT_MTU` **回读真实协商值**（`ble_client.cpp:1024-1030`）—— 车辆完全可以只接受比请求更小的 MTU，按请求值记账会让分包算错、响应被截。官方那个「库上限」（`ble.MaxMTU`，来自第三方 go ble 库，本仓库未 vendor）本地拿不到，所以按 Android ATT 常见上限阶梯试探，**不自造数字** |
| 成功标志 | `MTU 协商 = 517，每包载荷上限 514 字节`（数值随栈而变，以日志为准；只要不是下面那行 warn 就算成）。第三轮真机上没有这两行（日志是连接之后清过才开始记的），只能从分包反推 ≈247 —— 见 §11 第 9 条 ① |
| 失败判读 | `按 MTU=23 工作；超过 20 字节的响应可能被截断` → 后续 RKE 会出现 `FAULT_SIGNATURE_TOO_SHORT`，临时公钥协商必然失败。属 **Q2 风险点**，见 §9 |

### F8 服务/特征发现

| 项 | 内容 |
| --- | --- |
| 调用链 | `BleTransport.discoverServices()` → `src/infra/ble/gatt.js:GATT` + `src/infra/ble/uni-ble-api.js:matchUuid` |
| 用到接口 | `uni.getBLEDeviceServices({deviceId})`、`uni.getBLEDeviceCharacteristics({deviceId, serviceId})` |
| 实现方式 | `matchUuid` 同时接受 16 bit 短 UUID（`0211`）与 128 bit 长 UUID、大小写混排，靠「短的是长的前缀」判定 |
| GATT 表 | Service `00000211-b2d1-43f0-9b88-960cebf8b91e`；写 `0212`；INDICATE `0213`；READ `0214`（版本） |
| 成功标志 | `服务 0211 已就绪 write=0212 indicate=0213 read=0214` |
| 失败判读 | `0212/0213 特征不全，无法收发 VCSEC 报文` |

### F9 订阅 0213（INDICATE）+ 收帧重组 —— **Q1 关键点**

| 项 | 内容 |
| --- | --- |
| 调用链 | `BleTransport.subscribe()` → `uni.onBLECharacteristicValueChange` → `onChunk()` → `deliver()` |
| 用到接口 | `uni.notifyBLECharacteristicValueChange({deviceId, serviceId, characteristicId, state:true})`、`uni.onBLECharacteristicValueChange(cb)` |
| 实现方式 | uni 只能表达「开/关通知」，**无法手写 CCC 描述符**（0x2901 notify / 0x2902 indicate）。特斯拉用的是 **indicate**。收到 chunk 后先交给 `src/infra/ble/frame-codec.js:FrameReassembler`（拼在它的 `buffer` 里），再按 **2 字节大端长度前缀**循环切帧：`declared = buffer[0]<<8 | buffer[1]`，不够就等下一个分包（日志 `等待后续分包`），够了就 `stripLength()` 校验长度并交给等待队列 |
| 成功标志 | `已订阅 0213（INDICATE）`，且后续任何请求都有响应 |
| 失败判读 | `关键阻塞：运行时未能开启 0213 的通知` → **这是 uni 的能力边界，不是协议问题**。所有请求会表现为 `等待车辆响应超时` |
| 归零策略 | **与官方 `pkg/connector/ble/ble.go` 的 `rx()/flush()` 逐条对齐**：① 两包之间静默超过 `rxTimeout=1 秒` → 上一帧已断在半路，丢掉残留重新对齐（日志 `分包间隔超过 1000ms，丢弃上一帧残留的 N 字节`）；② 长度前缀声明 > `maxBLEMessageSize=1024` → 一定是错位前缀，整块丢掉（日志 `长度前缀 N 超过单帧上限 1024`），**绝不能卡在「等待后续分包」把之后每条正常响应都吃掉**；③ `send()` **不再**清空正在拼的半截帧 —— 官方传输层从不因为「又发了一条」就丢缓冲，而 `GetVehicleData` 的响应要拆成十几包慢慢推，以前赶上一次重发就送进 GCM 半截密文，现场表现为误导性的「响应 GCM tag 不符」；多余字节仍按 `无人等待的响应（车辆主动上报？）` 打印 |

### F10 发送一帧（串行写 + 超时）

| 项 | 内容 |
| --- | --- |
| 调用链 | `src/domain/command-dispatcher.js:sendRequest()` → `ble().send(frame, ms, keepQueue)` → `BleTransport.writeChunked()` |
| 用到接口 | `uni.writeBLECharacteristicValue({deviceId, serviceId, characteristicId, value:ArrayBuffer})` |
| 实现方式 | `bytesToAb()` 复制一份 `Uint8Array` 再取 `.buffer`（避免 buffer 视图共享导致长度异常）；写队列 `this.txChain = this.txChain.then(...)` 保证串行；每片写完 `delay(20)` 给车机处理时间；响应通过 `waitForFrame()` 的 FIFO 等待队列返回 |
| 长度处理 | **按官方规则真分包**：`cap = max(20, min(mtu, 1024) - 3)`（`mtu` 一律取**回读到的实际协商值**），帧长超过就循环 `writeBLECharacteristicValue` 逐片写，车端靠 2 字节长度前缀重组（官方 `connector/ble/ble.go:354` 的 `blockLength = min(ExchangeMTU, 1024) - 3` 就是这么做的）。日志 `帧长 N > MTU 可用 M，按官方规则分成 K 片写` 是 **info 级正常行为**。早期注释「特斯拉不接受分包写」是错的，已推翻 |
| 成功标志 | 日志 `发送 N 字节: <hex>` 后紧跟 `响应 M 字节: <hex>` |
| 失败判读 | `等待车辆响应超时 Xms（可能没订阅成功 / 车辆休眠 / MTU 不足）`；**写本身失败会如实抛 `BLE 写失败：第 i/K 片（…）写入失败：<errMsg> errCode=<n>`**（早期实现的 `.catch(() => {})` 会把真实写错误吞成误导性的「响应超时」，已修并有回归锁） |
| 原始帧旁路 | 每次收发都同时喂给 `onRaw` → `src/domain/connection-service.js:connection.raw`（保留最近 200 条 = `config` 里的 `RECENT_RAW_MAX`）→ ③ 报文控制台页显示 `→车 / ←车` |

### F11 绑定车辆（加白名单，需刷 NFC 钥匙卡）

| 项 | 内容 |
| --- | --- |
| UI 入口 | ① 页「③ 绑定（刷钥匙卡）」（`step3`）+ 同页的「钥匙类型」四选一 + 「④ 探针确认」（`stepProbe`） |
| 调用链 | `src/services/vehicle-api.js:bindKey(vin, {formFactor})`（外面套一层 `tracked()`）→ `src/domain/enrollment-service.js:bindKey(vin, opts)` 三段状态机：<br>**阶段 0** `probeOnce(vin)`（预探针，见下）→ **阶段 1** `src/store/credential-store.js:ensureKey(vin)` → `src/protocol/v3/codec.js:buildAddKeyEnvelope(publicKey, ROLE_DRIVER, formFactor)` → `ble().send(prependLength(frame), 8000, keepQueue=true)` → **阶段 2** `for(;;)` 交替「`ble().receive(2500)` 收车端回执」与「每 5 秒 `probeOnce` 打一针会话」，谁先出结果谁定论，整个窗口 `PAIR_WINDOW_MS`=150 秒 |
| 用到接口 | F10 的 `writeBLECharacteristicValue` + F9 的 indicate；无新增 |
| 纯 JS 实现 | `credential-store.ensureKey` → `src/protocol/identity.js:newKeyPair()` → `p256.normalizePrivateKey(randomBytes(32))` + `p256.publicKeyFromPrivate()`（65 字节未压缩点 `04‖X‖Y`）；`keyIdOf(pub) = SHA1(pub)[:4]`；落盘 `uni.setStorageSync('tesla_probe_key_v1', {priv, pub, vin})` |
| 协议报文 | `ToVCSECMessage{ signedMessage{ protobufMessageAsBytes = UnsignedMessage{ WhitelistOperation{ addKeyToWhitelistAndAddPermissions(5){ key{PublicKeyRaw=65B}, keyRole = ROLE_DRIVER(3) }, metadataForKey{keyFormFactor=KEY_FORM_FACTOR_ANDROID_DEVICE(7)} }, signatureType = SIGNATURE_TYPE_PRESENT_KEY(2) } }`<br>**这是全套里唯一不走 `RoutableMessage` 的报文**：此刻还没有会话，官方 `security.go:338 SendAddKeyRequestWithRole` 发的就是这个裸信封，首字节 `0x0a`。<br>**内层是明文，不加密**，授权靠「刷钥匙卡」这个物理事件。<br>现行 `vcsec.proto` 里 `PermissionChange` 只剩 `key / secondsToBeActive / keyRole`，**老版的 `repeated permission` 数组已经没有了**，权限改由 `keyRole` 表达 |
| 实际字节样本 | 真机日志（65 字节公钥省略中段）：`0056 0a54 1250 82014d 2a47 0a43 0a41 04e4f5f4d0a456177c…2378c413 2003 3202 0807 1802`。逐段：`0056`=2 字节大端长度前缀（86）→ `0a54`=signedMessage → `1250`=protobufMessageAsBytes → `82 01 4d`=字段16 WhitelistOperation → `2a 47`=字段5 addKeyToWhitelistAndAddPermissions → `0a43 0a41`=key.PublicKeyRaw → `20 03`=**keyRole=ROLE_DRIVER(3)** → `32 02 08 07`=metadataForKey.keyFormFactor=7 → `18 02`=signatureType=PRESENT_KEY |
| 车端时序 | 三个参考实现对「什么时候算绑完」说法不一致，取证如下（优先级：官方 > 0Bu > esphome）：<br>① 官方 `pkg/vehicle/security.go:314-338` 的 `SendAddKeyRequestWithRole` **发完就 return，连回执都不读**（注释原文：*returns nil as soon as the request is transmitted. A nil return value does not guarantee the user has approved*）。<br>② 官方 `pkg/protocol/protocol.md:824` 说车端会先回 `OPERATIONSTATUS_WAIT`（等刷卡），`:836` 说一条消息**只有带上 `commandStatus.whitelistOperationStatus` 才算终态**。<br>③ 0Bu `main/vehicle_pairing.cpp:246` 的量产实测结论：车机在屏幕上加白之后**并不发**那条 completing `commandStatus`，它把 whitelist-add 的完成超时标成 `ExpectedSilent`，改靠「事后能不能用这把钥匙建会话」判定。<br>**所以本端两条判据同时跑、谁先来算谁**：一边 `receive` 收车端回执（2.5 秒一片），一边发完 8 秒后每 5 秒打一次 `probeOnce` 会话探针。拿到 `whitelistOperationStatus` 就以它为准（那是车辆自己给的确切答案），否则探针命中即判成功。看到 `WAIT` 只提示一次、**绝不重发 add-key**（重发会让车辆重新起一遍配对流程，0Bu 的记录是这会导致车机反复弹配对请求） |
| 探针判据 | `probeOnce(vin)` = 直接跑一次 `handshakeOnce`，把它的返回值当「问句」用：车辆回 `SessionInfo.status = OK(0)` → 钥匙已在白名单；回 `KEY_NOT_ON_WHITELIST(1)` → 还没加上。这与官方 `security.go:324` 的注释（*Clients can check if publicKey has been enrolled … by attempting to call v.SessionInfo*）和 `dispatcher.go:464 SessionInfoRequest` + `AuthMethodNone`（**不带签名的 session_info_request**）的发包形状一致。<br>**探针打在 VCSEC 域而不是官方举例的 INFOTAINMENT 域**，理由：① VCSEC 才是解锁要用的域，「能建 VCSEC 会话」才是我们要的强判据；② esphome-tesla-ble 的 `AGENTS.md` 写明「VCSEC is always safe to poll」（低功耗控制器，不会唤醒车机），而 INFOTAINMENT 探针在车休眠时会干扰休眠。本机实测车辆拒绝建会话时回的 `session_info = 28 01` 也正是 VCSEC 域。<br>阶段 0 先打一针：**已经绑好了就直接返回 `already:true`，一个 add-key 都不发** |
| 钥匙类型（formFactor） | 官方 `cmd/tesla-control/commands.go:356-409` 把 `FORM_FACTOR` 做成 `add-key` 的**必填位置参数**（`nfc_card / ios_device / android_device / cloud_key`），`vcsec.go:151 addKeyPayload` 只是原样塞进 `KeyMetadata.keyFormFactor` —— **官方没有默认值**。三个参考实现取值不同（0Bu 生产固件 = `CLOUD_KEY`，它 vendor 的 tesla-ble C++ 库 `src/vehicle.cpp` 的 `Vehicle::pair` = `NFC_CARD`），属**产品选择差异、不是协议分歧**。按「不许因为别的项目不同就改协议」的规则：默认保持 `ANDROID_DEVICE(7)`（我们确实是手机），同时把这四个枚举值全开给现场 A/B（① 页「钥匙类型」条）。它只影响车机把新钥匙归到哪一类，**不影响任何协议字段的编码方式** |
| BLE 连接数上限 | 一辆车同时最多约 **3 个并发 BLE 连接**（官方 Tesla App、手机钥匙、遥控钥匙共享）。挤满时 add-key 会静默无响应，`bindKey` 的发送失败文案里直接写了这条。**现场测试前务必退出并杀掉官方 Tesla App 后台** |
| 刷卡位置 | 以 Tesla 官方支持页（`tesla.com/support/tesla-vehicle-keys`，Add Key 流程）为准：**Model 3 / Model Y：中控台杯架后方**；**Model S / Model X / Cybertruck：左侧无线充电板顶部，卡片正面朝下往下刷**。旧文档里的「驾驶侧 B 柱」是更早期 Model S/X 的位置，已不作准。<br>**注意：车机屏幕通常不会主动弹窗**——官方 App 配手机钥匙时提示语出现在**手机 App 里**，车机上的确认页要等**刷过一张有效实体卡之后**才出现。「屏幕没弹窗」的正确解读是**卡没被读到**，不是请求没送到 |
| 必须用实体卡 | 官方 `security.go:314` 原文：*The user must approve the request by tapping their NFC card on the center console and then confirming their intent on the vehicle UI.* 车主手册进一步写明：钥匙卡的作用就是「**authenticate** 手机」以及增删其它钥匙卡 / 手机 / 钥匙扣。签署方 `signerOfOperation` 是一张已在白名单的实体钥匙，**手机 NFC 替代不了**（见 F11「能不能跳过」行） |
| 成功标志 | 两种都算成功，日志会写明判据来源：<br>① 探针命中 —— `绑定成功 —— 探针第 N 次确认：会话已建立…`，并附 `本机 Tesla key id = XX:XX:XX:XX`；<br>② 车端给了终态 —— `车辆回执已加入白名单（WHITELISTOPERATION_INFORMATION_OK(0)）` + 随后那一针的会话结果。<br>「④ 探针确认」按钮（`probeSession()` → `probeEnrollment({force:true})`）任何时候都能单独按一次，回答「这把钥匙到底进没进白名单」。<br>**现场认钥匙**：车机 控制 > 安全 > 钥匙 里新登记的一律显示 `Unknown key`，用日志打出的 `Tesla key id`（`SHA1(65B 公钥)` 前 4 字节、冒号大写 hex，与 0Bu `vehicle_pairing.cpp:809-866` 同源）比对；「查白名单」回的 4 字节 keyId 也已按前缀归一，显示成同一个值 |
| 失败判读 | 车端给了明确回执时，日志会直接打出 `车辆回执：WHITELISTOPERATION_INFORMATION_…(N)` + 一句中文处置建议（`src/domain/response-hints.js:PAIR_HINTS`）。最常见：`NOT_ALLOWED_TO_ADD_UNLESS_ON_READER(14)` = **卡没贴到位/没在屏幕上确认**；`KEYFOB_SLOTS_FULL(3)` / `WHITELIST_FULL(4)` → 车机设置里删一把旧钥匙；`INVALID_PUBLIC_KEY(6)` → 公钥不是 65 字节 `04…`。<br>窗口等满仍判「没绑上」时，返回文案是固定的**四项排查**（车机有没有弹配对页 / 实体卡刷卡位置与屏幕确认 / BLE 连接数被官方 App 占满 / 车辆休眠要先踩刹车），并打印最后一次探针的结果。**注意：`wait:true` 不等于协议错**，它只说明这一轮没拿到任何一侧的确认 |
| 能不能跳过 | **不能。** 协议里没有任何「设备身份」，车辆只认公钥；官方 App 的私钥受 Android 沙箱保护读不到。加新钥匙本身还需要一次授权动作（刷卡 = `PRESENT_KEY`），另一条「用已在白名单的私钥签名」正好依赖那把拿不到的私钥。<br>**这是车辆侧的信任模型，不是 uni-app 的能力边界**：换 Kotlin / Swift / Flutter / 树莓派 + BlueZ 写的客户端同样必须刷实体卡。用手机 NFC 顶替也不行——读卡区是 **RFID 读卡器**，只认 Tesla 钥匙卡里的安全元件；Android HCE 只能模拟 ISO-DEP/Nfc-A 卡，既没有 Tesla 的凭据也过不了挑战应答，而且 uni-app 根本没有 HCE/卡模拟 API（`uni-NFC` 只有读卡方向） |

### F12 V3 握手（`session_info_request` ↔ `session_info`）

| 项 | 内容 |
| --- | --- |
| UI 入口 | ② 页「重新握手」（`handshake(true)` 强制重来）；任何加密指令前都会先自动 `handshake(false)`，会话可用就直接复用 |
| 调用链 | `src/services/vehicle-api.js:handshake(force)`（套 `tracked()`）→ `src/domain/handshake-service.js:handshake` → `handshakeOnce` → `src/protocol/v3/handshake.js:buildSessionInfoRequest(DOMAIN_VEHICLE_SECURITY, publicKey, uuid, routingAddress)` → `ble().send()` → `src/protocol/v3/codec.js:parseFrame` → `applySessionInfo` → `src/store/v3-session-store.js:storeV3Session()` |
| 用到接口 | 同 F10/F9 |
| 纯 JS 实现 | `sharedKeyOf = SHA1(ECDH(C,V).X)[:16]`（AES-128 密钥）→ 子密钥 `subkey(K,label) = HMAC-SHA256(K, label)`；响应用 `sessionInfoHmac` 认证：元数据 `sigtype=HMAC(6) → VIN(大写) → challenge(= 我们请求里的 uuid)` + `0xFF` 结束符 + `session_info` 原文，HMAC 密钥为 `subkey(K,"session info")` |
| 元数据编码 | `Metadata.add(tag,value)` = `[tag u8][len u8][value]`，**tag 必须递增**、`value` 为 `null` 静默跳过、超 255 字节报错；元数据里的 uint32 一律**大端**（protobuf 的 fixed32 才是小端，两者别混） |
| 会话参数 | `epoch`（16B 随机）+ `clock_time` → `anchor = localNow() - clock_time`（对齐 `signer.go:80 timeZero = generatedAt - ClockTime`）；`counter = max(本机, 车辆回传)`（对齐 `signer.go:104-106`，**只上调**） |
| 判读顺序 | **先解 `SessionInfo.status` 再要 `signature_data`**。`status != 0` 就是车辆明确拒绝，直接给人话（`status==1` → `KEY_NOT_ON_WHITELIST`，提示先做 ③ 绑定 + 踩刹车唤醒），并标 `fatal` **不重试**。以前先查 tag，会把「钥匙没进白名单」误报成「响应没有 session_info_tag」 |
| 重试 | 最多 2 次，间隔 1 秒；`fatal` 立即 `invalidateV3Session('车辆拒绝握手')` 并返回 |
| 成功标志 | `V3 握手成功 …（counter=N）` |
| 失败判读 | `SESSION_INFO_STATUS_KEY_NOT_ON_WHITELIST(1)` → 回 ① 页刷卡绑定；HMAC 对不上 → VIN 大小写 / `uuid` 复用出错，或车辆回了不同域的 `session_info` |

### F13 RKE 上锁 / 解锁（AES-128-GCM 加密指令）

| 项 | 内容 |
| --- | --- |
| UI 入口 | ② 页：`解锁(0)` `上锁(1)` `后备箱(2)` `前备箱(3)` `开充电口(4)` `关充电口(5)`；自定义数字框 + 「发送自定义动作」；「上锁→解锁 各 3 次」压测（任一轮失败即中断并报「压测在第 N 轮中断，后续结果不再可信」） |
| 调用链 | `src/services/vehicle-api.js:sendRke(action, name)`（套 `tracked()`）→ `src/services/vcsec/rke.js:sendRke` → `src/domain/command-dispatcher.js:sendRequest` →（缺会话时自动 `handshake(false)`）→ `src/protocol/v3/aead.js:encryptCommand` → `ble().send(frame, ms, keepQueue=true)` → `decryptResponse` |
| 用到接口 | 同 F10/F9 |
| 纯 JS 实现 | `src/infra/crypto/aes.js:aes128GcmEncrypt(key16, nonce, plaintext, aad)`；自研 CTR+GHASH 路径已与 Node `createCipheriv('aes-128-gcm')` 双向对拍。**V3 的 nonce 是 `randomBytes(12)`**（`gcm.NonceSize()`），不再是旧版那种「counter 转 4 字节当 IV」 |
| 协议报文 | 内层 `UnsignedMessage{ RKEAction: action }` → 加密成 `SignedMessage{ protobufMessageAsBytes = 密文, signature = GCM tag }` → 外层 `RoutableMessage{ to_destination{domain=VCSEC}, signedMessage{ signature_data{ signer_identity{public_key=65B}, AES_GCM_Personalized_data{epoch, nonce, counter, expires_at, tag} }, payload_format = AES_GCM_PERSONALIZED } }`。<br>**身份靠公钥本身，不再有 4 字节 `key_id`**。<br>AAD = `SHA256(TLV 元数据 ‖ 0xFF)`，元数据顺序固定为 `sigtype → domain → VIN → epoch → expires_at → counter → flags(仅 >0 才写)`。<br>**protobuf 坑（本次修复点）**：`UnsignedMessage` 整条消息只有一个 `oneof sub_message`，而 protobuf 规定 **oneof 成员一律「显式存在」**——值是 0 也要写 tag。所以 `UNLOCK(0)` 内层 = **`10 00`**（不是空字节串）、`LOCK(1)` = `10 01`。旧实现把「proto3 默认值省略」套到了 oneof 成员上，`UNLOCK` 内层被省成 0 字节 → 密文 0 字节 → 外层 `protobuf_message_as_bytes`（同为 oneof 成员）跟着被省略 → 车辆收到的是一条**没有载荷**的 RKE 命令，只能一直回 `operation_status=WAIT`；`LOCK(1)` 和 `ClosureMoveRequest{frontTrunk:3}` 因为值非 0 恰好编得出来，这与现场「上锁成、前备箱成、独独解锁 WAIT」逐字吻合 |
| 动作编号 | 官方现行 `RKEAction_E` 只剩 `UNLOCK(0) / LOCK(1) / REMOTE_DRIVE(20) / AUTO_SECURE_VEHICLE(29) / WAKE_VEHICLE(30)`。**后备箱、前备箱、充电口已经不是 RKE 动作**，页面上那几个按钮在 V3 下走 `sendClosure` → `ClosureMoveRequest{frontTrunk/rearTrunk/chargePort: MOVE(1)/OPEN(3)/CLOSE(4)}`，编号只是沿用旧版叫法；点自定义值时会提示「官方现行 RKEAction_E 里没有这个值」。**`REMOTE_DRIVE(20)` 不混在这排按钮里** —— 它是「解锁之后能否挂挡」的另一条独立命令，有自己的卡片、台账键和判读，见 F24 |
| counter 规则 | 每次组包 `counter = session.counter + 1`；**`0xFFFFFFFF` 是官方保留的 `counterMax` 哨兵（`crypto.go:18`），永远不能发出去**，最后一个可用值是 `0xFFFFFFFE`，越界直接抛错要求重新绑定。官方 `signer.go` 先 `s.counter++` 再组包、**发送失败也不回滚**；本实现等价：整帧组好才写回 `session.counter`，组包途中抛错等于这号没发出去 |
| 响应侧 | 置了 `FLAG_ENCRYPT_RESPONSE` 时车辆回 `AES_GCM_Response_data`；`decryptResponse` 用 `responseMetadata`（`sigtype=9 → domain → VIN → counter → flags(恒含) → request_hash → fault`）重算 AAD 验 tag。`request_hash = sigtype 单字节 ‖ 请求的 tag`（VCSEC 域若为 HMAC 则截到 16 字节），**不是**对请求帧再哈希<br>**`payload` 可以为空**：`RoutableMessage.payload` 是 `oneof{protobuf_message_as_bytes / session_info_request / session_info}`（`universal_message.proto:87-91`），车辆完全可以在还没出结果时先回一帧「只有 `signature_data`、没有载荷」的受理帧 —— 官方 `signer.go:219-242 Decrypt` 对空 payload 也没有任何前置检查。以前这里有一条凭空发明的「响应没有 payload」报错，把合法的空帧当解密失败抛了出来，`GetVehicleData` 就是这么整条挂掉的（**已删**）<br>**解不开的一帧只丢这一帧**：对齐官方 `dispatcher.go:302-308`（log + 丢弃、绝不终止请求），收帧循环遇到 tag 校验失败的帧会记下原因（`dropped`）并**继续收到截止时间**，超时文案里会带上 `已丢弃帧：…`，不静默失败；若每一帧都解不开，则报「所有帧都解不开」判超时而不是当场成功<br>**但「解不开」要先排除一种帧**：车辆用 `signedMessageStatus{ERROR / fault≠0}` 且不带你任何密文时，那是**协议层错误帧**（终态拒绝），根本不是「一帧解不开的响应」—— 拿它试解密只会刷出一句 `GCM tag 不符` 把车辆明说的拒绝盖掉（细则与官方依据见 F18「协议层错误帧」）<br>**先配对、再解密**（`dispatcher.go:252-293` 的 `{domain, address, uuid}` 三路配对）：路由地址、非空 `request_uuid`、`from_destination.domain` 三条闸门只要有一路对不上，就在**解密之前**丢掉并写明 `串台帧：…`（细则见 F18「配对闸门」）。少了这几道，上一条命令的残留帧、车辆自己发的周期广播都会被当成本次响应，现场只剩一条误导人的「响应 GCM tag 不符」或一句假报的成功<br>**domain 字节以响应自己为准**：`responseDomainByte(rm)` = `from_destination.domain`，车辆没带 `from_destination` 就是 **0**（`peer.go:108` 的 nil-safe 取值），**绝不回退成请求的域** —— 这一条是 `GetVehicleData`（车机域）响应验不过 tag 的直接嫌疑，离线有不对称回归锁把它钉死<br>**解不开时逐字段试算**：`decryptResponse` 会把 `domain / request_hash / flags / fault / counter` 各改一个重算，再把「换成更早那次请求的 hash」「换成另一域的会话密钥」也试一遍，命中哪个就在日志里点名 `换 […] 就能对上 → 根因是这个字段`；全试完仍对不上就报 `密文被截断或会话密钥不对`。**试算只用于诊断，绝不静默采纳猜出来的 AAD**，且诊断文案里不出现任何密钥字节（安全红线） |
| 成功标志 | `status=OPERATIONSTATUS_OK` **且车真的响**（这一档才算端到端成立） |
| 失败判读 | GCM tag 校验失败 → 会话密钥 / 元数据顺序 / VIN 大小写任一处不符，或车辆已轮换会话；`SignedMessage_information_E`（§7.2）；`MessageFault_E` 非 0 会直接打出名称（③ 页可对照）；握手被拒 `KEY_NOT_ON_WHITELIST` → 白名单里没这把 keyId，回 F11 |

### F14 无签名只读查询（绑定前就能发）

| 项 | 内容 |
| --- | --- |
| UI 入口 | ② 页「查车辆状态」；① 页「查白名单」「读 0214 版本」 |
| 调用链 | `src/services/vehicle-api.js:queries.{status, whitelist}` → `src/domain/enrollment-service.js:infoRequest(type, name, timeoutMs, slot)` → `sendRequest({plain:true})` → `src/protocol/v3/aead.js:buildPlainRequest`；版本读取走 `BleTransport.readVersion()` |
| 用到接口 | 前几项 = `writeBLECharacteristicValue` + indicate；读版本 = **`uni.readBLECharacteristicValue({deviceId, serviceId, characteristicId})`** |
| 实现方式 | 明文 `RoutableMessage{ to_destination{domain=VCSEC}, request_uuid, unsignedMessage{InformationRequest{…}} }`，**不需要会话、不需要签名**。所以「连接 → 读版本 → 查白名单」这条链**不刷卡、不占槽**，是现场最便宜的一次通路自检（= §1 的 ② 档） |
| 请求类型 | 官方现行 `vcsec.proto` 只剩 `GET_STATUS(0)`、`GET_WHITELIST_INFO(5)`、`GET_WHITELIST_ENTRY_INFO(6)`（编号取自 `vcsec.proto:50`）。`GET_EPHEMERAL_PUBLIC_KEY(3)` / `GET_VEHICLE_INFO(7)` / `GET_KEYSTATUS_INFO(8)` / `GET_CAPABILITIES(16)` 已删除，页面上也不再给按钮 |
| 实测字节 | `GET_WHITELIST_INFO`（本机真机日志，54 字节）：`0034 32020802 121210f4a7f03ef694e0ce3a4b16b56797bb0d 5204 0a02 0805 9a03101c8ba87857bc73d54661cb42f0f56b05a00302`。逐段：`0034`=长度前缀(52) → `32 02 08 02`=to_destination.domain=DOMAIN_VEHICLE_SECURITY(2) → `12 12 10 <16B>`=request_uuid → `52 04 0a 02 08 05`=unsignedMessage.InformationRequest.type=5 → 尾部 `9a 03 …` 是 BLE 层附加的链路标识，不是协议字段 |
| 白名单回包 | 这台车实测回 **4 字节 keyId**（`GET_WHITELIST_INFO` 里是 `whitelistEntryInformation` 列表），而 ③ 页/`checkWhitelisted` 早期按「完整公钥 SHA1」比对，永远比不中。现在 `keyIdMatches(entry, full)` 做**前缀归一**（`full.indexOf(e) === 0`），4 字节和 20 字节两种回包都认 |
| 关键改动 | `checkWhitelisted()` **无 `mustKey()` 守卫**，绑定前可查；本机 keyId 是否在内按 `hasKey()` 分支显示 |
| 成功标志 | `白名单 N 条 [keyId...]`；`通信协议版本 = <hex>`；`锁状态=VEHICLELOCKSTATE_UNLOCKED/LOCKED` |
| 失败判读 | 无响应 = 通路问题（回查 F9/F7）；有响应但 `summary.kind=other` = 字段号/枚举与该车固件不符（用 ③ 页对照规格）；`白名单里没有本机 keyId` = 绑定没落库，回 F11 重刷 |

### F15 密钥与 counter 持久化 / 换钥 / 清除

| 项 | 内容 |
| --- | --- |
| UI 入口 | ① 页「换新密钥对」「清除本机密钥」「断开连接」 |
| 调用链 | 密钥在 `src/store/credential-store.js:saveKeyPair / loadKey / ensureKey / clearKeys`；V3 会话在 `src/store/v3-session-store.js:v3Session / storeV3Session / invalidateV3Session / invalidateAllV3Sessions / resetV3Session`；「清除」这个动作在 `src/services/credential-service.js:forgetEverything / forgetBindProfile`（经门面 `src/services/index.js` 分别导出成 `forgetKey` / `forgetBind`）；`disconnectAll()` → `BleTransport.close()`；绑定档案见 F22（`src/store/bind-profile.js:saveBind / loadBind / markBound / describeBind`）、自动重连循环见 F22（`src/domain/auto-reconnect.js:autoReconnect / startAutoReconnectLoop / stopAutoReconnectLoop / describeAutoLoop / suspendAutoConnect`） |
| 用到接口 | `uni.setStorageSync / uni.getStorageSync`；`uni.closeBLEConnection` + `uni.closeBluetoothAdapter` |
| 存储键 | `tesla_probe_key_v1`（`{priv, pub, vin}` hex）、`tesla_probe_vin_v1`（VIN）、**V3 会话按域两个键**：`tesla_probe_v3_session_v1`（VCSEC=2）、`tesla_probe_v3_infotainment_v1`（车机=3），内容都是 `{counter, epoch, vehiclePublicKey, clock_time, set_time, anchor, ready}`，**唯独不含 16 字节会话密钥**；另有 `tesla_probe_bind_v1`（车辆蓝牙档案，F22） |
| 实现方式 | `App.vue:onLaunch → loadKey() + loadBind()` 启动回填，重开 App 既不用重新生成密钥、也不用重新手选设备；`onShow` 的自动重连循环靠这两样把门（`hasKey() && hasBind()`），缺一样就不启动（F22）；`ensureKey` 幂等；私钥**明文存沙箱**（探针专用，产品必须进 Android Keystore）。会话相关函数**全部带 `domain` 形参**（默认 VCSEC），`invalidateV3Session(why, domain)` 只作废该域的会话密钥与 `ready`，**counter / epoch 一律保留**；`resetV3Session(domain)` 才归零该域；`forgetKey()` 一次清掉密钥 + **两个域**的会话 + **绑定档案**（F22：没了私钥，自动回连也没有意义，不该再偷偷连车） |
| counter 语义 | V3 的 counter 是**签名序号**，车辆侧按「域 + 钥匙」分别记着上一把钥匙用到哪一号，回退一次就永久失效（对齐 `signer.go`）。所以任何「重连 / 握手失败 / 换网络」都**绝不把 counter 调小**，握手时只会 `max(本机, 车辆回传)` 往上并。**两域各一套序号，绝不能共用**（见 F21） |
| 风险 | 「清除本机密钥」会把密钥与 counter 一起清 0 → **车辆侧那把钥匙仍在白名单里但计数器记忆已丢**，重绑前别乱点；「换新密钥对」= 换了一把全新 key，旧计数作废是安全的，counter 归零没问题 |

### F16 亮屏保活

| 项 | 内容 |
| --- | --- |
| 调用链 | `App.vue:onLaunch` → `src/infra/platform/runtime.js:keepScreenOn(true)` |
| 用到接口 | `uni.setKeepScreenOn({keepScreenOn:true})`（需 `WAKE_LOCK`，manifest 已声明） |
| 为什么 | 绑定要等 60 秒刷卡，锁屏/息屏会让整轮作废；车库里这一点比什么都值钱 |
| 局限 | 只防息屏，**不防用户主动回桌面 / 系统杀后台**。测第 ③ 步期间不要切走 App |

### F17 报文控制台（排障 + 手工发任意字节）

| 项 | 内容 |
| --- | --- |
| UI 入口 | ③ 页（`→ 报文控制台`）：原始帧列表 / JSON 手工组包（预设 `绑定样例 / 握手样例 / RKE 样例`）/ 裸 hex 发送 / 按消息名解析 / Message + Enum 规格速查 |
| 调用链 | `debug.vue:buildFromJson()` → `toolkit().encode(SPEC,'RoutableMessage',obj)` → `prependLength` → `ble().send(frame,8000)`；`normalizeHex` → `parseFrame` → `decode / inspect` |
| 用到接口 | 复用 F10/F9（不新增）；页面跳转 `uni.navigateTo` |
| 实现方式 | 页面的协议能力**只来自 `src/services/vehicle-api.js` 的 `toolkit()`**（另外只从门面 `src/services/index.js` 拿 `log/state/ble/connection/beginAction/endAction`，从 `src/infra/bytes.js` 拿 `fromHex/toHex`），一次拿到 `SPEC` 表、根消息名（`RoutableMessage`）、`encode/decode/inspect/label/prependLength/parseFrame/summarize/summarizeVcsec`。`bytes` 字段在 JSON 里直接写 hex 字符串即可；`只编码不发送` 用于**把完整 hex 抄到 nRF Connect 做 A/B 对照**（§9）；`inspect()` 输出带字段名的结构化文本，用来肉眼核对字段号 |
| 规格表 | 根是 `RoutableMessage`，但 `ToVCSECMessage` 仍留在表里 —— 绑定帧（F11）走的就是它，③ 页要能手工组和解析 |
| 注意 | `rke` 预设里的 `signature_data` 需要你自己按会话密钥 + counter 算 GCM，所以它**只能观察报文结构**，真发 RKE 请用 ② 页按钮 |
| 价值 | 这是「协议问题」与「uni 问题」的分诊台：同一段 hex 用 nRF Connect 手发能成 → 问题在 uni；手发也不成 → 问题在报文 |

### F18 V3 请求编排（重发、路由地址、WAIT）

| 项 | 内容 |
| --- | --- |
| 调用链 | `src/domain/command-dispatcher.js:sendRequest(opts)`（除绑定外所有 V3 动作的公共出口） |
| 实现方式 | `routingAddress` 与 `uuid` 在 **attempt 循环之外**生成一次、整条请求连同重发全程复用（VCSEC 域的响应**只按 `routing_address` 配对**，`dispatcher.go:400-407`，换号会让响应掉进没人领的收件箱）；**编码按域分岔（第四轮真机改的，见 F25）**：**车机域（INFOTAINMENT）只编码一次**，重发上线的是**同一份已编码字节**（counter / nonce / tag / `request_hash` 全程不变）—— 官方 `dispatcher.go:434-460` 的传输层重发循环就是 `for { d.conn.Send(ctx, encodedMessage) }` 反复发同一个 `encodedMessage`。原来每次重发重新组包，requestId 一变，车辆对**第一次**请求的迟到回包就验不过 tag，`GetVehicleData` 这种慢响应最容易撞上「响应 GCM tag 不符」+「等待终态超时」。**VCSEC 域则每一圈重新 `encryptCommand`**：`vcsec.go:84-105` 遇到 `WAIT` 走的是**应用层**重试（重新调整个 `dispatcher.Send`），而每次 `Send` 都会重新 `session.authorize`（`counter++` / 新 nonce / 新 tag，`dispatcher.go:428`）—— 照抄车机域那份「同字节重发」，VCSEC 的重发帧就全是重复 counter，被车辆按 `protocol.md:547-549` 直接当旧包丢掉，现场表现为「按一次没反应、再按一次才生效」。`flags = 1 << FLAG_ENCRYPT_RESPONSE`（对齐 `vehicle.go`）。BLE 侧用 `ble().send(frame, ms, keepQueue)` —— 见下行 |
| 重发时留不留队列 | **第一次发之前清**（`keepQueue=false`）：那时队列里只可能是更早请求的残留帧，路由地址对不上；**重发时保留**（`keepQueue=true`）：requestId 这次不变，队列里可能正躺着**本请求的迟到回包**。收帧循环期间车辆又推进来的 ACK 一律进 `this.queue`，清掉就把终态丢了。<br>第四轮真机之后这里多了一个变量：**VCSEC 域的重发会换路由地址**（照官方 `dispatcher.go:392-413`，每次 Send 为 VCSEC 重新随机 `routing_address`、重新生成 uuid），所以保留下来的队列里那些旧路由地址的回包**本来就配不上号**，由配对闸门丢弃 —— `keepQueue` 的取值仍是 `attempt > 1`，两域一样 |
| 重发条件 | 车辆回 `WAIT` 按官方 `vcsec.go` 视为 `ErrBusy` → **整条重发**（不是继续读下一帧）；组包失败且还有额度 → 作废会话后重新握手再发；总时长受 `maxMs` 截止时间约束。<br>**重发发的是什么字节，按域分岔**：Infotainment 复用同一份已编码字节（编码只做一次），VCSEC **每圈重新签一份**，`counter` 必须 `+1`（见上一行与 F25）；resync 作废会话后同样强制重建，不能拿旧 epoch 的帧去撞新会话 |
| 终态判据 | RKE / 闭锁器：收到一条**没有 `commandStatus`** 的报文才算完（`executeRKEAction`）；白名单操作：**必须带 `whitelistOperationStatus`** 才是终态（`isWhitelistOperationComplete`）；`GetVehicleData`：`(obj) => !!(obj.vehicleData || obj.actionStatus)`（`vehicleData()` 自带这个 `done`，所以「车辆已受理、应用层为空」的那一帧不算终态，会继续等） |
| 收帧容错 | 一帧看不懂 **≠** 这条请求失败。`decodeFrame` 把「解不开 / 解析抛错」的帧标成 `{skipped:true}`，`sendRequest` 只丢这一帧并接着收下一帧（对齐官方 `dispatcher.go:302-308`：log + 丢弃、不终止请求），空载荷的受理帧则当成非终态继续等。见 F13「响应侧」 |
| 配对闸门 | **解密之前**先做三路配对，对齐官方 `dispatcher.go:252-293` 的 `receiverKey = {domain, address, uuid}`。每条闸门**只在本帧真带了那一线索时才否决**，线索缺失一律放行（老车 / VCSEC 回包常不带）：<br>① `to_destination.routing_address`（`protocol.md:36-38`「车辆把 to / from 对调后回包」）≠ 本次请求的 16 字节地址 → 丢；<br>② `request_uuid` **非空**却不等于本次请求的 uuid → 丢（`protocol.md:52-55` 说请求 uuid 会被复制进响应；tesla-key-esp32 `ARCHITECTURE.md:106` 与 `docs/adr/0003` 把「非空必匹配」定为防重放硬规则；VCSEC 受内存限制不填 → 不否决）；<br>③ `from_destination.domain` ≠ 本次请求发往的域 → 丢（`universal_message.proto:16-21`：`Destination` 是 oneof，要么带 domain 要么带 routing_address）。<br>被挡下的帧统一标 `串台帧` 并写明对不上哪一路，**根本不进 `decryptResponse`**。少了这几道，上一条命令的残留帧和车辆自己发的周期广播都会来冒充本次响应：轻则拿错的 `request_hash` 验 tag（现场只剩一句误导人的「响应 GCM tag 不符」），重则真机那次 —— VCSEC 广播帧（`to={domain:BROADCAST}`、`from={domain:VCSEC}`、无 uuid）被当成车机 `GetVehicleData` 的终态，报「成功：`actionStatus=OPERATIONSTATUS_OK(0)`」而一个 `vehicleData` 字节都没有。**第三轮日志反过来证明了这三道闸有用**：动作收尾后又推进来一条同款 VCSEC 广播帧（`320208003a020802521f…`），这次没进 GCM，打的是 `无人等待的响应（车辆主动上报？）`（`src/infra/ble/ble-transport.js` 的 `deliver()`） |
| 协议层错误帧 | 车辆用 `signedMessageStatus{operation_status / signed_message_fault}` 就能独立给出终态结论（`protocol.md:59-61`：**协议层错误走这里，应用层错误才会出现在 `protobuf_message_as_bytes`**）。当 `fault ≠ 0` 或 `operation_status = ERROR`，且帧里带 `AES_GCM_Response_data` 却**一个密文字节都没发**时，`decodeFrame` 直接判**终态拒绝**（`{refused:true}`）并翻成人话，**绝不拿它去试解密** —— 那种 tag 是给车辆自己挡下的那份大响应准备的，本地永远验不过，只会刷出一句「期望/实际 tag 不符」把车辆明说的拒绝盖掉（真机合包 6 类 `GetVehicleData` 的 `fault=25` 正是被老代码判成「解不开的帧」→ 一路等到「等待终态超时」）。按官方 `error.go:195-198`，`MESSAGEFAULT_ERROR_NONE` 与 `RESPONSE_MTU_EXCEEDED` 属 **「命令可能已经执行」**（车收下了请求，只是不发答案），文案照这个口径写；两者都**不自动重发**（`error_test.go:62-65` 钉死 25 的 `shouldRetry=false`，三家参考实现也没有一个对 25 做补救） |
| 顺手刷新 | 响应里搭车的 `session_info` 要过「本机已有共享密钥 / 距请求发出未超时 / 带 tag」三道闸才采纳（`dispatcher.go checkForSessionUpdate`） |
| 传输层配套 | `src/infra/ble/ble-transport.js` 为「一次请求多帧响应」加了暂存队列：`keepQueue=true` 时不清 `this.queue`，`receive()` 优先取暂存帧；一次 indicate 里粘两帧会被 `parseFrame` 拆开分别入队 |
| 价值 | 官方客户端本身就靠重发 + 路由地址配对活着，一次性发送等回复的写法在新款车上极易误判为「协议不通」 |

### F19 日志窗口（清空 / 复制 / 动作分段）

| 项 | 内容 |
| --- | --- |
| UI 入口 | 每个页面底部的「日志」卡片（`components/log-box/log-box.vue`），右上角控件：`共 N 条` / `清空` / `复制` / `自动滚底:开·关` |
| 调用链 | `log-box.vue:copy() → src/infra/platform/notify.js:copyText(全文) → uni.setClipboardData` → 成功后 `src/infra/logging/log-bus.js:log('ok', '已复制 N 条日志到剪贴板…')`（**不再用 toast 反馈**，直接写进日志自身）；`clear() → log-bus.js:clearLogs()` |
| 实现方式 | 日志源在 `src/infra/logging/log-bus.js` 的内存数组，`getLogs()/log()` 是唯一入口，页面只是渲染。**每条都带 `mm:ss.ms` 时间戳 + 级别色**（`tx/rx/ok/warn/err`），`复制` 导出的是**未着色的原文**，直接贴给协作者即可，不用截图 |
| 动作分段 | `src/infra/logging/action-tracer.js:beginAction(name)` 在段首插一行 `-----start----- 动作名`，`endAction(result)` 在段尾插 `-----end----- 动作名 | 成功：…` / `失败：…` / `异常：…`。`src/services/vehicle-api.js` 里每个对外动作都套了一层 `tracked(name, fn)`（内部就是 `action(name, fn)`），所以**点任何一个按钮产生的日志天然成一段**，段名就是按钮语义（`绑定（刷钥匙卡）`、`查白名单`、`V3 握手`、`RKE 动作`…） |
| 边界规则 | ① 嵌套调用只打**最外层**一对标记（`actionDepth` 计数）；② `action()` 会把返回值里的 `text` 折成一行放进展尾标记，**不截断**（`-----end-----` 常常是唯一带完整失败原因的一行，现场复测要求每条报错都能复制）；③ 动作抛异常照样收尾，`errCode` 一并拼进 `异常：…`；④ `清空` 会重置 `actionDepth`，不会出现「只有 end 没有 start」的孤儿标记 |
| 容量 | 日志环形缓冲 `MAX_LOGS = 1000` 条（一轮完整绑定 = 60 秒等待 + 每帧 hex + 逐帧解码就能产生上百条，400 条会在复测中途滚掉最早的关键日志） |
| 用法 | 复现问题 → 点 `复制` → 直接贴文本。看的时候搜 `-----start-----` 就能跳到对应动作，段内第一条 `tx` 是发出去的字节，最后一条 `-----end-----` 后面跟着结论 |
| 失败判读 | 日志为空 → 弹窗「日志是空的，没什么可复制」；`复制` 没反应 → 弹窗「当前环境不支持剪贴板」（H5 预览下正常，App 基座里应有）；列表恒空 = 组件没订阅到 `src/infra/logging/log-bus.js` 的日志总线 |

### F20 提示弹窗（notify：关闭 / 复制）

| 项 | 内容 |
| --- | --- |
| 用户输入 | 任何一次操作结果（绑定结论、握手拒绝、未连接、复制结果…） |
| 为什么换掉 toast | `uni.showToast` 的 `title` 在 App 端只画得下一两行，**车辆回执 + 人话解释 + 下一步动作**这种多行提示必然被剪；而且 toast 会自动消失，来不及看也无法选中。原先页面里还普遍写着 `this.toast(r.text.slice(0, 60))`，等于主动把结论砍成 60 字 |
| 实现 | `src/infra/platform/notify.js:notify(text)` → `uni.showModal({ title:'提示', content: preview(全文), showCancel:true, cancelText:'关闭', confirmText:'复制' })`；点 `复制` → `copyText(全文)` → `uni.setClipboardData` |
| 正文规则 | 弹窗里最多显示 `NOTIFY_MAX = 500` 字，超出只留头部并追加 `…（共 N 字，点「复制」取全文）`；**剪贴板里永远是未截断的全文**。调用方一律不许先 `slice` 再传进来 |
| 页面接法 | 除 ③ 报文控制台以外的 **9 个页面**各保留一个 `toast()` 方法（共 63 处调用点不动：`binding.vue` 14、`index.vue` 13、`rke.vue` 9、`home.vue` 7、`car-control.vue` 5、`diagnostics.vue` 5、`control.vue` 4、`info.vue` 3、`climate.vue` 3），函数体统一是 `notify(t)`；③ 报文控制台没有结果要提示，不用 `toast`；`log-box` 的复制成功反馈改写日志行，避免「弹窗上叠弹窗」 |
| 异常兜底 | 上面那 9 个页面同一个形状的 `guard(n, fn)`：catch 会把**错误原文（含 errCode）直接放进弹窗**「失败：<原文>」，同时写一条 `未捕获错误: …` 日志——不再只说「失败，看日志」；`bindKey / sendRke` 等返回 `{ok:false, text}` 的失败本来就全文进弹窗 |
| 降级 | Node 自检环境没有 `uni`：`notify()` 原样返回全文、`copyText()` 回调 `false`，绝不抛错（否则 `vue-check` / `run.mjs` 会被页面脚本拖死） |
| 回归锁 | `tests/run.mjs` [13] 节：`preview` 截断与提示文案、无 `uni` 降级，外加一条**全仓静态守卫** —— 任何 `.vue/.js` 里再出现 `uni.showToast(` 或 `toast(x.slice(` 直接判 FAIL |
| 已知副作用 | `uni.setClipboardData` 在 App 端会自己弹一条系统级「内容已复制」提示，这是 uni 内部行为、不是本工程的 toast，无法关闭 |

### F21 车控页 / 车机域动作 / 交互组件（④ 车控 + ② 测试两页）

| 项 | 内容 |
| --- | --- |
| UI 入口 | **这两页都不在底部导航里**：`pages.json` 根本没有 `tabBar` 字段，底部导航是自定义组件 `tf-tabbar`（见 F23）。**「② 动作测试」= `pages/rke/rke`** 由 ① 页（`pages/index/index`）底部的「→ 上锁 / 解锁页」按钮进入，`index.vue:goRke()` 用的是 `uni.navigateTo`；**「④ 车控」= `pages/car-control/car-control`** 是重构前的旧车控页，还注册在 `pages.json` 里当协议对照，但当前**没有任何页面跳它** —— 日常车控在「控制」tab（`pages/control/control`），它把这一页的动作重排成了俯视车身图 + 误触分级（F23） |
| 调用链（车控页） | 上锁/解锁：`car-control.vue:doLock/doUnlock → src/services/vehicle-api.js:sendRke → src/services/vcsec/rke.js`（**VCSEC 域**）；开盖：`doOpen → sendClosure`（前备箱/后备箱，VCSEC）**或** `chargePortDoor(true)`（充电盖板，**INFOTAINMENT 域**）；车辆信息：`doInfo → vehicleData(keys) → car_server.Action{getVehicleData}`；在线探测：`doPing → pingInfotainment()` |
| 调用链（测试页新增卡） | `rke.vue`「车机域动作」卡：`doPing → pingInfotainment()`、`doVehicleData → vehicleData()`（不传类别 = 6 类各发一条再合并），底层都是 `src/services/infotainment/car-action.js:sendCarAction` |
| 用到接口 | `uni.setStorageSync / getStorageSync`（两份会话各自落盘）、`uni.vibrateShort`（滑动到位震动）、`uni.createSelectorQuery`（量滑动轨道宽度）；跳页只有 `uni.navigateTo` / `uni.reLaunch`，**全站不再使用 `uni.switchTab`**；BLE 侧仍全是 F9/F10，**车机域不新增任何 uni API** |
| 实现方式（会话） | **per-domain 会话**：`src/store/v3-session-store.js` 把 V3 会话按域分开存 —— `DOMAIN_VEHICLE_SECURITY(2)` 用老键名 `tesla_probe_v3_session_v1`（已绑好车的 counter 记忆不能动），`DOMAIN_INFOTAINMENT(3)` 用 `tesla_probe_v3_infotainment_v1`（两个键名都在 `src/config/index.js` 里，分别是 `V3_SESSION_STORE` / `V3_INFOTAINMENT_STORE`）。`v3Session/storeV3Session/invalidateV3Session/resetV3Session` 全部接受 `domain` 参数（默认 VCSEC，老调用点零改动），另有 `invalidateAllV3Sessions()`。**两域共用 counter 是错的**：官方 `dispatcher.go:36` 就是 `sessions [Domain_MAX]Session`，混用的话第二个域的第一条命令就会 `INVALID_TOKEN_OR_COUNTER` |
| 实现方式（报文） | 载荷从 `ToVCSECMessage` 换成 `car_server.Action{oneof action_msg{vehicleAction=2}}`，回包 `car_server.Response{actionStatus=1, oneof response_msg{vehicleData=2 / ping=9}}`。`sendRequest` 的域、载荷构造函数、终态判据全部参数化；`CSOperationStatus_E` **只有 OK/ERROR、没有 WAIT**（`car_server.proto:160-164`），所以车机域第一帧就是结论，不走 VCSEC 那套 WAIT 重发 |
| 实现方式（UI） | 图标**零静态资源**，但分两代：这两张旧页（`rke` / `car-control`）仍用 `components/car-icon` —— 7 种**纯 CSS 绘制**（lock/unlock/frunk/trunk/charge/car/info）；底部五个 tab 与 `binding` 用 `components/tf-icon`，图标来自 `src/ui/icons.js`（36 个内联 SVG path，运行时编成 `data:image/svg+xml` 交给 `<image>`）。两代都**不用图片文件、不用字体图标** —— 探针工程靠热更新改 JS，静态资源一旦漏进基座就是白屏，CSS 没有这个问题；原生 `tabBar` 之所以弃用也是同一条理由（它强制要 PNG，见 F23）。交互件四个：`car-icon` / `tf-icon` / `slide-confirm` / `confirm-dialog`，共用格子样式 `.grid/.tile/.tile-name/.tile-sub/.tile-off/.tile-on` 放在 `App.vue` 全局（组件自己那几份是 scoped，跨页复用不了） |
| 误触分级 | 按「发出去能不能收回」分三档：**上锁 / 关充电盖板 = 点一下就走**（可逆）；**解锁 = `confirm-dialog` 二次确认，3 秒倒计时走完才点亮确认按钮**（倒计时结束不会自动执行，这是刻意的：自动执行等于没有确认）；**开盖 = `slide-confirm` 推到轨道最右端才发**（开出去的盖没有任何命令能收回来） |
| GetVehicleData 的用法 | 六类开关（`src/services/infotainment/vehicle-data.js` 的 `VEHICLE_DATA`）：闭锁 / 充电 / 行驶 / 空调 / 位置 / 胎压，对应 proto 的 `getClosuresState` 等字段。**每类一条独立请求，不传 = 6 类各发一条再合并**（同文件的 `vehicleData(keys)`）—— 官方 `pkg/protocol/state.go:70-82 GetState` 一次只收一个 `StateCategory`，nanopb 侧同样是每次只置一个开关，没有人把 6 个开关塞进同一条请求；这条不是风格问题：一帧要装下 6 类的 answers 就会撞上 `fault=25 RESPONSE_MTU_EXCEEDED`（车辆收下请求、直接不发响应体），拆单类之后每条答案都小到装得下。页面先勾类别再点「车辆信息」，合并后的 `summary.data` 是解好的 `car_server.VehicleData`（字段名照 proto 原样 snake_case），`buildRows()` 把它摊成键值行；**消息型 oneof（如 `charging_state`）解出来是 `{ type: 'Charging' }`，页面读 `m.type`**。结果行首是 `GetVehicleData：N 类各发一条，M 类带回数据…`，**`M` 按类别计数，绝不能按合并后的字段数**：真机回包会 ① 在问 `drive` 的那一帧里**顺带**塞回 `location_state`，② 每条 `vehicleData` 尾部带一个官方 `vehicle.proto` 里没有的**字段 999（值恒 1）**，按 §6「未登记字段 → `f<n>`」的规则原样显示成 `f999=1`（三家参考实现全无此字段，**不给它编名字**），按字段数算就会报出「6 类各发一条，7 类带回数据」这种比问的还多的数。某几类被拒不拖累其它类；一类数据都没拿到时会打一条 `warn` 说明「这帧里没有 vehicleData，可能车机只回了 actionStatus」 |
| 成功标志 | 充电盖板：日志 `status=OPERATIONSTATUS_OK`，且车真的开 / 关盖板（**第三轮真机已达成：开 / 关都成**）；Ping：回包带 `ping` 字段；GetVehicleData：页面出现 `<时间> 拉取 · 共 N 项` 和键值行 |
| 失败判读 | ① `SESSION_INFO_STATUS_KEY_NOT_ON_WHITELIST` → 这把钥匙没进白名单，回 ① 页（车机域的握手与 VCSEC 域**各自判**，页顶状态条两域各报一份）；② `actionStatus=ERROR` → `result_reason.plain_text` 会原文拼进提示（`appOutcome`），这是车机自己给的原因，别当成传输问题；③ 只有超时没有 ERROR → 车机大概率睡了，先按「车机在线探测（Ping）」，Ping 不通就别试车控动作；④ `FAULT_IV_SMALLER_THAN_EXPECTED` → 该域的 counter 回退了，见 §8.1，**必须看清日志里是哪个域**（两域 counter 互不相干） |
| 现场建议顺序 | 到车控页先点「车机在线探测（Ping）」—— 它不动车上任何东西，却一次回答「链路通不通 / 钥匙在白名单不在 / 车机醒没醒」。Ping 通了再点车控动作，最后用 GetVehicleData 核对车上状态与页面显示是否一致 |

### F22 绑定档案与前台自动重连循环

| 项 | 内容 |
| --- | --- |
| 为什么要有它 | 密钥（`tesla_probe_key_v1`）和两域 counter 早就落盘了，**唯独「车是哪一台」没落盘** —— 结果每次重开 App 都要重走一遍「② 扫描并连接（手选）」。这一条把缺口补上：绑定成功当刻记下车辆蓝牙档案，之后打开 App / 从后台回前台自动连回。<br>**第二版缺口是「只试一次」**：真实用法是人离车还有几十米就点开 App，这一次必然连不上（deviceId 直连要等系统超时、扫描窗口里也收不到广播），等他走到车边 App 早就不试了，只能杀后台重开 —— 而私钥和 counter 明明都在，重开毫无意义。所以现在的语义是**前台期间持续重试**：连上即停、失败按退避继续、链路断了重新武装 |
| UI 入口 | ① 页「车辆」卡片：`绑定档案：<状态行>` + 三个按钮 `立即自动连接` / `恢复自动重连`（带 loading）/ `清除绑定档案`，前两个点完还会 toast 出本次结果 + 循环状态。「绑定与钥匙」页（`pages/binding/binding`）另有一张只读的「绑定档案」卡片，按钮只有 `清除绑定档案`（自动连接那两个留在 ① 页，避免同一件事有两个入口）。<br>循环状态同时挂在**顶部状态条共用 `statusText()` 的那几页**末尾（`src/domain/session-status.js:statusText()` 末尾追加一段 `自动重连：…`，调用它的是 home / binding / index / rke / car-control 五页），页面每秒随 `tick()` 刷新一次，所以「它还在试、下一轮几秒后」是看得见的 |
| 调用链 | 写：`index.vue:step3 / stepProbe` 成功（以及 `binding.vue` 的三处 `r.ok`）→ `src/store/bind-profile.js:markBound()`；`src/domain/connection-service.js:connectTo()` 连上即 `saveBind({vin, deviceId, name, connectedAt})`，并把退避档位与尝试计数归零。<br>读：`App.vue:onLaunch → loadBind()`；`App.vue:onShow → startAutoReconnectLoop('回到前台') → runLoopOnce() → autoReconnect()` → `ensureAndroidPermissions` → `BleTransport.init()` → **deviceId 直连** →（失败才）`BleTransport.discover(scanMs, namesForVin)` → `pickFromList` → `connectTo`。<br>停：`App.vue:onHide → stopAutoReconnectLoop('退到后台')`；断线：`ble()` 的 state 回调收到 `disconnected` → 档位归零 → `runLoopOnce('断线重连')` |
| 存储键 | `tesla_probe_bind_v1` = `{vin, deviceId, name, keyId, boundAt, connectedAt}`；`saveBind(patch)` 只接受非空字段（扫到一半失败也不会把档案里的 VIN 抹成空串） |
| deviceId 的稳定性 | Android 上 `deviceId` 就是**车辆真实 MAC**，iOS 上是系统发给本 App 的**稳定 UUID** —— 两者跨重启可用，所以第一优先直接连它，连名字被改过的车也能连上（F5.1 那种场景） |
| 扫描兜底顺序 | `pickFromList`：档案 `deviceId` → 命中 VIN 广播名 → 命中档案里的广播名（`normName` 宽松比较）→ 广播了 `0211`（特斯拉 VCSEC 服务）。一条都不中才算「没扫到」，并把前 8 个广播名（带 `[0211]` 标记）打进日志，提示踩刹车唤醒或手选 |
| 退避阶梯 | `RETRY_STEPS_MS = [3000, 6000, 12000, 24000, 30000]` —— 3 → 6 → 12 → 24 → 30 秒，**封顶不无限翻倍**。不按 1 秒死循环是为了避免车辆休眠 / 真不在范围时让系统蓝牙栈长期忙碌、费电；只有**自动重试**才升档，手动触发、连上之后、链路真断开时都归零重来（这几种情况下人就在车旁边，要的是马上连上）。下一次排到几点由 `armRetry()` 记进 `loopNextAt`，只给状态行算剩余秒数 |
| 两层单飞锁 | 循环层 `loopRun`（正在进行的那一轮 Promise）：`startAutoReconnectLoop()` 重复调用**复用同一轮**，不会叠加两轮扫描，且复用在飞轮次时**不清 `loopTries`**（否则状态行会退回「第 0 次尝试」）。尝试层 `autoConnecting`（`autoReconnect()` 内部）：`onLaunch` + 连续 `onShow` 也只会真跑一次 |
| 准入门 | `doAutoReconnect` 四道门按序返回：`hasKey()` → `skipped:nokey`、`hasBind()` → `skipped:nobind`、`!autoSuspended` → `skipped:suspended`、未连接 → `skipped:already`，缺一不可；再往上一层是 `App.vue:onShow` 里的 `if (!hasKey() || !hasBind()) return` —— 没绑过的人根本不该看到循环在跑 |
| 暂停与恢复 | 「断开连接」（`disconnectAll`）= 用户明确说「现在别连」→ `suspendAutoConnect(true)`，**并把已排期的重试一起取消**（否则退避到点又连回去了）；`forgetBind()` / `forgetKey()` 同样停循环。恢复靠三件事之一：**手动连接成功**（`connectTo` 里顺手 `autoSuspended = false`）、点「恢复自动重连」（立刻真跑一轮 + 重新武装，不用等下一次回前台）、回到前台。不做暂停这件事的话，用户刚拔掉连接 App 又自己连回去 |
| 后台策略 | `App.vue:onHide → stopAutoReconnectLoop('退到后台')`。Android 后台蓝牙扫描受系统限制、定时器也可能被冻结，与其留一个不知何时触发的重试，不如回前台从最低档重新开一轮（`onShow` 会重新启动） |
| 档案展示 | `describeBind()`：广播名 / `deviceId` 尾 14 位 / VIN 后 6 位 / `keyId` 前 8 位 + 绑定与最近连接时间；页面每秒随 `tick()` 刷新 |
| 循环状态行 | `describeAutoLoop()` 七种输出，逐档对应上面那些门：`未启动（无密钥或无绑定档案）` / `已暂停（你主动断开过，点「恢复自动重连」）` / `未启动（回到前台会自动启动）` / `已连上车，断线会自动重连` / `正在连接（第 N 次尝试）` / `X 秒后重试（已试 N 次）` / `等待中`。剩余秒数用 `max(1, …)` 兜底，避免排期到点后显示「0 秒后重试」 |
| 判据 | 冷启动或从后台切回，日志出现 `自动连接成功（deviceId 直连）…` 或 `自动连接成功（命中档案里的名字 …）`，且车控页状态条变为已连接 —— **不需要再点任何扫描/连接按钮**。<br>循环的判据是：人不在车边时打开 App，状态行会先显示 `正在连接（第 1 次尝试）`，失败后变成 `3 秒后重试（已试 1 次）` 并一路上到 30 秒封顶；**站在原地等 1 分钟不需要任何操作，走到车边的那一轮会自己连上**，日志同时出现 `自动重连第 N 次没成功（…），X 秒后继续重试 —— 走到车边会自己连上，不必重开 App`。已经连上车之后把车开走断链，状态行应立刻回到 `正在连接（第 1 次尝试）`（断线归零重武装） |
| 失败判读 | `skipped:nokey/nobind` = 还没绑过，走 ① 页正常流程，**循环会因此停掉**（重试一万次也不会有密钥）；`skipped:suspended` = 你主动断开过，循环让位，点「恢复自动重连」即可；`skipped:permission` = 系统蓝牙权限被拒（回查 F2）；`skipped:adapter` = 基座没带蓝牙模块（回查 F1）。<br>**最后一类才需要人介入**：`permission / adapter / scan / notfound / connect` 属于「情况会变」（走近、车醒、蓝牙打开），循环会按退避一直试，看到状态行里 `已试 N 次` 在涨就是它在正常工作，**不是失败** |

### F23 底部导航 / 五个 tab 页 / 视图仓库与动作台账

| 项 | 内容 |
| --- | --- |
| 为什么要有它 | F21 那两张页（② 测试、④ 车控）是**给协议对照用的**：一个动作一屏，日志滚动，能证明「这条字节真的能动车」。但日常想知道「锁没锁、还剩多少电、盖板开没开」的人不该被要求去读日志。这一节加的是**界面那一侧的基础设施**：底部导航、五个日常 tab、两个新页（诊断、绑定与钥匙）、一份车辆状态视图模型、一份动作台账。**协议层一行没动** —— 新页面调的还是 `src/services/vehicle-api.js` 里那批函数，走的还是 F13/F21 的收发通路 |
| 底部导航为什么不是原生 `tabBar` | **`pages.json` 里根本没有 `tabBar` 字段**，底部导航是组件 `components/tf-tabbar/tf-tabbar.vue`。理由跟图标同源：原生 `tabBar` 的 `iconPath` **只认包内 PNG 文件路径**，而本工程一个图片资源都不引（探针靠热更新改 JS，静态资源漏进基座就是白屏，F21 已记过这条）。图标是运行时编出来的 `data:image/svg+xml` 字符串，只能交给 `<image :src>`，喂不进原生 tabBar。`TABS` 五项固定为 `车辆 / 控制 / 温度 / 信息 / 诊断`（key 与页名一一对应：home/control/climate/info/diagnostics，图标 car/lock/thermo/info/pulse）；`active` 由每页自己传，`tabIconSize:'46rpx'`、`onColor:'#ffffff'`、`offColor:'#7a8593'` |
| 切页为什么是 `uni.reLaunch` | `go(t)` 第一行 `if (t.key === this.active) return`（点自己什么都不做，不重开一遍页面），其余一律 `uni.reLaunch({url: t.url})`。用 reLaunch 不是为了「看起来像 tab」，是为了**页面栈里只留当前这一页**：车辆 / 控制 / 温度 / 信息四页各自 `onShow` 订阅 `subscribeVehicle()`（存进 `_off`）并起一个 1 秒 `tick()` 定时器，诊断页多一条 `subscribeDiagnostics()`（`_offV` / `_offD` 两条），而**每页的 `onHide` 和 `unmounted` 都调同一个 `teardown()`**（清定时器 + 逐个调退订函数）；栈里只有一页时这套释放是确定会走到的。要按 `navigateTo` 堆栈来回点，五页各自的订阅和定时器会同时留着。`switchTab` 则压根不可用 —— 没有 `tabBar` 字段就没有 tab 页可切，**全站不再使用 `uni.switchTab`** |
| 页面与入口 | `pages.json` 十个在册页：五个 tab + `pages/binding/binding`（绑定与钥匙）+ `pages/index/index`（① 扫描·连接·绑定）+ `pages/rke/rke`（② 动作测试）+ `pages/debug/debug`（③ 报文控制台）+ `pages/car-control/car-control`（④ 旧车控，动作与调用链和「控制」tab 一字不差，只留作界面对照，见 F21）。**`binding` 不是 tab**：从首页功能列表 `uni.navigateTo` 进去，页内返回用 `uni.reLaunch({url:'/pages/home/home'})`，它自己不挂标签栏。向导三件套的进法：① 由 `binding` 页「① 扫描并连接」那一格（`doScan → uni.navigateTo`）进，② 与 ③ 由 ① 页底部按钮进（F21）；④ 由诊断页「④ 旧车控页（界面对照）」那一格 `uni.navigateTo` 进，它同样不在底部导航里，看完用系统返回键回到诊断页。「绑定页不挂标签栏」「界面里没有死链」和「在册的每一页都至少有一个入口」这三条由 [18] 静态扫描锁着 |
| 车辆 tab（`pages/home/home.vue`） | 主视觉 `tf-hero`：`batteryPercent` 大字 + `rangeText` + 侧视车身 `<tf-icon name="car-side" size="560rpx">`；下面三枚 chip（挡位 / 锁 / 充电），未上锁那枚转成 `tf-chip-warn`；再下面 `.tf-quick` 一排五格 `上锁 / 解锁 / 前备箱 / 后备箱 / 刷新`。误触分级沿用 F21 的三档口径，但**首页这一排的开盖用的是 `confirm-dialog :seconds="0"`（一次确认就发），只有解锁是 `:seconds="3" :danger`**；控制页的开盖才是 `slide-confirm`。列表项点 `binding` 走 `navigateTo`，其余走 `reLaunch`；状态行 = `statusText()`（末尾带 F22 的 `自动重连：…`） |
| 控制 tab 的俯视车身图 | `<tf-icon name="car-top" size="280rpx" height="438rpx">`，path 在 `src/ui/icons.js` 的 `CAR_TOP_BODY`（`car-side` / `car-top` 用各自 viewBox，因为它们不是 24 格小图标而是主视觉）。`dots()` 算七个点位：前备箱 `top:5%`、后备箱 `top:95%`、四门 `left:21%/79%` × `top:40%/64%`、充电盖板 `left:17% top:82%`；源码注释写明方位口径 —— **图里车头朝上，图的左边就是车辆左侧（驾驶侧），盖板在左后翼子板上，所以点位压在左下而不是右下**。读的是 `vehicleView().doorStates` 的四个键（`driverFront / passengerFront / driverRear / passengerRear`） |
| 点位的第三态 | `tri(b)`：`true → dot-open`（黄）、`false → dot-shut`（绿）、其它 `→ dot-unk`（虚线圈）。注释就是这条的理由：**把「车机没回这个字段」画成「关着」，等于让界面替用户下了一个没有依据的结论**。中央锁不复用 `tri()` 而是另写 `lockDot(b)` —— 上锁才是安全态（绿 `dot-shut`），未上锁要标红（`dot-bad`），未知仍是 `dot-unk`：这里「不是上锁」跟「开着」不是一回事 |
| 充电盖板 A/B 对照（控制页） | 同一个物理动作有两条协议路径，两条都留在界面上各按一次，靠「盖板当前」那行有没有真的变来判断这台车吃哪条：A `car_server ChargePortDoorOpen / Close`（台账动作名 `打开充电盖板` / `关闭充电盖板`，tag `INFOTAINMENT`）、B `closureMoveRequest{chargePort: OPEN / CLOSE}`（动作名 `OPEN_CHARGE_PORT` / `CLOSE_CHARGE_PORT`，tag `VCSEC`）。每组按钮下面那行结论不是页面临时变量，是 `lastResult(name, tag)` 从台账取的 —— 所以离开页面再回来、甚至重启 App 之前的会话里，试过什么还在。`PATHS` 这份字面量在 `pages/control/control.vue` 和 `pages/diagnostics/diagnostics.vue` 各抄一份，**改一个字就命中不到台账**，这条由 [18] 逐字比对锁住 |
| 温度 tab / 信息 tab | `pages/climate/climate.vue`：车内 / 车外两个读数 + `启动空调`（`HvacAutoAction`）/ `关闭空调` / `刷新温度`（只问 climate 一类）；**设定值只读** —— `car_server.proto` 里 `SetKlimatZoneValues / SetTemps` 这类带动温度的动作既没在 `src/protocol/v3/spec.js` 登记、也没有取证到的金标准字节，按「不许猜字节」的规矩宁可不放按钮。`pages/info/info.vue`：里程与挡位、胎压四角、位置三段；按钮 `刷新全部 / 里程挡位 / 位置 / 胎压`；两条口径写死在页面上 —— 胎压单位按 `vehicle.proto` 原样是 **bar**（不是 kPa 也不是 psi），「定位时间」读的是 `location_state` 自带的 `gps_as_of` 而不是本页刷新时刻（BLE 链路本身没有 GPS） |
| 图标唯一数据源 | `src/ui/icons.js` 的 `ICONS` 共 **36 个键**（`lock unlock frunk trunk charge chargeport flash horn power vent car thermo heat cool fan pin gauge tire calendar shield battery info pulse key bluetooth wrench chevron chevronDown refresh close check warn plus minus car-side car-top`）。`iconSvg(name, …)` **遇到未知名返回空串**，`iconSrc` = `'data:image/svg+xml;charset=utf-8,'` + 编好的串；`enc()` 那里的注释记了一个坑：**`#` 必须转义**，data URI 里 `#` 之后会被当 fragment，颜色值整条截断。`tf-icon` 组件负责把 `iconSrc` 交给 `<image>`；`tf-tabbar` 直接 `import { iconSrc } from '@/src/ui/icons.js'` 而不套 `tf-icon`（省掉 easycom 解析成本）。两代图标并存：`rke`（②）与 `car-control`（④）两张老页仍是 `components/car-icon`（7 种纯 CSS 绘制，F21）；`tf-icon` 用在车辆 / 控制 / 温度 / 诊断四个 tab 页和 `binding`（`info` 页是纯读数，一枚图标都没画），标签栏则直接吃 `iconSrc` |
| 深色主题与全局样式只有一份 | 调色板挂在 `App.vue` 的 `page` 选择器上（`--bg / --bg-top / --bar / --card / --card-2 / --card-3 / --line / --text / --text-2 / --text-3 / --accent / --accent-2 / --ok / --warn / --err`），页面和组件一律读变量、不写死颜色；跨页共用的类（`.grid .tile .tile-name .tile-sub .tile-off .tile-on` 和 `.tf-hero .tf-batt .tf-chip* .tf-quick .tf-li* .tf-kv* .tf-empty`）也放全局，因为组件里那份是 scoped，别的页面复用不了 |
| 读数的唯一来源 | `src/store/vehicle-store.js:vehicleView()`。第三态常量 `UNKNOWN`（`'未知'`），从 `src/services/index.js` 出门面时别名成 `VEHICLE_UNKNOWN`；**页面侧不许 `|| false` / `|| 0` 兜底**，也不许自己去挖 `closures_state` 那类嵌套结构 —— 单位换算（英里→公里 `MI_TO_KM = 1.609344`、百分之一英里、伪枚举取 `type`）全在 store 做完，显示层只负责把 `null` 写成「未知」（`src/ui/format.js` 的 `unit() / yesNo() / ago() / clock()`）。写入只有两条：`applyVehicleData(payload, source)` 是**整体替换**（不是逐字段 merge），空数据直接 `return { updated: false }` **不抹旧值**；`clearVehicle(why)` 由 `src/services/credential-service.js:forgetBindProfile()` 调用 —— 清除绑定档案时必须连旧状态一起丢掉，否则换了车还在显示上一台的电量。全工程**唯一的 `applyVehicleData()` 调用点**在 `src/services/vehicle-api.js` 的 `vehicleData()` 里，页面不直接写仓库。每页都显示 `ago(updatedAt, now)` + `共 N 类`，断线后看到的是「最后一次拉到的那份 + 它有多旧」 |
| `categories` 怎么数 | store 里的 `CATEGORY_OF_FIELD` 把回包字段映射回六个类别，注释明确把字段 999 排除在外 —— **它不能混进 `categories`，否则界面又会算出「问 6 类回 7 类」**（F21 那条真机口径在界面侧的落点）。`hasData / categories / source / updatedAt` 是四页顶部那行小字的来源 |
| 动作台账 | `src/store/diagnostic-store.js`。`src/services/vehicle-api.js:tracked(name, fn, tag)` 包住每一个导出动作，登记名是**写死在这一个文件里的中文字符串**：`绑定（刷钥匙卡）` / `会话内加白名单` / `探针确认是否已入白名单` / `重新握手` / `V3 握手` / `查白名单` / `查车辆状态` / `查白名单条目 <槽位>` / **`驾驶授权（RemoteDrive）`（F24，tag `VCSEC`）**，以及 `RKE 动作`、`闭锁器请求`、`信息查询` 三条**允许调用方改名**的（`tracked(name || 'RKE 动作', …)`，tag `VCSEC`）—— 界面上看到的 `LOCK` / `UNLOCK` / `OPEN_FRUNK` / `OPEN_CHARGE_PORT` 就是页面传进来的 `name`，这正是 A/B 对照表里 B 路径那两个动作名的出处。车机域那组固定 tag `INFOTAINMENT`：`打开充电盖板` / `关闭充电盖板`、`闪灯`、`鸣笛`、`启动空调` / `关闭空调`、`车窗通风` / `关窗`、`Ping（车机探针）`、`GetVehicleData <类别1+类别2>`（不传类别时是 `GetVehicleData（全部）`）。成功失败都折成一条 `{name, ok, text, at, tag}`（`recordResult` / `recordError`，后者把 `err.message`、`errMsg` 和 `errCode=` 一起拼进 `text`）。`MAX_DIAGNOSTICS = 60` 是**环形缓冲**（超了 `shift()` 丢最旧），但 `total / okCount / failCount` 统计的是**全历史** —— 清掉旧记录不该让「这台车到底试了多少次」消失。`recentResults(limit)` 新→旧返回、不截断 `text`；`lastResult(name, tag)` 要求 name 与 tag 双命中（同名动作在两域都有，盖板那条就是）。**红线照旧**：台账只存「动作名 + 结论」，绝不存载荷、密钥、epoch、共享秘密，也不落盘 |
| 诊断 tab（`pages/diagnostics/diagnostics.vue`） | 三块：A/B 对照卡、动作台账、手动触发区。对照卡的 `paths` computed 取两条记录里 `at` 更新的那条，文案 `最近一次成功 · <动作名> · <ago>`，一条都没有就是 `这条路径还没试过`。触发区五个按钮 `刷新全部数据 / 查车辆状态 / 查白名单 / 重新握手 / 车机 Ping`（`busy` 分别 91/81/82/83/84），台账每条显示 `r.tag || '无域'`，默认看最近 20 条、可在 20 与 60（`MAX_DIAGNOSTICS`）之间切。`清空` 按钮的提示写的是「正在对照 A/B、或准备把日志发给别人时别清」—— 这页存在的意义就是把结论留在屏上给人看，所以清空的代价要说清楚。触发区下面还有一格 `④ 旧车控页（界面对照）`（`goLegacy → uni.navigateTo`）：怀疑「动作没反应」到底是协议不通还是新界面的交互挡住时，从那页用老九宫格再按一次同一条命令，它的结论同样落进这页的台账 |
| 绑定与钥匙页（`pages/binding/binding.vue`） | 档案**只读 `describeKey()` / `describeBind()` 这两句原文**，页面不自己拼字符串（同一份档案在 ① 页和这里必须长得一样）。`formFactorOptions() / defaultFormFactor()` 把官方四个 `FORM_FACTOR` 枚举全开，默认值定在 `src/domain/v3-context.js`（`KEY_FORM_FACTOR_ANDROID_DEVICE`）；VIN 输入框跟 ① 页共用同一个 `VIN_STORE` 键，在任一处填过另一边就有。「绑定顺序」六格：① 扫描并连接 / ① 按档案回连 / ② 刷卡绑定 / ③ 探针确认 / 查白名单 / 重新握手，另两枚 mini 按钮 `会话内加白名单`、`断开连接`；刷卡那一格旁边写明了**手机 NFC 贴上去没有任何作用（车端读卡区只认 RFID 卡）**。「清除（只动本机）」那张卡的文案直接说后果：`它删不掉车辆那一侧的记录：要彻底不再让这台手机动车，得在车机 Safety 里把对应钥匙删掉` |
| 页面 import 的边界 | 十个页面里**动作一律来自 `src/services/vehicle-api.js`，状态与档案一律来自门面 `src/services/index.js`**（全具名再导出，不用 `export *`，见 §2），外加显示层的 `src/ui/format.js` 和 `src/infra/platform/notify.js`；只有 `binding` 与 `index` 还直接碰了 `src/protocol/identity.js`、`src/config/index.js`（`VIN_STORE`）、`src/infra/storage/local-store.js`、`src/infra/platform/permissions.js`、`src/infra/bytes.js` —— 页面自己不去挖 `src/protocol/v3/` 或 `src/services/vcsec|infotainment/` |
| 回归锁 | `tests/run.mjs` 的 **[17]「车辆状态仓库 / 诊断台账（UI 视图模型）」42 条**（三态、单位换算、`UNKNOWN` 不兜底、整体替换不抹旧值、环形 60 与全历史计数、`lastResult` 双命中、`clearVehicle` 口径）与 **[18]「路由与界面字面量」16 条静态扫描**（在册 10 页且每册有 `.vue`、`pages/home/home` 排第一、界面里没有死链、在册的每一页都至少有一个入口、诊断页与绑定页真的被引用、标签栏五项且每项 url 与 key 配对且图标名有效、五个 tab 页都挂了 `active` 对应的标签栏、绑定页不含 `tf-tabbar`、控制页与诊断页的 A/B 台账键逐字一致，外加 F24 驾驶授权那五条：控制页台账键与 `vehicle-api` 逐字一致 / 解锁确认不夹带 RemoteDrive / 这颗按钮只触发一次 / `rke.js` 里没有 `REMOTE_DRIVE` / 文案不伪造启动状态）；`tests/vue-check.mjs` 真 import 全部 **17 个 `.vue`**（`pages/` + `components/` + `App.vue`），模板里写错组件名、脚本顶层抛错都会在这里现形 |
| 已知边界 | [18] 只校验**标签栏那五个图标名**在不在 `ICONS` 里；页面里手写的 `<tf-icon name="…">` 拼错，离线自检抓不到，而 `iconSvg()` 对未知名返回空串 —— 于是运行时表现是**图标位置空白，不是报错**。这也是这套界面只当「读数与操作面板」、判障仍然回 ③ 报文控制台和 §7 的原因之一 |

---

### F24 驾驶授权（RemoteDrive）—— 解锁了还是挂不上挡

| 项 | 内容 |
| --- | --- |
| 为什么要有它 | `Unlock()` 解开的是**中央锁**，挂 D/R 挡要的是**驾驶授权（drive authorization）**，官方把它们算作**两条命令**。第三轮真机之后现场就是这句话：解锁执行成功、门能拉开，上车踩刹车仍然挂不上挡。这一节加的是那条缺失的命令本身 —— 一条独立动作 + 控制页一颗独立按钮。<br>**第四轮真机（同一台车）把它上车验过了**：BLE 发 `REMOTE_DRIVE` 车辆**接受**（不是 code 7、也不是 code 6），挂挡成功。于是交互层多了一层编排：**解锁拿到终态成功之后自动补发一条授权**（见 **F25**）。但「并入」的边界没有变 —— 协议层与 `src/services/vcsec/` 这一层**永不**把两条命令缝在一起，串发只发生在上层 `src/services/vehicle-api.js:unlockAndDrive()`（车端按命令逐条授权，缝进 `Unlock()` 会让一次点击变成两笔不可拆分的操作，也会让「解锁被拒」和「授权被拒」两种结论混成一坨） |
| 官方取证（本地副本 `ref-repos/vehicle-command`，commit `f61e29e`，逐行核过） | 三个问题各有一条硬证据：<br>**① 它是不是独立命令？** `pkg/vehicle/vcsec.go:173-193 executeRKEAction(ctx, action)` 是 `Unlock / Lock / RemoteDrive / AutoSecure / Wake` 共同的出口，`:200-202 RemoteDrive(ctx)` 的函数体就一行 `executeRKEAction(RKE_ACTION_REMOTE_DRIVE)`。官方 SDK 里没有任何「unlock 顺带发 drive」的代码路径 —— 所以本项目的**协议层与 `services/vcsec/` 层也绝不发第二条**，第四轮真机之后的串发只存在于上层编排（F25）。<br>**② BLE 允不允许？** `cmd/tesla-control/commands.go:311-318` 的 `"drive"`（help 文本 `Remote start vehicle`）与 `"unlock"` / `"lock"` 完全同级：`requiresAuth: true`、`requiresFleetAPI: false`、不设 `domain`；而 `configureFlags` 在 `--ble` 下**只拒绝 `requiresFleetAPI` 的命令**。也就是说**官方 CLI 明确允许 `drive` 走 BLE**，`RemoteDrive()` 里也没有一行 transport 判断。<br>**③ Fleet 那条是不是另一套字节？** `pkg/proxy/command.go:207-208` 的 `remote_start_drive` 转调的**还是同一个 `v.RemoteDrive(ctx)`** —— 两条通道发到车上的载荷一模一样，差别只在 transport。<br>**结论**：不存在「SDK 禁止 BLE 做驾驶授权」这回事；能不能过**只由车端策略决定**，撞上 `GENERICERROR_NOT_ALLOWED_OVER_TRANSPORT(7)` 才是这台车在说「这条不许走 BLE」（§7.5） |
| 调用链 | **单独按按钮**：`pages/control/control.vue:doDrive()` →（`guard(13, …)` 单飞锁）→ `src/services/vehicle-api.js:remoteDrive()` = `tracked('驾驶授权（RemoteDrive）', …, 'VCSEC')` → `src/services/vcsec/drive.js:requestDrive()` → `src/services/vcsec/rke.js:sendRke(RKE.RKE_ACTION_REMOTE_DRIVE, 'REMOTE_DRIVE')` → `src/domain/command-dispatcher.js`（V3 加密、WAIT 重发、回执判读）。门面侧 `src/services/index.js` 再导出 `requestDrive` 与 `GENERIC_ERROR_HINTS`。<br>**随解锁串发**：`control.vue:onConfirm()` → `vehicle-api.unlockAndDrive()` —— 见 **F25**。<br>第四轮真机顺带修了 `command-dispatcher.js` 的重发语义（VCSEC 每圈重签、counter 前进），所以这一行的「一行没改」已经不成立，改动见 F18 与 F25 |
| 报文 | 与 `UNLOCK` / `LOCK` 同一形状：`ToVCSECMessage{ SignedMessage{ signature_type=PRESENT(2), signer_identity=ROOT, protocol_metadata=0x00, protobuf_message_as_bytes=Encrypt(UnsignedMessage{ RKEAction=20 }) } }`。内层 oneof 显式编码为 **`10 14`**（tag `1000 \| 2` = 字段 20，varint `14` = 20；按 proto3「oneof 成员一律显式存在」的规矩写死，见 §10，与 `UNLOCK` 的 `10 00` / `LOCK` 的 `10 01` 同一把锁）；信封、`flags = 1<<FLAG_ENCRYPT_RESPONSE`、签名身份与 F13 那两条金标准**一字不差**，只是内层换了一个枚举值 |
| UI 入口 | 控制 tab 那张卡「驾驶授权 · Remote Drive」（在「车锁与寻车」卡与「前备箱 / 后备箱」卡之间）：按钮文案是 **`重新请求驾驶授权`**（第四轮之后它是**重试**入口，正常路径由解锁串发，见 F25；`busy === 13`，与页面其它按钮共用单飞锁）+ 一行回执。回执**只读台账**：`lastResult('驾驶授权（RemoteDrive）', 'VCSEC')`，三种状态 —— `还没试过 · 点解锁时会自动发一次` / `车辆回执通过 · <多久前>` / `车辆回执拒绝 · <多久前>`。卡片说明写清了：解锁时已自动发过一次、这颗按钮用于窗口过去或那次被拒后单独重试、操作顺序（**先授权，再挂 D/R**）、以及这颗按钮为什么还留着（特斯拉手册口径：App 车控的驾驶授权约**两分钟**窗口，过期不必重走解锁）。code 7 的唯一出路也写在里面（改走 Fleet `remote_start_drive`，本项目没有网络通道，所以只能提示而不能代做） |
| 回执怎么判读 | 成功/失败一律用 VCSEC 域原有口径（§7.1 / §7.2）：没有 `commandStatus` 的空消息 = 成功；`WAIT` = 当下不肯执行、按 1 秒**重新签一份**整条重发（VCSEC 的 counter 必须前进，F18/F25）；`ERROR` 时把 `GenericError_E` 原文连同**处置建议**一起上抛 —— `src/domain/response-hints.js:GENERIC_ERROR_HINTS` 按枚举名匹配（`sendRequest` 的失败分支只回 `{ok, text, fault}` 不带 obj，所以匹配的是 `label('GenericError_E', …)` 渲染出的名字），**六个**码各有一句下一步，全表见 **§7.5**。<br>处置建议的上半截由 `command-dispatcher.js:genericErrorHint()` 统一拼接（解锁 / 上锁 / 驾驶授权三条动作共用同一张表），所以 `src/services/vcsec/drive.js` 里**只剩发命令与一条 `warn` 日志**，不再自己追加文案；被拒时的 `warn`：`车辆没接受驾驶授权：先确认挡位在 P，再看上一行的拒绝原因` |
| 红线 | ① **不并进 Unlock**：解锁的确认回调里一条命令就是一命令（[18] 静态扫描盯住 `rke.js` 里没有 `REMOTE_DRIVE`、解锁/上锁实现也没顺带发它）；② **不模拟成功**：界面那一行永远来自台账里车辆自己的回执，没有任何「点了就当已启动」的乐观更新（[18] 有一条专门扫按钮文案，出现「已启动 / 启动成功」这类替车辆下结论的字样即 FAIL）；③ **不猜字节**：`REMOTE_DRIVE` 只有官方枚举值 20 这一种写法，载荷由 `src/protocol/v3/spec.js` 的 `oo()` 打标生成 |
| 红线 | ① **协议层不并入 Unlock**：`src/services/vcsec/rke.js` 里永远不许出现 `REMOTE_DRIVE`，解锁 / 上锁的实现也不顺带发它（[18] 两条静态扫描分别盯住这两点）；串发只发生在**上层编排** `vehicle-api.unlockAndDrive()`，而且只以「解锁拿到终态成功」为前提（[18] 用正则锁住 `if (!u || !u.ok) return u;` 之后才 `await remoteDrive()`）。<br>② **不模拟成功**：界面那一行永远来自台账里车辆自己的回执，没有任何「点了就当已启动」的乐观更新（[18] 有一条专门扫按钮文案，出现「已启动 / 启动成功」这类替车辆下结论的字样即 FAIL，同时要求保留「车辆回执通过」这种转述口径）；串发时授权被拒**也不回头否定解锁**（[15] 有专门一条：`r.ok === true && r.unlock.ok === true && r.drive.ok === false`）。<br>③ **不猜字节**：`REMOTE_DRIVE` 只有官方枚举值 20 这一种写法，载荷由 `src/protocol/v3/spec.js` 的 `oo()` 打标生成 |
| 回归锁 | `[10]`（`REMOTE_DRIVE` 内层载荷 = `1014`）+ `[11]`（枚举表保留 20 且不与 `UNLOCK` 复用、未连接时分段与抛错、台账里 `驾驶授权（RemoteDrive）`/`VCSEC` 命中、`services/vcsec/index.js` 与门面两层导出齐全、`GENERIC_ERROR_HINTS` 可读）+ `[15]` 假车机端到端（驾驶授权与串发合计 **24 条**：握手只走 VCSEC、明文里出现 `1014`、回执 `ERROR` 判失败且**不因为被拒就重发**、被拒时那条人话警告、`NOT_IN_PARK` 时文案带上 P 挡指引，外加 F25 的 15 条）+ `[18]` 的**七条**（控制页台账键与 `vehicle-api` 登记名字**逐字一致**、解锁确认走 `unlockAndDrive()` 且页面只有一处调用、串发以 `u.ok` 为前提、页面不再自拼 `RKE_ACTION_UNLOCK`、单独重试那颗只出现一次、`rke.js` 里不出现 `REMOTE_DRIVE`、按钮文案不伪造启动状态） |

---

### F25 解锁串发驾驶授权 +「锁车要按两次」的真相（第四轮真机）

第四轮真机带回来两件事：一件是**好消息**（用户原话「我下去测试了，没问题」= BLE 发 `REMOTE_DRIVE` 这台车接受），另一件是**抱怨**（「不希望上车后还要再点击一次启动」+「授权启动后，锁车好像要点两次才能上锁」）。两条都落进了代码，也各自有回归锁。

| 项 | 内容 |
| --- | --- |
| ① 串发：一次点击做完两件事 | 调用链 `pages/control/control.vue:ask('unlock')` →（3 秒倒计时确认弹窗）→ `onConfirm()` → `guard(12, …)` → `src/services/vehicle-api.js:unlockAndDrive()` → 先发 `sendRke(RKE.RKE_ACTION_UNLOCK, 'UNLOCK')`，**只在它终态成功之后**才 `await remoteDrive()`。编排放在 `services/vehicle-api.js` 而不是 `services/vcsec/`，有三个理由：**a)** 协议层那一层仍然是一命令一动作（F24 红线①，[18] 静态扫描守住）；**b)** 两条动作各占一条台账，页面两行读数不互相覆盖 —— `UNLOCK` / `驾驶授权（RemoteDrive）` / `解锁并授权驾驶` 三个键都在（[15] 用 `lastResult` 三条逐一命中验证）；**c)** 不产生 `services → vehicle-api` 的反向依赖 |
| 返回形状 | `{ ok, unlock, drive, text }`：整体 `ok` 等于**解锁的 `ok`**（授权被拒不把已成功的解锁说成失败 —— 门确实开了，界面不许替车辆改写结论）；`text` 把两条回执**分开贴**，第二段固定前缀 `驾驶授权：`。授权没拿到回执时贴的是 `未发起（车辆没给回执）`，不是自造的「成功」 |
| 单独那颗按钮为什么还留着 | 特斯拉手册口径：App 车控的**驾驶授权约两分钟**窗口。窗口过去了、或串发那一次被车端拒了（不在 P 挡 / 已被拒），不用再走一遍解锁，直接按「重新请求驾驶授权」。控制页那张卡的说明写的就是这个顺序 |
| ②「锁车要按两次」= 我方缺陷，不是车端策略 | 根因在 `src/domain/command-dispatcher.js:sendRequest()` 的重发实现：车辆回 `OPERATIONSTATUS_WAIT` 时它整条重发，但**复用同一份已编码字节** —— 这是为了让车机域（`GetVehicleData`）的迟到回包还能验过 `request_hash` 而设计的。VCSEC 不适用这套：同一份字节意味着 **counter 不前进**，车辆按 `protocol.md:547-549`（Infotainment 用 sliding window 容忍乱序，**VCSEC 要求消息按 counter 顺序到达**，重复 counter → `MESSAGEFAULT_ERROR_REPEATED_COUNTER`）把重发帧**当旧包丢弃**。现场就成了「第一次按了没反应，再按一次才上锁」—— 因为第二次才是一次全新的 `sendRequest()`，counter 才前进 |
| 官方怎么做的（本地副本 `ref-repos/vehicle-command`，commit `f61e29e`，逐行核过） | 官方有**两层重试，语义不一样**：<br>**应用层** —— `pkg/vehicle/vcsec.go:84-105`：`executeRKEAction` 收到 `WAIT` 返回 `ErrBusy`，外层循环**重新调 `dispatcher.Send`**。每次 Send 都会重新 `session.authorize`（`dispatcher.go:428`）→ `counter++` / 新 nonce / 新 tag，并且 `dispatcher.go:392-413` 为 VCSEC 域**重新随机 `routing_address`、重新生成 uuid**。<br>**传输层** —— `dispatcher.go:434-460`：`for { d.conn.Send(ctx, encodedMessage) }` 反复发**同一个已编码 `encodedMessage`**。<br>所以正确照抄是：**车机域复用同一份字节（传输层语义），VCSEC 每圈重新签一份（应用层语义）** |
| 修复 | `command-dispatcher.js`：`const resignVCSEC = !opts.plain && domain === VCSEC`；每一圈 `if (stale \|\| resignVCSEC) built = null` 强制重建，重建时若 `frames > 0` 就换 `routingAddress` 与 `uuid`（照官方 392-413）；重发日志按域写清是哪一种（VCSEC 写 `counter 必须前进`）。顺带修掉一个跨域缺陷：`resync` 作废会话后原来仍会拿旧 epoch 的帧去撞新会话，现在由 `stale` 标志强制重建 |
| 别人的「丝滑」是什么 | 官方 App / tesla-tools 那条路径靠的**不是把两条命令缝起来**，而是：**BLE Presence 自动解锁**（靠近即解，无点击）+ **远离自动上锁**（`AUTO_SECURE`，无点击）+ App 里的 keyless driving 给一个约两分钟的授权窗口。本探针是**按钮式**的（无后台常驻、无 presence 订阅），能做到的极限就是：一次点击串完两条 + 把 counter 缺陷修掉 + 把车端策略写进界面提示。<br>另有一条**必须留在界面上的车端策略**：**手机钥匙还在车内时车辆会故意拒绝上锁**（回执撞 `GENERICERROR_ALREADY_ON` / `CLOSURES_OPEN` 也是同一类），这不是链路故障，`src/domain/response-hints.js` 与「车锁与寻车」卡的 `tip` 都照这个口径写，避免下一次再把「点两次才锁上」错怪成 counter 问题 |
| 回归锁 | `[15]` **15 条**新增：车辆回 `WAIT` 后确实重发了一条 / 两条的 `counter` 依次 `BASE+1 → BASE+2`（**不是原样重发旧帧**）/ 两份帧的**上线整帧字节不同**（新 nonce + 新 tag + 新路由地址）/ 重发**不必重新握手**（`handshakes === ['VCSEC']`）/ 第二次拿到终态才算成功 / 日志按域写明「重新签一份」；串发 5 条（两条 VCSEC 命令明文依次 `1000` / `1014`、共用同一次握手、整体成功以两条各自终态为准、回执把两条结论分开、三条台账键各自命中）；授权被拒不否定解锁 2 条；解锁被拒时**绝不补发授权** 2 条（`cmds.length === 1`）。车机域那条真机回归用例（`wire[0] === wire[1]`，同字节重发）仍然通过 —— 两域的分岔是**有意的**，不是回归。静态侧 `[18]` 的 18 条里共 **7 条**守驾驶授权与串发口径（其中 **4 条**是这一轮新写的口径：解锁确认全页只调 `unlockAndDrive()` 一处、正则锁死「先判 `u.ok` 才 `await remoteDrive()`」、页面不再自拼 `RKE_ACTION_UNLOCK`、`remoteDrive()` 全页只出现一次），逐条见 F24 红线与 §6 `[18]` 行 |

---

## 4. 接口总表（本工程用到的全部外部 API）

### 4.1 uni.\* —— 蓝牙（App 端，需自定义基座含 Bluetooth 模块）

| 分类 | API | 参数要点 | 失败时表现 / 备注 |
| --- | --- | --- | --- |
| 适配器 | `openBluetoothAdapter` | `{mode:'central'}`，失败降级 `{}` | 标准基座 → 弹「打包时未添加bluetooth模块」 |
| 适配器 | `getBluetoothAdapterState` | — | `available=false` = 系统蓝牙未开 |
| 适配器 | `closeBluetoothAdapter` | — | 忽略错误 |
| 扫描 | `startBluetoothDevicesDiscovery` | `allowDuplicatesKey:false, powerLevel:'high', interval:0` | 权限不足时**不报错**，只是永远扫不到 |
| 扫描 | `onBluetoothDeviceFound` / `offBluetoothDeviceFound` | 回调 `res.devices[]`，字段 `name/localName/deviceId/RSSI/advertisServiceUUIDs` | `off*` 老版本不存在，已保护 |
| 扫描 | `stopBluetoothDevicesDiscovery` | `allowDuplicatesKey:false` | 规则 A：连上后必须调 |
| 连接 | `createBLEConnection` | `{deviceId}` | 槽位被占（约 3 台）时超时/拒绝 |
| 连接 | `onBLEConnectionStateChange` | `{deviceId, connected}` | 车机休眠会掉线 |
| 连接 | `closeBLEConnection` | `{deviceId}` | 忽略错误 |
| 枚举 | `getBLEDeviceServices` / `getBLEDeviceCharacteristics` | `{deviceId}` / `{deviceId, serviceId}` | 需连接后 `delay(600)` 才稳定 |
| MTU | `setBLEMTU` | `{deviceId, mtu}` | **仅 Android**；iOS 无此 API |
| 订阅 | `notifyBLECharacteristicValueChange` | `{deviceId, serviceId, characteristicId, state:true}` | **Q1 风险点**：无法手写 0x2902 描述符 |
| 收 | `onBLECharacteristicValueChange` | `res.value` 为 `ArrayBuffer` | 可能半帧，按 2 字节大端前缀重组 |
| 发 | `writeBLECharacteristicValue` | `{deviceId, serviceId, characteristicId, value:ArrayBuffer}` | 帧 > `mtu-3` 会被栈拒绝（**Q3**） |
| 读 | `readBLECharacteristicValue` | 同上（0214） | 返回 `res.value` |
| 其它 | `setKeepScreenOn` / `setStorageSync` / `getStorageSync` / `showModal`（提示弹窗，见 F20）/ `setClipboardData`（复制，由 `src/infra/platform/notify.js` 统一封装）/ `navigateTo` / `reLaunch` / `createSelectorQuery` / `vibrateShort` | — | 与蓝牙无关的辅助能力；**`showToast` 已全部停用**，正文会被截断且无法复制。跳页只有两条：tab 之间用 `uni.reLaunch`（`components/tf-tabbar` 的 `go()`），非 tab 页用 `uni.navigateTo`；**全站不再使用 `uni.switchTab`**，因为 `pages.json` 里没有 `tabBar` 字段（为什么不用原生 tabBar 见 F23）；`createSelectorQuery` + `vibrateShort` 只服务滑动确认组件（量轨道宽度、到位震动），两者都有 `typeof` 守卫，Node 自检下自动跳过 |

### 4.2 plus.\* —— 5+ 原生桥（仅 App 端存在）

| API | 用途 |
| --- | --- |
| `plus.android.importClass('android.os.Build$VERSION').SDK_INT` | 决定运行时申请哪一套蓝牙权限（§3 的 F2） |
| `plus.android.requestPermissions(perms, ok, err)` | 申请定位 / SCAN / CONNECT |
| `plus.runtime.version / versionCode / appid / standalone` | 日志里确认「跑的是哪个基座」 |
| `typeof plus.bluetooth` | 基座是否编译了 Bluetooth 模块的**权威自检** |

> 全部 `plus.*` 调用都在 `try/catch` 或 `typeof` 守卫里，H5 / 小程序下不会崩，只会退化成「只能在 App 真机上运行」。

---

## 5. 在 HBuilder X 里跑起来

1. HBuilder X → 文件 → 打开目录 → 选 `f:\Desktop\test\tesla-ble-probe`。
2. `manifest.json` 的 `appid` 已填（`__UNI__4D4E055`）；换账号需点「重新获取」。
3. 手机开「开发者选项 + USB 调试」，数据线连电脑。
4. 运行 → 运行到手机或模拟器 → 运行到 Android App 基座 → 选设备。
   - **必须用自定义调试基座**：`uni.openBluetoothAdapter` 属于 5+ 的 Bluetooth 模块，已在 `manifest.json` 的 `app-plus.modules.Bluetooth` 声明，但**标准基座（HBuilder app）没编译这个模块**。
   - 做法：发行 → 原生App-云打包 → 只勾 Android → 勾选「打自定义调试基座」→ 完成后在运行面板把基座切成「**使用自定义基座运行**」。
   - `manifest.json` 里已声明 `modules.Bluetooth` + 14 项权限 + `abiFilters` + `minSdk 21`；**这些编译进基座，改一次要重打一次**。改 JS 只走热更新，不占打包次数。
   - 已知坑：HBuilderX 的「App模块配置」可视化界面持有 `manifest.json` 的内存模型，在界面里保存会把手写的 `modules` 覆盖掉。**每次打包前确认「蓝牙(Bluetooth)」显示为已勾选**，并抬高 `versionCode`，否则手机上装的还是旧基座。
5. 首次进 App：首页（车辆 tab）→ 列表里的「绑定与钥匙」→「① 扫描并连接」进到 ① 页，点「① 蓝牙就绪」会弹权限 → **必须选「使用应用期间允许 / 始终允许」**。
6. 每次下车库前：连电脑重新「运行到手机」推一次最新 JS（首页日志里的基座版本号就是给这一步核对用的）。
7. 坐进车里，带一张**实体 NFC 钥匙卡**（第 ③ 步要刷）。

### 现场操作顺序（照抄即可）

```
先做一件事：退出并【杀掉】官方 Tesla App 后台（含三星钱包里的特斯拉钥匙）。
       一辆车同时最多只接受约 3 个 BLE 连接，槽位被占满时配对会【静默失败】——
       不报错、不拒绝，就是你刷十次卡也没反应。

【只有第一次要下面这一整套】（入口：车辆 tab →「绑定与钥匙」→「① 扫描并连接」）
① 页  填 VIN（可留空）→ ① 蓝牙就绪 → ② 扫描并连接（手选）
       → 列表里点你车那一条（优先「命中VIN」，其次「0211 服务」，再按 dBm 挑最近的）
       → 读 0214 版本 → 查白名单        ← 不刷卡、不占槽，先确认 uni 收发通路（= ① 档 / ② 档）
       → 踩一脚刹车唤醒车机
       → （可选）先点「④ 探针确认」：如果直接回「已入白名单」，说明以前绑过，不用再刷卡
       → ③ 绑定（刷钥匙卡）— 页面可选钥匙类型，默认「Android 手机」
         发出后立刻把【实体钥匙卡】放在读卡区（不是手机！见 F11「必须用实体卡」）
           Model 3 / Y：中控台杯架后方（无线充电板靠后那块）
           Model S / X / Cybertruck：左侧无线充电板顶部，往下刷
         刷到车机屏幕出现「是否添加钥匙」→ 点确认
         屏幕一直不弹 = 卡没被读到（换一张车主钥匙卡，或换个贴卡位置重试）
         本步骤最多等 150 秒；期间 App 每 5 秒打一次 VCSEC 会话探针，
         车机不回「终态回执」也能靠探针判定成功（量产固件一般就不回，见 F11）
       → 不管 ③ 显示成功还是超时，都再点一次「④ 探针确认」拿最终结论
       → 最后点「查白名单」，确认列表里有本机 keyId 前 4 字节
         （车机上那行叫 "Unknown key"，认自己钥匙看 App 打出的 Tesla key id = XX:XX:XX:XX）
       → 到这一步「绑定档案」就写进 ① 页那一行了（F22），以后不用再走上面这些

【以后每次】  打开 App（或从后台切回前台）→ 启动自动重连循环（F22：每一轮先按档案里的 deviceId
             直连，连不上才扫一轮），日志出现「自动连接成功（…）」即可直接在「控制」tab 动车；
             人不在车边时它会按 3 → 6 → 12 → 24 → 30 秒退避一直试，走到车边那一轮自己就连上，
             不用杀后台重开；车休眠 / 走太远也一样，踩刹车唤醒后下一轮会自己补上。
             退到后台会暂停（Android 限制），回前台自动继续；不想让它连就点「断开连接」。
「控制」tab  先去「车辆」或「诊断」tab 点「车机 Ping」——它最轻、且能把 INFOTAINMENT 域的会话单独握出来
            （这一页没有 Ping 按钮，Ping 挂在车辆 / 诊断两页上）；
            Ping 通了再回「控制」tab 点上锁 / 解锁（首次会自动 V3 握手；解锁要走二次确认：倒计时 3 秒走完
            按钮才点亮，倒计时结束不会自动执行）→ 最后到「信息」tab 用 GetVehicleData 核对回执。
            前备箱 / 后备箱必须滑到底才发，松手回弹 = 没发；充电盖板那两条路径（A/B 对照）是普通按钮，不用滑。
② 测试页    连续压测：上锁→解锁 各 3 次（= 老流程，仍在这一页，它不在底部导航里，从 ① 页按钮进）
            车机域两格：Ping → 车辆信息（GetVehicleData 六类各发一条再合并）。这一页是**裸参数版**，
            不滑动、不二次确认，用来在「控制」tab 出问题时区分「协议错」还是「UI 交互错」。
```

> 序号有两套，别混：**页面**叫 ① 扫描·连接·绑定 / ② 动作测试 / ③ 报文控制台 / ④ 车控，这四页都不在底部导航里
> （底部五个 tab 用中文名：车辆 / 控制 / 温度 / 信息 / 诊断，见 F23）；而 ① 页里那四个按钮
> 上的 ①②③④ 是**步骤号**（蓝牙就绪 / 扫描连接 / 绑定 / 探针），跟页面号无关。上面「④ 探针确认」指的是按钮。

**底部各 tab 与 ② 测试页共用一条 BLE 连接，但两个域各有独立会话**：「控制」tab 与 ② 测试页的动作都走同一连接、同一个 `dispatcher`，
而 VCSEC 与 INFOTAINMENT 的 counter 是分键存储、各增各的（见 F21）。第三轮真机已经把车机域那一半跑通（握手 `SESSION_INFO_STATUS_OK(0)` + 六类数据全部解密成功），
所以现在再出现「上锁能通、车机命令不通」，只能说明**那一域的会话没握上或已过期**，不是字节写错 —— 到测试页点 Ping 复现即可。

**③ 的超时文案不是判决书**：等到点仍没结果时返回 `wait:true` + 四项排查（车机有没有弹配对页 / 实体卡刷卡位置与屏幕确认 / BLE 连接数被官方 App 占满 / 车辆休眠要先踩刹车）。**`wait:true` 不等于协议错**，按上面四项逐项排掉再重刷；判协议对错要看 ④ 探针和「查白名单」。

**绑定没落库时哪一页都必然失败**：握手会被车辆以 `SESSION_INFO_STATUS_KEY_NOT_ON_WHITELIST(1)` 拒绝，日志会直接说是这个原因、并且不白跑重试。看到这条就回 ① 页重刷，别在「控制」tab / ② 测试页连点。

**VIN 不是必须的**：只有走「按 VIN 自动连」才需要它。车辆的蓝牙名在车机或手机系统里被改过（例：`Tesla Model Y 小米YU7`）时，按 VIN 算出来的广播名一定匹配不上 —— 直接用 ② 的手选列表，见 F5.1。

**「读 0214 / 查白名单」放在绑定前是刻意的**：它俩都是无签名请求，能一次回答 Q1（indicate 到底开没开）和 Q2（MTU 够不够），而**不需要消耗车辆白名单槽位、不需要刷卡**。这两步不通，就别刷卡，直接按 §9 走替代方案。

绑定成功后 App 会自动生成一对 P-256 密钥并保存；重开 App 不用重新生成，但**车辆白名单只加一次**，重启 App 后直接在「控制」tab 点动作，缺会话会自动握手。

**重开 App 也不用重新扫描手选，更不用在车边反复重启**：③ 绑定 / ④ 探针一过，`markBound()` 会把 keyId 连同车辆蓝牙地址写进「绑定档案」（`tesla_probe_bind_v1`，见 F22），`App.vue:onShow` 会启动**自动重连循环** —— 人离车几十米提前打开 App 也没关系，前台期间它按 3 → 6 → 12 → 24 → 30 秒退避一直试，走到车边那一轮自己就连上了；连上之后停手，链路真断了（车休眠、走出范围）会自动归零重连。① 页那一行 `绑定档案：…` 和凡把 `statusText()` 打进状态条的那几页（「车辆」tab、绑定页、② 测试页、④ 车控页）末尾的 `自动重连：…` 就是这件事的可见证据。不想让 App 自动连车，点「断开连接」（同时取消已排期的重试，要恢复点「恢复自动重连」）或「清除绑定档案」（彻底忘掉这台车）；这两个按钮 ① 页和绑定页都有，「车辆」tab 上对应的是「停止重连」。退到后台会自己暂停（Android 限制），回前台继续。

---

## 6. 已验证范围（不需要真机就能确认的部分）

```powershell
cd f:\Desktop\test\tesla-ble-probe
node tests\run.mjs        # 结果: 503 passed, 0 failed
node tests\vue-check.mjs  # 页面脚本自检: 全部通过 (17 个)
```

> PowerShell 控制台默认 GBK，跑中文断言输出前先 `$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8`。

`tests/run.mjs` 用 Node 原生 `crypto` 做金标准对拍，已确认：

| 层 | 模块 → 函数 | 已证 |
| --- | --- | --- |
| SHA-1 | `sha1.js:sha1` | 与 `createHash('sha1')` 逐字节一致 |
| SHA-256 / HMAC-SHA256 | `sha256.js:sha256 / hmacSha256` | 与 `createHash('sha256')` / `createHmac('sha256')` 逐字节一致（含 >64 字节密钥的块填充、分组边界长度） |
| AES-128 | `aes.js:expandKey / aes128EncryptBlock` | 与 FIPS-197 官方向量一致 |
| AES-128-GCM（4 字节 nonce） | `aes.js:aes128GcmEncrypt / aes128GcmDecrypt` | 与 `createCipheriv('aes-128-gcm')` 密文+tag 双向一致，并能解密 Node 的产物 |
| AES-128-GCM（12 字节 nonce + AAD） | 同上，V3 路径 | 与官方向量（`protocol.md` 的 `nonce`/`AAD`/`ciphertext`/`tag` 四元组）逐字节一致 |
| P-256 标量乘 / ECDH | `p256.js:publicKeyFromPrivate / deriveSharedSecret / isOnCurve` | 与 `createECDH('prime256v1')` 生成的 G、公钥、共享点全部一致 |
| 随机源 | `aes.js:randomBytes` | **没有金标准可对拍**：App 逻辑层无 WebCrypto，实现是模块级持久 xoshiro128** 状态机（种子 = 4 次 `Math.random` + `Date.now` + `performance.now` 噪声，预热 32 轮）。自测里只把它当测试输入生成器，未对随机性本身做统计断言，**不是 CSPRNG**，风险见 §8.6 |
| protobuf | `src/protocol/pb.js:encode / decode / inspect` + `src/protocol/v3/spec.js:oo()` | 字段号→tag、varint、packed repeated、fixed32（小端）均与参考实现一致。**两条 presence 规则分开锁死**：普通 singular 标量等于默认值（0/空/false）按 proto3 省略；**oneof 成员一律「显式存在」，值为 0 / 空 bytes / 空 message 也必须写 tag**（`src/protocol/v3/spec.js` 用 `oo(组名, 字段)` 打标，`src/protocol/pb.js` 据此跳过省略，并校验同一组最多只给一个成员，冲突直接抛错）。金标准：`UNLOCK` 内层 `10 00`、`LOCK` 内层 `10 01`、前备箱 `OPEN` 内层 `22 02 30 03`、`GET_STATUS` 内层 `0a 00`（与官方 `vcsec.go:110-121 getVCSECInfo` 一致）、`Destination{domain=0}` = `08 00`、`KeyIdentity{handle=0}` = `18 00` |
| car_server 金标准 | `src/protocol/v3/spec.js` + `src/protocol/pb.js:数值类型` + `tests/run.mjs [8b]` | **INFOTAINMENT 域协议表（24 条）**：整条 `Action` 逐字节对拍 —— 盖板开 `1203f20300` / 关 `1203ea0300`、`Ping{ping_id=1}` = `1205f202020801`（`Ping` 不是空 message，内层还有 `08 01`）、`GetVehicleData{closures,charge}` = `12060a0412004200`（空 message 也写 tag+len=0，与三个参考实现一致）；`vehicle_action_msg` 互斥照样抛错。**数值类型补齐**（这是 `[8b]` 的另一半动机）：float/double 小端 fixed32/64、sint32 zigzag（`scheduled_charging_start_time_app=-120` 可还原）、**proto3 负 int32 会符号扩展成 10 字节 varint**（`DriveState.power=-5`，补 `src/protocol/pb.js` 之前一遇负值整帧解不出来）、u64 秒级时间戳、伪枚举（`ShiftState.P` / `ChargingState.Charging`）。**降级而非抛错**：wire type 与声明不符 → `f<n>`；未登记字段 → `f<n>`（车辆固件多回字段是常态，不能因此丢整帧）。`Response` 侧锁死 `actionStatus.result=ERROR(1)` + `result_reason.plain_text`，并断言 **`CSOperationStatus_E` 里根本没有 `WAIT`** |
| 绑定帧 | `src/protocol/v3/codec.js:buildAddKeyPayload / buildAddKeyEnvelope` | 内层 `WhitelistOperation{addKey…{key, keyRole}}` + 外层裸 `ToVCSECMessage{signedMessage{signatureType=PRESENT_KEY}}`，首字节 `0x0a`、`PermissionChange` 里**没有** `permission` 数组，与 `security.go:338` 逐字段对齐 |
| V3 帧（官方向量） | `src/protocol/v3/handshake.js:sharedKeyOf / subkey / sessionInfoHmac / applySessionInfo` + `src/protocol/v3/metadata.js:Metadata` + `src/protocol/v3/aead.js:encryptCommand / decryptResponse` | 与 `pkg/protocol/protocol.md` 的样例逐字节对拍：`K = SHA1(ECDH)[:16]`、`SESSION_INFO_KEY = HMAC(K,"session info")`、握手元数据 TLV、握手 HMAC tag、`AAD = SHA256(TLV‖0xFF)`、加密指令密文与 tag、响应解密与 `request_hash` 校验；另含 `counter` 上/下取 max、`epoch` 轮转归零、`0xFFFFFFFF` 哨兵被拒。**响应 AAD 不对称回归锁（20 条）**：车辆侧**不经**我方 `responseMetadata`，照官方 `peer.go:105-117` 手工拼 TLV 再加密（各算各的才叫验证）—— 覆盖 `responseDomainByte` 三档（无 `from_destination` = 0 / 只有 `routing_address` = 0 / 带 `domain` 取原值）、**A** 车辆不带 `from_destination` 时即使我方请求发向 INFOTAINMENT 也解得开（真机 VCSEC 响应就是死在「domain 回退成请求域」）、**B** 带 `from_destination` 时以响应自己的域为准、**C–F** 解不开时**逐字段试算点名根因**（domain 用请求的域 / 更早那次请求的 `request_hash` / 另一个域的会话密钥 / 单字段全试完 → 密文被截断或会话密钥不对），并且断言诊断文案与 detail 里**一个密钥字节都不出现**（安全红线） |
| 绑定状态机 | `src/domain/enrollment-service.js:bindKey / probeSession` + `tests/run.mjs [14]` | **离线假车机回归（26 条）**：桩 BLE 替换 `probe.ble`，按包形分辨「握手 = `RoutableMessage{session_info_request}`」与「加白名单 = 裸 `ToVCSECMessage{signedMessage}`」，握手回包现场算 `sessionInfoHmac`。锁死：预探针已命中则**一条 add-key 都不发** / 一轮只发一次 add-key（收到 `OPERATIONSTATUS_WAIT` **绝不重发**）/ 终态回执与会话探针**并行、谁先来算谁** / 探针命中与窗口耗尽两条路径 / 超时返回固定四项排查 / `formFactor` 真的落在 `WhitelistOperation.metadataForKey.keyFormFactor`（页面选的值与默认 `ANDROID_DEVICE` 各证一次）/ `key.PublicKeyRaw` 与 `keyRole=DRIVER` 逐字节正确 / BLE 写失败**立即返回不等窗口**且文案含连接数上限 / 未连接直接抛「还没连上车辆」。时间片（`windowMs` 等）可注入是为了秒级跑完两条路径，**默认值与协议字节零改动** |
| 车机域端到端 | `src/services/infotainment/charge-port.js:chargePortDoor` + `vehicle-data.js:vehicleData` + `ping.js:pingInfotainment` + `src/services/vcsec/drive.js:requestDrive` + `src/store/v3-session-store.js` per-domain 会话 + `tests/run.mjs [15]` | **假车机回归（93 条）**，与 `[14]` 的区别是这辆假车机**真的按请求元数据重算 AAD 把加密命令解开**，再回一帧加密 `car_server.Response`。锁死：① 车机动作用的是 **INFOTAINMENT 那份会话**（车辆两域自报 counter 故意给成 11 / 5，验完 VCSEC 那份「一步没动」，且两域用的是**两个不同 epoch**）② 走完整个加密链路后**上线明文仍与 `[8b]` 金标准一字不差**（`1203f20300` / `1205f202020801`）③ `actionStatus=ERROR` 判失败且 `result_reason.plain_text` 出现在文案里（官方 `infotainment.go:37-43` 的 `car could not execute command: <text>`），**并且绝不把 ERROR 当 WAIT 重发**（`cmds.length===1`）④ `GetVehicleData` **每类一条独立请求再合并**：只问点过的类别、不传 = 6 类各发一条（`cmds.length` 等于类别数，与官方 `state.go:70-82` 一次一个 `StateCategory` 一致）、未知类别**在发包前就抛错**、合并后的 `summary.data` 同时含多类字段 ⑤ `Ping` 载荷 `ping_id=1` ⑥ `summary.kind==='vehicleData'` 且 `summary.data` 是 snake_case 结构（「信息」tab、「控制」tab 与 ④ 车控页都靠它渲染）⑦ `statusText()` 两域各报一份 counter ⑧ **收帧容错（真机 `GetVehicleData` 报「响应没有 payload」的回归锁）**：假车机可以先回一帧**只有 `signature_data`、没有 payload** 的受理帧 —— 断言它不再被判解密失败、真正的 `vehicleData` 帧照样被收下、且**命令只发了一次**；再演一版 tag 被改坏的帧 —— 断言它只被丢弃并留一条日志、请求不中止；最后一版**每帧都坏** —— 断言判超时（不是当场成功）且文案里带 `已丢弃帧：…` ⑨ **重发上线的是同一份已编码字节**（官方 `dispatcher.go:434-460` 只 `Marshal` 一次、传输重试复用那串字节）：假车机吞掉第一次的回包、只把「上一次请求」的迟到回包推回来 —— 断言 `cmds.length===2` 且 `wire[0]===wire[1]`（counter / nonce / tag / `request_hash` 一字不差）、迟到回包照样解得开、日志里不再出现 `GCM tag 不符` ⑩ **响应归属三条闸门**（`dispatcher.go:252-293` 的 `{domain, address, uuid}`，全部在解密之前判）：挂在别人 `routing_address` 上的帧、`request_uuid` 非空却不是本次请求的帧、`from_destination` 是别的域的帧（真机表现 = VCSEC 的周期广播帧被当成 `GetVehicleData` 的响应，桩里就回一帧 `to=BROADCAST / from=VCSEC / actionStatus=OK`）—— 各断言它**根本没进 GCM**（日志无 `GCM tag 不符`、无 `响应解密诊断`）、真正的数据帧仍被收下、命令只发一次；只剩广播帧没有真响应时判超时，且文案点名「已丢弃 1 帧 / 来自 `DOMAIN_VEHICLE_SECURITY`」 ⑪ **协议层错误帧终态（真机 `fault=25 RESPONSE_MTU_EXCEEDED` 的回归锁）**：车辆回 `signedMessageStatus{ERROR, fault=25}` + 零字节密文 —— 断言**不再等到超时**、结论用的是车辆自己写的 fault 名、该类**不重发**（`cmds.length===1`）、文案带「命令可能已经执行」与「每类一条 / MTU」两条人话指引；两类里只有一类被拒时**另一类照样合并成功**（`summary.data.charge_state` 在、`closures_state` 缺、文案 `1 类带回数据 / 1 类被拒`） ⑫ **「带回数据」按类别计数**（真机口径回归锁：假车机在问 `drive` 的那一帧里顺带回一帧 `location_state`）—— 断言文案是 `GetVehicleData：2 类各发一条，2 类带回数据`（不是按合并后的字段数谎报成 3 类）、顺带带回的字段**照样合并**进 `summary.data`、两类仍是两条命令 ⑬ **驾驶授权（F24 `REMOTE_DRIVE`，三辆假车共 9 条）**：假车机只收到**一次 VCSEC 域握手**（不顺手碰车机域）、解出来的明文 = `1014`（`RKE_ACTION_REMOTE_DRIVE=20` 的 oneof 显式编码）、车辆没回 `commandStatus` 才算这条命令走完；回 `GENERICERROR_NOT_ALLOWED_OVER_TRANSPORT(7)` 时判**失败**且文案里同时出现枚举原文与 `Fleet` / `remote_start_drive` 这句下一步（**绝不替车辆模拟「启动成功」**）、被 `ERROR` 拒时**不按 WAIT 重发**（`cmds.length===1`）、台账里那一行存的就是车辆回执原文，并额外留一条 `车辆没接受驾驶授权` 的人话 `warn`；回 `GENERICERROR_VEHICLE_NOT_IN_PARK(5)` 时同样带出处置口径（`P 挡`） ⑭ **VCSEC 的重发必须「重新签一份」（真机那句「授权启动后锁车要点两次」的回归锁，6 条）**：车辆回一次 `OPERATIONSTATUS_WAIT` 再回终态 —— 断言确实发了两条命令、两条的 `counter` 依次 `BASE+1 → BASE+2`（**不是原样重发旧帧**）、两份帧的**上线整帧字节不同**（新 nonce + 新 tag + 新路由地址）、重发**不必重新握手**（`handshakes === ['VCSEC']`）、第二次拿到终态就判成功、日志按域写明这次是「`counter 必须前进`」那一种 —— 与 ⑨ 那组**方向相反**，两域的分岔是有意的 ⑮ **解锁串发驾驶授权（F25 `unlockAndDrive`，三辆假车共 9 条）**：一条命令都还没发之前先确认串发是**两条 VCSEC 命令、明文依次 `1000` / `1014`、共用同一次握手**；整体成功以两条各自拿到终态为准，回执文本把两条结论分开（`UNLOCK` / `REMOTE_DRIVE` / `驾驶授权：`），`lastResult` 三条台账键各自命中互不覆盖；车辆只拒授权（`VEHICLE_NOT_IN_PARK`）时**已成功的解锁不被说成失败**（`r.ok===true && r.unlock.ok===true && r.drive.ok===false`）且拒绝原因原样留在回执里；车辆拒解锁（`CLOSURES_OPEN`）时**绝不补发授权**（`cmds.length===1`）并按车辆结论判失败、文案带「没关严」这类车端策略的下一步 |
| V3 单一入口 | `src/services/vehicle-api.js` 转发 + `src/services/index.js` 门面 + `src/store/v3-session-store.js` V3 会话 | `api.version()==='v3'`、`toolkit().root==='RoutableMessage'`（同时保留 `ToVCSECMessage` 供绑定帧解析）、枚举转发（`rkeEnum/closureEnum/label`）与页面用的是同一张表；**会话按域分两份存**（`DOMAIN_VEHICLE_SECURITY` → `tesla_probe_v3_session_v1`，`DOMAIN_INFOTAINMENT` → `tesla_probe_v3_infotainment_v1`），每份的 counter **只增不减** |
| 日志分段 | `src/infra/logging/action-tracer.js:beginAction / endAction / action` + `src/infra/logging/log-bus.js:clearLogs` | 段首 `-----start----- 动作名`、段尾 `-----end----- 动作名 \| 结论`；嵌套只打最外层一对；`text` 折成一行；抛异常照样收尾；`clearLogs()` 重置嵌套计数，不留孤儿 `end`；未连接时动作抛错但分段完整 |
| 广播手选 | `src/infra/ble/device-matcher.js:makeMatcher / sortAdv` | 四级匹配各档命中、改过名（`Tesla Model Y 小米YU7`）确实不命中、空名/无期望名不报错；排序按「命中VIN → 0211 → 有名字 → 无名」且同级按 RSSI，且不修改入参数组 |
| 提示弹窗 | `src/infra/platform/notify.js:notify / copyText / preview` | 正文超 500 字只留头部并提示「点复制取全文」，**剪贴板里永远是未截断全文**；无 `uni` 环境（Node 自检）降级为原样返回 / 回调 `false`，绝不抛错；另有一条**全仓静态守卫**扫描所有 `.vue/.js`，出现 `uni.showToast(` 或 `toast(x.slice(` 即 FAIL |
| 长度前缀与收帧重组 | `src/infra/ble/frame-codec.js:prependLength / stripLength / FrameReassembler` + `src/infra/ble/ble-transport.js:onChunk / send / writeChunked` | **传输层回归锁（40 条）**：读写口径逐条对齐官方 `pkg/connector/ble/ble.go` —— ① 2 字节大端前缀 + 粘包/半包重组 ② 分包之间静默超过 `rxTimeout(1s)` 就丢掉上一帧残字节（`RX_IDLE_MS`，带 warn 日志）③ 声明长度 > `maxBLEMessageSize(1024)` 判定为错位前缀，**整块丢缓冲重新对齐**（`MAX_FRAME`，带 error 日志；不丢会永远卡在「等待后续分包」，把之后每一条正常响应都吃掉）④ **`send()` 绝不清空正在拼的半截帧** —— 旧实现每次发送都把 `FrameReassembler` 的缓冲整个清零，而 `GetVehicleData` 的响应要拆成十几包慢慢推，中途赶上一次重发就被拦腰截断，送进 GCM 的是截断密文（现场文案正是「响应 GCM tag 不符」+「等待终态超时」）；只有 `rejectAll`（写失败 / 断连）才重对齐 ⑤ 写分包 `max(20, min(mtu, 1024) - 3)` ↔ 官方 `ble.go:354` 的 `min(txMtu,1024) - 3`，`mtu` **一律取回读到的实际协商值**（谈不成才退到 `DefaultMTU-3`）⑥ **先订阅再谈 MTU**（`discoverServices → subscribe → negotiateMtu`，官方 `ble.go:345` 订阅、`:349` 才 `ExchangeMTU`）并注册 `uni.onBLEMTUChange` 回读真实值 —— 顺序反了的话车辆按新 MTU 发、我方还在按旧值切，多包响应必然被截断（现场文案就是「已丢弃 N 帧」+「响应 GCM tag 不符」+「等待终态超时」） |
| 自动重连循环 | `src/domain/auto-reconnect.js:startAutoReconnectLoop / runLoopOnce / armRetry / stopAutoReconnectLoop / describeAutoLoop` + `tests/run.mjs [16]` | **前台持续重试回归（27 条）**：不碰真蓝牙 —— 桩 `openBluetoothAdapter` 让它按 `adapterMode` 返回 fail（走退避）或挂住不返回（走在飞），再把 `setTimeout/clearTimeout` 劫持成可手动触发的队列（**只吞 ≥1000ms 的长延时**，`delay(600)` 这类短延时原样放行，否则内部窗口永远等不完）。锁死：① 没密钥 / 没档案时循环**直接不启动也不排期**（`skipped:nokey`）② 一次失败就排上 3 秒、状态行同步显示 `3 秒后重试（已试 1 次）`、日志带「不必重开 App」这句用户指引 ③ 连续失败严格按 `3 → 6 → 12 → 24 → 30 → 30` 升档并**封顶**（已试 7 次仍是 30 秒，不会指数爆掉）④ **单飞**：一轮在飞时重复 `start` 复用同一个 Promise、`autoReconnect()` 也还在飞、释放后只排**一个** 3 秒（不会叠出两轮扫描），且状态行不会倒退成「第 0 次尝试」⑤ **断线再武装**：`setState('disconnected')` 会清掉旧的 6 秒排期、立刻归零重排 3 秒（人还在车边要的是马上连回）⑥ **主动断开 = 让位**：`suspendAutoConnect(true)` 清空全部排期、状态行变成「已暂停」并提示点「恢复自动重连」，暂停期间 `start` 返回 `suspended` 且不再排期 ⑦ 已连上时 `skipped:already` 且不排重试、状态行说明「断线会自动重连」，`statusText()` 末尾确实带上这段 ⑧ `stopAutoReconnectLoop()` 与 `forgetBind()` 都会取消排期，并且**留一条日志**（不是静默行为） |
| 车辆状态仓库 / 诊断台账 | `src/store/vehicle-store.js:vehicleView / applyVehicleData / subscribeVehicle` + `src/store/diagnostic-store.js:recordResult / recordError / recentResults / lastResult`（登记点在 `src/services/vehicle-api.js` 的 `tracked()`）+ `tests/run.mjs [17]` | **UI 视图模型回归（42 条）**：仓库只有第三态 `UNKNOWN`（页面上显示「未知」），**它绝不兜底成任何一个具体值** —— 空仓库 `hasData=false`，电量/续航/锁状态是「未知」而不是「未上锁」，四门与俯视图逐门也都是「未知」而不是「全关 / 四个关着的点」，位置与胎压同样没有；没有数据时写入不报错也不更新时间戳。写入侧逐字段锁死读法：类别按 `*_state` 计数（车辆自己回的那两个 `f999` 不算类别）、电量取 `battery_level`、续航英里换公里、里程按百分之一英里、**`0` 是值不是缺失**（车速 0 mph = 「停着」、`locked=false` = 「未上锁」、四门全关 = 0 个开着）、伪枚举取 `type` 字符串、温度保留一位小数、盖板状态与挡位等无关字段各归各位、来源可追溯。**部分回包 = 整体替换**：没回到的类别一律回到「未知」（电量回到未知、`drive` 没回时车速也是未知、逐门不沿用上一轮的 `false`），类别计数只剩真正回过的 —— 这两组断言就是「宁可说不知道，也不给用户一个看起来像真值的默认值」这条规则的回归锁。台账侧：按时间倒序给页面、**文本不截断**、只有**同名同 tag** 才互相命中（充电盖板的车机域与 VCSEC 两条路径不能串台）、ok/fail 分开累计、记录上限由 `src/services/index.js` 门面透出（页面不必直连 store）、条数封顶后淘汰的是最旧那几条、`total` 继续累加不跟着裁剪、`okCount / failCount` 统计**全部历史**而不是窗口、被淘汰那条从 `lastResult` 里再也命中不到、`recentResults(20)` 新在前、不传 limit 给满窗口 |
| 路由与界面字面量 | `tests/run.mjs [18]`（直接读 `pages.json` 与 `.vue` 源文件做静态扫描，不等 HBuilderX 编译） | **防死链 / 防字符串漂移（18 条）**：首页排第一（切 tab 用 `reLaunch`，栈里只留它）、在册页面数与 `pages/` 目录数一致、每一册都有对应 `.vue` 文件、界面里跳的每一页都已注册、在册的每一页都至少有一个入口（注册了却进不去的孤儿页只有真机点遍界面才发现，离线看 `pages.json` 完全正常）、新补的诊断页与绑定页真的被引用到（在册却进不去等于还是死链）、底部标签栏恰好五项、每一项的 `url` 已注册且图标名在 `src/ui/icons.js` 的 `ICONS` 里、五个 tab 页都挂了自己的 `<tf-tabbar active="…">` 且 `active` 与页名对得上、绑定页不是 tab 所以不该出现标签栏（进出只有一条返回路径）、控制页与诊断页做盖板 A/B 对照用的台账键**逐字一致**（两页各写各的字符串，一旦漂移诊断页就查不到控制页留下的记录）—— 页面改名、`pages.json` 漏登记、图标名拼错这类问题以前只有编译期才暴露，现在离线一条 FAIL 就点出来。**驾驶授权与串发编排（F24 / F25）另有七条同名口径的静态扫描**：控制页 `DRIVE_LEDGER` 的 `name + tag` 与 `vehicle-api` 里 `tracked(...)` 的登记名**逐字一致**（差一个字界面就永远停在「还没试过」）、解锁的确认回调走 `unlockAndDrive()` 且**全页只有一处调用**（编排只有一个入口，不许页面自己拼第二条）、`vehicle-api` 里用正则锁死**先判 `u.ok` 再 `await remoteDrive()`**（串发只以解锁终态成功为前提）、页面不再自己拼 `RKE_ACTION_UNLOCK`（避免同一件事两处口径各自演化）、单独重试那颗按钮对应的 `remoteDrive()` 在整页只出现一次、`src/services/vcsec/rke.js` 里**不出现** `REMOTE_DRIVE`（协议层与 `services/vcsec/` 永远没把两条命令缝起来）、按钮与说明文案里不出现「已启动 / 启动成功」这类**替车辆下结论**的字样且必须保留「车辆回执通过」这种转述口径 |
| 页面脚本 | `tests/vue-check.mjs` | **17 个 `.vue` 全部真 import 通过**：10 个页面（`home` / `control` / `climate` / `info` / `diagnostics` / `binding` / `index` / `rke` / `debug` / `car-control`）+ 6 个组件（`car-icon` / `confirm-dialog` / `log-box` / `slide-confirm` / `tf-icon` / `tf-tabbar`）+ `App.vue`。校验方式是把 `<script>` 抽出来、把 `@/` 重写成相对路径后交给 Node 解析，所以「组件 props 拼错 / 方法名不存在 / import 路径写错」这类问题在离线阶段就会暴露 |
| 交互组件 | `components/{car-icon,confirm-dialog,log-box,slide-confirm,tf-icon,tf-tabbar}` | **零静态资源**：图标不引 png、不引字体图标（避免打包漏资源），**这也是底部导航不用原生 `tabBar` 的直接原因 —— 它强制要图片资源**。`tf-icon` / `tf-tabbar` 吃 `src/ui/icons.js` 里的内联 SVG，编成 `data:image/svg+xml` 交给 `<image>`；`[18]` 只锁标签栏那五个图标名（页面里 `<tf-icon name="…">` 拼错不会被离线抓到：`iconSvg` 对未知名字返回空串，表现是空白图标而不是报错）。旧页（② 测试页、④ 车控页）仍是 `car-icon` 那套 CSS 边框/圆点画的图标，两代并存。组件在导入期不碰 `uni.*`，会执行的调用都在 `typeof` 守卫里 —— `createSelectorQuery`（量轨道宽度）拿不到就退化成「按经验宽度算」，`vibrateShort` 不存在就静默跳过，因此组件在 Node 自检环境下也不会崩。**滑动确认松手回弹 = 不触发**，只有滑到底才 `$emit('confirm')`；**倒计时弹窗**走完才点亮确认按钮，倒计时结束本身**不执行**动作 |

**未验证 = 必须上真机**：车辆固件是否接受这些字节（RKE / 前备箱 / 车辆信息 / **充电盖板**都已拿到「接受」的答案 —— 盖板是真开真关，**这是车机域第一次「执行动作」成功；解锁同样已经拿到「接受」**；**第四轮真机把驾驶授权（`REMOTE_DRIVE`，F24）也验通了** —— BLE 发这条**这台车接受**，判据不是日志字样而是「按完踩刹车能挂上 D/R」，所以它现在随解锁自动串发（F25），`GENERICERROR_NOT_ALLOWED_OVER_TRANSPORT(7)` 没有出现在这一轮回执里；**只剩 Ping 未上车**（它与盖板共用同一条 `sendCarAction` 和同一个域会话，风险极低）。同一轮带回的那句「授权启动后锁车好像要点两次」经查**是自家缺陷不是车端策略**（VCSEC 重发复用了同一份字节、counter 没前进），已修并有回归锁（F18 / F25），下一轮上真机要复核的判据很具体：**锁车按一次就锁上**；若仍出现「按两次」，先看回执里的 `GenericError` 是哪一码（手机钥匙留车内 / 门没关严是车辆故意拒绝，见 §7.5））。BLE 侧那几项也在第三轮有了实测值：**`0213` 的通知通道可用**（一次动作 6 条请求的 6 帧响应全部到达）、**MTU 从分包反推 ≈247**（`已有 244 / 需要 380` 之后 `响应 378 字节` = 380 减去 2 字节长度前缀的整帧，即每包净荷正好 `247-3`；climate 同理 `244/266` → `264 字节`；本轮日志没有 `MTU 协商 =` 那行，所以是反推，见 §11 第 9 条 ①）、**187 字节的请求单帧写完**（209~232 字节的四类响应不需重组）。**INFOTAINMENT 域的会话密钥第一次拿到正面证据**：该域连续 6 帧 GCM 解密成功、counter 12→17 有序（前两轮一直卡在「解不开 / 装不进一包」，见 §11 第 8 条 ①）。仍要问评审的是车辆回包里的两个怪现象 —— **字段 999** 与「问 `drive` 顺带带回 `location_state`」是否官方预期（F21；本项目按「未登记字段 → `f<n>`」原样显示，不给它编名字）。官方 Go 实现是服务端证书，走的是另一条 TLS 路径；我们这里是 BLE + 白名单钥匙。

---

## 7. 判读表（真机日志对着这五张表看）

### 7.1 `OperationStatus_E` —— 车辆对某条操作的整体态度

| 值 | 名称 | 含义 / 怎么办 |
| --- | --- | --- |
| 0 | `OPERATIONSTATUS_OK` | 成功。`operationStatus` 是 `CommandStatus` 里**oneof 之外**的普通枚举，0 值按 proto3 会被省略，所以「成功」的响应里这个字段常常不出现——官方 `vcsec.go:174-179` 正是拿「响应里没有 `commandStatus`」当 done 判据（空消息 = 成功） |
| 1 | `OPERATIONSTATUS_WAIT` | 让你去刷钥匙卡。绑定流程第 ③ 步收到它是**正常中间态**；但**查询/解锁**这类不需要刷卡的操作一直回 WAIT 就不是中间态了——本次 `UNLOCK` 的成因是编码把载荷省成了 0 字节（见 F13 / §10） |
| 2 | `OPERATIONSTATUS_ERROR` | 失败。必须再看下一层的 `information` 枚举才知道原因 |

### 7.2 `SignedMessage_information_E` —— 加密指令（上锁/解锁）被拒的原因

| 值 | 名称 | 判读 |
| --- | --- | --- |
| 0 | `INFORMATION_NONE` | 接受，车动了 |
| 1 | `FAULT_UNKNOWN` | 通用失败，先怀疑报文结构 |
| 2 | `FAULT_NOT_ON_WHITELIST` | **没绑定 / 绑定的是另一把密钥** → 回 ① 页重新绑定 |
| 3 | `FAULT_IV_SMALLER_THAN_EXPECTED` | **counter 回退了** → 见 §8.1，只能删钥匙重新绑定，**禁止重试** |
| 4 | `FAULT_INVALID_TOKEN` | 车辆不认识这把身份（V3 用公钥本身，不再带 4 字节 keyId）→ 重新绑定 |
| 5 | `FAULT_TOKEN_AND_COUNTER_INVALID` | token+counter 双错，等价于密钥/计数器状态已废 → 重新绑定 |
| 6 | `FAULT_AES_DECRYPT_AUTH` | **GCM tag 校验失败** → 会话密钥算错、元数据顺序或 VIN 大小写不对；也可能是车辆已轮换会话 → 点「重新握手」重来 |
| 7 | `FAULT_ECDSA_INPUT` | 走了签名路径才会出现，本项目用 GCM 不产生 ECDSA |
| 8 | `FAULT_ECDSA_SIGNATURE` | 同上 |
| 9 | `FAULT_LOCAL_ENTITY_START` | 车辆内部模块启动失败（车端问题） |
| 10 | `FAULT_LOCAL_ENTITY_RESULT` | 车辆执行了但返回失败（如门锁机构故障）→ 换动作再试一次确认 |
| 11 | `FAULT_COULD_NOT_RETRIEVE_KEY` | 车辆取不到白名单公钥 → 重新绑定 |
| 12 | `FAULT_COULD_NOT_RETRIEVE_TOKEN` | 车辆取不到 token → 重新握手 |
| 13 | `FAULT_SIGNATURE_TOO_SHORT` | **`signature` 字段短于 16 字节** → GCM tag 被截断，通常是 MTU 太小（**Q2/Q3**） |
| 14 | `FAULT_TOKEN_IS_INCORRECT_LENGTH` | token 长度不对（旧式 4 字节 keyId 路径，V3 一般不命中） |

### 7.3 `WhitelistOperation_information_E` —— 绑定被拒的原因

日志里会打成 `车辆回执：<枚举名>(N)` 加一句中文处置建议（映射表在 `src/domain/response-hints.js:PAIR_HINTS`）。配对场景真会遇到的码：

| 值 | 名称 | 判读 |
| --- | --- | --- |
| 0 | `NONE` | 已写入白名单 → 回 ① 页点「查白名单」确认 keyId 在内 |
| 1 | `UNDOCUMENTED_ERROR` | 车端未知错误，重试一次 |
| 3 | `KEYFOB_SLOTS_FULL` | **钥匙卡槽位满了** → 车机设置里删一把不用的实体钥匙 |
| 4 | `WHITELIST_FULL` | 白名单满（含 NFC 卡）→ 同上 |
| 5 | `NO_PERMISSION_TO_ADD` | 当前刷的这把钥匙没有加钥匙的权限 → **换车主钥匙**刷 |
| 6 | `INVALID_PUBLIC_KEY` | **公钥格式不对** → 必须是 65 字节未压缩点 `04 ‖ X ‖ Y` |
| 12 | `KEY_NOT_ON_WHITELIST` | 用来签署这条请求的钥匙本身不在白名单里 |
| 13 | `KEY_ALREADY_ON_WHITELIST` | **本机公钥已经在里面了** → 不用再刷，直接去 ② 页开锁 |
| 14 | `NOT_ALLOWED_TO_ADD_UNLESS_ON_READER` | **最常见**：车辆要先检测到卡在读卡区 → 先把**实体钥匙卡**贴住（Model 3/Y 是中控台杯架后方，Model S/X/Cybertruck 是左侧无线充电板顶部往下刷）再重按「③ 绑定」 |
| 23 | `COULD_NOT_START_LOCAL_AUTH` | 车机没起本地授权流程 → 重新踩一脚刹车唤醒车机再试 |
| 24 | `USER_REJECTED` | 车机屏幕上点了「拒绝」 |
| 25 | `TIMED_OUT_WAITING_FOR_KEY` | 等刷卡超时：卡没贴 / 位置不对 / 贴太晚 |
| 26 | `TIMED_OUT_WAITING_FOR_USER_CONFIRMATION` | **刷了卡但没在车机屏幕上点确认** |
| 27 | `VALET_MODE_ACTIVE` | 车辆处于代客模式，不允许加钥匙 |
| 28 | `USER_CANCELED` | 车机屏幕上取消了配对 |

> 本项目绑定时发的是 `keyRole = ROLE_DRIVER(3)`、`formFactor = KEY_FORM_FACTOR_ANDROID_DEVICE(7)`，**不带 `permission` 数组**（现行 proto 已删），所以 2/7/8/9/10/11 这些「权限变更类」错误码理论上不会命中。
>
> **注意 `label()` 的一个坑**：这个枚举的**成员名自带 `WHITELISTOPERATION_INFORMATION_` 前缀**，所以 `label('WhitelistOperation_information_E', 14)` 返回的是 `WHITELISTOPERATION_INFORMATION_NOT_ALLOWED_TO_ADD_UNLESS_ON_READER(14)`。而 `Session_Info_Status` / `ClosureMoveType_E` 的成员名直接以枚举值原文开头。写断言或做前缀匹配时别一律按 `indexOf(...) === 0` 判。

### 7.4 `CSOperationStatus_E` —— 车机域（INFOTAINMENT / car_server）的回执

**只有两个值，没有 WAIT**。这一点决定了车机域的处理逻辑跟 VCSEC 完全不同：第一帧就是终态，
不存在「先回个 WAIT 让你等一下」，所以 `src/services/infotainment/car-action.js` 对车机命令**一律不重发**（`[15]` 里用 `cmds.length===1` 锁死）。

| 值 | 名称 | 判读 |
| --- | --- | --- |
| 0 | `OPERATIONSTATUS_OK` | 车机接受了。注意 proto3 的 0 值会被省略，所以**回执里根本没有 `actionStatus` 字段**通常就是成功；只有 `vehicleData` 那一支出现才说明带回了数据 |
| 1 | `OPERATIONSTATUS_ERROR` | 失败，**原因全在 `actionStatus.result_reason.plain_text` 里**（车机给的是人话，例：`Vehicle is not awake`）。App 会原样拼进失败文案，官方对应 `infotainment.go:37-43` 的 `car could not execute command: <plain_text>` |

车机域另两类要区分开的失败**不在这个枚举里**，而在传输/会话层：

| 现象 | 真实原因 | 处置 |
| --- | --- | --- |
| 握手被拒，日志出现 `SESSION_INFO_STATUS_KEY_NOT_ON_WHITELIST(1)` | 钥匙没落库（VCSEC、车机两域都过不了这道闸） | 回 ① 页重刷，别在 tab 页连点 |
| 只有超时、一条回执都没有 | 车机休眠 / 压根没回这个域 | 先点「车机在线探测（Ping）」；Ping 也不通就是车睡了，踩刹车唤醒 |
| `FAULT_IV_SMALLER_THAN_EXPECTED(3)` | counter 回退——**要看是哪一域的会话**，两域计数器各走各的 | 见 §8.1，只能重新绑定，禁止重试 |
| 动作回 `ERROR` 且 `plain_text` 说车没醒 | 车机侧业务判断，不是协议错 | 唤醒车机再试一次，别改字节 |
| `响应解密诊断：… 换 [domain 用请求的域 N / request_hash 换成更早那次请求（…） / … 的会话密钥] 就能对上 → 根因是这个字段` | 车辆算响应 AAD 时用的字段和我方差**一处**，日志已经点名是哪一处（`src/protocol/v3/aead.js` 的逐字段试算） | 按点名的字段改我方对应那一处；**注意这只是诊断，绝不会拿猜出来的 AAD 静默解密**（猜出来的明文不是协议允许的读法）。命中「更早那次请求」= 收到的是迟到回包，见 F18；命中「另一域的会话密钥」= 车机把回包记在别的域上 |
| `响应解密诊断：… 以上单字段全试完都对不上 → 密文被截断或会话密钥不对` | 单字段全试过都不是原因，只剩两种可能：**分包没拼完**（截断密文）或**会话密钥真的不对** | 先在同一段日志里找 `分包间隔超过 1000ms` / `长度前缀 N 超过单帧上限 1024` —— 有就是收帧被打断（§6 长度前缀行，官方 `ble.go` 口径）；都没有就点「重新握手」换一份会话密钥再试。**把整段日志（含那行 dump 的 `domain=… counter=… 密文=N B`）贴回来**，不要只贴「期望/实际」两个 tag |
| `串台帧：路由地址 … 不是本次请求` | 车辆推来的帧挂在**别的 routing_address** 上（上一轮请求或另一条连接的残留） | 正常噪声：官方 `dispatcher.go:263-293` 也是**解密之前就丢**，所以它不会被误报成 `GCM tag 不符`。若**每一帧**都是这条，说明我方路由地址与车辆认知不一致，贴日志回来 |
| `串台帧：来自 DOMAIN_VEHICLE_SECURITY(2)，不是本次请求的 DOMAIN_INFOTAINMENT(3)` / `串台帧：request_uuid … 不是本次请求` | 这帧压根不是本次请求的响应 —— 最常见的是**车辆自己发的周期广播帧**（`to={domain:BROADCAST}`、`from={domain:VCSEC}`，应用层还带着一看就像成功的 `actionStatus=OK`） | 同上一条：闸门在解密前就丢，**别把它当成功**。若超时文案里只剩这一条丢弃记录，说明车机这一轮根本没回该域 —— 先 Ping 唤醒再试 |
| `… 车辆回的是协议层错误帧（没有响应体），不再拿它试解密：MESSAGEFAULT_ERROR_RESPONSE_MTU_EXCEEDED(25)` | 车机**收下了请求，但答案装不进一包，所以直接不发数据**（`protocol.md:59-61`：协议层错误走 `signedMessageStatus`，不会给你应用层回执）。日志里的 `密文=0B` 就是这件事的样子 | 结论句是 `… 被拒：…` + `命令可能已经执行`（`error.go:195-198`），**不自动重发**（`error_test.go:62-65`）。车辆信息已经拆成每类一条；单类仍被拒就是这一类本身装不下 → 从勾选里去掉这一类，或按日志 `MTU 协商 = …` 那行确认 MTU 是否被系统压得太低 |

### 7.5 `GenericError_E` —— 车端 `nominalError`（RKE 动作被拒的原因，驾驶授权主要看这张表）

VCSEC 域的动作被业务逻辑挡回来时，`CommandStatus{operationStatus=ERROR}` 下面那层 `information` 给的就是这张表的值（官方 `pkg/vehicle/vcsec.go:173-193 executeRKEAction` 把 `nominalError` 原样上抛，取值权威口径 `pkg/protocol/protobuf/errors.proto:8-22`）。
`src/domain/response-hints.js:GENERIC_ERROR_HINTS` 只给**下面这六个码**追加处置建议（按枚举名匹配，因为 `sendRequest` 的失败分支只回 `{ok, text, fault}` 不带 obj），其余一律只打枚举名原文 —— **不猜**。
拼接动作统一在 `src/domain/command-dispatcher.js:genericErrorHint()` 里做：**解锁 / 上锁 / 驾驶授权任何一条**被车端这样拒绝，回执文案都会带上对应的下一步（原先只有驾驶授权带，第四轮真机之后上锁撞 `ALREADY_ON` / `CLOSURES_OPEN` 也能看懂了）。

| 值 | 名称 | 判读 |
| --- | --- | --- |
| 0 | `GENERICERROR_NONE` | 没有业务层错误；如果 `operationStatus` 同时也不是 `ERROR`，就是车端接受了这条动作 |
| 1 | `GENERICERROR_UNKNOWN` | 车辆自己没说原因，只能把日志贴回来 |
| 2 | `GENERICERROR_CLOSURES_OPEN` | 门/前备箱/后备箱没关严。**解锁少见，上锁和 `AutoSecure` 常见** —— 第四轮那句「锁车好像要点两次」里就混着这一码：车端没关严就是不上锁，重按也不会成 → 先让所有开度归零再按 |
| 3 | `GENERICERROR_ALREADY_ON` | 车辆已在目标状态，不是故障。**上锁撞它 = 车还没从驾驶授权状态退出来**（先下车、挂 P 再锁）；手机钥匙留在车内时车辆也会**故意**拒绝上锁（防锁手机在车里），这两种都别当成链路不通 |
| 4 | `GENERICERROR_DISABLED_FOR_USER_COMMAND` | 命令被车机里的用户开关关了 → 去车机「安全」/「手机 App 车控」一类设置里确认它没被禁用 |
| 5 | `GENERICERROR_VEHICLE_NOT_IN_PARK` | **RemoteDrive 最常见的拒绝**：车辆不在 P 挡 → 先把它停回 P 再按授权（驾驶授权只给停稳挂 P 的车） |
| 6 | `GENERICERROR_UNAUTHORIZED` | 这把钥匙权限不够（`protocol.md:187-198`：能授权哪些命令由 keyRole 决定）。本项目按 `ROLE_DRIVER` 加白仍被拒，说明这台车对驾驶授权要求更高级别的钥匙（例如车主钥匙） |
| 7 | `GENERICERROR_NOT_ALLOWED_OVER_TRANSPORT` | **车端策略禁止这条命令走当前 transport**。注意这**不是 SDK 的限制**：官方把同一个 `RemoteDrive()` 同时挂在 BLE CLI（`cmd/tesla-control/commands.go:311 "drive"`）和 Fleet 命令（`pkg/proxy/command.go:207 remote_start_drive`）上，`vcsec.go:200-202` 里也没有一行 transport 判断 —— 撞上 7 是**这台车**只放其中一条通道，BLE 侧无解，只能改走 Wi-Fi/Internet + Tesla Fleet API 的 `remote_start_drive`（本探针没有网络通道，所以只能提示，不能代做）。**第四轮真机口径：测试车没有回这一码**，`REMOTE_DRIVE` 走 BLE 被接受（`operationStatus` 不是 `ERROR`、`nominalError` 也不是 7），所以下一轮复核时**别再默认「BLE 一定被拒」**；这条判读留给别的车用 |

> 只有 `WAIT` 才重发（`command-dispatcher.js` 的原有编排，`[15]` 用 `cmds.length===1` 锁死「被 `ERROR` 拒时绝不重发」）；`GenericError` 是车端**已经判定完**的终态，重发只会再涨一次 counter。
> 而 VCSEC 域的**重发本身必须重新签一份**（`counter` 前进 + 新 nonce + 新路由地址，照官方 `vcsec.go:84-105` → `dispatcher.go:428`），照旧字节重发会被车辆按 `protocol.md:547-549` 当旧包丢掉 —— 这就是第四轮「锁车要点两次」的根因，判读口径见 F25，车机域仍复用同一份字节（`dispatcher.go:434-460`）。
> 界面侧：`GenericError_E` 的枚举名 + 上表那句处置建议会原样进 `tracked()` 台账（`UNLOCK` / `LOCK` / `驾驶授权（RemoteDrive）` / tag `VCSEC`），控制页那两张卡读的就是这些行 —— **车辆拒了显示「车辆回执拒绝」，不会显示「已启动」**。

---

## 8. 已知不确定项（真机前先看一眼，省时间）

1. **counter 只能增、不能回退。** 协议里最不可逆的坑：nonce/counter 复用会永久触发 `FAULT_IV_SMALLER_THAN_EXPECTED`，且对同一把已绑定密钥**无法自愈**，只能删钥匙重新绑定。所以 counter 按域分开存在 `uni.setStorageSync('tesla_probe_v3_session_v1')`（VCSEC）与 `'tesla_probe_v3_infotainment_v1'`（车机）里，组包时 `+1` 后才写回，握手时只会 `max(本机, 车辆回传)` 往上并（`invalidateV3Session(why, domain)` 作废**该域**的会话密钥但**绝不动 counter**）。所以：**任何一次失败后不要立刻连点重试**——失败不代表 counter 没涨。
2. **压缩点公钥未支持。** `p256.js:deriveSharedSecret` 明确拒绝 33 字节输入。若真机上车辆握手回的公钥不是 65 字节 `04…`，日志会直接报出来 → 需要补模平方根开点（数学上不复杂，但要实测确认车辆真会发压缩点）。
3. **RKE 动作编号已经大幅收缩。** 官方现行 `RKEAction_E` 只剩 `0 / 1 / 20 / 29 / 30`；`AUTO_SECURE_VEHICLE`、`WAKE_VEHICLE` 在早期 proto 里不存在或编号不同。页面上「后备箱/前备箱/充电口」是走 `ClosureMoveRequest`（F13 的「动作编号」行），自定义数字框发非表内值时只会打一条 `warn`，不伤车，但别当成「方案不行」的证据。**`REMOTE_DRIVE(20)` 现在不再靠自定义数字框手打了** —— 控制页有它自己那颗按钮（F24），② 测试页的手动 RKE 输入框照旧保留（判障时还要用它发 `29` / `30`）。
4. **会话是否轮换。** 目前是「握手一次、之后一直复用」。若车辆在一定时间/counter 跨度后要求重新握手，表现为 GCM tag 校验失败（`FAULT_AES_DECRYPT_AUTH`）→ 点「重新握手」重来即可。
5. **车辆最多同时约 3 台 BLE 钥匙连接。** 官方特斯拉 App 在后台时可能占用连接 → 扫到但连不上 / 连上无响应。**测试前杀掉官方 App 后台并断开它的蓝牙**。手机装过官方 App、已认证手机钥匙，**不影响探针**（协议无设备身份），但也**不能因此跳过绑定**（见 F11 最后一行）。
6. **本机密钥对的随机源不是 CSPRNG。** App 逻辑层没有 WebCrypto（`crypto.getRandomValues` 在 uni-app 的 JS 运行时里不存在），`aes.js:randomBytes` 用的是模块级持久 xoshiro128** 状态机：种子来自 4 次独立 `Math.random()` + `Date.now()`（高低位）+ `performance.now()` 噪声，异或进 4 个 32bit 状态字后预热 32 轮，避免「单次 32bit 种子 → 32 字节私钥只隐含 32bit 熵」。对**可行性探针**够用（一把临时钥匙，测完可删）；正式产品必须换成原生 CSPRNG（Android `SecureRandom` / iOS `SecRandomCopyBytes`，经 UTS 或原生插件暴露）。附带一条与性能有关的事实：纯 JS 的 P-256 标量乘在桌面 Node 上约 17 ms/次（密钥生成与 ECDH 各一次，每次连接最多一轮），手机上是同一数量级，不构成卡顿或超时风险。
7. **BLE 广播名匹配已做四层加固**（F5）：精确 / 前缀 / 归一化宽松等值 / 归一化宽松前缀，另加「无名但广播 `0211`」这条独立旁证；未命中但含 `TESLA` 时会单独打印真实名。**但匹配规则有个无法绕过的前提：车辆没改名。** 车机里「重命名蓝牙」、或手机系统里配对后被缓存成新名（实测出现过 `Tesla Model Y 小米YU7`），按 VIN 算出来的名字就永远匹配不上 —— 这正是 ② 页改成**广播手选弹窗**（F5.1）的原因：`0211` 服务标识和 RSSI 比名字可靠得多。所以「扫不到车」剩下的解释只有两种：**车真的没在广播**，或**名字被改过（改用手动选择）**。
8. **「扫到了但连上就断」不是匹配问题。** 若日志已经出现 `发现车辆 … connecting`，随后 `disconnected` / `getBLEDeviceServices:fail no connection`，说明匹配这一步已经成功，失败点在连接层之后：优先按 §8.5 处理（杀掉官方 App 后台、车机设置里删旧钥匙），再确认车没休眠（踩刹车让车机醒再试）。手选弹窗解决不了这一类。
9. **自动重连（F22）有三处只能上车确认。** ① **Android 上「不扫描直接 `createBLEConnection(deviceId)`」各 ROM 行为不一致**：原生 BLE 栈大多要求设备先被扫描到过一次，所以每一轮实现都是「先试 deviceId 直连 → 失败立刻扫一轮再按档案挑」，日志把两条路径分开写（`自动连接成功（deviceId 直连）` / `自动连接成功（命中档案里的名字…）`），上车看它实际走的是哪条。② **持续重试会不会被系统限流**：Android 的 `BluetoothLeScanner` 在后台有「30 秒内最多 6 次扫描」这类硬限制，前台一般不受，但各家 ROM 会把限制延伸到锁屏 / 省电模式；现在的策略是**退到后台就停循环**（`onHide`），所以真机要确认的是「前台 + 熄屏」这一档会不会被掐掉。③ **连上就被踹的抖动场景**：车辆最多同时约 3 台 BLE 钥匙（§8.5），如果探针挤进去又被立刻断开，`disconnected` 会把退避归零重来 —— 表现是每 3 秒冲一次车。真机上若确认这种抖动有害，就把再武装改成「连续断 N 次后按 30 秒档」，别改协议。**另外，App 被系统杀掉后 `onShow` 不一定触发**：uni-app 没有后台 BLE 保活，冷启动只会走 `onLaunch`，回前台才会重启循环 —— 「杀进程又不重开 App」这种情况下探针不可能自己连上车，那是产品化（前台服务 / 原生插件）要解决的事，不在可行性判定范围内。档案里的 `deviceId` 本身跨重启有效（Android = 车辆真实 MAC，iOS = 系统给本 App 的稳定 UUID），所以重开 App 一定能回到自动连接。
10. **车库里的最坏情况**：探针这把钥匙作废（重绑即可）或白名单槽位满（车机删旧钥匙）。**车不会被锁死** —— 官方 App、NFC 卡、钥匙扣、车内门把手四条退路都不经过本探针。

---

## 9. 如果 uni-app 的原生蓝牙能力不够（替代方案）

代码里已经把最可能的阻塞点埋成显式日志，出现下面任一条，**说明协议本身没问题、是 uni 的蓝牙 API 到不了**，别再改协议代码：

| 日志关键词 | 原因 | 方案 |
| --- | --- | --- |
| 弹窗 `打包时未添加bluetooth模块` | 跑在**标准基座**上（`manifest.json` 里改了也没用，基座是预编译的） | 云打包一次**自定义调试基座**（§5 第 4 步），之后改 JS 只走热更新 |
| `关键阻塞：运行时未能开启 0213 的通知` | `notifyBLECharacteristicValueChange` 打不开 CCC 描述符 `0x2902`（uni 不暴露手写描述符） | **A** 用 **nRF Connect** 连同一台车，手动对 `0213` Enable indicate，再回本 App 发送 —— 区分「一次性订阅失败」与「uni 根本不行」<br>**B** 换支持写描述符的 uni 原生蓝牙插件（DCloud 插件市场搜 BLE 类 / UTS 插件，注意需付费 + 重新打基座）<br>**C** 直接用 Android 原生（Kotlin + `BluetoothGatt.writeDescriptor`）或 Flutter `flutter_blue_plus` 重写传输层，`src/` 分层后的各层模块可原样复用（只依赖 ECDH + AES + protobuf） |
| `setBLEMTU 不可用（…），按 MTU=23 工作；超过 20 字节的响应可能被截断` | `setBLEMTU` 被拒或谈不成（`src/infra/ble/mtu-manager.js:negotiateMtu` 依次试 517/247/185/128/64 全失败），或当前平台根本没有这个 API。另有**顺序前提**：MTU 只能在订阅之后谈（官方 `ble.go:345` 先 Subscribe、`:349` 才 `ExchangeMTU`，本实现同序 `discoverServices → subscribe → negotiateMtu`），反了就会出现「包还在按 20B 切、通知已经来了」 | **写方向已经不怕了**：`BleTransport.writeChunked` 按官方 `blockLength = min(MTU,1024)-3` 真分包，出现 `帧长 N > MTU 可用 M，按官方规则分成 K 片写` 是**正常 info 日志、不是故障**。真正的问题是**读方向**：65 字节临时公钥响应会被系统截成 20B → 用 nRF Connect 设 247 对比；或走 B/C |
| `FAULT_SIGNATURE_TOO_SHORT(13)` | 写方向被 ATT 分片、或读方向被截断 | 同上；这条**同时**能反证 MTU 实际值 |
| `等待车辆响应超时` 但订阅显示成功 | indicate 打开了但回调没投递（uni 的事件总线/多监听器冲突），或车端没回 | 先在 ③ 页发一条 `GET_WHITELIST_INFO` 明文请求（F14 的实测字节）复现；能定性为「uni 回调问题」还是「车没回」 |
| `只能在 App 真机上运行` | 跑在 H5 / 小程序 / 未打基座 | 必须真机 + 自定义基座 |
| `disconnected` 紧跟 `connecting`，随后 `getBLEDeviceServices:fail no connection` | 连接被**车端**掐了：3 台 BLE 钥匙上限 / 官方 App 抢占了这条连接 / 车机休眠 / 选错了设备（手选时点了别人的广播） | 杀掉官方 App 后台并在系统蓝牙里断开它 → 踩刹车让车机醒 → 重新 ② 手选（挑标了 `0211 服务` 的那条）。**这与广播名匹配无关，改匹配规则没用** |
| `扫描 … 未发现目标车辆`，但「列出周围广播」里能看到一个不像 VIN 派生的 `Tesla …` 名字 | 车辆蓝牙名被改过（车机重命名 / 系统配对缓存） | 用 ② 的手选弹窗直接点它（F5.1）；或在车机蓝牙设置里把名字改回 `Tesla <VIN后6位>` |

**最低成本的「非 uni」验证路径**：nRF Connect 手工发字节。
连车 → 对 `0213` Enable indicate → 设 MTU 247 → 向 `0212` 写 ③ 页「只编码不发送」产出的完整 hex（含 2 字节长度前缀）→ 看回包。
- nRF Connect 手发能被车执行，本 App 不行 → 问题 100% 在 uni 蓝牙 API（走 B/C）。
- nRF Connect 也不行 → 问题在协议实现，把报文贴回来。

**取证优先级**（现场能留多少留多少）：日志窗口点 `复制` 贴文本（F19，最省事，带 `-----start-----/-----end-----` 动作分段）> 整段录屏 > ③ 页原始帧 hex > 车辆真实广播名 > 白名单条数 > 车机屏幕提示。

---

## 10. 规格来源

| 来源 | 用途 |
| --- | --- |
| `protos/VCSECv3.10.14.proto`（trifinite/vcsec-archive） | 早期字段号 / 枚举数值的旁证（**现行数值一律以 `vehicle-command` 的 `protobuf/vcsec.proto` 为准**，两者不一致时后者赢；映射写在 `src/protocol/v3/spec.js` 头注释） |
| gist `LexNastin/fc55736f…` | 端到端绑定 + 加密指令的样例报文与字节核对 |
| `teslabtapi.com/docs/start` | GATT（Service `…0211` / 写 `0212` / 收 `0213` / 版本 `0214`）、2 字节大端长度前缀、BLE 命名规则（新 `Tesla `+VIN 后 6 位 / 旧 `S`+SHA1(VIN)hex 前 16 位+末位 C/R/D/P） |
| `teslabtapi.com/docs/more/rke` | RKE 动作枚举、AES-GCM key/nonce/aad 推导 |
| `github.com/teslamotors/vehicle-command` → `pkg/protocol/protocol.md` | **V3 的权威来源**：`RoutableMessage` 报文格式、TLV 元数据编码、成对的官方测试向量（§6 里 V3 那几行逐字节对拍都取自这里） |
| 同上 → `internal/authentication/{native,metadata,peer,signer,verifier,crypto}.go` | 握手 HMAC 的元数据顺序、子密钥派生、`counter` 语义（`counterMax = 0xFFFFFFFF` 是保留哨兵、`timeZero = generatedAt - clock_time` 锚点、换 `epoch` 时 counter 归零） |
| 同上 → `internal/dispatcher/{dispatcher,session,receiver}.go` | 请求 ID 如何配对响应、`routing_address` / `uuid` 何时生成何时复用、响应里搭车 `session_info` 的采纳条件 |
| 同上 → `pkg/vehicle/{vehicle,vcsec,security}.go` | `flags = 1<<FLAG_ENCRYPT_RESPONSE`、BLE 每 1 秒重发、`WAIT` 按 `ErrBusy` 整条重发 |
| 同上 → `pkg/vehicle/vcsec.go:84-105` + `internal/dispatcher/dispatcher.go:428` + `:392-413` + `:434-460` | **F25「锁车要点两次」的权威取证 —— 官方是两层重试，语义正好相反**：① 应用层 `vcsec.go:84-105` 拿到 `OPERATIONSTATUS_WAIT` 就返回 `ErrBusy`，**外层重新调用 `dispatcher.Send()`**；而一次 `Send()` 会重新 `session.authorize`（`dispatcher.go:428`）→ **`counter` 前进 + 新 nonce + 新 tag**，并且 `:392-413` 只为 VCSEC 目的地**重新随机 `routing_address`、重新生成 uuid**。② 传输层 `dispatcher.go:434-460` 的循环则相反：反复写出**同一份已经 `proto.Marshal` 的字节**（不重新签名）。所以「整条重发」落在应用层时**必须重签**，落在传输层时才复用旧字节 —— 本项目第四轮之前把 VCSEC 的 WAIT 重发按车机域那种「复用同一份字节」实现了，才会被车辆当旧包丢弃（见 `protocol.md:547-549` 下一行） |
| 同上 → `pkg/protocol/protocol.md:547-549` | 两域乱序容忍度的差异写得很直白：Infotainment 用 sliding window，**VCSEC 要求消息按 `counter` 顺序到达**，重复的 `counter` 会被判 `MESSAGEFAULT_ERROR_REPEATED_COUNTER` —— 这就是「同字节重发」在 VCSEC 域为什么必然失败的那条依据 |
| 同上 → `pkg/vehicle/vcsec.go:173-193`（`executeRKEAction`）与 `:200-202`（`RemoteDrive`） | **F24 驾驶授权的权威取证**：`Unlock / Lock / RemoteDrive / AutoSecure / Wake` 全部走同一个 `executeRKEAction(ctx, action)`，`RemoteDrive(ctx)` 的函数体就一行 `executeRKEAction(RKE_ACTION_REMOTE_DRIVE)`，**函数体内没有任何 transport 判断**，也没有任何「unlock 顺带发 drive」的路径 —— 它是一条**独立命令**，且官方允许它走 BLE。被拒时该函数把 `nominalError` 原样上抛（→ §7.5） |
| 同上 → `cmd/tesla-control/commands.go:311-318`（`"drive"`，help `Remote start vehicle`）+ `configureFlags` | BLE CLI 侧的命令注册表：`drive` 与 `unlock` / `lock` **完全同级** —— `requiresAuth: true`、`requiresFleetAPI: false`、不设 `domain`；而 `--ble` 只拒绝 `requiresFleetAPI` 的命令。**这就是「官方并未禁止 RemoteDrive 走 BLE」的直接证据** |
| 同上 → `pkg/proxy/command.go:207-208`（`remote_start_drive`） | Fleet/Proxy 那条**转调的还是同一个 `v.RemoteDrive(ctx)`** —— 两条通道发到车上的载荷一模一样，差别只在 transport。所以「BLE 被拒」只能由车端策略解释（`GENERICERROR_NOT_ALLOWED_OVER_TRANSPORT(7)`），不能由 SDK 推出来 |
| 同上 → `pkg/protocol/protobuf/errors.proto:8-22`（`GenericError_E`） | RKE 动作被业务层拒绝的原因全集与**数值**：`NONE=0 / UNKNOWN=1 / CLOSURES_OPEN=2 / ALREADY_ON=3 / DISABLED_FOR_USER_COMMAND=4 / VEHICLE_NOT_IN_PARK=5 / UNAUTHORIZED=6 / NOT_ALLOWED_OVER_TRANSPORT=7`（§7.5 表的出处，`src/domain/response-hints.js:GENERIC_ERROR_HINTS` 只给其中六个可处置的码加建议：`CLOSURES_OPEN / ALREADY_ON / DISABLED_FOR_USER_COMMAND / VEHICLE_NOT_IN_PARK / UNAUTHORIZED / NOT_ALLOWED_OVER_TRANSPORT`） |
| 同上 → `pkg/protocol/domains.go:7-13` | `Domain_MAX` 的存在本身：**每个 destination domain 一个会话**；本项目只登记 `DOMAIN_VEHICLE_SECURITY(2)` 与 `DOMAIN_INFOTAINMENT(3)` 两个会建会话的域 |
| 同上 → `internal/dispatcher/dispatcher.go:36` | `sessions [Domain_MAX]Session` —— per-domain 会话的**直接实现证据**（不是推测） |
| 同上 → `pkg/protocol/infotainment.go:19-45` | 车机域动作的**回执判读口径**：只看 `actionStatus.result`，`ERROR` 时把 `result_reason.plain_text` 拼成 `car could not execute command: <text>`；`:59-70` 给出 `Ping{ping_id:1}` 的载荷 |
| 同上 → `pkg/protocol/state.go:38-86` | `GetVehicleData` 的**类别开关全集**（closures / charge / climate / drive / location / tirePressure 六类），以及 `VehicleData` 里各子结构的取用方式。**关键是 `:70-82 GetState(category)` 一次只收一个 `StateCategory`**、`:38-58` 是「类别 → 单条请求」的一对一 map —— 没有任何参考实现把多个开关塞进同一条 `GetVehicleData` |
| 同上 → `protobuf/car_server.proto` | `Action{oneof action_msg{vehicleAction=2}}` 与 `VehicleAction` 的 oneof 字段号：`getVehicleData=1`、`ping=46`、盖板关 `=61` / 开 `=62`；`Response{actionStatus=1, oneof response_msg{vehicleData=2, getSessionInfoResponse=3, ping=9}}`；`CSOperationStatus_E` **只有 OK/ERROR、没有 WAIT** |
| `github.com/0Bu/tesla-key-esp32`、`yoziru/esphome-tesla-ble` + `tesla-ble/src/client.cpp:46-52`、`include/peer.h` | nanopb 侧旁证：`peer` 结构里**每个域各存一份 session/counter**；空 message 动作（充电盖板开 / 关）编码为「tag + len=0」，整条 `Action` 固定 5 字节 |

> 关于早期文档里「`nonce = 4B counter` / AAD 空」与现行「`12B nonce` + AAD」的矛盾：**两者都曾对，是两代协议**。前者对应 VCSEC 直连报文，官方现行客户端走 V3 `RoutableMessage`。本工程一开始两套都实现、并在启动页选择，用真机给出答案：直连那套在这代车机上拿不到可解析的响应，于是连同选版本页一起删了（§2.1）。现在只剩 V3，**唯一保留的老式信封是绑定帧**（F11，因为那时还没有会话可加密）。

协议里最容易写错的一点单独强调：**protobuf 的「默认值省略」只适用于普通 singular 标量，oneof 成员一律是「显式存在」**（见 [protobuf 官方 Field Presence](https://protobuf.dev/programming-guides/field-presence/)）。

- 普通标量：等于 0 / 空 / false 时不编码。所以 `GET_STATUS(0)` 的 `informationRequestType` 不出现，但 `InformationRequest` 本身是 `UnsignedMessage` 的 oneof 成员 → 请求体仍是 `0a 00`（tag + 长度 0）；`CommandStatus.operationStatus=OK(0)` 也因此常常不出现。
- oneof 成员：值为 0 也要写 tag。`RKE_ACTION_UNLOCK = 0`，而 `UnsignedMessage` 整条消息只有一个 `oneof sub_message`——一旦把 `UNLOCK` 当普通标量省略，内层就退化成 **0 字节**，密文 0 字节，外层 `protobuf_message_as_bytes`（同为 oneof 成员）跟着被省略，车辆收到一条**没有载荷**的 RKE 命令，只能一直回 `operation_status=WAIT`。这正是「上锁成、前备箱成、独独解锁 WAIT」的成因。

三方依据（本项目按此顺序取证，未采信任何早期文档的说法）：官方 Go `vcsec.go:181-186` 组 RKE 请求时用 `SubMessage: &vcsec.UnsignedMessage_RKEAction{RKEAction: action}` + `proto.Marshal`，oneof wrapper 无条件编码；`vcsec.go:109-130 getVCSECInfo` 证明 `GET_STATUS` 的内层就是 `0a 00`；nanopb 侧 `tesla-ble/src/client.cpp:683-699` 靠 `which_sub_message` 达到同样效果。

**待真机复验**：修好后解锁应回「没有 `commandStatus` 的空消息」（官方 `vcsec.go:174-179` 判为成功）并且车真的响。

另外核对过一处容易误判为 bug 的地方：**WAIT 时整条重发是对的**，不用改。链路为 `vcsec.go:47-51`（WAIT → `ErrBusy`）→ `readUntil:71-74`（`err != nil` 直接上抛，不再继续读）→ `getVCSECResult:94` 调 `protocol.ShouldRetry`，而 `ErrBusy = NewError(…, PossibleSuccess=false, PossibleTemporary=true)`（`error.go:34`）使 `ShouldRetry` 返回 `true`（`error.go:131-133`）→ 于是**重新组包、整条重发**。这与 `src/domain/command-dispatcher.js` 的 `busy → 重发` 完全一致；官方注释还点明 WAIT 常见于车辆正在唤醒、执行组件尚未起来（`error.go:26-29`）。
若载荷修好后仍一直回 WAIT，说明车辆**收到了动作但当下不肯执行**，按上表语义继续重发直到 `maxMs`，然后排查车端状态（是否在唤醒中、挡位/车速、是否限制了手机钥匙解锁），不要再怀疑 `readUntil` 那层。

---

## 11. 请评审 AI 重点回答的问题

1. §3 里 F9（INDICATE 订阅）与 F7（MTU）是唯一的 uni 硬边界吗？还有没有别的 API（如 `uni.writeBLECharacteristicValueType`、UTS 插件、`plus.bluetooth` 直接调用）能在**不引入第三方原生插件**的前提下打开 0x2902？
2. F11 的绑定报文（裸 `ToVCSECMessage{signedMessage{PRESENT_KEY}}` + 明文内层 + `keyRole=ROLE_DRIVER(3)` + `formFactor` 由页面选、默认 `ANDROID_DEVICE(7)`，**不带 `permission` 数组**）与官方固件期望是否一致？官方 `security.go:338 SendAddKeyRequestWithRole` 发的就是这个形状，但现行 proto 里 `PermissionChange` 只剩 `key / secondsToBeActive / keyRole` —— `keyFormFactor` 按官方 `vcsec.go:151` 放在 `WhitelistOperation.metadataForKey`，只给 `keyRole` 不给任何 permission，车机会不会因此回 `NO_PERMISSION_TO_ADD(5)`？
   另外，**绑定成败的判定已经改成「终态回执与会话探针并行、谁先来算谁」**，理由是取证到量产固件常常**不回** `protocol.md:836` 那条 completing 的 `whitelistOperationStatus`（0Bu `vehicle_pairing.cpp:246` 明确把它标成 `ExpectedSilent`）。请确认：① 这个结论对本车（HW4/V3、2025.44）是否成立；② 探针用的「无签名 `session_info_request` 打 VCSEC 域」（官方 `vehicle.go:120` + `dispatcher.go:464 AuthMethodNone`）会不会有唤醒车机 / 计入操作频率之类的副作用；③ 有没有比它更可靠的「已入白名单」判据。
3. F12/F13 的密钥与加密链（`sharedKey = SHA1(ECDH_x)[:16]`、`subkey = HMAC-SHA256(K,label)`、`nonce = randomBytes(12)`、`AAD = SHA256(TLV‖0xFF)`、`signature = GCM tag`、身份靠 `signer_identity.public_key`）有没有和现行固件不符之处？特别是响应侧 `request_hash` 的构造（`sigtype 单字节 ‖ 请求的 tag`，HMAC 时截 16 字节）。
4. counter 与会话的生命周期管理（换连接 `invalidateV3Session(why, domain)` 只清该域密钥不动 counter、握手 `max(本机, 车辆回传)`、组包成功才写回）是否存在会导致 `IV_SMALLER_THAN_EXPECTED` 的边界（例如并发点击、断连重连、App 被杀、`0xFFFFFFFF` 哨兵附近）？**现在两域各一份 counter**，请一并检查跨域并发：车控页 `busy` 锁是「同一时刻只允许一个动作」，两页两个域的动作是否仍可能在两域之间造成竞态？
5. 若 Q1/Q2 判定为「uni 做不到」，§9 的 B/C 哪条改动量最小？`src/` 分层后的模块里哪些可以直接复用、哪些必须原生替代？（我方已知最需要原生替代的是 `src/infra/crypto/aes.js:randomBytes` —— 纯 JS 的 xoshiro128**，非 CSPRNG，见 §8.6。）
6. `GET_WHITELIST_INFO` 这台车实测回的是 **4 字节 keyId**，而 V3 的 `keyIdOf(pub)` 是完整 20 字节 SHA1。现在靠 `keyIdMatches()` 做前缀归一糊过去了 —— 官方到底哪一种才是规范回包？不同年款会不会回 20 字节、导致前缀匹配反向失效？
7. 手选弹窗（F5.1）目前用「广播了 `0211` 服务」当作比名字更强的车辆证据。在 Android 上 `advertisServiceUUIDs` 是否总能被 `onBluetoothDeviceFound` 填充（部分机型只在连接后才给服务列表）？若不可靠，是否该改成点完条目后靠 `getBLEDeviceServices` 的结果二次确认？
8. **INFOTAINMENT 域（F21）第三轮上车已经拿到真数据**：六类各发一条、六类全部解密成功（电量 / 充电 / 空调 / 行驶 / 位置 / 胎压）。前两轮的空手而归分别是我方自创的「响应没有 payload」误报（见 F13「响应侧」）和车辆自己写明的 `fault=25 RESPONSE_MTU_EXCEEDED`（见 F18「协议层错误帧」），两者都已修并上回归锁。还需要评审的三点：
   ① 手机 BLE 钥匙（白名单里的 `KEY_FORM_FACTOR_ANDROID_DEVICE`）在 `DOMAIN_INFOTAINMENT` 上**能建会话、能读状态、也能执行动作**都已证实：读状态 = 该域连续 6 帧 GCM 解密成功、counter 12→17 有序（见 §6 结尾），执行动作 = **充电盖板真机开 / 关都成**（`OPERATIONSTATUS_OK` 且盖真的动了）。所以这个域**不存在「只许读不许写」的权限墙**，剩下没上车的只有 Ping —— 而 Ping 与盖板走的是同一条 `sendCarAction`、同一个域会话（`infotainment.go:52-70` 的 authenticated no-op），它不通的概率已经很低。官方 Go 客户端是**服务端证书**走 TLS，nanopb 侧是 ESP32 钥匙；请确认现行固件对 BLE 钥匙在这个域的动作权限还有没有别的类别是收着的（例如预设空调、启动模式）。
   ② 两域会话**共用同一个 `sharedKey`（`SHA1(ECDH)[:16]`）但各自一份 counter/epoch** —— 我们是按 `dispatcher.go:36` 的数组形状推的。请确认车辆侧给两个域下发的 `SessionInfo` 里的 `epoch` 是否确实不同、共享秘密是否真的与域无关（若按域派生，`[15]` 里那两条 `epochMatches` 断言就会在真机上暴露成 GCM tag 校验失败）。
   ③ 充电盖板现在是**两条路径并存**：车控页走车机域 `chargePortDoorClose/Open(61/62)`（`car_server.VehicleAction`），测试页仍保留 VCSEC 的 `ClosureMoveRequest{chargePort}`（`CLOSE/OPEN_CHARGE_PORT`）。真机已经给出半边答案：**车机域那条可用**（开 / 关都成）。VCSEC 那条**故意先留着做 A/B**，用来回答「这台车到底认哪条、两条是不是都认」—— 请确认按官方现状应该以哪条为准，另一条该不该删。
9. **第二次真机 `GetVehicleData` 的两帧到底是什么 —— 第三轮已经给出答案**：第二轮日志给的是 `fault=25 … 密文=0B`（即 `signedMessageStatus{operation_status=ERROR, signed_message_fault=RESPONSE_MTU_EXCEEDED}`、`protobuf_message_as_bytes` 长度 0），紧跟 5 次 `等待终态超时（最后一帧：无；已丢弃 1 帧 … 响应 GCM tag 不符）`；清掉日志再点一次，则先回同样的 tag 不符、随后 `取暂存帧 26 字节` 被判成 **`成功：actionStatus=OPERATIONSTATUS_OK(0)`**，但那 26 字节里一个 `vehicleData` 都没有。我方的三条判读**全部被第三轮真机日志证实**：① 错误帧是**终态拒绝**（不再拿它试解密、不自动重发，`error.go:195-198` + `error_test.go:62-65`）—— 拆单类后 `fault=25` 一次都没再出现；② 那条「成功」确实是把**别的域的帧当成了本次响应**（`to=BROADCAST` / `from=VCSEC` / 无 `request_uuid` 却带 `actionStatus=OK` 的周期广播帧），按 `{domain, address, uuid}` 三路闸门在解密前丢弃后，第三轮收尾又出现一条同款广播帧，这次打的是「无人等待的响应」（F18「配对闸门」）；③ 根因是**一条请求问了六类**，拆成每类一条后六类全部带回数据。仍需评审的是：① 该车（HW4/V3、2025.44）在 `DOMAIN_INFOTAINMENT` 上实际协商到的 MTU 我方从分包反推是 **247**（首包净荷 244 = `247-3`，380 字节的帧跨两包重组后回 `响应 378 字节`）—— 与 Android 侧请求 517 被车机降到 247 一致吗？**本轮日志在连接之后被清过才开始记**，没有 `MTU 协商 =` / `MTU 变更（车辆侧回读）` 那两行，所以这只是反推：如果 `setBLEMTU(517)` 在 Android 上「成功」而 `res.mtu` 回的是**请求值**、链路实际只跑到 247，那写方向会按 `517-3` 切包（现网请求最长 187 字节，暂时看不出差别）。请确认 `res.mtu` 到底是请求值还是协商值，`onBLEMTUChange` 是不是唯一可信的回读源。官方对 `VehicleData` **单类**响应有没有「一定装不进一包」的类别（`charge_state` 就已经是两包）？② 官方 Go 客户端问 `GetVehicleData` 时是**每类一条并发**还是串行？`state.go:70-82` 只给了单类别入口，没看到调用方怎么排布六类（我方现在是串行，六条之间不并发，避免 counter 竞态）。③ 车辆在该域发**广播帧**（`DOMAIN_BROADCAST`）是常态吗（第三轮日志收尾确实抓到一条）？会不会与本请求的响应在暂存队列里交错？④ 车辆回包里的两个怪现象是不是官方预期：**每条 `vehicleData` 尾部都带字段 999（值恒 1）**，以及**问 `drive` 那一条会顺带带回 `location_state`** —— 官方 `vehicle.proto` 里既没有 999，`DriveState` 也不含位置；我方按「未登记字段 → `f<n>`」原样显示、并按类别计数（F21）。**顺带一条已知的自家缺口**：本端目前只在 ③ 报文控制台里把无 payload 帧识别成 `handshakeRequest`（`src/protocol/v3/summary.js`），`sendRequest` 收到它并不会像官方 dispatcher 那样回一帧 `SessionInfo`，而是按「看不懂的帧」丢掉继续等 —— 真机若出现这种帧，表现就是「命令一直超时」。第三轮日志里**没有出现过这种帧**，所以这个缺口仍未被现场触发过，要不要补「回 session_info + 整条重发」请给个意见。
10. **自动重连（F22）的档案粒度与节流**：现在记的是 `{vin, deviceId, name, keyId, boundAt, connectedAt}`，靠 `deviceId` 跨重启稳定这一假设；重试节奏是模块级状态（`loopWanted / loopStep / loopTries`），**不落盘**。请评审：① 一车多机 / 一机多车时档案该不该做成列表（当前是单车覆盖式，`清除绑定档案` 手动切车）；② `autoSuspended` 也只在内存里（主动断开 = 取消已排期的重试，回前台不会把它冲掉，但重开 App 会恢复自动连）—— 要不要连 `boundAt` 一起落盘做成持久开关；③ **前台 3 → 30 秒退避是经验值**：走到车边通常 20~30 秒内会连上，但用户站在原地等一分钟会不会觉得「它卡住了」而改用手动？需不需要在 30 秒封顶若干轮之后再降频（例如 60 秒）；④ 有没有比「deviceId 直连 + 一轮扫描兜底」更确定的重连姿势（例如 Android 上先 `getBLEDeviceConnections` 看是否已被系统侧保持连接）。
11. **解锁之后能不能挂挡 —— 第四轮已经给出答复（F24 / F25）**：真机结论是**这台车（HW4/V3、2025.44）接受 BLE 发 `REMOTE_DRIVE`**，判据不是日志字样而是「按完踩刹车能挂上 D/R」，回执里既没出现 `GENERICERROR_NOT_ALLOWED_OVER_TRANSPORT(7)` 也没出现 `UNAUTHORIZED(6)`。所以原先的两个问题（① 这台车对 `REMOTE_DRIVE` 的实际策略、② 纯 BLE 无 Fleet 凭证时能不能让车进入可挂挡状态）**已由现场证实为「能」**；本项目的做法仍是**照发 BLE、只认车端回执**，只是位置从「单独按钮」升级为「解锁拿到终态成功之后自动补发一条」（`vehicle-api.unlockAndDrive()`，F25）；协议层与 `src/services/vcsec/` 里依旧没有 drive —— 官方 `Unlock()` 里没有这条，红线不松，**也绝不替车辆模拟「启动成功」**。仍需评审的是：① **授权窗口的实际时长与过期后再请求的行为** —— 手册口径约两分钟，但车端从没在回执里给过窗口字段，我方无法证伪；串发严格排在解锁终态之后，要不要再等一个「门已开」的状态位（现在不等）；② **串发多消耗 counter**（解锁一条 + 授权一条，授权撞 `WAIT` 还要再 `+1`，见 F25）对本 §8.1「counter 只能增、不可回退」的长期影响，以及车辆对 VCSEC 域有没有频率侧的限制；③ 与官方 App 的**体验差距**：量产的「丝滑」靠的是 **BLE Presence 自动解锁**（连上就开）与**远离自动上锁**（`AUTO_SECURE`，断开就锁），不是把两条命令缝起来（取证见 F25 那一行）。本探针是按钮式的，要不要把连接状态机接进这两条自动路径，接了之后怎么与「手机钥匙留在车内时车辆会**故意**拒绝上锁」（§7.5 码 `ALREADY_ON`）这条车端策略共存 —— 是产品决策，不是协议问题；④ 万一换一台车真的只放行 Fleet/Proxy：本探针**零网络通道**（§2），届时的回落口径建议保持「把 `GenericError` 原文抄回评审、由人去官方 App 操作」，而不是在界面上摆一条做不到的按钮。
