@echo off
rem Stockera - stahne novou verzi aplikace z GitHubu (git pull), doinstaluje nastroje a pregeneruje report.
rem Tvoje data (data\, out\) git ignoruje, takze zustanou beze zmeny.
chcp 65001 >nul
title Stockera - aktualizace aplikace
if "%~1"=="--z-kopie" goto :main
set "HERE=%~dp0"
set "HERE_FWD=%HERE:\=/%"
echo "%HERE_FWD%" | findstr /l /i /c:"/AppData/Local/Temp/" /c:".zip/" >nul
if not errorlevel 1 goto :zipped
rem cmd cte skript prubezne a git pull ho muze prepsat - proto bezi kopie z %TEMP%.
copy /y "%~f0" "%TEMP%\stockera-aktualizace-aplikace.cmd" >nul & call "%TEMP%\stockera-aktualizace-aplikace.cmd" --z-kopie "%~dp0" & exit /b

:main
set "HERE=%~2"
cd /d "%HERE%"
echo == Stockera: aktualizace aplikace ==
echo Stahne novou verzi programu. Tvoje vypisy, databaze ani report se nikam neposilaji ani nemazou.
echo.

where git >nul 2>nul
if errorlevel 1 goto :nogit
git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 goto :noclone
set "DIRTY="
for /f "delims=" %%i in ('git status --porcelain --untracked-files^=no') do set "DIRTY=1"
if defined DIRTY goto :dirty

for /f %%i in ('git rev-parse HEAD') do set "BEFORE=%%i"
echo [1/3] Stahuji novou verzi...
git pull --ff-only
if errorlevel 1 goto :pullfailed
for /f %%i in ('git rev-parse HEAD') do set "AFTER=%%i"
if "%BEFORE%"=="%AFTER%" goto :uptodate
echo       Novinky:
git --no-pager log --format="      - %%s" %BEFORE%..HEAD

echo [2/3] Doinstalovavam nastroje projektu...
where pnpm >nul 2>nul
if errorlevel 1 goto :nopnpm
call pnpm install --frozen-lockfile
if errorlevel 1 goto :installfailed

echo [3/3] Pregeneruji report novou verzi...
call "%HERE%aktualizovat-windows.cmd"
exit /b %errorlevel%

:uptodate
echo.
echo  Uz mas nejnovejsi verzi.
echo.
pause
exit /b 0

:nogit
echo.
echo  [CHYBA] Na tomto pocitaci chybi git.
echo.
echo  Co delat:
echo    1. Nainstaluj ho z https://git-scm.com (staci porad klikat Dalsi),
echo       nebo prikazem: winget install --id Git.Git -e
echo    2. Zavri toto okno a spust aktualizovat-aplikaci-windows.cmd znovu.
goto :fail

:noclone
echo.
echo  [CHYBA] Tato slozka neni stazena pres git (nejspis ze ZIPu).
echo.
echo  Co delat:
echo    1. Stahni aplikaci znovu prikazem git clone (viz NAVOD.md, cast Aktualizace aplikace).
echo    2. Do nove slozky presun svou slozku data (vypisy, databaze, nastaveni).
goto :fail

:dirty
git status --short --untracked-files=no
echo.
echo  [CHYBA] Soubory programu (vyse) jsou na tomto pocitaci upravene - aktualizace by je prepsala.
echo.
echo  Co delat:
echo    1. Pokud upravy nepotrebujes, vrat je prikazem: git checkout -- .
echo    2. Pak spust aktualizovat-aplikaci-windows.cmd znovu.
goto :fail

:pullfailed
echo.
echo  [CHYBA] Novou verzi se nepodarilo stahnout (podrobnosti vyse).
echo  Zkontroluj pripojeni k internetu a spust skript znovu.
goto :fail

:nopnpm
echo.
echo  [CHYBA] Chybi pnpm. Spust instalace-windows.cmd a pak tento skript znovu.
goto :fail

:installfailed
echo.
echo  [CHYBA] Instalace nastroju projektu selhala (podrobnosti vyse).
echo  Zkontroluj pripojeni k internetu a spust skript znovu.
goto :fail

:zipped
echo.
echo  [CHYBA] Slozka Stockera je jeste zabalena v ZIPu nebo v docasne slozce.
echo.
echo  Co delat:
echo    1. Klikni na ZIP pravym tlacitkem a zvol "Extrahovat vse...".
echo    2. Rozbal ho napr. do Dokumentu.
echo    3. Spust tento soubor znovu z rozbalene slozky.

:fail
echo.
pause
exit /b 1
