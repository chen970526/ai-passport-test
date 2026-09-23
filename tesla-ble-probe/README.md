# Tesla BLE 离线钥匙可行性探针（uni-app）

**这个工程只做一件事：验证「特斯拉开放的 BLE 离线钥匙协议（VCSEC）」能不能在一台安卓手机上，用 uni-app + 其自带的原生蓝牙 API 跑通。**

跑通 = 能绑定车辆 → 能协商出会话密钥 → 能发出被车辆实际执行的**上锁 / 解锁**指令。

它不是产品：私钥明文存在 App 沙箱、UI 只有按钮和日志、错误提示直给。
**只在真机（App / Android）上有效**，H5 与小程序拿不到蓝牙 GATT，代码里会直接抛「只能在 App 真机上运行」。

两件事和初版不同，先记住：

- **只保留一套协议：V3（官方 vehicle-command 现行 `RoutableMessage`）**。早期那套「VCSEC 直连 + counter 当 nonce」的报文实测在这代车机上拿不到有效响应，已连同 `common/actions.js`、`common/spec.js` 和启动选版本页一起删掉；现在 ① ② ③ 三个页面直接就是 V3 流程（§2.1、F12–F13、F18–F20）。
- **② 扫描连接改成「广播手选」**：车辆蓝牙名被车机或手机改过时（如 `Tesla Model Y 小米YU7`），按 VIN 算出来的名字必然匹配不上；现在会把 12 秒内扫到的广播全部列出来，按「命中VIN / 0211 服务 / dBm」排序让人点（F5.1）。

---

## 0. 给评审者（人或 AI）的一段话

请重点判断的不是「密码学对不对」（这部分已用 Node 原生 `crypto` 逐字节对拍，见 §6），而是下面 4 个**只有真机能回答**的问题：

| # | 待判定问题 | 卡在哪 | 如果不行，退路 |
| --- | --- | --- | --- |
| Q1 | `uni.notifyBLECharacteristicValueChange` 能否真正打开 0213 的 CCC 描述符（0x2902 = indicate） | uni 不暴露手写描述符 | 见 §9 三级方案 |
| Q2 | `uni.setBLEMTU` 能否把 MTU 谈到 ≥ 帧长+3（响应里有 65 字节临时公钥） | 部分栈只在连接瞬间允许一次 MTU 请求 | 同上 |
| Q3 | `uni.writeBLECharacteristicValue` 一次能否写完整帧（≈40–110B），不做 ATT 分片 | ~~特斯拉 VCSEC 不接受跨 ATT PDU 的分片写~~ **此假设已被官方 `ble.go` 推翻**：车端就是按 `min(MTU,1024)-3` 分片收、靠长度前缀重组 | 已按官方规则实现分包写（F7）；抬高 MTU 只对**读方向**仍是硬需求 |
| Q4 | Android 12+ 上，uni 的 BLE 全套 API 在运行时权限（SCAN/CONNECT）下的行为是否与 targetSdk 匹配 | 基座 targetSdk 由云打包决定，不一定等于 manifest 写的值 | 已改成运行时 `SDK_INT` 探测（§3 的 F2） |

协议侧的风险点（与 uni 无关，属「方案本身」）：counter 单调递增不可回退、白名单槽位有限（约 3 把 BLE 钥匙）、临时公钥是否轮换。见 §8。

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
├── main.js / App.vue / pages.json / manifest.json   uni-app 工程四件套（Vue3）
├── pages/
│   ├── index/index.vue    ① 蓝牙就绪 → ② 扫描连接（广播手选弹窗）→ ③ 绑定车辆（刷钥匙卡）+ 排查按钮
│   ├── rke/rke.vue        握手 / 上锁 / 解锁 / 闭锁器动作 / 连发压测
│   └── debug/debug.vue     手工组包、原始帧收发、报文解析、规格速查（排障用）
├── components/log-box/log-box.vue   全局日志窗口（清空 / 复制 / 自动滚底，订阅 session 日志总线）
├── common/
│   ├── sha1.js  sha256.js  aes.js  p256.js   纯 JS 密码学（不依赖 BigInt / 不依赖任何原生模块）
│   ├── bytes.js                      字节 / hex / 大端整数工具
│   ├── pb.js                         手写 protobuf wire 编码 + 解码 + 结构化打印
│   ├── v3spec.js                     V3（UniversalMessage / RoutableMessage / SecurityType）字段号与枚举表
│   ├── vcsec.js                      与协议无关的公共件：GATT UUID、2 字节长度前缀、BLE 广播命名、密钥对、keyId
│   ├── v3vcsec.js                    V3 协议层：握手报文、AES-GCM 会话加密、响应解密与认证、报文摘要
│   ├── tesla-ble.js                  uni BLE 封装（适配器、扫描、手选列表、连接、MTU、订阅、分帧重组、权限）
│   ├── session.js                    全局会话：密钥对、V3 会话落盘、日志总线与动作分段、BLE 生命周期
│   ├── v3actions.js                  V3 动作：握手 / 刷卡绑定 / 加密指令 / 闭锁器 / 查询 / 重发编排
│   ├── notify.js                     全站唯一的提示出口：「关闭 / 复制」弹窗（替代 uni.showToast）
│   └── api.js                        页面唯一入口：给每个动作包一层日志分段，另向 ③ 控制台交出整套编解码工具
└── tests/
    ├── run.mjs                       算法与协议对拍自测（Node，220 条断言）
    └── vue-check.mjs                 把 .vue 的 <script> 真 import 一遍做语法自检（5 个文件）
