@echo off
REM Stop Bima daemon (Windows)
setlocal
cd /d "%~dp0\.."

echo.
echo  Menghentikan Bima daemon...
echo.

node src\cli.js daemon stop

echo.
pause
endlocal
