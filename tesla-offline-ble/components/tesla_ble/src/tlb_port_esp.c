// components/tesla_ble/src/tlb_port_esp.c
// 平台钩子的设备侧实现：熵源、时钟、mbedTLS P-256。
//
// ECDH 语义必须与探针 p256.js:deriveSharedSecret 一致：
//   · **不做 mod n**（探针直接把 32 字节私钥当纯量用，只有 newKeyPair 走 normalizePrivateKey）；
//   · 只接受 65 字节未压缩点（33 字节压缩点探针是明确抛错的，本项目里车辆的
//     session_info.public_key 一直是 65 字节，压缩分支没有可达路径）；
//   · 结果是共享点的仿射 X 坐标（32 字节），不是 ANSI X9.63 的整点。
#include <string.h>

#include "esp_log.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"

#include "mbedtls/ecp.h"
#include "mbedtls/bignum.h"

#include "tesla_core/tlb_types.h"
#include "tesla_ble/tlb_ble.h"

static const char *TAG = "tlb_port";

// mbedtls_f_rng_t：int(void *p_rng, unsigned char *output, size_t len)
static int tlb_rng(void *p_rng, unsigned char *output, size_t len)
{
    (void)p_rng;
    if (len > 0) {
        esp_fill_random(output, len);
    }
    return 0;
}

void tlb_port_random(uint8_t *out, size_t len)
{
    if (out && len) {
        esp_fill_random(out, len);
    }
}

int64_t tlb_port_now_ms(void)
{
    return esp_timer_get_time() / 1000LL;
}

// 全零私钥在探针里会走进 scalarMult 并得到无穷远点，最后抛
// 「私钥无效（结果为无穷远点）」/「ECDH 结果为无穷远点」。
// mbedTLS 侧对应 MBEDTLS_ERR_ECP_INVALID_KEY，行为一致：判失败。
bool tlb_port_ecdh(const uint8_t priv[TLB_PRIV_LEN], const uint8_t pub[TLB_PUB_LEN],
                   uint8_t out[TLB_SHARED_LEN])
{
    mbedtls_ecp_group grp;
    mbedtls_ecp_point point;
    mbedtls_mpi d;
    unsigned char buf[65];
    size_t olen = 0;
    bool ok = false;
    int rc;

    if (!priv || !pub || !out) {
        return false;
    }
    if (pub[0] != 0x04) {
        ESP_LOGW(TAG, "对端公钥不是未压缩格式（首字节 0x%02x）", pub[0]);
        return false;
    }

    mbedtls_ecp_group_init(&grp);
    mbedtls_ecp_point_init(&point);
    mbedtls_mpi_init(&d);

    rc = mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_SECP256R1);
    if (rc != 0) {
        goto done;
    }
    rc = mbedtls_mpi_read_binary(&d, priv, TLB_PRIV_LEN);
    if (rc != 0) {
        goto done;
    }
    rc = mbedtls_ecp_point_read_binary(&grp, &point, pub, TLB_PUB_LEN);
    if (rc != 0) {
        // 探针在这里对应「坐标越界」/「不在曲线上」两抛
        ESP_LOGW(TAG, "对端公钥解析失败 -0x%04x", -rc);
        goto done;
    }
    rc = mbedtls_ecp_check_pubkey(&grp, &point);
    if (rc != 0) {
        ESP_LOGW(TAG, "对端公钥不在 P-256 曲线上 -0x%04x", -rc);
        goto done;
    }
    // f_rng **不能**传 NULL：mbedTLS 3.x 的 mbedtls_ecp_mul_restartable 入口有硬守卫
    // （ecp.c 里 `if (f_rng == NULL) return MBEDTLS_ERR_ECP_BAD_INPUT_DATA;`），
    // 传 NULL 会当场 -0x4F80 早退，连纯量乘法都不会开始 —— 真机 handshake 就是死在这。
    // 这里补上 ESP 硬件真随机：随机化只改内部仿射坐标的表示（侧信道防护），
    // 归一化后的仿射 X 与探针逐字节相同，不影响任何一个输出字节。
    rc = mbedtls_ecp_mul(&grp, &point, &d, &point, tlb_rng, NULL);
    if (rc != 0) {
        ESP_LOGW(TAG, "ECDH 点乘失败 -0x%04x", -rc);
        goto done;
    }
    rc = mbedtls_ecp_point_write_binary(&grp, &point, MBEDTLS_ECP_PF_UNCOMPRESSED, &olen, buf,
                                        sizeof(buf));
    if (rc != 0 || olen != TLB_PUB_LEN) {
        goto done;
    }
    memcpy(out, buf + 1, TLB_SHARED_LEN); // 0x04 || X || Y → 取 X
    ok = true;

done:
    mbedtls_mpi_free(&d);
    mbedtls_ecp_point_free(&point);
    mbedtls_ecp_group_free(&grp);
    return ok;
}

// 对应探针 newKeyPair()：randomBytes(32) → normalizePrivateKey（d = k mod n，d != 0）
// → publicKeyFromPrivate。这里直接用 mbedtls_ecp_gen_privkey 出合法 d（等价于
// 「约减后非零」，见 tlb_ble.h 的偏离登记），公钥走同一条点乘路径。
bool tlb_port_keygen(uint8_t priv[TLB_PRIV_LEN], uint8_t pub[TLB_PUB_LEN])
{
    mbedtls_ecp_group grp;
    mbedtls_ecp_point point;
    mbedtls_mpi d;
    unsigned char raw[TLB_PRIV_LEN];
    size_t olen = 0;
    bool ok = false;
    int rc;

    if (!priv || !pub) {
        return false;
    }

    mbedtls_ecp_group_init(&grp);
    mbedtls_ecp_point_init(&point);
    mbedtls_mpi_init(&d);

    rc = mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_SECP256R1);
    if (rc != 0) {
        goto done;
    }
    rc = mbedtls_ecp_gen_privkey(&grp, &d, tlb_rng, NULL);
    if (rc != 0) {
        ESP_LOGE(TAG, "生成私钥失败 -0x%04x", -rc);
        goto done;
    }
    rc = mbedtls_ecp_mul(&grp, &point, &d, &grp.G, tlb_rng, NULL);
    if (rc != 0) {
        ESP_LOGE(TAG, "公钥点乘失败（结果为无穷远点）-0x%04x", -rc);
        goto done;
    }
    rc = mbedtls_ecp_point_write_binary(&grp, &point, MBEDTLS_ECP_PF_UNCOMPRESSED, &olen, pub,
                                        TLB_PUB_LEN);
    if (rc != 0 || olen != TLB_PUB_LEN) {
        goto done;
    }
    // 私钥定长 32 字节大端：mbedtls_mpi_write_binary 会补齐前导零
    memset(raw, 0, sizeof(raw));
    rc = mbedtls_mpi_write_binary(&d, raw, TLB_PRIV_LEN);
    if (rc != 0) {
        goto done;
    }
    memcpy(priv, raw, TLB_PRIV_LEN);
    ok = true;

done:
    mbedtls_mpi_free(&d);
    mbedtls_ecp_point_free(&point);
    mbedtls_ecp_group_free(&grp);
    return ok;
}
