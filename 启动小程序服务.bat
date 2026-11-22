@echo off
chcp 65001 >nul
title HQ CRM - 小程序API服务
cd /d %~dp0
echo 正在启动小程序API服务（端口 5100）...
node mp-api/server.js
pause
