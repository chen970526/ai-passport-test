<template>
  <view class="wrap">
    <!-- 顶部：这台 App 现在到底连着谁、两个域的会话各是什么状态 -->
    <view class="card">
      <view class="title">连接</view>
      <view class="status">{{ status }}</view>
      <view class="row">
        <button class="btn btn-plain" size="mini" @click="goBind">→ 扫描 / 连接 / 绑定</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 1" @click="doPing">车机在线探测（Ping）</button>
      </view>
      <view class="tip">
        Ping 走的是车机域（INFOTAINMENT）的加密会话，官方注释叫「authenticated no-op」——
        它不动车上任何东西，却同时验证了三件事：蓝牙链路通、这把钥匙在白名单里、车机醒着。
        命令没反应时先点它，比直接试车控动作更快定位问题。
      </view>
    </view>

    <!-- 车控：低风险的两个直接点，解锁走二次确认，开盖走滑动确认 -->
    <view class="card">
      <view class="title">车控</view>
      <view class="grid">
        <view class="tile" :class="{ 'tile-off': busy !== 0 }" @click="doLock">
          <car-icon name="lock" size="64rpx" />
          <view class="tile-name">上锁</view>
          <view class="tile-sub">RKE LOCK</view>
        </view>
        <view class="tile" :class="{ 'tile-off': busy !== 0 }" @click="askUnlock">
          <car-icon name="unlock" size="64rpx" />
          <view class="tile-name">解锁</view>
          <view class="tile-sub">二次确认</view>
        </view>
        <view class="tile" :class="{ 'tile-off': busy !== 0 }" @click="doInfo">
          <car-icon name="info" size="64rpx" />
          <view class="tile-name">车辆信息</view>
          <view class="tile-sub">{{ picked.length }}/{{ allCats.length }} 类</view>
        </view>
        <view class="tile" :class="{ 'tile-off': busy !== 0 }" @click="doChargeClose">
          <car-icon name="charge" size="64rpx" />
          <view class="tile-name">关充电盖板</view>
          <view class="tile-sub">车机域</view>
        </view>
      </view>
      <view class="tip">
        上锁/解锁是 VCSEC 的 RKE 动作；充电盖板走车机域（car_server 的 chargePortDoorClose/Open），
        两者用的是各自的会话，不共用 counter。
      </view>
    </view>

    <!-- 开盖类动作没有「撤销」这一步，所以一律要滑动推到底才发 -->
    <view class="card">
      <view class="title">开盖（滑动确认）</view>
      <view class="ff-list">
        <text
          v-for="l in lids"
          :key="l.key"
          class="ff"
          :class="{ 'ff-on': l.key === lid }"
          @click="lid = l.key"
        >{{ l.name }}</text>
      </view>
      <view class="row">
        <car-icon :name="lidIcon" size="60rpx" />
        <text class="lid-name">要打开的是：{{ lidName }}</text>
      </view>
      <slide-confirm :disabled="busy !== 0" :text="'滑动打开' + lidName" done-text="已发送，可再次滑动" @confirm="doOpen" />
      <view class="tip">
        前备箱 / 后备箱走 VCSEC 的 ClosureMoveRequest（V3 的 RKEAction_E 只剩 0/1/20/29/30，没有开盖这一档）；
        充电盖板走车机域。开盖指令发出去就收不回，所以这里只给「滑动」这一条路。
      </view>
    </view>

    <!-- GetVehicleData：勾类别 → 拉一次 → 把解出来的人话摊开 -->
    <view class="card">
      <view class="title">车辆信息（GetVehicleData）</view>
      <view class="ff-list">
        <text
          v-for="c in allCats"
          :key="c"
          class="ff"
          :class="{ 'ff-on': picked.indexOf(c) >= 0 }"
          @click="toggleCat(c)"
        >{{ catName(c) }}</text>
      </view>
      <view class="row">
        <button class="btn btn-plain" size="mini" @click="pickAll">全选</button>
        <button class="btn btn-plain" size="mini" @click="pickNone">全不选</button>
      </view>
      <view v-if="infoAt" class="status">{{ infoAt }} 拉取 · 共 {{ rows.length }} 项</view>
      <view v-for="(r, i) in rows" :key="'r' + i" class="kv">
        <text class="kv-k">{{ r[0] }}</text>
        <text class="kv-v">{{ r[1] }}</text>
      </view>
      <view v-if="!rows.length" class="tip">
        还没拉到数据。选好几类再点上面的「车辆信息」；一个类别都不选时按钮会直接告诉你没选。
      </view>
      <view v-if="infoText" class="mono raw">{{ infoText }}</view>
    </view>

    <view class="card">
      <view class="title">日志</view>
      <log-box height="420rpx" />
    </view>

    <!-- 解锁的二次确认：要等 countdown 秒才点亮，防手比脑子快 -->
    <confirm-dialog
      :show="dlg === 'unlock'"
      title="确认解锁全部车门？"
      desc="这把钥匙会让四个车门和后备箱全部失去锁定，车辆不会自动重新上锁（除非你开了自动落锁）。"
      tip="人不在车边就不要点确认。"
      confirm-text="解锁"
      cancel-text="取消"
      :seconds="3"
      :danger="true"
      @confirm="doUnlock"
      @cancel="dlg = ''"
    />
  </view>
