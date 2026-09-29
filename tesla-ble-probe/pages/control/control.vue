<template>
  <view class="tf-page">
    <!-- ============================================================ 俯视车身图
      点位颜色只有三种：开着 / 关着 / 未知。「未知」单独一种颜色，不能画成关着的样子 ——
      断线之后屏幕上留的是最后一次拉到的数据，把「没回包」显示成「关着」比显示「未知」危险得多。
      四个车门点位读的是 vehicleView().doorStates（store 已经归一化过），这里不碰 closures_state。 -->
    <view class="tf-card">
      <view class="hd">
        <text class="tf-card-title hd-title">车身 · 俯视</text>
        <view class="tf-chip" :class="connChip.cls">{{ connChip.text }}</view>
      </view>

      <view v-if="v.hasData" class="topwrap">
        <view class="topbox">
          <tf-icon name="car-top" size="280rpx" height="438rpx" color="#cdd7e2" :weight="1.4" />
          <view v-for="d in dots" :key="d.key" class="dot" :class="d.cls" :style="d.pos" />
        </view>
        <view class="toplist">
          <view v-for="s in stateRows" :key="s.label" class="st">
            <view class="dot dot-legend" :class="s.cls" />
            <text class="st-name">{{ s.label }}</text>
            <text class="st-val">{{ s.text }}</text>
          </view>
        </view>
      </view>
      <view v-else class="tf-empty">
        还没有车辆数据。连上车之后用下面的「刷新」拉一次 GetVehicleData，这张图才点得亮。
      </view>

      <view v-if="v.hasData" class="tip fresh">{{ ago(v.updatedAt, now) }}拉取 · {{ v.source }}</view>
    </view>

    <!-- ============================================================ 车锁与寻车 -->
    <view class="tf-card">
      <view class="tf-card-title">车锁与寻车</view>
      <view class="grid">
        <view class="tile" :class="{ 'tile-off': busy !== 0 }" @click="doLock">
          <tf-icon name="lock" size="52rpx" />
          <view class="tile-name">上锁</view>
          <view class="tile-sub">VCSEC RKE</view>
        </view>
        <view class="tile" :class="{ 'tile-off': busy !== 0 }" @click="ask('unlock')">
          <tf-icon name="unlock" size="52rpx" />
          <view class="tile-name">解锁</view>
          <view class="tile-sub">RKE + 驾驶授权</view>
        </view>
        <view class="tile" :class="{ 'tile-off': busy !== 0 }" @click="doFlash">
          <tf-icon name="flash" size="52rpx" />
          <view class="tile-name">闪灯</view>
          <view class="tile-sub">车机域 26</view>
        </view>
        <view class="tile" :class="{ 'tile-off': busy !== 0 }" @click="doHorn">
          <tf-icon name="horn" size="52rpx" />
          <view class="tile-name">鸣笛</view>
          <view class="tile-sub">车机域 27</view>
        </view>
      </view>
      <view class="tip">
        闪灯 / 鸣笛是两个空 message，不动任何可动件；车没反应时先试这两个，能分清「链路不通」还是「动作被拒」。
        解锁成功后会自动补发一条驾驶授权（省得上车再点一次）；上锁若要点两次才生效，看回执里的拒绝原因：
        手机钥匙留在车内时车辆会故意拒绝上锁，门 / 箱没关严也一样 —— 这些是车端策略，不是链路故障。
      </view>
    </view>

    <!-- ============================================================ 驾驶授权（Remote Drive）
      解锁解开的是中央锁，挂挡要的是驾驶授权 —— 官方把它们算作两条命令
      （RemoteDrive = RKE_ACTION_REMOTE_DRIVE(20)，与 Unlock 各自调一次 executeRKEAction，
      vcsec.go:173-202），同域、同签名、同一份 authMethod，官方 CLI 里 drive 和 unlock 同级
      且允许走 BLE（commands.go:311）。
      真机验证：BLE 发这条车辆接受，所以「解锁」那颗已经会在解锁成功后自动补发它。
      这颗按钮留着是因为授权是有时限的（特斯拉手册：App 车控的驾驶授权约两分钟窗口），
      窗口过了、或当时被车端拒了，不用再走一遍解锁，直接按这里重试。
      下面那行只转述车辆这一条的回执，成功失败都不加戏。 -->
    <view class="tf-card">
      <view class="tf-card-title">驾驶授权 · Remote Drive</view>
      <view class="row">
        <button class="btn" size="mini" :loading="busy === 13" :disabled="busy !== 0 && busy !== 13" @click="doDrive">
          重新请求驾驶授权
        </button>
        <text class="drive-res" :class="drive.cls">{{ drive.text }}</text>
      </view>
      <view class="tip">
        解锁时已经自动发过一次；上车后挂不上挡（授权窗口过去、或那次被拒）再按这颗单独重试。它和解锁是同一条 VCSEC 通道上的另一条命令。
        踩刹车之前先授权，再挂 D/R。
        回执原文一律照车辆的说法展示 —— 若撞上 GENERICERROR_NOT_ALLOWED_OVER_TRANSPORT，
        说明这台车不允许驾驶授权走 BLE，得改走 Wi-Fi/Internet + Tesla Fleet API 的 remote_start_drive（本项目没有网络通道，只能提示这一条出路）。
      </view>
    </view>

    <!-- ============================================================ 前后箱（滑动到底才发） -->
    <view class="tf-card">
      <view class="tf-card-title">前备箱 / 后备箱</view>
      <view class="lid">
        <view class="lid-head">
          <tf-icon name="frunk" size="40rpx" :color="v.frunkOpen ? '#ffb020' : '#e8eaed'" />
          <text class="lid-name">打开前备箱</text>
          <text class="lid-state">{{ yesNo(v.frunkOpen, '开着', '关着') }}</text>
        </view>
        <slide-confirm
          :disabled="busy !== 0"
          text="→ 向右滑动打开前备箱"
          done-text="已发送，可再次滑动"
          @confirm="doLid('frunk')"
        />
      </view>
      <view class="lid">
        <view class="lid-head">
          <tf-icon name="trunk" size="40rpx" :color="v.trunkOpen ? '#ffb020' : '#e8eaed'" />
          <text class="lid-name">打开后备箱</text>
          <text class="lid-state">{{ yesNo(v.trunkOpen, '开着', '关着') }}</text>
        </view>
        <slide-confirm
          :disabled="busy !== 0"
          text="→ 向右滑动打开后备箱"
          done-text="已发送，可再次滑动"
          @confirm="doLid('trunk')"
        />
      </view>
      <view class="tip">
        VCSEC 的 ClosureMoveRequest{frontTrunk / rearTrunk: OPEN}，发出去没有「撤销」这一步，所以要推到底才发。
      </view>
    </view>

    <!-- ============================================================ 充电盖板 A/B 对照
      同一个物理动作有两条协议路径，两条都保留：哪条在这台车上真的有效，靠的就是这里各按一次、
      再看下面「盖板当前」那一行有没有真的变。每条路径自己的结论取自诊断台账（按 name + tag 命中）。 -->
    <view class="tf-card">
      <view class="tf-card-title">充电盖板 · 两条路径对照</view>
      <view class="tip">盖板当前：{{ v.chargePortOpenText }}{{ v.chargePortLatch ? ' · 卡扣 ' + v.chargePortLatch : '' }}</view>

      <view v-for="p in paths" :key="p.key" class="ab">
        <view class="ab-head">
          <text class="ab-name">{{ p.title }}</text>
          <text class="tip ab-proto">{{ p.proto }}</text>
        </view>
        <view class="ab-body">
          <button class="btn" size="mini" :loading="busy === p.busyOpen" @click="doPort(p.key, true)">打开</button>
          <button class="btn btn-plain" size="mini" :loading="busy === p.busyClose" @click="doPort(p.key, false)">关闭</button>
          <text class="ab-res" :class="p.resCls">{{ p.resText }}</text>
        </view>
      </view>
    </view>

    <!-- ============================================================ 空调与车窗 -->
    <view class="tf-card">
      <view class="tf-card-title">空调与车窗</view>
      <view class="grid">
        <view class="tile" :class="{ 'tile-off': busy !== 0, 'tile-on': v.climateOn === true }" @click="doHvac(true)">
          <tf-icon name="power" size="52rpx" />
          <view class="tile-name">启动空调</view>
          <view class="tile-sub">HvacAutoAction</view>
        </view>
        <view class="tile" :class="{ 'tile-off': busy !== 0 }" @click="doHvac(false)">
          <tf-icon name="close" size="52rpx" />
          <view class="tile-name">关闭空调</view>
          <view class="tile-sub">{{ v.climateOn === null ? '状态未知' : v.climateOn ? '现在是开的' : '现在是关的' }}</view>
        </view>
        <view class="tile" :class="{ 'tile-off': busy !== 0 }" @click="doWindow('vent')">
          <tf-icon name="vent" size="52rpx" />
          <view class="tile-name">车窗通风</view>
          <view class="tile-sub">WindowAction vent</view>
        </view>
        <view class="tile" :class="{ 'tile-off': busy !== 0 }" @click="doWindow('close')">
          <tf-icon name="shield" size="52rpx" />
          <view class="tile-name">关窗</view>
          <view class="tile-sub">WindowAction close</view>
        </view>
      </view>
      <view class="tip">
        空调这条是车机域一键启停（官方 climate.go 只填 power_on，不带 manual_override）；
        车窗这条是 oneof action{{ '{' }}vent / close{{ '}' }}，车机没有「开到某个百分比」这一档。
      </view>
    </view>

    <!-- ============================================================ 数据 -->
    <view class="tf-card">
      <view class="tf-card-title">数据</view>
      <view class="row">
        <button class="btn" size="mini" :loading="busy === 91" @click="doRefresh">刷新全部</button>
        <button class="btn btn-plain" size="mini" :loading="busy === 92" @click="doRefreshClosures">只拉闭锁器</button>
      </view>
      <view class="tip">{{ v.hasData ? '共 ' + v.categories.length + ' 类 · ' + ago(v.updatedAt, now) + '更新' : '一次 GetVehicleData 都还没成功过' }}</view>
    </view>

    <!-- 解锁是全站唯一的危险动作：不等三秒按不下去 -->
    <confirm-dialog
      :show="dlg === 'unlock'"
      title="确认解锁全部车门？"
      desc="四个车门和后备箱会同时失去锁定，车辆不会自动重新上锁。解锁成功后还会紧跟着发一条驾驶授权。"
      tip="人不在车边不要点确认。授权被拒不影响解锁本身，回执会分开写。"
      confirm-text="解锁"
      :seconds="3"
      :danger="true"
      @confirm="onConfirm"
      @cancel="dlg = ''"
    />

    <tf-tabbar active="control" />
  </view>
