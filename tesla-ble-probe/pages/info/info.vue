<template>
  <view class="tf-page">
    <!-- ============================================================ 车辆概况
      界面只读 vehicleView()：里程 / 车速的单位换算（英里、mph、百分之一英里）都在 store 里做完，
      这一层只负责显示，没回字段一律「未知」。 -->
    <view class="tf-card">
      <view class="hd">
        <text class="tf-card-title hd-title">车辆概况</text>
        <view class="tf-chip" :class="connChip.cls">{{ connChip.text }}</view>
      </view>

      <view v-if="v.hasData">
        <view v-for="r in odometerRows" :key="r.label" class="tf-kv">
          <text class="tf-kv-label">{{ r.label }}</text>
          <text class="tf-kv-value" :class="{ unk: r.unk }">{{ r.text }}</text>
        </view>
        <view class="tip fresh">{{ ago(v.updatedAt, now) }}更新 · 来源 {{ v.source }}</view>
      </view>
      <view v-else class="tf-empty">
        还没有车辆数据。连上车之后点下面的「刷新」拉一次 GetVehicleData。
      </view>
    </view>

    <!-- ============================================================ 胎压四角 -->
    <view class="tf-card">
      <view class="tf-card-title">胎压（bar）</view>
      <view v-if="v.hasTirePressure" class="tires">
        <view class="corner-hd">左侧</view>
        <view class="corner-hd">右侧</view>
        <view v-for="t in tires" :key="t.key" class="tire-cell" :class="{ 'tire-front': t.front }">
          <text class="tire-name">{{ t.name }}</text>
          <text class="tire-val" :class="{ unk: t.unk }">{{ t.text }}</text>
        </view>
      </view>
      <view v-else class="tf-empty">
        {{ v.hasData ? '这次回包里没有胎压。用下面的「只拉胎压」单独问一次 getTirePressureState。' : '胎压来自 getTirePressureState，连上车之后拉一次才有数。' }}
      </view>
      <view v-if="v.hasTirePressure" class="tip fresh">
        单位是 bar（vehicle.proto 原样），不是 kPa 也不是 psi；哪个角没回就是「未知」，不会拿别角的数顶上去。
      </view>
    </view>

    <!-- ============================================================ 位置 -->
    <view class="tf-card">
      <view class="tf-card-title">位置</view>
      <view v-for="r in locationRows" :key="r.label" class="tf-kv">
        <text class="tf-kv-label">{{ r.label }}</text>
        <text class="tf-kv-value" :class="{ unk: r.unk }">{{ r.text }}</text>
      </view>
      <view class="tip fresh">
        「定位时间」是车机那份 location_state 自带的 gps_as_of，不是本页刷新的时刻 ——
         BLE 链路本身没有 GPS，车机存的位置旧了也只能显示旧的那一份。
      </view>
    </view>

    <!-- ============================================================ 数据 -->
    <view class="tf-card">
      <view class="tf-card-title">数据</view>
      <view class="row">
        <button class="btn" size="mini" :loading="busy === 91" @click="doRefresh">刷新全部</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 94" @click="doOne('drive', 94)">里程挡位</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 95" @click="doOne('location', 95)">位置</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 96" @click="doOne('tirePressure', 96)">胎压</button>
      </view>
      <view class="tip">{{ v.hasData ? '本轮共 ' + v.categories.length + ' 类：' + v.categories.join(' / ') : '还没有成功的 GetVehicleData' }}</view>
    </view>

    <tf-tabbar active="info" />
  </view>
</template>

<script>
import { log, connection, vehicleView, subscribeVehicle } from '@/src/services/index.js'
import { vehicleData, vehicleDataAll } from '@/src/services/vehicle-api.js'
import { ago, clock, unit, yesNo } from '@/src/ui/format.js'
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
    odometerRows() {
      const v = this.v
      return [
        { label: '总里程', text: unit(v.odometerKm, ' km'), unk: v.odometerKm === null },
        { label: '挡位', text: v.shiftText, unk: v.shift === null },
        { label: '车速', text: unit(v.speedKmh, ' km/h'), unk: v.speedKmh === null },
        { label: '人在车上', text: yesNo(v.userPresent, '在', '不在'), unk: v.userPresent === null }
      ]
    },
    tires() {
      const t = this.v.tire
      return [
        { key: 'fl', name: '左前', text: unit(t.fl, ' bar', 1), unk: t.fl === null, front: true },
        { key: 'fr', name: '右前', text: unit(t.fr, ' bar', 1), unk: t.fr === null, front: true },
        { key: 'rl', name: '左后', text: unit(t.rl, ' bar', 1), unk: t.rl === null, front: false },
        { key: 'rr', name: '右后', text: unit(t.rr, ' bar', 1), unk: t.rr === null, front: false }
      ]
    },
    locationRows() {
      const v = this.v
      // gps_as_of 是车机给的时间戳（秒），换成当天时分秒；没回就是「未知」
      const asOf = v.gpsAsOf === null ? null : clock(v.gpsAsOf * 1000)
      return [
        { label: '纬度', text: unit(v.latitude, '°', 6), unk: v.latitude === null },
        { label: '经度', text: unit(v.longitude, '°', 6), unk: v.longitude === null },
        { label: '朝向', text: v.heading === null ? '未知' : unit(v.heading, '°', 0), unk: v.heading === null },
        { label: '定位时间', text: asOf || '未知', unk: !asOf },
        { label: '地点名', text: v.locationName || '未知', unk: !v.locationName }
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
    doRefresh() {
      return this.guard(91, async () => {
        this.report(await vehicleData(vehicleDataAll().slice()))
      })
    },
    // 单类别刷新：每个类别一条 GetVehicleData（合包会被车机判 MTU 超限，见 vehicle-data.js）
    doOne(cat, n) {
      return this.guard(n, async () => {
        this.report(await vehicleData([cat]))
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

/* 胎压按「前排 / 后排 × 左 / 右」摆成四角，跟车上实际位置对得上，比一列 kv 更好核对 */
.tires {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  justify-content: space-between;
}

.corner-hd {
  width: 46%;
  margin-bottom: 8rpx;
  font-size: 21rpx;
  color: var(--text-3);
  text-align: center;
}

.tire-cell {
  width: 46%;
  margin-bottom: 14rpx;
  padding: 18rpx 8rpx;
  background-color: var(--card-2);
  border: 1rpx solid var(--line);
  border-radius: 16rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.tire-front {
  border-color: var(--accent-2);
}

.tire-name {
  font-size: 22rpx;
  color: var(--text-3);
}

.tire-val {
  margin-top: 6rpx;
  font-size: 34rpx;
  color: var(--text);
}

.unk {
  color: var(--text-3);
}

.fresh {
  margin-top: 12rpx;
}
</style>