</template>

<script>
import { log, state } from '@/src/services/index.js'
import {
  statusText,
  sendRke,
  sendClosure,
  rkeEnum,
  closureEnum,
  chargePortDoor,
  pingInfotainment,
  vehicleData,
  vehicleDataCategories,
  vehicleDataAll
} from '@/src/services/vehicle-api.js'
import { notify } from '@/src/infra/platform/notify.js'

const CAT_NAMES = { closures: '闭锁', charge: '充电', drive: '行驶', climate: '空调', location: '位置', tirePressure: '胎压' }

export default {
  data() {
    return {
      status: '',
      busy: 0,
      dlg: '',
      lids: [
        { key: 'frunk', name: '前备箱', icon: 'frunk' },
        { key: 'trunk', name: '后备箱', icon: 'trunk' },
        { key: 'charge', name: '充电盖板', icon: 'charge' }
      ],
      lid: 'frunk',
      allCats: vehicleDataCategories(),
      picked: vehicleDataAll().slice(),
      info: null,
      infoText: '',
      infoAt: ''
    }
  },
  computed: {
    lidName() {
      return (this.lids.filter((l) => l.key === this.lid)[0] || {}).name
    },
    lidIcon() {
      return (this.lids.filter((l) => l.key === this.lid)[0] || {}).icon
    },
    // 锁状态直接反映到图标上：解锁状态下锁那个格子还是「未上锁」的样子
    locked() {
      const c = this.info && this.info.closures_state
      return !!(c && c.locked)
    },
    rows() {
      return this.buildRows(this.info)
    }
  },
  onShow() {
    this.tick()
    this._timer = setInterval(() => this.tick(), 1000)
  },
  onHide() {
    clearInterval(this._timer)
  },
  unmounted() {
    clearInterval(this._timer)
  },
  methods: {
    tick() {
      this.status = statusText()
    },
    catName(c) {
      return CAT_NAMES[c] || c
    },
    toggleCat(c) {
      const i = this.picked.indexOf(c)
      if (i >= 0) this.picked.splice(i, 1)
      else this.picked.push(c)
    },
    pickAll() {
      this.picked = this.allCats.slice()
    },
    pickNone() {
      this.picked = []
    },
    toast(t) {
      notify(t)
    },
    // 与 ①② 页同一套：一次只允许一条 BLE 请求在路上，错误一律弹窗带原文
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
    askUnlock() {
      if (this.busy) {
        this.toast('上一步还没结束')
        return
      }
      this.dlg = 'unlock'
    },
    doLock() {
      return this.guard(11, async () => {
        const r = await sendRke(rkeEnum('RKE_ACTION_LOCK'), 'LOCK')
        this.report(r)
      })
    },
    doUnlock() {
      this.dlg = ''
      return this.guard(12, async () => {
        const r = await sendRke(rkeEnum('RKE_ACTION_UNLOCK'), 'UNLOCK')
        this.report(r)
      })
    },
    doChargeClose() {
      return this.guard(13, async () => {
        const r = await chargePortDoor(false)
        this.report(r)
      })
    },
    doPing() {
      return this.guard(1, async () => {
        const r = await pingInfotainment()
        this.report(r)
      })
    },
    // 滑动到底才走到这里
    doOpen() {
      const key = this.lid
      if (key === 'charge') {
        return this.guard(14, async () => {
          this.report(await chargePortDoor(true))
        })
      }
      const field = key === 'frunk' ? 'frontTrunk' : 'rearTrunk'
      const name = key === 'frunk' ? 'OPEN_FRUNK' : 'OPEN_TRUNK'
      return this.guard(15, async () => {
        const req = {}
        req[field] = closureEnum('CLOSURE_MOVE_TYPE_OPEN')
        this.report(await sendClosure(req, name))
      })
    },
    doInfo() {
      if (!this.picked.length) {
        this.toast('一个类别都没选 —— 至少勾一类，或者点「全选」')
        return
      }
      return this.guard(16, async () => {
        const r = await vehicleData(this.picked.slice())
        this.report(r)
        const d = r.summary && r.summary.kind === 'vehicleData' ? r.summary.data : null
        if (d) {
          this.info = d
          this.infoText = r.summary.text
          this.infoAt = new Date().toLocaleTimeString()
        } else {
          log('warn', '这帧里没有 vehicleData，可能车机只回了 actionStatus：' + ((r.summary && r.summary.text) || '无摘要'))
        }
      })
    },
    buildRows(d) {
      if (!d) return []
      const out = []
      const yes = (v, a, b) => (v === undefined ? '未知' : v ? a : b)
      const kind = (m) => (m && m.type ? m.type : '未知')
      const num = (v) => (typeof v === 'number' ? (v % 1 ? v.toFixed(1) : String(v)) : '未知')
      const any = (list) => {
        const got = list.filter((v) => v === true)
        return list.indexOf(undefined) < 0 ? (got.length ? '有（' + got.length + '）' : '全无') : '部分未知'
      }
      const c = d.closures_state
      if (c) {
        out.push(['车门锁', yes(c.locked, '已上锁', '未上锁')])
        out.push([
          '四门',
          c.door_open_driver_front === undefined && c.door_open_driver_rear === undefined
            ? '未知（车机没回这几个字段）'
            : any([
                c.door_open_driver_front,
                c.door_open_passenger_front,
                c.door_open_driver_rear,
                c.door_open_passenger_rear
              ])
        ])
        out.push(['前备箱', yes(c.door_open_trunk_front, '开着', '关着')])
        out.push(['后备箱', yes(c.door_open_trunk_rear, '开着', '关着')])
        out.push([
          '车窗',
          c.window_open_driver_front === undefined
            ? '未知'
            : any([c.window_open_driver_front, c.window_open_passenger_front, c.window_open_driver_rear, c.window_open_passenger_rear])
        ])
        out.push(['人在车内', yes(c.is_user_present, '在', '不在')])
      }
      const g = d.charge_state
      if (g) {
        out.push(['电量', g.battery_level === undefined ? '未知' : g.battery_level + '%'])
        out.push(['充电状态', kind(g.charging_state)])
        out.push(['充电盖板', yes(g.charge_port_door_open, '开着', '关着')])
        out.push(['充电口锁止', kind(g.charge_port_latch)])
        out.push(['表显续航', num(g.battery_range)])
      }
      const s = d.drive_state
      if (s) {
        out.push(['挡位', kind(s.shift_state)])
        out.push(['车速', num(s.speed)])
      }
      const k = d.climate_state
      if (k) {
        out.push(['车内温度', k.inside_temp_celsius === undefined ? '未知' : num(k.inside_temp_celsius) + '℃'])
        out.push(['车外温度', k.outside_temp_celsius === undefined ? '未知' : num(k.outside_temp_celsius) + '℃'])
        out.push(['空调', yes(k.is_climate_on, '开', '关')])
      }
      const l = d.location_state
      if (l) {
        out.push([
          '经纬度',
          l.latitude === undefined || l.longitude === undefined ? '未知' : num(l.latitude) + ', ' + num(l.longitude)
        ])
      }
      const p = d.tire_pressure_state
      if (p) {
        out.push(['胎压 左前/右前', num(p.tpms_pressure_fl) + ' / ' + num(p.tpms_pressure_fr)])
        out.push(['胎压 左后/右后', num(p.tpms_pressure_rl) + ' / ' + num(p.tpms_pressure_rr)])
      }
      return out
    },
    goBind() {
      uni.navigateTo({ url: '/pages/index/index' })
    }
  }
}
</script>

