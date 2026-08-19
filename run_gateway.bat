@echo off
chcp 65001 >nul 2>&1
:: TS 网关启动 helper — 被 startup.bat 调用
cd /d "C:\zy\jiabaixing"
npm run cli daemon start >> "C:\zy\jiabaixing\.jiabaixing\daemon_auto.log" 2>&1
