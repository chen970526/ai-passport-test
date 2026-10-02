// tests/host/tlb_port_host.c —— 主机测试用平台钩子实现（无 IDF、无真实熵源）。
// 金标准里所有随机量（nonce / 私钥）都由用例显式注入，因此这里只需保证：
//   1) 链接期有定义；2) 结果可复现（固定种子的 xorshift），测试不会因为“随机”而抖动。
#include <string.h>

#include "tesla_core/tlb_types.h"

static uint64_t g_state = 0x853c49e6748fda33ULL;

void tlb_port_random(uint8_t *out, size_t len) {
    for (size_t i = 0; i < len; i++) {
        g_state ^= g_state >> 12;
        g_state ^= g_state << 25;
        g_state ^= g_state >> 27;
        out[i] = (uint8_t)(g_state >> 11);
    }
}

// 主机侧没有 P-256 实现，也不该有：ECDH 只在设备上跑，
// 金标准比对的是共享秘密之后的派生（tlb_v3_shared_key）。
// 默认恒失败（hs 系列用例走不到派生）。握手 happy path（探针 / 绑定）需要一次真 ECDH，
// 由 tlb_host_set_ecdh_fixture 注入「私钥-公钥配成一对、X 坐标已知」的三元组；
// 只有 priv/pub 与登记值逐字节相符才给出 X，避免桩被误用成「任意输入都算得出密钥」。
static uint8_t fx_priv[TLB_PRIV_LEN];
static uint8_t fx_pub[TLB_PUB_LEN];
static uint8_t fx_x[TLB_SHARED_LEN];
static bool fx_on;

void tlb_host_set_ecdh_fixture(const uint8_t *priv, const uint8_t *pub, const uint8_t *x)
{
    memcpy(fx_priv, priv, TLB_PRIV_LEN);
    memcpy(fx_pub, pub, TLB_PUB_LEN);
    memcpy(fx_x, x, TLB_SHARED_LEN);
    fx_on = true;
}

void tlb_host_clear_ecdh_fixture(void) { fx_on = false; }

bool tlb_port_ecdh(const uint8_t priv[TLB_PRIV_LEN], const uint8_t pub[TLB_PUB_LEN],
                   uint8_t out[TLB_SHARED_LEN]) {
    if (!fx_on) return false;
    if (memcmp(priv, fx_priv, TLB_PRIV_LEN) != 0) return false;
    if (memcmp(pub, fx_pub, TLB_PUB_LEN) != 0) return false;
    memcpy(out, fx_x, TLB_SHARED_LEN);
    return true;
}

// 虚拟毫秒时钟：主机测试一律显式传 now，这里返回固定值以免引入真实时间。
int64_t tlb_port_now_ms(void) { return 0; }