<style scoped>
.lid-name {
  margin-left: 14rpx;
  font-size: 26rpx;
  color: #212529;
}

/* 车辆信息的键值行 */
.kv {
  display: flex;
  flex-direction: row;
  padding: 6rpx 0;
  border-bottom: 1rpx solid #f1f3f5;
}

.kv-k {
  width: 200rpx;
  font-size: 24rpx;
  color: #495057;
}

.kv-v {
  flex: 1;
  font-size: 24rpx;
  color: #212529;
  word-break: break-all;
}

.raw {
  margin-top: 10rpx;
  padding: 10rpx;
  background-color: #f8f9fa;
  border-radius: 6rpx;
  white-space: pre-wrap;
}

/* 类别 / 开盖目标的小标签条（与 ① 页的钥匙类型同一套视觉） */
.ff-list {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  margin: 6rpx 0 10rpx 0;
}

.ff {
  margin-right: 10rpx;
  margin-bottom: 8rpx;
  padding: 6rpx 14rpx;
  font-size: 22rpx;
  color: #495057;
  background-color: #f1f3f5;
  border: 1rpx solid #e9ecef;
  border-radius: 20rpx;
}

.ff-on {
  color: #ffffff;
  background-color: #2b6cb0;
  border-color: #2b6cb0;
}
</style>
