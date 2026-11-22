@echo off
chcp 65001 >nul
cd /d "%~dp0"
title HQ CRM（局域网共享版）
echo.
echo ============================================
echo    HQ CRM 系统正在启动...
echo ============================================
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 22 或更高版本。
  echo 下载地址: https://nodejs.org/
  pause
  exit /b 1
)
netstat -ano | findstr ":5000" | findstr "LISTEN" >nul 2>nul
if not errorlevel 1 (
  echo [提示] 系统已在运行，正在打开浏览器...
  start "" http://127.0.0.1:5000
  exit /b 0
)
node server.js
echo.
echo 服务已停止。
pause
