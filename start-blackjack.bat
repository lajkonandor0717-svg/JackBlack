@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo A Node.js nincs telepitve, vagy nincs hozzaadva a PATH-hoz.
    pause
    exit /b 1
)

curl.exe --silent --fail --max-time 1 http://localhost:3000/ >nul 2>&1
if errorlevel 1 (
    start "Blackjack szerver" cmd /k "node server.js"
)

set /a tries=0
:wait_server
curl.exe --silent --fail --max-time 1 http://localhost:3000/ >nul 2>&1
if not errorlevel 1 goto open_app
set /a tries+=1
if %tries% GEQ 40 goto server_error
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Milliseconds 250"
goto wait_server

:open_app
start "" "http://localhost:3000"
exit /b 0

:server_error
echo Nem sikerult elinditani az alkalmazast 20 masodpercen belul.
pause
exit /b 1
