@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0DSH-Remote.ps1" %*
exit /b %ERRORLEVEL%
