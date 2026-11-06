# Rozhodnutí (pro další úpravy – lidské i AI)

Záznam všech architektonických, bezpečnostních a výpočetních rozhodnutí včetně důvodů. Před úpravou si přečti
celý soubor; když rozhodnutí měníš, uprav ho tady (a v `README.md` / `docs/ZADANI.md`).
Související: `docs/ZADANI.md` (zadání), `docs/xtb-format.md` (formát exportu), `docs/zdroje-dat.md` (zdroje dat).

## 0. Nepřekročitelná pravidla od uživatele

1. **Osobní data nesmí opustit počítač.** Ven smí jen ticker / ISIN / datum k veřejným API. Nikdy množství, ceny,
   hodnoty, čísla účtů, jméno.
2. **Zpracování bez AI** – deterministický kód, opakovatelný příkazem `pnpm update-data`.
3. **Vše uvnitř složky projektu.** Nic neinstalovat globálně, neměnit nastavení systému, nemazat nic mimo projekt.
   Když něco nejde, říct to uživateli (ne obcházet).
4. **Přenositelnost na Windows** – složku jde zkopírovat na Windows (Node ≥ 24 + pnpm + `pnpm install`) a funguje.
   Žádné bash-only skripty v `package.json`, žádné systémové aplikace (např. Chrome z `/Applications`) jako závislost.
5. **Moderní nástroje, nejnovější verze, žádné zranitelnosti** (`pnpm audit` musí být čistý), minimum závislostí.
6. **Vše dokumentované a otestované** ve složce projektu.
7. AI při vývoji smí číst jen **anonymizované / smyšlené** výpisy (`data/input/fake data.xlsx`). Skutečná data AI nečte.
8. Uživatel komunikuje česky; UI, výpisy CLI a dokumentace jsou česky, komentáře v kódu anglicky.

## 1. Technologie a nástroje

| Rozhodnutí | Důvod |
|---|---|
| Node.js ≥ 24, TypeScript spouštěný **nativně** (type stripping), bez build kroku | žádný bundler/transpiler, méně závislostí |
| Jen *erasable* TS syntaxe (žádné `enum`, parameter properties, namespaces), importy s příponou `.ts` | vyžaduje to nativní type stripping (`erasableSyntaxOnly`, `allowImportingTsExtensions`) |
| `tsc --noEmit` jen pro typecheck (typescript 7), `@types/node` | jediné devDependencies |
| **Nula runtime závislostí** | menší útočná plocha (supply chain), nic k auditu |
| `node:sqlite` (vestavěné) místo better-sqlite3 apod. | bez nativních modulů → funguje i na Windows bez kompilace |
| `node:test` místo Jest/Vitest | vestavěné |
| Vlastní ZIP/XLSX čtečka (`src/xlsx`) | knihovny pro XLSX mají historii zranitelností a jsou velké |
| pnpm 10.18.1 (`packageManager`) | pnpm 12 se přes `packageManager` nepodařilo stáhnout (ENOEXEC); uživatel zakázal zásahy mimo projekt (corepack apod.) |
| `pnpm-workspace.yaml`: `ignoreScripts: true`, `minimumReleaseAge: 4320`, `saveExact: true` | ochrana dodavatelského řetězce: žádné install skripty, jen verze starší 3 dnů, přesné verze |
| Skript se jmenuje `ingest`, ne `import` | `pnpm import` je vestavěný příkaz pnpm |
| `--disable-warning=ExperimentalWarning` ve skriptech | `node:sqlite` hlásí experimentální warning |

Quirky `node:sqlite`: řádky mají null prototype (před `deepEqual` spread), `.all()` občas potřebuje `as unknown as T[]`,
SQL řetězce v jednoduchých uvozovkách.

### Instalační a spouštěcí skripty
- `instalace-windows.cmd` (→ `scripts/instalace.ps1`) a `instalace-mac.command` jsou výjimka z pravidla „nic mimo
  složku“: na výslovné přání uživatele doinstalují Node.js (winget `OpenJS.NodeJS.LTS` / Homebrew) a pnpm
  (`npm install -g pnpm@10.18.1` – přesná verze kvůli `packageManager`). Bez winget/brew jen odkážou na nodejs.org.
- `aktualizovat-*.cmd/.command` spouští `pnpm update-data`; `.cmd` obchází blokaci `pnpm.ps1` execution policy
  v PowerShellu (nic v systému se nemění, `-ExecutionPolicy Bypass` platí jen pro daný proces).
