@echo off
cd /d "%~dp0"
echo Installing dependencies...
call npm install
if errorlevel 1 (
  echo Failed to install dependencies. Make sure Node.js 20+ is installed.
  pause
  exit /b 1
)
echo Building Windows EXE installer...
call npm run build
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)
echo.
echo Done! Your .exe files are inside the "dist" folder.
explorer dist
pause
