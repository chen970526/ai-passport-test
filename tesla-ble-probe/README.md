# Tesla BLE 离线钥匙可行性探针（uni-app）

**这个工程只做一件事：验证「特斯拉开放的 BLE 离线钥匙协议（VCSEC）」能不能在一台安卓手机上，用 uni-app + 其自带的原生蓝牙 API 跑通。**

跑通 = 能绑定车辆 → 能协商出会话密钥 → 能发出被车辆实际执行的**上锁 / 解锁**指令。

它不是产品：私钥明文存在 App 沙箱、UI 只有按钮和日志、错误提示直给。
**只在真机（App / Android）上有效**，H5 与小程序拿不到蓝牙 GATT，代码里会直接抛「只能在 App 真机上运行」。

---

## 0. 给评审者（人或 AI）的一段话

请重点判断的不是「密码学对不对」（这部分已用 Node 原生 `crypto` 逐字节对拍，见 §6），而是下面 4 个**只有真机能回答**的问题：

| # | 待判定问题 | 卡在哪 | 如果不行，退路 |
| --- | --- | --- | --- |
| Q1 | `uni.notifyBLECharacteristicValueChange` 能否真正打开 0213 的 CCC 描述符（0x2902 = indicate） | uni 不暴露手写描述符 | 见 §9 三级方案 |
| Q2 | `uni.setBLEMTU` 能否把 MTU 谈到 ≥ 帧长+3（响应里有 65 字节临时公钥） | 部分栈只在连接瞬间允许一次 MTU 请求 | 同上 |
| Q3 | `uni.writeBLECharacteristicValue` 一次能否写完整帧（≈40–110B），不做 ATT 分片 | 特斯拉 VCSEC 不接受跨 ATT PDU 的分片写 | 抬高 MTU；否则换原生层 |
| Q4 | Android 12+ 上，uni 的 BLE 全套 API 在运行时权限（SCAN/CONNECT）下的行为是否与 targetSdk 匹配 | 基座 targetSdk 由云打包决定，不一定等于 manifest 写的值 | 已改成运行时 `SDK_INT` 探测（§3 的 F2） |

协议侧的风险点（与 uni 无关，属「方案本身」）：counter 单调递增不可回退、白名单槽位有限（约 3 把 BLE 钥匙）、临时公钥是否轮换。见 §8。

---

## 1. 可行性判定标准（四档，出门测之前先记住）

| 档位 | 现象 | 结论 |
| --- | --- | --- |
| ① 弱证据 | 能扫到车、能 `createBLEConnection`、能枚举出 `0211/0212/0213/0214` | 只证明 uni 的 BLE **连接层**能用，协议还没开始 |
| ② 中通证据 | 连接后点「读 0214 版本」能读到字节；点「查白名单」能收到车辆回包并解出 `whitelistInfo` | 证明 **收发通路 + INDICATE 订阅 + 分帧重组**在 uni 下成立。这一步**不需要密钥、不需要刷卡、不占槽位** |
| ③ 强证据 | 「③ 绑定」刷钥匙卡后回 `status=OK`，且「查白名单」里出现本机 keyId | 证明**协议实现被车辆接受**（组包、字段号、formFactor、权限表全对） |
| ④ 端到端 | 「协商临时公钥」拿到 65B 点 + 「解锁 / 上锁」回 `status=OK` **且车真的动了** | 方案成立，可以继续做产品化 |

**只有 ② 失败才是 uni 的能力问题；③/④ 失败一般是协议或业务状态问题**（判读表见 §7.3）。

---

## 2. 目录结构与分层

```
tesla-ble-probe/
├── main.js / App.vue / pages.json / manifest.json   uni-app 工程四件套（Vue3）
├── pages/
│   ├── index/index.vue    ① 蓝牙就绪 → ② 扫描连接 → ③ 绑定车辆（刷钥匙卡）+ 排查按钮
│   ├── rke/rke.vue        协商临时公钥 → 上锁 / 解锁 / 其它 RKE 动作 / 连发压测
│   └── debug/debug.vue     手工组包、原始帧收发、报文解析、规格速查（排障用）
├── components/log-box/log-box.vue   全局日志窗口（easycom 免注册，订阅 session 日志总线）
├── common/
│   ├── sha1.js  aes.js  p256.js     纯 JS 密码学（不依赖 BigInt / 不依赖任何原生模块）
│   ├── bytes.js                      字节 / hex / 大端整数工具
│   ├── pb.js                         手写 protobuf wire 编码 + 解码 + 结构化打印
│   ├── spec.js                       VCSEC 字段号与枚举表（规格来源见 §10）
│   ├── vcsec.js                      帧构造 / 解析 / GATT UUID / 长度前缀 / BLE 命名
│   ├── tesla-ble.js                  uni BLE 封装（适配器、扫描、连接、MTU、订阅、分帧重组、权限）
│   ├── session.js                    全局会话：密钥对、counter 落盘、日志总线、BLE 生命周期
│   └── actions.js                    页面动作：绑定 / 协商 / 上锁解锁 / 只读查询
└── tests/
    ├── run.mjs                       算法与协议对拍自测（Node，98 条断言）
    └── vue-check.mjs                 把 .vue 的 <script> 真 import 一遍做语法自检（5 个文件）
```

