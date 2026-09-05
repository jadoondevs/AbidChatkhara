@echo off
REM ---------------------------------------------------------------------------
REM  AbidChatkhara POS — stop the background server.
REM  You normally do NOT need this: closing the till window leaves the server
REM  running (so nothing is lost), and shutting the PC down stops it anyway.
REM  Use this only if you want to stop the server without a reboot.
REM ---------------------------------------------------------------------------
title AbidChatkhara POS - stop
echo Stopping the POS server on port 4000...
set "found="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4000" ^| findstr "LISTENING"') do (
  taskkill /PID %%p /F >nul 2>&1
  set "found=1"
)
if defined found (echo Stopped.) else (echo Nothing was running on port 4000.)
timeout /t 2 >nul
