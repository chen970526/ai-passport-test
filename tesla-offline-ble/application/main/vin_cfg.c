// application/main/vin_cfg.c —— 无 VIN 时的「热点 + 内网网页」配网通道。
//
// 为什么存在：新固件车广播名是哈希（拿不到 VIN 后 6 位），而会话握手 HMAC 必须用
// 全量 17 位 VIN（tlb_v3.c:session_info_hmac 的 personalization 字段），所以 VIN 只能
// 由用户输入。真实用户不碰电脑，串口 REPL 不适用 → 手机连本热点，在局域网网页里填。
//
// 规则（用户定死）：
//   · 只有设备里没有 VIN（首次开机/出厂重置后）才开热点；VIN 一存进 NVS 立即重启。
//   · 配网模式 = 只留「屏幕提示页 + AP + DHCP + DNS + HTTP」五样：蓝牙栈、worker/link
//     任务一律不启动（C3 内存只够一条链路，实测 BLE 栈吃掉 ~105KB 后热点必死）。
//   · 网关 IP 用 192.168.4.2 —— 用户另一块固件占着 4.1。
//   · VIN 只走手机直连热点的局域网（WPA2-PSK，密码印在屏幕上），热点本身不联网。
//   · 保存成功 → 回「已保存」页 → 延时 2 秒 esp_restart()：重启是最稳的状态清零，
//     起来即正常模式（开蓝牙、热点不再开）。绝不在响应还没发完时重启。
#include <stdio.h>
#include <string.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_err.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_system.h" // esp_restart
#include "esp_wifi.h"
#include "lwip/ip4_addr.h" // IP4_ADDR

#include "vin_cfg.h"
#include "tesla_ble/tlb_ble.h" // tlb_app_post_vin

static const char *TAG = "vin_cfg";

static esp_netif_t *s_ap_netif;
static httpd_handle_t s_server;
static volatile bool s_stop_req; // 实际含义：VIN 已存好，该重启了
static volatile bool s_running;

// —— 配网页（手机浏览器渲染，不受设备字库限制，文案随便写中文）——
#define PAGE_HEAD                                                              \
    "<!doctype html><html lang=zh><head><meta charset=utf-8>"                  \
    "<meta name=viewport content='width=device-width,initial-scale=1'>"        \
    "<title>设置 VIN</title><style>"                                           \
    "body{font-family:-apple-system,sans-serif;background:#101418;color:#eee;" \
    "padding:24px;line-height:1.6}input{width:100%;padding:14px;font-size:18px;" \
    "background:#1c232b;color:#fff;border:1px solid #3a4450;border-radius:10px;" \
    "letter-spacing:1px}button{margin-top:14px;width:100%;padding:15px;"       \
    "font-size:18px;background:#3E8BFF;color:#fff;border:0;border-radius:10px}" \
    ".tip{color:#9AA4B0;font-size:14px}.err{color:#F16A5A}"                    \
    "</style></head><body>"

// 表单主体与结尾拆开：出错时把错误行插在中间，用分块发送拼页 ——
// 模板里的 CSS（width:100%）不能进 snprintf 格式串，否则 % 被当转换符。
#define PAGE_FORM_MID                                                          \
    "<h3>AI Passport · 设置车辆 VIN</h3>"                                      \
    "<p class=tip>VIN 只写入本设备的存储：热点不联网，VIN 不出这个局域网，"    \
    "不上传任何服务器。</p>"                                                   \
    "<p class=tip>17 位，不含字母 I / O / Q。查看位置：Tesla App → 控制 → "    \
    "车辆信息。</p>"                                                           \
    "<form method='POST' action='/vin'>"                                       \
    "<input name='vin' maxlength='17' autocomplete='off' autocapitalize='characters' " \
    "pattern='[A-HJ-NPR-Z0-9]{17}' placeholder='例如 5YJ3E1EA7LF123456' required>" \
    "<button type='submit'>保存 VIN</button></form>"

#define PAGE_FORM_TAIL \
    "<p class=tip>保存成功后设备自动重启，进入正常工作模式。</p></body></html>"

static const char PAGE_FORM[] = PAGE_HEAD PAGE_FORM_MID PAGE_FORM_TAIL;

