@echo off
chcp 65001 >nul
title MC Seed - 停止
cd /d "%~dp0"
echo 正在停止手机看板...
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8790" ^| findstr "LISTENING"') do (
  taskkill /PID %%a /F >nul 2>&1
  set FOUND=1
)
del /q watch.lock 2>nul
if "%FOUND%"=="1" (
  echo 已停止。
) else (
  echo 没有正在运行的看板。
)
ping -n 3 127.0.0.1 >nul
