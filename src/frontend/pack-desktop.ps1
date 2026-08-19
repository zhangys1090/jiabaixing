# Jiabaixing Desktop - pack script (Hermes approach)
# Usage: cd c:\zy\jiabaixing\src\frontend ; .\pack-desktop.ps1

$ErrorActionPreference = "Stop"

$FrontendDir = "c:\zy\jiabaixing\src\frontend"
$ProjectDir = "c:\zy\jiabaixing"
$ReleaseDir = Join-Path $FrontendDir "release\JiabaixingDesktop-win32-x64"
$AppDir = Join-Path $ReleaseDir "resources\app"
$PythonSource = Join-Path $ProjectDir "python"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Jiabaixing Desktop Pack (Hermes)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Step 0: pre-checks
Write-Host "[0/6] Pre-checks..." -ForegroundColor Yellow

$buildIndex = Join-Path $FrontendDir "build\index.html"
$electronMain = Join-Path $FrontendDir "electron\main.js"
$exePath = Join-Path $ReleaseDir "JiabaixingDesktop.exe"
$pythonMain = Join-Path $PythonSource "agent\main.py"

if (-not (Test-Path $buildIndex)) {
    Write-Host "  ERROR: build/ not found, run 'npm run build' first" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $electronMain)) {
    Write-Host "  ERROR: electron/main.js not found" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $exePath)) {
    Write-Host "  ERROR: Electron runtime not found at $exePath" -ForegroundColor Red
    exit 1
}

$skipPython = -not (Test-Path $pythonMain)
if ($skipPython) {
    Write-Host "  WARN: Python backend not found, will skip" -ForegroundColor Yellow
}

Write-Host "  Pre-checks passed" -ForegroundColor Green

# Step 1: clean old resources/app and leftover unpacked app dir
Write-Host "[1/6] Cleaning old resources/app..." -ForegroundColor Yellow
if (Test-Path $AppDir) {
    Remove-Item -Recurse -Force $AppDir
}
$oldUnpackedAppDir = Join-Path $FrontendDir "release\app"
if (Test-Path $oldUnpackedAppDir) {
    Remove-Item -Recurse -Force $oldUnpackedAppDir
    Write-Host "  Removed leftover release/app/" -ForegroundColor Green
}
New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
Write-Host "  Cleaned" -ForegroundColor Green

# Step 2: copy CRA build (drop stale artifacts / source maps)
Write-Host "[2/6] Copying build/..." -ForegroundColor Yellow
$buildSrc = Join-Path $FrontendDir "build"
$buildDst = Join-Path $AppDir "build"
if (Test-Path $buildDst) { Remove-Item -Recurse -Force $buildDst }
Copy-Item -Recurse -Force $buildSrc $buildDst

# 移除 source map / LICENSE / robots.txt
Get-ChildItem -Path $buildDst -Filter "*.map" -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path $buildDst -Filter "*.LICENSE.txt" -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue
if (Test-Path (Join-Path $buildDst "robots.txt")) { Remove-Item -Force (Join-Path $buildDst "robots.txt") }

# 清理 build/ 中过期的旧文件（按当前 asset-manifest.json 保留）
$amPath = Join-Path $buildDst "asset-manifest.json"
$keep = @{ }
$keep["index.html"] = $true
$keep["favicon.ico"] = $true
$keep["manifest.json"] = $true
$keep["logo192.png"] = $true
$keep["asset-manifest.json"] = $true
if (Test-Path $amPath) {
    $raw = Get-Content $amPath -Raw
    $raw | Select-String -Pattern '"\./([^"]+)"' -AllMatches | ForEach-Object {
        foreach ($m in $_.Matches) {
            $rel = $m.Groups[1].Value
            if ($rel) { $keep[$rel] = $true }
        }
    }
}
Get-ChildItem -Path $buildDst -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($buildDst.Length + 1)
    if (-not $keep.ContainsKey($rel)) {
        Write-Host "    removing stale: $rel" -ForegroundColor DarkGray
        Remove-Item -Force $_.FullName -ErrorAction SilentlyContinue
    }
}

