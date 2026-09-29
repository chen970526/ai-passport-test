<template>
  <view class="tf-page">
    <!-- ============================================================ 车辆卡
      界面只读 vehicleView()：电量/续航/挡位/锁状态都是 store 归一化过的语义字段，
      这一层不许再去挖 closures_state 之类的嵌套结构，也不许给「未知」兜底成 0/false。 -->
    <view class="tf-card">
      <view class="row">
        <text class="tf-name">{{ carName }}</text>
        <view class="tf-chip" :class="connChip.cls">{{ connChip.text }}</view>
      </view>

      <view v-if="v.hasData">
        <view class="tf-hero">
          <view class="batt">
            <text class="tf-batt">{{ v.batteryPercent === null ? '--' : v.batteryPercent }}</text>
            <text class="tf-batt-unit">%</text>
            <text class="tf-sub batt-note">{{ v.rangeText }}</text>
          </view>
          <view class="carpic">
            <tf-icon name="car-side" size="560rpx" height="210rpx" color="#dfe6ee" :weight="1.3" />
          </view>
        </view>
        <view class="row chips">
          <view class="tf-chip">{{ v.shiftText }}</view>
          <view class="tf-chip" :class="v.locked === false ? 'tf-chip-warn' : ''">{{ v.lockedText }}</view>
          <view class="tf-chip" :class="chargeChip.cls">{{ chargeChip.text }}</view>
        </view>
        <view class="tip fresh">{{ ago(v.updatedAt, now) }}更新 · 共 {{ v.categories.length }} 类数据</view>
      </view>

      <view v-else class="tf-empty">
        还没有车辆数据。人在车边、连上车之后点下面的「刷新」拉一次 GetVehicleData。
      </view>

      <!-- 快捷动作：只用协议里已登记的能力（VCSEC RKE / ClosureMoveRequest / 车机域 GetVehicleData） -->
      <view class="tf-quick">
        <view class="tf-qi" :class="{ 'tf-qi-off': busy !== 0 }" @click="doLock">
          <tf-icon name="lock" size="52rpx" />
          <text class="tf-qi-label">上锁</text>
        </view>
        <view class="tf-qi" :class="{ 'tf-qi-off': busy !== 0 }" @click="ask('unlock')">
          <tf-icon name="unlock" size="52rpx" />
          <text class="tf-qi-label">解锁</text>
        </view>
        <view class="tf-qi" :class="{ 'tf-qi-off': busy !== 0 }" @click="ask('frunk')">
          <tf-icon name="frunk" size="52rpx" />
          <text class="tf-qi-label">前备箱</text>
        </view>
        <view class="tf-qi" :class="{ 'tf-qi-off': busy !== 0 }" @click="ask('trunk')">
          <tf-icon name="trunk" size="52rpx" />
          <text class="tf-qi-label">后备箱</text>
        </view>
        <view class="tf-qi" :class="{ 'tf-qi-off': busy !== 0 }" @click="refresh">
          <tf-icon name="refresh" size="52rpx" />
          <text class="tf-qi-label">刷新</text>
        </view>
      </view>
    </view>

    <!-- ============================================================ 功能列表 -->
    <view class="tf-card">
      <view v-for="r in rows" :key="r.key" class="tf-li" hover-class="tf-li-hover" @click="go(r)">
        <tf-icon :name="r.icon" size="44rpx" />
        <view class="tf-li-body">
          <view class="tf-li-title">{{ r.title }}</view>
          <view class="tf-li-sub">{{ r.sub }}</view>
        </view>
        <text class="tf-li-value">{{ r.value || '' }}</text>
        <tf-icon name="chevron" size="28rpx" color="#7c8794" />
      </view>
    </view>

    <!-- ============================================================ 连接 -->
    <view class="tf-card">
      <view class="tf-card-title">链路</view>
      <view class="status">{{ status }}</view>
      <view class="row">
        <button class="btn" size="mini" :loading="busy === 1" @click="doConnect">连接车辆</button>
        <button class="btn btn-plain" size="mini" @click="doStop">停止重连</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 2" @click="doPing">车机 Ping</button>
      </view>
      <view class="tip">{{ auto }}</view>
    </view>

    <!-- 二次确认：解锁是危险动作（要倒计时），开盖只需一次确认 -->
    <confirm-dialog
      :show="dlg !== ''"
      :title="dlgTitle"
      :desc="dlgDesc"
      :tip="dlgTip"
      :confirm-text="dlgOk"
      :seconds="dlg === 'unlock' ? 3 : 0"
      :danger="dlg === 'unlock'"
      @confirm="onConfirm"
      @cancel="dlg = ''"
    />

    <tf-tabbar active="home" />
  </view>
