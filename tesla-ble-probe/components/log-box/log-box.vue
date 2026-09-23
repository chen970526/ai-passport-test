<template>
  <view class="logbox">
    <view class="logbar">
      <text class="logcount">共 {{ list.length }} 条</text>
      <button class="btn btn-plain mini" size="mini" @click="clear">清空</button>
      <button class="btn btn-plain mini" size="mini" @click="copy">复制</button>
      <button class="btn btn-plain mini" size="mini" @click="follow = !follow">{{ follow ? '自动滚底:开' : '自动滚底:关' }}</button>
    </view>
    <scroll-view class="scroll" scroll-y :scroll-top="scrollTop" :style="{ height: height }">
      <view v-for="(l, i) in list" :key="i" class="line">
        <text class="ts">{{ l.stamp }}</text>
        <text class="tx" :class="'k-' + l.kind">{{ l.msg }}</text>
      </view>
    </scroll-view>
  </view>
</template>

<script>
import { getLogs, subscribe, clearLogs, log } from '@/common/session.js'
import { notify, copyText } from '@/common/notify.js'

export default {
  name: 'LogBox',
  props: {
    height: { type: String, default: '520rpx' }
  },
  data() {
    return {
      list: getLogs(),
      scrollTop: 0,
      follow: true
    }
  },
  mounted() {
    this.unsub = subscribe(() => {
      this.list = getLogs()
      if (this.follow) this.toBottom()
    })
  },
  beforeUnmount() {
    if (this.unsub) this.unsub()
  },
  methods: {
    toBottom() {
      // scroll-view 只有在值变化时才滚，所以来回抖一下
      this.scrollTop = this.scrollTop >= 99999 ? 99998 : 99999
    },
    clear() {
      clearLogs()
      this.list = getLogs()
    },
    // 把当前日志整段复制到剪贴板，这样反馈问题时不用截图
    copy() {
      if (!this.list.length) {
        notify('日志是空的，没什么可复制')
        return
      }
      const text = this.list.map((l) => (l.stamp ? l.stamp + ' ' : '') + l.msg).join('\n')
      const n = this.list.length
      copyText(text, (ok) => {
        if (ok) log('ok', '已复制 ' + n + ' 条日志到剪贴板，直接贴文本即可')
        else notify('当前环境不支持剪贴板（H5 请在真机 App 上用）')
      })
    }
  }
}
</script>

<style scoped>
.logbox {
  background-color: #10151c;
  border-radius: 8rpx;
  padding: 8rpx;
}

.logbar {
  display: flex;
  flex-direction: row;
  align-items: center;
  margin-bottom: 6rpx;
}

.logcount {
  flex: 1;
  color: #6c757d;
  font-size: 20rpx;
}

.mini {
  height: 48rpx;
  line-height: 48rpx;
  font-size: 20rpx;
  padding: 0 12rpx;
}

.scroll {
  flex: 1;
}

.line {
  display: flex;
  flex-direction: row;
  padding: 2rpx 4rpx;
}

.ts {
  width: 110rpx;
  color: #495057;
  font-family: monospace;
  font-size: 20rpx;
}

.tx {
  flex: 1;
  font-family: monospace;
  font-size: 21rpx;
  color: #adb5bd;
  word-break: break-all;
  white-space: pre-wrap;
}

.k-ok {
  color: #51cf66;
}

.k-error {
  color: #ff6b6b;
}

.k-warn {
  color: #fcc419;
}

.k-tx {
  color: #74c0fc;
}

.k-rx {
  color: #b197fc;
}

.k-info {
  color: #adb5bd;
}

.k-state {
  color: #3bc9db;
}
</style>
