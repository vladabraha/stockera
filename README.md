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
pnpm market           # stažení kurzů ČNB, cen a složení ETF (jediný krok se sítí)
pnpm analyze          # výpočty → výpis do terminálu + out/analysis.json
pnpm update-data      # vše najednou: ingest + market + analyze
```

Export z xStation: **Historie účtu → zvolit celé období → Export (XLSX)**, pro každý subúčet zvlášť.
Formát je popsán v [docs/xtb-format.md](docs/xtb-format.md), zdroje tržních dat v [docs/zdroje-dat.md](docs/zdroje-dat.md).

Ruční doplnění (ISIN, země akcie, složení ETF bez dat, zdroj cen): zkopíruj `config/instruments.example.json` do `data/instruments.json`.

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
| `src/net/` | jediný HTTP klient: allowlist domén, jen GET, audit log |
| `src/market/` | parsery zdrojů (ČNB, Xetra, justETF, Yahoo) a inkrementální aktualizace |
| `src/importer.ts` | idempotentní import do DB |
| `src/analysis/` | výpočty: kurzy (`fx`), časový test (`calendar`), loty, FIFO kontrola, portfolio a daně, ocenění, země, vývoj hodnoty (`market`) |
| `src/cli/` | příkazy (`pnpm ingest`, `pnpm market`, `pnpm analyze`) |
| `tests/` | testy + generátor syntetických XLSX (`tests/helpers`) |
| `out/` | **výstupy – v .gitignore** (`analysis.json`) |
| `config/` | vzor ruční konfigurace instrumentů |
| `data/` | **osobní data – v .gitignore**: `input/` výpisy, `stockera.db` databáze, `instruments.json`, `logs/network.log` |

## Bezpečnost
- Žádné runtime závislosti; vývojové závislosti s přesnými verzemi.
- `pnpm-workspace.yaml`: zakázané install skripty závislostí, instalace jen verzí starších 3 dnů.
- Import ani výpočty nekomunikují po síti. Síť používá jen `pnpm market`, výhradně přes `src/net/http.ts`:
  - povolené servery: `www.cnb.cz`, `www.cashmarket.deutsche-boerse.com`, `www.justetf.com`, `query1/query2.finance.yahoo.com` (jiné, i při přesměrování, se zablokují),
  - posílá jen tickery, ISINy a data (ověřeno testem `tests/market.test.ts`), bez cookies,
  - každý požadavek se zapíše do `data/logs/network.log`.

## Fáze
1. ✅ Import XLSX → SQLite, testy
2. ✅ Výpočty: FIFO kontrola párování, časový test, limit 100 000 Kč, dividendy, vklady/výběry (splity čekají na ukázku exportu)
3. ✅ Kurzy ČNB, ceny (justETF / Yahoo), ISIN (Xetra), složení ETF podle zemí, vývoj hodnoty – síťová vrstva s allowlistem a audit logem
4. Generátor jednosouborového HTML (CZK/EUR, grafy, taby, akordeony), mobilní zobrazení
