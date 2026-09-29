<template>
  <!--
    带倒计时的二次确认弹窗：确认按钮要等 seconds 秒才点亮。
    为什么不是「倒计时结束自动执行」：这个项目里所有动作都是往车上发真命令，
    自动执行等于把一个「还要看一眼」的决定交给时间；反过来（必须先等几秒）
    才能真正挡住「手比脑子快」的连点。
  -->
  <view v-if="show" class="cd-mask" @click="onCancel">
    <view class="cd-card" @click.stop>
      <view class="cd-title">{{ title }}</view>
      <view class="cd-desc">{{ desc }}</view>
      <view v-if="tip" class="cd-tip">{{ tip }}</view>
      <view class="cd-row">
        <view class="cd-btn cd-plain" @click="onCancel">{{ cancelText }}</view>
        <view class="cd-btn cd-go" :class="[left > 0 ? 'cd-wait' : '', danger ? 'cd-danger' : '']" @click="onConfirm">
          {{ left > 0 ? confirmText + '（' + left + 's）' : confirmText }}
        </view>
      </view>
    </view>
  </view>
</template>

<script>
export default {
  name: 'ConfirmDialog',
  props: {
    show: { type: Boolean, default: false },
    title: { type: String, default: '确认执行？' },
    desc: { type: String, default: '' },
    tip: { type: String, default: '' },
    confirmText: { type: String, default: '确认' },
    cancelText: { type: String, default: '取消' },
    seconds: { type: Number, default: 3 },
    danger: { type: Boolean, default: false }
  },
  data() {
    return { left: 0 }
  },
  watch: {
    show(v) {
      this.stop()
      if (v) this.start()
    }
  },
  beforeUnmount() {
    this.stop()
  },
  methods: {
    start() {
      const s = this.seconds > 0 ? Math.ceil(this.seconds) : 0
      this.left = s
      if (!s) return
      this._t = setInterval(() => {
        this.left--
        if (this.left <= 0) this.stop()
      }, 1000)
    },
    stop() {
      clearInterval(this._t)
      this._t = null
    },
    onConfirm() {
      if (this.left > 0) return
      this.$emit('confirm')
    },
    onCancel() {
      this.$emit('cancel')
    }
  }
}
</script>

<style scoped>
.cd-mask {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

/* 配色全部取自 App.vue 的那份变量：弹窗是全站共用的，不能自己留一套浅色 */
.cd-card {
  width: 600rpx;
  padding: 28rpx 24rpx 20rpx 24rpx;
  background-color: var(--card);
  border: 1rpx solid var(--line);
  border-radius: 16rpx;
}

.cd-title {
  font-size: 30rpx;
  font-weight: bold;
  color: var(--text);
  margin-bottom: 10rpx;
}

.cd-desc {
  font-size: 25rpx;
  color: var(--text-2);
  line-height: 38rpx;
}

.cd-tip {
  margin-top: 12rpx;
  padding: 10rpx 12rpx;
  font-size: 22rpx;
  color: var(--text-3);
  line-height: 32rpx;
  background-color: var(--card-2);
  border-radius: 6rpx;
}

.cd-row {
  display: flex;
  flex-direction: row;
  margin-top: 24rpx;
}

.cd-btn {
  flex: 1;
  height: 76rpx;
  line-height: 76rpx;
  margin: 0 10rpx;
  text-align: center;
  font-size: 28rpx;
  border-radius: 8rpx;
}

.cd-plain {
  background-color: var(--card-3);
  color: var(--text-2);
}

.cd-go {
  background-color: var(--accent-2);
  color: var(--text);
}

.cd-danger {
  background-color: #6b2020;
  color: #ffd7d7;
}

.cd-wait {
  background-color: var(--line);
  color: var(--text-3);
}
</style>