- `.cmd` soubory jen ASCII + CRLF (kódová stránka cmd), `.ps1` UTF-8 **s BOM** + CRLF (jinak PowerShell 5.1 rozbije
  diakritiku), `.command` LF + spustitelný bit; hlídá `.gitattributes`. PowerShell skript nebyl spuštěn na Windows
  (vývoj probíhal na macOS) – při první chybě opravit.

## 2. Vstup (XTB)

- Hlavní zdroj = **export historie účtu z xStation (XLSX)**, každý subúčet (EUR, CZK) zvlášť. Listy
  `Closed Positions`, `Cash Operations`, `Open Positions`. Detaily v `docs/xtb-format.md`.
- Daňový výpis (Fiscal Report) se **nepoužívá** – je souhrnný, bez lotů; importer ho rozpozná a přeskočí.
- PDF se nepodporuje (uživatel původně zmínil PDF, XLSX je strojově spolehlivější).
- Data v exportu jsou Excel serial v UTC; hlavičky se hledají case-insensitive (liší se mezi listy).
- Měna účtu je jen v souhrnném řádku `Open Positions`.
- Řádky `Total` / `Profit/loss` se kontrolují proti součtům → varování při nesouladu.
- Neznámé typy cash operací se uloží a vypíše se varování (klasifikace regexem: `divid`, `withholding`, `withdraw`,
  `fee|commission|swap|rollover`). Skutečné názvy dividend/srážkové daně/výběrů/splitů zatím **nemáme ověřené** (není vzorek).

## 3. Databáze a import

- `data/stockera.db` (SQLite, WAL, foreign keys), migrace přes `PRAGMA user_version` v `src/db/database.ts`
  (1: účty, instrumenty, importy, cash ops, loty; 2: `fx_rates`; 3: `instrument_meta`, `prices`, `country_weights`).
  **Nové změny schématu = nová migrace na konec pole, nikdy neupravovat existující.**
- Import je **idempotentní**: soubor podle sha256 se přeskočí; cash ops `ON CONFLICT DO NOTHING` (unikátní `ID`);
  uzavřené loty mají klíč (účet, position_id, close_time, volume) – Position ID není unikátní kvůli částečným uzavřením.
- Snapshot otevřených pozic se pro účet nahradí jen novějším `as_of`.
- Konflikt měny účtu → výjimka a rollback.
- DB a `network.log` dostávají práva 600 (macOS/Linux); na Windows no-op.
- `data/` a `out/` jsou v `.gitignore` a **nikdy se necommitují**.

## 4. Výpočty (daně CZ) – `src/analysis`

Pravidla ověřená k 18. 9. 2026 (taxfolio.cz). Není to daňové poradenství – v UI je disclaimer.

- **Párování prodejů:** zdrojem pravdy je **párování z XTB** (Position ID). **FIFO** se počítá jen jako kontrola
  (per účet + ticker) a rozdíly se hlásí. Prodejní událost = uzavřené loty do 5 s; sell cash op se páruje v okně 60 s + stejné množství.
- **Časový test:** posuzuje se **po lotech**, > 3 roky. První den bez daně = 3. výročí nákupu + 1 den
  (29. 2. → 28. 2. + 1 den). Kalendářní data v **Europe/Prague**, v DB UTC.
- **Limit 100 000 Kč:** z **hrubých příjmů z prodejů** za rok (ne ze zisku), vše-nebo-nic. **Konzervativně se
  započítávají všechny prodeje včetně těch s časovým testem** (výklad nejistý – raději přísněji).
- Strop 40 mil. Kč pro osvobození časovým testem platí **jen pro rok 2025** (`TIME_TEST_CAP_YEARS`).
- Ztráty se v rámci roku započítají proti ziskům, základ ≥ 0, ztráty se nepřevádí.
- **Kurzy:** denní kurz ČNB ke dni obchodu (nákup kurzem dne nákupu, prodej kurzem dne prodeje); víkend/svátek
  = poslední fixing max. 7 dní zpět. EUR = CZK / kurz EUR (nebo nativně u EUR účtu).
- **Model peněz:** `Money {native, currency, czk|null, eur|null}`, `Totals` s mapou `native` podle měn.
  `null` se propaguje, když chybí kurz → UI ukáže nativní měnu, nic se nevymýšlí.
- **Zdroj nákupní ceny / výnosu** (fake export má prohozené sloupce Purchase/Sale Value): cash operace →
  sloupce XTB → cena × objem. Otevřené loty: cash op → value − gross_profit → objem × open price.
- Ocenění držby: tržní cena, pokud je novější než snapshot XTB; jinak hodnota ze snapshotu. Lot bez ceny = nákupní cena.
- Vývoj hodnoty: denně hodnota vs. investováno v CZK i EUR; dny bez kurzu se vynechají.
- Neúplná historie (první cash op je později než nejstarší lot) → varování.
- Splity: **neimplementováno** (chybí vzorek exportu).

