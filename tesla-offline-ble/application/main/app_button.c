// application/main/app_button.c —— 特斯拉工程自带的 ADC 三键驱动。
//
// 为什么要从基线 bsp_button.c 分叉一份：电池供电实测按键 ADC 读回 -1
// （bsp_button 把真实错误码吞了，只给 -1），插上 USB 电源又恢复正常，
// 没有错误信息就无法定根因。本版本改动三点，其余逻辑与基线一致：
//   1) adc_oneshot_read 失败自动重试（最多 3 次）——若失灵是 BLE 发射
//      突发造成的瞬时超时，重试即可自愈，按键直接复活；
//   2) 首次失败/恢复时各打一条中文日志（含 esp_err 名），日志会进
//      屏幕诊断页2 的环形缓冲——不带电脑也能在屏幕上看到真实原因；
//   3) 校准换算失败时退回线性估算（12dB 衰减满量程≈3100mV），
//      宁可电压粗略也不让按键整体失联。
#include "app_button.h"

#include "bsp_pins.h"
#include "iot_button.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "app_btn";

static const uint16_t BTN_MV[BSP_BTN_COUNT][2] = BSP_BTN_MV_TABLE;

// ADC1 是 unit 级独占资源：轮询与 read_mv 共用同一个 oneshot 句柄。
static adc_oneshot_unit_handle_t s_adc;
static adc_cali_handle_t         s_cali;

#define BSP_BTN_ATTEN ADC_ATTEN_DB_12 // 量程约 0~3100mV，覆盖松开态

typedef struct {
    button_driver_t base;
    unsigned        index;
} app_adc_button_t;

static app_adc_button_t s_drivers[BSP_BTN_COUNT];
static button_handle_t  s_btn[BSP_BTN_COUNT];
static bsp_btn_cb_t     s_cb;
static void            *s_user;
static volatile bool    s_ready;

static int64_t s_sample_time;
static int     s_sample_mv = -1;
static bool    s_sample_valid;

// 错误状态机：只在「好→坏」「坏→好」跳变时各打一条日志，不刷屏。
// 最后一次错误名粘存在 s_last_err[]，屏幕诊断页1 直接取用——
// 环形缓冲会被 NimBLE 周期日志挤掉，粘存不会。
static bool  s_err_active;
static char  s_last_err[24] = "无";

// 初始化失败自愈：记住首次请求的回调，之后每 5 秒允许再试一次。
// （cleanup 会清空 s_cb/user，所以用独立的 want 副本。）
static bsp_btn_cb_t s_want_cb;
static void        *s_want_user;
static int64_t      s_last_try;

// ---------------------------------------------------------------- 组合键（出厂重置）
//
// 硬件约束：三键共用一路电阻分压（右一=0Ω / 右二=1kΩ / 右三=2.2kΩ），
// 右一与任何键同按，稳态都被读成纯右一，电压窗口无法区分。
// 靠【跳变沿】识别：先按住右二（电压在 DOWN 窗口 150~447mV），再按下右一
// 时电压直接落入 UP 窗口（0~150mV），中间不经过松开态（>=1900mV）。
// 人手「先松开再按下」的动作在 1ms 采样下必然多次落在松开态，因此该跳变可靠。
// 检测到跳变后，UP 窗口连续保持 COMBO_HOLD_MS 即判定组合键成立。
// 注意按键顺序：必须先右二、后右一（先右一后右二电压无变化，识别不到）。
// 选右二+右一而不是右三+右一：右三长按是诊断开关，组合键会先撞上它。
#define COMBO_HOLD_MS 3000

typedef enum { WIN_UP = 0, WIN_DOWN, WIN_OK, WIN_RELEASE } win_t;

static app_combo_cb_t s_combo_cb;
static void          *s_combo_user;
static volatile bool  s_combo_active; // 已识别 OK→UP 跳变，正在等保持时长
static volatile bool  s_combo_fired;  // 组合键已触发（抑制普通事件，直到全松开）
static win_t         s_prev_win = WIN_RELEASE;
static int64_t       s_combo_start_us;

