@echo off
chcp 65001 >nul
set LOG=%TEMP%\crm_fw_result.txt
echo 正在为 HQ CRM 系统放行防火墙端口(5000)...
netsh advfirewall firewall delete rule name="CRM-5000" >nul 2>&1
netsh advfirewall firewall add rule name="CRM-5000" dir=in action=allow protocol=TCP localport=5000 profile=any
if %errorlevel%==0 (
  echo [OK] > "%LOG%"
  echo.
  echo ============================================
  echo    [成功] 防火墙已放行 5000 端口！
  echo.
  for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /i "IPv4"') do set IP=%%i
  echo    局域网访问地址： http://%IP%:5000
  echo ============================================
) else (
  echo [FAIL] > "%LOG%"
  echo.
  echo ============================================
  echo    [失败] 没有管理员权限，放行未生效。
  echo    请确认在弹出的“用户账户控制”窗口点了【是】。
  echo ============================================
)
echo.
pause