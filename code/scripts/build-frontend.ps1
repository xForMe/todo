[CmdletBinding()]
param(
    [switch]$SkipSync,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$reactPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\frontend-react'))
$distPath = [System.IO.Path]::GetFullPath((Join-Path $reactPath 'public\dist'))
$bundleName = 'workbench-react.js'

foreach ($required in @('package.json', 'package-lock.json', 'vite.config.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $reactPath $required) -PathType Leaf)) {
        throw "缺少 React 工程文件：$required"
    }
}
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node -or -not $npm) {
    throw '未找到 Node.js 或 npm，请安装 Node.js 22.12+ 并重新打开终端。'
}
$nodeVersion = & $node.Source --version
# Vite 8 supports Node ^20.19.0 or >=22.12.0; this project requires the latter.
if ($LASTEXITCODE -ne 0 -or -not ($nodeVersion -match '^v(\d+\.\d+\.\d+)$') -or [version]$Matches[1] -lt [version]'22.12.0') {
    throw "React 构建需要 Node.js 22.12+，当前版本：$nodeVersion"
}
if ($SkipSync -and -not (Test-Path -LiteralPath (Join-Path $reactPath 'node_modules\.bin\vite.cmd') -PathType Leaf)) {
    throw '缺少已安装的 React 构建依赖，请取消 -SkipSync 或先按锁文件安装。'
}
if ($CheckOnly) {
    Write-Host "React 构建环境检查通过：Node.js $nodeVersion。未安装依赖或生成产物。"
    return
}

Push-Location -LiteralPath $reactPath
try {
    if (-not $SkipSync) {
        Write-Host '正在按锁文件安装 React 构建依赖……'
        & $npm.Source ci --ignore-scripts --include=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'React 依赖安装失败，未替换原产物。' }
    }
    # Build outside the static root. Only publish a complete bundle after Vite exits successfully.
    $stageParent = Join-Path $reactPath 'build'
    New-Item -ItemType Directory -Path $stageParent -Force | Out-Null
    $stage = New-Item -ItemType Directory -Path (Join-Path $stageParent ('.vite-stage-' + [guid]::NewGuid().ToString('N')))
    try {
        & $npm.Source run build -- --outDir $stage.FullName
        if ($LASTEXITCODE -ne 0) { throw 'React 构建失败，未替换原产物。' }
        $built = Join-Path $stage.FullName $bundleName
        if (-not (Test-Path -LiteralPath $built -PathType Leaf) -or (Get-Item -LiteralPath $built).Length -eq 0) {
            throw 'React 构建未生成有效产物，未替换原产物。'
        }
        New-Item -ItemType Directory -Path $distPath -Force | Out-Null
        $bundle = Join-Path $distPath $bundleName
        if (Test-Path -LiteralPath $bundle -PathType Leaf) {
            [System.IO.File]::Replace($built, $bundle, [NullString]::Value)
        } else {
            [System.IO.File]::Move($built, $bundle)
        }
        Write-Host 'React 前端构建已就绪，由 FastAPI 同源提供。'
    } finally {
        # The only directory removed is the one this invocation just created above.
        if ($stage.Parent.FullName -eq $stageParent -and $stage.Name -match '^\.vite-stage-[0-9a-f]{32}$') {
            Remove-Item -LiteralPath $stage.FullName -Recurse -Force
        }
    }
} finally {
    Pop-Location
}
