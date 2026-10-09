# ============================================================
#  一键烧录脚本（配合 flash.bat 双击运行）
#  流程：认端口(VID_303A) → 找 ESP-IDF → 编译 → 备份 NVS → 烧录
#  换电脑、换盘符都不用改，所有路径相对本文件所在目录（仓库根）。
# ============================================================
param([switch]$NoPause)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Say($msg, $color = 'White') { Write-Host "`n== $msg" -ForegroundColor $color }
function Die($msg) { Write-Host "`n[X] $msg" -ForegroundColor Red; if (-not $NoPause) { Read-Host '按回车退出' }; exit 1 }

# ---- 1. 找板子串口：ESP32-C3 原生 USB 的厂商 ID 固定是 VID_303A，
#      鼠标键盘(HID)/移动硬盘(大容量存储)都不会命中，按它过滤即可。
Say '第 1 步：识别板子串口（VID_303A = Espressif）' 'Cyan'
$ports = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.InstanceId -match 'VID_303A' } |
    ForEach-Object { if ($_.FriendlyName -match '\((COM\d+)\)') { $Matches[1] } } |
    Sort-Object -Unique)
if ($ports.Count -eq 0) {
    Write-Host '没找到 Espressif 设备。请确认：' -ForegroundColor Yellow
    Write-Host '  1) USB 线已插好（要数据线，不是只能充电的线）' -ForegroundColor Yellow
    Write-Host '  2) 换台电脑/换一个 USB 口试试' -ForegroundColor Yellow
    Die '未识别到板子串口'
}
if ($ports.Count -gt 1) {
    Write-Host "检测到多个 Espressif 串口：$($ports -join ', ')" -ForegroundColor Yellow
    $ports = Read-Host '请输入要用的串口号（如 COM5）'
} else {
    $ports = $ports[0]
}
Say "串口 = $ports" 'Green'

# ---- 2. 找 ESP-IDF v5.5.3：本机环境变量 → 各盘符常见安装位置逐个试
Say '第 2 步：定位 ESP-IDF' 'Cyan'
$idf = $null
if ($env:IDF_PATH -and (Test-Path "$env:IDF_PATH\export.ps1")) { $idf = $env:IDF_PATH }
if (-not $idf) {
    $roots = @((Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -ne $null }).Root)
    foreach ($r in $roots) {
        foreach ($sub in @('esp-idf-v5.5.3', 'esp\esp-idf-v5.5.3', 'Espressif\frameworks\esp-idf-v5.5.3')) {
            $p = Join-Path $r $sub
            if (Test-Path (Join-Path $p 'export.ps1')) { $idf = $p; break }
        }
        if ($idf) { break }
    }
}
if (-not $idf -and $env:LOCALAPPDATA) {
    $p = Join-Path $env:LOCALAPPDATA 'Espressif\frameworks\esp-idf-v5.5.3'
    if (Test-Path (Join-Path $p 'export.ps1')) { $idf = $p }
}
if (-not $idf) {
    $idf = Read-Host '自动没找到 ESP-IDF，手动输入 esp-idf-v5.5.3 目录路径'
    if (-not (Test-Path (Join-Path $idf 'export.ps1'))) { Die "路径下没有 export.ps1：$idf" }
}
Say "ESP-IDF = $idf" 'Green'
# 工具链目录：优先 IDF 同级的 tools（本机布局），没有就用 IDF 默认
$tools = Join-Path (Split-Path $idf -Parent) 'tools'
if (Test-Path $tools) { $env:IDF_TOOLS_PATH = $tools }
. (Join-Path $idf 'export.ps1') | Out-Null
if (-not (Get-Command idf.py -ErrorAction SilentlyContinue)) { Die 'IDF 激活失败：idf.py 不可用' }

# ---- 3. 编译（增量，没改动时很快）
Say '第 3 步：编译固件' 'Cyan'
idf.py -C tesla-offline-ble build
if ($LASTEXITCODE -ne 0) { Die '编译失败，看上面的报错' }

# ---- 4. 备份 NVS（红线：里面有本车绑定密钥，烧录前必须留一份）
Say '第 4 步：备份 NVS（0x9000）' 'Cyan'
New-Item -ItemType Directory -Force -Path nvs-backups | Out-Null
$backup = "nvs-backups\nvs-before-$(Get-Date -Format yyyyMMdd-HHmmss).bin"
python -m esptool --chip esp32c3 -p $ports --baud 921600 --before default_reset --after hard_reset `
    read_flash 0x9000 0x6000 $backup
if ($LASTEXITCODE -ne 0) { Die "NVS 备份失败，已中止（没动固件，放心）。重试或检查 USB" }
Say "NVS 已备份到 $backup" 'Green'

# ---- 5. 烧录（bootloader + 分区表 + 应用，绝不碰 0x9000）
Say '第 5 步：烧录固件' 'Cyan'
idf.py -C tesla-offline-ble -p $ports flash
if ($LASTEXITCODE -ne 0) { Die '烧录失败。若刚才是断电/拔线导致，直接重新双击本脚本即可' }

Write-Host ''
Write-Host '  [OK] 烧录完成！板子已自动重启，可以拔线去车里用了。' -ForegroundColor Green
Write-Host "  想看运行日志：idf.py -C tesla-offline-ble -p $ports monitor（退出 Ctrl+]）" -ForegroundColor Gray
if (-not $NoPause) { Read-Host "`n按回车关闭窗口" }