</template>

<script>
import { log, bind, connection, vehicleView, subscribeVehicle, startAutoReconnectLoop, stopAutoReconnectLoop, describeAutoLoop, hasBind, hasKey, describeBind, lastResult } from '@/src/services/index.js'
import { statusText, sendRke, sendClosure, rkeEnum, closureEnum, pingInfotainment, vehicleData, vehicleDataAll } from '@/src/services/vehicle-api.js'
import { ago, unit, yesNo } from '@/src/ui/format.js'
import { notify } from '@/src/infra/platform/notify.js'

const CONN = {
  idle: { text: '未连接', cls: '' },
  scanning: { text: '扫描中', cls: 'tf-chip-warn' },
  connecting: { text: '连接中', cls: 'tf-chip-warn' },
  connected: { text: '已连接', cls: 'tf-chip-on' },
  disconnected: { text: '已断开', cls: 'tf-chip-err' }
}

const DLG = {
  unlock: {
    title: '确认解锁全部车门？',
    desc: '四个车门和后备箱会同时失去锁定，车辆不会自动重新上锁。',
    tip: '人不在车边不要点确认。',
    ok: '解锁'
  },
  frunk: {
    title: '打开前备箱？',
    desc: 'VCSEC 的 ClosureMoveRequest{frontTrunk: OPEN}，指令发出去没有撤销这一步。',
    tip: '确认周围没人手扶盖子。',
    ok: '打开'
  },
  trunk: {
    title: '打开后备箱？',
    desc: 'VCSEC 的 ClosureMoveRequest{rearTrunk: OPEN}，指令发出去没有撤销这一步。',
    tip: '注意车辆后方空间。',
    ok: '打开'
  }
}

