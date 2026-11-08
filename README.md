# Stockera

Lokální analýza portfolia z výpisů XTB. Data i výpočty zůstávají na tomto počítači – viz [zadání](docs/ZADANI.md), [architektura a fungování](docs/architektura.md) a [rozhodnutí](docs/ROZHODNUTI.md). **Krátký návod k použití: [NAVOD.md](NAVOD.md).**

## Požadavky
- Node.js ≥ 24 (vestavěné `node:sqlite`, `node:test`, spouštění TypeScriptu bez kompilace)
- pnpm (verze zafixovaná v `package.json` → `packageManager`)

## Použití
```bash
pnpm install          # jen vývojové nástroje (typescript, @types/node)
# vlož export historie účtu z xStation (XLSX) a/nebo z Trading 212 (CSV) do data/input/
pnpm ingest           # import do data/stockera.db (opakovatelné, bez duplicit)
pnpm market           # stažení kurzů ČNB, cen a složení ETF (jediný krok se sítí)
pnpm analyze          # výpočty → výpis do terminálu (--json uloží i NEŠIFROVANÝ out/analysis.json)
pnpm report           # zašifrovaný report out/stockera.html (zeptá se na heslo)
pnpm update-data      # průvodce: ingest → market → report, se srozumitelnými hláškami
```

### HTML report
`out/stockera.html` je jediný soubor, který funguje offline v jakémkoli moderním prohlížeči (i na mobilu – stačí ho
zkopírovat, např. AirDrop/kabel/USB). Obsahuje taby **Portfolio** (souhrn, vývoj hodnoty, rozložení podle instrumentů
a zemí, sektory, akcie uvnitř ETF sečtené přes všechna ETF, časový test, akordeon instrumentů → nákupy, graf ceny/hodnoty každého instrumentu) a **Prodané** (daňové roky s návodem, co vyplnit v daňovém přiznání a co přiložit, včetně CSV přehledu prodejů,
akordeon prodaných instrumentů → jednotlivé prodeje se ziskem v měně i v %). Přepínání Kč / € a světlého / tmavého vzhledu.

- Data v souboru jsou zašifrovaná (gzip → AES-256-GCM, klíč z hesla přes PBKDF2-SHA256, 600 000 iterací);
  dešifrují se až v prohlížeči po zadání hesla. Heslo se nikam neukládá, tlačítko *Zamknout* data zahodí z paměti.
- Content-Security-Policy povoluje jen vlastní vložený skript a styl a síť jen na `api.onvista.de` a `api.frankfurter.dev` (zálohy `www.tradegatebsx.com`, `data-api.ecb.europa.eu`):
  po odemknutí si report stáhne **aktuální ceny a kurzy** (odchází jen ISIN a kódy měn, nikdy počty kusů ani hodnoty)
  a hodnotu přepočítá v paměti. Bez internetu ukáže hodnoty z poslední aktualizace.
- Heslo: interaktivně (skryté zadání, 2×), nebo proměnnou `STOCKERA_PASSWORD`
  (macOS/Linux `STOCKERA_PASSWORD=… pnpm report`, PowerShell `$env:STOCKERA_PASSWORD='…'; pnpm report`).
  Heslo z proměnné může zůstat v historii příkazů – bezpečnější je interaktivní zadání.
- Zapomenuté heslo nevadí – report se dá kdykoli vygenerovat znovu z databáze s novým heslem.

Export z xStation: **Historie účtu → zvolit celé období → Export (XLSX)**, pro každý subúčet zvlášť.
Export z Trading 212: **Historie → Export (CSV)**, všechny typy záznamů; jeden soubor má max. 12 měsíců, takže celou
historii pokryj více soubory (překryvy nevadí). Data obou brokerů tvoří jedno portfolio – stejný ISIN = jedna pozice,
v detailu je vidět platforma každého nákupu.
Formát je popsán v [docs/xtb-format.md](docs/xtb-format.md), zdroje tržních dat v [docs/zdroje-dat.md](docs/zdroje-dat.md).

Ruční doplnění (ISIN, země akcie, sektor, složení ETF bez dat, zdroj cen): zkopíruj `config/instruments.example.json` do `data/instruments.json`.

## Přenos na jiný počítač (i Windows)
Vše potřebné je ve složce projektu; mimo ni jsou jen Node.js a pnpm.
1. Zkopíruj celou složku **včetně `data/`** (databáze, výpisy, ruční konfigurace; `out/` a `node_modules/` není potřeba).
2. Spusť `1-instalace-windows.cmd` / `1-instalace-mac.command`: doinstaluje Node.js ≥ 24 (winget / Homebrew),
   pnpm ve verzi z `packageManager` v `package.json` (`npm install -g`) a závislosti projektu. Ručně: Node.js z nodejs.org, `npm install -g pnpm@10.34.9`, `pnpm install`.