**零 npm 依赖**：`common/` 下全是自研纯 JS，HBuilder X 里不需要 `npm install`，也不需要任何原生插件。

分层原则：**协议层（`vcsec/pb/spec/sha1/aes/p256/bytes`）完全不认识 uni，传输层（`tesla-ble.js`）完全不认识协议**。
所以将来换 Kotlin / Flutter 重写传输层时，只有 `tesla-ble.js` 一个文件需要替代。

---

## 3. 功能点全清单（每个功能点：入口 → 调用链 → 接口 → 实现方式 → 判据）

> 表里的「uni 接口」全部是 uni-app App 端自带 API（无需插件）；「纯 JS」列是本工程自研实现。

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
| 失败判读 | 只填后 6 位时老命名规则失效（日志会说明） |

### F5 BLE 扫描并命中目标车辆

| 项 | 内容 |
| --- | --- |
| UI 入口 | 「② 扫描并连接」（`step2` → `connectTo`）；「列出周围广播」（`allAdvs` → `scanAll`） |
| 调用链 | `session.js:connectTo(vin)` → `TeslaBle.scan(names, 20000)` → `TeslaBle.connect(device)` |
| 用到接口 | `uni.onBluetoothDeviceFound(cb)`、`uni.startBluetoothDevicesDiscovery({allowDuplicatesKey:false, powerLevel:'high', interval:0})`、`uni.stopBluetoothDevicesDiscovery()`、`uni.offBluetoothDeviceFound()`（老版本无此 API，已 try/catch） |
| 实现方式 | 四级匹配 + 两级兜底：<br>1) `exact` 精确等值；2) `prefixes` 前缀；3) `normName()`（去掉所有非字母数字并转大写）后的等值/前缀，吸收 `Tesla 723591` / `Tesla_723591` / `tesla723591` 这类差异；<br>4) 广播**无名字**但 `advertisServiceUUIDs` 里带 `0211`（VCSEC 服务）→ 认作疑似车辆；<br>5) 名字含 `TESLA` 但没命中期望名 → 单独打 `warn` 把**真实广播名 + rssi** 打出来，供现场抄进匹配规则 |
| 成功标志 | `发现车辆 name=... (exact/prefix/loose/loose-prefix 命中 X) id=...` |
| 失败判读 | `扫描 20000ms 未发现目标车辆` → 车没在广播（人不在车边 / 车机蓝牙被关闭 / 车辆深度睡眠导致广播间隔很长 / 真名格式不同）。先点「列出周围广播」人工确认 |
| 排查按钮 | 「列出周围广播」用 `scanAll(10000)` 只收集不匹配，输出 `名字 + deviceId`（无名设备用 `(无名) + deviceId 后 8 位`，不折叠），并对期望名标 `★命中` |

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
| 调用链 | `actions.js:exchange(frame, what, timeoutMs)` → `TeslaBle.send(frame, timeoutMs)` → `_writeChunked` |
| 用到接口 | `uni.writeBLECharacteristicValue({deviceId, serviceId, characteristicId, value:ArrayBuffer})` |
| 实现方式 | `bytesToAb()` 复制一份 `Uint8Array` 再取 `.buffer`（避免 buffer 视图共享导致长度异常）；写队列 `this._tx = this._tx.then(...)` 保证串行；每次写完 `delay(30)` 给车机处理时间；响应通过 `_waitForFrame()` 的 FIFO 等待队列返回 |
| 长度处理 | 帧 > `mtu-3` 时打 `warn` 后**仍直发**（特斯拉不接受应用层分片，只能靠 MTU） |
| 成功标志 | 日志 `发送 N 字节: <hex>` 后紧跟 `响应 M 字节: <hex>` |
| 失败判读 | `等待车辆响应超时 Xms（可能没订阅成功 / 车辆休眠 / MTU 不足）` |
| 原始帧旁路 | 每次收发都同时喂给 `onRaw` → `session.js:connection.raw`（保留最近 60 条）→ ③ 报文控制台页显示 `→车 / ←车` |

### F11 绑定车辆（加白名单，需刷 NFC 钥匙卡）

