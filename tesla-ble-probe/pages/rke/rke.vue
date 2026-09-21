<template>
  <view class="wrap">
    <view class="card">
      <view class="title">会话</view>
      <view class="status">{{ status }}</view>
      <view class="row">
        <button class="btn btn-plain" size="mini" :loading="busy === 1" @click="doEph">协商临时公钥</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 2" @click="doStatus">查车辆状态</button>
      </view>
      <view class="tip">
        解锁 / 上锁第一次点击时会自动先协商临时公钥；每次操作 counter 都会 +1 并落盘，
        绝不能回退，否则车辆报 IV_SMALLER_THAN_EXPECTED，这把钥匙就得重新绑定。
      </view>
    </view>

    <view class="card">
      <view class="title">常用动作</view>
      <view class="row">
        <button class="btn" size="mini" :loading="busy === 11" @click="doAction(0, 'UNLOCK', 11)">解锁 (0)</button>
        <button class="btn" size="mini" :loading="busy === 12" @click="doAction(1, 'LOCK', 12)">上锁 (1)</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 13" @click="doAction(2, 'OPEN_TRUNK', 13)">后备箱 (2)</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 14" @click="doAction(3, 'OPEN_FRUNK', 14)">前备箱 (3)</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 15" @click="doAction(4, 'OPEN_CHARGE_PORT', 15)">开充电口 (4)</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 16" @click="doAction(5, 'CLOSE_CHARGE_PORT', 16)">关充电口 (5)</button>
      </view>
      <view class="field">
        <text class="field-label">自定义</text>
        <input class="input" type="number" v-model="custom" placeholder="RKEAction_E 的数字值" />
      </view>
      <view class="row">
        <button class="btn btn-plain" size="mini" :loading="busy === 9" @click="doCustom">发送自定义动作</button>
      </view>
      <view class="tip">
        本表只登记 v3.10.14 里确认存在的 0..20；AUTO_SECURE_VEHICLE / WAKE_VEHICLE 之类新动作
        数值未经核实，发出去最多拿到 FAULT_UNKNOWN，不会伤车，但别把它当成方案不行的证据。
      </view>
    </view>

    <view class="card">
      <view class="title">连续压测</view>
      <view class="row">
        <button class="btn btn-plain" size="mini" :loading="busy === 10" @click="doLoop">上锁→解锁 各 3 次</button>
      </view>
      <view class="tip">用来验证 counter 单调递增与共享密钥复用是否符合预期（同一 sharedKey 换 counter 连发）。</view>
    </view>

    <view class="card">
      <view class="title">日志</view>
      <log-box height="560rpx" />
    </view>
  </view>
</template>

<script>
import { log } from '@/common/session.js'
import { sendRke, requestEphemeralKey, queries, statusText, RKE } from '@/common/actions.js'
import { label } from '@/common/vcsec.js'

export default {
  data() {
    return { status: '', busy: 0, custom: '' }
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
    toast(t) {
      if (typeof uni !== 'undefined' && uni.showToast) uni.showToast({ title: t, icon: 'none', duration: 2500 })
    },
    async guard(n, fn) {
      if (this.busy) {
        this.toast('上一步还没结束')
        return
      }
      this.busy = n
      try {
        await fn()
      } catch (e) {
        log('error', (e && e.message) || String(e))
        this.toast('失败，看日志')
      } finally {
        this.busy = 0
        this.tick()
      }
    },
    doEph() {
      return this.guard(1, async () => {
        const r = await requestEphemeralKey()
        log(r.ok ? 'ok' : 'warn', r.text)
        this.toast(r.text.slice(0, 60))
      })
    },
    doStatus() {
      return this.guard(2, async () => {
        const r = await queries.status()
        const vs = r.obj && r.obj.vehicleStatus
        if (vs) log('ok', '锁状态=' + label('VehicleLockState_E', vs.vehicleLockState))
      })
    },
    doAction(action, name, n) {
      return this.guard(n, async () => {
        const r = await sendRke(action, name)
        log(r.ok ? 'ok' : 'warn', r.text)
        this.toast(r.text.slice(0, 60))
      })
    },
    doCustom() {
      const v = parseInt(this.custom, 10)
      if (!isFinite(v) || v < 0) {
        this.toast('请先填一个 0 以上的数字')
        return
      }
      return this.guard(9, async () => {
        const r = await sendRke(v, 'CUSTOM_' + v + '_' + label('RKEAction_E', v))
        log(r.ok ? 'ok' : 'warn', r.text)
        this.toast(r.text.slice(0, 60))
      })
    },
    async doLoop() {
      await this.guard(10, async () => {
        for (let i = 0; i < 3; i++) {
          const a = await sendRke(RKE.RKE_ACTION_LOCK, 'LOOP_LOCK#' + (i + 1))
          log(a.ok ? 'ok' : 'warn', a.text)
          const b = await sendRke(RKE.RKE_ACTION_UNLOCK, 'LOOP_UNLOCK#' + (i + 1))
          log(b.ok ? 'ok' : 'warn', b.text)
          if (!a.ok || !b.ok) {
            log('error', '压测在第 ' + (i + 1) + ' 轮中断，后续结果不再可信')
            return
          }
        }
        log('ok', '压测完成：6 帧全部 status=OK')
      })
    }
  }
}
</script>
