@echo off
setlocal
if exist "%~dp0Paper Timeline.exe" goto packaged
if exist "%~dp0release\win-unpacked\Paper Timeline.exe" goto project
node "%~dp0ai\cli.cjs" %*
exit /b %errorlevel%

:packaged
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0Paper Timeline.exe" "%~dp0ai\cli.cjs" %*
exit /b %errorlevel%

:project
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0release\win-unpacked\Paper Timeline.exe" "%~dp0ai\cli.cjs" %*
exit /b %errorlevel%