3. Report dvojklikem `2-vytvorit-report-windows.cmd` / `2-vytvorit-report-mac.command`, nebo libovolný příkaz výše.

## Nová verze aplikace
V gitu je jen program; osobní data (`data/`, `out/`, výpisy, databáze, logy) jsou v `.gitignore`. Ve složce stažené
přes `git clone` stačí dvojklik na `3-stahnout-novou-verzi-aplikace-windows.cmd` / `3-stahnout-novou-verzi-aplikace-mac.command`:
`git pull --ff-only` → povýšení pnpm, pokud se změnil `packageManager` → `pnpm install --frozen-lockfile` → přegenerování reportu. Databáze se na novou verzi převede
sama (migrace v `src/db/database.ts`).

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
| `src/t212/` | import CSV z Trading 212: parser, FIFO párování prodejů, přestavba účtů `T212-<měna>` |
| `src/xtb/` | parser exportu XTB → typovaná data; při změně formátu hlásí `XtbFormatError` |
| `src/db/` | SQLite schéma a migrace (`PRAGMA user_version`) |
| `src/net/` | jediný HTTP klient: allowlist domén, jen GET, audit log |
| `src/market/` | parsery zdrojů (ČNB, Xetra, justETF, onvista, Yahoo) a inkrementální aktualizace |
| `src/importer.ts` | idempotentní import do DB |
| `src/analysis/` | výpočty: kurzy (`fx`), časový test (`calendar`), loty, FIFO kontrola, portfolio a daně, ocenění, země, sektory, vývoj hodnoty (`market`) |
| `src/report/` | HTML report: šifrování (`crypto`), frontend (`app.ts`, `styles.css`, bez knihoven), sestavení (`build`) |
| `src/cli/` | příkazy (`pnpm ingest`, `pnpm market`, `pnpm analyze`, `pnpm report`, průvodce `update.ts`); hlášky a log chyb v `friendly.ts` |
| `tests/` | testy + generátor syntetických XLSX (`tests/helpers`) |
| `out/` | **výstupy – v .gitignore** (`stockera.html` zašifrovaně; `analysis.json` jen s `pnpm analyze --json`, nešifrovaně – po použití smazat) |
| `config/` | vzor ruční konfigurace instrumentů |
| `1-instalace-*`, `2-vytvorit-report-*`, `3-stahnout-novou-verzi-aplikace-*`, `scripts/` | dvojklikací skripty pro Windows (`.cmd` → `scripts/instalace.ps1`) a macOS (`.command`) – instalace, aktualizace dat, nová verze aplikace |
| `data/` | **osobní data – v .gitignore**: `input/` výpisy, `stockera.db` databáze, `instruments.json`, `logs/network.log` |

## Bezpečnost
- Žádné runtime závislosti; vývojové závislosti s přesnými verzemi.
- `pnpm-workspace.yaml`: zakázané install skripty závislostí, instalace jen verzí starších 3 dnů.
- Import ani výpočty nekomunikují po síti. Síť používá jen `pnpm market`, výhradně přes `src/net/http.ts`:
  - povolené servery: `www.cnb.cz`, `www.cashmarket.deutsche-boerse.com`, `www.justetf.com`, `query1/query2.finance.yahoo.com`, `api.onvista.de`, `www.pse.cz` (jiné, i při přesměrování, se zablokují),
  - posílá jen tickery, ISINy a data (ověřeno testem `tests/market.test.ts`), bez cookies,
  - každý požadavek se zapíše do `data/logs/network.log`,
  - ceny se stahují od 1. 12. roku před prvním nákupem pro všechny tickery stejně (z požadavků nejde vyčíst, kdy jsi co koupil),
  - odpovědi nad 20 MB se zahodí,
  - odpovědi s podezřelým obsahem (HTML/skripty, řídicí znaky, `__proto__`…) se zahodí a vypíše se varování (`src/net/inspect.ts`); totéž dělají živé ceny v reportu.
- `data/stockera.db` a `network.log` mají na macOS/Linuxu práva jen pro vlastníka (600); na Windows platí oprávnění uživatelského profilu.
- Nešifrovaný `out/analysis.json` vzniká jen na vyžádání (`pnpm analyze --json`); bez přepínače se starý smaže.
- Bezpečnostní revize (security review) celého projektu: žádná zneužitelná chyba; doporučená zpevnění výše jsou zapracovaná.

## Fáze
1. ✅ Import XLSX → SQLite, testy
2. ✅ Výpočty: FIFO kontrola párování, časový test, limit 100 000 Kč, dividendy, vklady/výběry (splity čekají na ukázku exportu)
3. ✅ Kurzy ČNB, ceny (justETF / Yahoo), ISIN (Xetra), složení ETF podle zemí, vývoj hodnoty – síťová vrstva s allowlistem a audit logem
4. ✅ Zašifrovaný jednosouborový HTML report (CZK/EUR, grafy, taby, akordeony), mobilní zobrazení