| 项 | 内容 |
| --- | --- |
| UI 入口 | ① 页「③ 绑定（刷钥匙卡）」（`step3`） |
| 调用链 | `actions.js:bindKey(vin)` → `session.js:ensureKey(vin)` → `vcsec.js:buildWhitelistFrame(publicKey, formFactor)` → `exchange(..., 60000)` |
| 用到接口 | F10 的 `writeBLECharacteristicValue` + F9 的 indicate；无新增 |
| 纯 JS 实现 | `session.ensureKey` → `vcsec.newKeyPair()` → `p256.normalizePrivateKey(randomBytes(32))` + `p256.publicKeyFromPrivate()`（65 字节未压缩点 `04‖X‖Y`）；`keyIdOf(pub) = SHA1(pub)[:4]`；落盘 `uni.setStorageSync('tesla_probe_key_v1', {priv, pub, vin})` |
| 协议报文 | `ToVCSECMessage{ signedMessage{ protobufMessageAsBytes = UnsignedMessage{ WhitelistOperation{ addKeyToWhitelistAndAddPermissions(5){ key{PublicKeyRaw=65B}, permission=[LOCAL_DRIVE(2), LOCAL_UNLOCK(1), REMOTE_DRIVE(4), REMOTE_UNLOCK(3)] }, metadataForKey{keyFormFactor=KEY_FORM_FACTOR_ANDROID_DEVICE(7)} }, signatureType = SIGNATURE_TYPE_PRESENT_KEY(2) } }`<br>**注意：内层是明文，不加密**，靠「刷钥匙卡」这个物理事件授权 |
| 实际字节样本 | 用全 `11` 的假公钥跑 `buildWhitelistFrame(pub, 7)`，92 字节：`005a 0a58 1254 820151 2a4b 0a43 0a41 <65×11> 1204 02010403 3202 0807 1802`。逐段：`005a`=2 字节大端长度前缀 → `0a58`=signedMessage → `1254`=protobufMessageAsBytes → `82 01 51`=字段16 WhitelistOperation → `2a4b`=字段5 addKeyToWhitelistAndAddPermissions → `0a43 0a41`=key.PublicKeyRaw → `12 04 02 01 04 03`=**packed** repeated permission → `32 02 08 07`=metadataForKey.keyFormFactor=7 → `18 02`=signatureType=PRESENT_KEY |
| 时序 | 车辆先回 `status=WAIT(1)`，然后进入 30 秒刷卡窗口；本端 `exchange` 最长等 **60 秒**（提示文案已写明两个时限） |
| 成功标志 | `绑定成功：公钥已进白名单，keyId=xxxxxxxx` |
| 失败判读 | `WhitelistOperation_information_E`（§7.3）；最常见 `KEYFOB_SLOTS_FULL(3)` / `WHITELIST_FULL(4)` → 车机设置里删一把旧钥匙；`INVALID_PUBLIC_KEY(6)` → 公钥不是 65 字节 `04…` |
| 能不能跳过 | **不能。** 协议里没有任何「设备身份」，车辆只认公钥；官方 App 的私钥受 Android 沙箱保护读不到。加新钥匙本身还需要一次授权动作（刷卡 = `PRESENT_KEY`），另一条「用已在白名单的私钥签名」正好依赖那把拿不到的私钥 |

### F12 协商临时公钥（ECDH → sharedKey）

| 项 | 内容 |
| --- | --- |
| UI 入口 | ② 页「协商临时公钥」（`doEph`）；RKE 首次点击时**自动**先做这一步 |
| 调用链 | `actions.js:requestEphemeralKey()` → `vcsec.buildEphemeralRequestFrame(publicKey)` → `ephemeralKeyFromResponse(obj)` → `sharedKeyOf(privateKey, eph)` |
| 用到接口 | 同 F10/F9 |
| 纯 JS 实现 | `p256.deriveSharedSecret(priv32, peer65)`（标量乘，**明确拒绝 33 字节压缩点**）→ `SHA1(sharedX)[:16]` = `sharedKey`（AES-128 密钥） |
| 协议报文 | `ToVCSECMessage{ unsignedMessage{ InformationRequest{ informationRequestType = GET_EPHEMERAL_PUBLIC_KEY(3), keyId{publicKeySHA1 = SHA1(pub)[:4]} } }`<br>实测字节（keyId 用 `11 11 11 11` 占位）：`12 0c 0a 0a 08 03 12 06 0a 04 11 11 11 11`（未加 2 字节前缀）<br>响应取 `FromVCSECMessage.sessionInfo.publicKey`（字段 3） |
| 生命周期 | `sharedKey` 存在内存 `state.sharedKey`，**不落盘**；`connectTo()` 会把它置 `null`（换连接必须重新协商） |
| 成功标志 | `共享密钥已协商 = <32hex>（AES-128-GCM 用，本次连接内有效）` |
| 失败判读 | `临时公钥格式意外（长度 X，首字节 Y）` → 车辆发了压缩点，见 §8.2；`FAULT_AES_DECRYPT_AUTH(6)` → 车辆轮换过临时公钥，重按一次即可 |

