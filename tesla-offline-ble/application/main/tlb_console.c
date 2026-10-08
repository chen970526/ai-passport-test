// 最小串口命令行：把探针上那组按钮一一映射成子命令，全部只做「入队」，
// 真正的 BLE 动作仍由 worker 任务执行（tlb_app_post 的约定）。
// 走板上已有的 USB-Serial-JTAG（和日志同一个口），不占额外引脚。
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#include "esp_console.h"
#include "esp_err.h"
#include "esp_log.h"
#include "nvs.h"
#include "tesla_ble/tlb_ble.h"
#include "tesla_core/tlb_text.h"
#include "tesla_core/tlb_types.h"

#define TLB_TAG "tlb_console"

// 无参数命令：context 里装的就是要投递的命令号。
static int cmd_post_simple(void *ctx, int argc, char **argv)
{
    (void)argc;
    (void)argv;
    tlb_app_post((tlb_cmd_t)(intptr_t)ctx, 0);
    return 0;
}

static int reg_simple(const char *name, const char *hint, const char *help, tlb_cmd_t cmd)
{
    esp_console_cmd_t c = {
        .command = name,
        .help = help,
        .hint = hint,
        .func = NULL,
        .argtable = NULL,
        .func_w_context = cmd_post_simple,
        .context = (void *)(intptr_t)cmd,
    };
    return esp_console_cmd_register(&c);
}

// connect [VIN]：给了 VIN 就按 VIN 扫并连，没给就走自动重连那一轮。
static int cmd_connect(void *ctx, int argc, char **argv)
{
    (void)ctx;
    if (argc >= 2) {
        tlb_app_post_vin(argv[1]);
        tlb_app_post(TLB_CMD_CONNECT_VIN, 0);
    } else {
        tlb_app_post(TLB_CMD_CONNECT_AUTO, 0);
    }
    return 0;
}

// rke <action>：action 直接当参数传给 handle_rke。
// 数值一律以 vcsec.RKEAction_E 为准（tlb_text.c 的 E_RKE / tlb_types.h）：
//   0=UNLOCK 解锁  1=LOCK 上锁  20=REMOTE_DRIVE 驾驶授权  29=AUTO_SECURE  30=WAKE 唤醒
// 旧文案把 1 说成解锁、20 说成上锁，是凭印象编的 —— 真机因此误发过一条 REMOTE_DRIVE。
// 这里先按白名单拦一次（给即时反馈），固件侧 handle_rke 还会再拦一次（权威闸门）。
static int cmd_rke(void *ctx, int argc, char **argv)
{
    (void)ctx;
    if (argc < 2) {
        printf("用法: rke <action>  0=解锁 1=上锁 20=驾驶授权(RemoteDrive) 29=自动落锁 30=唤醒\r\n");
        return 1;
    }
    char *end = NULL;
    long v = strtol(argv[1], &end, 10);
    if (end == argv[1] || (end && *end)) {
        printf("rke: 「%s」不是数字\r\n", argv[1]);
        return 1;
    }
    if (!tlb_rke_action_known((int32_t)v)) {
        printf("rke: %ld 不在官方 RKEAction_E 白名单(0/1/20/29/30)，已拒绝下发\r\n", v);
        return 1;
    }
    printf("已入队 ");
    char lbl[64];
    tlb_label(TLB_EN_RKE, (uint32_t)v, lbl, sizeof(lbl));
    printf("%s（回车后由 worker 执行，下发前还会打一行审计）\r\n", lbl);
    tlb_app_post(TLB_CMD_RKE, (int32_t)v);
    return 0;
}

// loop start|stop：退避重连循环的开关。
static int cmd_loop(void *ctx, int argc, char **argv)
{
    (void)ctx;
    if (argc >= 2 && strcmp(argv[1], "stop") == 0) {
        tlb_app_post(TLB_CMD_LOOP_STOP, 0);
        return 0;
    }
    if (argc >= 2 && strcmp(argv[1], "start") == 0) {
        tlb_app_post(TLB_CMD_LOOP_START, 0);
        return 0;
    }
    printf("用法: loop start|stop\r\n");
    return 1;
}

// forget：默认只清绑定档案；--all 连本机密钥和两个域的 counter 一起清（需要重新刷卡）。
static int cmd_forget(void *ctx, int argc, char **argv)
{
    (void)ctx;
    if (argc >= 2 && strcmp(argv[1], "--all") == 0) {
        printf("警告: 正在清除本机密钥 + 全部 V3 会话（含 counter）。counter 只能单调递增，清完必须重新刷卡绑定。\r\n");
        tlb_app_post(TLB_CMD_FORGET, 0);
        return 0;
    }
    tlb_app_post(TLB_CMD_FORGET, 1);
    return 0;
}

// vin：读回当前生效的 VIN（档案里没有时用手动输入的那条）。
static int cmd_vin(void *ctx, int argc, char **argv)
{
    (void)ctx;
    (void)argc;
    char vin[40];
    if (argc >= 2) {
        tlb_app_post_vin(argv[1]);
        snprintf(vin, sizeof(vin), "%s", argv[1]);
        printf("已记录 VIN（去空格、转大写后由 core 处理）\r\n");
        return 0;
    }
    if (!tlb_nvs_vin_load(vin, sizeof(vin)) || !vin[0]) {
        printf("本机还没有 VIN，可执行: vin <17位>\r\n");
        return 1;
    }
    printf("VIN=%s\r\n", vin);
    return 0;
}