</template>

<script>
import { log, connection, vehicleView, subscribeVehicle, lastResult } from '@/src/services/index.js'
import {
  sendRke,
  sendClosure,
  remoteDrive,
  unlockAndDrive,
  rkeEnum,
  closureEnum,
  chargePortDoor,
  flashLights,
  honkHorn,
  hvacAuto,
  windowAction,
  vehicleData,
  vehicleDataAll
} from '@/src/services/vehicle-api.js'
import { ago, yesNo } from '@/src/ui/format.js'
import { notify } from '@/src/infra/platform/notify.js'

const CONN = {
  idle: { text: '未连接', cls: '' },
  scanning: { text: '扫描中', cls: 'tf-chip-warn' },
  connecting: { text: '连接中', cls: 'tf-chip-warn' },
  connected: { text: '已连接', cls: 'tf-chip-on' },
  disconnected: { text: '已断开', cls: 'tf-chip-err' }
}

// 点位三态：开着（黄）/ 关着（绿）/ 未知（虚线圈）。未知必须是第三种样子 ——
// 把「车机没回这个字段」画成「关着」，等于让界面替用户下了一个没有依据的结论。
function tri(b) {
  if (b === true) return 'dot-open'
  if (b === false) return 'dot-shut'
  return 'dot-unk'
}

