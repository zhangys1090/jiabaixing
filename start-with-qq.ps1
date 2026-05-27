# Jiabaixing + QQ (Mirai) 启动脚本
# 使用方法: PowerShell 右键"以管理员身份运行"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Jiabaixing + QQ 机器人 启动脚本" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$MIRAI_DIR = "$env:USERPROFILE\MiraiConsole"
$JIABAIXING_DIR = "c:\zy\jiabaixing"
$MIRAI_JAR = "$MIRAI_DIR\mirai-console-wrapper.jar"

Write-Host "[1/3] 检查 Mirai Console..." -ForegroundColor Yellow

if (-not (Test-Path $MIRAI_JAR)) {
    Write-Host "[下载] Mirai Console 未找到，开始下载..." -ForegroundColor Yellow
    
    New-Item -ItemType Directory -Force -Path $MIRAI_DIR | Out-Null
    
    $loaderUrl = "https://github.com/iTXTech/mirai-console-loader/releases/download/v2.1.2/mcl-2.1.2.zip"
    $zipPath = "$env:TEMP\mcl.zip"
    
    try {
        Invoke-WebRequest -Uri $loaderUrl -OutFile $zipPath -UseBasicParsing
        Expand-Archive -Path $zipPath -DestinationPath $MIRAI_DIR -Force
        Remove-Item $zipPath -Force
        Write-Host "[OK] Mirai Console 下载完成" -ForegroundColor Green
    } catch {
        Write-Host "[失败] 下载失败: $_" -ForegroundColor Red
        Write-Host "请手动下载: https://github.com/iTXTech/mirai-console-loader"
        exit 1
    }
}

Write-Host "[OK] Mirai Console 已安装" -ForegroundColor Green

Write-Host "[2/3] 检查 Java..." -ForegroundColor Yellow
try {
    $javaVer = java -version 2>&1
    Write-Host "[OK] Java 已安装" -ForegroundColor Green
} catch {
    Write-Host "[失败] 未找到 Java，请安装 Java 11+" -ForegroundColor Red
    Write-Host "下载地址: https://adoptium.net/"
    exit 1
}

Write-Host "[3/3] 启动服务..." -ForegroundColor Yellow

# 启动 Mirai
Write-Host "[启动] Mirai Console..." -ForegroundColor Cyan
$miraiProcess = Start-Process -WindowStyle Normal -FilePath "java" -ArgumentList "-jar", "mirai-console-wrapper.jar" -WorkingDirectory $MIRAI_DIR -NoNewWindow

Write-Host "[等待] Mirai 启动中..." -ForegroundColor Gray
Start-Sleep -Seconds 10

Write-Host "[启动] Jiabaixing 后端..." -ForegroundColor Cyan
Set-Location $JIABAIXING_DIR
$env:QQ_ENABLED = "true"
Start-Process -WindowStyle Normal -FilePath "cmd.exe" -ArgumentList "/c", "npm run start:backend"

Write-Host ""
Write-Host "================================" -ForegroundColor Cyan
Write-Host "  [OK] 启动完成！" -ForegroundColor Green
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "服务地址:"
Write-Host "  Jiabaixing: http://localhost:3001"
Write-Host "  Mirai:      http://localhost:8080"
Write-Host ""
Write-Host "Mirai 登录: 在 Mirai 窗口输入 → login 你的QQ号 密码"
Write-Host "前端界面:   浏览器打开 http://localhost:3000"
Write-Host ""
Write-Host "按 Enter 退出脚本..." -ForegroundColor Gray
$null = Read-Host
