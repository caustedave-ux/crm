@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 外贸客户自动回复工作台
echo ============================================
echo   外贸客户自动回复工作台
echo   按 Ctrl+C 停止
echo ============================================
echo.
node worker.js
echo.
echo worker 已退出。
pause
