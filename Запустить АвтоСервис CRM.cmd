@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0" || exit /b 1
set "CRM_LAUNCH_MODE=%~1"

powershell.exe -NoLogo -NoProfile -NonInteractive -Command ^
  "$ErrorActionPreference = 'Stop'; $url = 'http://127.0.0.1:4178/';" ^
  "function Test-Crm { try { $page = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2; return ($page.Content -match 'id=.autoservice.'); } catch { return $false; } }" ^
  "try {" ^
  "  if (-not (Test-Crm)) {" ^
  "    $node = Get-Command node.exe -ErrorAction SilentlyContinue;" ^
  "    if (-not $node -or [int]((& $node.Source --version).Split('.')[0].TrimStart('v')) -lt 24) { throw 'Для запуска нужен Node.js 24 или новее в PATH.'; }" ^
  "    $logs = Join-Path (Get-Location) 'data'; New-Item -ItemType Directory -Force -Path $logs | Out-Null;" ^
  "    $err = Join-Path $logs 'server-error.log';" ^
  "    $server = Start-Process -FilePath $node.Source -ArgumentList 'server.mjs' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'server.log') -RedirectStandardError $err -PassThru;" ^
  "    $ready = $false; for ($i = 0; $i -lt 10; $i++) { if (Test-Crm) { $ready = $true; break }; if ($server.HasExited) { break }; Start-Sleep -Milliseconds 300 }" ^
  "    if (-not $ready) { throw ('Сервер не запустился. Подробности: ' + $err); }" ^
  "  }" ^
  "  Write-Host ('АвтоСервис CRM запущена: ' + $url);" ^
  "  if ($env:CRM_LAUNCH_MODE -ne '--no-browser') { Start-Process $url }" ^
  "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"

set "CRM_EXIT=%ERRORLEVEL%"
if not "%CRM_EXIT%"=="0" if /i not "%CRM_LAUNCH_MODE%"=="--no-browser" pause
popd
exit /b %CRM_EXIT%
