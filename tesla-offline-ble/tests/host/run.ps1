# tests/host/run.ps1 —— 编译并运行 tesla_core 主机测试（纯 C，不依赖 ESP-IDF）。
# 用法： powershell -ExecutionPolicy Bypass -File tests/host/run.ps1 [-Regen]
param(
    [switch]$Regen
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$build = Join-Path $root 'build/host'
New-Item -ItemType Directory -Force -Path $build | Out-Null

if ($Regen -or -not (Test-Path (Join-Path $build 'goldens.h.stamp'))) {
    node (Join-Path $root 'tools/gen_goldens.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'gen_goldens failed' }
    (Get-Item (Join-Path $root 'tests/host/goldens.h')).LastWriteTime | Set-Content (Join-Path $build 'goldens.h.stamp')
}

$srcs = @(Get-ChildItem -Recurse -Path (Join-Path $root 'components/tesla_core/src') -Filter *.c |
          ForEach-Object { $_.FullName })
$srcs += (Get-ChildItem -Path (Join-Path $root 'tests/host') -Filter *.c |
          ForEach-Object { $_.FullName })

$exe = Join-Path $build 'test_core.exe'
$common = @('-std=c11', '-O1', '-g0', '-Wall', '-Wextra', '-Werror',
            '-I', (Join-Path $root 'components/tesla_core/include'),
            '-I', (Join-Path $root 'tests/host'))

& gcc @common $srcs '-o' $exe
if ($LASTEXITCODE -ne 0) { throw 'gcc compile failed' }

& $exe
if ($LASTEXITCODE -ne 0) { throw 'host tests failed' }
Write-Output 'host tests: PASS'
