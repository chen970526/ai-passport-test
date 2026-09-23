<template>
  <view class="wrap">
    <view class="card">
      <view class="title">原始帧（最近 {{ raw.length }} 条）</view>
      <scroll-view scroll-y class="raw">
        <view v-for="(r, i) in raw" :key="i" class="rawline">
          <text :class="r.dir === 'tx' ? 'dirtx' : 'dirrx'">{{ r.dir === 'tx' ? '→车' : '←车' }}</text>
          <text class="monoblock">{{ r.hex }}</text>
        </view>
        <text v-if="!raw.length" class="tip">还没有数据</text>
      </scroll-view>
    </view>

    <view class="card">
      <view class="title">手工组包（V3 · JSON = {{ rootName }}，bytes 字段可直接写 hex 字符串）</view>
      <textarea class="ta" v-model="json" :style="{ height: taH }" auto-height="false" />
      <view class="row">
        <button class="btn btn-plain" size="mini" @click="preset('bind')">绑定样例</button>
        <button class="btn btn-plain" size="mini" @click="preset('eph')">临时公钥样例</button>
        <button class="btn btn-plain" size="mini" @click="preset('rke')">RKE 样例</button>
      </view>
      <view class="row">
        <button class="btn" size="mini" :loading="busy === 1" @click="sendJson">编码并发送</button>
        <button class="btn btn-plain" size="mini" @click="encodeOnly">只编码不发送</button>
      </view>
    </view>

    <view class="card">
      <view class="title">裸报文</view>
      <textarea class="ta" v-model="hex" placeholder="粘贴 hex（含或不含 2 字节长度前缀都行）" />
      <view class="row">
        <button class="btn btn-plain" size="mini" @click="pick('FromVCSECMessage')">解析为 FromVCSEC</button>
        <button class="btn btn-plain" size="mini" @click="pick('ToVCSECMessage')">解析为 ToVCSEC</button>
        <button class="btn btn-plain" size="mini" @click="pick('UnsignedMessage')">解析为 Unsigned</button>
        <button class="btn" size="mini" :loading="busy === 2" @click="sendHex">直接发送</button>
      </view>
      <text class="monoblock out">{{ result }}</text>
    </view>

    <view class="card">
      <view class="title">规格速查（现场怀疑字段号时改这里）</view>
      <view class="field">
        <text class="field-label">Message</text>
        <picker :range="msgNames" @change="onMsg">
          <view class="input picker">{{ msgName }}</view>
        </picker>
      </view>
      <text class="monoblock out">{{ msgDump }}</text>
      <view class="field">
        <text class="field-label">Enum</text>
        <picker :range="enumNames" @change="onEnum">
          <view class="input picker">{{ enumName }}</view>
        </picker>
      </view>
      <text class="monoblock out">{{ enumDump }}</text>
    </view>

    <view class="card">
      <view class="title">日志</view>
      <log-box height="460rpx" />
    </view>
  </view>
</template>

<script>
import { log, state, ble, connection, beginAction, endAction } from '@/common/session.js'
import { toolkit } from '@/common/api.js'
import { fromHex, toHex } from '@/common/bytes.js'

// V3：绑定仍是裸 ToVCSECMessage（此时还没有会话），其余是明文 RoutableMessage
function presets(tk) {
  const D = tk.SPEC.enums.Domain
  return {
    bind: {
      signedMessage: { signatureType: 2, protobufMessageAsBytes: '' }
    },
    eph: {
      to_destination: { domain: D.DOMAIN_INFOTAINMENT },
      session_info_request: { public_key: '', challenge: '' },
      request_uuid: '',
      uuid: ''
    },
    rke: {
      to_destination: { domain: D.DOMAIN_VEHICLE_SECURITY },
      protobuf_message_as_bytes: '',
      flags: 2
    }
  }
}

