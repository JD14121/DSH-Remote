@echo off
title DSH-Remote
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0DSH-Remote.ps1" %*
exit /b %ERRORLEVEL%
