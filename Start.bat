@echo off
cd /d "%~dp0"
node scripts\run.cjs start
if errorlevel 1 pause
