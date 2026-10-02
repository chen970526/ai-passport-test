// components/tesla_core/include/tesla_core/tlb_pb.h
// protobuf wire 格式的最小读写原语（不是通用 schema 引擎）。
//
// 语义必须与探针 src/protocol/pb.js 逐字节一致，关键约定：
//   1. 字段写入顺序 = 调用方的书写顺序（JS 里是对象 key 的插入顺序），不是字段号顺序；
//   2. oneof 成员是 explicit presence：即使值为 0 / 空 bytes / 空 message 也要写 tag，
//      因此各写入函数带 force 参数；普通 singular 标量等于默认值时省略；
//   3. fixed32 小端；元数据里的 uint32 是大端（见 tlb_meta）；
//   4. 读到的未知字段一律跳过，不报错。
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// wire type
enum {
    TLB_WIRE_VARINT = 0,
    TLB_WIRE_FIXED64 = 1,
    TLB_WIRE_LEN = 2,
    TLB_WIRE_FIXED32 = 5
};

// ---------------------------------------------------------------- 写入侧
typedef struct {
    uint8_t *buf;
    size_t cap;
    size_t len;
    bool failed; // 任一写入溢出即置位，后续写入直接失败
} tlb_wb_t;

void tlb_wb_init(tlb_wb_t *w, uint8_t *buf, size_t cap);
// 失败时返回 0（调用方据此判定缓冲区不够）
size_t tlb_wb_len(const tlb_wb_t *w);

bool tlb_wb_raw(tlb_wb_t *w, const uint8_t *data, size_t len);
bool tlb_wb_varint(tlb_wb_t *w, uint64_t v);
bool tlb_wb_tag(tlb_wb_t *w, uint32_t field, uint32_t wire);

// force=true 对应 oneof / explicit presence：值为 0 也写。
bool tlb_wb_u32(tlb_wb_t *w, uint32_t field, uint32_t v, bool force);
bool tlb_wb_bool(tlb_wb_t *w, uint32_t field, bool v, bool force);
bool tlb_wb_fixed32(tlb_wb_t *w, uint32_t field, uint32_t v, bool force);
// data 为 NULL 或 len 为 0 时，只有 force 才会写出空的 LEN 字段。
bool tlb_wb_bytes(tlb_wb_t *w, uint32_t field, const uint8_t *data, size_t len, bool force);
// 嵌套消息：sub 必须已经写完；sub==NULL 视为空消息。
// 与 pb.js 的 case 'msg' 一致 —— 一旦被调用就无条件写出 tag+长度（空消息写长度 0），
// 想省略这个字段的调用方自己先判断，别依赖这里。
bool tlb_wb_sub(tlb_wb_t *w, uint32_t field, const tlb_wb_t *sub);

// ---------------------------------------------------------------- 读取侧
typedef struct {
    const uint8_t *p;
    const uint8_t *end;
    bool failed;
} tlb_rb_t;

void tlb_rb_init(tlb_rb_t *r, const uint8_t *data, size_t len);
bool tlb_rb_eof(const tlb_rb_t *r);
uint64_t tlb_rb_remaining(const tlb_rb_t *r);

// 读一个 tag；正常读到字段返回 true，读到结尾返回 false，格式错置 failed。
bool tlb_rb_next(tlb_rb_t *r, uint32_t *field, uint32_t *wire);
bool tlb_rb_varint(tlb_rb_t *r, uint64_t *out);
// varint 截到 32 位（proto 里 uint32 的线上形态允许 10 字节）
bool tlb_rb_u32(tlb_rb_t *r, uint32_t *out);
bool tlb_rb_bool(tlb_rb_t *r, bool *out);
bool tlb_rb_fixed32(tlb_rb_t *r, uint32_t *out);
// 借用语义：返回的指针指向原始缓冲区，不复制
bool tlb_rb_bytes(tlb_rb_t *r, const uint8_t **ptr, size_t *len);
// 进入 LEN 包裹的子消息
bool tlb_rb_sub(tlb_rb_t *r, tlb_rb_t *sub);
bool tlb_rb_skip(tlb_rb_t *r, uint32_t wire);
