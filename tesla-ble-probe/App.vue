<script>
import { loadKey, loadBind, startAutoReconnectLoop, stopAutoReconnectLoop, hasKey, hasBind, log } from '@/src/services/index.js'
import { keepScreenOn, logRuntimeEnv } from '@/src/infra/platform/runtime.js'

export default {
  onLaunch() {
    log('info', 'Tesla BLE 离线钥匙探针启动（V3 协议 / 纯 JS 密码学 + uni 原生蓝牙，不依赖任何 npm 原生插件）')
    logRuntimeEnv(log)
    loadKey()
    // 绑定档案：第一次绑车时记下的车辆蓝牙地址 / 广播名，重启后靠它自动回连
    loadBind()
    // 探针全程保持亮屏：绑定要等 60 秒刷钥匙卡，息屏会让整轮作废
    keepScreenOn(true)
  },
  async onShow() {
    // 真实场景：人离车还有几十米就点开 App，这一次必然连不上。所以前台期间要一直试
    // （退避 3 → 6 → 12 → 24 → 30 秒），走到车边那一轮自己就连上了，不必杀后台重开。
    // 准入判断、单飞锁都在 src/domain/auto-reconnect.js 里：没钥匙 / 没档案 / 已连着 / 主动断开过 一律跳过。
    if (!hasKey() || !hasBind()) return
    const r = await startAutoReconnectLoop('回到前台')
    if (r.ok) log('ok', r.text)
    else if (!r.skipped || (r.skipped !== 'already' && r.skipped !== 'nokey' && r.skipped !== 'nobind' && r.skipped !== 'suspended' && r.skipped !== 'stopped')) {
      log('warn', '自动连接未完成：' + r.text)
    }
  },
  onHide() {
    // 退到后台就停：Android 后台蓝牙扫描受系统限制，定时器也可能被冻结，
    // 与其留一个不可控的排期，不如回到前台时重新从最低档开始（onShow 会再起一轮）。
    stopAutoReconnectLoop('退到后台')
  },
  onError(e) {
    log('error', '全局异常: ' + (e && e.message ? e.message : e))
  }
}
</script>

<style>
/* ---------------------------------------------------------------- 深色主题
   全站只有这一份调色板：页面和组件一律读 CSS 变量，不许再写死颜色值。
   变量挂在 page 上（webview 里 page 就是根节点，自定义属性会往下继承，
   组件的 scoped 样式一样能取到），老页面用的类名原样保留，只是换成深色系。 */
page {
  --bg: #0f1317;
  --bg-top: #1d2731;
  --bar: #0b0e12;
  --card: #191f26;
  --card-2: #222a33;
  --card-3: #2b3540;
  --line: #2c3540;
  --text: #f2f5f8;
  --text-2: #b5bfcb;
  --text-3: #7c8794;
  --accent: #4a9eff;
  --accent-2: #1f5fa8;
  --ok: #46d68a;
  --warn: #ffb020;
  --err: #ff6b6b;

  background-color: var(--bg);
  background-image: linear-gradient(180deg, var(--bg-top) 0%, var(--bg) 46%);
  color: var(--text);
  font-size: 28rpx;
}

.wrap,
.tf-page {
  min-height: 100vh;
  box-sizing: border-box;
  padding: 20rpx 24rpx 40rpx 24rpx;
}

.card,
.tf-card {
  background-color: var(--card);
  border: 1rpx solid var(--line);
  border-radius: 20rpx;
  padding: 22rpx;
  margin-bottom: 22rpx;
}

.tf-card-flat {
  background-color: var(--card);
  border-radius: 20rpx;
  padding: 22rpx;
  margin-bottom: 22rpx;
}

.tf-card-title {
  font-size: 26rpx;
  color: var(--text-3);
  margin-bottom: 14rpx;
}

.title {
  font-size: 28rpx;
  font-weight: bold;
  color: var(--text);
  margin-bottom: 12rpx;
}

.row {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
}

.tip {
  font-size: 22rpx;
  color: var(--text-3);
  line-height: 32rpx;
}

.status {
  font-family: monospace;
  font-size: 22rpx;
  color: #79c0ff;
  line-height: 32rpx;
  word-break: break-all;
}

.muted {
  color: var(--text-3);
}

/* ---------------------------------------------------------------- 按钮 */
.btn {
  margin: 6rpx 8rpx 6rpx 0;
  padding: 0 22rpx;
  height: 76rpx;
  line-height: 76rpx;
  font-size: 26rpx;
  background-color: var(--accent-2);
  color: var(--text);
  border-radius: 12rpx;
  display: inline-block;
}

.btn-plain {
  background-color: var(--card-3);
  color: var(--text-2);
}

.btn-danger {
  background-color: #6b2020;
  color: #ffd7d7;
}

.btn::after {
  border: none;
}

.btn[disabled] {
  opacity: 0.45;
}

