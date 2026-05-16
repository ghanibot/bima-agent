@echo off
REM ──────────────────────────────────────────────────────────────
REM  Bima Agent — One-Click Launcher (Windows)
REM
REM  Double-click this file to start Bima as a background daemon.
REM  The admin panel opens automatically in your default browser.
REM  Close the browser anytime — Bima keeps running.
REM
REM  To stop:  run "stop-bima.bat" or "node src\cli.js daemon stop"
REM ──────────────────────────────────────────────────────────────

setlocal

cd /d "%~dp0\.."

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║          BIMA AGENT - One-Click Launcher             ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

REM Check Node.js available
where node >nul 2>&1
if errorlevel 1 (
  echo  [ERROR] Node.js tidak terinstall.
  echo  Download dari: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

REM Start daemon
node src\cli.js daemon start

echo.
echo  Bima berjalan di background. Tutup window ini aman.
echo  Untuk stop: jalankan stop-bima.bat
echo.
timeout /t 5 /nobreak >nul
endlocal
