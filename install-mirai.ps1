# Mirai Console + QQ Setup
# Usage: .\install-mirai.ps1

$MIRAI_DIR = "$env:USERPROFILE\MiraiConsole"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Mirai Console Setup Wizard" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Java check
Write-Host "[1/4] Checking Java..." -ForegroundColor Yellow
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
try {
    $v = java -version 2>&1 | Select-Object -First 1
    Write-Host "  OK: $v" -ForegroundColor Green
} catch {
    Write-Host "  ERROR: Java not found!" -ForegroundColor Red
    Write-Host "  Download: https://adoptium.net (JDK 17, x64 MSI)"
    Read-Host "Press Enter to exit"
    exit 1
}

# Step 2: Check MCL
Write-Host "[2/4] Checking Mirai Console Loader..." -ForegroundColor Yellow
$MCL_CMD = "$MIRAI_DIR\mcl.cmd"

if (Test-Path $MCL_CMD) {
    Write-Host "  OK: MCL already installed" -ForegroundColor Green
} else {
    Write-Host "  MCL not found. Opening download page..." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  === MANUAL STEP REQUIRED ===" -ForegroundColor Cyan
    Write-Host "  1. Download mcl-installer-*-windows-amd64.exe"
    Write-Host "  2. Run it, install to: $MIRAI_DIR"
    Write-Host "  3. Come back and press Enter"
    Write-Host ""
    Start-Process "https://github.com/iTXTech/mcl-installer/releases"
    Read-Host "  Done? Press Enter to continue"
    
    if (-not (Test-Path $MCL_CMD)) {
        Write-Host "  ERROR: Still not found at $MIRAI_DIR" -ForegroundColor Red
        Write-Host "  Make sure you installed to the correct folder."
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "  OK: MCL detected" -ForegroundColor Green
}

# Step 3: Install mirai-api-http plugin
Write-Host "[3/4] Installing mirai-api-http plugin..." -ForegroundColor Yellow
Set-Location $MIRAI_DIR
cmd /c "mcl.cmd --update-package net.mamoe:mirai-api-http --channel stable-v2 --type plugin 2>&1"
cmd /c "mcl.cmd --dry-run 2>&1"

# Generate random verifyKey
$verifyKey = "jiabaixing-qq-" + (Get-Random -Minimum 1000 -Maximum 9999)

$CONFIG_DIR = "$MIRAI_DIR\config\net.mamoe.mirai-api-http"
New-Item -ItemType Directory -Force -Path $CONFIG_DIR | Out-Null

$SETTING_FILE = "$CONFIG_DIR\setting.yml"
if (-not (Test-Path $SETTING_FILE)) {
    @"
adapters:
  - http
debug: false
enableVerify: false
verifyKey: $verifyKey
singleMode: false
cacheSize: 4096
adapterSettings:
  http:
    host: localhost
    port: 8080
    cors:
      - "*"
"@ -replace "`r`n", "`n" | Out-File -FilePath $SETTING_FILE -Encoding utf8 -NoNewline
    Write-Host "  OK: setting.yml created" -ForegroundColor Green
} else {
    Write-Host "  OK: setting.yml exists" -ForegroundColor Green
    $content = Get-Content $SETTING_FILE -Raw -Encoding UTF8
    if ($content -match 'verifyKey:\s*"?(.+?)"?\s*$') {
        $verifyKey = $matches[1]
    }
}

Write-Host "  verifyKey = $verifyKey" -ForegroundColor Cyan

# Step 4: Update Jiabaixing .env
Write-Host "[4/4] Updating Jiabaixing config..." -ForegroundColor Yellow
$ENV_FILE = "c:\zy\jiabaixing\.env"
$lines = Get-Content $ENV_FILE -Encoding UTF8
$newLines = @()
$foundQQ = $false
foreach ($line in $lines) {
    if ($line -match "^QQ_ENABLED=") {
        $newLines += "QQ_ENABLED=true"
        $foundQQ = $true
    } elseif ($line -match "^MIRAI_VERIFY_KEY=") {
        $newLines += "MIRAI_VERIFY_KEY=$verifyKey"
    } elseif ($line -match "^QQ_ACCOUNT=") {
        $newLines += $line
    } else {
        $newLines += $line
    }
}
if (-not $foundQQ) {
    $newLines += ""
    $newLines += "QQ_ENABLED=true"
    $newLines += "MIRAI_VERIFY_KEY=$verifyKey"
    $newLines += "MIRAI_HTTP_HOST=localhost"
    $newLines += "MIRAI_HTTP_PORT=8080"
    $newLines += "QQ_ACCOUNT=your_qq_number"
}
$newLines -join "`n" | Out-File -FilePath $ENV_FILE -Encoding UTF8
Write-Host "  OK: .env updated (QQ_ENABLED=true)" -ForegroundColor Green

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  SETUP COMPLETE!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host ""
Write-Host "  1. Start Mirai:" -ForegroundColor Cyan
Write-Host "     cd /d $MIRAI_DIR"
Write-Host "     mcl"
Write-Host ""
Write-Host "  2. Login QQ in Mirai console:" -ForegroundColor Yellow
Write-Host "     login YOUR_QQ_NUMBER YOUR_PASSWORD"
Write-Host "     (Accept login on your phone QQ)"
Write-Host ""
Write-Host "  3. Edit .env, set QQ_ACCOUNT=YOUR_QQ_NUMBER" -ForegroundColor Yellow
Write-Host ""
Write-Host "  4. Start Jiabaixing:" -ForegroundColor Cyan
Write-Host "     cd c:\zy\jiabaixing"
Write-Host "     npm start"
Write-Host ""
Read-Host "Press Enter to exit"
