<template>
  <!--
    图标渲染：把 src/ui/icons.js 里的 SVG 编成 data URI 交给 <image>。
    尺寸给 width/height（height 不写就跟 width 正方形），mode 用 aspectFit 保证线稿不变形。
    用法：<tf-icon name='lock' size='44rpx' color='#e8eaed' />
  -->
  <image class="tf-icon" :src="src" :style="box" mode="aspectFit" />
</template>

<script>
import { iconSrc } from '@/src/ui/icons.js'

export default {
  name: 'TfIcon',
  props: {
    name: { type: String, default: 'car' },
    size: { type: String, default: '44rpx' },
    height: { type: String, default: '' },
    color: { type: String, default: '#e8eaed' },
    weight: { type: [Number, String], default: 1.7 }
  },
  computed: {
    box() {
      return { width: this.size, height: this.height || this.size }
    },
    src() {
      return iconSrc(this.name, this.color, this.weight)
    }
  }
}
</script>

<style scoped>
.tf-icon {
  display: block;
  flex-shrink: 0;
}
</style>