export default {
  data() {
    const tk = toolkit()
    const p = presets(tk)
    return {
      raw: [],
      json: JSON.stringify(p.eph, null, 1),
      hex: '',
      result: '',
      taH: '220rpx',
      busy: 0,
      rootName: 'RoutableMessage',
      msgNames: Object.keys(tk.SPEC.messages),
      msgName: 'RoutableMessage',
      enumNames: Object.keys(tk.SPEC.enums),
      enumName: 'MessageFault_E'
    }
  },
  computed: {
    msgDump() {
      const list = (toolkit().SPEC.messages || {})[this.msgName] || []
      return list
        .map((f) => f.num + ' ' + f.name + ' : ' + f.kind + (f.enum ? '<' + f.enum + '>' : f.msg ? '<' + f.msg + '>' : '') + (f.rep ? ' repeated' : ''))
        .join('\n')
    },
    enumDump() {
      const map = (toolkit().SPEC.enums || {})[this.enumName] || {}
      return Object.keys(map)
        .map((k) => map[k] + ' ' + k)
        .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
        .join('\n')
    }
  },
  onShow() {
    this.raw = connection.raw.slice()
    this._timer = setInterval(() => {
      this.raw = connection.raw.slice()
    }, 700)
  },
  onHide() {
    clearInterval(this._timer)
  },
  unmounted() {
    clearInterval(this._timer)
  },
  methods: {
    preset(k) {
      const tk = toolkit()
      const p = JSON.parse(JSON.stringify(presets(tk)[k]))
      this.rootName = k === 'bind' ? 'ToVCSECMessage' : 'RoutableMessage'
      if (!state.publicKey) {
        this.result = '先在①页生成密钥（绑定或查白名单会自动生成），preset 需要真实公钥才能算出内层报文'
        this.json = JSON.stringify(p, null, 1)
        return
      }
      const F = tk.SPEC.enums.KeyFormFactor
      const ROLE = tk.SPEC.enums.Role
      if (k === 'bind') {
        // 现行 proto 里 permission 数组已被 keyRole 取代
        const inner = tk.encode(tk.SPEC, 'UnsignedMessage', {
          WhitelistOperation: {
            addKeyToWhitelistAndAddPermissions: { key: { PublicKeyRaw: toHex(state.publicKey) }, keyRole: ROLE.ROLE_DRIVER },
            metadataForKey: { keyFormFactor: F.KEY_FORM_FACTOR_ANDROID_DEVICE }
          }
        })
        p.signedMessage.protobufMessageAsBytes = toHex(inner)
        this.result = 'bind 内层 = 未加密的 UnsignedMessage（' + inner.length + 'B），signatureType=PRESENT_KEY；' +
          '这条链路官方不等响应，①页的「绑定」按钮发的就是它'
      }
      if (k === 'eph') {
        p.session_info_request.public_key = toHex(state.publicKey)
        this.result = 'eph = 握手第一步（session_info_request），明文；车辆的 session_info 要配 session_info_tag 才认'
      }
      if (k === 'rke') {
        const action = 1 // LOCK
        const inner = tk.encode(tk.SPEC, 'UnsignedMessage', { RKEAction: action })
        p.protobuf_message_as_bytes = toHex(inner)
        this.result = '注意：这里组的是「明文」RoutableMessage，只用于看字段；' +
          '真发 RKE 请用②页按钮（会自动握手 + AES-GCM 加密 + counter 递增）。'
      }
      this.json = JSON.stringify(p, null, 1)
    },
    buildFromJson() {
      const tk = toolkit()
      const obj = JSON.parse(this.json)
      const body = tk.encode(tk.SPEC, this.rootName, obj)
      return { tk, obj, body, frame: tk.prependLength(body) }
    },
    encodeOnly() {
      try {
        const r = this.buildFromJson()
        this.result = 'protobuf ' + r.body.length + 'B: ' + toHex(r.body) + '\n带长度前缀 ' + r.frame.length + 'B: ' + toHex(r.frame) +
          '\n回读校验:\n' + r.tk.inspect(r.tk.SPEC, this.rootName, r.tk.decode(r.tk.SPEC, this.rootName, r.body))
        log('tx', '手工编码 ' + toHex(r.frame))
      } catch (e) {
        this.result = '失败: ' + ((e && e.message) || e)
        log('error', '手工编码失败: ' + ((e && e.message) || e))
      }
    },
    // 响应解读：先判断这帧是不是 RoutableMessage，不是就按裸 FromVCSECMessage 解
    describeResponse(tk, body) {
      const parsed = tk.parseFrame(body)
      if (parsed.kind !== 'routable') {
        const dec = tk.decode(tk.SPEC, 'FromVCSECMessage', parsed.vcsec || body)
        return '响应（裸 FromVCSECMessage）\n' + tk.inspect(tk.SPEC, 'FromVCSECMessage', dec) + '\n摘要: ' + this.summaryOf(tk, dec)
      }
      let out = '响应（RoutableMessage）\n' + tk.inspect(tk.SPEC, 'RoutableMessage', parsed.rm) + '\n摘要: ' + tk.summarize(parsed.rm).text
      if (parsed.rm.protobuf_message_as_bytes && parsed.rm.protobuf_message_as_bytes.length) {
        const dec = tk.decode(tk.SPEC, 'FromVCSECMessage', parsed.rm.protobuf_message_as_bytes)
        out += '\n内层 FromVCSECMessage:\n' + tk.inspect(tk.SPEC, 'FromVCSECMessage', dec)
      }
      return out
    },
    async sendJson() {
      if (this.busy) return
      this.busy = 1
      beginAction('报文控制台 · 手工组包发送（' + this.rootName + '）')
      let outcome = ''
      try {
        const r = this.buildFromJson()
        // 收帧窗口里车辆可能连发多帧，keepQueue=true 才不丢暂存的 ACK
        const body = await ble().send(r.frame, 8000, true)
        if (!body) {
          this.result = '已发送，不等待响应'
          outcome = '已发送（无响应）'
          return
        }
        this.result = this.describeResponse(r.tk, body)
        outcome = '已收到响应'
      } catch (e) {
        this.result = '失败: ' + ((e && e.message) || e)
        log('error', '手工发送失败: ' + ((e && e.message) || e))
        outcome = '失败：' + ((e && e.message) || e)
      } finally {
        endAction(outcome)
        this.busy = 0
      }
    },
    summaryOf(tk, obj) {
      const cs = obj && obj.commandStatus
      if (!cs) return '(无 commandStatus)'
      return 'status=' + tk.label('VCOperationStatus_E', cs.operationStatus)
    },
    normalizeHex() {
      const s = this.hex.replace(/[^0-9a-fA-F]/g, '')
      if (s.length % 2 !== 0) throw new Error('hex 长度必须是偶数')
      let bytes = fromHex(s)
      if (bytes.length >= 2) {
        const declared = (bytes[0] << 8) | bytes[1]
        if (declared === bytes.length - 2) bytes = bytes.subarray(2)
      }
      return bytes
    },
    pick(msgName) {
      try {
        const tk = toolkit()
        const bytes = this.normalizeHex()
        const obj = tk.decode(tk.SPEC, msgName, bytes)
        this.result = '按 ' + msgName + ' 解析:\n' + tk.inspect(tk.SPEC, msgName, obj)
      } catch (e) {
        this.result = '解析失败: ' + ((e && e.message) || e)
      }
    },
    async sendHex() {
      if (this.busy) return
      this.busy = 2
      beginAction('报文控制台 · 裸报文发送')
      let outcome = ''
      try {
        const tk = toolkit()
        const inner = this.normalizeHex()
        const frame = tk.prependLength(inner)
        const body = await ble().send(frame, 8000, true)
        this.result = body ? this.describeResponse(tk, body) : '已发送'
        outcome = body ? '已收到响应' : '已发送（无响应）'
      } catch (e) {
        this.result = '失败: ' + ((e && e.message) || e)
        log('error', '裸发送失败: ' + ((e && e.message) || e))
        outcome = '失败：' + ((e && e.message) || e)
      } finally {
        endAction(outcome)
        this.busy = 0
      }
    },
    onMsg(e) {
      this.msgName = this.msgNames[e.detail.value]
    },
    onEnum(e) {
      this.enumName = this.enumNames[e.detail.value]
    }
  }
}
</script>

<style scoped>
.raw {
  height: 220rpx;
  background-color: #f1f3f5;
  border-radius: 6rpx;
  padding: 6rpx;
}

.rawline {
  display: flex;
  flex-direction: row;
}

.dirtx {
  width: 60rpx;
  color: #1971c2;
  font-size: 20rpx;
}

.dirrx {
  width: 60rpx;
  color: #6741d9;
  font-size: 20rpx;
}

.monoblock {
  flex: 1;
  font-family: monospace;
  font-size: 20rpx;
  color: #343a40;
  word-break: break-all;
  white-space: pre-wrap;
}

.out {
  display: block;
  margin-top: 10rpx;
  background-color: #f8f9fa;
  padding: 8rpx;
  border-radius: 6rpx;
  min-height: 40rpx;
}

.ta {
  width: 100%;
  height: 160rpx;
  border: 1rpx solid #ced4da;
  border-radius: 6rpx;
  padding: 10rpx;
  font-family: monospace;
  font-size: 22rpx;
  box-sizing: border-box;
}

.picker {
  line-height: 68rpx;
}
</style>
