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
      <view class="title">手工组包（JSON = ToVCSECMessage，bytes 字段可直接写 hex 字符串）</view>
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
import { log, state, ble, connection } from '@/common/session.js'
import { SPEC, encode, decode, inspect, prependLength, toHex, label } from '@/common/vcsec.js'
import { fromHex } from '@/common/bytes.js'

const PRESETS = {
  bind: {
    signedMessage: { signatureType: 2, protobufMessageAsBytes: '' }
  },
  eph: {
    unsignedMessage: { InformationRequest: { informationRequestType: 3, keyId: { publicKeySHA1: '' } } }
  },
  rke: {
    signedMessage: { signatureType: 0, protobufMessageAsBytes: '', counter: 1, signature: '', keyId: '' }
  }
}

export default {
  data() {
    return {
      raw: [],
      json: JSON.stringify(PRESETS.eph, null, 1),
      hex: '',
      result: '',
      taH: '220rpx',
      busy: 0,
      msgNames: Object.keys(SPEC.messages),
      msgName: 'FromVCSECMessage',
      enumNames: Object.keys(SPEC.enums),
      enumName: 'SignedMessage_information_E'
    }
  },
  computed: {
    msgDump() {
      const list = SPEC.messages[this.msgName] || []
      return list
        .map((f) => f.num + ' ' + f.name + ' : ' + f.kind + (f.enum ? '<' + f.enum + '>' : f.msg ? '<' + f.msg + '>' : '') + (f.rep ? ' repeated' : ''))
        .join('\n')
    },
    enumDump() {
      const map = SPEC.enums[this.enumName] || {}
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
    toast(t) {
      if (typeof uni !== 'undefined' && uni.showToast) uni.showToast({ title: t, icon: 'none', duration: 2200 })
    },
    preset(k) {
      const p = JSON.parse(JSON.stringify(PRESETS[k]))
      if (!state.publicKey) {
        this.result = '先在①页生成密钥（绑定或查白名单会自动生成），preset 需要真实公钥才能算出内层报文'
        this.json = JSON.stringify(p, null, 1)
        return
      }
      const P = SPEC.enums.WhitelistKeyPermission_E
      const F = SPEC.enums.KeyFormFactor
      if (k === 'bind') {
        const inner = encode(SPEC, 'UnsignedMessage', {
          WhitelistOperation: {
            addKeyToWhitelistAndAddPermissions: {
              key: { PublicKeyRaw: toHex(state.publicKey) },
              permission: [P.WHITELISTKEYPERMISSION_LOCAL_DRIVE, P.WHITELISTKEYPERMISSION_LOCAL_UNLOCK, P.WHITELISTKEYPERMISSION_REMOTE_DRIVE, P.WHITELISTKEYPERMISSION_REMOTE_UNLOCK]
            },
            metadataForKey: { keyFormFactor: F.KEY_FORM_FACTOR_ANDROID_DEVICE }
          }
        })
        p.signedMessage.protobufMessageAsBytes = toHex(inner)
        p.signedMessage.keyId = state.keyId
        this.result = 'bind 内层 = 未加密的 UnsignedMessage（' + inner.length + 'B）；发出后车辆回 WAIT，刷钥匙卡后回 OK'
      }
      if (k === 'eph') {
        p.unsignedMessage.InformationRequest.keyId.publicKeySHA1 = state.keyId
        this.result = 'eph 走 unsignedMessage（不加密），响应里 sessionInfo.publicKey 是 65 字节未压缩点'
      }
      if (k === 'rke') {
        const inner = encode(SPEC, 'UnsignedMessage', { RKEAction: 1 })
        p.signedMessage.protobufMessageAsBytes = toHex(inner)
        p.signedMessage.keyId = state.keyId
        p.signedMessage.counter = state.counter || 1
        this.result = '注意：这里的密文/明文是手填的，signature 需要你按 sharedKey + counter 自己算 GCM tag，' +
          '正常发 RKE 请用②页的按钮。本 preset 只用于观察报文结构。'
      }
      this.json = JSON.stringify(p, null, 1)
    },
    buildFromJson() {
      const obj = JSON.parse(this.json)
      const body = encode(SPEC, 'ToVCSECMessage', obj)
      return { obj, body, frame: prependLength(body) }
    },
    encodeOnly() {
      try {
        const r = this.buildFromJson()
        this.result = 'protobuf ' + r.body.length + 'B: ' + toHex(r.body) + '\n带长度前缀 ' + r.frame.length + 'B: ' + toHex(r.frame) +
          '\n回读校验:\n' + inspect(SPEC, 'ToVCSECMessage', decode(SPEC, 'ToVCSECMessage', r.body))
        log('tx', '手工编码 ' + toHex(r.frame))
      } catch (e) {
        this.result = '失败: ' + ((e && e.message) || e)
        log('error', '手工编码失败: ' + ((e && e.message) || e))
      }
    },
    async sendJson() {
      if (this.busy) return
      this.busy = 1
      try {
        const r = this.buildFromJson()
        const body = await ble().send(r.frame, 8000)
        if (!body) {
          this.result = '已发送，不等待响应'
          return
        }
        const dec = decode(SPEC, 'FromVCSECMessage', body)
        this.result = '响应 ' + toHex(body) + '\n' + inspect(SPEC, 'FromVCSECMessage', dec) + '\n摘要: ' + this.summaryOf(dec)
      } catch (e) {
        this.result = '失败: ' + ((e && e.message) || e)
        log('error', '手工发送失败: ' + ((e && e.message) || e))
      } finally {
        this.busy = 0
      }
    },
    summaryOf(obj) {
      const cs = obj && obj.commandStatus
      if (!cs) return '(无 commandStatus)'
      return 'status=' + label('OperationStatus_E', cs.operationStatus)
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
        const bytes = this.normalizeHex()
        const obj = decode(SPEC, msgName, bytes)
        this.result = '按 ' + msgName + ' 解析:\n' + inspect(SPEC, msgName, obj)
      } catch (e) {
        this.result = '解析失败: ' + ((e && e.message) || e)
      }
    },
    async sendHex() {
      if (this.busy) return
      this.busy = 2
      try {
        const inner = this.normalizeHex()
        const frame = prependLength(inner)
        const body = await ble().send(frame, 8000)
        this.result = body ? '响应 ' + toHex(body) + '\n' + inspect(SPEC, 'FromVCSECMessage', decode(SPEC, 'FromVCSECMessage', body)) : '已发送'
      } catch (e) {
        this.result = '失败: ' + ((e && e.message) || e)
        log('error', '裸发送失败: ' + ((e && e.message) || e))
      } finally {
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
