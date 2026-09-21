<template>
  <view class="wrap">
    <view class="card">
      <view class="title">车辆</view>
      <view class="field">
        <text class="field-label">VIN</text>
        <input class="input" v-model="vin" placeholder="完整 VIN（用来算广播名）" @blur="saveVin" />
      </view>
      <view class="status">{{ status }}</view>
      <view class="tip">
        广播名匹配规则：新 = Tesla + VIN 后 6 位；旧 = S + SHA1(VIN) 十六进制前 16 位。
        实在不知道 VIN 也可以只填后 6 位（旧命名规则会失效）。
      </view>
    </view>

    <view class="card">
      <view class="title">三步验证</view>
      <view class="row">
        <button class="btn" size="mini" :loading="busy === 1" @click="step1">① 蓝牙就绪</button>
        <button class="btn" size="mini" :loading="busy === 2" @click="step2">② 扫描并连接</button>
        <button class="btn" size="mini" :loading="busy === 3" @click="step3">③ 绑定（刷钥匙卡）</button>
      </view>
      <view class="row">
        <button class="btn btn-plain" size="mini" @click="goRke">→ 上锁 / 解锁页</button>
        <button class="btn btn-plain" size="mini" @click="goDebug">→ 报文控制台</button>
      </view>
    </view>

    <view class="card">
      <view class="title">辅助排查</view>
      <view class="row">
        <button class="btn btn-plain" size="mini" :loading="busy === 4" @click="allAdvs">列出周围广播</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 5" @click="readWhitelist">查白名单</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 6" @click="readVersion">读 0214 版本</button>
      </view>
      <view class="row">
        <button class="btn btn-plain" size="mini" @click="renewKey">换新密钥对</button>
        <button class="btn btn-danger" size="mini" @click="forget">清除本机密钥</button>
        <button class="btn btn-danger" size="mini" @click="disconnect">断开连接</button>
      </view>
      <view class="tip">
        「查白名单」里看不到本机 keyId 时，说明绑定没落库或钥匙被车主删除；
        车辆同时最多保持约 3 台已连接手机，连接失败先想想这个。
      </view>
    </view>

    <view class="card">
      <view class="title">日志</view>
      <log-box height="600rpx" />
    </view>
  </view>
</template>

<script>
import { log, state, ble, connectTo, disconnectAll, hasKey, ensureKey, forgetKey, saveKeyPair, describeKey } from '@/common/session.js'
import { ensureAndroidPermissions } from '@/common/tesla-ble.js'
import { bindKey, checkWhitelisted, statusText } from '@/common/actions.js'
import { newKeyPair, bleNamesForVin } from '@/common/vcsec.js'
import { toHex } from '@/common/bytes.js'

const VIN_STORE = 'tesla_probe_vin_v1';

export default {
  data() {
    return {
      vin: '',
      status: '',
      busy: 0
    }
  },
  onShow() {
    const v = typeof uni !== 'undefined' && uni.getStorageSync ? uni.getStorageSync(VIN_STORE) : ''
    if (v && !this.vin) this.vin = v
    if (!state.vin && this.vin) state.vin = this.vin
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
      this.status = statusText() + ' | ' + describeKey()
    },
    saveVin() {
      state.vin = (this.vin || '').trim().toUpperCase()
      if (typeof uni !== 'undefined' && uni.setStorageSync) uni.setStorageSync(VIN_STORE, state.vin)
    },
    toast(title, icon) {
      if (typeof uni !== 'undefined' && uni.showToast) uni.showToast({ title, icon: icon || 'none', duration: 2200 })
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
    async step1() {
      await this.guard(1, async () => {
        const p = await ensureAndroidPermissions()
        if (p.needed && !p.granted) {
          log('error', '权限被拒绝: ' + JSON.stringify(p.denied) + ' —— 不给权限就扫不到 BLE 广播')
          return
        }
        if (!p.needed) log('info', '非 App 环境或无 plus.android，跳过运行时授权')
        else log('info', '运行时权限已授予: ' + JSON.stringify(p.perms))
        await ble().init()
      })
    },
    async step2() {
      await this.guard(2, async () => {
        this.saveVin()
        const d = await connectTo(state.vin)
        if (!d) this.toast('没扫到车，看日志里的广播列表')
        else this.toast('已连接 ' + (d.name || ''))
      })
    },
    async step3() {
      await this.guard(3, async () => {
        this.toast('已发送，请立刻刷钥匙卡', 'none')
        const r = await bindKey(state.vin)
        this.toast(r.text.slice(0, 60))
        log(r.ok ? 'ok' : 'warn', '绑定结论: ' + r.text)
      })
    },
    async allAdvs() {
      await this.guard(4, async () => {
        const b = ble()
        await b.init()
        const list = await b.scanAll(10000)
        const want = bleNamesForVin(state.vin)
        log('info', '10 秒内共 ' + list.length + ' 个具名广播；期望 ' + want.exact.concat(want.prefixes).join(' / '))
        for (const it of list) {
          const hit = want.exact.indexOf(it.name) >= 0 || want.prefixes.some((p) => it.name.indexOf(p) === 0)
          log(hit ? 'ok' : 'rx', (hit ? '★命中 ' : '    ') + it.name + '  ' + it.deviceId)
        }
      })
    },
    async readWhitelist() {
      await this.guard(5, async () => {
        if (!hasKey()) ensureKey(state.vin)
        const r = await checkWhitelisted()
        this.toast(r.text.slice(0, 60))
      })
    },
    async readVersion() {
      await this.guard(6, async () => {
        const v = await ble().readVersion()
        this.toast('版本 ' + toHex(v || new Uint8Array(0)))
      })
    },
    renewKey() {
      if (!hasKey()) {
        ensureKey(state.vin)
        this.tick()
        return
      }
      const kp = newKeyPair()
      saveKeyPair(kp, state.vin)
      log('warn', '已换成本地新密钥；车辆侧还没登记，必须重新刷卡绑定')
      this.tick()
    },
    forget() {
      forgetKey()
      this.tick()
    },
    async disconnect() {
      await this.guard(7, async () => {
        await disconnectAll()
      })
    },
    goRke() {
      uni.navigateTo({ url: '/pages/rke/rke' })
    },
    goDebug() {
      uni.navigateTo({ url: '/pages/debug/debug' })
    }
  }
}
</script>
