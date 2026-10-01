@echo off
title Harness Remote
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0harness-start.ps1" %*
exit /b %ERRORLEVEL%
