<template>
  <view class="tf-page">
    <!-- ============================================================ 座舱温度
      读数全部来自 vehicleView()：store 已经把 climate_state 归一化过（摄氏度、保留一位小数、
      没回字段就是 null），这一层只负责把 null 显示成「未知」，不许在这里补 0 或补当前温度。 -->
    <view class="tf-card">
      <view class="hd">
        <text class="tf-card-title hd-title">座舱温度</text>
        <view class="tf-chip" :class="connChip.cls">{{ connChip.text }}</view>
      </view>

      <view v-if="v.hasData" class="temps">
        <view class="temp">
          <tf-icon name="thermo" size="40rpx" :color="v.climateOn === true ? '#46d68a' : '#7c8794'" />
          <text class="temp-val">{{ unit(v.insideTemp, '℃') }}</text>
          <text class="temp-name">车内</text>
        </view>
        <view class="temp">
          <tf-icon name="cool" size="40rpx" />
          <text class="temp-val">{{ unit(v.outsideTemp, '℃') }}</text>
          <text class="temp-name">车外</text>
        </view>
      </view>
      <view v-else class="tf-empty">
        还没有车辆数据。连上车之后点下面的「刷新温度」，只问 climate 这一类也够把温度读出来。
      </view>

      <view class="grid">
        <view class="tile" :class="{ 'tile-off': busy !== 0, 'tile-on': v.climateOn === true }" @click="doHvac(true)">
          <tf-icon name="power" size="52rpx" />
          <view class="tile-name">启动空调</view>
          <view class="tile-sub">HvacAutoAction</view>
        </view>
        <view class="tile" :class="{ 'tile-off': busy !== 0 }" @click="doHvac(false)">
          <tf-icon name="close" size="52rpx" />
          <view class="tile-name">关闭空调</view>
          <view class="tile-sub">{{ v.climateOn === null ? '现在未知' : v.climateOn ? '现在是开的' : '现在是关的' }}</view>
        </view>
        <view class="tile" :class="{ 'tile-off': busy !== 0 }" @click="doRefreshClimate">
          <tf-icon name="refresh" size="52rpx" />
          <view class="tile-name">刷新温度</view>
          <view class="tile-sub">只问 climate</view>
        </view>
      </view>
      <view class="tip">
        开 / 关走的是车机域 HvacAutoAction{power_on}：官方 climate.go 只填这一个开关，不带
        manual_override，所以启停之后是按车机自己存的设定值跑，不接遥控改风量和温度。
      </view>
    </view>

    <!-- ============================================================ 设定值（只读） -->
    <view class="tf-card">
      <view class="tf-card-title">设定与状态</view>
      <view v-for="r in rows" :key="r.label" class="tf-kv">
        <text class="tf-kv-label">{{ r.label }}</text>
        <text class="tf-kv-value" :class="{ unk: r.unk }">{{ r.text }}</text>
      </view>
      <view class="tip ro">
        温度设定只读：car_server.proto 里的 SetKlimatZoneValues / SetTemps 这类带温度的动作，
        本项目没有在 src/protocol/v3/spec.js 登记、也没有取证到的金标准字节，按「不许猜字节」的规矩宁可不放按钮。
      </view>
    </view>

    <!-- ============================================================ 数据 -->
    <view class="tf-card">
      <view class="tf-card-title">数据</view>
      <view class="row">
        <button class="btn" size="mini" :loading="busy === 91" @click="doRefresh">刷新全部</button>
      </view>
      <view class="tip">{{ v.hasData ? ago(v.updatedAt, now) + '更新 · 共 ' + v.categories.length + ' 类 · 来源 ' + v.source : '一次成功的 GetVehicleData 都还没有' }}</view>
    </view>

    <tf-tabbar active="climate" />
  </view>
</template>

<script>
import { log, connection, vehicleView, subscribeVehicle } from '@/src/services/index.js'
import { hvacAuto, vehicleData, vehicleDataAll } from '@/src/services/vehicle-api.js'
import { ago, unit, yesNo } from '@/src/ui/format.js'
import { notify } from '@/src/infra/platform/notify.js'

const CONN = {
  idle: { text: '未连接', cls: '' },
  scanning: { text: '扫描中', cls: 'tf-chip-warn' },
  connecting: { text: '连接中', cls: 'tf-chip-warn' },
  connected: { text: '已连接', cls: 'tf-chip-on' },
  disconnected: { text: '已断开', cls: 'tf-chip-err' }
}

export default {
  data() {
    return {
      v: vehicleView(),
      now: Date.now(),
      busy: 0,
      _off: null,
      _timer: null
    }
  },
  computed: {
    connChip() {
      return CONN[connection.connection] || { text: '未知', cls: '' }
    },
    rows() {
      const v = this.v
      return [
        { label: '主驾设定', text: unit(v.driverTemp, '℃'), unk: v.driverTemp === null },
        { label: '副驾设定', text: unit(v.passengerTemp, '℃'), unk: v.passengerTemp === null },
        { label: '空调压缩机', text: yesNo(v.climateOn, '运行中', '未运行'), unk: v.climateOn === null },
        { label: '预调理', text: yesNo(v.preconditioning, '进行中', '未进行'), unk: v.preconditioning === null },
        { label: '数据类别', text: v.categories.length ? v.categories.join(' / ') : '未知', unk: !v.categories.length }
      ]
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
    // 与首页 / 控制页同一套：一次只允许一条 BLE 请求在路上，错误一律弹窗带原文
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
    doHvac(on) {
      return this.guard(on ? 41 : 42, async () => {
        this.report(await hvacAuto(on))
      })
    },
    // 只问 climate 一类：单条 GetVehicleData，避免全量那六条往返
    doRefreshClimate() {
      return this.guard(93, async () => {
        this.report(await vehicleData(['climate']))
      })
    },
    doRefresh() {
      return this.guard(91, async () => {
        this.report(await vehicleData(vehicleDataAll().slice()))
      })
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
  margin-bottom: 14rpx;
}

.hd-title {
  margin-bottom: 0;
}

/* 两个大读数：车内 / 车外，「未知」就是这两个字，不许显示 0℃ */
.temps {
  display: flex;
  flex-direction: row;
  padding: 6rpx 0 18rpx 0;
}

.temp {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.temp-val {
  margin-top: 8rpx;
  font-size: 46rpx;
  font-weight: 300;
  color: var(--text);
}

.temp-name {
  margin-top: 2rpx;
  font-size: 22rpx;
  color: var(--text-3);
}

.ro {
  margin-top: 14rpx;
}

.unk {
  color: var(--text-3);
}
</style>