static win_t win_of_mv(int mv)
{
    if (mv < 0) {
        return WIN_RELEASE; // 读失败不触发组合键
    }
    if (mv < 150) {
        return WIN_UP;
    }
    if (mv < 447) {
        return WIN_DOWN;
    }
    if (mv < 1900) {
        return WIN_OK;
    }
    return WIN_RELEASE;
}

// 每次拿到新采样后跑一遍组合键状态机。
static void combo_step(int mv)
{
    win_t w = win_of_mv(mv);
    if (s_combo_fired) {
        // 已触发：只等全部松开复位，期间不再产生第二次触发
        if (w == WIN_RELEASE) {
            s_combo_fired = false;
            s_combo_active = false;
        }
        s_prev_win = w;
        return;
    }
    if (s_combo_active) {
        if (w != WIN_UP) {
            s_combo_active = false; // 没保持够 3 秒就松了任一键
        } else if (esp_timer_get_time() - s_combo_start_us >=
                   (int64_t)COMBO_HOLD_MS * 1000) {
            s_combo_fired = true;
            ESP_LOGW(TAG, "组合键（右二+右一保持3秒）：出厂重置");
            if (s_combo_cb) {
                s_combo_cb(s_combo_user);
            }
        }
    } else if (s_prev_win == WIN_DOWN && w == WIN_UP) {
        s_combo_active = true; // 右二按住时直接按下右一
        s_combo_start_us = esp_timer_get_time();
    }
    s_prev_win = w;
}

void app_button_set_combo_cb(app_combo_cb_t cb, void *user)
{
    s_combo_cb = cb;
    s_combo_user = user;
}

static void note_adc_err(esp_err_t e, const char *what)
{
    snprintf(s_last_err, sizeof(s_last_err), "%s", esp_err_to_name(e));
    if (!s_err_active) {
        s_err_active = true;
        ESP_LOGE(TAG, "%s失败:%s", what, esp_err_to_name(e));
    }
}

const char *app_button_last_err(void)
{
    return s_last_err;
}

static void note_adc_ok(void)
{
    if (s_err_active) {
        s_err_active = false;
        ESP_LOGI(TAG, "按键ADC读取恢复");
    }
}

// 读一路原始值：失败重试，最多 3 次；全失败返回错误码。
static esp_err_t adc_read_raw_retry(int *raw)
{
    esp_err_t e = ESP_FAIL;
    for (int i = 0; i < 3; i++) {
        e = adc_oneshot_read(s_adc, BSP_BTN_ADC_CHANNEL, raw);
        if (e == ESP_OK) {
            note_adc_ok();
            return ESP_OK;
        }
    }
    note_adc_err(e, "按键ADC读取");
    return e;
}

// raw → mV：优先走 eFuse 校准；校准失败退回线性估算并记一条日志。
static esp_err_t adc_to_mv(int raw, int *mv)
{
    if (s_cali && adc_cali_raw_to_voltage(s_cali, raw, mv) == ESP_OK) {
        return ESP_OK;
    }
    note_adc_err(ESP_FAIL, "按键ADC校准");
    *mv = (int)((int64_t)raw * 3100 / 4095); // 12dB 衰减满量程近似
    return ESP_OK;
}

static uint8_t button_level(button_driver_t *driver)
{
    if (!s_ready) return BUTTON_INACTIVE;
    const app_adc_button_t *button = (const app_adc_button_t *)driver;
    const int64_t now = esp_timer_get_time();
    // 一个轮询周期内三个键共用同一次采样（与基线一致）。
    if (!s_sample_valid || now - s_sample_time >= 1000) {
        int sum = 0;
        s_sample_time = now;
        s_sample_valid = true;
        s_sample_mv = -1;
        for (int i = 0; i < CONFIG_ADC_BUTTON_SAMPLE_TIMES; ++i) {
            int raw;
            if (adc_read_raw_retry(&raw) != ESP_OK) {
                return BUTTON_INACTIVE;
            }
            sum += raw;
        }
        int mv;
        if (adc_to_mv(sum / CONFIG_ADC_BUTTON_SAMPLE_TIMES, &mv) == ESP_OK) {
            s_sample_mv = mv;
            combo_step(mv); // 新采样顺带跑组合键状态机
        }
    }
    // 半开区间防两键命中同一边界（与基线一致）。
    return s_sample_mv >= BTN_MV[button->index][0] &&
                   s_sample_mv < BTN_MV[button->index][1]
               ? BUTTON_ACTIVE
               : BUTTON_INACTIVE;
}