// 中央锁反过来：上锁才是安全态（绿），未上锁要标红，所以不能复用 tri()
function lockDot(b) {
  if (b === true) return 'dot-shut'
  if (b === false) return 'dot-bad'
  return 'dot-unk'
}

// 两条协议路径：A 是车机域那两个空 message，B 是 VCSEC 的 ClosureMoveRequest{chargePort}。
// names 里的名字就是诊断台账里的动作名（vehicle-api 的 tracked() 登记时用的那批），别改字。
const PATHS = [
  {
    key: 'A',
    title: '路径 A · 车机域',
    proto: 'car_server ChargePortDoorOpen / Close',
    busyOpen: 71,
    busyClose: 72,
    names: ['打开充电盖板', '关闭充电盖板'],
    tag: 'INFOTAINMENT'
  },
  {
    key: 'B',
    title: '路径 B · VCSEC',
    proto: 'closureMoveRequest{chargePort: OPEN / CLOSE}',
    busyOpen: 73,
    busyClose: 74,
    names: ['OPEN_CHARGE_PORT', 'CLOSE_CHARGE_PORT'],
    tag: 'VCSEC'
  }
]

// 驾驶授权在诊断台账里的键：必须和 src/services/vehicle-api.js 里
// tracked('驾驶授权（RemoteDrive）', …, 'VCSEC') 逐字一致，否则界面上那一行永远停在「还没试过」。
const DRIVE_LEDGER = { name: '驾驶授权（RemoteDrive）', tag: 'VCSEC' }

