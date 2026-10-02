// components/tesla_ble/src/tlb_nvs_store.c
// NVS 后端：密钥 / 两个域会话 / 绑定档案 / 手输 VIN。
//
// 落盘哪些字段、恢复时怎么判空，全由 tesla_core 的 tlb_store.c 决定（金标准锁死）；
// 本文件只把「槽位号 → NVS 键名」这一层钉死，键名一旦上线永不改名
// （config/index.js 的文件头注释就是这个理由：改名 = 私钥和 counter 当成第一次运行）。
#include <stdio.h>
#include <string.h>
#include <time.h>

#include "nvs.h"
#include "nvs_flash.h"

#include "tesla_core/tlb_types.h"
#include "tesla_ble/tlb_ble.h"

#define TLB_NVS_NS "tesla_ble"

// 槽位 → 键名。1=key（tesla_probe_key_v1）、2=v3_session（沿用老键名语义）、
// 3=v3_info（车机域单独一份，两个 counter 绝不相通）。
static const char *slot_key_of(uint32_t slot)
{
    switch (slot) {
        case TLB_STORE_SLOT_KEY:
            return "key";
        case TLB_STORE_SLOT_VCSEC:
            return "v3_session";
        case TLB_STORE_SLOT_INFOTAINMENT:
            return "v3_info";
        default:
            return NULL;
    }
}

static nvs_handle_t s_h;
static bool s_open;

esp_err_t tlb_nvs_init(void)
{
    if (s_open) {
        return ESP_OK;
    }
    esp_err_t e = nvs_open(TLB_NVS_NS, NVS_READWRITE, &s_h);
    if (e == ESP_OK) {
        s_open = true;
    }
    return e;
}

static int nvs_read(void *ud, uint32_t slot, uint8_t *out, size_t cap)
{
    const char *k = slot_key_of(slot);
    size_t need = 0;
    esp_err_t e;

    (void)ud;
    if (!k || !out) {
        return -1;
    }
    if (!s_open) {
        return -1;
    }
    e = nvs_get_blob(s_h, k, NULL, &need);
    if (e == ESP_ERR_NVS_NOT_FOUND) {
        return 0; // 没有存档 = 首次运行
    }
    if (e != ESP_OK) {
        return -1;
    }
    // 宁可判失败，也不能悄悄截断成一份坏档（tlb_store.h 对后端的硬要求）
    if (need > cap) {
        return -1;
    }
    need = cap;
    e = nvs_get_blob(s_h, k, out, &need);
    if (e == ESP_ERR_NVS_NOT_FOUND) {
        return 0;
    }
    if (e != ESP_OK) {
        return -1;
    }
    return (int)need;
}

static int nvs_write(void *ud, uint32_t slot, const uint8_t *blob, size_t len)
{
    const char *k = slot_key_of(slot);
    esp_err_t e;

    (void)ud;
    if (!k || !blob || !s_open) {
        return -1;
    }
    e = nvs_set_blob(s_h, k, blob, len);
    if (e != ESP_OK) {
        return -1;
    }
    return nvs_commit(s_h) == ESP_OK ? 0 : -1;
}

static int nvs_erase(void *ud, uint32_t slot)
{
    const char *k = slot_key_of(slot);

    (void)ud;
    if (!k || !s_open) {
        return -1;
    }
    esp_err_t e = nvs_erase_key(s_h, k);
    if (e == ESP_ERR_NVS_NOT_FOUND) {
        return 0; // 本来就没有 = 目标状态已达成
    }
    if (e != ESP_OK) {
        return -1;
    }
    return nvs_commit(s_h) == ESP_OK ? 0 : -1;
}

void tlb_nvs_backend(tlb_store_backend_t *out)
{
    if (!out) {
        return;
    }
    out->ud = NULL;
    out->read = nvs_read;
    out->write = nvs_write;
    out->erase = nvs_erase;
}

// ---------------------------------------------------------------- 绑定档案
//
// 档案是设备层自己的东西（探针存在 uni storage 的 JSON 里），不走 tlb_store 的
// blob 编码；这里用固定布局 + 版本头，改字段必须递增版本并把旧档按「无档案」处理。
#define TLB_PROFILE_MAGIC 0x54425046u // 'TBPF'
#define TLB_PROFILE_VERSION 1u

typedef struct {
    uint32_t magic;
    uint32_t version;
    char id[TLB_BLE_ID_MAX];
    char name[TLB_ADV_NAME_MAX];
    char vin[TLB_VIN_MAX];
    char key_id[48];
    int64_t bound_at;
    int64_t connected_at;
} tlb_profile_blob_t;

static void copy_str(char *dst, size_t cap, const char *src)
{
    if (!src || !*src) {
        dst[0] = '\0';
        return;
    }
    snprintf(dst, cap, "%s", src);
}

// saveBind(patch) 的语义（bind-profile.js:25-35）：patch 里为空 / 未给的字段
// **保留原值**，绝不把档案抹平。load/blob 那两侧仍用 copy_str（整体覆盖）。
static void copy_patch(char *dst, size_t cap, const char *src)
{
    if (!src || !*src) {
        return;
    }
    snprintf(dst, cap, "%s", src);
}