static esp_err_t button_driver_delete(button_driver_t *driver)
{
    (void)driver; // 静态存储；共享 ADC 在所有按键之后释放
    return ESP_OK;
}

static void on_event(void *arg, void *usr_data, bsp_btn_ev_t ev)
{
    (void)arg;
    if (!s_ready || !s_cb) return;
    // 组合键识别中/已触发时，抑制全部普通按键事件：电压从 DOWN 窗口切到 UP 窗口
    // 会让 iot_button 补发「右二单击」（引导页会误移光标/常态会误解锁）、UP 长按等伪事件，
    // 设备马上要出厂重置，这些事件一个都不能放出去。
    if (s_combo_active || s_combo_fired) return;
    s_cb((bsp_btn_t)(intptr_t)usr_data, ev, s_user);
}
static void cb_press(void *a, void *u) { on_event(a, u, BSP_BTN_PRESS); }
static void cb_click(void *a, void *u) { on_event(a, u, BSP_BTN_CLICK); }
static void cb_double(void *a, void *u) { on_event(a, u, BSP_BTN_DOUBLE); }
static void cb_long(void *a, void *u) { on_event(a, u, BSP_BTN_LONG); }

// 初始化失败回滚：先停 button driver，再释放校准与 ADC unit（与基线同序）。
static void button_cleanup(void)
{
    s_cb = NULL;
    s_user = NULL;
    s_ready = false;
    s_sample_valid = false;

    for (int i = BSP_BTN_COUNT - 1; i >= 0; i--) {
        if (!s_btn[i]) continue;
        esp_err_t e = iot_button_delete(s_btn[i]);
        if (e != ESP_OK) {
            ESP_LOGE(TAG, "按键 %d 回滚失败:%s", i, esp_err_to_name(e));
            continue;
        }
        s_btn[i] = NULL;
    }
    for (int i = 0; i < BSP_BTN_COUNT; ++i) {
        if (s_btn[i]) return; // 有 driver 还活着就不能拆 ADC
    }
    if (s_cali) {
        if (adc_cali_delete_scheme_curve_fitting(s_cali) == ESP_OK) s_cali = NULL;
    }
    if (s_adc) {
        if (adc_oneshot_del_unit(s_adc) == ESP_OK) s_adc = NULL;
    }
}

static esp_err_t register_callbacks(button_handle_t button, void *index)
{
    esp_err_t e = iot_button_register_cb(button, BUTTON_PRESS_DOWN, NULL, cb_press, index);
    if (e == ESP_OK) e = iot_button_register_cb(button, BUTTON_SINGLE_CLICK, NULL, cb_click, index);
    // 双击只给右三（OK=index 2）注册：它是开后备箱的唯一触发。
    // 右一右二若也注册双击，组件要等完双击判定窗口才出单击事件，上锁/解锁会明显变钝。
    if (e == ESP_OK && (intptr_t)index == 2) {
        e = iot_button_register_cb(button, BUTTON_DOUBLE_CLICK, NULL, cb_double, index);
    }
    if (e == ESP_OK) e = iot_button_register_cb(button, BUTTON_LONG_PRESS_START, NULL, cb_long, index);
    return e;
}

