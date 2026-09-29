<template>
  <!--
    纯 CSS 画的车辆图标：不引图片、不引字体图标，App / H5 / 小程序一套代码通吃。
    所有尺寸都用百分比，靠外层 size 缩放；描边一律 6rpx（在 64~120rpx 区间都好看）。
    支持的 name：lock / unlock / frunk / trunk / charge / car / info
  -->
  <view class="ico" :class="'ico-' + n" :style="{ width: size, height: size }">
    <!-- 车锁：锁梁 + 锁体；unlock 把锁梁抬起并歪一点，一眼能看出「开着」 -->
    <template v-if="n === 'lock' || n === 'unlock'">
      <view class="lk-shackle" :class="{ 'lk-open': n === 'unlock' }" :style="line" />
      <view class="lk-body" :style="fill" />
    </template>

    <!-- 侧视车辆：frunk / trunk 在对应一端上方加一条掀起的盖线 -->
    <template v-if="n === 'car' || n === 'frunk' || n === 'trunk'">
      <view class="cr-cabin" :style="line" />
      <view class="cr-body" :style="line" />
      <view class="cr-wheel cr-wheel-l" :style="fill" />
      <view class="cr-wheel cr-wheel-r" :style="fill" />
      <view v-if="n === 'frunk'" class="cr-lid cr-lid-l" :style="fill" />
      <view v-if="n === 'trunk'" class="cr-lid cr-lid-r" :style="fill" />
    </template>

    <!-- 充电口：特斯拉的盖板是个椭圆 + 闪电 -->
    <template v-if="n === 'charge'">
      <view class="ch-ring" :style="line" />
      <view class="ch-bolt" :style="fill" />
    </template>

    <template v-if="n === 'info'">
      <view class="if-ring" :style="line" />
      <view class="if-dot" :style="fill" />
      <view class="if-bar" :style="fill" />
    </template>
  </view>
</template>

<script>
export default {
  name: 'CarIcon',
  props: {
    name: { type: String, default: 'car' },
    size: { type: String, default: '72rpx' },
    color: { type: String, default: '#343a40' }
  },
  computed: {
    n() {
      return this.name || 'car'
    },
    fill() {
      return { backgroundColor: this.color }
    },
    line() {
      return { borderColor: this.color }
    }
  }
}
</script>

<style scoped>
.ico {
  position: relative;
  display: inline-block;
}

/* ---------------------------------------------------------------- 车锁 */
.lk-shackle {
  position: absolute;
  left: 26%;
  top: 8%;
  width: 48%;
  height: 44%;
  box-sizing: border-box;
  border: 6rpx solid #343a40;
  border-bottom: none;
  border-radius: 50% 50% 0 0;
  transition: transform 0.2s;
}

.lk-open {
  transform: translate(-24%, -16%) rotate(-14deg);
}

.lk-body {
  position: absolute;
  left: 16%;
  top: 44%;
  width: 68%;
  height: 46%;
  border-radius: 16%;
}

/* ---------------------------------------------------------------- 车辆侧视 */
.cr-cabin {
  position: absolute;
  left: 28%;
  top: 22%;
  width: 44%;
  height: 26%;
  box-sizing: border-box;
  border: 6rpx solid #343a40;
  border-bottom: none;
  border-radius: 46% 46% 0 0;
}

.cr-body {
  position: absolute;
  left: 8%;
  top: 46%;
  width: 84%;
  height: 26%;
  box-sizing: border-box;
  border: 6rpx solid #343a40;
  border-radius: 12rpx;
}

.cr-wheel {
  position: absolute;
  top: 64%;
  width: 20%;
  height: 20%;
  border-radius: 50%;
}

.cr-wheel-l {
  left: 16%;
}

.cr-wheel-r {
  right: 16%;
}

/* 掀起的盖板：一条短线绕铰点转出去 */
.cr-lid {
  position: absolute;
  top: 14%;
  width: 30%;
  height: 6rpx;
  border-radius: 4rpx;
}

.cr-lid-l {
  left: 4%;
  transform: rotate(-26deg);
  transform-origin: 100% 50%;
}

.cr-lid-r {
  right: 4%;
  transform: rotate(26deg);
  transform-origin: 0 50%;
}

/* ---------------------------------------------------------------- 充电口 */
.ch-ring {
  position: absolute;
  left: 24%;
  top: 10%;
  width: 52%;
  height: 80%;
  box-sizing: border-box;
  border: 6rpx solid #343a40;
  border-radius: 50%;
}

.ch-bolt {
  position: absolute;
  left: 36%;
  top: 26%;
  width: 28%;
  height: 48%;
  /* clip-path 只在不支持的极老 webview 上退化成一块颜色 */
  clip-path: polygon(62% 0, 8% 55%, 42% 55%, 32% 100%, 92% 42%, 55% 42%, 70% 0);
}

/* ---------------------------------------------------------------- 信息 */
.if-ring {
  position: absolute;
  left: 10%;
  top: 10%;
  width: 80%;
  height: 80%;
  box-sizing: border-box;
  border: 6rpx solid #343a40;
  border-radius: 50%;
}

.if-dot {
  position: absolute;
  left: 46%;
  top: 26%;
  width: 8%;
  height: 8%;
  border-radius: 50%;
}

.if-bar {
  position: absolute;
  left: 46%;
  top: 40%;
  width: 8%;
  height: 34%;
  border-radius: 4rpx;
}
</style>
