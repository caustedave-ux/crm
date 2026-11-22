@echo off
chcp 936 >nul
title HQ CRM - 重启系统
cd /d D:\外贸CRM
echo ============================================
echo    正在重启 HQ CRM 系统...
echo ============================================
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5000" ^| findstr "LISTENING"') do taskkill /f /pid %%p >nul 2>&1
timeout /t 1 >nul
powershell -NoProfile -Command "Start-Process -FilePath node -ArgumentList 'server.js' -WorkingDirectory 'D:\外贸CRM' -WindowStyle Hidden -RedirectStandardOutput 'D:\外贸CRM\server.log' -RedirectStandardError 'D:\外贸CRM\server.err.log'"
timeout /t 3 >nul
start "" http://127.0.0.1:5000
echo.
echo 重启完成，浏览器已打开。
timeout /t 3 >nul
exit