export default {
  data() {
    return {
      v: vehicleView(),
      status: '',
      auto: '',
      now: Date.now(),
      busy: 0,
      dlg: '',
      _off: null,
      _timer: null
    }
  },
  computed: {
    carName() {
      if (bind.name) return bind.name
      if (bind.vin) return 'VIN …' + String(bind.vin).slice(-6)
      return '未绑定车辆'
    },
    connChip() {
      return CONN[connection.connection] || { text: '未知', cls: '' }
    },
    chargeChip() {
      if (this.v.chargingState === 'Charging') return { text: '充电中 ' + unit(this.v.chargerPower, ' kW'), cls: 'tf-chip-on' }
      if (this.v.chargingState) return { text: '充电：' + this.v.chargingState, cls: '' }
      return { text: '充电：' + unit(this.v.chargeLimitSoc, '%'), cls: '' }
    },
    rows() {
      const v = this.v
      const tire = v.hasTirePressure
        ? [v.tire.fl, v.tire.fr, v.tire.rl, v.tire.rr].map((p) => unit(p, '', 1)).join(' / ')
        : '未知'
      return [
        {
          key: 'control',
          title: '控制',
          icon: 'lock',
          url: '/pages/control/control',
          sub: v.lockedText + ' · 前备箱' + yesNo(v.frunkOpen, '开着', '关着') + ' · 后备箱' + yesNo(v.trunkOpen, '开着', '关着'),
          value: ''
        },
        {
          key: 'climate',
          title: '温度',
          icon: 'thermo',
          url: '/pages/climate/climate',
          sub: '车内 ' + unit(v.insideTemp, '℃') + ' · 车外 ' + unit(v.outsideTemp, '℃'),
          value: v.climateOn === null ? '' : v.climateOn ? '空调开' : '空调关'
        },
        {
          key: 'info',
          title: '信息',
          icon: 'info',
          url: '/pages/info/info',
          sub: '里程 ' + unit(v.odometerKm, ' km') + ' · 胎压 ' + tire + ' bar',
          value: v.hasLocation ? '有位置' : ''
        },
        { key: 'diagnostics', title: '诊断', icon: 'pulse', url: '/pages/diagnostics/diagnostics', sub: this.diagSub, value: '' },
        { key: 'binding', title: '绑定与钥匙', icon: 'key', url: '/pages/binding/binding', sub: describeBind(), value: '' }
      ]
    },
    diagSub() {
      const r = lastResult('GetVehicleData（全部）')
      if (!r) return '本会话还没有动作记录'
      return (r.ok ? '成功 ' : '失败 ') + r.name + ' · ' + ago(r.at, this.now)
    },
    dlgTitle() {
      return (DLG[this.dlg] || DLG.unlock).title
    },
    dlgDesc() {
      return (DLG[this.dlg] || DLG.unlock).desc
    },
    dlgTip() {
      return (DLG[this.dlg] || DLG.unlock).tip
    },
    dlgOk() {
      return (DLG[this.dlg] || DLG.unlock).ok
    }
  },
  onShow() {
    this.tick()
    this._off = subscribeVehicle(() => {
      this.v = vehicleView()
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
    unit,
    yesNo,
    tick() {
      this.now = Date.now()
      this.status = statusText()
      this.auto = describeAutoLoop()
    },
    teardown() {
      clearInterval(this._timer)
      if (this._off) {
        this._off()
        this._off = null
      }
    },
    toast(t) {
      notify(t)
    },
    // 一次只允许一条 BLE 请求在路上；错误一律弹窗带原文（与旧页同一套）
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
      if (key === 'unlock') {
        return this.guard(12, async () => {
          this.report(await sendRke(rkeEnum('RKE_ACTION_UNLOCK'), 'UNLOCK'))
        })
      }
      if (key === 'frunk' || key === 'trunk') {
        const field = key === 'frunk' ? 'frontTrunk' : 'rearTrunk'
        const name = key === 'frunk' ? 'OPEN_FRUNK' : 'OPEN_TRUNK'
        return this.guard(15, async () => {
          const req = {}
          req[field] = closureEnum('CLOSURE_MOVE_TYPE_OPEN')
          this.report(await sendClosure(req, name))
        })
      }
    },
    doLock() {
      return this.guard(11, async () => {
        this.report(await sendRke(rkeEnum('RKE_ACTION_LOCK'), 'LOCK'))
      })
    },
    refresh() {
      return this.guard(16, async () => {
        this.report(await vehicleData(vehicleDataAll().slice()))
      })
    },
    doPing() {
      return this.guard(2, async () => {
        this.report(await pingInfotainment())
      })
    },
    async doConnect() {
      if (!hasKey() || !hasBind()) {
        this.toast('还没有钥匙或绑定档案，请先进「绑定与钥匙」完成一次绑定')
        return
      }
      await this.guard(1, async () => {
        const r = await startAutoReconnectLoop('首页手动')
        this.toast(r.ok ? r.text : r.text || '未连上')
        this.tick()
      })
    },
    doStop() {
      stopAutoReconnectLoop('首页手动停止')
      this.toast('已停止自动重连：' + describeAutoLoop())
      this.tick()
    },
    go(r) {
      if (r.key === 'binding') {
        uni.navigateTo({ url: '/pages/binding/binding' })
        return
      }
      uni.reLaunch({ url: r.url })
    }
  }
}
</script>

<style scoped>
.row {
  display: flex;
  flex-direction: row;
  align-items: center;
  flex-wrap: wrap;
}

.chips {
  margin-top: 6rpx;
}

.batt {
  display: flex;
  flex-direction: row;
  align-items: baseline;
}

.batt-note {
  margin-left: 20rpx;
}

.carpic {
  display: flex;
  flex-direction: row;
  justify-content: center;
  padding: 10rpx 0 4rpx 0;
}

.fresh {
  margin-top: 10rpx;
  font-size: 21rpx;
  color: var(--text-3);
}

.tf-li-hover {
  background-color: var(--card-2);
}
</style>
