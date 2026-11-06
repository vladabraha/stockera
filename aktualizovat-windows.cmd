@echo off
rem Stockera - nacte nove vypisy z data\input, stahne ceny a vytvori out\stockera.html.
cd /d "%~dp0"
call pnpm update-data
pause
