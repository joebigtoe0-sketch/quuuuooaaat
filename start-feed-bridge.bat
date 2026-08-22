@echo off
REM Runs the residential poller for RIKU's caller-follow feed.
REM Put PUMP_COOKIE / RIKU_URL / ADMIN_KEY in tools\feed-bridge.env first.
cd /d "%~dp0"
:loop
node tools\feed-bridge.mjs
echo feed-bridge exited, restarting in 10s...
timeout /t 10 /nobreak >nul
goto loop
