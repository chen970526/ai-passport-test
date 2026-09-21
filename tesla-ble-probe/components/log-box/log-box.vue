<template>
  <view class="logbox">
    <view class="logbar">
      <text class="logcount">共 {{ list.length }} 条</text>
      <button class="btn btn-plain mini" size="mini" @click="clear">清空</button>
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
import { getLogs, subscribe, clearLogs } from '@/common/session.js'

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
