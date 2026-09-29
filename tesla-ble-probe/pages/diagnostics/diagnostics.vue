<template>
  <view class="tf-page">
    <!-- ============================================================ 台账概览
      这一页不反向解析日志文本：所有结论来自 src/store/diagnostic-store.js 那份结构化台账
      （动作的返回值直接登记），所以「成功几次 / 失败几次」是按真实 ok 计数，不是猜的。 -->
    <view class="tf-card">
      <view class="hd">
        <text class="tf-card-title hd-title">动作台账</text>
        <view class="tf-chip" :class="connChip.cls">{{ connChip.text }}</view>
      </view>
      <view class="row chips">
        <view class="tf-chip">共 {{ d.total }} 次</view>
        <view class="tf-chip tf-chip-on">成功 {{ d.okCount }}</view>
        <view class="tf-chip" :class="d.failCount ? 'tf-chip-err' : ''">失败 {{ d.failCount }}</view>
        <view class="tf-chip">只留最近 {{ MAX }} 条</view>
      </view>
      <view class="tip">
        台账里只有「动作名 + 结论原文」，绝不存载荷、密钥、counter、共享秘密 —— 所以这份列表可以放心整段抄给别人看。
      </view>
    </view>

    <!-- ============================================================ 充电盖板 A/B 谁成功
      同一个物理动作两条协议路径（车机域 / VCSEC），对照的历史就在台账里，不必回控制页翻。
      动作名与 tag 必须和 vehicle-api 里 tracked() 登记时用的字符串逐字一致，否则命中不了。 -->
    <view class="tf-card">
      <view class="tf-card-title">充电盖板 · 两条路径谁成功</view>
      <view class="tip">
        盖板当前：{{ v.chargePortOpenText }}{{ v.chargePortLatch ? ' · 卡扣 ' + v.chargePortLatch : '' }}
      </view>
      <view v-for="p in paths" :key="p.key" class="ab">
        <view class="ab-head">
          <text class="ab-name">{{ p.title }}</text>
          <text class="tip ab-proto">{{ p.proto }}</text>
        </view>
        <view class="ab-body">
          <text class="ab-res" :class="p.resCls">{{ p.resText }}</text>
        </view>
      </view>
      <view class="tip">
        两条都按过才算对照。哪条真的让上面「盖板当前」变了，哪条就是这台车认的路径；只看结论原文是不够的。
      </view>
    </view>

    <!-- ============================================================ 最近记录 -->
    <view class="tf-card">
      <view class="hd">
        <text class="tf-card-title hd-title">最近记录（新→旧）</text>
        <view class="row">
          <button class="btn btn-plain mini" size="mini" @click="toggleLimit">
            {{ limit >= MAX ? '只看最近 20' : '看全部 ' + MAX }}
          </button>
          <button class="btn btn-plain mini" size="mini" @click="ask('clear')">清空</button>
        </view>
      </view>

      <view v-if="!recs.length" class="tf-empty">
        还没有任何动作记录。到车辆 / 控制 / 温度页按一条命令，或者用下面「再跑几条」，这里就会有内容。
      </view>

      <view v-for="(r, i) in recs" :key="r.at + '-' + i" class="rec">
        <tf-icon :name="r.ok ? 'check' : 'warn'" size="30rpx" :color="r.ok ? '#46d68a' : '#ff6b6b'" />
        <view class="rec-body">
          <view class="rec-name">
            {{ r.name }}
            <text class="rec-tag">{{ r.tag || '无域' }}</text>
          </view>
          <view class="rec-text" :class="{ 'rec-bad': !r.ok }">{{ r.text || '（这条没有返回结论原文）' }}</view>
          <view class="rec-time">{{ clock(r.at) }} · {{ ago(r.at, now) }}</view>
        </view>
      </view>
    </view>

    <!-- ============================================================ 再跑几条 -->
    <view class="tf-card">
      <view class="tf-card-title">再跑几条看看</view>
      <view class="row">
        <button class="btn" size="mini" :loading="busy === 91" @click="doRefresh">刷新全部数据</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 81" @click="doStatus">查车辆状态</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 82" @click="doWhitelist">查白名单</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 83" @click="doHandshake">重新握手</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 84" @click="doPing">车机 Ping</button>
      </view>
      <view class="tip">
        查白名单走 VCSEC，Ping 和 GetVehicleData 走车机域：两边的会话、counter 各是各的，
        一条失败不代表另一条也不通。失败原文会同时落进上面的台账。
      </view>
      <view class="row legacy">
        <button class="btn btn-plain" size="mini" @click="goLegacy">④ 旧车控页（界面对照）</button>
      </view>
      <view class="tip">
        这一页是「控制」tab 的前身：两边都有的动作，参数与调用链和它一字不差（同一批 vehicle-api 函数），
        区别只在界面 —— 老那套 CSS 图标 + 九宫格，没有俯视车身点位，也没有后来加的「驾驶授权」按钮
        （那条命令在 ③ RKE 控制台用自定义 action=20 发，走的是同一个 sendRke）。
        怀疑问题出在新界面的交互（点位读数、滑动确认）而不是协议本身时，从这里按同一条命令再试一次。
        它不在底部导航里，看完用系统返回键回来，台账照样会把它的结论收进来。
      </view>
    </view>

    <!-- ============================================================ 运行日志
      逐行的过程（收发帧、重试、超时）只有日志里有，台账只留结论，所以两者要并排看。 -->
    <view class="tf-card">
      <view class="tf-card-title">运行日志</view>
      <log-box height="480rpx" />
    </view>

    <confirm-dialog
      :show="dlg === 'clear'"
      title="清空诊断台账？"
      desc="所有动作的历史结论会被抹掉，成功 / 失败计数归零。"
      tip="正在对照 A/B、或准备把日志发给别人时别清 —— 清了就看不出「刚才那条到底成没成」。运行日志不受影响。"
      confirm-text="清空台账"
      :seconds="2"
      :danger="true"
      @confirm="onConfirm"
      @cancel="dlg = ''"
    />

    <tf-tabbar active="diagnostics" />
  </view>
