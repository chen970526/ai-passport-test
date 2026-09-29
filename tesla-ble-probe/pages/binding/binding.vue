<template>
  <view class="tf-page">
    <!-- ============================================================ 本机钥匙
      档案一律只读 describeKey() / describeBind() 这两句原文：它们的字段拼装顺序、截断方式
      和日志里出现的是同一份，界面上再拆字段就等于两处口径各自演化。 -->
    <view class="tf-card">
      <view class="hd">
        <text class="tf-card-title hd-title">本机钥匙</text>
        <view class="tf-chip" :class="keyReady ? 'tf-chip-on' : 'tf-chip-err'">{{ keyReady ? '已有密钥' : '未生成' }}</view>
      </view>
      <view class="mono block">{{ keyInfo }}</view>
      <view class="row">
        <button v-if="!keyReady" class="btn" size="mini" :loading="busy === 11" @click="doGenKey">生成本机密钥</button>
        <button v-else class="btn btn-plain" size="mini" :loading="busy === 14" @click="ask('renew')">换一把新钥匙</button>
      </view>
      <view class="tip">
        私钥存在这台 App 的沙箱里（明文，仅限探针；正式产品必须进 Keystore / Keychain）。
        「换一把新钥匙」只改本机，车辆白名单里那把旧的还在，所以换完必须重新刷一次卡。
      </view>
    </view>

    <!-- ============================================================ 绑定档案 -->
    <view class="tf-card">
      <view class="hd">
        <text class="tf-card-title hd-title">绑定档案</text>
        <view class="tf-chip" :class="bindReady ? 'tf-chip-on' : ''">{{ bindReady ? '有档案' : '无档案' }}</view>
      </view>
      <view class="mono block">{{ bindInfo }}</view>
      <view class="row">
        <button class="btn btn-danger" size="mini" :loading="busy === 15" @click="ask('unbind')">清除绑定档案</button>
      </view>
      <view class="tip">
        档案记的是「这台手机连过哪台车」：蓝牙地址 + 广播名 + VIN + 已登记的 keyId。
        清除它不影响密钥和会话，但重启后不再自动回连，得重新走一次「扫描并连接」。
      </view>
    </view>

    <!-- ============================================================ VIN 与钥匙类型 -->
    <view class="tf-card">
      <view class="tf-card-title">VIN 与钥匙类型</view>
      <view class="field">
        <text class="field-label">VIN</text>
        <input class="input" type="text" :value="vin" maxlength="17" placeholder="17 位，车辆铭牌或车机软件页面" @input="onVin" />
      </view>
      <view class="row">
        <button class="btn btn-plain" size="mini" @click="saveVin">保存 VIN</button>
      </view>
      <view class="tip vin-tip">
        VIN 用来匹配蓝牙广播名（车辆出厂按 VIN 后几位命名广播）；绑定与查白名单也都要用它。
        清档案不会清掉这里存的 VIN，换车再改。
      </view>

      <view v-for="f in factors" :key="f.value" class="ff" :class="{ 'ff-on': f.value === formFactor }" @click="pickFormFactor(f)">
        <tf-icon name="key" size="34rpx" :color="f.value === formFactor ? '#4a9eff' : '#7c8794'" />
        <view class="ff-body">
          <view class="ff-name">{{ shortName(f.name) }}</view>
          <view v-if="f.note" class="ff-note">{{ f.note }}</view>
        </view>
        <tf-icon v-if="f.value === formFactor" name="check" size="30rpx" color="#46d68a" />
      </view>
      <view class="tip">
        钥匙类型只告诉车机把这把新钥匙归到哪一类，add-key 里它是必填参数但没有「默认答案」；
        它不改变协议字节，选错了也能再绑一次。绑手机就选 ANDROID_DEVICE / IOS_DEVICE，拿实体卡选 KEY_CARD。
      </view>
    </view>

    <!-- ============================================================ 按顺序做 -->
    <view class="tf-card">
      <view class="tf-card-title">绑定顺序</view>
      <view class="status">{{ status }}</view>
      <view class="grid">
        <view class="tile" :class="{ 'tile-off': busy !== 0 }" @click="doScan">
          <tf-icon name="bluetooth" size="52rpx" />
          <view class="tile-name">① 扫描并连接</view>
          <view class="tile-sub">手选设备那页</view>
        </view>
        <view class="tile" :class="{ 'tile-off': busy !== 0 }" @click="doConnect">
          <tf-icon name="power" size="52rpx" />
          <view class="tile-name">① 按档案回连</view>
          <view class="tile-sub">已有档案时用</view>
        </view>
        <view class="tile" :class="{ 'tile-off': busy !== 0 }" @click="ask('bind')">
          <tf-icon name="key" size="52rpx" />
          <view class="tile-name">② 刷卡绑定</view>
          <view class="tile-sub">add-key + 实体卡</view>
        </view>
        <view class="tile" :class="{ 'tile-off': busy !== 0 }" @click="doProbe">
          <tf-icon name="shield" size="52rpx" />
          <view class="tile-name">③ 探针确认</view>
          <view class="tile-sub">能不能建会话</view>
        </view>
        <view class="tile" :class="{ 'tile-off': busy !== 0 }" @click="doWhitelist">
          <tf-icon name="info" size="52rpx" />
          <view class="tile-name">查白名单</view>
          <view class="tile-sub">车上登记了谁</view>
        </view>
        <view class="tile" :class="{ 'tile-off': busy !== 0 }" @click="doHandshake">
          <tf-icon name="refresh" size="52rpx" />
          <view class="tile-name">重新握手</view>
          <view class="tile-sub">VCSEC 会话</view>
        </view>
      </view>
      <view class="row sess">
        <button class="btn btn-plain" size="mini" :loading="busy === 12" @click="doViaSession">会话内加白名单</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 7" @click="doDisconnect">断开连接</button>
      </view>
      <view class="tip">
        「② 刷卡绑定」发的是 add-key：车端要求用一张已在车上的实体 Tesla 钥匙卡贴在读卡区签署，再在车机屏上点确认，
        手机 NFC 贴上去没有任何作用（车端读卡区只认 RFID 卡）。没有卡就别发这条，车机会一直静默等。
        「会话内加白名单」是另一条路：在已经建好的会话里直接加，只有车机已经允许移动设备接入时才可能成。
      </view>
      <view class="tip">{{ auto }}</view>
    </view>

    <!-- ============================================================ 危险动作 -->
    <view class="tf-card">
      <view class="tf-card-title">清除（只动本机）</view>
      <view class="row">
        <button class="btn btn-danger" size="mini" :loading="busy === 16" @click="ask('unkey')">清除密钥与全部会话</button>
      </view>
      <view class="tip">
        这一条会把私钥、两个域各自的 V3 会话（含 counter）连同绑定档案一起抹掉，下次必须重新刷卡绑定。
        它删不掉车辆那一侧的记录：要彻底不再让这台手机动车，得在车机 Safety 里把对应钥匙删掉。
      </view>
    </view>

    <view class="row back">
      <button class="btn btn-plain" size="mini" @click="goHome">返回车辆首页</button>
    </view>

    <confirm-dialog
      :show="dlg !== ''"
      :title="dlgTitle"
      :desc="dlgDesc"
      :tip="dlgTip"
      :confirm-text="dlgOk"
      :seconds="dlgSeconds"
      :danger="dlgDanger"
      @confirm="onConfirm"
      @cancel="dlg = ''"
    />
  </view>