## 5. Tržní data a síť – `src/net`, `src/market`

- **Veškerá síť jen přes `src/net/http.ts`** (jinde `fetch` nepoužívat!). GET, jen HTTPS, výchozí port, bez
  přihlašovacích údajů, `credentials: 'omit'`, ruční přesměrování s kontrolou každého skoku (max 5), timeout 60 s,
  throttle 400 ms/host, **limit odpovědi 20 MB**, audit každého požadavku (i zablokovaného) do `data/logs/network.log`.
- **Allowlist** (`ALLOWED_HOSTS`): `www.cnb.cz`, `www.cashmarket.deutsche-boerse.com`, `www.justetf.com`,
  `query1/query2.finance.yahoo.com`. Nový zdroj = přidat sem + test + `docs/zdroje-dat.md`.
- Síť používá **jen `pnpm market`**. Import, výpočty i report jsou offline.
- Zdroje (podrobně `docs/zdroje-dat.md`):
  - kurzy: ČNB roční txt (minulé roky se znovu nestahují, pokud mají kurz z 20.–31. 12.),
  - ticker → ISIN: CSV všech instrumentů Xetra (jen pro `.DE`),
  - ETF: justETF profil (země: top země + „Ostatní“ = `XX`; obnova po 30 dnech) a justETF chart API (denní ceny EUR),
  - akcie: Yahoo chart v8 (z této IP často 429 → varování, ne pád). Mapování `.UK`→`.L`, `.NL`→`.AS`, `.US`→bez přípony; GBp ÷ 100.
  - Země akcie: prefix ISIN, jinak země burzy. Kód `GB`, ne `UK`.
- **Zamítnuto:** Stooq (vyžaduje JS), OpenFIGI (nevrací ISIN), vyhledávání Börse Frankfurt/Euronext (prázdné),
  „proxy ETF“ přes podobné ETF z justETF (nespolehlivé) → místo toho ruční doplnění.
- Ruční přepisy: `data/instruments.json` (vzor `config/instruments.example.json`, klíče začínající `$` se ignorují):
  `isin`, `countries`/`country`, `priceSource` (`justetf`|`yahoo`|`none`), `yahooSymbol`.
  Swapové/aktivní ETF (LEER, DEGT) nemají na justETF země → `??` = „Neznámé složení“, doplnit ručně.
- **Ceny se stahují od společného hrubého data** (1. 12. roku před prvním nákupem) pro všechny tickery, aby
  z požadavků nešlo vyčíst, kdy byl který instrument koupen. Dál inkrementálně od posledního data − 7 dní.
- Selhání zdroje = varování, nikdy pád celého běhu.

## 6. Report – `src/report`

- **Jeden samostatný HTML soubor** `out/stockera.html` – funguje offline, i na mobilu (přenos ručně: AirDrop/USB).
  Žádný server, žádná PWA, žádný hosting.
- **Vždy zašifrovaný heslem** (rozhodnutí uživatele): gzip → AES-256-GCM (IV 12 B), klíč PBKDF2-SHA256
  **600 000 iterací**, sůl 16 B; nová sůl i IV při každém sestavení. Dešifruje se v prohlížeči (WebCrypto +
  `DecompressionStream`). Heslo se nikam neukládá; *Zamknout* zahodí data z paměti.
  Testy používají 1000 iterací (`buildReport(a, pw, { iterations })`).
- Heslo: interaktivně (skryté, 2×, raw mode – funguje i ve Windows Terminal/PowerShell/cmd), nebo
  `STOCKERA_PASSWORD` (varování o historii příkazů, proměnná se po přečtení smaže). **Min. 12 znaků.**
- **CSP** v `<meta>`: `default-src 'none'`, `script-src`/`style-src` jen **sha256 hash** vložených bloků,
  `img-src`/`connect-src`/`form-action`/`base-uri` `'none'` → stránka nemůže nic odeslat.
  Důsledky pro kód frontendu:
  - **žádné `style="…"` atributy v markupu** (CSP je blokuje) – barvy/šířky jen přes CSSOM (`el.style.setProperty`, helper `paint()`),
  - SVG barvy přes `var()` nastavovat přes `style`, ne prezentační atributy,
  - žádné externí fonty, obrázky, knihovny; žádné inline `on*=` handlery,
  - data vkládat jen přes `textContent`/`append`/`setAttribute` (nikdy `innerHTML` s daty), nevytvářet odkazy.