</template>

<script>
import {
  log,
  connection,
  vehicleView,
  subscribeVehicle,
  subscribeDiagnostics,
  diagnostics,
  recentResults,
  lastResult,
  clearDiagnostics,
  MAX_DIAGNOSTICS,
  VC
} from '@/src/services/index.js'
import { vehicleData, vehicleDataAll, pingInfotainment, queries, checkWhitelisted, handshake } from '@/src/services/vehicle-api.js'
import { ago, clock } from '@/src/ui/format.js'
import { notify } from '@/src/infra/platform/notify.js'

const CONN = {
  idle: { text: '未连接', cls: '' },
  scanning: { text: '扫描中', cls: 'tf-chip-warn' },
  connecting: { text: '连接中', cls: 'tf-chip-warn' },
  connected: { text: '已连接', cls: 'tf-chip-on' },
  disconnected: { text: '已断开', cls: 'tf-chip-err' }
}

// 与 pages/control/control.vue 的 PATHS 同一批字符串：
// name 是 vehicle-api 里 tracked() 登记进台账的动作名，tag 区分协议路径，改一个字就命中不到。
const PATHS = [
  {
    key: 'A',
    title: '路径 A · 车机域',
    proto: 'car_server ChargePortDoorOpen / Close',
    names: ['打开充电盖板', '关闭充电盖板'],
    tag: 'INFOTAINMENT'
  },
  {
    key: 'B',
    title: '路径 B · VCSEC',
    proto: 'closureMoveRequest{chargePort: OPEN / CLOSE}',
    names: ['OPEN_CHARGE_PORT', 'CLOSE_CHARGE_PORT'],
    tag: 'VCSEC'
  }
]

