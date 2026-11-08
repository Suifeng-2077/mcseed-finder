@echo off
chcp 65001 >nul
title MC Seed Watch
cd /d "%~dp0"
node mcseed-app.js watch
pause