static const char PAGE_OK[] = PAGE_HEAD
    "<h3 style='color:#34C759'>VIN 已保存 ✓</h3>"
    "<p class=tip>设备几秒后自动重启，热点随之关闭。现在可以断开本 WiFi、回到车里进行绑定了。</p>"
    "</body></html>";

static esp_err_t send_html(httpd_req_t *req, const char *html)
{
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    return httpd_resp_send(req, html, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t root_get(httpd_req_t *req)
{
    return send_html(req, PAGE_FORM);
}

// 门户弹窗兜底：手机联网检测常访问这些固定路径，一律 302 到配置页。
// （真正的自动弹窗靠下面的 DNS 劫持 + DHCP 选项 114，这里只是双保险。）
static const char *PROBE_PATHS[] = {
    "/generate_204",
    "/gen_204",
    "/connectivitycheck.gstatic.com/generate_204",
    "/hotspot-detect.html",
    "/library/test/success.html",
    "/mobile/hotspot-detect.html",
    "/fwlink/?lm=3&sc=gatekeeper&ct=&t=1",
    "/htmfile.txt",
    "/success.txt",
    "/robots.txt",
};

static esp_err_t probe_get(httpd_req_t *req)
{
    httpd_resp_set_status(req, "302 Found");
    httpd_resp_set_hdr(req, "Location", "http://" VIN_AP_IP "/");
    return httpd_resp_send(req, NULL, 0);
}

// VIN 合法字符：大写字母数字，且不含 I/O/Q（VIN 标准禁用）
static bool vin_charset_ok(const char *v)
{
    for (int i = 0; i < 17; i++) {
        char c = v[i];
        int ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z' && c != 'I' && c != 'O' && c != 'Q');
        if (!ok) {
            return false;
        }
    }
    return true;
}

static esp_err_t vin_post(httpd_req_t *req)
{
    char body[128];
    char err_msg[64];
    int len = httpd_req_recv(req, body, sizeof(body) - 1);
    if (len <= 0) {
        httpd_resp_sendstr(req, "bad request");
        return ESP_OK;
    }
    body[len] = '\0';

    const char *p = strstr(body, "vin=");
    char vin[20];
    size_t j = 0;
    if (p != NULL) {
        p += 4;
        for (; *p != '\0' && *p != '&' && j + 1 < sizeof(vin); p++) {
            char c = (*p == '+') ? ' ' : *p;
            if (c == ' ') {
                continue;
            }
            if (c >= 'a' && c <= 'z') {
                c = (char)(c - 32);
            }
            vin[j++] = c;
        }
    }
    vin[j] = '\0';

    if (p == NULL) {
        snprintf(err_msg, sizeof(err_msg), "没收到 VIN 字段，请重试。");
    } else if (j != 17) {
        snprintf(err_msg, sizeof(err_msg), "VIN 必须是 17 位，当前 %u 位，请核对后重填。",
                 (unsigned)j);
    } else if (!vin_charset_ok(vin)) {
        snprintf(err_msg, sizeof(err_msg), "VIN 只含大写字母和数字，且不含 I / O / Q。");
    } else {
        tlb_app_post_vin(vin); // 落 NVS；配网模式下其内部喊 vin_cfg_stop → 本文件延时重启
        ESP_LOGI(TAG, "配网页已收到 VIN（尾号 %.4s），保存成功，即将重启", vin + 13);
        return send_html(req, PAGE_OK);
    }

    // 分块拼页：head + 错误行 + 表单 + tail（模板含 CSS 的 %，不能整页走 snprintf）
    char line[96];
    int n = snprintf(line, sizeof(line), "<p class=err>%s</p>", err_msg);
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    if (httpd_resp_send_chunk(req, PAGE_HEAD, strlen(PAGE_HEAD)) != ESP_OK ||
        httpd_resp_send_chunk(req, line, n) != ESP_OK ||
        httpd_resp_send_chunk(req, PAGE_FORM_MID, strlen(PAGE_FORM_MID)) != ESP_OK ||
        httpd_resp_send_chunk(req, PAGE_FORM_TAIL, strlen(PAGE_FORM_TAIL)) != ESP_OK) {
        return ESP_FAIL;
    }
    return httpd_resp_send_chunk(req, NULL, 0);
}

// —— DNS 劫持：任何 A 查询一律回答本机 IP，手机才会弹「需要登录」门户页 ——
// 只拼最小应答（原样回问题段 + 一条 A 记录），不引完整 DNS 库。
static void dns_task(void *arg)
{
    (void)arg;
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) {
        ESP_LOGE(TAG, "DNS 套接字创建失败");
        vTaskDelete(NULL);
        return;
    }
    struct sockaddr_in sa = {0};
    sa.sin_family = AF_INET;
    sa.sin_port = htons(53);
    sa.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(fd, (struct sockaddr *)&sa, sizeof(sa)) != 0) {
        ESP_LOGE(TAG, "DNS 绑定 53 端口失败");
        close(fd);
        vTaskDelete(NULL);
        return;
    }
    ESP_LOGI(TAG, "DNS 已监听 :53（所有域名解析到 " VIN_AP_IP "）");
    uint8_t buf[512];
    while (true) {
        struct sockaddr_in ca;
        socklen_t clen = sizeof(ca);
        int n = recvfrom(fd, buf, sizeof(buf), 0, (struct sockaddr *)&ca, &clen);
        if (n < 12) {
            continue;
        }
        uint16_t flags = (uint16_t)buf[2] << 8 | buf[3];
        if ((flags & 0x8000) != 0 || (flags & 0x7FFF) != 0) {
            continue; // 非查询包
        }
        // 问题段必须有且仅有 1 条（门户检测都是如此），QNAME 按 label 跳到 QTYPE+QCLASS
        int p = 12;
        int labels = 0;
        while (p < n) {
            int l = buf[p];
            if (l == 0) {
                p++;
                break;
            }
            if ((l & 0xC0) != 0) { // 压缩指针不该出现在查询里，保守放弃
                p = -1;
                break;
            }
            p += 1 + l;
            labels++;
        }
        if (p < 0 || p + 4 > n || labels == 0 || buf[5] != 1) {
            continue;
        }
        // 应答头：QR=1, AA=1, RCODE=0；问题数保留，应答数=1
        buf[2] = 0x81;
        buf[3] = 0x80;
        buf[6] = 0;
        buf[7] = 1;
        // 紧跟问题段后拼 A 记录：指针压缩到 QNAME 起点(0x0C) + A/IN + TTL + 4B 本机 IP
        uint8_t *a = buf + p + 4;
        a[0] = 0xC0;
        a[1] = 0x0C;
        a[2] = 0;
        a[3] = 1; // TYPE=A
        a[4] = 0;
        a[5] = 1; // CLASS=IN
        a[6] = 0;
        a[7] = 0;
        a[8] = 0;
        a[9] = 60; // TTL
        a[10] = 0;
        a[11] = 4; // RDLEN
        // 192.168.4.2
        a[12] = 192;
        a[13] = 168;
        a[14] = 4;
        a[15] = 2;
        sendto(fd, buf, (size_t)(a + 16 - buf), 0, (struct sockaddr *)&ca, clen);
    }
}