/* ---------------------------------------------------------------- 表单 */
.field {
  display: flex;
  flex-direction: row;
  align-items: center;
  margin-bottom: 12rpx;
}

.field-label {
  width: 110rpx;
  font-size: 26rpx;
  color: var(--text-2);
}

.input {
  flex: 1;
  height: 72rpx;
  padding: 0 16rpx;
  font-size: 26rpx;
  border: 1rpx solid var(--line);
  border-radius: 12rpx;
  background-color: var(--card-2);
  color: var(--text);
}

.mono {
  font-family: monospace;
  font-size: 22rpx;
  word-break: break-all;
}

/* ---------------------------------------------------------------- 车控格子
   动作面板共用：一个大按钮 = 图标 + 名字 + 一行小字（状态或协议域）。 */
.grid {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  justify-content: space-between;
}

.tile {
  width: 32%;
  min-width: 180rpx;
  margin-bottom: 16rpx;
  padding: 22rpx 8rpx 18rpx 8rpx;
  background-color: var(--card-2);
  border: 1rpx solid var(--line);
  border-radius: 16rpx;
  text-align: center;
}

.tile-name {
  margin-top: 12rpx;
  font-size: 24rpx;
  color: var(--text);
}

.tile-sub {
  margin-top: 4rpx;
  font-size: 19rpx;
  color: var(--text-3);
  word-break: break-all;
}

/* 按下去/正在等回执：整块压暗，避免重复点 */
.tile-off {
  opacity: 0.45;
}

/* 状态类图标点亮时用的强调色 */
.tile-on {
  background-color: #17304a;
  border-color: var(--accent-2);
}

/* ---------------------------------------------------------------- 新 UI 通用件 */

/* 大数字：首页的电量百分比 */
.tf-hero {
  padding: 8rpx 4rpx 24rpx 4rpx;
}

.tf-name {
  font-size: 44rpx;
  font-weight: bold;
  color: var(--text);
  line-height: 60rpx;
}

.tf-batt {
  font-size: 76rpx;
  font-weight: 300;
  color: var(--text);
  line-height: 88rpx;
}

.tf-batt-unit {
  font-size: 34rpx;
  color: var(--text-2);
  margin-left: 4rpx;
}

.tf-sub {
  font-size: 24rpx;
  color: var(--text-2);
  line-height: 36rpx;
}

/* 状态小胶囊：已驻车 / 已上锁 / 未连接 */
.tf-chip {
  display: inline-flex;
  align-items: center;
  height: 40rpx;
  padding: 0 16rpx;
  margin-right: 10rpx;
  border-radius: 20rpx;
  font-size: 21rpx;
  background-color: var(--card-3);
  color: var(--text-2);
}

.tf-chip-on {
  background-color: rgba(70, 214, 138, 0.16);
  color: var(--ok);
}

.tf-chip-warn {
  background-color: rgba(255, 176, 32, 0.16);
  color: var(--warn);
}

.tf-chip-err {
  background-color: rgba(255, 107, 107, 0.16);
  color: var(--err);
}

/* 快捷图标行（首页那一排 5 个） */
.tf-quick {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  padding: 6rpx 0 2rpx 0;
}

.tf-qi {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 14rpx 0;
  border-radius: 16rpx;
}

.tf-qi-label {
  margin-top: 10rpx;
  font-size: 21rpx;
  color: var(--text-2);
  text-align: center;
}

.tf-qi-off {
  opacity: 0.4;
}

/* 列表行（首页「控制 / 温度 / 地点 …」那一列） */
.tf-li {
  display: flex;
  flex-direction: row;
  align-items: center;
  padding: 26rpx 4rpx;
  border-bottom: 1rpx solid var(--line);
}

.tf-li:last-child {
  border-bottom: none;
}

.tf-li-body {
  flex: 1;
  margin-left: 22rpx;
}

.tf-li-title {
  font-size: 29rpx;
  color: var(--text);
}

.tf-li-sub {
  margin-top: 6rpx;
  font-size: 22rpx;
  color: var(--text-3);
  word-break: break-all;
}

.tf-li-value {
  margin-right: 10rpx;
  font-size: 24rpx;
  color: var(--text-2);
  text-align: right;
}

/* 键值表（信息页 / 温度页的读数） */
.tf-kv {
  display: flex;
  flex-direction: row;
  align-items: center;
  padding: 18rpx 2rpx;
  border-bottom: 1rpx solid var(--line);
}

.tf-kv:last-child {
  border-bottom: none;
}

.tf-kv-label {
  width: 240rpx;
  font-size: 25rpx;
  color: var(--text-2);
}

.tf-kv-value {
  flex: 1;
  font-size: 27rpx;
  color: var(--text);
  text-align: right;
  word-break: break-all;
}

.tf-empty {
  padding: 40rpx 20rpx;
  text-align: center;
  color: var(--text-3);
  font-size: 24rpx;
  line-height: 36rpx;
}
</style>