bool tlb_nvs_profile_load(tlb_profile_t *out)
{
    tlb_profile_blob_t b;
    uint8_t tmp[sizeof(tlb_profile_blob_t) + 1];
    size_t need = sizeof(tmp);
    esp_err_t e;

    if (!out) {
        return false;
    }
    memset(out, 0, sizeof(*out));
    if (!s_open) {
        return false;
    }
    e = nvs_get_blob(s_h, "bind", tmp, &need);
    if (e != ESP_OK || need != sizeof(b)) {
        return false;
    }
    memcpy(&b, tmp, sizeof(b));
    if (b.magic != TLB_PROFILE_MAGIC || b.version != TLB_PROFILE_VERSION) {
        return false; // 旧版布局：当作没有档案，绝不按字节猜
    }
    copy_str(out->id, sizeof(out->id), b.id);
    copy_str(out->name, sizeof(out->name), b.name);
    copy_str(out->vin, sizeof(out->vin), b.vin);
    copy_str(out->key_id, sizeof(out->key_id), b.key_id);
    out->bound_at = b.bound_at;
    out->connected_at = b.connected_at;
    out->valid = out->id[0] != '\0' || out->key_id[0] != '\0'; // 探针的 hasBind()
    return out->valid;
}

bool tlb_nvs_profile_save(const tlb_profile_t *p)
{
    tlb_profile_blob_t b;
    tlb_profile_t cur;
    esp_err_t e;

    if (!p || !s_open) {
        return false;
    }
    // saveBind(patch) 的语义：只覆盖非空字段，其余保留原值
    if (!tlb_nvs_profile_load(&cur)) {
        memset(&cur, 0, sizeof(cur));
    }
    copy_patch(cur.id, sizeof(cur.id), p->id);
    copy_patch(cur.name, sizeof(cur.name), p->name);
    copy_patch(cur.vin, sizeof(cur.vin), p->vin);
    copy_patch(cur.key_id, sizeof(cur.key_id), p->key_id);
    if (p->bound_at != 0) {
        cur.bound_at = p->bound_at;
    }
    if (p->connected_at != 0) {
        cur.connected_at = p->connected_at;
    }

    memset(&b, 0, sizeof(b));
    b.magic = TLB_PROFILE_MAGIC;
    b.version = TLB_PROFILE_VERSION;
    copy_str(b.id, sizeof(b.id), cur.id);
    copy_str(b.name, sizeof(b.name), cur.name);
    copy_str(b.vin, sizeof(b.vin), cur.vin);
    copy_str(b.key_id, sizeof(b.key_id), cur.key_id);
    b.bound_at = cur.bound_at;
    b.connected_at = cur.connected_at;
    e = nvs_set_blob(s_h, "bind", &b, sizeof(b));
    if (e != ESP_OK) {
        return false;
    }
    return nvs_commit(s_h) == ESP_OK;
}

void tlb_nvs_profile_clear(void)
{
    if (!s_open) {
        return;
    }
    nvs_erase_key(s_h, "bind");
    nvs_commit(s_h);
}

bool tlb_nvs_vin_load(char *out, size_t cap)
{
    size_t need = cap;
    esp_err_t e;

    if (!out || !cap || !s_open) {
        return false;
    }
    out[0] = '\0';
    e = nvs_get_str(s_h, "vin", out, &need);
    return e == ESP_OK;
}

bool tlb_nvs_vin_save(const char *vin)
{
    if (!vin || !s_open) {
        return false;
    }
    if (nvs_set_str(s_h, "vin", vin) != ESP_OK) {
        return false;
    }
    return nvs_commit(s_h) == ESP_OK;
}

// describeBind()：new Date(t).toLocaleString() 在设备上没有对应物，
// 换成 UTC 秒级时间戳（偏离登记在 tlb_ble.h）。
static void fmt_when(int64_t ms, char *out, size_t cap)
{
    if (ms <= 0) {
        snprintf(out, cap, "未记录");
        return;
    }
    time_t t = (time_t)(ms / 1000);
    struct tm tm_buf;
    gmtime_r(&t, &tm_buf);
    strftime(out, cap, "%Y-%m-%d %H:%M:%S", &tm_buf);
}

void tlb_nvs_profile_describe(const tlb_profile_t *p, char *out, size_t cap)
{
    char when_bound[32] = "未记录";
    char when_conn[32] = "未记录";
    const char *tail;
    const char *vin6;
    size_t id_len, vin_len;
    int n;

    if (!out || !cap) {
        return;
    }
    out[0] = '\0';
    if (!p || !p->valid) {
        snprintf(out, cap, "无绑定档案");
        return;
    }
    fmt_when(p->bound_at, when_bound, sizeof(when_bound));
    fmt_when(p->connected_at, when_conn, sizeof(when_conn));

    // 探针：deviceId 只截末 14 个字符显示；keyId 只截前 8 位；VIN 只截后 6 位
    id_len = strlen(p->id);
    tail = id_len > 14 ? p->id + id_len - 14 : p->id;
    vin_len = strlen(p->vin);
    vin6 = vin_len > 6 ? p->vin + vin_len - 6 : p->vin;

    n = snprintf(out, cap, "%s / %s", p->name[0] ? p->name : "(无名)",
                 id_len ? tail : "未记录设备");
    if (n < 0 || (size_t)n >= cap) {
        return;
    }
    cap -= (size_t)n;
    out += n;
    if (vin_len) {
        n = snprintf(out, cap, " VIN…%s", vin6);
        if (n < 0 || (size_t)n >= cap) {
            return;
        }
        cap -= (size_t)n;
        out += n;
    }
    if (p->key_id[0]) {
        n = snprintf(out, cap, " keyId=%.8s… 绑定于 %s", p->key_id, when_bound);
    } else {
        n = snprintf(out, cap, " 钥匙未登记");
    }
    if (n < 0 || (size_t)n >= cap) {
        return;
    }
    cap -= (size_t)n;
    out += n;
    if (p->connected_at > 0) {
        snprintf(out, cap, " 上次连接 %s", when_conn);
    }
}