// VIN 存好 → 让手机把「已保存」页收完 → 重启进正常模式（蓝牙栈在重启后才创建）。
// 绝不在 httpd 回调里拆自己的台，善后统一在这里做。
static void vin_cfg_task(void *arg)
{
    (void)arg;
    while (!s_stop_req) {
        vTaskDelay(pdMS_TO_TICKS(500));
    }
    vTaskDelay(pdMS_TO_TICKS(2000)); // 等响应发完、手机渲染完
    ESP_LOGI(TAG, "VIN 已保存，重启进入正常模式（热点随之关闭）");
    esp_restart();
}

bool vin_cfg_start(void)
{
    if (s_running) {
        return true; // 幂等
    }
    s_stop_req = false;

    esp_event_loop_create_default(); // 已建过就返回 INVALID_STATE，忽略
    if (s_ap_netif == NULL) {
        esp_netif_init();
        s_ap_netif = esp_netif_create_default_wifi_ap();
        // 网关 192.168.4.2（4.1 被用户另一块固件占用）。IDF v5.5 的 DHCP 池默认
        // 覆盖整个子网并自动跳过服务器自身地址，无需（也无法）再配 start/end。
        esp_netif_dhcps_stop(s_ap_netif);
        esp_netif_ip_info_t ip = {0};
        IP4_ADDR(&ip.ip, 192, 168, 4, 2);
        IP4_ADDR(&ip.gw, 192, 168, 4, 2);
        IP4_ADDR(&ip.netmask, 255, 255, 255, 0);
        esp_netif_set_ip_info(s_ap_netif, &ip);
        // 门户提示（DHCP 选项 114）：部分安卓据此直接弹配置页。
        // 注意：API 只拷贝指针，URL 必须活过 DHCP 服务整个生命周期 → 静态字面量。
        static const char PORTAL_URL[] = "http://" VIN_AP_IP "/";
        esp_netif_dhcps_option(s_ap_netif, ESP_NETIF_OP_SET, ESP_NETIF_CAPTIVEPORTAL_URI,
                               (void *)PORTAL_URL, sizeof(PORTAL_URL));
        esp_netif_dhcps_start(s_ap_netif);
    }

    ESP_LOGI(TAG, "开热点前堆: 空闲内部=%u 最大内部块=%u",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
    wifi_init_config_t wcfg = WIFI_INIT_CONFIG_DEFAULT();
    esp_err_t e1 = esp_wifi_init(&wcfg);
    if (e1 != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_init 失败(%s/0x%x)，配网热点放弃", esp_err_to_name(e1), (int)e1);
        return false;
    }
    wifi_config_t wc = {0};
    strlcpy((char *)wc.ap.ssid, VIN_AP_SSID, sizeof(wc.ap.ssid));
    strlcpy((char *)wc.ap.password, VIN_AP_PASS, sizeof(wc.ap.password));
    wc.ap.channel = 6;
    wc.ap.authmode = WIFI_AUTH_WPA2_PSK;
    wc.ap.max_connection = 4;
    esp_wifi_set_mode(WIFI_MODE_AP);
    esp_wifi_set_config(WIFI_IF_AP, &wc);
    if (esp_wifi_start() != ESP_OK) {
        ESP_LOGE(TAG, "热点启动失败");
        esp_wifi_deinit();
        return false;
    }

    httpd_config_t hc = HTTPD_DEFAULT_CONFIG();
    hc.lru_purge_enable = true;
    hc.stack_size = 3072;      // 默认 4096；配网参考实测：内存紧时 3072 可显著缓解
    hc.max_uri_handlers = 16;  // 默认 8：/ + /vin + 10 个门户探测路径装不下
    if (httpd_start(&s_server, &hc) != ESP_OK) {
        ESP_LOGE(TAG, "配网页服务启动失败");
        s_server = NULL;
        esp_wifi_stop();
        esp_wifi_deinit();
        return false;
    }
    const httpd_uri_t uri_get = {.uri = "/", .method = HTTP_GET, .handler = root_get};
    const httpd_uri_t uri_post = {.uri = "/vin", .method = HTTP_POST, .handler = vin_post};
    httpd_register_uri_handler(s_server, &uri_get);
    httpd_register_uri_handler(s_server, &uri_post);
    for (size_t i = 0; i < sizeof(PROBE_PATHS) / sizeof(PROBE_PATHS[0]); i++) {
        httpd_uri_t u = {.uri = PROBE_PATHS[i], .method = HTTP_GET, .handler = probe_get};
        httpd_register_uri_handler(s_server, &u);
    }

    if (xTaskCreate(dns_task, "vin_dns", 3072, NULL, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "DNS 任务创建失败（门户弹窗将不可用，手动输地址仍可配）");
    }
    if (xTaskCreate(vin_cfg_task, "vin_cfg", 3072, NULL, 5, NULL) != pdPASS) {
        httpd_stop(s_server);
        s_server = NULL;
        esp_wifi_stop();
        esp_wifi_deinit();
        ESP_LOGE(TAG, "配网监视任务创建失败");
        return false;
    }
    s_running = true;
    ESP_LOGI(TAG, "配网热点已开启：%s（密码见屏幕）→ http://" VIN_AP_IP, VIN_AP_SSID);
    return true;
}

// 兼容串口 REPL 通道调用：配网模式下保存即重启，不在此处拆台（httpd 回调里
// stop 自己会死锁）；正常模式下热点本来就没开，置标志无害。
void vin_cfg_stop(void)
{
    if (s_running) {
        s_stop_req = true;
    }
}

bool vin_cfg_active(void)
{
    return s_running;
}
