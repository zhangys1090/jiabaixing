<#
.SYNOPSIS
  Jiabaixing Desktop — Python 环境自动安装脚本
.DESCRIPTION
  检测并安装 Python 3.13 嵌入式环境到桌面端 resources/app/python/ 目录
  同时复制 Python 后端代码到 resources/app/python-backend/
  
  Hermes Bootstrap 流程：
  1. 读取 install-stamp.json 检查安装状态
  2. 下载 Python 3.13 embeddable package
  3. 安装 pip
  4. 安装依赖
  5. 复制后端代码
  6. 更新 install-stamp.json
#>

param(
    [string]$AppDir = "",
    [string]$PythonVersion = "3.13.5",
    [string]$PythonShortVersion = "3.13"
)

$ErrorActionPreference = "Stop"

if (-not $AppDir) {
    $AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    # 向上两级到 resources/app
    $AppDir = Split-Path -Parent (Split-Path -Parent $AppDir)
    $AppDir = Join-Path $AppDir "resources\app"
}

$PythonDir = Join-Path $AppDir "python"
$BackendDir = Join-Path $AppDir "python-backend"
$StampFile = Join-Path $AppDir "electron\backend\install-stamp.json"
$SourceBackendDir = Join-Path $AppDir "..\..\..\..\..\python"

Write-Host "=== Jiabaixing Bootstrap ===" -ForegroundColor Cyan
Write-Host "AppDir: $AppDir"
Write-Host "PythonDir: $PythonDir"
Write-Host "BackendDir: $BackendDir"

# Step 1: 检查 install-stamp
$stamp = $null
if (Test-Path $StampFile) {
    $stamp = Get-Content $StampFile -Raw | ConvertFrom-Json
    if ($stamp.installed -eq $true) {
        Write-Host "[Bootstrap] Python already installed, skipping" -ForegroundColor Green
        return
    }
}

# Step 2: 检查现有 Python
$pythonExe = Join-Path $PythonDir "python.exe"
if (Test-Path $pythonExe) {
    Write-Host "[Bootstrap] Python already exists at: $pythonExe" -ForegroundColor Green
} else {
    # Step 3: 下载 Python embeddable package
    $pythonUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
    $zipFile = Join-Path $env:TEMP "python-embed.zip"
    
    Write-Host "[Bootstrap] Downloading Python $PythonVersion embeddable package..." -ForegroundColor Yellow
    
    try {
        Invoke-WebRequest -Uri $pythonUrl -OutFile $zipFile -UseBasicParsing
        Write-Host "[Bootstrap] Download complete" -ForegroundColor Green
    } catch {
        Write-Host "[Bootstrap] Download failed: $_" -ForegroundColor Red
        Write-Host "[Bootstrap] Falling back to system Python" -ForegroundColor Yellow
        return
    }
    
    # Step 4: 解压
    Write-Host "[Bootstrap] Extracting Python to: $PythonDir" -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $PythonDir -Force | Out-Null
    Expand-Archive -Path $zipFile -DestinationPath $PythonDir -Force
    Remove-Item $zipFile -Force
    
    # Step 5: 安装 pip（修改 python313._pth 文件）
    $pthFile = Get-ChildItem $PythonDir -Filter "python$($PythonShortVersion.Replace('.',''))._pth" | Select-Object -First 1
    if ($pthFile) {
        $pthContent = Get-Content $pthFile.FullName -Raw
        # 取消 import site 的注释以启用 site-packages
        $pthContent = $pthContent -replace '#import site', 'import site'
        # 添加 Scripts 和 Lib/site-packages
        $pthContent = $pthContent.TrimEnd() + "`nScripts`nLib\site-packages`n.."
        Set-Content -Path $pthFile.FullName -Value $pthContent -NoNewline
    }
    
    # 下载 get-pip.py
    $getPipUrl = "https://bootstrap.pypa.io/get-pip.py"
    $getPipFile = Join-Path $PythonDir "get-pip.py"
    try {
        Invoke-WebRequest -Uri $getPipUrl -OutFile $getPipFile -UseBasicParsing
        & $pythonExe $getPipFile --no-warn-script-location
        Remove-Item $getPipFile -Force
        Write-Host "[Bootstrap] pip installed" -ForegroundColor Green
    } catch {
        Write-Host "[Bootstrap] pip installation failed: $_" -ForegroundColor Red
    }
    
    # Step 6: 安装 Python 依赖
    Write-Host "[Bootstrap] Installing Python dependencies..." -ForegroundColor Yellow
    $requirementsFile = Join-Path $BackendDir "requirements.txt"
    if (Test-Path $requirementsFile) {
        & $pythonExe -m pip install -r $requirementsFile --no-warn-script-location 2>&1
        Write-Host "[Bootstrap] Dependencies installed" -ForegroundColor Green
    } else {
        # 如果没有 requirements.txt，安装核心依赖
        $coreDeps = @("uvicorn", "fastapi", "litellm", "httpx", "pydantic")
        foreach ($dep in $coreDeps) {
            Write-Host "  Installing $dep..." -ForegroundColor Gray
            & $pythonExe -m pip install $dep --no-warn-script-location 2>$null
        }
        Write-Host "[Bootstrap] Core dependencies installed" -ForegroundColor Green
    }
}

# Step 7: 复制后端代码
if (-not (Test-Path $BackendDir)) {
    Write-Host "[Bootstrap] Copying backend code..." -ForegroundColor Yellow
    # 尝试从项目源码复制
    $possibleSources = @(
        (Join-Path $AppDir "..\..\..\..\..\python"),
        (Join-Path $AppDir "..\..\..\python"),
        "c:\zy\jiabaixing\python"
    )
    
    $sourceFound = $false
    foreach ($src in $possibleSources) {
        $resolved = if (Test-Path $src) { (Resolve-Path $src).Path } else { $null }
        if ($resolved -and (Test-Path (Join-Path $resolved "agent"))) {
            Write-Host "  Source: $resolved" -ForegroundColor Gray
            Copy-Item -Recurse -Force $resolved $BackendDir
            # 排除测试和缓存
            Get-ChildItem -Path $BackendDir -Directory -Filter "__pycache__" -Recurse | Remove-Item -Recurse -Force
            Get-ChildItem -Path $BackendDir -Directory -Filter "tests" -Recurse | Remove-Item -Recurse -Force
            Get-ChildItem -Path $BackendDir -Filter ".coverage" -Recurse | Remove-Item -Force
            $sourceFound = $true
            break
        }
    }
    
    if (-not $sourceFound) {
        Write-Host "[Bootstrap] Backend source not found, will run in offline mode" -ForegroundColor Red
    } else {
        Write-Host "[Bootstrap] Backend code copied" -ForegroundColor Green
    }
}

# Step 8: 更新 install-stamp
if (Test-Path $StampFile) {
    $stamp = Get-Content $StampFile -Raw | ConvertFrom-Json
    $stamp.installed = (Test-Path $pythonExe)
    $stamp.lastChecked = (Get-Date).ToString("o")
    $stamp | ConvertTo-Json -Depth 3 | Set-Content $StampFile -Encoding UTF8
    Write-Host "[Bootstrap] install-stamp.json updated" -ForegroundColor Green
}

Write-Host "=== Bootstrap Complete ===" -ForegroundColor Cyan
