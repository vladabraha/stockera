@echo off
rem Stockera - stahne novou verzi aplikace z GitHubu (git pull), doinstaluje nastroje a pregeneruje report.
rem Tvoje data (data\, out\) git ignoruje, takze zustanou beze zmeny.
chcp 65001 >nul
title Stockera - stazeni nove verze aplikace
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
echo == Stockera: stazeni nove verze aplikace ==
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
echo [1/2] Stahuji novou verzi...
git pull --ff-only
if errorlevel 1 goto :pullfailed
for /f %%i in ('git rev-parse HEAD') do set "AFTER=%%i"
if "%BEFORE%"=="%AFTER%" goto :uptodate
echo       Novinky:
git --no-pager log --format="      - %%s" %BEFORE%..HEAD

echo [2/2] Doinstalovavam nastroje projektu...
where pnpm >nul 2>nul
if errorlevel 1 goto :nopnpm
rem Bez prepinani verzi: jinak by pnpm sam stahoval jinou verzi mimo slozku projektu.
for /f "delims=" %%v in ('node -p "require('./package.json').packageManager.split('@')[1]"') do set "PNPMV=%%v"
set "PNPMCUR="
set "npm_config_manage_package_manager_versions=false"
for /f "delims=" %%v in ('pnpm --version 2^>nul') do set "PNPMCUR=%%v"
set "npm_config_manage_package_manager_versions="
if "%PNPMCUR%"=="%PNPMV%" goto :pnpmok
echo       Povysuji pnpm na %PNPMV%...
call npm install -g "pnpm@%PNPMV%"
if errorlevel 1 goto :installfailed
:pnpmok
call pnpm install --frozen-lockfile
if errorlevel 1 goto :installfailed

echo.
echo  Nova verze aplikace je nainstalovana.
set "HASINPUT="
if exist "data\input\*.xlsx" set "HASINPUT=1"
if exist "data\input\*.csv" set "HASINPUT=1"
if not defined HASINPUT goto :noinput
echo.
echo == Pregenerovani reportu novou verzi ==
call "%HERE%2-vytvorit-report-windows.cmd"
exit /b %errorlevel%

:noinput
echo.
echo  Dalsi krok: uloz vypisy z XTB (XLSX) nebo Trading 212 (CSV) do slozky data\input
echo  a spust 2-vytvorit-report-windows.cmd.
echo.
pause
exit /b 0

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
echo    2. Zavri toto okno a spust 3-stahnout-novou-verzi-aplikace-windows.cmd znovu.
goto :fail

:noclone
echo.
echo  [CHYBA] Tato slozka neni stazena pres git (nejspis ze ZIPu).
echo.
echo  Co delat:
echo    1. Stahni aplikaci znovu prikazem git clone (viz NAVOD.md, cast 4. Nova verze aplikace).
echo    2. Do nove slozky presun svou slozku data (vypisy, databaze, nastaveni).
goto :fail

:dirty
git status --short --untracked-files=no
echo.
echo  [CHYBA] Soubory programu (vyse) jsou na tomto pocitaci upravene - nova verze by je prepsala.
echo.
echo  Co delat:
echo    1. Pokud upravy nepotrebujes, vrat je prikazem: git checkout -- .
echo    2. Pak spust 3-stahnout-novou-verzi-aplikace-windows.cmd znovu.
goto :fail

:pullfailed
echo.
echo  [CHYBA] Novou verzi se nepodarilo stahnout (podrobnosti vyse).
echo  Zkontroluj pripojeni k internetu a spust skript znovu.
goto :fail

:nopnpm
echo.
echo  [CHYBA] Chybi pnpm. Spust 1-instalace-windows.cmd a pak tento skript znovu.
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
