# Jiabaixing V5.0 一键部署脚本 - Windows PowerShell
# 用于在本地深度部署 Jiabaixing 系统

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Jiabaixing V5.0 本地深度部署脚本" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# 步骤1: 检查环境
Write-Host "[1/8] 检查环境..." -ForegroundColor Yellow

# 检查 Node.js
try {
    $nodeVersion = node --version
    Write-Host "  ✅ Node.js 版本: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "  ❌ Node.js 未安装或未在 PATH 中" -ForegroundColor Red
    Write-Host "  请先安装 Node.js (推荐 v20+): https://nodejs.org/" -ForegroundColor Yellow
    Read-Host "  按任意键退出"
    exit 1
}

# 检查 npm
try {
    $npmVersion = npm --version
    Write-Host "  ✅ npm 版本: $npmVersion" -ForegroundColor Green
} catch {
    Write-Host "  ❌ npm 不可用" -ForegroundColor Red
    Read-Host "  按任意键退出"
    exit 1
}

# 步骤2: 检查项目目录
Write-Host ""
Write-Host "[2/8] 检查项目目录..." -ForegroundColor Yellow
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $projectRoot
Write-Host "  项目根目录: $projectRoot" -ForegroundColor Gray

Set-Location $projectRoot

# 步骤3: 检查 .env 文件
Write-Host ""
Write-Host "[3/8] 检查环境配置..." -ForegroundColor Yellow
if (Test-Path ".env") {
    Write-Host "  ✅ .env 文件已存在" -ForegroundColor Green
} else {
    Write-Host "  ⚠️  .env 文件不存在，从 .env.example 创建" -ForegroundColor Yellow
    Copy-Item ".env.example" ".env"
    Write-Host "  ✅ 已创建 .env 文件，请在部署后配置 API Key" -ForegroundColor Green
}

# 步骤4: 安装依赖
Write-Host ""
Write-Host "[4/8] 安装项目依赖..." -ForegroundColor Yellow
Write-Host "  这可能需要几分钟时间，请耐心等待..." -ForegroundColor Gray

try {
    npm install
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✅ 后端依赖安装成功" -ForegroundColor Green
    } else {
        Write-Host "  ⚠️  依赖安装返回非零退出码，但可能已成功" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  ❌ 依赖安装失败" -ForegroundColor Red
}

# 步骤5: 安装前端依赖
Write-Host ""
Write-Host "[5/8] 安装前端依赖..." -ForegroundColor Yellow
if (Test-Path "src\frontend") {
    Set-Location "src\frontend"
    try {
        if (Test-Path "node_modules") {
            Write-Host "  前端依赖已存在，跳过安装" -ForegroundColor Gray
        } else {
            npm install
            Write-Host "  ✅ 前端依赖安装成功" -ForegroundColor Green
        }
    } catch {
        Write-Host "  ⚠️  前端依赖安装可能有问题" -ForegroundColor Yellow
    }
    Set-Location $projectRoot
}

# 步骤6: 创建数据目录
Write-Host ""
Write-Host "[6/8] 创建数据目录..." -ForegroundColor Yellow
$dirs = @("data", "data\eval", "data\eval\reports", "data\persistence", "data\memory", "data\evolution", "logs", "uploads")
foreach ($dir in $dirs) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Write-Host "  ✅ 创建目录: $dir" -ForegroundColor Green
    }
}

# 步骤7: 检查 better-sqlite3
Write-Host ""
Write-Host "[7/8] 检查原生模块..." -ForegroundColor Yellow
try {
    npm run fix:native 2>&1 | Out-Null
    Write-Host "  ✅ better-sqlite3 重建完成" -ForegroundColor Green
} catch {
    Write-Host "  ⚠️  better-sqlite3 重建可能有问题" -ForegroundColor Yellow
}

# 步骤8: 部署完成
Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  部署完成！" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步操作:" -ForegroundColor Yellow
Write-Host ""
Write-Host "1. 配置 .env 文件中的 API Key" -ForegroundColor White
Write-Host "   编辑 .env 文件，配置 DEEPSEEK_API_KEY" -ForegroundColor Gray
Write-Host ""
Write-Host "2. 启动完整系统:" -ForegroundColor White
Write-Host "   npm start" -ForegroundColor Cyan
Write-Host ""
Write-Host "3. 或分别启动:" -ForegroundColor White
Write-Host "   npm run start:backend  # 后端 (端口 3111)" -ForegroundColor Gray
Write-Host "   npm run start:frontend # 前端 (端口 3000)" -ForegroundColor Gray
Write-Host ""
Write-Host "4. 运行测试:" -ForegroundColor White
Write-Host "   npm test" -ForegroundColor Cyan
Write-Host "   npm run eval" -ForegroundColor Cyan
Write-Host ""
Write-Host "5. 访问系统:" -ForegroundColor White
Write-Host "   前端界面: http://localhost:3000" -ForegroundColor Cyan
Write-Host "   后端 API: http://localhost:3111" -ForegroundColor Cyan
Write-Host ""

# 询问是否立即启动
$startNow = Read-Host "是否现在启动系统? (y/n)"
if ($startNow -eq "y" -or $startNow -eq "Y") {
    Write-Host ""
    Write-Host "正在启动 Jiabaixing V5.0..." -ForegroundColor Green
    Write-Host "按 Ctrl+C 停止服务" -ForegroundColor Yellow
    Write-Host ""
    npm start
}
