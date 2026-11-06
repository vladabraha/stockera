# Návod

## Poprvé (jednou na počítači)
1. Nainstaluj [Node.js](https://nodejs.org) verze 24 nebo novější.
2. V terminálu (Windows: PowerShell) ve složce projektu spusť:
   ```
   npm install -g pnpm
   pnpm install
   ```

## Aktualizace dat
1. V xStation exportuj **historii účtu** do XLSX (každý účet zvlášť).
2. Soubor ulož do složky `data/input/`.
3. Spusť:
   ```
   pnpm update-data
   ```
4. Zadej heslo k reportu (aspoň 12 znaků, 2×).

## Prohlížení
- Otevři `out/stockera.html` v prohlížeči a zadej heslo.
- Na mobil soubor jen zkopíruj (AirDrop, kabel, cloud) a otevři ho tam. Funguje i offline.

## Když něco chybí
- Hláška „Neznámé složení“ nebo „Chybí historie cen“: doplň instrument do `data/instruments.json`
  (vzor je v `config/instruments.example.json`) a znovu spusť `pnpm update-data`.

## Přenos na jiný počítač
Zkopíruj celou složku včetně `data/` a na novém počítači spusť `pnpm install`.
Zapomenuté heslo nevadí, nový report vytvoříš s novým heslem příkazem `pnpm report`.
