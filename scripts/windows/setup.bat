@echo off
REM ---------------------------------------------------------------------------
REM  AbidChatkhara POS — one-time setup.
REM  Run this ONCE after you first download the code, and again whenever you
REM  update it. It installs everything and builds the app so the till is
REM  ready to launch. Needs internet only for this step.
REM ---------------------------------------------------------------------------
title AbidChatkhara POS - setup
cd /d "%~dp0..\.."

echo Installing dependencies (this can take a few minutes)...
call npm.cmd install
if not %errorlevel%==0 goto fail

echo.
echo Building the app...
call npm.cmd run build
if not %errorlevel%==0 goto fail

echo.
echo ===========================================================
echo  Setup complete. Use "start-pos.vbs" to open the till.
echo ===========================================================
pause
exit /b 0

:fail
echo.
echo ===========================================================
echo  Setup FAILED. Copy the messages above and send them on.
echo ===========================================================
pause
exit /b 1
