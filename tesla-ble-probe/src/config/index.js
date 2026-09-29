// 全站魔法数登记处：存储键名、日志上限、退避阶梯、扫描窗口。
//
// 存储键一旦上线就**永不改名**：改一个字符等于把真机上已经存在的私钥和两个域的
// counter 当成「第一次运行」，回退 counter 会当场制造 IV 洞，只能重新绑钥匙。

export const KEY_STORE = 'tesla_probe_key_v1';

// 手输的 VIN：扫描时按它匹配广播名，也是绑定档案里 vin 字段的初始来源。
// 与密钥、绑定档案是两个键 —— 换了车、清了档案都不该把「上次输入的是哪台车」弄丢。
export const VIN_STORE = 'tesla_probe_vin_v1';

// 绑定档案：车辆蓝牙地址（Android=MAC / iOS=系统 UUID）、广播名、VIN、绑上去的 keyId、时间戳。
// 没有这一份，重启 App 就只能重新「扫描 + 手选设备」，而私钥和两个域的 counter 明明都还在。
export const BIND_STORE = 'tesla_probe_bind_v1';

// ---------------------------------------------------------------- V3 会话的存储键
//
// 为什么 counter 一定要落盘：车辆侧记录「上次用过的 counter」，
// 一旦我们重启 App 后从 1 重来，AES-GCM 的 nonce 被重复使用，
// 车辆会直接回 FAULT_IV_SMALLER_THAN_EXPECTED / TOKEN_AND_COUNTER_INVALID，
// 而且这个洞对同一把 key 是永久的 —— 只能重新绑定。所以 counter 只增不减。
//
// 为什么 counter 还要**按 domain 分开**落盘（本项目最重要的一个结构决定）：
//   官方 internal/dispatcher/dispatcher.go:36 是 `sessions map[universal.Domain]*session`，
//   :131-156 StartSessions 对 VCSEC 与 INFOTAINMENT **分别**握手；
//   pkg/protocol/domains.go:7 写明「Each Domain manages its own key pair」；
//   C++ 参考实现同构：tesla-ble/src/client.cpp:46-52 initialize_peers_ 建
//   session_vcsec_ / session_infotainment_，include/peer.h 每个 Peer 各自持有
//   domain_ / counter_ / epoch_ / shared_secret_sha1_。
//   → 两个域的共享密钥、epoch、counter 全都不相通。如果把车机（INFOTAINMENT）的包
//     用 VCSEC 的 counter 发出去（或反之），车辆一侧就会留下一个「永远填不上的洞」，
//     之后这个域每条命令都回 IV_SMALLER_THAN_EXPECTED，只能重新绑钥匙。
//   所以这里一个 domain 一个存储键，绝不允许两个域复用同一个 counter。
//
// VCSEC 那一份**沿用老键名** tesla_probe_v3_session_v1：已经绑好车、counter 跑到几百的
// 真机不会因为这次升级而回退 counter（回退 = 立刻制造 IV 洞 = 重新绑钥匙）。
export const V3_SESSION_STORE = 'tesla_probe_v3_session_v1';
export const V3_INFOTAINMENT_STORE = 'tesla_probe_v3_infotainment_v1';

// 一轮完整绑定（60 秒等待 + 每帧 hex + 逐帧解码）就能产生上百条日志，
// 留 400 条会在复测中途把最早的关键日志滚掉 —— 放大到 1000。
export const MAX_LOGS = 1000;

// 报文控制台（③ 页）只留最近这么多次原始收发，再多就没人看得完了
export const RECENT_RAW_MAX = 200;

// 阶梯 3 → 6 → 12 → 24 → 30 秒封顶；只有「自动重试」才升档，
// 手动触发和断线重连都归零重来（这两种情况下用户就在车旁边，要的是马上连上）。
export const RETRY_STEPS_MS = [3000, 6000, 12000, 24000, 30000];

// 手动「扫描并连接」按 VIN 匹配广播名的窗口
export const SCAN_TIMEOUT_MS = 20000;
// 自动重连那一轮的扫描窗口（opts.scanMs 缺省值）
export const AUTO_RECONNECT_SCAN_MS = 10000;
