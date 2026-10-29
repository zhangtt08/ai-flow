# AI Flow Launcher (self-healing)
# Starts AI Flow. If a backend left over from a previous crash still holds the
# single-instance mutex, this cleans it up first so the app does not fail silently.
#
# 用法：双击 AI Flow 启动器.cmd 即可（本文件由它调用）。
# 如果双击 exe 没反应，用这个启动器，它会自动清理残留进程。

$ErrorActionPreference = 'SilentlyContinue'
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $AppDir 'AI Flow.exe'
$DataDir = Join-Path $env:APPDATA 'com.aiflow.desktop'
$DesktopJson = Join-Path $DataDir 'desktop.json'

function Test-Health([int]$Port) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 -UseBasicParsing
        return ($r.StatusCode -eq 200 -and $r.Content -match 'ai-flow')
    } catch { return $false }
}

function Get-ListeningPort {
    if (-not (Test-Path $DesktopJson)) { return 0 }
    try { return [int](Get-Content $DesktopJson -Raw | ConvertFrom-Json).port } catch { return 0 }
}

Write-Host '========================================' -ForegroundColor Cyan
Write-Host '  AI Flow 启动器' -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan

if (-not (Test-Path $Exe)) {
    Write-Host '[错误] 没找到 AI Flow.exe' -ForegroundColor Red
    Write-Host '请确认本文件与 AI Flow.exe 在同一个文件夹。'
    Read-Host '按回车退出'
    exit 1
}

$port = Get-ListeningPort
if ($port -gt 0 -and (Test-Health $port)) {
    Write-Host "AI Flow 已在运行（端口 $port），正在打开窗口..." -ForegroundColor Green
    Start-Process "http://127.0.0.1:$port/"
    Start-Sleep -Seconds 2
    exit 0
}

Write-Host '检查残留进程...'
$stale = Get-CimInstance Win32_Process -Filter "Name='node.real.exe' OR Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*server.mjs*' -and $_.CommandLine -like '*AI Flow*' }

if ($stale) {
    foreach ($proc in $stale) {
        Write-Host ("  清理残留进程 PID {0}" -f $proc.ProcessId) -ForegroundColor Yellow
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Write-Host '等待锁释放...'
    Start-Sleep -Seconds 3
} else {
    Write-Host '  没有残留进程。'
}

if (Test-Path $DesktopJson) { Remove-Item $DesktopJson -Force -ErrorAction SilentlyContinue }

Write-Host '正在启动 AI Flow...'
Start-Process -FilePath $Exe

Write-Host '等待服务就绪...'
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $port = Get-ListeningPort
    if ($port -gt 0 -and (Test-Health $port)) { $ok = $true; break }
    Write-Host -NoNewline '.'
}
Write-Host ''

if ($ok) {
    Write-Host "AI Flow 启动成功（端口 $port）。" -ForegroundColor Green
    Start-Sleep -Seconds 2
    exit 0
}

Write-Host '[警告] 服务启动较慢或没有响应。' -ForegroundColor Yellow
Write-Host '请稍等几秒后手动双击 AI Flow.exe 再试一次。'
Write-Host "如果仍然打不开，把日志发给开发者：$DataDir\ai-flow.log"
Read-Host '按回车退出'
exit 1