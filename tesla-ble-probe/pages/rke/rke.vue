<template>
  <view class="wrap">
    <view class="card">
      <view class="title">会话</view>
      <view class="status">{{ status }}</view>
      <view class="row">
        <button class="btn btn-plain" size="mini" :loading="busy === 1" @click="doEph">重新握手（临时公钥）</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 2" @click="doStatus">查车辆状态</button>
      </view>
      <view class="tip">{{ sessionTip }}</view>
    </view>

    <view class="card">
      <view class="title">常用动作</view>
      <view class="row">
        <button class="btn" size="mini" :loading="busy === 11" @click="doAction(0, 'UNLOCK', 11)">解锁 (0)</button>
        <button class="btn" size="mini" :loading="busy === 12" @click="doAction(1, 'LOCK', 12)">上锁 (1)</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 13" @click="doClosure('rearTrunk', 'OPEN_TRUNK', 13)">后备箱 (2)</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 14" @click="doClosure('frontTrunk', 'OPEN_FRUNK', 14)">前备箱 (3)</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 15" @click="doClosure('chargePort', 'OPEN_CHARGE_PORT', 15)">开充电口 (4)</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 16" @click="doClosure('chargePort', 'CLOSE_CHARGE_PORT', 16, false)">关充电口 (5)</button>
      </view>
      <view class="field">
        <text class="field-label">自定义</text>
        <input class="input" type="number" v-model="custom" placeholder="RKEAction_E 的数字值" />
      </view>
      <view class="row">
        <button class="btn btn-plain" size="mini" :loading="busy === 9" @click="doCustom">发送自定义动作</button>
      </view>
      <view class="tip">{{ actionTip }}</view>
    </view>

    <view class="card">
      <view class="title">连续压测</view>
      <view class="row">
        <button class="btn btn-plain" size="mini" :loading="busy === 10" @click="doLoop">上锁→解锁 各 3 次</button>
      </view>
      <view class="tip">用来验证会话复用与 counter 单调递增是否符合预期（同一 sharedKey 连续换 counter 发帧）。</view>
    </view>

    <view class="card">
      <view class="title">日志</view>
      <log-box height="560rpx" />
    </view>
  </view>
</template>

<script>
import { log } from '@/common/session.js'
import { sendRke, sendClosure, requestEphemeralKey, queries, statusText, label, rkeEnum, closureEnum } from '@/common/api.js'
import { notify } from '@/common/notify.js'

export default {
  data() {
    return { status: '', busy: 0, custom: '' }
  },
  computed: {
    sessionTip() {
      return '每次动作前会自动握手（拿 epoch / clock_time），会话失效时点上面这个按钮强制重来一次；' +
        '握手被车端拒绝（比如钥匙不在白名单）时不会白跑三次，日志里会直接说是哪个 status。'
    },
    actionTip() {
      return 'V3 的 RKEAction_E 只剩 0/1/20/29/30；后备箱、前备箱、充电口走 ClosureMoveRequest，' +
        '所以上面这几个按钮发的是闭锁器报文，编号只是沿用旧版的叫法。'
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
    // 统一走可复制弹窗（见 common/notify.js），正文一律不许截断
    toast(t) {
      notify(t)
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
        // 弹窗里直接带错误原文（点「复制」取全文），不要只说「看日志」
        const msg = ((e && (e.message || e.errMsg)) || String(e)) + (e && e.errCode !== undefined ? ' errCode=' + e.errCode : '')
        log('error', '未捕获错误: ' + msg)
        this.toast('失败：' + msg)
      } finally {
        this.busy = 0
        this.tick()
      }
    },
    doEph() {
      return this.guard(1, async () => {
        const r = await requestEphemeralKey()
        log(r.ok ? 'ok' : 'warn', r.text)
        this.toast(r.text)
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
        this.toast(r.text)
      })
    },
    // 后备箱 / 前备箱 / 充电口在 V3 里走 ClosureMoveRequest
    doClosure(field, name, n, open) {
      return this.guard(n, async () => {
        const type = closureEnum(open === false ? 'CLOSURE_MOVE_TYPE_CLOSE' : 'CLOSURE_MOVE_TYPE_OPEN')
        const req = {}
        req[field] = type
        const r = await sendClosure(req, name)
        log(r.ok ? 'ok' : 'warn', r.text)
        this.toast(r.text)
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
        this.toast(r.text)
      })
    },
    async doLoop() {
      await this.guard(10, async () => {
        const lock = rkeEnum('RKE_ACTION_LOCK')
        const unlock = rkeEnum('RKE_ACTION_UNLOCK')
        for (let i = 0; i < 3; i++) {
          const a = await sendRke(lock, 'LOOP_LOCK#' + (i + 1))
          log(a.ok ? 'ok' : 'warn', a.text)
          const b = await sendRke(unlock, 'LOOP_UNLOCK#' + (i + 1))
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