$buildSize = (Get-ChildItem -Recurse $buildDst -File | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host "  build/ -> $([math]::Round($buildSize, 2)) MB" -ForegroundColor Green

# Step 3: copy Electron code
Write-Host "[3/6] Copying electron/..." -ForegroundColor Yellow
$electronSrc = Join-Path $FrontendDir "electron"
$electronDst = Join-Path $AppDir "electron"
Copy-Item -Recurse -Force $electronSrc $electronDst
# remove test files
Get-ChildItem -Path $electronDst -Filter "*.test.*" -Recurse | Remove-Item -Force
Get-ChildItem -Path $electronDst -Directory -Filter "__mocks__" -Recurse | Remove-Item -Recurse -Force
$electronSize = (Get-ChildItem -Recurse $electronDst | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host "  electron/ -> $([math]::Round($electronSize, 2)) MB" -ForegroundColor Green

# Step 4: copy assets
Write-Host "[4/6] Copying assets/..." -ForegroundColor Yellow
$assetsSrc = Join-Path $FrontendDir "assets"
$assetsDst = Join-Path $AppDir "assets"
Copy-Item -Recurse -Force $assetsSrc $assetsDst
Write-Host "  assets/ -> OK" -ForegroundColor Green

# Step 5: copy Python backend
if (-not $skipPython) {
    Write-Host "[5/6] Copying python-backend/..." -ForegroundColor Yellow
    $backendDir = Join-Path $AppDir "python-backend"
    $agentSrc = Join-Path $PythonSource "agent"
    $agentDst = Join-Path $backendDir "agent"

    # 复制前先清理源目录中的 __pycache__，避免把大量 .pyc 带进包
    Get-ChildItem -Path $agentSrc -Directory -Filter "__pycache__" -Recurse | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $agentSrc -Directory -Filter ".pytest_cache" -Recurse | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $agentSrc -Directory -Filter "tests" -Recurse | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

    Copy-Item -Recurse -Force $agentSrc $agentDst

    $pyprojectSrc = Join-Path $PythonSource "pyproject.toml"
    if (Test-Path $pyprojectSrc) {
        Copy-Item -Force $pyprojectSrc (Join-Path $backendDir "pyproject.toml")
    }

    # cleanup —— 二次确保无编译缓存/测试/开发文件
    Get-ChildItem -Path $backendDir -Directory -Filter "__pycache__" -Recurse | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $backendDir -Directory -Filter ".pytest_cache" -Recurse | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $backendDir -Directory -Filter "tests" -Recurse | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $backendDir -Directory -Filter "__mocks__" -Recurse | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    # 注意：agent/evaluation 会在引擎初始化时被懒加载，删除会触发非致命 warning，保留
    Get-ChildItem -Path $backendDir -Directory -Filter "persona" -Recurse | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $backendDir -Filter ".coverage" -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $backendDir -Filter "nul" -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $backendDir -Filter "*.pyc" -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $backendDir -Filter "*.pyo" -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $backendDir -Filter "*.log" -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $backendDir -Filter "*.md" -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $backendDir -Filter ".git*" -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $backendDir -Filter ".DS_Store" -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $backendDir -Filter "Thumbs.db" -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $backendDir -Filter ".gitignore" -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $backendDir -Filter "poetry.lock" -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $backendDir -Filter "requirements*.txt" -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $backendDir -Filter "setup.py" -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $backendDir -Filter "tox.ini" -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $backendDir -Filter "pytest.ini" -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue

    $backendSize = (Get-ChildItem -Recurse $backendDir | Measure-Object -Property Length -Sum).Sum / 1MB
    Write-Host "  python-backend/ -> $([math]::Round($backendSize, 2)) MB" -ForegroundColor Green
} else {
    Write-Host "[5/6] Skipping Python backend" -ForegroundColor Yellow
    $backendSize = 0
}

# Step 5.5: copy .env for backend configuration
$envSrc = Join-Path $ProjectDir ".env"
if (Test-Path $envSrc) {
    Write-Host "[5.5/6] Copying .env..." -ForegroundColor Yellow
    Copy-Item -Force $envSrc (Join-Path $AppDir ".env")
    Write-Host "  .env -> OK" -ForegroundColor Green
} else {
    Write-Host "[5.5/6] WARN: .env not found at project root" -ForegroundColor Yellow
}

# Step 6: create package.json + verify stamp
Write-Host "[6/6] Creating package.json + verifying install-stamp..." -ForegroundColor Yellow

$pkgJson = @{
    name = "jiabaixing-desktop"
    version = "5.0.0"
    main = "electron/main.js"
    private = $true
    description = "Jiabaixing Desktop - Local-first AI Agent Engine"
} | ConvertTo-Json -Depth 3
Set-Content -Path (Join-Path $AppDir "package.json") -Value $pkgJson -Encoding UTF8

$stampPath = Join-Path $AppDir "electron\backend\install-stamp.json"
$installPs1 = Join-Path $AppDir "electron\backend\install.ps1"

if (Test-Path $stampPath) {
    Write-Host "  install-stamp.json -> OK" -ForegroundColor Green
} else {
    Write-Host "  WARN: install-stamp.json not found" -ForegroundColor Yellow
}

if (Test-Path $installPs1) {
    Write-Host "  install.ps1 -> OK" -ForegroundColor Green
} else {
    Write-Host "  WARN: install.ps1 not found" -ForegroundColor Yellow
}

# Step 7: asar pack（python-backend 保持 unpacked，否则 Python 无法读取文件）
Write-Host "[7/6] Packing app into app.asar..." -ForegroundColor Yellow
$resourcesDir = Split-Path $AppDir
$appAsar = Join-Path $resourcesDir "app.asar"
$appAsarUnpacked = Join-Path $resourcesDir "app.asar.unpacked"

# 移除旧文件
if (Test-Path $appAsar) { Remove-Item -Force $appAsar }
if (Test-Path $appAsarUnpacked) { Remove-Item -Recurse -Force $appAsarUnpacked }

# 打包整个 app，但把 python-backend 排除在 asar 外
$asarCmd = Join-Path $FrontendDir "node_modules\.bin\asar.cmd"
$asarArgs = @("pack", "$AppDir", "$appAsar", "--unpack-dir", "python-backend")
Write-Host "  asar cmd: $asarCmd" -ForegroundColor Gray
if ($asarCmd -and (Test-Path $asarCmd)) {
    Write-Host "  Using local asar" -ForegroundColor Gray
    $asarOutput = & $asarCmd $asarArgs 2>&1
    $asarExit = $LASTEXITCODE
} else {
    Write-Host "  Local asar not found, falling back to npx" -ForegroundColor Yellow
    $asarOutput = & npx asar $asarArgs 2>&1
    $asarExit = $LASTEXITCODE
}
if ($asarExit -ne 0) {
    Write-Host "  ERROR: asar pack failed (exit $asarExit)" -ForegroundColor Red
    if ($asarOutput) {
        Write-Host "  Output:" -ForegroundColor Red
        $asarOutput | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    }
    exit 1
}

# 删除原始 app 目录
Remove-Item -Recurse -Force $AppDir

$asarSize = (Get-Item $appAsar).Length / 1MB
$unpackedSize = 0
if (Test-Path $appAsarUnpacked) {
    $unpackedSize = (Get-ChildItem -Recurse $appAsarUnpacked | Measure-Object -Property Length -Sum).Sum / 1MB
}
Write-Host "  app.asar -> $([math]::Round($asarSize, 2)) MB" -ForegroundColor Green
Write-Host "  app.asar.unpacked -> $([math]::Round($unpackedSize, 2)) MB" -ForegroundColor Green

# Step 8: trim Electron locales (keep only en-US + zh-CN)
Write-Host "[8/6] Trimming Electron locales..." -ForegroundColor Yellow
$localesDir = Join-Path $ReleaseDir "locales"
$localeSavedMB = 0
if (Test-Path $localesDir) {
    $before = (Get-ChildItem -Path $localesDir -Filter "*.pak" | Measure-Object -Property Length -Sum).Sum / 1MB
    Get-ChildItem -Path $localesDir -Filter "*.pak" | Where-Object { $_.Name -notin @("en-US.pak", "zh-CN.pak") } | ForEach-Object {
        $localeSavedMB += $_.Length / 1MB
        Remove-Item -Force $_.FullName
    }
    $after = (Get-ChildItem -Path $localesDir -Filter "*.pak" | Measure-Object -Property Length -Sum).Sum / 1MB
    Write-Host "  kept en-US.pak + zh-CN.pak, saved $([math]::Round($localeSavedMB, 2)) MB" -ForegroundColor Green
}

# Step 9: trim Electron runtime bloat (safe for GPU-disabled desktop mode)
Write-Host "[9/6] Trimming Electron runtime bloat..." -ForegroundColor Yellow
$runtimeSavedMB = 0
$bloatFiles = @(
    "LICENSES.chromium.html",
    "debug.log",
    # WebGPU/DirectX shader compiler — not needed for a standard desktop GUI
    "dxcompiler.dll",
    "dxil.dll",
    # Vulkan loader — disabled via --disable-gpu, not needed
    "vulkan-1.dll",
    # ffmpeg media decoder — chat GUI does not play video/audio
    "ffmpeg.dll"
    # 保留 vk_swiftshader.dll / icd.json 作为无 GPU 时的软件渲染回退
)
foreach ($file in $bloatFiles) {
    $filePath = Join-Path $ReleaseDir $file
    if (Test-Path $filePath) {
        $runtimeSavedMB += (Get-Item $filePath).Length / 1MB
        Remove-Item -Force $filePath -ErrorAction SilentlyContinue
    }
}
Write-Host "  saved $([math]::Round($runtimeSavedMB, 2)) MB" -ForegroundColor Green

# Summary
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Pack Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green

$totalSize = $asarSize + $unpackedSize
$fullPkgSize = (Get-ChildItem -Recurse $ReleaseDir | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host ""
Write-Host "  Size breakdown:" -ForegroundColor White
Write-Host "    app.asar            $([math]::Round($asarSize, 2)) MB"
Write-Host "    app.asar.unpacked   $([math]::Round($unpackedSize, 2)) MB"
Write-Host "    locales saved       $([math]::Round($localeSavedMB, 2)) MB"
Write-Host "    runtime bloat saved $([math]::Round($runtimeSavedMB, 2)) MB"
Write-Host "    --------------------------"
Write-Host "    app total           $([math]::Round($totalSize, 2)) MB"
Write-Host "    full package        $([math]::Round($fullPkgSize, 2)) MB"
Write-Host ""
Write-Host "  Bootstrap flow:" -ForegroundColor White
Write-Host "    Desktop start -> read install-stamp.json"
Write-Host "    -> first run executes install.ps1"
Write-Host "    -> install Python 3.13 embeddable"
Write-Host "    -> start uvicorn backend"
Write-Host "    -> health check -> connect WebSocket"
Write-Host ""
Write-Host "  Executable:" -ForegroundColor Cyan
Write-Host "    $exePath"
Write-Host ""
