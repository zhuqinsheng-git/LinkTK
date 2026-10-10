@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title LinkTK

set "APP_URL=http://127.0.0.1:5173"

echo.
echo ========================================
echo   LinkTK Launcher
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found.
    echo Install Node.js 20 or later, then run this file again.
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm was not found.
    echo Reinstall Node.js with npm included, then run this file again.
    echo.
    pause
    exit /b 1
)

echo [INFO] Checking whether the service is already running...
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 5173); $c.Close(); exit 0 } catch { exit 1 }"
if not errorlevel 1 (
    echo [INFO] The service is already running.
    echo.
    echo   [1] Open the web page
    echo   [2] Stop the service
    echo   [0] Exit this window
    echo.
    choice /c 120 /n /m "Choose an option: "
    if errorlevel 3 exit /b 0
    if errorlevel 2 goto stop_existing
    start "" "%APP_URL%"
    echo.
    echo [INFO] The page has been opened. This launcher will close automatically.
    exit /b 0
)

if not exist "node_modules\" (
    echo [INFO] Installing dependencies. This is only needed the first time...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] Dependency installation failed.
        echo Check the network connection and npm configuration, then try again.
        echo.
        pause
        exit /b 1
    )
)

echo [INFO] Starting the development server...
echo [INFO] A separate server window will stay open.
echo [INFO] Press Ctrl+C in the server window. It will close automatically.
echo.

start "" /b powershell -NoProfile -WindowStyle Hidden -Command "$url = '%APP_URL%'; for ($i = 0; $i -lt 60; $i++) { try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 5173); $c.Close(); Start-Process $url; break } catch { Start-Sleep -Milliseconds 500 } }"

start "LinkTK Server" cmd /c "title LinkTK Server && echo Starting LinkTK... && node node_modules\vite\bin\vite.js --host 127.0.0.1"

echo.
echo [INFO] Server window started. This launcher will close automatically.
exit /b 0

:stop_existing
echo.
echo [INFO] Stopping the service on port 5173...
powershell -NoProfile -Command "$connection = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($connection) { Stop-Process -Id $connection.OwningProcess -Force; exit 0 }; exit 1"
if errorlevel 1 (
    echo [INFO] The service is no longer running.
) else (
    echo [INFO] The service has stopped.
)
echo.
exit /b 0
