// components/tesla_core/src/tlb_frame.c
// 分帧重组。语义必须与探针 frame-codec.js 的 FrameReassembler 一致，由金标准锁死：
//   1) 只有「分包静默 > RX_IDLE_MS」或「声明长度越界」才清 buffer，发送新请求不清；
//   2) 长度越界时整块丢弃并 return，绝不跳过 2 字节重新找头（否则会连锁吃掉后续正常响应）；
//   3) 一次通知可能同时带来「上一帧尾巴 + 下一帧开头」，必须循环切帧。
#include <string.h>

#include "tesla_core/tlb_frame.h"

void tlb_frame_reset(tlb_frame_t *f)
{
    if (!f) {
        return;
    }
    memset(f, 0, sizeof(*f));
}

const int tlb_mtu_steps[TLB_MTU_STEPS_N] = { 517, 247, 185, 128, 64 };

size_t tlb_payload_cap(int mtu)
{
    int m = mtu == 0 ? TLB_MTU_DEFAULT : mtu;
    int cap = m < TLB_FRAME_MAX_BYTES ? m : TLB_FRAME_MAX_BYTES;
    cap -= 3;
    return cap < 20 ? 20 : (size_t)cap;
}

bool tlb_frame_prepend(const uint8_t *msg, size_t msg_len, uint8_t *out, size_t out_cap,
                       size_t *out_len)
{
    if (!msg || !out || !out_len || msg_len > TLB_FRAME_MAX_BYTES || out_cap < msg_len + 2) {
        return false;
    }
    out[0] = (uint8_t)((msg_len >> 8) & 0xff);
    out[1] = (uint8_t)(msg_len & 0xff);
    memcpy(out + 2, msg, msg_len);
    *out_len = msg_len + 2;
    return true;
}

bool tlb_frame_strip(const uint8_t *frame, size_t frame_len, const uint8_t **body,
                     size_t *body_len)
{
    size_t expect;

    if (!frame || frame_len < 2 || !body || !body_len) {
        return false;
    }
    expect = ((size_t)frame[0] << 8) | frame[1];
    if (frame_len - 2 != expect) {
        return false;
    }
    *body = frame + 2;
    *body_len = expect;
    return true;
}

void tlb_frame_push(tlb_frame_t *f, const uint8_t *chunk, size_t chunk_len, int64_t now_ms,
                    tlb_frame_fn on_frame, void *ud)
{
    if (!f) {
        return;
    }
    if (f->len && now_ms - f->last_at > TLB_FRAME_RX_IDLE_MS) {
        f->dropped++;
        f->len = 0;
    }
    f->last_at = now_ms;
    if (chunk && chunk_len) {
        if (chunk_len > sizeof(f->buf) - f->len) {
            // 单条通知就超过缓冲上界：一定是失步，按越界同一处理——整块丢弃重新对齐
            f->dropped++;
            f->len = 0;
            if (chunk_len > sizeof(f->buf)) {
                return;
            }
            chunk_len = sizeof(f->buf); // 实际到不了这里，保险起见截断
        }
        memcpy(f->buf + f->len, chunk, chunk_len);
        f->len += chunk_len;
    }

    while (f->len >= 2) {
        size_t declared = ((size_t)f->buf[0] << 8) | f->buf[1];
        size_t total;
        if (declared > TLB_FRAME_MAX_BYTES) {
            f->dropped++;
            f->len = 0;
            return;
        }
        if (f->len < declared + 2) {
            return; // 等后续分包
        }
        total = declared + 2;
        // 切出来的长度天然等于声明值，探针里的 stripLength 在此不可能失败
        if (on_frame) {
            on_frame(ud, f->buf + 2, declared);
        }
        memmove(f->buf, f->buf + total, f->len - total);
        f->len -= total;
    }
}