export default {
  data() {
    return {
      v: vehicleView(),
      now: Date.now(),
      busy: 0,
      dlg: '',
      _off: null,
      _timer: null
    }
  },
  computed: {
    connChip() {
      return CONN[connection.connection] || { text: '未知', cls: '' }
    },
    // 俯视图点位：车在图里是「车头朝上」，所以图的左边 = 车辆左侧（驾驶侧）。
    // 充电盖板在左后翼子板上，所以点位压在左下而不是右下。
    dots() {
      const v = this.v
      const d = v.doorStates
      return [
        { key: 'frunk', cls: tri(v.frunkOpen), pos: { left: '50%', top: '5%' } },
        { key: 'trunk', cls: tri(v.trunkOpen), pos: { left: '50%', top: '95%' } },
        { key: 'df', cls: tri(d.driverFront), pos: { left: '21%', top: '40%' } },
        { key: 'pf', cls: tri(d.passengerFront), pos: { left: '79%', top: '40%' } },
        { key: 'dr', cls: tri(d.driverRear), pos: { left: '21%', top: '64%' } },
        { key: 'pr', cls: tri(d.passengerRear), pos: { left: '79%', top: '64%' } },
        { key: 'port', cls: tri(v.chargePortOpen), pos: { left: '17%', top: '82%' } }
      ]
    },
    // 右侧那一列读数：和点位用同一套三态，读的是同一批 store 字段。
    stateRows() {
      const v = this.v
      const d = v.doorStates
      return [
        { label: '中央锁', text: v.lockedText, cls: lockDot(v.locked) },
        { label: '左前门', text: yesNo(d.driverFront, '开着', '关着'), cls: tri(d.driverFront) },
        { label: '右前门', text: yesNo(d.passengerFront, '开着', '关着'), cls: tri(d.passengerFront) },
        { label: '左后门', text: yesNo(d.driverRear, '开着', '关着'), cls: tri(d.driverRear) },
        { label: '右后门', text: yesNo(d.passengerRear, '开着', '关着'), cls: tri(d.passengerRear) },
        { label: '前备箱', text: yesNo(v.frunkOpen, '开着', '关着'), cls: tri(v.frunkOpen) },
        { label: '后备箱', text: yesNo(v.trunkOpen, '开着', '关着'), cls: tri(v.trunkOpen) },
        { label: '车窗', text: v.windowUnknown ? '未知' : v.windowsOpen + ' 扇开着', cls: tri(v.windowsOpen === null ? null : v.windowsOpen > 0) },
        { label: '充电盖板', text: v.chargePortOpenText, cls: tri(v.chargePortOpen) },
        { label: '人在车上', text: yesNo(v.userPresent, '在', '不在'), cls: tri(v.userPresent) }
      ]
    },
    paths() {
      const out = []
      for (const p of PATHS) {
        let best = null
        for (const n of p.names) {
          const r = lastResult(n, p.tag)
          if (r && (!best || r.at > best.at)) best = r
        }
        const row = {
          key: p.key,
          title: p.title,
          proto: p.proto,
          busyOpen: p.busyOpen,
          busyClose: p.busyClose,
          resCls: best ? (best.ok ? 'tf-chip-on' : 'tf-chip-err') : '',
          resText: best ? (best.ok ? '成功 · ' : '失败 · ') + best.name + ' · ' + ago(best.at, this.now) : '这条路径还没试过'
        }
        out.push(row)
      }
      return out
    },
    // 驾驶授权那一行的结论：只读诊断台账里这条动作的最后一次回执（名字 + tag 与 vehicle-api 登记的一致）。
    // 没试过就是「还没试过」，车辆拒了就是拒了 —— 界面不替车推断「应该已经能挂挡了」。
    drive() {
      const r = lastResult(DRIVE_LEDGER.name, DRIVE_LEDGER.tag)
      if (!r) return { cls: '', text: '还没试过 · 点解锁时会自动发一次' }
      return {
        cls: r.ok ? 'tf-chip-on' : 'tf-chip-err',
        text: (r.ok ? '车辆回执通过 · ' : '车辆回执拒绝 · ') + ago(r.at, this.now)
      }
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
    // 与首页同一套：一次只允许一条 BLE 请求在路上，错误一律弹窗带原文
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
    // 解锁：真机验证过车辆接受 BLE 的 REMOTE_DRIVE，所以这里在解锁终态成功之后
    // 自动补发一条驾驶授权（vehicle-api.unlockAndDrive 负责编排），上车不用再点第二次。
    // 前提只有「解锁真的成功了」；授权被拒时两条回执分开贴，不代替车辆下结论。
    onConfirm() {
      const key = this.dlg
      this.dlg = ''
      if (key !== 'unlock') return
      return this.guard(12, async () => {
        this.report(await unlockAndDrive())
      })
    },
    doLock() {
      return this.guard(11, async () => {
        this.report(await sendRke(rkeEnum('RKE_ACTION_LOCK'), 'LOCK'))
      })
    },
    // 驾驶授权：单独重试用的这颗（授权窗口约两分钟，过期或当时被拒时不必重走解锁）。
    // 回执原样上报，被车端拒时 command-dispatcher 会把 GenericError 的处置建议附在 text 里。
    doDrive() {
      return this.guard(13, async () => {
        this.report(await remoteDrive())
      })
    },
    doFlash() {
      return this.guard(21, async () => {
        this.report(await flashLights())
      })
    },
    doHorn() {
      return this.guard(22, async () => {
        this.report(await honkHorn())
      })
    },
    doLid(key) {
      const field = key === 'frunk' ? 'frontTrunk' : 'rearTrunk'
      const name = key === 'frunk' ? 'OPEN_FRUNK' : 'OPEN_TRUNK'
      return this.guard(31, async () => {
        const req = {}
        req[field] = closureEnum('CLOSURE_MOVE_TYPE_OPEN')
        this.report(await sendClosure(req, name))
      })
    },
    doHvac(on) {
      return this.guard(on ? 41 : 42, async () => {
        this.report(await hvacAuto(on))
      })
    },
    doWindow(mode) {
      return this.guard(mode === 'vent' ? 51 : 52, async () => {
        this.report(await windowAction(mode))
      })
    },
    doPort(key, open) {
      const p = key === 'A' ? PATHS[0] : PATHS[1]
      return this.guard(open ? p.busyOpen : p.busyClose, async () => {
        if (key === 'A') {
          this.report(await chargePortDoor(open))
          return
        }
        const req = {}
        req.chargePort = closureEnum(open ? 'CLOSURE_MOVE_TYPE_OPEN' : 'CLOSURE_MOVE_TYPE_CLOSE')
        this.report(await sendClosure(req, open ? p.names[0] : p.names[1]))
      })
    },
    doRefresh() {
      return this.guard(91, async () => {
        this.report(await vehicleData(vehicleDataAll().slice()))
      })
    },
    // 只拉闭锁器：人站在车边看盖板/车门有没有真的动，用这一条省一次全量往返
    doRefreshClosures() {
      return this.guard(92, async () => {
        this.report(await vehicleData(['closures']))
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

.topwrap {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
}

.topbox {
  position: relative;
  width: 280rpx;
  height: 438rpx;
  flex-shrink: 0;
}

.toplist {
  flex: 1;
  margin-left: 16rpx;
}

.st {
  display: flex;
  flex-direction: row;
  align-items: center;
  padding: 9rpx 0;
}

.st-name {
  width: 140rpx;
  font-size: 23rpx;
  color: var(--text-3);
}

.st-val {
  flex: 1;
  font-size: 25rpx;
  color: var(--text);
  text-align: right;
}

/* 点位：三态各一种颜色，位置由 vehicleView 的语义字段决定（见 dots 计算属性） */
.dot {
  position: absolute;
  width: 20rpx;
  height: 20rpx;
  margin-left: -10rpx;
  margin-top: -10rpx;
  border-radius: 50%;
  border: 2rpx solid var(--line);
  background-color: var(--card-3);
}

.dot-open {
  background-color: var(--warn);
  border-color: var(--warn);
}

.dot-shut {
  background-color: var(--ok);
  border-color: var(--ok);
}

.dot-unk {
  background-color: transparent;
  border-color: var(--text-3);
  border-style: dashed;
}

/* 未上锁是「要留意」而不是「开着」，所以锁这一行单独用红色而不是复用三态 */
.dot-bad {
  background-color: var(--err);
  border-color: var(--err);
}

.dot-legend {
  position: static;
  width: 16rpx;
  height: 16rpx;
  margin: 0 12rpx 0 0;
}

.lid {
  margin-bottom: 14rpx;
}

.lid-head {
  display: flex;
  flex-direction: row;
  align-items: center;
  padding: 6rpx 0 2rpx 0;
}

.lid-name {
  flex: 1;
  margin-left: 14rpx;
  font-size: 26rpx;
  color: var(--text);
}

.lid-state {
  font-size: 23rpx;
  color: var(--text-3);
}

.ab {
  margin-top: 16rpx;
  padding-top: 14rpx;
  border-top: 1rpx solid var(--line);
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

.drive-res {
  flex: 1;
  min-width: 0;
  margin-left: 14rpx;
  font-size: 21rpx;
  line-height: 30rpx;
  text-align: right;
  color: var(--text-3);
}

.fresh {
  margin-top: 12rpx;
  font-size: 21rpx;
  color: var(--text-3);
}
</style>