```

**零 npm 依赖**：`common/` 下全是自研纯 JS，HBuilder X 里不需要 `npm install`，也不需要任何原生插件。

分层原则：**协议层（`v3vcsec/pb/v3spec/sha1/sha256/aes/p256/bytes`）完全不认识 uni，传输层（`tesla-ble.js`）完全不认识协议**。
所以将来换 Kotlin / Flutter 重写传输层时，只有 `tesla-ble.js` 一个文件需要替代。

### 2.1 为什么只剩 V3 一套

早期版本同时保留了「VCSEC 直连」（`ToVCSECMessage` + 用 counter 当 nonce + AAD 空）和「V3 `RoutableMessage`」两套报文，并在启动页让人选版本。真机结果：直连那套的加密指令一律拿不到可解析的响应，而 V3 一路走通到「车辆明确回 `session_info.status`」，所以直连实现连同选版本页一起删掉了。现在 `pages.json` 首页就是 `pages/index/index`，**没有版本选择这一步**。

现行这一套的要点（对应官方 vehicle-command 源码，本地副本见 `.hosttest/vc`）：

| 环节 | 报文 | 官方出处 |
| --- | --- | --- |
| 刷卡绑定（还没有会话） | 裸 `ToVCSECMessage{signedMessage{PRESENT_KEY}}`，首字节 `0x0a` | `pkg/vehicle/security.go:338 SendAddKeyRequestWithRole` |
| 建立会话 | `RoutableMessage{session_info_request(14)}` ↔ `RoutableMessage{session_info(15), signature_data}` | `internal/dispatcher/`、`pkg/protocol/protocol.md` |
| 下指令 | `RoutableMessage{protobuf_message_as_bytes=SignedMessage(AES_GCM_Personalized_data)}`，`12B 随机 nonce` + `AAD = SHA256(TLV 元数据 ‖ 0xFF ‖ 明文)` | `pkg/protocol/authentication.go` / `session.go` |
| 会话状态 | `sharedKey` + `epoch` + `anchor(timeZero)` + `counter`（只增不减，落盘 `tesla_probe_v3_session_v1`） | 同上 |
| RKE 动作 | `RKEAction_E` 只剩 0/1/20/29/30；后备箱 / 前备箱 / 充电口改走 `ClosureMoveRequest` | `pkg/protocol/protobuf/vcsec.proto` |

**唯一的例外是绑定**：加白名单发生在「还没有会话」的时刻，官方也是直接把这个老式信封交给 BLE 层（首字节 `0x0a` 而不是 `0x12`），所以 `common/vcsec.js` 里保留了 `prependLength / stripLength / GATT / bleNamesForVin / newKeyPair / keyIdOf` 这几个与协议版本无关的公共件。

---

## 3. 功能点全清单（每个功能点：入口 → 调用链 → 接口 → 实现方式 → 判据）

> 表里的「uni 接口」全部是 uni-app App 端自带 API（无需插件）；「纯 JS」列是本工程自研实现。
> 旧版协议已删除，**F1–F20 全文只描述 V3 这一套**；F11 的绑定帧是唯一的例外（它天生不带会话，见 §2.1）。

### F1 运行环境自检（基座对不对 / 蓝牙模块进没进）

| 项 | 内容 |
| --- | --- |
| UI 入口 | 无按钮，App 启动时自动跑（`App.vue` 的 `onLaunch`） |
| 调用链 | `App.vue:onLaunch` → `tesla-ble.js:logRuntimeEnv(log)` → `session.js:log()` |
| 用到接口 | `plus.runtime.version / versionCode / appid / standalone`、`typeof plus.bluetooth` |
| 实现方式 | `plus.bluetooth` **只有在基座编译了 Bluetooth 模块时才存在**，所以它是「基座是否为新基座」的权威探针；`plus.runtime.standalone` 用来区分独立 App / 调试基座 |
| 成功标志 | 日志 `Bluetooth 模块已就绪（plus.bluetooth 存在）` + 基座版本号 |
| 失败判读 | `基座里没有 Bluetooth 模块` → 手机上还是旧基座，或 `manifest.json` 的 `modules` 被 HBuilderX 可视化界面回写清掉了（见 §5） |

### F2 Android 运行时权限

| 项 | 内容 |
| --- | --- |
| UI 入口 | ① 页「① 蓝牙就绪」（`step1`） |
| 调用链 | `index.vue:step1` → `tesla-ble.js:ensureAndroidPermissions()` → `ble().init()` |
| 用到接口 | `plus.android.requestPermissions(perms, okCb, errCb)`；内部用 `plus.android.importClass('android.os.Build$VERSION').SDK_INT` 决定申请哪一套 |
| 实现方式 | **运行时探测而非写死**：`SDK_INT >= 31` 时在 `ACCESS_FINE_LOCATION` 之外追加 `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT`；否则只申请定位（老模型下申请未声明的新权限会被判「永久拒绝」，误导排障）。两套权限在 `manifest.json` 里**全部声明**，所以无论基座 targetSdk 是多少都不缺 |
| 成功标志 | `运行时权限已授予: [...]` |
| 失败判读 | `权限被拒绝: [...]` → 系统弹窗里选了「拒绝/始终拒绝」；Android 12+ 上定位被拒不影响，Android 11- 上定位被拒 = 扫描恒空 |
| 为什么这段是 JS | 改它**不需要重新打包基座**（热更新即可），所以现场可以根据日志直接调 |

### F3 打开蓝牙适配器

| 项 | 内容 |
| --- | --- |
| UI 入口 | 「① 蓝牙就绪」；「列出周围广播」「② 扫描并连接」内部也会先调一次 |
| 调用链 | `session.js:ble()` 拿单例 → `TeslaBle.init()` |
| 用到接口 | `uni.openBluetoothAdapter({mode:'central'})`（失败时降级再试一次 `{}`）、`uni.getBluetoothAdapterState()` |
| 实现方式 | `api(name, opts)` 这个包装函数把 uni 的回调式 API 转 Promise，并在 `typeof uni[name] !== 'function'` 时抛「只能在 App 真机上运行」，用于识别 H5/小程序环境 |
| 成功标志 | `蓝牙适配器已开启 available=true discovering=false` |
| 失败判读 | 弹窗 `打包时未添加bluetooth模块` → 跑在标准基座上；`蓝牙不可用` → 系统蓝牙没开 |

### F4 VIN → 广播名（识别自己的车）

| 项 | 内容 |
| --- | --- |
| UI 入口 | ① 页 VIN 输入框（`@blur="saveVin"`，落盘 `tesla_probe_vin_v1`） |
| 调用链 | `session.js:namesForVin(vin)` → `vcsec.js:bleNamesForVin(vin)` → `bytes.js:utf8ToBytes/toHex` + `sha1.js:sha1` |
| 用到接口 | 无（纯 JS） |
| 实现方式 | 返回 `{exact:[], prefixes:[]}` 两组：<br>`exact` = `Tesla ` + **VIN 后 6 位**（2023-06-21 起的新命名，只需后 6 位）<br>`prefixes` = `S` + `SHA1(完整 VIN 的 UTF-8)` 的十六进制**前 16 位**（老命名，末位 C/R/D/P 未知 → 只能做前缀匹配，**必须完整 VIN**） |
| 已核对样例 | VIN `LRWYGCEJ0TC723591` → `Tesla 723591` / `S4adfe3eacbdb58b7`（与 App 日志输出一致，`node crypto` 独立复算过） |
| 失败判读 | 只填后 6 位时老命名规则失效（`prefixes` 为空，只剩 `Tesla ` + 后 6 位这一条精确名）；VIN 完全留空时自动路径直接抛 `请先填写 VIN…`，此时走 F5.1 手选 |
| **规则失效的情形** | 车辆蓝牙名在车机里改过（如 `Tesla Model Y 小米YU7`）、或手机系统里已配对并被缓存成新名字 → **按 VIN 算出来的名字根本匹配不上**。这不是 bug，是命名规则本身被人为改掉了；对策见 F5.1 的手选弹窗 |

### F5 BLE 扫描并命中目标车辆

| 项 | 内容 |
| --- | --- |
| UI 入口 | 「② 扫描并连接（手选）」（`step2` → 打开弹窗 → `rescan` / `pick` / `autoConnect`）；「列出周围广播」（`allAdvs` → `scanAll`） |
| 调用链 | 自动路径：`index.vue:autoConnect` → `session.js:connectTo(vin)` → `TeslaBle.scan(names, 20000)`（命中即停）<br>手选路径：`index.vue:rescan` → `TeslaBle.discover(12000, names, onFound)`（全量收集）→ `index.vue:pick(d)` → `session.js:connectTo(vin, d)`（**跳过名字匹配，直连指定设备**） |
| 用到接口 | `uni.onBluetoothDeviceFound(cb)`、`uni.startBluetoothDevicesDiscovery({allowDuplicatesKey:false, powerLevel:'high', interval:0})`、`uni.stopBluetoothDevicesDiscovery()`、`uni.offBluetoothDeviceFound()`（老版本无此 API，已 try/catch） |
| 实现方式 | 匹配逻辑抽成 `tesla-ble.js:makeMatcher(names)`（可离线断言），四级：<br>1) `exact` 精确等值；2) `prefixes` 前缀；3) `normName()`（去掉所有非字母数字并转大写）后的等值，吸收 `Tesla 723591` / `Tesla_723591` / `tesla723591`；<br>4) 归一化后的前缀（`s4-adfe3eacbdb58b7-extra` 这类带后缀的老命名）；<br>另有一条独立旁证：广播**无名字**但 `advertisServiceUUIDs` 里带 `0211`（VCSEC 服务）→ 认作疑似车辆（`hasTeslaService`）；<br>名字含 `TESLA` 但没命中期望名 → 单独打 `warn` 把**真实广播名 + rssi** 打出来 |
| 成功标志 | `发现车辆 name=... (exact/prefix/loose/loose-prefix 命中 X) id=...` |
| 失败判读 | `扫描 20000ms 未发现目标车辆` → 车没在广播（人不在车边 / 车机蓝牙被关闭 / 车辆深度睡眠导致广播间隔很长）或**名字被改过**。后者用 F5.1 手选 |
| 排查按钮 | 「列出周围广播」用 `scanAll(10000)` 只收集不匹配，输出 `名字 + deviceId`（无名设备用 `(无名) + deviceId 后 8 位`，不折叠），并对期望名标 `★命中` |

### F5.1 广播手选弹窗（车辆蓝牙名被改过时唯一能走通的路）

| 项 | 内容 |
| --- | --- |
| UI 入口 | 「② 扫描并连接（手选）」→ 全屏弹层「选择要连接的设备」 |
| 调用链 | `index.vue:step2` → `picker=true` → `rescan()` → `TeslaBle.discover(SCAN_MS=12000, namesForVin(vin), onFound)` → 点某一条 → `pick(d)` → `connect(d)` → `session.js:connectTo(vin, d)` |
| 用到接口 | 同 F5（不新增 uni API）；`discover` 内部仍是 `onBluetoothDeviceFound` + `startBluetoothDevicesDiscovery` |
| 实现方式 | `discover()` 与 `scan()` 的**唯一区别是不做「命中即停」**：把 12 秒窗口里看到的每个 `deviceId` 聚合进 `Map`（`name` 取最新非空、`rssi` 取最新、`tesla`/`hit` 一旦为真就保留），每来一批广播就 `onFound(排序后的快照)` 回调 → **列表边扫边长，不用等超时**。排序由 `tesla-ble.js:sortAdv()` 决定 |
| 排序规则 | 命中 VIN(0) → 广播了 `0211`(1) → 有名字(2) → 无名(3)；同一档内按 RSSI 越接近 0 越靠前；缺 RSSI 当最弱处理。原数组不被修改 |
| 每条显示什么 | 广播名（无名则 `(无名) + deviceId 后 8 位`）、`deviceId`、标签：`命中VIN <mode>` / `0211 服务` / `<rssi>dBm` |
| 现场怎么选 | ① 优先点标了「命中VIN」的；② 没有就点标了「0211 服务」的（那是特斯拉 VCSEC 服务的硬证据，比名字可靠）；③ 两个都没有，就按 dBm 点离你最近的那个，连不上再换下一条 |
| 底部三个按钮 | 「重新扫描」（清空重扫，`scanning` 期间 `loading` 防重点）、「按 VIN 自动连」（回到 F5 的命中即停路径，没改过名的车一键更快）、「关闭」 |
| 守卫 | 还在扫描时点条目 → 弹窗「还在扫描，等一下再点」；上一步未完成（`busy`）→ 弹窗「上一步还没结束」；`connectTo(vin, device)` 只要收到 `device` 参数就**完全跳过 `scan()`**（`session.js:289-300`），因此手选路径下 VIN 留空也能连上；VIN 为空只在自动路径里报错 —— `请先填写 VIN（需要后 6 位才能匹配广播名），或在扫描列表里手选设备` |
| 一个诚实的提醒 | 手选解决的是「**匹配不上名字**」。若日志显示已经 `发现车辆 … connecting` 之后才 `disconnected` / `getBLEDeviceServices:fail no connection`，那失败点在**连接层之后**，与名字无关——按 §8.5（3 台钥匙上限、官方 App 抢连接）和 F6 的失败判读（车机休眠 / 距离）排查 |

### F6 GATT 连接 + 停扫 + 断连监听

| 项 | 内容 |
| --- | --- |
| 调用链 | `TeslaBle.connect(device)` |
| 用到接口 | `uni.createBLEConnection({deviceId})`、`uni.stopBluetoothDevicesDiscovery()`、`uni.onBLEConnectionStateChange(cb)` |
| 实现方式 | 三条来自实测经验的硬规则写死在 `tesla-ble.js` 头注释：<br>**A** 连上立刻停扫（Android 边扫边连会掉包/断连）；**B** 所有 write 排队串行，绝不在 BLE 回调里再 write；**C** 一次 ATT 通知只装一个 PDU，必须抬 MTU 否则 65B 响应收不全。<br>连上后 `delay(600)` 再枚举服务（Android 需要时间），然后依次 `_negotiateMtu → _discover → _subscribe` |
| 成功标志 | 状态机 `connecting → connected`（页顶 `BLE=connected`） |
| 失败判读 | `连接已断开（车辆 3 台钥匙上限 / 车机休眠 / 距离都可能是原因）`；`没找到特斯拉 VCSEC 服务 0211，实际服务: ...`（会把真实服务 UUID 全列出来） |

### F7 MTU 协商

| 项 | 内容 |
| --- | --- |
| 调用链 | `TeslaBle._negotiateMtu()` |
| 用到接口 | `uni.setBLEMTU({deviceId, mtu})`（**只有 Android 有**，iOS 系统自动协商） |
| 实现方式 | 从大到小依次试 `247 → 185 → 128 → 64`，任一成功即记 `this.mtu` 并返回；全部失败只 warn，不抛（保证小包查询仍能跑） |
| 成功标志 | `MTU 协商成功 = 247` |
| 失败判读 | `按 MTU=23 工作；超过 20 字节的响应可能被截断` → 后续 RKE 会出现 `FAULT_SIGNATURE_TOO_SHORT`，临时公钥协商必然失败。属 **Q2 风险点**，见 §9 |

### F8 服务/特征发现

| 项 | 内容 |
| --- | --- |
| 调用链 | `TeslaBle._discover()` → `vcsec.js:GATT` + `tesla-ble.js:matchUuid` |
| 用到接口 | `uni.getBLEDeviceServices({deviceId})`、`uni.getBLEDeviceCharacteristics({deviceId, serviceId})` |
| 实现方式 | `matchUuid` 同时接受 16 bit 短 UUID（`0211`）与 128 bit 长 UUID、大小写混排，靠「短的是长的前缀」判定 |
| GATT 表 | Service `00000211-b2d1-43f0-9b88-960cebf8b91e`；写 `0212`；INDICATE `0213`；READ `0214`（版本） |
| 成功标志 | `服务 0211 已就绪 write=0212 indicate=0213 read=0214` |
| 失败判读 | `0212/0213 特征不全，无法收发 VCSEC 报文` |

### F9 订阅 0213（INDICATE）+ 收帧重组 —— **Q1 关键点**

| 项 | 内容 |
| --- | --- |
| 调用链 | `TeslaBle._subscribe()` → `uni.onBLECharacteristicValueChange` → `_onChunk` → `_deliver` |
| 用到接口 | `uni.notifyBLECharacteristicValueChange({deviceId, serviceId, characteristicId, state:true})`、`uni.onBLECharacteristicValueChange(cb)` |
| 实现方式 | uni 只能表达「开/关通知」，**无法手写 CCC 描述符**（0x2901 notify / 0x2902 indicate）。特斯拉用的是 **indicate**。收到 chunk 后先拼进 `_rx`，再按 **2 字节大端长度前缀**循环切帧：`declared = rx[0]<<8 | rx[1]`，不够就等下一个分包（日志 `等待后续分包`），够了就 `stripLength()` 校验长度并交给等待队列 |
| 成功标志 | `已订阅 0213（INDICATE）`，且后续任何请求都有响应 |
| 失败判读 | `关键阻塞：运行时未能开启 0213 的通知` → **这是 uni 的能力边界，不是协议问题**。所有请求会表现为 `等待车辆响应超时` |
| 归零策略 | 每次 `send()` 前把 `_rx` 清空，保证「一问一答」对齐；多余字节按 `无人等待的响应（车辆主动上报？）` 打印 |

### F10 发送一帧（串行写 + 超时）

| 项 | 内容 |
| --- | --- |
| 调用链 | `v3actions.js:sendRequest → ble().send(frame, ms, keepQueue)` → `TeslaBle._writeChunked` |
| 用到接口 | `uni.writeBLECharacteristicValue({deviceId, serviceId, characteristicId, value:ArrayBuffer})` |
| 实现方式 | `bytesToAb()` 复制一份 `Uint8Array` 再取 `.buffer`（避免 buffer 视图共享导致长度异常）；写队列 `this._tx = this._tx.then(...)` 保证串行；每片写完 `delay(20)` 给车机处理时间；响应通过 `_waitForFrame()` 的 FIFO 等待队列返回 |
| 长度处理 | **按官方规则真分包**：`cap = mtu - 3`，帧长超过就循环 `writeBLECharacteristicValue` 逐片写，车端靠 2 字节长度前缀重组（官方 `connector/ble/ble.go` 的 `blockLength = min(ExchangeMTU, 1024) - 3` 就是这么做的）。日志 `帧长 N > MTU 可用 M，按官方规则分成 K 片写` 是 **info 级正常行为**。早期注释「特斯拉不接受分包写」是错的，已推翻 |
| 成功标志 | 日志 `发送 N 字节: <hex>` 后紧跟 `响应 M 字节: <hex>` |
| 失败判读 | `等待车辆响应超时 Xms（可能没订阅成功 / 车辆休眠 / MTU 不足）`；**写本身失败会如实抛 `BLE 写失败：第 i/K 片（…）写入失败：<errMsg> errCode=<n>`**（早期实现的 `.catch(() => {})` 会把真实写错误吞成误导性的「响应超时」，已修并有回归锁） |
| 原始帧旁路 | 每次收发都同时喂给 `onRaw` → `session.js:connection.raw`（保留最近 200 条）→ ③ 报文控制台页显示 `→车 / ←车` |

### F11 绑定车辆（加白名单，需刷 NFC 钥匙卡）

| 项 | 内容 |
| --- | --- |
| UI 入口 | ① 页「③ 绑定（刷钥匙卡）」（`step3`）+ 同页的「钥匙类型」四选一 + 「④ 探针确认」（`stepProbe`） |
| 调用链 | `api.js:bindKey(vin, {formFactor})` → `v3actions.js:bindKey(vin, opts)` 三段状态机：<br>**阶段 0** `probeOnce(vin)`（预探针，见下）→ **阶段 1** `session.js:ensureKey(vin)` → `v3vcsec.js:buildAddKeyEnvelope(publicKey, ROLE_DRIVER, formFactor)` → `ble().send(prependLength(frame), 8000, keepQueue=true)` → **阶段 2** `for(;;)` 交替「`ble().receive(2500)` 收车端回执」与「每 5 秒 `probeOnce` 打一针会话」，谁先出结果谁定论，整个窗口 `PAIR_WINDOW_MS`=150 秒 |
| 用到接口 | F10 的 `writeBLECharacteristicValue` + F9 的 indicate；无新增 |
| 纯 JS 实现 | `session.ensureKey` → `vcsec.newKeyPair()` → `p256.normalizePrivateKey(randomBytes(32))` + `p256.publicKeyFromPrivate()`（65 字节未压缩点 `04‖X‖Y`）；`keyIdOf(pub) = SHA1(pub)[:4]`；落盘 `uni.setStorageSync('tesla_probe_key_v1', {priv, pub, vin})` |
| 协议报文 | `ToVCSECMessage{ signedMessage{ protobufMessageAsBytes = UnsignedMessage{ WhitelistOperation{ addKeyToWhitelistAndAddPermissions(5){ key{PublicKeyRaw=65B}, keyRole = ROLE_DRIVER(3) }, metadataForKey{keyFormFactor=KEY_FORM_FACTOR_ANDROID_DEVICE(7)} }, signatureType = SIGNATURE_TYPE_PRESENT_KEY(2) } }`<br>**这是全套里唯一不走 `RoutableMessage` 的报文**：此刻还没有会话，官方 `security.go:338 SendAddKeyRequestWithRole` 发的就是这个裸信封，首字节 `0x0a`。<br>**内层是明文，不加密**，授权靠「刷钥匙卡」这个物理事件。<br>现行 `vcsec.proto` 里 `PermissionChange` 只剩 `key / secondsToBeActive / keyRole`，**老版的 `repeated permission` 数组已经没有了**，权限改由 `keyRole` 表达 |
| 实际字节样本 | 真机日志（65 字节公钥省略中段）：`0056 0a54 1250 82014d 2a47 0a43 0a41 04e4f5f4d0a456177c…2378c413 2003 3202 0807 1802`。逐段：`0056`=2 字节大端长度前缀（86）→ `0a54`=signedMessage → `1250`=protobufMessageAsBytes → `82 01 4d`=字段16 WhitelistOperation → `2a 47`=字段5 addKeyToWhitelistAndAddPermissions → `0a43 0a41`=key.PublicKeyRaw → `20 03`=**keyRole=ROLE_DRIVER(3)** → `32 02 08 07`=metadataForKey.keyFormFactor=7 → `18 02`=signatureType=PRESENT_KEY |
| 车端时序 | 三个参考实现对「什么时候算绑完」说法不一致，取证如下（优先级：官方 > 0Bu > esphome）：<br>① 官方 `pkg/vehicle/security.go:314-338` 的 `SendAddKeyRequestWithRole` **发完就 return，连回执都不读**（注释原文：*returns nil as soon as the request is transmitted. A nil return value does not guarantee the user has approved*）。<br>② 官方 `pkg/protocol/protocol.md:824` 说车端会先回 `OPERATIONSTATUS_WAIT`（等刷卡），`:836` 说一条消息**只有带上 `commandStatus.whitelistOperationStatus` 才算终态**。<br>③ 0Bu `main/vehicle_pairing.cpp:246` 的量产实测结论：车机在屏幕上加白之后**并不发**那条 completing `commandStatus`，它把 whitelist-add 的完成超时标成 `ExpectedSilent`，改靠「事后能不能用这把钥匙建会话」判定。<br>**所以本端两条判据同时跑、谁先来算谁**：一边 `receive` 收车端回执（2.5 秒一片），一边发完 8 秒后每 5 秒打一次 `probeOnce` 会话探针。拿到 `whitelistOperationStatus` 就以它为准（那是车辆自己给的确切答案），否则探针命中即判成功。看到 `WAIT` 只提示一次、**绝不重发 add-key**（重发会让车辆重新起一遍配对流程，0Bu 的记录是这会导致车机反复弹配对请求） |
| 探针判据 | `probeOnce(vin)` = 直接跑一次 `handshakeOnce`，把它的返回值当「问句」用：车辆回 `SessionInfo.status = OK(0)` → 钥匙已在白名单；回 `KEY_NOT_ON_WHITELIST(1)` → 还没加上。这与官方 `security.go:324` 的注释（*Clients can check if publicKey has been enrolled … by attempting to call v.SessionInfo*）和 `dispatcher.go:464 SessionInfoRequest` + `AuthMethodNone`（**不带签名的 session_info_request**）的发包形状一致。<br>**探针打在 VCSEC 域而不是官方举例的 INFOTAINMENT 域**，理由：① VCSEC 才是解锁要用的域，「能建 VCSEC 会话」才是我们要的强判据；② esphome-tesla-ble 的 `AGENTS.md` 写明「VCSEC is always safe to poll」（低功耗控制器，不会唤醒车机），而 INFOTAINMENT 探针在车休眠时会干扰休眠。本机实测车辆拒绝建会话时回的 `session_info = 28 01` 也正是 VCSEC 域。<br>阶段 0 先打一针：**已经绑好了就直接返回 `already:true`，一个 add-key 都不发** |
| 钥匙类型（formFactor） | 官方 `cmd/tesla-control/commands.go:356-409` 把 `FORM_FACTOR` 做成 `add-key` 的**必填位置参数**（`nfc_card / ios_device / android_device / cloud_key`），`vcsec.go:151 addKeyPayload` 只是原样塞进 `KeyMetadata.keyFormFactor` —— **官方没有默认值**。三个参考实现取值不同（0Bu 生产固件 = `CLOUD_KEY`，它 vendor 的 tesla-ble C++ 库 `src/vehicle.cpp` 的 `Vehicle::pair` = `NFC_CARD`），属**产品选择差异、不是协议分歧**。按「不许因为别的项目不同就改协议」的规则：默认保持 `ANDROID_DEVICE(7)`（我们确实是手机），同时把这四个枚举值全开给现场 A/B（① 页「钥匙类型」条）。它只影响车机把新钥匙归到哪一类，**不影响任何协议字段的编码方式** |
| BLE 连接数上限 | 一辆车同时最多约 **3 个并发 BLE 连接**（官方 Tesla App、手机钥匙、遥控钥匙共享）。挤满时 add-key 会静默无响应，`bindKey` 的发送失败文案里直接写了这条。**现场测试前务必退出并杀掉官方 Tesla App 后台** |
| 刷卡位置 | 以 Tesla 官方支持页（`tesla.com/support/tesla-vehicle-keys`，Add Key 流程）为准：**Model 3 / Model Y：中控台杯架后方**；**Model S / Model X / Cybertruck：左侧无线充电板顶部，卡片正面朝下往下刷**。旧文档里的「驾驶侧 B 柱」是更早期 Model S/X 的位置，已不作准。<br>**注意：车机屏幕通常不会主动弹窗**——官方 App 配手机钥匙时提示语出现在**手机 App 里**，车机上的确认页要等**刷过一张有效实体卡之后**才出现。「屏幕没弹窗」的正确解读是**卡没被读到**，不是请求没送到 |
| 必须用实体卡 | 官方 `security.go:314` 原文：*The user must approve the request by tapping their NFC card on the center console and then confirming their intent on the vehicle UI.* 车主手册进一步写明：钥匙卡的作用就是「**authenticate** 手机」以及增删其它钥匙卡 / 手机 / 钥匙扣。签署方 `signerOfOperation` 是一张已在白名单的实体钥匙，**手机 NFC 替代不了**（见 F11「能不能跳过」行） |
| 成功标志 | 两种都算成功，日志会写明判据来源：<br>① 探针命中 —— `绑定成功 —— 探针第 N 次确认：会话已建立…`，并附 `本机 Tesla key id = XX:XX:XX:XX`；<br>② 车端给了终态 —— `车辆回执已加入白名单（WHITELISTOPERATION_INFORMATION_OK(0)）` + 随后那一针的会话结果。<br>「④ 探针确认」按钮（`probeSession()` → `probeEnrollment({force:true})`）任何时候都能单独按一次，回答「这把钥匙到底进没进白名单」。<br>**现场认钥匙**：车机 控制 > 安全 > 钥匙 里新登记的一律显示 `Unknown key`，用日志打出的 `Tesla key id`（`SHA1(65B 公钥)` 前 4 字节、冒号大写 hex，与 0Bu `vehicle_pairing.cpp:809-866` 同源）比对；「查白名单」回的 4 字节 keyId 也已按前缀归一，显示成同一个值 |
| 失败判读 | 车端给了明确回执时，日志会直接打出 `车辆回执：WHITELISTOPERATION_INFORMATION_…(N)` + 一句中文处置建议（`v3actions.js:PAIR_HINTS`）。最常见：`NOT_ALLOWED_TO_ADD_UNLESS_ON_READER(14)` = **卡没贴到位/没在屏幕上确认**；`KEYFOB_SLOTS_FULL(3)` / `WHITELIST_FULL(4)` → 车机设置里删一把旧钥匙；`INVALID_PUBLIC_KEY(6)` → 公钥不是 65 字节 `04…`。<br>窗口等满仍判「没绑上」时，返回文案是固定的**四项排查**（车机有没有弹配对页 / 实体卡刷卡位置与屏幕确认 / BLE 连接数被官方 App 占满 / 车辆休眠要先踩刹车），并打印最后一次探针的结果。**注意：`wait:true` 不等于协议错**，它只说明这一轮没拿到任何一侧的确认 |
| 能不能跳过 | **不能。** 协议里没有任何「设备身份」，车辆只认公钥；官方 App 的私钥受 Android 沙箱保护读不到。加新钥匙本身还需要一次授权动作（刷卡 = `PRESENT_KEY`），另一条「用已在白名单的私钥签名」正好依赖那把拿不到的私钥。<br>**这是车辆侧的信任模型，不是 uni-app 的能力边界**：换 Kotlin / Swift / Flutter / 树莓派 + BlueZ 写的客户端同样必须刷实体卡。用手机 NFC 顶替也不行——读卡区是 **RFID 读卡器**，只认 Tesla 钥匙卡里的安全元件；Android HCE 只能模拟 ISO-DEP/Nfc-A 卡，既没有 Tesla 的凭据也过不了挑战应答，而且 uni-app 根本没有 HCE/卡模拟 API（`uni-NFC` 只有读卡方向） |

### F12 V3 握手（`session_info_request` ↔ `session_info`）

| 项 | 内容 |
| --- | --- |
| UI 入口 | ② 页「重新握手」（`handshake(true)` 强制重来）；任何加密指令前都会先自动 `handshake(false)`，会话可用就直接复用 |
| 调用链 | `api.js:handshake(force)` → `v3actions.js:handshake` → `handshakeOnce` → `v3vcsec.js:buildSessionInfoRequest(DOMAIN_VEHICLE_SECURITY, publicKey, uuid, routingAddress)` → `ble().send()` → `parseFrame` → `applySessionInfo` → `session.js:storeV3Session()` |
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
| 调用链 | `api.js:sendRke(action, name)` → `v3actions.js:sendRke` → `sendRequest` →（缺会话时自动 `handshake(false)`）→ `v3vcsec.js:encryptCommand` → `ble().send(frame, ms, keepQueue=true)` → `decryptResponse` |
| 用到接口 | 同 F10/F9 |
| 纯 JS 实现 | `aes.aes128GcmEncrypt(key16, nonce, plaintext, aad)`；自研 CTR+GHASH 路径已与 Node `createCipheriv('aes-128-gcm')` 双向对拍。**V3 的 nonce 是 `randomBytes(12)`**（`gcm.NonceSize()`），不再是旧版那种「counter 转 4 字节当 IV」 |
| 协议报文 | 内层 `UnsignedMessage{ RKEAction: action }` → 加密成 `SignedMessage{ protobufMessageAsBytes = 密文, signature = GCM tag }` → 外层 `RoutableMessage{ to_destination{domain=VCSEC}, signedMessage{ signature_data{ signer_identity{public_key=65B}, AES_GCM_Personalized_data{epoch, nonce, counter, expires_at, tag} }, payload_format = AES_GCM_PERSONALIZED } }`。<br>**身份靠公钥本身，不再有 4 字节 `key_id`**。<br>AAD = `SHA256(TLV 元数据 ‖ 0xFF)`，元数据顺序固定为 `sigtype → domain → VIN → epoch → expires_at → counter → flags(仅 >0 才写)`。<br>**proto3 坑**：`UNLOCK(0)` 的 `RKEAction` 是默认值 → 内层编码为**空字节串**；`LOCK(1)` 内层 = `10 01` |
| 动作编号 | 官方现行 `RKEAction_E` 只剩 `UNLOCK(0) / LOCK(1) / REMOTE_DRIVE(20) / AUTO_SECURE_VEHICLE(29) / WAKE_VEHICLE(30)`。**后备箱、前备箱、充电口已经不是 RKE 动作**，页面上那几个按钮在 V3 下走 `sendClosure` → `ClosureMoveRequest{frontTrunk/rearTrunk/chargePort: MOVE(1)/OPEN(3)/CLOSE(4)}`，编号只是沿用旧版叫法；点自定义值时会提示「官方现行 RKEAction_E 里没有这个值」 |
| counter 规则 | 每次组包 `counter = session.counter + 1`；**`0xFFFFFFFF` 是官方保留的 `counterMax` 哨兵（`crypto.go:18`），永远不能发出去**，最后一个可用值是 `0xFFFFFFFE`，越界直接抛错要求重新绑定。官方 `signer.go` 先 `s.counter++` 再组包、**发送失败也不回滚**；本实现等价：整帧组好才写回 `session.counter`，组包途中抛错等于这号没发出去 |
| 响应侧 | 置了 `FLAG_ENCRYPT_RESPONSE` 时车辆回 `AES_GCM_Response_data`；`decryptResponse` 用 `responseMetadata`（`sigtype=9 → domain → VIN → counter → flags(恒含) → request_hash → fault`）重算 AAD 验 tag。`request_hash = sigtype 单字节 ‖ 请求的 tag`（VCSEC 域若为 HMAC 则截到 16 字节），**不是**对请求帧再哈希 |
| 成功标志 | `status=OPERATIONSTATUS_OK` **且车真的响**（这一档才算端到端成立） |
| 失败判读 | GCM tag 校验失败 → 会话密钥 / 元数据顺序 / VIN 大小写任一处不符，或车辆已轮换会话；`SignedMessage_information_E`（§7.2）；`MessageFault_E` 非 0 会直接打出名称（③ 页可对照）；握手被拒 `KEY_NOT_ON_WHITELIST` → 白名单里没这把 keyId，回 F11 |

### F14 无签名只读查询（绑定前就能发）

| 项 | 内容 |
| --- | --- |
| UI 入口 | ② 页「查车辆状态」；① 页「查白名单」「读 0214 版本」 |
| 调用链 | `api.js:queries.{status, whitelist}` → `v3actions.js:infoRequest(type, name, timeoutMs, slot)` → `sendRequest({plain:true})` → `v3vcsec.js:buildPlainRequest`；版本读取走 `TeslaBle.readVersion()` |
| 用到接口 | 前几项 = `writeBLECharacteristicValue` + indicate；读版本 = **`uni.readBLECharacteristicValue({deviceId, serviceId, characteristicId})`** |
| 实现方式 | 明文 `RoutableMessage{ to_destination{domain=VCSEC}, request_uuid, unsignedMessage{InformationRequest{…}} }`，**不需要会话、不需要签名**。所以「连接 → 读版本 → 查白名单」这条链**不刷卡、不占槽**，是现场最便宜的一次通路自检（= §1 的 ② 档） |
| 请求类型 | 官方现行 `vcsec.proto` 只剩 `GET_STATUS(0)`、`GET_WHITELIST_INFO(5)`、`GET_WHITELIST_ENTRY_INFO(9)`。`GET_EPHEMERAL_PUBLIC_KEY(3)` / `GET_VEHICLE_INFO(7)` / `GET_KEYSTATUS_INFO(8)` / `GET_CAPABILITIES(16)` 已删除，页面上也不再给按钮 |
| 实测字节 | `GET_WHITELIST_INFO`（本机真机日志，54 字节）：`0034 32020802 121210f4a7f03ef694e0ce3a4b16b56797bb0d 5204 0a02 0805 9a03101c8ba87857bc73d54661cb42f0f56b05a00302`。逐段：`0034`=长度前缀(52) → `32 02 08 02`=to_destination.domain=DOMAIN_VEHICLE_SECURITY(2) → `12 12 10 <16B>`=request_uuid → `52 04 0a 02 08 05`=unsignedMessage.InformationRequest.type=5 → 尾部 `9a 03 …` 是 BLE 层附加的链路标识，不是协议字段 |
| 白名单回包 | 这台车实测回 **4 字节 keyId**（`GET_WHITELIST_INFO` 里是 `whitelistEntryInformation` 列表），而 ③ 页/`checkWhitelisted` 早期按「完整公钥 SHA1」比对，永远比不中。现在 `keyIdMatches(entry, full)` 做**前缀归一**（`full.indexOf(e) === 0`），4 字节和 20 字节两种回包都认 |
| 关键改动 | `checkWhitelisted()` **无 `mustKey()` 守卫**，绑定前可查；本机 keyId 是否在内按 `hasKey()` 分支显示 |
| 成功标志 | `白名单 N 条 [keyId...]`；`通信协议版本 = <hex>`；`锁状态=VEHICLELOCKSTATE_UNLOCKED/LOCKED` |
| 失败判读 | 无响应 = 通路问题（回查 F9/F7）；有响应但 `summary.kind=other` = 字段号/枚举与该车固件不符（用 ③ 页对照规格）；`白名单里没有本机 keyId` = 绑定没落库，回 F11 重刷 |

### F15 密钥与 counter 持久化 / 换钥 / 清除

| 项 | 内容 |
| --- | --- |
| UI 入口 | ① 页「换新密钥对」「清除本机密钥」「断开连接」 |
| 调用链 | `session.js:saveKeyPair / loadKey / forgetKey / ensureKey / storeV3Session / invalidateV3Session / resetV3Session`；`disconnectAll()` → `TeslaBle.close()` |
| 用到接口 | `uni.setStorageSync / uni.getStorageSync`；`uni.closeBLEConnection` + `uni.closeBluetoothAdapter` |
| 存储键 | `tesla_probe_key_v1`（`{priv, pub, vin}` hex）、`tesla_probe_v3_session_v1`（`{counter, epoch, vehiclePublicKey, clock_time, set_time, anchor, ready}`，**唯独不含 16 字节会话密钥**）、`tesla_probe_vin_v1`（VIN） |
| 实现方式 | `App.vue:onLaunch → loadKey()` 启动回填，重开 App 不用重新生成密钥；`ensureKey` 幂等；私钥**明文存沙箱**（探针专用，产品必须进 Android Keystore）。`invalidateV3Session(why)` 只作废会话密钥与 `ready`，**counter / epoch 一律保留**；`resetV3Session()` 才归零 |
| counter 语义 | V3 的 counter 是**签名序号**，车辆侧记着上一把钥匙用到哪一号，回退一次就永久失效（对齐 `signer.go`）。所以任何「重连 / 握手失败 / 换网络」都**绝不把 counter 调小**，握手时只会 `max(本机, 车辆回传)` 往上并 |
| 风险 | 「清除本机密钥」会把密钥与 counter 一起清 0 → **车辆侧那把钥匙仍在白名单里但计数器记忆已丢**，重绑前别乱点；「换新密钥对」= 换了一把全新 key，旧计数作废是安全的，counter 归零没问题 |

### F16 亮屏保活

| 项 | 内容 |
| --- | --- |
| 调用链 | `App.vue:onLaunch` → `tesla-ble.js:keepScreenOn(true)` |
| 用到接口 | `uni.setKeepScreenOn({keepScreenOn:true})`（需 `WAKE_LOCK`，manifest 已声明） |
| 为什么 | 绑定要等 60 秒刷卡，锁屏/息屏会让整轮作废；车库里这一点比什么都值钱 |
| 局限 | 只防息屏，**不防用户主动回桌面 / 系统杀后台**。测第 ③ 步期间不要切走 App |

### F17 报文控制台（排障 + 手工发任意字节）

| 项 | 内容 |
| --- | --- |
| UI 入口 | ③ 页（`→ 报文控制台`）：原始帧列表 / JSON 手工组包（预设 `绑定样例 / 握手样例 / RKE 样例`）/ 裸 hex 发送 / 按消息名解析 / Message + Enum 规格速查 |
| 调用链 | `debug.vue:buildFromJson → api.toolkit().encode(SPEC,'RoutableMessage',obj) → prependLength → ble().send(frame,8000)`；`normalizeHex → parseFrame → decode / inspect` |
| 用到接口 | 复用 F10/F9（不新增）；页面跳转 `uni.navigateTo` |
| 实现方式 | 页面**只 import `common/api.js`** 的 `toolkit()`，一次拿到 `SPEC` 表、根消息名（`RoutableMessage`）、`encode/decode/inspect/label/prependLength/parseFrame/summarize/summarizeVcsec`。`bytes` 字段在 JSON 里直接写 hex 字符串即可；`只编码不发送` 用于**把完整 hex 抄到 nRF Connect 做 A/B 对照**（§9）；`inspect()` 输出带字段名的结构化文本，用来肉眼核对字段号 |
| 规格表 | 根是 `RoutableMessage`，但 `ToVCSECMessage` 仍留在表里 —— 绑定帧（F11）走的就是它，③ 页要能手工组和解析 |
| 注意 | `rke` 预设里的 `signature_data` 需要你自己按会话密钥 + counter 算 GCM，所以它**只能观察报文结构**，真发 RKE 请用 ② 页按钮 |
| 价值 | 这是「协议问题」与「uni 问题」的分诊台：同一段 hex 用 nRF Connect 手发能成 → 问题在 uni；手发也不成 → 问题在报文 |

### F18 V3 请求编排（重发、路由地址、WAIT）

| 项 | 内容 |
| --- | --- |
| 调用链 | `v3actions.js:sendRequest(opts)`（除绑定外所有 V3 动作的公共出口） |
| 实现方式 | `routingAddress` 与 `uuid` 在 **attempt 循环之外**生成一次、整条请求连同重发全程复用（VCSEC 域的响应**只按 `routing_address` 配对**，`dispatcher.go:400-407`，换号会让响应掉进没人领的收件箱）；每次 attempt 重新调 `encryptCommand` → counter 前进、nonce 重取。`flags = 1 << FLAG_ENCRYPT_RESPONSE`（对齐 `vehicle.go`）。BLE 侧用 `ble().send(frame, ms, keepQueue=true)` —— 收帧期间车辆可能又推进来一帧，清队列会把终态丢掉 |
| 重发条件 | 车辆回 `WAIT` 按官方 `vcsec.go` 视为 `ErrBusy` → **整条重发**（不是继续读下一帧）；组包失败且还有额度 → 作废会话后重新握手再发；总时长受 `maxMs` 截止时间约束 |
| 终态判据 | RKE / 闭锁器：收到一条**没有 `commandStatus`** 的报文才算完（`executeRKEAction`）；白名单操作：**必须带 `whitelistOperationStatus`** 才是终态（`isWhitelistOperationComplete`） |
| 顺手刷新 | 响应里搭车的 `session_info` 要过「本机已有共享密钥 / 距请求发出未超时 / 带 tag」三道闸才采纳（`dispatcher.go checkForSessionUpdate`） |
| 传输层配套 | `tesla-ble.js` 为「一次请求多帧响应」加了暂存队列：`keepQueue=true` 时不清 `_queue`，`receive()` 优先取暂存帧；一次 indicate 里粘两帧会被 `parseFrame` 拆开分别入队 |
| 价值 | 官方客户端本身就靠重发 + 路由地址配对活着，一次性发送等回复的写法在新款车上极易误判为「协议不通」 |

### F19 日志窗口（清空 / 复制 / 动作分段）

| 项 | 内容 |
| --- | --- |
| UI 入口 | 每个页面底部的「日志」卡片（`components/log-box/log-box.vue`），右上角控件：`共 N 条` / `清空` / `复制` / `自动滚底:开·关` |
| 调用链 | `log-box.vue:copy() → notify.js:copyText(全文) → uni.setClipboardData` → 成功后 `session.js:log('ok', '已复制 N 条日志到剪贴板…')`（**不再用 toast 反馈**，直接写进日志自身）；`clear() → session.js:clearLogs()` |
| 实现方式 | 日志源在 `session.js` 的内存数组，`getLogs()/log()` 是唯一入口，页面只是渲染。**每条都带 `mm:ss.ms` 时间戳 + 级别色**（`tx/rx/ok/warn/err`），`复制` 导出的是**未着色的原文**，直接贴给协作者即可，不用截图 |
| 动作分段 | `session.js:beginAction(name)` 在段首插一行 `-----start----- 动作名`，`endAction(result)` 在段尾插 `-----end----- 动作名 | 成功：…` / `失败：…` / `异常：…`。`api.js` 里每个对外动作都包了 `action(name, fn)`，所以**点任何一个按钮产生的日志天然成一段**，段名就是按钮语义（`绑定（刷钥匙卡）`、`查白名单`、`V3 握手`、`RKE 动作`…） |
| 边界规则 | ① 嵌套调用只打**最外层**一对标记（`actionDepth` 计数）；② `action()` 会把返回值里的 `text` 折成一行放进展尾标记，**不截断**（`-----end-----` 常常是唯一带完整失败原因的一行，现场复测要求每条报错都能复制）；③ 动作抛异常照样收尾，`errCode` 一并拼进 `异常：…`；④ `清空` 会重置 `actionDepth`，不会出现「只有 end 没有 start」的孤儿标记 |
| 容量 | 日志环形缓冲 `MAX_LOGS = 1000` 条（一轮完整绑定 = 60 秒等待 + 每帧 hex + 逐帧解码就能产生上百条，400 条会在复测中途滚掉最早的关键日志） |
| 用法 | 复现问题 → 点 `复制` → 直接贴文本。看的时候搜 `-----start-----` 就能跳到对应动作，段内第一条 `tx` 是发出去的字节，最后一条 `-----end-----` 后面跟着结论 |
| 失败判读 | 日志为空 → 弹窗「日志是空的，没什么可复制」；`复制` 没反应 → 弹窗「当前环境不支持剪贴板」（H5 预览下正常，App 基座里应有）；列表恒空 = 组件没订阅到 `session.js` 的日志总线 |

### F20 提示弹窗（notify：关闭 / 复制）

| 项 | 内容 |
| --- | --- |
| 用户输入 | 任何一次操作结果（绑定结论、握手拒绝、未连接、复制结果…） |
| 为什么换掉 toast | `uni.showToast` 的 `title` 在 App 端只画得下一两行，**车辆回执 + 人话解释 + 下一步动作**这种多行提示必然被剪；而且 toast 会自动消失，来不及看也无法选中。原先页面里还普遍写着 `this.toast(r.text.slice(0, 60))`，等于主动把结论砍成 60 字 |
| 实现 | `common/notify.js:notify(text)` → `uni.showModal({ title:'提示', content: preview(全文), showCancel:true, cancelText:'关闭', confirmText:'复制' })`；点 `复制` → `copyText(全文)` → `uni.setClipboardData` |
| 正文规则 | 弹窗里最多显示 `NOTIFY_MAX = 500` 字，超出只留头部并追加 `…（共 N 字，点「复制」取全文）`；**剪贴板里永远是未截断的全文**。调用方一律不许先 `slice` 再传进来 |
| 页面接法 | 三个页面的 `toast()` 方法保留（23 处调用点不动），函数体统一改成 `notify(t)`；`log-box` 的复制成功反馈改写日志行，避免「弹窗上叠弹窗」 |
| 异常兜底 | `index.vue / rke.vue` 的 `guard()` catch 会把**错误原文（含 errCode）直接放进弹窗**「失败：<原文>」，同时写一条 `未捕获错误: …` 日志——不再只说「失败，看日志」；`bindKey / sendRke` 等返回 `{ok:false, text}` 的失败本来就全文进弹窗 |
| 降级 | Node 自检环境没有 `uni`：`notify()` 原样返回全文、`copyText()` 回调 `false`，绝不抛错（否则 `vue-check` / `run.mjs` 会被页面脚本拖死） |
| 回归锁 | `tests/run.mjs` [13] 节：`preview` 截断与提示文案、无 `uni` 降级，外加一条**全仓静态守卫** —— 任何 `.vue/.js` 里再出现 `uni.showToast(` 或 `toast(x.slice(` 直接判 FAIL |
| 已知副作用 | `uni.setClipboardData` 在 App 端会自己弹一条系统级「内容已复制」提示，这是 uni 内部行为、不是本工程的 toast，无法关闭 |

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
| 其它 | `setKeepScreenOn` / `setStorageSync` / `getStorageSync` / `showModal`（提示弹窗，见 F20）/ `setClipboardData`（复制，由 `common/notify.js` 统一封装）/ `navigateTo` | — | 与蓝牙无关的辅助能力；**`showToast` 已全部停用**，正文会被截断且无法复制 |

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
5. 首次进 App 点「① 蓝牙就绪」会弹权限 → **必须选「使用应用期间允许 / 始终允许」**。
6. 每次下车库前：连电脑重新「运行到手机」推一次最新 JS（首页日志里的基座版本号就是给这一步核对用的）。
7. 坐进车里，带一张**实体 NFC 钥匙卡**（第 ③ 步要刷）。

### 现场操作顺序（照抄即可）

```
先做一件事：退出并【杀掉】官方 Tesla App 后台（含三星钱包里的特斯拉钥匙）。
       一辆车同时最多只接受约 3 个 BLE 连接，槽位被占满时配对会【静默失败】——
       不报错、不拒绝，就是你刷十次卡也没反应。
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
② 页  上锁 → 解锁（首次会自动 V3 握手）→ 上锁→解锁 各 3 次
```

**③ 的超时文案不是判决书**：等到点仍没结果时返回 `wait:true` + 四项排查（车机有没有弹配对页 / 实体卡刷卡位置与屏幕确认 / BLE 连接数被官方 App 占满 / 车辆休眠要先踩刹车）。**`wait:true` 不等于协议错**，按上面四项逐项排掉再重刷；判协议对错要看 ④ 探针和「查白名单」。

**绑定没落库时 ② 页必然失败**：握手会被车辆以 `SESSION_INFO_STATUS_KEY_NOT_ON_WHITELIST(1)` 拒绝，日志会直接说是这个原因、并且不白跑重试。看到这条就回 ① 页重刷，别在 ② 页连点。

**VIN 不是必须的**：只有走「按 VIN 自动连」才需要它。车辆的蓝牙名在车机或手机系统里被改过（例：`Tesla Model Y 小米YU7`）时，按 VIN 算出来的广播名一定匹配不上 —— 直接用 ② 的手选列表，见 F5.1。

**「读 0214 / 查白名单」放在绑定前是刻意的**：它俩都是无签名请求，能一次回答 Q1（indicate 到底开没开）和 Q2（MTU 够不够），而**不需要消耗车辆白名单槽位、不需要刷卡**。这两步不通，就别刷卡，直接按 §9 走替代方案。

绑定成功后 App 会自动生成一对 P-256 密钥并保存；重开 App 不用重新生成，但**车辆白名单只加一次**，重启 App 后直接去 ② 页点动作，缺会话会自动握手。

---

## 6. 已验证范围（不需要真机就能确认的部分）

```powershell
cd f:\Desktop\test\tesla-ble-probe
node tests\run.mjs        # 结果: 246 passed, 0 failed
node tests\vue-check.mjs  # 页面脚本自检: 全部通过 (5 个文件)
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
| protobuf | `pb.js:encode / decode / inspect` | 字段号→tag、varint、packed repeated、**proto3 默认值省略**、fixed32（小端）均与参考实现一致 |
| 绑定帧 | `v3vcsec.js:buildAddKeyPayload / buildAddKeyEnvelope` | 内层 `WhitelistOperation{addKey…{key, keyRole}}` + 外层裸 `ToVCSECMessage{signedMessage{signatureType=PRESENT_KEY}}`，首字节 `0x0a`、`PermissionChange` 里**没有** `permission` 数组，与 `security.go:338` 逐字段对齐 |
| V3 帧（官方向量） | `v3vcsec.js:sharedKeyOf / subkey / Metadata / sessionInfoHmac / applySessionInfo / encryptCommand / decryptResponse` | 与 `pkg/protocol/protocol.md` 的样例逐字节对拍：`K = SHA1(ECDH)[:16]`、`SESSION_INFO_KEY = HMAC(K,"session info")`、握手元数据 TLV、握手 HMAC tag、`AAD = SHA256(TLV‖0xFF)`、加密指令密文与 tag、响应解密与 `request_hash` 校验；另含 `counter` 上/下取 max、`epoch` 轮转归零、`0xFFFFFFFF` 哨兵被拒 |
| 绑定状态机 | `v3actions.js:bindKey / probeSession` + `tests/run.mjs [14]` | **离线假车机回归（26 条）**：桩 BLE 替换 `probe.ble`，按包形分辨「握手 = `RoutableMessage{session_info_request}`」与「加白名单 = 裸 `ToVCSECMessage{signedMessage}`」，握手回包现场算 `sessionInfoHmac`。锁死：预探针已命中则**一条 add-key 都不发** / 一轮只发一次 add-key（收到 `OPERATIONSTATUS_WAIT` **绝不重发**）/ 终态回执与会话探针**并行、谁先来算谁** / 探针命中与窗口耗尽两条路径 / 超时返回固定四项排查 / `formFactor` 真的落在 `WhitelistOperation.metadataForKey.keyFormFactor`（页面选的值与默认 `ANDROID_DEVICE` 各证一次）/ `key.PublicKeyRaw` 与 `keyRole=DRIVER` 逐字节正确 / BLE 写失败**立即返回不等窗口**且文案含连接数上限 / 未连接直接抛「还没连上车辆」。时间片（`windowMs` 等）可注入是为了秒级跑完两条路径，**默认值与协议字节零改动** |
| V3 单一入口 | `api.js` 转发 + `session.js` V3 会话 | `api.version()==='v3'`、`toolkit().root==='RoutableMessage'`（同时保留 `ToVCSECMessage` 供绑定帧解析）、枚举转发（`rkeEnum/closureEnum/label`）与页面用的是同一张表；V3 会话 counter **只增不减** |
| 日志分段 | `session.js:beginAction / endAction / action / clearLogs` | 段首 `-----start----- 动作名`、段尾 `-----end----- 动作名 \| 结论`；嵌套只打最外层一对；`text` 折成一行；抛异常照样收尾；`clearLogs()` 重置嵌套计数，不留孤儿 `end`；未连接时动作抛错但分段完整 |
| 广播手选 | `tesla-ble.js:makeMatcher / sortAdv` | 四级匹配各档命中、改过名（`Tesla Model Y 小米YU7`）确实不命中、空名/无期望名不报错；排序按「命中VIN → 0211 → 有名字 → 无名」且同级按 RSSI，且不修改入参数组 |
| 提示弹窗 | `notify.js:notify / copyText / preview` | 正文超 500 字只留头部并提示「点复制取全文」，**剪贴板里永远是未截断全文**；无 `uni` 环境（Node 自检）降级为原样返回 / 回调 `false`，绝不抛错；另有一条**全仓静态守卫**扫描所有 `.vue/.js`，出现 `uni.showToast(` 或 `toast(x.slice(` 即 FAIL |
| 长度前缀 | `vcsec.js / v3vcsec.js:prependLength / stripLength` + `tesla-ble.js:_onChunk` | 2 字节大端前缀 + 粘包/半包重组 |
| 页面脚本 | `tests/vue-check.mjs` | `version` / `index` / `rke` / `debug` 四个页面 + `log-box` 组件 + `App.vue` 的 `<script>` 全部真 import 通过 |

**未验证 = 必须上真机**：车辆固件是否接受这些字节、`0213` 能否在 uni API 下打开 INDICATE、MTU 能否谈成、单帧能否一次写完。

---

## 7. 判读表（真机日志对着这三张表看）

### 7.1 `OperationStatus_E` —— 车辆对某条操作的整体态度

| 值 | 名称 | 含义 / 怎么办 |
| --- | --- | --- |
| 0 | `OPERATIONSTATUS_OK` | 成功。注意 proto3 会**省略 0 值**，所以「成功」的响应里这个字段常常不出现 |
| 1 | `OPERATIONSTATUS_WAIT` | 让你去刷钥匙卡。绑定流程第 ③ 步收到它是**正常中间态** |
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

日志里会打成 `车辆回执：<枚举名>(N)` 加一句中文处置建议（映射表在 `v3actions.js:PAIR_HINTS`）。配对场景真会遇到的码：

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

---

## 8. 已知不确定项（真机前先看一眼，省时间）

1. **counter 只能增、不能回退。** 协议里最不可逆的坑：nonce/counter 复用会永久触发 `FAULT_IV_SMALLER_THAN_EXPECTED`，且对同一把已绑定密钥**无法自愈**，只能删钥匙重新绑定。所以 counter 存在 `uni.setStorageSync('tesla_probe_v3_session_v1')` 里，组包时 `+1` 后才写回，握手时只会 `max(本机, 车辆回传)` 往上并（`invalidateV3Session()` 作废会话密钥但**绝不动 counter**）。所以：**任何一次失败后不要立刻连点重试**——失败不代表 counter 没涨。
2. **压缩点公钥未支持。** `p256.js:deriveSharedSecret` 明确拒绝 33 字节输入。若真机上车辆握手回的公钥不是 65 字节 `04…`，日志会直接报出来 → 需要补模平方根开点（数学上不复杂，但要实测确认车辆真会发压缩点）。
3. **RKE 动作编号已经大幅收缩。** 官方现行 `RKEAction_E` 只剩 `0 / 1 / 20 / 29 / 30`；`AUTO_SECURE_VEHICLE`、`WAKE_VEHICLE` 在早期 proto 里不存在或编号不同。页面上「后备箱/前备箱/充电口」是走 `ClosureMoveRequest`（F13 的「动作编号」行），自定义数字框发非表内值时只会打一条 `warn`，不伤车，但别当成「方案不行」的证据。
4. **会话是否轮换。** 目前是「握手一次、之后一直复用」。若车辆在一定时间/counter 跨度后要求重新握手，表现为 GCM tag 校验失败（`FAULT_AES_DECRYPT_AUTH`）→ 点「重新握手」重来即可。
5. **车辆最多同时约 3 台 BLE 钥匙连接。** 官方特斯拉 App 在后台时可能占用连接 → 扫到但连不上 / 连上无响应。**测试前杀掉官方 App 后台并断开它的蓝牙**。手机装过官方 App、已认证手机钥匙，**不影响探针**（协议无设备身份），但也**不能因此跳过绑定**（见 F11 最后一行）。
6. **本机密钥对的随机源不是 CSPRNG。** App 逻辑层没有 WebCrypto（`crypto.getRandomValues` 在 uni-app 的 JS 运行时里不存在），`aes.js:randomBytes` 用的是模块级持久 xoshiro128** 状态机：种子来自 4 次独立 `Math.random()` + `Date.now()`（高低位）+ `performance.now()` 噪声，异或进 4 个 32bit 状态字后预热 32 轮，避免「单次 32bit 种子 → 32 字节私钥只隐含 32bit 熵」。对**可行性探针**够用（一把临时钥匙，测完可删）；正式产品必须换成原生 CSPRNG（Android `SecureRandom` / iOS `SecRandomCopyBytes`，经 UTS 或原生插件暴露）。附带一条与性能有关的事实：纯 JS 的 P-256 标量乘在桌面 Node 上约 17 ms/次（密钥生成与 ECDH 各一次，每次连接最多一轮），手机上是同一数量级，不构成卡顿或超时风险。
7. **BLE 广播名匹配已做四层加固**（F5）：精确 / 前缀 / 归一化宽松等值 / 归一化宽松前缀，另加「无名但广播 `0211`」这条独立旁证；未命中但含 `TESLA` 时会单独打印真实名。**但匹配规则有个无法绕过的前提：车辆没改名。** 车机里「重命名蓝牙」、或手机系统里配对后被缓存成新名（实测出现过 `Tesla Model Y 小米YU7`），按 VIN 算出来的名字就永远匹配不上 —— 这正是 ② 页改成**广播手选弹窗**（F5.1）的原因：`0211` 服务标识和 RSSI 比名字可靠得多。所以「扫不到车」剩下的解释只有两种：**车真的没在广播**，或**名字被改过（改用手动选择）**。
8. **「扫到了但连上就断」不是匹配问题。** 若日志已经出现 `发现车辆 … connecting`，随后 `disconnected` / `getBLEDeviceServices:fail no connection`，说明匹配这一步已经成功，失败点在连接层之后：优先按 §8.5 处理（杀掉官方 App 后台、车机设置里删旧钥匙），再确认车没休眠（踩刹车让车机醒再试）。手选弹窗解决不了这一类。
9. **车库里的最坏情况**：探针这把钥匙作废（重绑即可）或白名单槽位满（车机删旧钥匙）。**车不会被锁死** —— 官方 App、NFC 卡、钥匙扣、车内门把手四条退路都不经过本探针。

---

## 9. 如果 uni-app 的原生蓝牙能力不够（替代方案）

代码里已经把最可能的阻塞点埋成显式日志，出现下面任一条，**说明协议本身没问题、是 uni 的蓝牙 API 到不了**，别再改协议代码：

| 日志关键词 | 原因 | 方案 |
| --- | --- | --- |
| 弹窗 `打包时未添加bluetooth模块` | 跑在**标准基座**上（`manifest.json` 里改了也没用，基座是预编译的） | 云打包一次**自定义调试基座**（§5 第 4 步），之后改 JS 只走热更新 |
| `关键阻塞：运行时未能开启 0213 的通知` | `notifyBLECharacteristicValueChange` 打不开 CCC 描述符 `0x2902`（uni 不暴露手写描述符） | **A** 用 **nRF Connect** 连同一台车，手动对 `0213` Enable indicate，再回本 App 发送 —— 区分「一次性订阅失败」与「uni 根本不行」<br>**B** 换支持写描述符的 uni 原生蓝牙插件（DCloud 插件市场搜 BLE 类 / UTS 插件，注意需付费 + 重新打基座）<br>**C** 直接用 Android 原生（Kotlin + `BluetoothGatt.writeDescriptor`）或 Flutter `flutter_blue_plus` 重写传输层，`common/` 全部模块可原样复用（只依赖 ECDH + AES + protobuf） |
| `按 MTU=23 工作，>20B 响应可能被截断` | `setBLEMTU` 被拒或谈不成（`_negotiateMtu` 依次试 247/185/128/64 全失败） | **写方向已经不怕了**：`_writeChunked` 按官方 `blockLength = min(MTU,1024)-3` 真分包，出现 `帧长 N > MTU 可用 M，按官方规则分成 K 片写` 是**正常 info 日志、不是故障**。真正的问题是**读方向**：65 字节临时公钥响应会被系统截成 20B → 用 nRF Connect 设 247 对比；或走 B/C |
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
| `protos/VCSECv3.10.14.proto`（trifinite/vcsec-archive） | 早期字段号 / 枚举数值的旁证（**现行数值一律以 `vehicle-command` 的 `protobuf/vcsec.proto` 为准**，两者不一致时后者赢；映射写在 `common/v3spec.js` 头注释） |
| gist `LexNastin/fc55736f…` | 端到端绑定 + 加密指令的样例报文与字节核对 |
| `teslabtapi.com/docs/start` | GATT（Service `…0211` / 写 `0212` / 收 `0213` / 版本 `0214`）、2 字节大端长度前缀、BLE 命名规则（新 `Tesla `+VIN 后 6 位 / 旧 `S`+SHA1(VIN)hex 前 16 位+末位 C/R/D/P） |
| `teslabtapi.com/docs/more/rke` | RKE 动作枚举、AES-GCM key/nonce/aad 推导 |
| `github.com/teslamotors/vehicle-command` → `pkg/protocol/protocol.md` | **V3 的权威来源**：`RoutableMessage` 报文格式、TLV 元数据编码、成对的官方测试向量（§6 里 V3 那几行逐字节对拍都取自这里） |
| 同上 → `internal/authentication/{native,metadata,peer,signer,verifier,crypto}.go` | 握手 HMAC 的元数据顺序、子密钥派生、`counter` 语义（`counterMax = 0xFFFFFFFF` 是保留哨兵、`timeZero = generatedAt - clock_time` 锚点、换 `epoch` 时 counter 归零） |
| 同上 → `internal/dispatcher/{dispatcher,session,receiver}.go` | 请求 ID 如何配对响应、`routing_address` / `uuid` 何时生成何时复用、响应里搭车 `session_info` 的采纳条件 |
| 同上 → `pkg/vehicle/{vehicle,vcsec,security}.go` | `flags = 1<<FLAG_ENCRYPT_RESPONSE`、BLE 每 1 秒重发、`WAIT` 按 `ErrBusy` 整条重发 |

> 关于早期文档里「`nonce = 4B counter` / AAD 空」与现行「`12B nonce` + AAD」的矛盾：**两者都曾对，是两代协议**。前者对应 VCSEC 直连报文，官方现行客户端走 V3 `RoutableMessage`。本工程一开始两套都实现、并在启动页选择，用真机给出答案：直连那套在这代车机上拿不到可解析的响应，于是连同选版本页一起删了（§2.1）。现在只剩 V3，**唯一保留的老式信封是绑定帧**（F11，因为那时还没有会话可加密）。

协议里最容易写错的一点单独强调：**proto3 的 singular 标量等于 0 时不编码**。所以 `UNLOCK(0)` 的内层报文是**空字节串**（车辆按默认 0 解释），而 `LOCK(1)` 是 `10 01`；`GET_STATUS(0)` 的请求体因此短到只有 4 字节。

---

## 11. 请评审 AI 重点回答的问题

1. §3 里 F9（INDICATE 订阅）与 F7（MTU）是唯一的 uni 硬边界吗？还有没有别的 API（如 `uni.writeBLECharacteristicValueType`、UTS 插件、`plus.bluetooth` 直接调用）能在**不引入第三方原生插件**的前提下打开 0x2902？
2. F11 的绑定报文（裸 `ToVCSECMessage{signedMessage{PRESENT_KEY}}` + 明文内层 + `keyRole=ROLE_DRIVER(3)` + `formFactor` 由页面选、默认 `ANDROID_DEVICE(7)`，**不带 `permission` 数组**）与官方固件期望是否一致？官方 `security.go:338 SendAddKeyRequestWithRole` 发的就是这个形状，但现行 proto 里 `PermissionChange` 只剩 `key / secondsToBeActive / keyRole` —— `keyFormFactor` 按官方 `vcsec.go:151` 放在 `WhitelistOperation.metadataForKey`，只给 `keyRole` 不给任何 permission，车机会不会因此回 `NO_PERMISSION_TO_ADD(5)`？
   另外，**绑定成败的判定已经改成「终态回执与会话探针并行、谁先来算谁」**，理由是取证到量产固件常常**不回** `protocol.md:836` 那条 completing 的 `whitelistOperationStatus`（0Bu `vehicle_pairing.cpp:246` 明确把它标成 `ExpectedSilent`）。请确认：① 这个结论对本车（HW4/V3、2025.44）是否成立；② 探针用的「无签名 `session_info_request` 打 VCSEC 域」（官方 `vehicle.go:120` + `dispatcher.go:464 AuthMethodNone`）会不会有唤醒车机 / 计入操作频率之类的副作用；③ 有没有比它更可靠的「已入白名单」判据。
3. F12/F13 的密钥与加密链（`sharedKey = SHA1(ECDH_x)[:16]`、`subkey = HMAC-SHA256(K,label)`、`nonce = randomBytes(12)`、`AAD = SHA256(TLV‖0xFF)`、`signature = GCM tag`、身份靠 `signer_identity.public_key`）有没有和现行固件不符之处？特别是响应侧 `request_hash` 的构造（`sigtype 单字节 ‖ 请求的 tag`，HMAC 时截 16 字节）。
4. counter 与会话的生命周期管理（换连接 `invalidateV3Session()` 只清密钥不动 counter、握手 `max(本机, 车辆回传)`、组包成功才写回）是否存在会导致 `IV_SMALLER_THAN_EXPECTED` 的边界（例如并发点击、断连重连、App 被杀、`0xFFFFFFFF` 哨兵附近）？
5. 若 Q1/Q2 判定为「uni 做不到」，§9 的 B/C 哪条改动量最小？`common/` 的模块里哪些可以直接复用、哪些必须原生替代？（我方已知最需要原生替代的是 `aes.js:randomBytes` —— 纯 JS 的 xoshiro128**，非 CSPRNG，见 §8.6。）
6. `GET_WHITELIST_INFO` 这台车实测回的是 **4 字节 keyId**，而 V3 的 `keyIdOf(pub)` 是完整 20 字节 SHA1。现在靠 `keyIdMatches()` 做前缀归一糊过去了 —— 官方到底哪一种才是规范回包？不同年款会不会回 20 字节、导致前缀匹配反向失效？
7. 手选弹窗（F5.1）目前用「广播了 `0211` 服务」当作比名字更强的车辆证据。在 Android 上 `advertisServiceUUIDs` 是否总能被 `onBluetoothDeviceFound` 填充（部分机型只在连接后才给服务列表）？若不可靠，是否该改成点完条目后靠 `getBLEDeviceServices` 的结果二次确认？
