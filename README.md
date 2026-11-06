# Stockera

Lokální analýza portfolia z výpisů XTB. Data i výpočty zůstávají na tomto počítači – viz [zadání](docs/ZADANI.md).

## Požadavky
- Node.js ≥ 24 (vestavěné `node:sqlite`, `node:test`, spouštění TypeScriptu bez kompilace)
- pnpm (verze zafixovaná v `package.json` → `packageManager`)

## Použití
```bash
pnpm install          # jen vývojové nástroje (typescript, @types/node)
# vlož export historie účtu z xStation (XLSX) do data/input/
pnpm ingest           # import do data/stockera.db (opakovatelné, bez duplicit)
pnpm analyze          # výpočty → výpis do terminálu + out/analysis.json
```

Export z xStation: **Historie účtu → zvolit celé období → Export (XLSX)**, pro každý subúčet zvlášť.
Formát je popsán v [docs/xtb-format.md](docs/xtb-format.md).

## Vývoj
```bash
pnpm test         # testy (node:test, pouze syntetická data)
pnpm typecheck    # kontrola typů
pnpm check        # obojí
pnpm audit        # kontrola zranitelností závislostí
```

## Struktura
| Cesta | Obsah |
|---|---|
| `src/xlsx/` | vlastní čtečka XLSX (ZIP + XML), bez externích knihoven |
| `src/xtb/` | parser exportu XTB → typovaná data; při změně formátu hlásí `XtbFormatError` |
| `src/db/` | SQLite schéma a migrace (`PRAGMA user_version`) |
| `src/importer.ts` | idempotentní import do DB |
| `src/analysis/` | výpočty: kurzy (`fx`), časový test (`calendar`), loty, FIFO kontrola, portfolio a daně |
| `src/cli/` | příkazy (`pnpm ingest`, `pnpm analyze`) |
| `tests/` | testy + generátor syntetických XLSX (`tests/helpers`) |
| `out/` | **výstupy – v .gitignore** (`analysis.json`) |
| `data/` | **osobní data – v .gitignore**: `input/` výpisy, `stockera.db` databáze |

## Bezpečnost
- Žádné runtime závislosti; vývojové závislosti s přesnými verzemi.
- `pnpm-workspace.yaml`: zakázané install skripty závislostí, instalace jen verzí starších 3 dnů.
- Import ani výpočty nekomunikují po síti.

## Fáze
1. ✅ Import XLSX → SQLite, testy
2. ✅ Výpočty: FIFO kontrola párování, časový test, limit 100 000 Kč, dividendy, vklady/výběry (splity čekají na ukázku exportu)
3. Ceny (Yahoo), kurzy ČNB, metadata a složení ETF (síťová vrstva s allowlistem a audit logem)
4. Generátor jednosouborového HTML (CZK/EUR, grafy, taby, akordeony), mobilní zobrazení
