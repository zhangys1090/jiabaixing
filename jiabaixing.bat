@echo off
chcp 65001 >nul
title Jiabaixing V5.0 - AI Agent
color 0A

echo.
echo   ========================================
echo     Jiabaixing V5.0 - AI Agent Framework
echo     One-Click Launcher
echo   ========================================
echo.

cd /d C:\zy\jiabaixing

:: check node
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   [FAIL] Node.js not found. Install Node.js ^>= 20.x
    pause
    exit /b 1
)
echo   [OK] Node.js

:: rebuild better-sqlite3 for Windows (WSL build won't work)
echo   [..] Checking native modules...
node -e "try{require('better-sqlite3')}catch(e){process.exit(1)}" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   [..] Rebuilding better-sqlite3 for Windows...
    call npx --yes node-gyp rebuild --directory=node_modules/better-sqlite3 >nul 2>&1
    if %ERRORLEVEL% neq 0 (
        call npm run fix:native >nul 2>&1
    )
    node -e "try{require('better-sqlite3')}catch(e){process.exit(1)}" >nul 2>&1
    if %ERRORLEVEL% neq 0 (
        echo   [WARN] better-sqlite3 failed, some features disabled
    ) else (
        echo   [OK] Native modules
    )
) else (
    echo   [OK] Native modules
)

:: ensure .env has valid API keys
echo   [..] Checking config...
node -e "require('dotenv').config();var keys=['XIAOMI_API_KEY','DEEPSEEK_API_KEY','OPENAI_API_KEY'];var found=keys.some(function(k){return process.env[k]&&process.env[k].length>5&&process.env[k].indexOf('***')<0});if(!found){process.exit(1)}" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   [WARN] No valid API key found
    echo   Starting config wizard...
    start cmd /c "cd /d C:\zy\jiabaixing && npx tsx --env-file=.env src/config/setup.ts && pause"
)

:: kill any existing node process on port 3111
echo   [..] Cleaning previous instances...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3111') do (
    if not "%%a"=="" taskkill /f /pid %%a >nul 2>&1
)

:: start Python Agent backend (V5.0 true backend, best-effort)
echo   [0/4] Starting Python Agent backend (port 3112)...
set "PYOK=0"
if exist "%~dp0.venv\Scripts\python.exe" (
    start /b "" cmd /c "cd /d %~dp0python && "%~dp0.venv\Scripts\python.exe" -m uvicorn agent.main:app --host 127.0.0.1 --port 3112 > "%~dp0logs\python_backend.log" 2>&1"
    for /l %%i in (1,1,40) do (
        >nul 2>&1 curl -s http://127.0.0.1:3112/health
        if not errorlevel 1 (
            set "PYOK=1"
            goto py_wait_done
        )
        timeout /t 1 /nobreak >nul
    )
)
:py_wait_done
if "%PYOK%"=="1" ( echo   [OK] Python Agent backend ready (3112) ) else ( echo   [WARN] Python backend not ready; TS gateway will fall back to local )

:: start backend
echo   [1/4] Starting backend...
start /b "" cmd /c "cd /d C:\zy\jiabaixing && npx tsx --env-file=.env src/main.ts"

:: wait for ready
echo   [2/3] Waiting for service (up to 60s)...
setlocal enabledelayedexpansion
for /l %%i in (1,1,60) do (
    >nul 2>&1 curl -s http://localhost:3111/api/health && (
        echo   [OK] Backend ready
        goto :ready
    )
    timeout /t 1 /nobreak >nul
)
echo   [FAIL] Backend timeout. Check logs at C:\zy\jiabaixing\logs\
pause
exit /b 1

:ready
endlocal

:: open browser
echo   [3/3] Opening browser...
start http://localhost:3111

echo.
echo   ========================================
echo     Jiabaixing V5.0 is running
echo   ========================================
echo     API:        http://localhost:3111
echo     Frontend:   http://localhost:3111/
echo   ========================================
echo.
echo   Press any key to stop...
pause >nul

:: cleanup
echo   Stopping...
taskkill /f /im node.exe >nul 2>&1
echo   Done.