- Frontend je psaný v TS (`app.ts` + sdílený `crypto.ts`), `build.ts` ho převede `stripTypeScriptTypes`, odstraní
  **jednořádkové** `import … from '…'` a prefixy `export`, zabalí do IIFE. Víceřádkové importy → build selže (záměrně).
  Ve frontendu tedy jen typové importy + `crypto.ts`; nic dalšího importovat nejde.
- Payload je v `<script type="application/json" id="payload">` (jen base64 + JSON).
- Testy (`tests/report.test.ts`) hlídají: round-trip šifrování, nepřítomnost plaintextu (tickery, účty), shodu CSP
  hashů, jediné URL v HTML je SVG namespace, žádné `style=`/`on*=`/`<link>`/`<img>`/`<iframe>`, přesně 2 `<script>`.
- Nešifrovaný `out/analysis.json` vzniká **jen** s `pnpm analyze --json` (práva 600); bez přepínače se starý smaže.
  `update-data` = `ingest → market → report` (bez analyze).

### UI / design
- Dva taby: **Portfolio** (hodnota + graf vývoje s rozsahy 1M–Vše, souhrnné statistiky, donut podle instrumentů,
  sloupce podle zemí, „Brzy bez daně“, akordeon instrumentů → nákupy s časovým testem; „Zobrazit graf“ přepne hlavní
  graf na cenu/hodnotu instrumentu s body nákupů/prodejů) a **Prodané** (realizovaný zisk, daně podle let s limitem
  100 tis., akordeon prodaných instrumentů → jednotlivé prodeje se ziskem v měně i %). Přepínač Kč / €.
- Vědomě **ne „typický AI dashboard“**: teplé neutrální pozadí (#f4f2ed), tlumená zelenomodrá akcentní barva
  (#127a6b), vlastní paleta tickerů (ne Tableau), barevné „avatary“ tickerů, segmentové přepínače, bez barevných
  levých okrajů karet a gradientů. Systémové fonty (CSP blokuje webfonty), tabulkové číslice.
- Světlý i tmavý režim podle `prefers-color-scheme` (CSS proměnné v `styles.css`).
- Responzivita: < 860 px jeden sloupec, < 640 px statistiky 2×, taby na celou šířku, **tabulky → karty**
  (`td[data-label]` + `td::before`). Každá buňka tabulky musí mít `data-label`.
- Vlastní SVG grafy bez knihoven. Výkon: decimace na ~2 body/px, hover přes `requestAnimationFrame`, binární
  hledání bodu, min/max cyklem (ne spread – velká pole). Změřeno na 40 instrumentech × 10 let při 4× zpomaleném
  CPU: odemčení ~270 ms, interakce < 80 ms, ~2,3k DOM uzlů.

## 7. Bezpečnostní revize (11/2026)

Revize celého projektu nenašla zneužitelnou chybu (allowlist, XSS, CSP, krypto, SQL – vše parametrizované,
ZIP – názvy jen jako klíče v paměti). Zapracovaná zpevnění: `analysis.json` jen na vyžádání, heslo ≥ 12 znaků
+ varování u env, společné datum začátku cen, limit 20 MB odpovědi, kontrola importů při buildu, práva 600.
Vědomě neřešeno: zip bomb (jen DoS vlastního počítače vlastním souborem), prototype pollution v
`data/instruments.json` (vlastní lokální konfigurace).

## 8. Ověřování a testy

- `pnpm check` (typecheck + testy) a `pnpm audit` musí projít před každým commitem.
- Testy jsou offline: syntetické XLSX (`tests/helpers/xlsxBuilder.ts`, `fakeXtb.ts`), `fakeFetch` místo sítě,
  in-memory DB. Testy nesmí volat skutečné API ani číst `data/`.
- Vizuální kontrola reportu probíhala jednorázově headless Chrome (CDP) **mimo projekt, se svolením uživatele**;
  není to součást projektu ani závislost. Nepřidávat Playwright/Puppeteer bez souhlasu.
- Commity obsahují trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

## 9. Otevřené body

- Splity, skutečné názvy dividend / srážkové daně / výběrů (čeká se na anonymizovaný vzorek).
- Export CZK subúčtu (čeká se na uživatele).
- Ruční doplnění zemí pro LEER.DE, DEGT.DE a cen pro CSG.NL (Yahoo 429) do `data/instruments.json`.
- Zda se prodeje splňující časový test započítávají do limitu 100 000 Kč (teď konzervativně ano).
- Volitelné: zaokrouhlení čísel v payloadu reportu (menší soubor) – pak upravit `deepEqual` v testu.
