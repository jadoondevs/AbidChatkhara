@echo off
REM ---------------------------------------------------------------------------
REM  AbidChatkhara POS — visible launcher (for first run / troubleshooting).
REM  Does the same as start-pos.vbs but shows a window and the server log,
REM  so you can see any error. For everyday use, prefer start-pos.vbs.
REM ---------------------------------------------------------------------------
title AbidChatkhara POS
cd /d "%~dp0..\.."

REM Is the server already up? (node is guaranteed present since npm works.)
node -e "require('http').get('http://localhost:4000',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>nul
if %errorlevel%==0 (
  echo POS server is already running.
  goto open
)

echo Starting the POS server in the background...
start "AbidChatkhara POS server" /min cmd /c "npm.cmd start > pos-server.log 2>&1"

echo Waiting for the server to be ready...
:wait
timeout /t 1 >nul
node -e "require('http').get('http://localhost:4000',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>nul
if not %errorlevel%==0 goto wait

:open
echo Opening the till...
start "" http://localhost:4000
exit /b 0
