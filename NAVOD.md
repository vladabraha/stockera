# Návod

## Poprvé (jednou na počítači)
Ve složce projektu dvakrát klikni na:
- **Windows:** `instalace-windows.cmd`
- **Mac:** `instalace-mac.command` (když ho Mac nechce otevřít: pravé tlačítko → Otevřít)

Skript sám doinstaluje Node.js a pnpm, pokud chybí, a připraví projekt.
Když se Node.js nainstalovat nepodaří, stáhni ho z [nodejs.org](https://nodejs.org) (verze LTS) a skript spusť znovu.

## Aktualizace dat
1. V xStation exportuj **historii účtu** do XLSX (každý účet zvlášť).
2. Soubor ulož do složky `data/input/`.
3. Dvakrát klikni na `aktualizovat-windows.cmd` / `aktualizovat-mac.command`
   (nebo v terminálu spusť `pnpm update-data`).
4. Zadej heslo k reportu (aspoň 12 znaků, 2×).

## Prohlížení
- Otevři `out/stockera.html` v prohlížeči a zadej heslo.
- Na mobil soubor jen zkopíruj (AirDrop, kabel, cloud) a otevři ho tam. Funguje i offline.

## Když něco chybí
- Hláška „Neznámé složení“ nebo „Chybí historie cen“: doplň instrument do `data/instruments.json`
  (vzor je v `config/instruments.example.json`) a znovu spusť aktualizaci.

## Přenos na jiný počítač
Zkopíruj celou složku včetně `data/` a na novém počítači spusť instalační skript.
Zapomenuté heslo nevadí, nový report vytvoříš s novým heslem příkazem `pnpm report`.
