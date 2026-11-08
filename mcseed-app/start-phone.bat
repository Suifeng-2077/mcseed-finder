@echo off
chcp 65001 >nul
title MC Seed - 手机看板
cd /d "%~dp0"
echo ==============================================
echo   手机看板启动中...
echo   启动后本窗口会打印手机要打开的地址
echo   窗口最小化即可，不要关闭
echo ==============================================
echo.
node mcseed-app.js watch --poll 250 --retry 8 --retry-ms 200 --http 8790 --http-token 8888
echo.
echo 已停止。按任意键关闭。
pause >nul
