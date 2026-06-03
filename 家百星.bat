@echo off
chcp 65001 >nul
title 家百星 · 御姐秘书 V5.0
color 0A

echo.
echo   ╔══════════════════════════════════════╗
echo   ║     家百星 · 御姐秘书  V5.0        ║
echo   ║     一键启动 · Harness Agent       ║
echo   ╚══════════════════════════════════════╝
echo.

cd /d C:\zy\jiabaixing

:: 检查 node
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   ❌ 未找到 Node.js，请先安装 Node.js ^>= 20.x
    pause
    exit /b 1
)

:: 检查 better-sqlite3
node -e "require('better-sqlite3')" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   ⚠️  better-sqlite3 需要重新编译...
    call npm run fix:native >nul 2>&1
    if %ERRORLEVEL% neq 0 (
        echo   ❌ 编译失败，请手动执行: npm run fix:native
        pause
        exit /b 1
    )
    echo   ✅ 编译完成
)

:: 检查配置
node -e "require('dotenv/config');process.exit(require('fs').existsSync('.env')?0:1)" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   ⚠️  未检测到配置，打开配置向导...
    start cmd /c "cd /d C:\zy\jiabaixing && npx tsx --env-file=.env src/config/setup.ts"
)

echo.
echo   [1/3] 正在启动后端服务...
start /b cmd /c "cd /d C:\zy\jiabaixing && npx tsx --env-file=.env src/main.ts" > nul 2>&1

echo   [2/3] 等待服务就绪...
setlocal enabledelayedexpansion
for /l %%i in (1,1,30) do (
    >nul 2>&1 curl -s http://localhost:3111/api/health && (
        echo   ✅ 后端就绪
        goto :ready
    )
    timeout /t 1 /nobreak >nul
)
echo   ⚠️  后端启动超时，请检查日志
pause
exit /b 1

:ready
endlocal

echo   [3/3] 正在打开浏览器...
start http://localhost:3111

echo.
echo   ┌────────────────────────────────────────────────────┐
echo   │ 家百星 · V5.0 Harness  已就绪                      │
echo   ├────────────────────────────────────────────────────┤
echo   │ API:        http://localhost:3111                  │
echo   │ 前端:       http://localhost:3111/                  │
echo   │ WebSocket:  ws://localhost:3111                    │
echo   └────────────────────────────────────────────────────┘
echo.
echo   按任意键停止服务...
pause >nul

:: 清理
echo   正在关闭服务...
taskkill /f /im node.exe >nul 2>&1
echo   ✅ 已关闭
