[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)][int]$Port = 8000,
    [switch]$SkipSync,
    [switch]$Migrate,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$backendPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\backend'))
$locationPushed = $false
try {
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
        throw '未找到 uv，请先安装 uv 并重新打开终端。'
    }
    foreach ($required in @('pyproject.toml', 'uv.lock', 'alembic.ini')) {
        if (-not (Test-Path -LiteralPath (Join-Path $backendPath $required))) {
            throw "缺少工程文件：$required"
        }
    }
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    try { $listener.Start() } catch { throw "端口 $Port 已被占用，请停止旧服务或使用 -Port 指定其他端口。" }
    finally { $listener.Stop() }
    if ($CheckOnly) {
        Write-Host "启动环境检查通过：uv、工程文件、127.0.0.1:$Port。未安装依赖、迁移或启动服务。"
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
    $databaseResult = $LASTEXITCODE
    if ($databaseResult -eq 0) {
        if ($Migrate) { throw '远程数据库不自动迁移，请按 TECH-013 显式执行并验证。' }
    } elseif ($databaseResult -eq 10) {
        if ($env:TODO_DATABASE_URL) { throw '自定义 SQLite 请按 README 手动启动，避免备份错误文件。' }
    $dataPath = Join-Path $backendPath 'data'
    New-Item -ItemType Directory -Force -Path $dataPath | Out-Null
    $databasePath = Join-Path $dataPath 'todo.sqlite3'
    if (-not (Test-Path -LiteralPath $databasePath) -and -not $Migrate) {
        throw '本地数据库不存在。首次初始化请运行 code\scripts\start.ps1 -Migrate。'
    }
    if ($Migrate) {
        if (Test-Path -LiteralPath $databasePath) {
            $backupPath = Join-Path $dataPath ('backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
            New-Item -ItemType Directory -Path $backupPath -Force | Out-Null
            foreach ($suffix in @('', '-wal', '-shm')) {
                $sourcePath = $databasePath + $suffix
                if (Test-Path -LiteralPath $sourcePath) {
                    Copy-Item -LiteralPath $sourcePath -Destination $backupPath -ErrorAction Stop
                }
            }
            Write-Host "本地数据库已备份：$backupPath"
        }
        Write-Host '正在执行数据库迁移……'
        & uv run --locked alembic upgrade head
        if ($LASTEXITCODE -ne 0) { throw '数据库迁移失败，启动已停止；请保留备份检查原因。' }
    } else {
        Write-Host '使用已有本地数据库，保留原有数据；本次不备份、不迁移。'
    }
    } else {
        throw '数据库连接或版本检查失败，启动已停止。'
    }
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


