@echo off
chcp 65001 >nul
echo ================================
echo  jiabaixing 一键重启
echo ================================

echo.
echo 正在查找并杀死旧后端...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3111"') do (
  if not "%%a"=="0" (
    taskkill /F /PID %%a >nul 2>&1 && echo [OK] 旧后端 PID %%a 已杀死
  )
)
timeout /t 3 /nobreak >nul

echo.
echo 启动后端 (port 3111)...
start "jiabaixing-backend" cmd /c "cd /d %~dp0 && npm run start:backend"

echo 等待后端就绪...
:wait
timeout /t 2 /nobreak >nul
curl -s http://localhost:3111/api/health >nul 2>&1
if errorlevel 1 goto wait

echo [OK] 后端已就绪

echo.
echo 启动前端 (port 3100)...
start "jiabaixing-frontend" cmd /c "cd /d %~dp0 && npm run start:frontend"

echo.
echo ================================
echo  全部启动完成！
echo  后端: http://localhost:3111
echo  前端: http://localhost:3100
echo ================================