### F13 RKE 上锁 / 解锁（AES-128-GCM 加密指令）

| 项 | 内容 |
| --- | --- |
| UI 入口 | ② 页：`解锁(0)` `上锁(1)` `后备箱(2)` `前备箱(3)` `开充电口(4)` `关充电口(5)`；自定义数字框 + 「发送自定义动作」；「上锁→解锁 各 3 次」压测（任一轮失败即中断并报「压测在第 N 轮中断，后续结果不再可信」） |
| 调用链 | `actions.js:sendRke(action, name)` →（缺 sharedKey 时自动 `requestEphemeralKey()`）→ `session.nextCounter()` → `vcsec.buildRkeFrame(pub, sharedKey, counter, action)` → `exchange(..., 8000)` |
| 用到接口 | 同 F10/F9 |
| 纯 JS 实现 | `aes.aes128GcmEncrypt(key16, nonce, plaintext, aad=new Uint8Array(0))`，其中 **nonce = `beBytes(counter,4)`**（4 字节大端，特斯拉不用标准 12 字节 IV）；自研 CTR+GHASH 路径已与 Node `createCipheriv('aes-128-gcm')` 双向对拍 |
| 协议报文 | 内层 `UnsignedMessage{ RKEAction: action }` → `ToVCSECMessage{ signedMessage{ protobufMessageAsBytes = 密文, counter, signature = GCM tag(16B), keyId = SHA1(pub)[:4], signatureType = AES_GCM(0，proto3 省略) } }`<br>**proto3 坑**：`UNLOCK(0)` 的 RKEAction 是默认值 → 内层编码为**空字节串**；`LOCK(1)` 内层 = `10 01`（`RKEAction` 是字段 2 → tag = `2*8+0 = 0x10`） |
| counter 规则 | `nextCounter()` 只增不减并落盘 `tesla_probe_counter_v1`；车辆响应里带回来的 counter 经 `syncCounter()` **只上调、绝不下调** |
| 成功标志 | `status=OPERATIONSTATUS_OK` **且车真的响**（这一档才算端到端成立） |
| 失败判读 | `SignedMessage_information_E`（§7.2）；`FAULT_IV_SMALLER_THAN_EXPECTED(3)` → counter 回退，这把钥匙永久失效，**立刻停手，禁止重试** |

### F14 无签名只读查询（绑定前就能发）

| 项 | 内容 |
| --- | --- |
| UI 入口 | ② 页「查车辆状态」；① 页「查白名单」「读 0214 版本」 |
| 调用链 | `actions.js:queries.{status, whitelist, vehicleInfo, capabilities, keyStatus}` → `infoRequest(type, label)` → `vcsec.buildInfoRequestFrame(type, hasKey()?pub:null)`；版本读取走 `TeslaBle.readVersion()` |
| 用到接口 | 前 5 项 = `writeBLECharacteristicValue` + indicate；读版本 = **`uni.readBLECharacteristicValue({deviceId, serviceId, characteristicId})`** |
| 实现方式 | `InformationRequest` 全部走 `unsignedMessage`，**不需要密钥、不需要签名**。所以「连接 → 读版本 → 查白名单」这条链**不刷卡、不占槽**，是现场最便宜的一次通路自检（= §1 的 ② 档） |
| 请求类型 | `GET_STATUS(0)`、`GET_EPHEMERAL_PUBLIC_KEY(3)`、`GET_WHITELIST_INFO(5)`、`GET_VEHICLE_INFO(7)`、`GET_KEYSTATUS_INFO(8)`、`GET_CAPABILITIES(16)` |
| 实测字节 | `GET_WHITELIST_INFO`（不带 keyId）= `00 06 12 04 0a 02 08 05`；`GET_STATUS`（不带 keyId）= `00 04 12 02 0a 00`（`type=0` 被 proto3 省略 → `InformationRequest` 编码为空） |
| 关键改动 | `checkWhitelisted()` **已去掉 `mustKey()` 守卫**，绑定前可查；本机 keyId 是否在内按 `hasKey()` 分支显示。`buildInfoRequestFrame` 里的 `keyId` 是 `SHA1(公钥)` 前 4 字节，不是公钥本身 |
| 成功标志 | `白名单 N 条 [keyId...]`；`通信协议版本 = <hex>`；`锁状态=VEHICLELOCKSTATE_UNLOCKED/LOCKED` |
| 失败判读 | 无响应 = 通路问题（回查 F9/F7）；有响应但 `summary.kind=other` = 字段号/枚举与该车固件不符（用 ③ 页对照规格） |

### F15 密钥与 counter 持久化 / 换钥 / 清除