</template>

<script>
import {
  log,
  state,
  hasKey,
  ensureKey,
  saveKeyPair,
  describeKey,
  hasBind,
  describeBind,
  markBound,
  forgetKey,
  forgetBind,
  disconnectAll,
  startAutoReconnectLoop,
  describeAutoLoop,
  suspendAutoConnect,
  VC
} from '@/src/services/index.js'
import { bindKey, bindKeyViaSession, probeSession, checkWhitelisted, handshake, statusText, formFactorOptions, defaultFormFactor } from '@/src/services/vehicle-api.js'
import { newKeyPair } from '@/src/protocol/identity.js'
import { VIN_STORE } from '@/src/config/index.js'
import { readValue, writeValue } from '@/src/infra/storage/local-store.js'
import { notify } from '@/src/infra/platform/notify.js'

// 三个要二次确认的动作。绑定本身不危险（顶多白等一个刷卡窗口），
// 但「换钥匙 / 清档案 / 清密钥」都会让下次必须重新绑，所以宁可等两秒。
const DLG = {
  bind: {
    title: '确认：手上有实体钥匙卡？',
    desc: '接下来会发 add-key，把本机公钥提交给车辆，等待你用一张已在车上的钥匙卡签署（约 60 秒窗口）。',
    tip: '先踩刹车唤醒车机；Model 3/Y 把卡放在中控台杯架后方，Model S/X 放在左侧无线充电板上往下刷；最后在车机屏点确认。',
    ok: '我有卡，开始绑定',
    seconds: 2,
    danger: false
  },
  renew: {
    title: '换一把本机新密钥？',
    desc: '旧的私钥会被替换。车辆白名单里仍然留着旧公钥，所以在重新刷卡绑定成功之前，这把新钥匙动车不了。',
    tip: '只是想动车的话不用换钥匙；确定要换再按。',
    ok: '换新钥匙',
    seconds: 2,
    danger: false
  },
  unbind: {
    title: '清除绑定档案？',
    desc: '本机不再记得连过哪台车，也不会自动回连，同时车辆状态会被丢弃。密钥与会话保留。',
    tip: '车还停在旁边时先别清；清完要重新扫描并手选设备。',
    ok: '清除档案',
    seconds: 3,
    danger: true
  },
  unkey: {
    title: '清除本机密钥与所有会话？',
    desc: '私钥、两个域各自的 V3 会话（含 counter）和绑定档案一起抹掉，下次必须重新刷卡绑定。',
    tip: '车辆那一侧的记录删不掉：要彻底断开这台手机，请在车机 Safety 里删除对应钥匙。',
    ok: '全部清除',
    seconds: 3,
    danger: true
  }
}

