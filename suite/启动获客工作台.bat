@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 获客工作台 - Lead Suite
echo.
echo ============================================
echo    获客工作台正在启动...
echo ============================================
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)
netstat -ano | findstr ":5101" | findstr "LISTEN" >nul 2>nul
if not errorlevel 1 (
  echo [提示] 系统已在运行，正在打开浏览器...
  start "" http://127.0.0.1:5101
  exit /b 0
)
start "" http://127.0.0.1:5101
node server.js
echo.
echo 服务已停止。
pause
