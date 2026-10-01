@echo off
title Harness Remote Setup
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0harness-setup.ps1" %*
exit /b %ERRORLEVEL%
