# AI Flow Launcher (self-healing)
# 1) If any AI Flow backend responds to /api/health, just open its page (never kill a healthy instance).
# 2) Otherwise kill leftover backends that are not responding (they still hold the single-instance
#    mutex, which is why double-clicking AI Flow.exe can do nothing).
# 3) Start AI Flow and wait until the service really responds.

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

function Get-ListeningPort([int]$ProcessId) {
    $conn = Get-NetTCPConnection -State Listen -OwningProcess $ProcessId -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return [int]$conn.LocalPort }
    return 0
}

# 任何目录下的 AI Flow 后端（路径里可能是 "AI Flow" 也可能是 "AI-Flow"）
function Get-AiFlowBackends {
    Get-CimInstance Win32_Process -Filter "Name='node.real.exe' OR Name='node.exe'" |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -match 'server\.mjs' -and
            $_.CommandLine -match '(?i)AI[ -]?Flow'
        } | ForEach-Object {
            [pscustomobject]@{
                ProcessId = $_.ProcessId
                Port      = Get-ListeningPort $_.ProcessId
            }
        }
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

# ---------- 1. 已有能响应的实例：直接打开（绝不杀正常实例）----------
$backends = @(Get-AiFlowBackends)
$live = $backends | Where-Object { $_.Port -gt 0 -and (Test-Health $_.Port) } | Select-Object -First 1
if (-not $live) {
    # 启动瞬间端口刚起还没响应：最多等 6 秒
    $starting = $backends | Where-Object { $_.Port -gt 0 } | Select-Object -First 1
    if ($starting) {
        for ($i = 0; $i -lt 3; $i++) {
            Start-Sleep -Seconds 2
            if (Test-Health $starting.Port) { $live = $starting; break }
        }
    }
}
if ($live) {
    Write-Host "AI Flow 已在运行（端口 $($live.Port)），正在打开窗口..." -ForegroundColor Green
    Start-Process "http://127.0.0.1:$($live.Port)/"
    Start-Sleep -Seconds 2
    exit 0
}

# ---------- 2. 清理连不上的残留后端（它们占着单实例锁）----------
if ($backends.Count -gt 0) {
    foreach ($proc in $backends) {
        if ($proc.Port -gt 0 -and (Test-Health $proc.Port)) { continue }
        Write-Host ("  清理残留后端 PID {0}" -f $proc.ProcessId) -ForegroundColor Yellow
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Write-Host '等待锁释放...'
    Start-Sleep -Seconds 3
} else {
    Write-Host '检查残留进程... 没有残留进程。'
}

if (Test-Path $DesktopJson) { Remove-Item $DesktopJson -Force -ErrorAction SilentlyContinue }

# ---------- 3. 启动 ----------
Write-Host '正在启动 AI Flow...'
Start-Process -FilePath $Exe

Write-Host '等待服务就绪...'
$ok = $false
$port = 0
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Path $DesktopJson) {
        try { $port = [int](Get-Content $DesktopJson -Raw | ConvertFrom-Json).port } catch { $port = 0 }
    }
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