| 项 | 内容 |
| --- | --- |
| UI 入口 | ① 页「换新密钥对」「清除本机密钥」「断开连接」 |
| 调用链 | `session.js:saveKeyPair / loadKey / forgetKey / ensureKey / nextCounter / syncCounter`；`disconnectAll()` → `TeslaBle.close()` |
| 用到接口 | `uni.setStorageSync / uni.getStorageSync`；`uni.closeBLEConnection` + `uni.closeBluetoothAdapter` |
| 存储键 | `tesla_probe_key_v1`（`{priv, pub, vin}` hex）、`tesla_probe_counter_v1`（number）、`tesla_probe_vin_v1`（VIN） |
| 实现方式 | `App.vue:onLaunch → loadKey()` 启动回填，重开 App 不用重新生成密钥；`ensureKey` 幂等；私钥**明文存沙箱**（探针专用，产品必须进 Android Keystore） |
| 风险 | 「清除本机密钥」会连 counter 一起清 0 → **车辆侧那把钥匙仍在白名单里但计数器记忆已丢**，重绑前别乱点；「换新密钥对」= 换了一把全新 key，旧计数作废是安全的，counter 归零没问题 |

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
| UI 入口 | ③ 页（`→ 报文控制台`）：原始帧列表 / JSON 手工组包（预设 `绑定样例 / 临时公钥样例 / RKE 样例`）/ 裸 hex 发送 / 按消息名解析 / Message + Enum 规格速查 |
| 调用链 | `debug.vue:buildFromJson → pb.encode(SPEC,'ToVCSECMessage',obj) → prependLength → ble().send(frame,8000)`；`normalizeHex → pb.decode(SPEC, msgName, bytes) → pb.inspect` |
| 用到接口 | 复用 F10/F9（不新增）；页面跳转 `uni.navigateTo` |
| 实现方式 | `bytes` 字段在 JSON 里直接写 hex 字符串即可；`只编码不发送` 用于**把完整 hex 抄到 nRF Connect 做 A/B 对照**（§9）；`inspect()` 输出带字段名的结构化文本，用来肉眼核对字段号 |
| 注意 | `rke` 预设里的 `signature` 需要你自己按 sharedKey+counter 算 GCM tag，所以它**只能观察报文结构**，真发 RKE 请用 ② 页按钮 |
| 价值 | 这是「协议问题」与「uni 问题」的分诊台：同一段 hex 用 nRF Connect 手发能成 → 问题在 uni；手发也不成 → 问题在报文 |

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
| 其它 | `setKeepScreenOn` / `setStorageSync` / `getStorageSync` / `showToast` / `navigateTo` | — | 与蓝牙无关的辅助能力 |

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
① 页  填 VIN → ① 蓝牙就绪 → ② 扫描并连接
       → 读 0214 版本 → 查白名单        ← 不刷卡、不占槽，先确认 uni 收发通路（= ① 档 / ② 档）
       → ③ 绑定（30 秒内刷钥匙卡）      ← 这一步才真正写白名单
