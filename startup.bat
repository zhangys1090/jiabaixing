@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

:: 家百星 V5.0 — Task Scheduler 自启包装器
:: 静默启动 Python 后端 + TS 网关，日志写到 .jiabaixing/

set "ROOT=%~dp0"
set "PY_LOG=%ROOT%.jiabaixing\autostart.log"
set "PID_FILE=%ROOT%.jiabaixing\python_auto.pid"

echo [%date% %time%] 家百星自动启动 >> "%PY_LOG%"

:: 1. 启动 Python 后端
cd /d "%ROOT%python"
set "PYTHON=%ROOT%.venv\Scripts\python.exe"
if exist "%PYTHON%" (
    echo [%date% %time%] 启动 Python 后端... >> "%PY_LOG%"
    :: S4U 兼容：用 start 启动独立窗口进程
    start /b "" cmd /c ""%ROOT%run_python.bat""
)

:: 等待 Python 就绪（最多 120s）
echo [%date% %time%] 等待 Python 后端就绪... >> "%PY_LOG%"
for /l %%i in (1,1,120) do (
    >nul 2>&1 curl -s http://127.0.0.1:3112/health
    if not errorlevel 1 (
        echo [%date% %time%] Python 后端就绪 (%%is) >> "%PY_LOG%"
        goto :py_ready
    )
    >nul ping -n 2 127.0.0.1
)
echo [%date% %time%] Python 后端启动超时 >> "%PY_LOG%"

:py_ready

:: 2. 启动 TS 网关
cd /d "%ROOT%"
echo [%date% %time%] 启动 TS 网关... >> "%PY_LOG%"
start /b "" cmd /c ""%ROOT%run_gateway.bat""

:: 等待网关就绪（最多 30s）
for /l %%i in (1,1,30) do (
    >nul 2>&1 curl -s http://127.0.0.1:3111/api/health
    if not errorlevel 1 (
        echo [%date% %time%] TS 网关就绪 (%%is) >> "%PY_LOG%"
        goto :gw_ready
    )
    >nul ping -n 2 127.0.0.1
)
echo [%date% %time%] TS 网关启动超时 >> "%PY_LOG%"

:gw_ready
echo [%date% %time%] 家百星启动完成 >> "%PY_LOG%"
exit /b 0
