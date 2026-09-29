<template>
  <view class="wrap">
    <view class="card">
      <view class="title">车辆</view>
      <view class="field">
        <text class="field-label">VIN</text>
        <input class="input" v-model="vin" placeholder="完整 VIN（用来算广播名）" @blur="saveVin" />
      </view>
      <view class="status">{{ status }}</view>
      <view class="status">绑定档案：{{ bindInfo }}</view>
      <view class="tip">
        广播名匹配规则：新 = Tesla + VIN 后 6 位；旧 = S + SHA1(VIN) 十六进制前 16 位。
        实在不知道 VIN 也可以只填后 6 位（旧命名规则会失效）。
        车辆的蓝牙名在手机上改过、或已被系统配对过，就按这个规则匹配不上 ——
        ② 扫描并连接 会把扫到的广播全部列出来，直接点你车那一条即可。
      </view>
      <view class="tip">
        绑过一次之后不用每次手选：本机会把车辆的蓝牙地址（Android 是真实 MAC、iOS 是系统给本 App 的稳定 UUID）
        和广播名记下来，前台期间会一直试着连（连不上按 3 → 6 → 12 → 24 → 30 秒退避重试），
        人在几十米外提前打开 App，走到车边那一轮自己就连上了，不用杀后台重开。
        状态行最后那段「自动重连：…」会实时显示正在第几次尝试 / 几秒后重试；退到后台会暂停（系统限制），回前台自动继续。
        点「② 扫描并连接（手选）」或「立即自动连接」连上任意一台车，同样会更新这份档案。
        主动「断开连接」会暂停自动重连，免得你想断还连着；点「恢复自动重连」或再手动连一次即恢复。
      </view>
      <view class="row">
        <button class="btn" size="mini" :loading="busy === 9" @click="manualAuto">立即自动连接</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 10" @click="resumeAuto">恢复自动重连</button>
        <button class="btn btn-danger" size="mini" @click="clearBind">清除绑定档案</button>
      </view>
    </view>

    <view class="card">
      <view class="title">三步验证</view>
      <view class="row">
        <button class="btn" size="mini" :loading="busy === 1" @click="step1">① 蓝牙就绪</button>
        <button class="btn" size="mini" :loading="busy === 2" @click="step2">② 扫描并连接（手选）</button>
        <button class="btn" size="mini" :loading="busy === 3" @click="step3">③ 绑定（刷钥匙卡）</button>
      </view>
      <view class="row">
        <button class="btn" size="mini" :loading="busy === 8" @click="stepProbe">④ 探针确认（能不能建会话）</button>
      </view>
      <view class="field">
        <text class="field-label">钥匙类型</text>
        <view class="ff-list">
          <text
            v-for="f in formFactors"
            :key="f.value"
            class="ff"
            :class="{ 'ff-on': f.value === formFactor }"
            @click="pickFormFactor(f)"
          >{{ shortName(f.name) }}</text>
        </view>
      </view>
      <view class="tip">
        钥匙类型（FORM_FACTOR）官方没有默认值，是 add-key 的必填参数（vehicle-command commands.go:363），
        四个候选值都开放给现场试；默认 {{ shortName(defaultFfName) }}（我们是手机）。
        它只影响车机把新钥匙归到哪一类，不影响协议字节 —— 换着试是为排除「车机拒绝这一类钥匙」，
        不是因为哪个参考实现用了别的值就说我们错了。
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
        「查白名单」里看不到本机 keyId（车辆回的是前 4 字节，日志里两个形式都印出来了）时，
        说明绑定没落库或钥匙被车主删除；车辆同时最多保持约 3 台已连接手机，连接失败先想想这个。
        绑定必须刷实体钥匙卡：官方 CLI 发完 add-key 也只是 5 秒退出、不看回执，所以「车辆没响应」通常是没人刷卡，不是链路故障。手机 NFC 替代不了钥匙卡。
        读卡区：Model 3/Y 在中控台杯架后方，Model S/X/Cybertruck 在左侧无线充电板顶部往下刷。
      </view>
    </view>

    <view class="card">
      <view class="title">日志</view>
      <log-box height="600rpx" />
    </view>

    <!-- ② 扫描并连接：把扫到的广播全部列出来手选（车辆改过蓝牙名时唯一可行的路） -->
    <view v-if="picker" class="mask">
      <view class="sheet">
        <view class="sheet-title">选择要连接的设备</view>
        <view class="tip">
          {{ scanning ? '扫描中…（' + scanMs / 1000 + ' 秒，边扫边出）' : '扫描结束，共 ' + devices.length + ' 个广播' }}。
          优先点标了「命中VIN」的；没有就点标了「0211」的（那是特斯拉 VCSEC 服务）；
          两个都没有，就按信号（dBm 越接近 0 越近）点离你最近的那个。
        </view>
        <scroll-view scroll-y class="sheet-list">
          <view v-for="d in devices" :key="d.deviceId" class="dev" @click="pick(d)">
            <view class="dev-name">{{ d.name || '(无名) ' + tail(d.deviceId) }}</view>
            <view class="dev-id">{{ d.deviceId }}</view>
            <view class="dev-tags">
              <text v-if="d.hit" class="tag tag-hit">命中VIN {{ d.mode }}</text>
              <text v-else-if="d.tesla" class="tag tag-hit">0211 服务</text>
              <text class="tag">{{ rssiText(d) }}</text>
            </view>
          </view>
          <view v-if="!devices.length && !scanning" class="tip">
            一个广播都没扫到：先点「① 蓝牙就绪」，确认系统蓝牙开着、定位权限给了、车没休眠（踩一下刹车让车机醒）。
          </view>
        </scroll-view>
        <view class="row">
          <button class="btn btn-plain" size="mini" :loading="scanning" @click="rescan">重新扫描</button>
          <button class="btn btn-plain" size="mini" @click="autoConnect">按 VIN 自动连</button>
          <button class="btn btn-danger" size="mini" @click="closePicker">关闭</button>
        </view>
      </view>
    </view>
  </view>
