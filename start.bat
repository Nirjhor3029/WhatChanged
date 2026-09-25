@echo off
title DB Checker
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22.13+ is required: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Installing database drivers ^(first run only^)...
  call npm install --omit=dev --no-fund --no-audit || (pause & exit /b 1)
)
node server.js --open
pause
