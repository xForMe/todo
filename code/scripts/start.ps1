[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)][int]$Port = 8000,
    [switch]$SkipSync,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$backendPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\backend'))
$venvPath = Join-Path $backendPath '.venv'
$python = Join-Path $venvPath 'Scripts\python.exe'
$uvicorn = Join-Path $venvPath 'Scripts\uvicorn.exe'
$buildFrontend = Join-Path $PSScriptRoot 'build-frontend.ps1'
$databaseStatus = Join-Path $PSScriptRoot 'database_status.py'
$app = 'todo_backend.main:create_app'

function Get-PortOwners {
    Get-NetTCPConnection -State Listen | Where-Object LocalPort -EQ $Port |
        Select-Object -ExpandProperty OwningProcess -Unique
}

function Get-ProjectListeners {
    # Windows console entry points may hand the socket to the base Python.
    # Match whole arguments at the front, never a path mentioned elsewhere.
    $entry = '(?:"' + [regex]::Escape($uvicorn) + '"|' + [regex]::Escape($uvicorn) + ')'
    $appArg = [regex]::Escape($app) + '(?:\s|$)'
    foreach ($ownerId in @(Get-PortOwners)) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerId"
        if ($process -and $process.CommandLine -match '^(?:"([^"\r\n]+)"|([^\s"]+))\s+(.+)$') {
            $exe = $Matches[1] + $Matches[2]
            $arguments = $Matches[3]
            if ($process.ExecutablePath -eq $exe -and (
                ($exe -eq $uvicorn -and $arguments -match "^$appArg") -or
                ([IO.Path]::GetFileName($exe) -eq 'python.exe' -and $arguments -match "^$entry\s+$appArg") -or
                ($exe -eq $python -and $arguments -match "^-m\s+uvicorn\s+$appArg")
            )) {
                $process
                continue
            }
        }
        throw "端口 $Port 被其他程序或无法核实的进程占用（PID $ownerId），未停止该进程。"
    }
}

function Assert-PortAvailable {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    $listener.ExclusiveAddressUse = $true
    try { $listener.Start() }
    catch { throw "端口 $Port 未释放或已被其他程序占用，启动已停止。" }
    finally { $listener.Stop() }
}

function Stop-PreviousService {
    foreach ($previous in @(Get-ProjectListeners)) {
        $process = Get-Process -Id $previous.ProcessId -ErrorAction SilentlyContinue
        if (-not $process) { continue }
        try {
            # Hold the process handle while checking it still owns this port.
            $null = $process.Handle
            $current = Get-ProjectListeners | Where-Object ProcessId -EQ $previous.ProcessId
            if (-not $current) { continue }
            if ($current.CreationDate -ne $previous.CreationDate -or $current.CommandLine -cne $previous.CommandLine) {
                throw '端口进程身份已变化，未停止进程，请重新启动。'
            }
            Write-Host "正在停止本项目旧服务（PID $($process.Id)）……"
            Stop-Process -InputObject $process -Force
            if (-not $process.WaitForExit(10000)) {
                throw "旧服务（PID $($process.Id)）未退出，启动已停止。"
            }
        } finally {
            $process.Dispose()
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (@(Get-PortOwners).Count) {
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "端口 $Port 仍有监听进程，启动已停止。"
        }
        Start-Sleep -Milliseconds 200
    }
    Assert-PortAvailable
}

function Assert-ProjectFiles {
    param([string[]]$Paths)
    foreach ($path in $Paths) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "缺少启动所需文件：$path"
        }
    }
}

try {
    Assert-ProjectFiles @((Join-Path $backendPath 'pyproject.toml'), (Join-Path $backendPath 'uv.lock'),
        (Join-Path $backendPath 'alembic.ini'), $databaseStatus, $buildFrontend)
    if ($SkipSync) {
        if (-not (Test-Path -LiteralPath $python -PathType Leaf) -or
            -not (Test-Path -LiteralPath $uvicorn -PathType Leaf)) {
            throw '未安装后端依赖，请取消 -SkipSync 后再启动。'
        }
    } else {
        $uv = Get-Command uv.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $uv) { throw '未找到 uv，请先安装 uv 并重新打开终端。' }
    }

    $existing = @(Get-ProjectListeners)
    if (-not $existing.Count) { Assert-PortAvailable }
    & $buildFrontend -CheckOnly -SkipSync:$SkipSync
    if ($CheckOnly) {
        Write-Host "启动环境检查通过：端口 $Port，本项目监听进程数 $($existing.Count)。未安装、构建、查库或停止进程。"
        exit 0
    }

    Push-Location -LiteralPath $backendPath
    try {
        if (-not $SkipSync) {
            Write-Host '正在按锁文件同步后端依赖……'
            $originalVenv = $env:UV_PROJECT_ENVIRONMENT
            try {
                $env:UV_PROJECT_ENVIRONMENT = $venvPath
                & $uv.Source sync --locked
                if ($LASTEXITCODE -ne 0) { throw '后端依赖同步失败，旧服务未停止。' }
            } finally {
                $env:UV_PROJECT_ENVIRONMENT = $originalVenv
            }
        }
        Assert-ProjectFiles @($python, $uvicorn)
        & $python $databaseStatus
        if ($LASTEXITCODE -ne 0) {
            throw 'PostgreSQL 连接或版本检查失败，旧服务未停止；启动不会自动迁移。'
        }

        & $buildFrontend -SkipSync:$SkipSync
        Stop-PreviousService

        Write-Host "正在启动 http://127.0.0.1:$Port 。看到 Uvicorn 启动完成后即可访问，按 Ctrl+C 停止。"
        & $uvicorn $app --factory --host 127.0.0.1 --port $Port
        if ($LASTEXITCODE -notin @(0, 130, -1073741510)) {
            throw "服务退出，退出码：$LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
