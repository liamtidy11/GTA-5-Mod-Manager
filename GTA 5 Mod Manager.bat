@echo off
cd /d "%~dp0"
title GTA 5 Mod Manager
if not exist "node_modules\" (
  echo Installing GTA 5 Mod Manager...
  call npm install
  if errorlevel 1 (
    echo npm install failed. Make sure Node.js is installed.
    pause
    exit /b 1
  )
)
npx electron .
