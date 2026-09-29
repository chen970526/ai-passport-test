<template>
  <!--
    滑动确认：把圆钮一路推到最右端才触发动作。
    为什么不用普通按钮：车控这几个动作（开前备箱、开充电盖板）是「发出去就收不回」的，
    误触的代价比多点一下高得多；滑动这个动作本身就把「想清楚了吗」这一步做掉了。
  -->
  <view class="sc" :class="{ 'sc-done': done, 'sc-off': disabled }">
    <view class="sc-track">
      <view class="sc-fill" :style="{ width: dx + knob + 'px' }" />
      <text class="sc-text">{{ done ? doneText : text }}</text>
      <view
        class="sc-knob"
        :style="{ transform: 'translateX(' + dx + 'px)', transition: dragging ? 'none' : 'transform .18s ease-out' }"
        @touchstart="onStart"
        @touchmove.stop.prevent="onMove"
        @touchend="onEnd"
        @touchcancel="onEnd"
      >
        <view class="sc-arrow" />
      </view>
    </view>
  </view>
</template>

<script>
const PAD = 4; // 轨道内边距，和样式里 .sc-knob 的 left/top 保持一致
const KNOB = 48; // 圆钮直径（px）
const RESET_MS = 900; // 触发后停留多久复位

export default {
  name: 'SlideConfirm',
  props: {
    text: { type: String, default: '→ 向右滑动确认' },
    doneText: { type: String, default: '已发送，可再次滑动' },
    disabled: { type: Boolean, default: false }
  },
  data() {
    return { dx: 0, dragging: false, done: false, max: 0, x0: 0, knob: KNOB }
  },
  mounted() {
    this.measure()
  },
  beforeUnmount() {
    clearTimeout(this._t)
  },
  methods: {
    measure() {
      const apply = (w) => {
        // 量不到（H5 首帧、组件被隐藏）就用一个够用的兜底值，至少推得到底
        const width = w && w > 120 ? w : 320
        this.max = Math.round(width - KNOB - PAD * 2)
      }
      if (typeof uni === 'undefined' || !uni.createSelectorQuery) {
        apply(0)
        return
      }
      uni
        .createSelectorQuery()
        .in(this)
        .select('.sc-track')
        .boundingClientRect((r) => apply(r && r.width))
        .exec()
    },
    px(e) {
      const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0])
      return t ? t.pageX : 0
    },
    onStart(e) {
      if (this.disabled || this.done) return
      if (!this.max) this.measure()
      this.dragging = true
      this.x0 = this.px(e) - this.dx
    },
    onMove(e) {
      if (!this.dragging) return
      let d = this.px(e) - this.x0
      if (d < 0) d = 0
      if (d > this.max) d = this.max
      this.dx = d
      // 推到底附近就立刻成立，不必要求指尖精确压在最后一像素上
      if (d >= this.max - 4) this.fire()
    },
    onEnd() {
      if (!this.dragging) return
      this.dragging = false
      if (!this.done) this.dx = 0
    },
    fire() {
      this.dragging = false
      this.done = true
      this.dx = this.max
      if (typeof uni !== 'undefined' && uni.vibrateShort) uni.vibrateShort({ fail: () => {} })
      this.$emit('confirm')
      clearTimeout(this._t)
      this._t = setTimeout(() => {
        this.done = false
        this.dx = 0
      }, RESET_MS)
    }
  }
}
</script>

<style scoped>
.sc {
  margin: 8rpx 0;
}

.sc-track {
  position: relative;
  height: 56px;
  padding: 0;
  border-radius: 28px;
  background-color: var(--card-2);
  border: 1rpx solid var(--line);
  overflow: hidden;
}

.sc-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background-color: rgba(74, 158, 255, 0.18);
}

.sc-text {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  line-height: 56px;
  text-align: center;
  font-size: 24rpx;
  color: var(--text-2);
}

.sc-knob {
  position: absolute;
  left: 4px;
  top: 4px;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background-color: var(--card-3);
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
}

.sc-arrow {
  width: 0;
  height: 0;
  border-top: 10rpx solid transparent;
  border-bottom: 10rpx solid transparent;
  border-left: 14rpx solid var(--accent);
}

.sc-done .sc-track {
  background-color: rgba(70, 214, 138, 0.14);
  border-color: var(--ok);
}

.sc-done .sc-text {
  color: var(--ok);
}

.sc-done .sc-fill {
  background-color: rgba(70, 214, 138, 0.18);
}

.sc-off {
  opacity: 0.45;
}
</style>
