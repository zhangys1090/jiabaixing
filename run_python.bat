@echo off
chcp 65001 >nul 2>&1
:: Python 后端启动 helper — 被 startup.bat 调用，保持后台运行
"C:\zy\jiabaixing\.venv\Scripts\python.exe" -m uvicorn agent.main:app --host 127.0.0.1 --port 3112 >> "C:\zy\jiabaixing\.jiabaixing\python_backend.log" 2>&1