// wipe_legacy：只删旧「AI工牌」应用留在 NVS 里的 trae_cfg 命名空间（245B profile）。
// 旧固件本体早在刷 0x10000 时被覆盖，这是唯一残留；本固件从不读它，删不删都不影响功能。
// 绝不允许在这里碰 tesla_ble / nimble_bond / phy —— 前两个是车钥匙的命根子。
static int cmd_wipe_legacy(void *ctx, int argc, char **argv)
{
    (void)ctx;
    (void)argc;
    (void)argv;
    nvs_handle_t h;
    esp_err_t e = nvs_open("trae_cfg", NVS_READWRITE, &h);
    if (e == ESP_ERR_NVS_NOT_FOUND) {
        printf("trae_cfg 不存在，旧配置已经清过了\r\n");
        return 0;
    }
    if (e != ESP_OK) {
        printf("打开 trae_cfg 失败: %s\r\n", esp_err_to_name(e));
        return 1;
    }
    e = nvs_erase_all(h);
    if (e == ESP_OK) {
        e = nvs_commit(h);
    }
    nvs_close(h);
    if (e != ESP_OK) {
        printf("清除 trae_cfg 失败: %s\r\n", esp_err_to_name(e));
        return 1;
    }
    printf("已清除 trae_cfg（旧 AI工牌配置）；tesla_ble 绑定与配对信息未动\r\n");
    return 0;
}

void tlb_console_start(void)
{
    esp_console_repl_t *repl = NULL;
    esp_console_dev_usb_serial_jtag_config_t dev_cfg = ESP_CONSOLE_DEV_USB_SERIAL_JTAG_CONFIG_DEFAULT();
    esp_console_repl_config_t repl_cfg = ESP_CONSOLE_REPL_CONFIG_DEFAULT();

    repl_cfg.prompt = "tlb> ";
    repl_cfg.max_cmdline_length = 128;
    repl_cfg.task_stack_size = 4096;
    repl_cfg.task_priority = 2;

    esp_err_t e = esp_console_new_repl_usb_serial_jtag(&dev_cfg, &repl_cfg, &repl);
    if (e != ESP_OK) {
        ESP_LOGE(TLB_TAG, "串口控制台起不来: 0x%x", e);
        return;
    }

    struct {
        const char *name;
        const char *help;
        tlb_cmd_t cmd;
    } simple[] = {
        {"scan", "列出车辆 BLE 广播（全部广播）", TLB_CMD_SCAN_LIST},
        {"handshake", "VCSEC 与车机两个域各握手一次", TLB_CMD_HANDSHAKE},
        {"bind", "刷 NFC 钥匙卡完成绑定（需已连接车辆）", TLB_CMD_BIND},
        {"probe", "会话探针确认（只读，不发控制指令）", TLB_CMD_PROBE},
        {"version", "读 0x0214 固件版本", TLB_CMD_VERSION},
        {"status", "打印一行设备状态", TLB_CMD_STATUS},
        {"disconnect", "主动断开并暂停自动重连", TLB_CMD_DISCONNECT},
        {"resume", "取消「用户主动断开」的暂停标记，恢复自动重连", TLB_CMD_RESUME},
    };

    esp_err_t first_err = ESP_OK;
    for (size_t i = 0; i < sizeof(simple) / sizeof(simple[0]); i++) {
        esp_err_t r = reg_simple(simple[i].name, NULL, simple[i].help, simple[i].cmd);
        if (r != ESP_OK && first_err == ESP_OK) {
            first_err = r;
        }
    }

    const esp_console_cmd_t extra[] = {
        {
            .command = "connect", .hint = "[VIN]",
            .help = "连接车辆：带 VIN 按 VIN 匹配，不带则走自动重连一轮",
            .func_w_context = cmd_connect,
        },
        {
            .command = "rke", .hint = "<0|1|20|29|30>",
            .help = "RKE 控制：0=解锁 1=上锁 20=驾驶授权(RemoteDrive) 29=自动落锁 30=唤醒",
            .func_w_context = cmd_rke,
        },
        {
            .command = "loop", .hint = "start|stop",
            .help = "自动重连轮询开关（固定约 2 秒一轮）",
            .func_w_context = cmd_loop,
        },
        {
            .command = "wipe_legacy",
            .help = "只清除旧 AI工牌留在 NVS 的 trae_cfg 配置（不碰车钥匙绑定）",
            .func_w_context = cmd_wipe_legacy,
        },
        {
            .command = "forget", .hint = "[--all]",
            .help = "清除绑定档案；加 --all 连密钥和 counter 一起清",
            .func_w_context = cmd_forget,
        },
        {
            .command = "vin", .hint = "[17位VIN]",
            .help = "查看或设置本机 VIN",
            .func_w_context = cmd_vin,
        },
    };
    for (size_t i = 0; i < sizeof(extra) / sizeof(extra[0]); i++) {
        esp_console_cmd_t c = extra[i];
        c.context = NULL;
        esp_err_t r = esp_console_cmd_register(&c);
        if (r != ESP_OK && first_err == ESP_OK) {
            first_err = r;
        }
    }

    esp_console_register_help_command();

    if (first_err != ESP_OK) {
        ESP_LOGW(TLB_TAG, "部分控制台命令注册失败: 0x%x", first_err);
    }

    e = esp_console_start_repl(repl);
    if (e != ESP_OK) {
        ESP_LOGE(TLB_TAG, "REPL 任务启动失败: 0x%x", e);
        return;
    }
    ESP_LOGI(TLB_TAG, "串口控制台已就绪，输入 help 看命令（命令只入队，结果稍后打印）");
}

