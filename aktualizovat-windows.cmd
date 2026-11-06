@echo off
rem Stockera - nacte vypisy z data\input, stahne ceny a vytvori out\stockera.html.
chcp 65001 >nul
title Stockera - aktualizace
set "HERE=%~dp0"
set "HERE_FWD=%HERE:\=/%"
echo "%HERE_FWD%" | findstr /l /i /c:"/AppData/Local/Temp/" /c:".zip/" >nul
if not errorlevel 1 goto :zipped
cd /d "%HERE%"

where node >nul 2>nul
if errorlevel 1 goto :nonode
node -e "process.exit(+process.versions.node.split('.')[0]>=24?0:1)"
if errorlevel 1 goto :nonode

node --disable-warning=ExperimentalWarning src\cli\update.ts
if errorlevel 1 goto :failed

echo.
echo  Oteviram report v prohlizeci...
start "" "%HERE%out\stockera.html"
echo.
pause
exit /b 0

:failed
echo.
echo  Aktualizace se nedokoncila - co udelat, je vypsane vyse.
if exist "data\logs\chyby.log" echo  Technicke podrobnosti pro pripadnou pomoc: data\logs\chyby.log
echo.
pause
exit /b 1

:nonode
echo.
echo  [CHYBA] Na tomto pocitaci chybi Node.js 24 nebo novejsi.
echo.
echo  Co delat:
echo    1. Spust nejdriv instalace-windows.cmd (dvojklikem).
echo    2. Pak zavri toto okno a spust aktualizovat-windows.cmd znovu.
echo.
pause
exit /b 1

:zipped
echo.
echo  [CHYBA] Slozka Stockera je jeste zabalena v ZIPu nebo v docasne slozce.
echo.
echo  Co delat:
echo    1. Klikni na ZIP pravym tlacitkem a zvol "Extrahovat vse...".
echo    2. Rozbal ho napr. do Dokumentu.
echo    3. Spust tento soubor znovu z rozbalene slozky.
echo.
pause
exit /b 1