② 页  协商临时公钥 → 上锁 → 解锁 → 上锁→解锁 各 3 次
```

**「读 0214 / 查白名单」放在绑定前是刻意的**：它俩都是无签名请求，能一次回答 Q1（indicate 到底开没开）和 Q2（MTU 够不够），而**不需要消耗车辆白名单槽位、不需要刷卡**。这两步不通，就别刷卡，直接按 §9 走替代方案。

绑定成功后 App 会自动生成一对 P-256 密钥并保存；重开 App 不用重新生成，但**车辆白名单只加一次**，重启 App 后直接做「协商临时公钥」即可。

---

## 6. 已验证范围（不需要真机就能确认的部分）

```powershell
cd f:\Desktop\test\tesla-ble-probe
node tests\run.mjs        # 结果: 98 passed, 0 failed
node tests\vue-check.mjs  # 页面脚本自检: 全部通过 (5 个)
```

`tests/run.mjs` 用 Node 原生 `crypto` 做金标准对拍，已确认：

| 层 | 模块 → 函数 | 已证 |
| --- | --- | --- |
| SHA-1 | `sha1.js:sha1` | 与 `createHash('sha1')` 逐字节一致 |
| AES-128 | `aes.js:expandKey / aes128EncryptBlock` | 与 FIPS-197 官方向量一致 |
| AES-128-GCM（4 字节 nonce） | `aes.js:aes128GcmEncrypt / aes128GcmDecrypt` | 与 `createCipheriv('aes-128-gcm')` 密文+tag 双向一致，并能解密 Node 的产物 |
| P-256 标量乘 / ECDH | `p256.js:publicKeyFromPrivate / deriveSharedSecret / isOnCurve` | 与 `createECDH('prime256v1')` 生成的 G、公钥、共享点全部一致 |
| 随机源 | `aes.js:randomBytes` | **没有金标准可对拍**：App 逻辑层无 WebCrypto，实现是模块级持久 xoshiro128** 状态机（种子 = 4 次 `Math.random` + `Date.now` + `performance.now` 噪声，预热 32 轮）。自测里只把它当测试输入生成器，未对随机性本身做统计断言，**不是 CSPRNG**，风险见 §8.6 |
| protobuf | `pb.js:encode / decode / inspect` | 字段号→tag、varint、packed repeated、**proto3 默认值省略**均与参考实现一致 |
| VCSEC 帧 | `vcsec.js:build* / decodeResponse / summarize / label` | 与 teslabtapi / 公开 gist 的样例字节逐条对齐（含 `10 01` = `UnsignedMessage.RKEAction=LOCK`） |
| 长度前缀 | `vcsec.js:prependLength / stripLength` + `tesla-ble.js:_onChunk` | 2 字节大端前缀 + 粘包/半包重组 |
| 页面脚本 | `tests/vue-check.mjs` | 3 个页面 + `log-box` 组件 + `App.vue` 的 `<script>` 全部真 import 通过 |

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
| 3 | `FAULT_IV_SMALLER_THAN_EXPECTED` | **counter 回退了** → 见 §8.1，只能重新绑定，**禁止重试** |
| 4 | `FAULT_INVALID_TOKEN` | keyId（公钥 SHA1）车辆不认识 → 重新绑定 |
| 5 | `FAULT_TOKEN_AND_COUNTER_INVALID` | token+counter 双错，等价于密钥/计数器状态已废 → 重新绑定 |
| 6 | `FAULT_AES_DECRYPT_AUTH` | **GCM tag 校验失败** → sharedKey 算错、nonce 拼错、或 aad 非空；也可能是车辆换了临时公钥没重新协商 → 点「协商临时公钥」重来 |
| 7 | `FAULT_ECDSA_INPUT` | 走了签名路径才会出现，本项目用 GCM 不产生 ECDSA |
| 8 | `FAULT_ECDSA_SIGNATURE` | 同上 |
| 9 | `FAULT_LOCAL_ENTITY_START` | 车辆内部模块启动失败（车端问题） |
| 10 | `FAULT_LOCAL_ENTITY_RESULT` | 车辆执行了但返回失败（如门锁机构故障）→ 换动作再试一次确认 |
| 11 | `FAULT_COULD_NOT_RETRIEVE_KEY` | 车辆取不到白名单公钥 → 重新绑定 |
| 12 | `FAULT_COULD_NOT_RETRIEVE_TOKEN` | 车辆取不到 token → 重新协商临时公钥 |
| 13 | `FAULT_SIGNATURE_TOO_SHORT` | **`signature` 字段短于 16 字节** → GCM tag 被截断，通常是 MTU 太小（**Q2/Q3**） |
| 14 | `FAULT_TOKEN_IS_INCORRECT_LENGTH` | token 长度不对（应为 4 字节 keyId） |

### 7.3 `WhitelistOperation_information_E` —— 绑定被拒的原因

| 值 | 名称 | 判读 |
| --- | --- | --- |
| 0 | `NONE` | 已写入白名单 |
| 1 | `UNDOCUMENTED_ERROR` | 车端未知错误，重试一次 |
| 2 | `NO_PERMISSION_TO_REMOVE_ONESELF` | 权限设置里误带了「删自己」 |
| 3 | `KEYFOB_SLOTS_FULL` | **钥匙槽满了**（BLE 钥匙位有限，通常 3 台）→ 车机设置里删一把旧钥匙 |
| 4 | `WHITELIST_FULL` | 白名单满（含 NFC 卡）→ 同上 |
| 5 | `NO_PERMISSION_TO_ADD` | 权限等级不够，车辆要求更高授权 |
| 6 | `INVALID_PUBLIC_KEY` | **公钥格式不对** → 必须是 65 字节未压缩点 `04 ‖ X ‖ Y` |
| 7 | `NO_PERMISSION_TO_REMOVE` | 权限里带了删除 |
| 8 | `NO_PERMISSION_TO_CHANGE_PERMISSIONS` | 权限变更需更高授权 |
| 9 | `ATTEMPTING_TO_ELEVATE_OTHER_ABOVE_ONESELF` | 给别人提权超过自己 |
| 10 | `ATTEMPTING_TO_DEMOTE_SUPERIOR_TO_ONESELF` | 给上级降权 |
| 11 | `ATTEMPTING_TO_REMOVE_OWN_PERMISSIONS` | 申请里删了自己的权限 |

> 本项目绑定时固定申请 `LOCAL_UNLOCK(1) / LOCAL_DRIVE(2) / REMOTE_UNLOCK(3) / REMOTE_DRIVE(4)`，`formFactor = KEY_FORM_FACTOR_ANDROID_DEVICE(7)`，正常不会命中 9/10/11。

---

## 8. 已知不确定项（真机前先看一眼，省时间）

1. **counter 只能增、不能回退。** 协议里最不可逆的坑：nonce 复用会永久触发 `FAULT_IV_SMALLER_THAN_EXPECTED`，且对同一把已绑定密钥**无法自愈**，只能删钥匙重新绑定。所以 `session.js` 把 counter 写进 `uni.setStorageSync('tesla_probe_counter_v1')`，`nextCounter()` 只增不减；车辆响应带回的 counter **只用于向上纠偏**。所以：**任何一次失败后不要立刻连点重试**——失败不代表 counter 没涨。
2. **压缩点公钥未支持。** `p256.js:deriveSharedSecret` 明确拒绝 33 字节输入。若真机上车辆返回的 `sessionInfo.publicKey` 不是 65 字节 `04…`，日志会直接报出来 → 需要补模平方根开点（数学上不复杂，但要实测确认车辆真会发压缩点）。
3. **部分 RKE 动作数值与固件版本相关。** `AUTO_SECURE_VEHICLE`、`WAKE_VEHICLE` 在旧版 proto 里不存在或编号不同，本项目页面上只放了 0–5 这些跨版本稳定的动作；自定义数字框用来试其它值。发出去最多拿到 `FAULT_UNKNOWN`，不伤车，但别当成「方案不行」的证据。
4. **临时公钥是否轮换。** 目前是「协商一次、之后一直用这把」。若车辆在一定时间/counter 跨度后要求重新协商，表现为 `FAULT_AES_DECRYPT_AUTH` → 点「协商临时公钥」重来即可。
5. **车辆最多同时约 3 台 BLE 钥匙连接。** 官方特斯拉 App 在后台时可能占用连接 → 扫到但连不上 / 连上无响应。**测试前杀掉官方 App 后台并断开它的蓝牙**。手机装过官方 App、已认证手机钥匙，**不影响探针**（协议无设备身份），但也**不能因此跳过绑定**（见 F11 最后一行）。
6. **本机密钥对的随机源不是 CSPRNG。** App 逻辑层没有 WebCrypto（`crypto.getRandomValues` 在 uni-app 的 JS 运行时里不存在），`aes.js:randomBytes` 用的是模块级持久 xoshiro128** 状态机：种子来自 4 次独立 `Math.random()` + `Date.now()`（高低位）+ `performance.now()` 噪声，异或进 4 个 32bit 状态字后预热 32 轮，避免「单次 32bit 种子 → 32 字节私钥只隐含 32bit 熵」。对**可行性探针**够用（一把临时钥匙，测完可删）；正式产品必须换成原生 CSPRNG（Android `SecureRandom` / iOS `SecRandomCopyBytes`，经 UTS 或原生插件暴露）。附带一条与性能有关的事实：纯 JS 的 P-256 标量乘在桌面 Node 上约 17 ms/次（密钥生成与 ECDH 各一次，每次连接最多一轮），手机上是同一数量级，不构成卡顿或超时风险。
7. **BLE 广播名匹配已做四层加固**（F5）：精确 / 前缀 / 归一化宽松 / 无名但广播 `0211` 兜底；未命中但含 `TESLA` 时会单独打印真实名。所以「扫不到车」现在基本只剩一种解释：**车真的没在广播**。
8. **车库里的最坏情况**：探针这把钥匙作废（重绑即可）或白名单槽位满（车机删旧钥匙）。**车不会被锁死** —— 官方 App、NFC 卡、钥匙扣、车内门把手四条退路都不经过本探针。

---

## 9. 如果 uni-app 的原生蓝牙能力不够（替代方案）

代码里已经把最可能的阻塞点埋成显式日志，出现下面任一条，**说明协议本身没问题、是 uni 的蓝牙 API 到不了**，别再改协议代码：

| 日志关键词 | 原因 | 方案 |
| --- | --- | --- |
| 弹窗 `打包时未添加bluetooth模块` | 跑在**标准基座**上（`manifest.json` 里改了也没用，基座是预编译的） | 云打包一次**自定义调试基座**（§5 第 4 步），之后改 JS 只走热更新 |
| `关键阻塞：运行时未能开启 0213 的通知` | `notifyBLECharacteristicValueChange` 打不开 CCC 描述符 `0x2902`（uni 不暴露手写描述符） | **A** 用 **nRF Connect** 连同一台车，手动对 `0213` Enable indicate，再回本 App 发送 —— 区分「一次性订阅失败」与「uni 根本不行」<br>**B** 换支持写描述符的 uni 原生蓝牙插件（DCloud 插件市场搜 BLE 类 / UTS 插件，注意需付费 + 重新打基座）<br>**C** 直接用 Android 原生（Kotlin + `BluetoothGatt.writeDescriptor`）或 Flutter `flutter_blue_plus` 重写传输层，`common/` 全部模块可原样复用（只依赖 ECDH + AES + protobuf） |
| `按 MTU=23 工作，>20B 响应可能被截断` / `帧长 X > 当前 MTU 可用 Y` | `setBLEMTU` 被拒或谈不成 | 65 字节临时公钥响应必然失败 → 用 nRF Connect 设 247 对比；或走 B/C |
| `FAULT_SIGNATURE_TOO_SHORT(13)` | 写方向被 ATT 分片、或读方向被截断 | 同上；这条**同时**能反证 MTU 实际值 |
| `等待车辆响应超时` 但订阅显示成功 | indicate 打开了但回调没投递（uni 的事件总线/多监听器冲突），或车端没回 | 先在 ③ 页发一个 `GET_WHITELIST_INFO` 裸帧（`00 06 12 04 0a 02 08 05`）复现；能定性为「uni 回调问题」还是「车没回」 |
| `只能在 App 真机上运行` | 跑在 H5 / 小程序 / 未打基座 | 必须真机 + 自定义基座 |

**最低成本的「非 uni」验证路径**：nRF Connect 手工发字节。
连车 → 对 `0213` Enable indicate → 设 MTU 247 → 向 `0212` 写 ③ 页「只编码不发送」产出的完整 hex（含 2 字节长度前缀）→ 看回包。
- nRF Connect 手发能被车执行，本 App 不行 → 问题 100% 在 uni 蓝牙 API（走 B/C）。
- nRF Connect 也不行 → 问题在协议实现，把报文贴回来。

**取证优先级**（现场能留多少留多少）：整段录屏 > 失败时的日志整屏截图 > ③ 页原始帧 hex > 车辆真实广播名 > 白名单条数 > 车机屏幕提示。

---

## 10. 规格来源

| 来源 | 用途 |
| --- | --- |
| `protos/VCSECv3.10.14.proto`（trifinite/vcsec-archive） | 字段号、枚举数值的权威表（`common/spec.js` 头注释已标注；`MESSAGES` 表即字段号映射） |
| gist `LexNastin/fc55736f…` | 端到端绑定 + 加密指令的样例报文与字节核对 |
| `teslabtapi.com/docs/start` | GATT（Service `…0211` / 写 `0212` / 收 `0213` / 版本 `0214`）、2 字节大端长度前缀、BLE 命名规则（新 `Tesla `+VIN 后 6 位 / 旧 `S`+SHA1(VIN)hex 前 16 位+末位 C/R/D/P） |
| `teslabtapi.com/docs/more/rke` | RKE 动作枚举、AES-GCM key/nonce/aad 推导 |

协议里最容易写错的一点单独强调：**proto3 的 singular 标量等于 0 时不编码**。所以 `UNLOCK(0)` 的内层报文是**空字节串**（车辆按默认 0 解释），而 `LOCK(1)` 是 `10 01`；`GET_STATUS(0)` 的请求体因此短到只有 4 字节。

---

## 11. 请评审 AI 重点回答的问题

1. §3 里 F9（INDICATE 订阅）与 F7（MTU）是唯一的 uni 硬边界吗？还有没有别的 API（如 `uni.writeBLECharacteristicValueType`、UTS 插件、`plus.bluetooth` 直接调用）能在**不引入第三方原生插件**的前提下打开 0x2902？
2. F11 的绑定报文（`signatureType = PRESENT_KEY(2)` + 明文内层 + `permission` 四项 + `formFactor=7`）与官方固件期望是否一致？`permission` 现在按 proto3 默认走 **packed**（实际字节 `12 04 02 01 04 03`），车辆固件是否接受 packed，还是必须退化成 unpacked 的逐个 `10 xx`？权限集合的内容与顺序有没有问题？
3. F12/F13 的密钥推导链（`sharedKey = SHA1(ECDH_x)[:16]`、`nonce = 4B 大端 counter`、`aad = 空`、`signature = 16B GCM tag`、`keyId = SHA1(pub)[:4]`）有没有和现行固件不符之处？
4. counter 与临时公钥的生命周期管理（换连接清 `sharedKey`、counter 只增、`syncCounter` 只上调）是否存在会导致 `IV_SMALLER_THAN_EXPECTED` 的边界（例如并发点击、断连重连、App 被杀）？
5. 若 Q1/Q2 判定为「uni 做不到」，§9 的 B/C 哪条改动量最小？`common/` 的 8 个模块里哪些可以直接复用、哪些必须原生替代？（我方已知最需要原生替代的是 `aes.js:randomBytes` —— 纯 JS 的 xoshiro128**，非 CSPRNG，见 §8.6。）