esp_err_t app_button_init(bsp_btn_cb_t cb, void *user)
{
    s_want_cb = cb;
    s_want_user = user;
    s_last_try = esp_timer_get_time();
    if (s_ready) {
        s_cb = cb;
        s_user = user;
        return ESP_OK;
    }

    s_cb = cb;
    s_user = user;

    const adc_oneshot_unit_init_cfg_t ucfg = { .unit_id = BSP_BTN_ADC_UNIT };
    esp_err_t ae = adc_oneshot_new_unit(&ucfg, &s_adc);
    if (ae != ESP_OK) {
        note_adc_err(ae, "按键ADC初始化");
        ESP_LOGE(TAG, "ADC unit 创建失败(%s)", esp_err_to_name(ae));
        s_adc = NULL;
        button_cleanup();
        return ae;
    }

    const adc_oneshot_chan_cfg_t channel = {
        .atten = BSP_BTN_ATTEN,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    ae = adc_oneshot_config_channel(s_adc, BSP_BTN_ADC_CHANNEL, &channel);
    if (ae != ESP_OK) {
        note_adc_err(ae, "按键ADC初始化");
        ESP_LOGE(TAG, "ADC 通道配置失败(%s)", esp_err_to_name(ae));
        button_cleanup();
        return ae;
    }
    // 初始化时刻自检读：区分「ADC 从一开始就是坏的」和「跑起来才坏」，
    // 这条日志在 BLE 已启动、按键轮询未开的时间窗里打，位置最有诊断价值。
    {
        int self_raw = 0;
        esp_err_t se = adc_oneshot_read(s_adc, BSP_BTN_ADC_CHANNEL, &self_raw);
        if (se == ESP_OK) {
            ESP_LOGI(TAG, "按键ADC自检:通过 raw=%d", self_raw);
        } else {
            note_adc_err(se, "按键ADC自检");
            ESP_LOGE(TAG, "按键ADC自检:失败(%s)", esp_err_to_name(se));
        }
    }
    const adc_cali_curve_fitting_config_t cal = {
        .unit_id = BSP_BTN_ADC_UNIT,
        .chan = BSP_BTN_ADC_CHANNEL,
        .atten = BSP_BTN_ATTEN,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    ae = adc_cali_create_scheme_curve_fitting(&cal, &s_cali);
    if (ae != ESP_OK) {
        // 校准不可用不致命：read 路径有线性兜底，按键仍能工作。
        ESP_LOGW(TAG, "ADC 校准创建失败(%s)，改用线性估算", esp_err_to_name(ae));
        s_cali = NULL;
    }

    for (int i = 0; i < BSP_BTN_COUNT; i++) {
        s_drivers[i] = (app_adc_button_t){
            .base = { .get_key_level = button_level, .del = button_driver_delete },
            .index = (unsigned)i,
        };
        const button_config_t bc = { 0 };
        esp_err_t e = iot_button_create(&bc, &s_drivers[i].base, &s_btn[i]);
        if (e != ESP_OK || !s_btn[i]) {
            note_adc_err(e == ESP_OK ? ESP_FAIL : e, "按键驱动创建");
            ESP_LOGE(TAG, "按键 %d 创建失败(%s)——检查 GPIO%d 的 ADC 配置与分压电阻",
                     i, esp_err_to_name(e), BSP_BTN_ADC_CHANNEL);
            e = e == ESP_OK ? ESP_FAIL : e;
            button_cleanup();
            return e;
        }
        void *idx = (void *)(intptr_t)i;
        e = register_callbacks(s_btn[i], idx);
        if (e != ESP_OK) {
            note_adc_err(e, "按键回调注册");
            ESP_LOGE(TAG, "按键 %d 回调注册失败:%s", i, esp_err_to_name(e));
            button_cleanup();
            return e;
        }
    }

    s_sample_valid = false;
    s_ready = true;
    ESP_LOGI(TAG, "按键就绪:ADC1_CH%d 三键分压(带重试)", BSP_BTN_ADC_CHANNEL);
    return ESP_OK;
}

int app_button_read_mv(void)
{
    if (!s_adc) return -1;
    int raw = 0;
    if (adc_read_raw_retry(&raw) != ESP_OK) return -1;
    int mv = 0;
    if (adc_to_mv(raw, &mv) != ESP_OK) return -1;
    return mv;
}

// 初始化失败后的自愈重试：每 5 秒最多一次，由界面心跳驱动。
// 若电池开机时 ADC 只是"暂时没就绪"，这里会把它救回来并在日志页
// 留下「按键ADC读取恢复」；若持续失败，粘存错误码会一直顶在诊断页1。
esp_err_t app_button_try_reinit(void)
{
    if (s_ready) return ESP_OK;
    if (!s_want_cb) return ESP_ERR_INVALID_STATE; // 还没人请求过按键
    const int64_t now = esp_timer_get_time();
    if (now - s_last_try < 5000000) return ESP_ERR_TIMEOUT; // 未到重试窗口
    return app_button_init(s_want_cb, s_want_user);
}
