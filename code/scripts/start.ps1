[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)][int]$Port = 8000,
    [switch]$SkipSync,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$backendPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\backend'))
$locationPushed = $false

function Get-ProjectListeners {
    # Only listeners belonging to this checkout can be stopped, never arbitrary port owners.
    $owners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -eq $Port } | Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($ownerId in $owners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerId"
        $command = [string]$process.CommandLine
        $python = Join-Path $backendPath '.venv\Scripts\python.exe'
        $uvicorn = Join-Path $backendPath '.venv\Scripts\uvicorn.exe'
        $owned = $command -match '(^|\s)todo_backend\.main:create_app(\s|$)' -and (
            $command.IndexOf('"' + $python + '"', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $command.IndexOf('"' + $uvicorn + '"', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $command.StartsWith($python + ' ', [StringComparison]::OrdinalIgnoreCase) -or
            $command.StartsWith($uvicorn + ' ', [StringComparison]::OrdinalIgnoreCase))
        if (-not $process -or -not $owned) {
            throw "端口 $Port 被其他程序或无法核实的进程占用（PID $ownerId），未停止该进程。"
        }
        $process
    }
}

function Assert-PortAvailable {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    try { $listener.Start() } catch { throw "端口 $Port 未释放或已被其他程序占用，启动已停止。" }
    finally { $listener.Stop() }
}

try {
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
        throw '未找到 uv，请先安装 uv 并重新打开终端。'
    }
    foreach ($required in @('pyproject.toml', 'uv.lock', 'alembic.ini')) {
        if (-not (Test-Path -LiteralPath (Join-Path $backendPath $required))) {
            throw "缺少工程文件：$required"
        }
    }
    $existing = @(Get-ProjectListeners)
    if (-not $existing.Count) { Assert-PortAvailable }
    if ($CheckOnly) {
        Write-Host "启动环境检查通过：端口 $Port，本项目已运行进程数 $($existing.Count)。未停止服务、同步依赖或访问数据库。"
        exit 0
    }
    Push-Location -LiteralPath $backendPath
    $locationPushed = $true
    if (-not $SkipSync) {
        Write-Host '正在按锁文件同步依赖……'
        & uv sync --locked
        if ($LASTEXITCODE -ne 0) { throw '依赖同步失败，启动已停止。' }
    }
    & uv run --locked python ../scripts/database_status.py
    if ($LASTEXITCODE -ne 0) {
        throw 'PostgreSQL 连接或版本检查失败，旧服务未停止。'
    }
    foreach ($previous in @(Get-ProjectListeners)) {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($previous.ProcessId)"
        if (-not $current) { continue }
        if ($current.CreationDate -ne $previous.CreationDate -or $current.CommandLine -ne $previous.CommandLine) {
            throw '端口进程身份已变化，未停止进程，请重新启动。'
        }
        Write-Host "正在停止本项目旧服务（PID $($current.ProcessId)）……"
        Stop-Process -Id $current.ProcessId -Force
        Wait-Process -Id $current.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -eq $Port }).Count -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 200
    }
    Assert-PortAvailable
    Write-Host "打开浏览器访问 http://127.0.0.1:$Port ，即可开始使用。"
    Write-Host '服务运行期间请保持此窗口打开，按 Ctrl+C 停止。'
    & uv run --locked uvicorn todo_backend.main:create_app --factory --host 127.0.0.1 --port $Port
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 130 -and $LASTEXITCODE -ne -1073741510) {
        throw "服务退出，退出码：$LASTEXITCODE"
    }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    if ($locationPushed) { Pop-Location }
}


