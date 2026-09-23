<script>
import { loadKey, log } from '@/common/session.js'
import { keepScreenOn, logRuntimeEnv } from '@/common/tesla-ble.js'

export default {
  onLaunch() {
    log('info', 'Tesla BLE 离线钥匙探针启动（V3 协议 / 纯 JS 密码学 + uni 原生蓝牙，不依赖任何 npm 原生插件）')
    logRuntimeEnv(log)
    loadKey()
    // 探针全程保持亮屏：绑定要等 60 秒刷钥匙卡，息屏会让整轮作废
    keepScreenOn(true)
  },
  onShow() {},
  onHide() {},
  onError(e) {
    log('error', '全局异常: ' + (e && e.message ? e.message : e))
  }
}
</script>

<style>
/* 探针不看 UI，只保证「按钮点得动、日志看得清」 */
page {
  background-color: #f7f7f7;
}

.wrap {
  padding: 12rpx 16rpx 40rpx 16rpx;
}

.card {
  background-color: #ffffff;
  border-radius: 8rpx;
  padding: 16rpx;
  margin-bottom: 16rpx;
  box-shadow: 0 1rpx 4rpx rgba(0, 0, 0, 0.06);
}

.title {
  font-size: 26rpx;
  font-weight: bold;
  color: #333333;
  margin-bottom: 10rpx;
}

.row {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
}

.tip {
  font-size: 22rpx;
  color: #888888;
  line-height: 32rpx;
}

.status {
  font-family: monospace;
  font-size: 22rpx;
  color: #0b7285;
  line-height: 32rpx;
  word-break: break-all;
}

.btn {
  margin: 6rpx 8rpx 6rpx 0;
  padding: 0 20rpx;
  height: 72rpx;
  line-height: 72rpx;
  font-size: 26rpx;
  background-color: #2b6cb0;
  color: #ffffff;
  border-radius: 6rpx;
  display: inline-block;
}

.btn-plain {
  background-color: #e9ecef;
  color: #343a40;
}

.btn-danger {
  background-color: #c92a2a;
}

.btn::after {
  border: none;
}

.field {
  display: flex;
  flex-direction: row;
  align-items: center;
  margin-bottom: 10rpx;
}

.field-label {
  width: 96rpx;
  font-size: 26rpx;
  color: #495057;
}

.input {
  flex: 1;
  height: 68rpx;
  padding: 0 14rpx;
  font-size: 26rpx;
  border: 1rpx solid #ced4da;
  border-radius: 6rpx;
  background-color: #ffffff;
}

.mono {
  font-family: monospace;
  font-size: 22rpx;
  word-break: break-all;
}
</style>
