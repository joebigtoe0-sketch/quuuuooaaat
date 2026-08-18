@echo off
rem QUANT forever-loop: any exit (crash, /admin restart, memory reset) relaunches.
cd /d %~dp0server
:loop
echo [%date% %time%] starting QUANT... >> data\server.out.log
call npx tsx src/index.ts >> data\server.out.log 2>&1
echo [%date% %time%] QUANT exited — relaunching in 3s >> data\server.out.log
timeout /t 3 /nobreak > nul
goto loop
