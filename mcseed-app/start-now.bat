@echo off
chcp 65001 >nul
title MC Seed Now
cd /d "%~dp0"
node mcseed-app.js now
pause
