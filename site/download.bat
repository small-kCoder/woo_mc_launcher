@echo off
setlocal
chcp 65001 >nul
title WOO 我的世界启动器 一键下载
cd /d "%~dp0"

set "P1=https://gitee.com/small-kCoding/woo_mc_launcher/releases/download/v1.2.3/WOO-MC-Launcher-1.2.3-win-x64-part1.zip"
set "P2=https://gitee.com/small-kCoding/woo_mc_launcher/releases/download/v1.2.3/WOO-MC-Launcher-1.2.3-win-x64-part2.zip"
set "OUT=WOO-MC-Launcher-1.2.3"

echo.
echo  WOO 我的世界启动器 v1.2.3
echo  即将下载两个分卷并自动解压到当前目录。
echo.
pause

echo 正在下载分卷 1/2 ...
curl.exe -L --fail --retry 3 --progress-bar -o "%TEMP%\woo-part1.zip" "%P1%"
if errorlevel 1 goto fail
echo 正在下载分卷 2/2 ...
curl.exe -L --fail --retry 3 --progress-bar -o "%TEMP%\woo-part2.zip" "%P2%"
if errorlevel 1 goto fail

echo 正在解压到 "%cd%\%OUT%" ...
if not exist "%OUT%" mkdir "%OUT%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath \"$env:TEMP\woo-part1.zip\" -DestinationPath \"%cd%\%OUT%\" -Force; Expand-Archive -LiteralPath \"$env:TEMP\woo-part2.zip\" -DestinationPath \"%cd%\%OUT%\" -Force"
if errorlevel 1 goto fail

del "%TEMP%\woo-part1.zip" "%TEMP%\woo-part2.zip" >nul 2>nul
echo.
echo  完成：%cd%\%OUT%
echo  正在打开目录...
start "" "%cd%\%OUT%"
pause
exit /b 0

:fail
echo.
echo  下载或解压失败，请检查网络后重新运行本文件。
pause
exit /b 1
