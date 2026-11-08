@echo off
chcp 65001 >nul
title MC Seed Next
cd /d "%~dp0"
node mcseed-app.js next
pause