export default {
  data() {
    const ff = defaultFormFactor()
    return {
      vin: '',
      factors: formFactorOptions(),
      formFactor: ff,
      status: '',
      auto: '',
      keyInfo: '',
      bindInfo: '',
      keyReady: hasKey(),
      bindReady: hasBind(),
      busy: 0,
      dlg: '',
      _timer: null
    }
  },
  computed: {
    dlgTitle() {
      return (DLG[this.dlg] || DLG.bind).title
    },
    dlgDesc() {
      return (DLG[this.dlg] || DLG.bind).desc
    },
    dlgTip() {
      return (DLG[this.dlg] || DLG.bind).tip
    },
    dlgOk() {
      return (DLG[this.dlg] || DLG.bind).ok
    },
    dlgSeconds() {
      return (DLG[this.dlg] || DLG.bind).seconds
    },
    dlgDanger() {
      return !!(DLG[this.dlg] || DLG.bind).danger
    }
  },
  onShow() {
    const v = readValue(VIN_STORE) || state.vin || ''
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
    // 档案与状态行都是「取一次算一次」的同步函数，靠 tick 刷进 data 才能重画
    tick() {
      this.status = statusText()
      this.auto = describeAutoLoop()
      this.keyInfo = describeKey()
      this.bindInfo = describeBind()
      this.keyReady = hasKey()
      this.bindReady = hasBind()
    },
    onVin(e) {
      this.vin = (e && e.detail && e.detail.value) || ''
    },
    saveVin() {
      state.vin = (this.vin || '').trim().toUpperCase()
      this.vin = state.vin
      writeValue(VIN_STORE, state.vin)
      log('info', state.vin ? 'VIN 已保存：' + state.vin : 'VIN 已清空')
      this.tick()
    },
    shortName(name) {
      // 枚举原名是 KEY_FORM_FACTOR_ANDROID_DEVICE 这种长串，列表里只显示后半段
      return String(name || '').replace('KEY_FORM_FACTOR_', '')
    },
    pickFormFactor(f) {
      this.formFactor = f.value
      log('info', '钥匙类型选择为 ' + this.shortName(f.name) + (f.note ? '（' + f.note + '）' : '') +
        '；这只影响车机把新钥匙归到哪一类，不影响协议字节')
    },
    toast(t) {
      notify(t)
    },
    // 与其他页同一套：一次只允许一条 BLE 动作在路上，错误一律弹窗带原文
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
      if (key === 'bind') return this.doBind()
      if (key === 'renew') return this.doRenewKey()
      if (key === 'unbind') return this.doUnbind()
      if (key === 'unkey') return this.doUnkey()
    },
    needVin() {
      if (state.vin) return true
      this.toast('先填 VIN：广播名和白名单都要按它匹配')
      return false
    },
    doScan() {
      uni.navigateTo({ url: '/pages/index/index' })
    },
    goHome() {
      uni.reLaunch({ url: '/pages/home/home' })
    },
    doConnect() {
      if (!this.bindReady) {
        this.toast('还没有绑定档案，先去「① 扫描并连接」手选一次设备')
        return
      }
      return this.guard(1, async () => {
        suspendAutoConnect(false)
        const r = await startAutoReconnectLoop('绑定页手动')
        this.toast((r.ok ? r.text : r.text || '没连上') + '\n' + describeAutoLoop())
      })
    },
    doDisconnect() {
      return this.guard(7, async () => {
        await disconnectAll()
        // 主动断开 = 明确表达「现在别连」：自动重连会一并暂停，靠上面那个「回连」按钮恢复
        this.toast('已断开，并暂停自动重连')
      })
    },
    doGenKey() {
      return this.guard(11, async () => {
        const r = ensureKey(state.vin)
        this.toast(r.created ? '已生成本机密钥：' + describeKey() : '本机已有密钥：' + describeKey())
        this.tick()
      })
    },
    doRenewKey() {
      return this.guard(14, async () => {
        if (!hasKey()) {
          ensureKey(state.vin)
          this.tick()
          return
        }
        const kp = newKeyPair()
        saveKeyPair(kp, state.vin)
        log('warn', '已换成本地新密钥；车辆侧还没登记，必须重新刷卡绑定')
        this.tick()
      })
    },
    async doBind() {
      if (!this.needVin()) return
      await this.guard(3, async () => {
        if (!hasKey()) ensureKey(state.vin)
        const r = await bindKey(state.vin, { formFactor: this.formFactor })
        this.toast(r.text)
        log(r.ok ? 'ok' : 'warn', '绑定结论: ' + r.text)
        // 只有车辆真的认了这把钥匙才登记 keyId —— 档案里的 keyId 是「这台车上有我这把钥匙」的凭据
        if (r.ok) markBound()
        this.tick()
      })
    },
    doViaSession() {
      if (!this.needVin()) return
      return this.guard(12, async () => {
        const r = await bindKeyViaSession(state.vin, { formFactor: this.formFactor })
        this.toast(r.text)
        log(r.ok ? 'ok' : 'warn', '会话内加白名单结论: ' + r.text)
        if (r.ok) markBound()
        this.tick()
      })
    },
    doProbe() {
      return this.guard(8, async () => {
        const r = await probeSession()
        this.toast(r.text)
        log(r.ok ? 'ok' : 'warn', '探针结论: ' + r.text)
        // 探针过了 = 这把钥匙确实能在车上建会话，等同于已绑定，补记档案
        if (r.ok) markBound()
        this.tick()
      })
    },
    doWhitelist() {
      return this.guard(5, async () => {
        if (!hasKey()) ensureKey(state.vin)
        this.report(await checkWhitelisted())
      })
    },
    doHandshake() {
      return this.guard(13, async () => {
        this.report(await handshake(true, VC))
      })
    },
    doUnbind() {
      forgetBind()
      this.toast('绑定档案已清除')
      this.tick()
    },
    doUnkey() {
      forgetKey()
      this.toast('本机密钥与所有域的会话已清除')
      this.tick()
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

.block {
  padding: 14rpx 16rpx;
  margin-bottom: 10rpx;
  background-color: var(--card-2);
  border: 1rpx solid var(--line);
  border-radius: 12rpx;
  color: var(--text-2);
  line-height: 34rpx;
}

.vin-tip {
  margin-bottom: 14rpx;
}

/* 钥匙类型单选：一行一个，选中那条描边 + 打勾 */
.ff {
  display: flex;
  flex-direction: row;
  align-items: center;
  padding: 18rpx 16rpx;
  margin-bottom: 12rpx;
  background-color: var(--card-2);
  border: 1rpx solid var(--line);
  border-radius: 12rpx;
}

.ff-on {
  border-color: var(--accent);
  background-color: #17304a;
}

.ff-body {
  flex: 1;
  margin-left: 16rpx;
}

.ff-name {
  font-size: 25rpx;
  color: var(--text);
}

.ff-note {
  margin-top: 4rpx;
  font-size: 20rpx;
  color: var(--text-3);
  line-height: 30rpx;
}

.sess {
  margin-top: 6rpx;
}

.back {
  justify-content: center;
  padding-bottom: 20rpx;
}
</style>
