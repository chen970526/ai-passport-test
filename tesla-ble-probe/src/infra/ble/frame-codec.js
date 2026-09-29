// BLE 分帧：2 字节大端长度前缀 + 跨通知重组。
//
// 依据（官方 pkg/connector/ble/ble.go，逐字对齐）：
//   protocol.md:160-161  每帧前面带 2 字节大端长度前缀，接收端靠它重新组包
//   ble.go:98-106  rx()   ：两包之间超过 rxTimeout(1s)，上一帧就是断在半路，残字节是垃圾
//   ble.go:flush()         ：声明长度 > maxBLEMessageSize(1024) 一定是错位前缀，整块丢掉重新对齐
//
// 为什么必须「整块丢掉」而不是「跳过 2 字节继续找」：一旦卡在「等待后续分包」，
// 之后每一条正常响应都会被这个错误的期望长度吃掉，现场表现是全线超时，
// 排查时看起来像协议错，其实是传输层失步。

import { concatBytes, toHex } from '../bytes.js';

export const RX_IDLE_MS = 1000; // = 官方 rxTimeout
export const MAX_FRAME = 1024; // = 官方 maxBLEMessageSize

// 发送侧：给完整报文补上长度前缀
export function prependLength(msg) {
  return concatBytes([new Uint8Array([(msg.length >> 8) & 0xff, msg.length & 0xff]), msg]);
}

// 接收侧：剥掉长度前缀并校验，不符就抛（调用方按「这一帧作废」处理）
export function stripLength(frame) {
  if (frame.length < 2) throw new Error('报文不足 2 字节');
  const expect = (frame[0] << 8) | frame[1];
  const body = frame.subarray(2);
  if (body.length !== expect) {
    throw new Error('长度前缀不符: 声明 ' + expect + ' 实际 ' + body.length);
  }
  return body;
}

// 一次 ATT 通知只能装一个 PDU，而特斯拉响应里有 65 字节的临时公钥，
// 所以「一通知 ≠ 一帧」是常态。这个类把 chunk 流还原成帧流。
export class FrameReassembler {
  constructor(opts) {
    const o = opts || {};
    this.onFrame = o.onFrame || function () {};
    this.log = o.log || function () {};
    // 注意：发送方**不会**清空 buffer —— 官方传输层从不因为「又发了一条」就丢掉正在拼的半截帧，
    // 只在分包静默 RX_IDLE_MS 后清。GetVehicleData 的响应要拆成十几包慢慢推，
    // 中途清一次就送进 GCM 就只剩半截密文，现场表现正是「响应 GCM tag 不符」＋「等待终态超时」。
    this.buffer = new Uint8Array(0);
    this.lastAt = 0;
    this.dropped = 0; // 累计丢弃字节数，只给日志用（「已丢弃 N 帧」那类判读要看它）
  }

  reset() {
    this.buffer = new Uint8Array(0);
    this.lastAt = 0;
  }

  push(chunk) {
    const now = Date.now();
    if (this.buffer.length && now - this.lastAt > RX_IDLE_MS) {
      this.dropped++;
      this.log('warn', '分包间隔超过 ' + RX_IDLE_MS + 'ms，丢弃上一帧残留的 ' + this.buffer.length + ' 字节');
      this.buffer = new Uint8Array(0);
    }
    this.lastAt = now;
    this.buffer = concatBytes([this.buffer, chunk]);

    // 一次通知可能同时给「上一帧的尾巴 + 下一帧的开头」，必须循环切而不是只切一次
    while (this.buffer.length >= 2) {
      const declared = (this.buffer[0] << 8) | this.buffer[1];
      if (declared > MAX_FRAME) {
        this.dropped++;
        this.log('error', '长度前缀 ' + declared + ' 超过单帧上限 ' + MAX_FRAME + '，丢弃 ' + this.buffer.length + ' 字节重新对齐');
        this.buffer = new Uint8Array(0);
        return;
      }
      if (this.buffer.length < declared + 2) {
        this.log('info', '等待后续分包（已有 ' + this.buffer.length + ' / 需要 ' + (declared + 2) + '）');
        return;
      }
      const frame = this.buffer.subarray(0, declared + 2);
      this.buffer = this.buffer.subarray(declared + 2);
      let body;
      try {
        body = stripLength(frame);
      } catch (e) {
        this.dropped++;
        this.log('error', '分帧失败: ' + ((e && e.message) || e) + ' 原始=' + toHex(frame));
        continue;
      }
      this.onFrame(body);
    }
  }
}