export default {
  data() {
    return {
      v: vehicleView(),
      d: { total: diagnostics.total, okCount: diagnostics.okCount, failCount: diagnostics.failCount },
      recs: recentResults(20),
      now: Date.now(),
      busy: 0,
      dlg: '',
      limit: 20,
      MAX: MAX_DIAGNOSTICS,
      _offV: null,
      _offD: null,
      _timer: null
    }
  },
  computed: {
    connChip() {
      return CONN[connection.connection] || { text: '未知', cls: '' }
    },
    paths() {
      const out = []
      for (const p of PATHS) {
        let best = null
        for (const n of p.names) {
          const r = lastResult(n, p.tag)
          if (r && (!best || r.at > best.at)) best = r
        }
        out.push({
          key: p.key,
          title: p.title,
          proto: p.proto,
          resCls: best ? (best.ok ? 'tf-chip-on' : 'tf-chip-err') : '',
          resText: best
            ? (best.ok ? '最近一次成功 · ' : '最近一次失败 · ') + best.name + ' · ' + ago(best.at, this.now)
            : '这条路径还没试过'
        })
      }
      return out
    }
  },
  onShow() {
    this.tick()
    this.pull()
    this._offV = subscribeVehicle(() => {
      this.v = vehicleView()
    })
    // 台账一变就重新取：动作是在别的页面上按的，这一页靠订阅把结论同步过来
    this._offD = subscribeDiagnostics(() => {
      this.pull()
    })
    this._timer = setInterval(() => this.tick(), 1000)
  },
  onHide() {
    this.teardown()
  },
  unmounted() {
    this.teardown()
  },
  methods: {
    ago,
    clock,
    tick() {
      this.now = Date.now()
    },
    pull() {
      this.recs = recentResults(this.limit)
      this.d = { total: diagnostics.total, okCount: diagnostics.okCount, failCount: diagnostics.failCount }
    },
    teardown() {
      clearInterval(this._timer)
      if (this._offV) {
        this._offV()
        this._offV = null
      }
      if (this._offD) {
        this._offD()
        this._offD = null
      }
    },
    toast(t) {
      notify(t)
    },
    // 与其他页同一套：一次只允许一条 BLE 请求在路上，错误一律弹窗带原文
    async guard(n, fn) {
      if (this.busy) {
        this.toast('上一步还没结束')
        return
      }
      this.busy = n
      try {
        await fn()
      } catch (e) {
        const msg = ((e && (e.message || e.errMsg)) || String(e)) + (e && e.errCode !== undefined ? ' errCode=' + e.errCode : '')
        log('error', '未捕获错误: ' + msg)
        this.toast('失败：' + msg)
      } finally {
        this.busy = 0
        this.tick()
      }
    },
    report(r) {
      this.toast(r.text)
      log(r.ok ? 'ok' : 'warn', r.text)
      return r
    },
    ask(key) {
      if (this.busy) {
        this.toast('上一步还没结束')
        return
      }
      this.dlg = key
    },
    onConfirm() {
      const key = this.dlg
      this.dlg = ''
      if (key !== 'clear') return
      clearDiagnostics()
      this.pull()
      this.toast('诊断台账已清空')
    },
    toggleLimit() {
      this.limit = this.limit >= MAX_DIAGNOSTICS ? 20 : MAX_DIAGNOSTICS
      this.pull()
    },
    doRefresh() {
      return this.guard(91, async () => {
        this.report(await vehicleData(vehicleDataAll().slice()))
      })
    },
    doStatus() {
      return this.guard(81, async () => {
        this.report(await queries.status())
      })
    },
    doWhitelist() {
      return this.guard(82, async () => {
        this.report(await checkWhitelisted())
      })
    },
    // force=true：这里就是「重新握手」按钮，复用会话没意义，必须真的重做一次看它成不成
    doHandshake() {
      return this.guard(83, async () => {
        this.report(await handshake(true, VC))
      })
    },
    doPing() {
      return this.guard(84, async () => {
        this.report(await pingInfotainment())
      })
    },
    // 非 tab 页只能用 navigateTo，返回靠系统返回键（这一页没有标签栏可切）
    goLegacy() {
      uni.navigateTo({ url: '/pages/car-control/car-control' })
    }
  }
}
</script>

<style scoped>
.hd {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  margin-bottom: 14rpx;
}

.hd-title {
  margin-bottom: 0;
}

.chips {
  margin-bottom: 6rpx;
}

.mini {
  height: 52rpx;
  line-height: 52rpx;
  font-size: 21rpx;
  padding: 0 16rpx;
}

.ab {
  margin-top: 16rpx;
  padding-top: 14rpx;
  border-top: 1rpx solid var(--line);
}

.legacy {
  margin-top: 14rpx;
}

.ab-head {
  display: flex;
  flex-direction: row;
  align-items: baseline;
  flex-wrap: wrap;
}

.ab-name {
  font-size: 26rpx;
  color: var(--text);
  margin-right: 12rpx;
}

.ab-proto {
  flex: 1;
  font-family: monospace;
  word-break: break-all;
}

.ab-body {
  display: flex;
  flex-direction: row;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 4rpx;
}

.ab-res {
  font-size: 21rpx;
  line-height: 30rpx;
  padding: 4rpx 12rpx;
  border-radius: 12rpx;
  color: var(--text-3);
  word-break: break-all;
}

/* 一条记录：图标 + 动作名/域 + 结论原文 + 时间。结论原文一律不截断 */
.rec {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  padding: 16rpx 2rpx;
  border-bottom: 1rpx solid var(--line);
}

.rec:last-child {
  border-bottom: none;
}

.rec-body {
  flex: 1;
  margin-left: 16rpx;
}

.rec-name {
  display: flex;
  flex-direction: row;
  align-items: baseline;
  flex-wrap: wrap;
  font-size: 25rpx;
  color: var(--text);
}

.rec-tag {
  margin-left: 12rpx;
  padding: 2rpx 10rpx;
  border-radius: 10rpx;
  background-color: var(--card-3);
  color: var(--text-3);
  font-size: 18rpx;
  font-family: monospace;
}

.rec-text {
  margin-top: 6rpx;
  font-size: 22rpx;
  line-height: 32rpx;
  color: var(--text-2);
  word-break: break-all;
  white-space: pre-wrap;
}

.rec-bad {
  color: var(--err);
}

.rec-time {
  margin-top: 4rpx;
  font-size: 19rpx;
  color: var(--text-3);
}
</style>
