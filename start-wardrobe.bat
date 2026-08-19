@echo off
REM Standalone wardrobe — the dress-up tool ONLY, none of the show.
REM First run builds the client so /wardrobe.html exists; then boots the tiny server.
cd /d C:\Users\nikos\quant
echo Building client (one time / after edits)...
call npm run build -w client
echo Starting standalone wardrobe on http://127.0.0.1:8490/wardrobe
call npx tsx server/src/wardrobe-server.ts
pause
