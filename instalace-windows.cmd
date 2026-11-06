@echo off
rem Stockera - priprava (Node.js, pnpm, zavislosti). Staci spustit dvojklikem.
title Stockera - instalace
set "HERE=%~dp0"
set "HERE_FWD=%HERE:\=/%"
echo "%HERE_FWD%" | findstr /l /i /c:"/AppData/Local/Temp/" /c:".zip/" >nul
if not errorlevel 1 goto :zipped
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%scripts\instalace.ps1"
if errorlevel 1 goto :failed
pause
exit /b 0

:failed
echo.
echo  Instalace se nedokoncila - duvod a postup jsou vypsane vyse.
echo  Kdyz si nevis rady, nainstaluj Node.js (verze LTS) rucne z https://nodejs.org
echo  a spust instalace-windows.cmd znovu.
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
