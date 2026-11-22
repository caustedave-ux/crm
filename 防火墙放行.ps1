param([switch]$NoGui)
$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'crm_fw_result.txt'
& netsh advfirewall firewall delete rule name="CRM-5000" 2>$null | Out-Null
& netsh advfirewall firewall add rule name="CRM-5000" dir=in action=allow protocol=TCP localport=5000 profile=any | Out-Null
if ($LASTEXITCODE -eq 0) {
  Set-Content -LiteralPath $log -Value '[OK] CRM-5000 rule added' -Encoding UTF8
  $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1 -ExpandProperty IPAddress)
  Add-Content -LiteralPath $log -Value ("LAN: http://" + $ip + ":5000") -Encoding UTF8
  $msg = "防火墙已放行 5000 端口！`n`n局域网访问地址：`nhttp://${ip}:5000`n`n请用手机或另一台电脑打开上面的网址。"
} else {
  Set-Content -LiteralPath $log -Value '[FAIL] need admin' -Encoding UTF8
  $msg = "放行失败：没有管理员权限。`n`n请在弹窗中点击 是 按钮后再试一次。"
}
if (-not $NoGui) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($msg, 'HQ CRM 防火墙放行', 'OK', 'Information') | Out-Null
}