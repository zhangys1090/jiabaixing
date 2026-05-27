@echo off
chcp 65001 >nul
set MIRAI_DIR=%USERPROFILE%\MiraiConsole

echo ========================================
echo   Mirai QQ 机器人 - 快速启动
echo ========================================
echo.
echo [1/3] 检查文件...
echo.

if not exist "%MIRAI_DIR%" (
    echo ❌ 未找到 MiraiConsole 目录
    echo 请先完成这2步：
    echo   1. 浏览器打开: https://github.com/iTXTech/mcl-installer/releases
    echo   2. 下载 mcl-installer-*-windows-amd64.exe
    echo   3. 双击运行, 安装目录填: %MIRAI_DIR%
    echo.
    pause
    exit /b 1
)

cd /d "%MIRAI_DIR%"

echo ✅ MiraiConsole 目录已找到
echo.
echo [2/3] 更新/安装 mirai-api-http 插件...

if exist "mcl.cmd" (
    echo 运行 mcl --update-package ...
    call mcl.cmd --update-package net.mamoe:mirai-api-http --channel stable-v2 --type plugin
    echo.
    echo 运行 mcl --dry-run 下载...
    call mcl.cmd --dry-run
    echo ✅ 插件更新完成
) else if exist "mcl" (
    echo 运行 mcl ...
    call mcl --update-package net.mamoe:mirai-api-http --channel stable-v2 --type plugin
    call mcl --dry-run
    echo ✅ 插件更新完成
) else (
    echo ❌ 未找到 mcl 启动脚本, 请重新安装 MCL
    pause
    exit /b 1
)

echo.
echo [3/3] 检查配置...

set CONFIG_DIR=%MIRAI_DIR%\config\net.mamoe.mirai-api-http
if not exist "%CONFIG_DIR%" mkdir "%CONFIG_DIR%"

if exist "%CONFIG_DIR%\setting.yml" (
    echo ✅ setting.yml 已存在
) else (
    echo 正在创建 setting.yml...
    (
echo adapters:
echo   - http
echo debug: false
echo enableVerify: false
echo verifyKey: jiabaixing-qq-2024
echo singleMode: false
echo cacheSize: 4096
echo adapterSettings:
echo   http:
echo     host: localhost
echo     port: 8080
echo     cors:
echo       - "*"
echo.
    ) > "%CONFIG_DIR%\setting.yml"
    echo ✅ setting.yml 已创建
)

echo.
echo ========================================
echo   ✅ Mirai 初始化完成！
echo ========================================
echo.
echo 下一步启动 Mirai:
echo.
echo   在命令提示符输入:
echo   cd /d %MIRAI_DIR%
echo   mcl
echo.
echo   然后输入: login 你的QQ号 密码
echo   接着在手机QQ上确认登录
echo.
pause
