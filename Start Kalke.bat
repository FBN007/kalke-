@echo off
title Kalke - FPV route planner
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kalke-server.ps1"
if errorlevel 1 (
  echo.
  echo The local server could not start, so Kalke opens straight from the file instead.
  echo Everything works except "Go to my location".
  start "" "%~dp0index.html"
  echo.
  pause
)
