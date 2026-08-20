@echo off
REM PUPPET MODE — the stage, hand-driven. No brain, no chain, no trading,
REM nothing posts. Direct him yourself and film it for marketing.
cd /d C:\Users\nikos\quant
echo Building client (one time / after edits)...
call npm run build -w client
echo.
echo   control board : http://127.0.0.1:8492/puppet
echo   the shot      : http://127.0.0.1:8492/stage?auto=1
echo.
call npx tsx server/src/puppet-server.ts
pause
