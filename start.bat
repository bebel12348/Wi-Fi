@echo off
title WiFi Monitor Bridge
color 0A
echo.
echo  ============================================
echo   WiFi Monitor - Local SSH Bridge
echo  ============================================
echo.

:: Cek apakah node ada
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    color 0C
    echo  [ERROR] Node.js tidak ditemukan!
    echo  Download di: https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Install dependencies jika belum ada
if not exist "node_modules" (
    echo  [INFO] Install dependencies...
    call npm install
    echo.
)

echo  [OK] Memulai bridge di http://localhost:3000
echo  [OK] Buka dashboard dan hubungkan ke bridge ini
echo.
node bridge.js
pause
