// components/tesla_core/include/tesla_core/tlb_frame.h
// BLE 分帧：2 字节大端长度前缀 + 跨通知重组（对齐探针 src/infra/ble/frame-codec.js）。
#pragma once

#include "tlb_types.h"

#define TLB_FRAME_RX_IDLE_MS 1000 // = 官方 rxTimeout：两包之间静默超过它，残字节是垃圾
#define TLB_FRAME_MAX_BYTES TLB_FRAME_MAX
#define TLB_FRAME_NOTIFY_MAX 517  // 单条 ATT 通知上限（MTU 512 + 3）
#define TLB_FRAME_BUF (TLB_FRAME_MAX + 2 + TLB_FRAME_NOTIFY_MAX)

typedef struct {
    uint8_t buf[TLB_FRAME_BUF];
    size_t len;
    int64_t last_at;
    uint32_t dropped; // 丢弃事件数，只给日志判读用
} tlb_frame_t;

// body 指针落在 f->buf 内，仅在回调期间有效
typedef void (*tlb_frame_fn)(void *ud, const uint8_t *body, size_t body_len);

void tlb_frame_reset(tlb_frame_t *f);

// ---------------------------------------------------------------- 分包上限（mtu-manager.js）
#define TLB_MTU_DEFAULT 23 // Android 未协商前的 ATT 默认值
#define TLB_MTU_STEPS_N 5
// 从 Android ATT 常见上限往下阶梯试探；一律以回读到的实际值为准
extern const int tlb_mtu_steps[TLB_MTU_STEPS_N];

// payloadCap(mtu) = max(20, min(mtu || 23, MAX_FRAME) - 3)：ATT 操作码 + 句柄占 3 字节。
// mtu == 0 走默认值（JS 的 || 语义），负数按 20 兜底。
size_t tlb_payload_cap(int mtu);

// 发送侧：补 2 字节大端长度前缀
bool tlb_frame_prepend(const uint8_t *msg, size_t msg_len, uint8_t *out, size_t out_cap,
                       size_t *out_len);

// 接收侧：剥掉长度前缀并校验，不符即 false（调用方按「这一帧作废」处理）
bool tlb_frame_strip(const uint8_t *frame, size_t frame_len, const uint8_t **body,
                     size_t *body_len);

void tlb_frame_push(tlb_frame_t *f, const uint8_t *chunk, size_t chunk_len, int64_t now_ms,
                    tlb_frame_fn on_frame, void *ud);