</template>

<script>
import { log, state, ble, connectTo, disconnectAll, hasKey, ensureKey, forgetKey, saveKeyPair, describeKey, namesForVin, hasBind, forgetBind, markBound, describeBind, startAutoReconnectLoop, describeAutoLoop, suspendAutoConnect } from '@/src/services/index.js'
import { ensureAndroidPermissions } from '@/src/infra/platform/permissions.js'
import { bindKey, checkWhitelisted, statusText, probeSession, formFactorOptions, defaultFormFactor } from '@/src/services/vehicle-api.js'
import { newKeyPair, bleNamesForVin } from '@/src/protocol/identity.js'
import { VIN_STORE } from '@/src/config/index.js'
import { toHex } from '@/src/infra/bytes.js'
import { notify } from '@/src/infra/platform/notify.js'

const SCAN_MS = 12000; // 手选列表的扫描窗口：再短就扫不全，再长人就开始点了

export default {
  data() {
    // 钥匙类型候选值：官方 vehicle-command 把 FORM_FACTOR 定为 add-key 的必填参数、
    // 没有默认值（commands.go:363），所以这里四个枚举值全开，默认值由 src/domain/v3-context.js 决定。
    const opts = formFactorOptions()
    const def = defaultFormFactor()
    let defName = ''
    for (const o of opts) {
      if (o.value === def) defName = o.name
    }
    return {
      vin: '',
      status: '',
      bindInfo: '无绑定档案',
      busy: 0,
      picker: false,
      devices: [],
      scanning: false,
      scanMs: SCAN_MS,
      formFactors: opts,
      formFactor: def,
      defaultFfName: defName
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
      this.bindInfo = describeBind()
    },
    saveVin() {
      state.vin = (this.vin || '').trim().toUpperCase()
      if (typeof uni !== 'undefined' && uni.setStorageSync) uni.setStorageSync(VIN_STORE, state.vin)
    },
    // 统一走可复制弹窗（见 src/infra/platform/notify.js），正文一律不许截断
    toast(title) {
      notify(title)
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
    // ② 不再「命中即连」：先把全部广播列出来让人挑，挑中才连
    async step2() {
      this.saveVin()
      this.picker = true
      await this.rescan()
    },
    async rescan() {
      if (this.scanning) return
      this.scanning = true
      this.devices = []
      try {
        const b = ble()
        await b.init()
        this.devices = await b.discover(SCAN_MS, namesForVin(state.vin), (list) => { this.devices = list })
        const sus = this.devices.filter((d) => d.hit || d.tesla).length
        log('info', '扫描结束：' + this.devices.length + ' 个广播，疑似车辆 ' + sus + ' 个')
      } catch (e) {
        const msg = ((e && (e.message || e.errMsg)) || String(e)) + (e && e.errCode !== undefined ? ' errCode=' + e.errCode : '')
        log('error', '扫描失败: ' + msg)
        this.toast('扫描失败：' + msg)
      } finally {
        this.scanning = false
      }
    },
    async pick(d) {
      if (this.scanning) { this.toast('还在扫描，等一下再点'); return }
      if (this.busy) { this.toast('上一步还没结束'); return }
      this.picker = false
      log('info', '手选 ' + (d.name || '(无名)') + ' / ' + d.deviceId +
        (d.hit ? '（命中 ' + d.hit + '）' : d.tesla ? '（广播了 0211 服务）' : '（按名字/信号猜的，连不上就换一条）'))
      await this.connect(d)
    },
    // 没改过蓝牙名的车还是想一键连：走原来「按 VIN 匹配、命中即停」那条路
    async autoConnect() {
      if (this.scanning) { this.toast('还在扫描，等一下再点'); return }
      this.picker = false
      await this.connect(null)
    },
    async connect(device) {
      await this.guard(2, async () => {
        const d = await connectTo(state.vin, device)
        if (!d) this.toast('按 VIN 没扫到车，回列表里直接点你车那一条')
        else this.toast('已连接 ' + (d.name || d.deviceId))
      })
    },
    closePicker() {
      this.picker = false
    },
    tail(id) {
      return String(id || '').slice(-8)
    },
    rssiText(d) {
      return typeof d.rssi === 'number' && d.rssi ? d.rssi + 'dBm' : '信号未知'
    },
    shortName(name) {
      // 枚举原名是 KEY_FORM_FACTOR_ANDROID_DEVICE 这种长串，弹层里只显示后半段
      return String(name || '').replace('KEY_FORM_FACTOR_', '')
    },
    pickFormFactor(f) {
      this.formFactor = f.value
      log('info', '钥匙类型选择为 ' + this.shortName(f.name) + (f.note ? '（' + f.note + '）' : '') +
        '；这只影响车机把新钥匙归到哪一类，不影响协议字节')
    },
    async step3() {
      await this.guard(3, async () => {
        // 发请求前先确认手上有实体钥匙卡：官方 security.go:314 写明必须「tap NFC card +
        // 车机屏幕确认」两步，而车端读卡区只认 Tesla RFID 卡，手机 NFC 贴上去没有任何作用。
        // 没卡就别发，否则只会白等一个绑定窗口再拿一个「车辆没有回执」。
        const ready = await this.confirmCard()
        if (!ready) {
          log('info', '取消绑定：没有实体钥匙卡就不要发 add-key，车端会一直静默等待')
          return
        }
        // 不预先弹「请刷卡」之外的提示：绑定过程中日志里会出现「车辆已进入配对等待 + 刷卡位置」，
        // 那才是车真的在等卡的时刻，比抢在发送前提示准。
        const r = await bindKey(state.vin, { formFactor: this.formFactor })
        this.toast(r.text)
        log(r.ok ? 'ok' : 'warn', '绑定结论: ' + r.text)
        // 只有车辆真的认了这把钥匙才登记 keyId —— 档案里的 keyId 是「这台车上有我这把钥匙」的凭据
        if (r.ok) markBound()
      })
    },
    // ④ 探针：车端加白名单后通常不会回「完成」的 commandStatus（0Bu vehicle_pairing.cpp:246 实测），
    // 唯一的硬判据是「事后能不能用这把钥匙建起 VCSEC 会话」。绑完不确定成没成，就按这个。
    async stepProbe() {
      await this.guard(8, async () => {
        const r = await probeSession()
        this.toast(r.text)
        log(r.ok ? 'ok' : 'warn', '探针结论: ' + r.text)
        // 探针过了 = 这把钥匙确实能在车上建会话，等同于已绑定，补记档案
        if (r.ok) markBound()
      })
    },
    confirmCard() {
      return new Promise((resolve) => {
        if (typeof uni === 'undefined' || !uni.showModal) {
          resolve(true)
          return
        }
        uni.showModal({
          title: '绑定前：请准备实体钥匙卡',
          content:
            '这一步要往车里加一把新钥匙（本机公钥），车端要求用一张已在车上的 Tesla 实体钥匙卡做签署：\n\n' +
            '1）踩刹车唤醒车机，车机 Controls > Safety 里「Allow Mobile Access」必须是开的\n' +
            '2）发出请求后，把钥匙卡放到读卡区：Model 3/Y = 中控台杯架后方；Model S/X/Cybertruck = 左侧无线充电板顶部往下刷\n' +
            '3）在车机屏幕点「确认」\n\n' +
            '手机 NFC 无效：车端读卡区只读 Tesla RFID 钥匙卡，不做手机卡模拟。三星 S25 贴上去弹的是手机自己的 NFC 窗，跟车辆无关。',
          confirmText: '我有卡，开始',
          cancelText: '先不发',
          success: (res) => resolve(!!(res && res.confirm)),
          fail: () => resolve(true)
        })
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
        this.toast(r.text)
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
    // 手动触发一轮「档案优先」的自动连接，同时把持续重试重新武装：
    // 车刚唤醒、或蓝牙刚打开导致前几轮失败时用这一刀，之后交给退避循环，不必反复点。
    async manualAuto() {
      await this.guard(9, async () => {
        suspendAutoConnect(false)
        const r = await startAutoReconnectLoop('手动「立即自动连接」')
        this.toast(
          (r.ok ? r.text : (r.text || '自动连接未完成')) +
          '\n' + describeAutoLoop()
        )
      })
    },
    async resumeAuto() {
      await this.guard(10, async () => {
        suspendAutoConnect(false)
        const r = await startAutoReconnectLoop('恢复自动重连')
        log('info', '已恢复自动重连：' + (hasBind() ? '前台会持续尝试连回档案里的车' : '但还没有绑定档案，需要先连一次车') +
          '；本次结果：' + (r.ok ? r.text : (r.text || '未连上')) + '｜' + describeAutoLoop())
      })
    },
    clearBind() {
      forgetBind()
      this.tick()
    },
    goRke() {
      // 原生 tabBar 已移除（图标全部内联 SVG，原生 tab 只吃 PNG），
      // 底部导航由 tf-tabbar 组件承担，页面之间统一用 navigateTo / reLaunch。
      uni.navigateTo({ url: '/pages/rke/rke' })
    },
    goDebug() {
      uni.navigateTo({ url: '/pages/debug/debug' })
    }
  }
}
</script>

<style scoped>
/* 设备手选弹层：盖住整屏，列表可滚，点一条就走 */
.mask {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.45);
  z-index: 90;
}

.sheet {
  position: absolute;
  left: 16rpx;
  right: 16rpx;
  top: 80rpx;
  bottom: 80rpx;
  padding: 20rpx;
  background-color: #ffffff;
  border-radius: 8rpx;
  display: flex;
  flex-direction: column;
}

.sheet-title {
  font-size: 28rpx;
  font-weight: bold;
  color: #333333;
  margin-bottom: 8rpx;
}

.sheet-list {
  height: 60vh;
  flex: 1;
  margin-top: 10rpx;
  margin-bottom: 10rpx;
}

.dev {
  padding: 14rpx 12rpx;
  border-bottom: 1rpx solid #e9ecef;
}

.dev-name {
  font-size: 26rpx;
  color: #212529;
  word-break: break-all;
}

.dev-id {
  font-family: monospace;
  font-size: 20rpx;
  color: #868e96;
  word-break: break-all;
}

.dev-tags {
  margin-top: 4rpx;
}

.tag {
  margin-right: 8rpx;
  padding: 0 10rpx;
  font-size: 20rpx;
  color: #495057;
  background-color: #f1f3f5;
  border-radius: 4rpx;
}

.tag-hit {
  color: #ffffff;
  background-color: #2b6cb0;
}

/* 钥匙类型（FORM_FACTOR）选择条：小标签排一行，选中的高亮 */
.ff-list {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  margin-top: 6rpx;
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
