<template>
  <!--
    自定义底部标签栏：不用原生 tabBar，因为原生 tabBar 强制要 PNG 图标，
    而本项目一个图片资源都不引（图标全部内联 SVG）。
    切页用 reLaunch，行为等同切 tab：栈里只留当前这一页，页面里的订阅会正常释放。
  -->
  <view class="tf-tabbar-root">
    <view class="tf-tabbar-space" />
    <view class="tf-tabbar">
      <view
        v-for="t in tabs"
        :key="t.key"
        class="tf-tab"
        hover-class="tf-tab-hover"
        @click="go(t)"
      >
        <image class="tf-tab-ico" :src="pic(t)" mode="aspectFit" :style="{ width: tabIconSize, height: tabIconSize }" />
        <text class="tf-tab-text" :class="{ 'tf-tab-on': t.key === active }">{{ t.text }}</text>
      </view>
    </view>
  </view>
</template>

<script>
// 这里不 import tf-icon，而是直接吃 icons.js：组件引组件靠 easycom，
// 少一层依赖就少一种「easycom 在组件里没生效」的排查成本。
import { iconSrc } from '@/src/ui/icons.js'

const TABS = [
  { key: 'home', text: '车辆', icon: 'car', url: '/pages/home/home' },
  { key: 'control', text: '控制', icon: 'lock', url: '/pages/control/control' },
  { key: 'climate', text: '温度', icon: 'thermo', url: '/pages/climate/climate' },
  { key: 'info', text: '信息', icon: 'info', url: '/pages/info/info' },
  { key: 'diagnostics', text: '诊断', icon: 'pulse', url: '/pages/diagnostics/diagnostics' }
];

export default {
  name: 'TfTabbar',
  props: {
    active: { type: String, default: 'home' },
    tabIconSize: { type: String, default: '46rpx' },
    onColor: { type: String, default: '#ffffff' },
    offColor: { type: String, default: '#7a8593' }
  },
  data() {
    return { tabs: TABS };
  },
  methods: {
    pic(t) {
      return iconSrc(t.icon, t.key === this.active ? this.onColor : this.offColor);
    },
    go(t) {
      if (t.key === this.active) return;
      uni.reLaunch({ url: t.url });
    }
  }
};
</script>

<style scoped>
.tf-tabbar-space {
  height: 118rpx;
}

.tf-tab-ico {
  display: block;
}

.tf-tabbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: row;
  background-color: var(--bar);
  border-top: 1rpx solid var(--line);
  padding-bottom: env(safe-area-inset-bottom);
  z-index: 20;
}

.tf-tab {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 12rpx 0 14rpx 0;
}

.tf-tab-hover {
  background-color: var(--card-2);
}

.tf-tab-text {
  margin-top: 6rpx;
  font-size: 20rpx;
  color: var(--text-3);
}

.tf-tab-on {
  color: var(--text);
  font-weight: bold;
}
</style>
