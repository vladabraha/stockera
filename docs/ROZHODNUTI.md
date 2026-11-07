# Rozhodnutí (pro další úpravy – lidské i AI)

Záznam všech architektonických, bezpečnostních a výpočetních rozhodnutí včetně důvodů. Před úpravou si přečti
celý soubor; když rozhodnutí měníš, uprav ho tady (a v `README.md` / `docs/ZADANI.md`).
Související: `docs/ZADANI.md` (zadání), `docs/architektura.md` (architektura, import, DB, frontend), `docs/xtb-format.md` (formát exportu), `docs/zdroje-dat.md` (zdroje dat).

## 0. Nepřekročitelná pravidla od uživatele

1. **Osobní data nesmí opustit počítač.** Ven smí jen ticker / ISIN / datum (report v prohlížeči navíc kódy měn)
   k veřejným API. Nikdy množství, ceny, hodnoty, čísla účtů, jméno.
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
- `aktualizovat-*.cmd/.command` spouští **přímo `node src/cli/update.ts`** (ne pnpm – k běhu stačí Node ≥ 24, tím
  odpadá i problém s execution policy u `pnpm.ps1`). Předem ověří Node; po úspěchu otevřou `out/stockera.html`.
  `instalace-windows.cmd` běží přes `powershell -ExecutionPolicy Bypass` (platí jen pro daný proces).
- Oba `.cmd` odmítnou běh ze ZIPu / `%TEMP%` (Průzkumník spouští soubory ze ZIPu z dočasné složky) – detekce přes
  `findstr /l` na cestu s `/` místo `\` (findstr bere `\` jako escape).
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
- **Daň** = 15 % ze základu (`src/analysis/tax.ts`, sdíleno s reportem). Pásmo 23 % závisí na všech příjmech, které
  aplikace nezná → jen poznámka v UI.
- **Vyrovnání letošní daně ztrátou** (karta letošního roku v „Daně podle let“): když letošní prodeje mají daň,
  ukáže se, které držené pozice prodat se ztrátou, aby se základ vynuloval (`lossOffsetPlan`). Prodej se páruje
  **FIFO** per účet a ticker, takže jde prodat jen nejstarší loty; loty se splněným testem se nezapočítají (jejich
  zisk i ztráta jsou osvobozené). Nejdřív pozice s největší ztrátou, poslední jen částečně. Podle aktuálních (i živých) cen.
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
  `query1/query2.finance.yahoo.com`, `api.onvista.de`. Nový zdroj = přidat sem + test + `docs/zdroje-dat.md`.
- Síť používá **jen `pnpm market`** a volitelně otevřený report (živé ceny, viz §6). Import a výpočty jsou offline.
- Zdroje (podrobně `docs/zdroje-dat.md`):
  - kurzy: ČNB roční txt (minulé roky se znovu nestahují, pokud mají kurz z 20.–31. 12.),
  - ticker → ISIN: CSV všech instrumentů Xetra (jen pro `.DE`); ETF, které tam není (např. LCUW), → onvista
    vyhledávání, ISIN jen při **jednoznačné shodě symbolu** ve skupině ETF (`pickOnvistaEtf`),
  - ETF: justETF profil (země: top země + „Ostatní“ = `XX`; obnova po 30 dnech) a justETF chart API (denní ceny EUR),
  - ETF bez zemí na justETF → záložně onvista `api/v1/funds/ISIN:{isin}/breakdowns` (`countryBreakdown`, německé
    názvy zemí → `countryCode` zná i `de` + aliasy jako „Barmittel“ = `XX`). Zdroj se ukládá (`onvista`), obnova po 30 dnech.
  - akcie: Yahoo chart v8. Yahoo vrací 429 na „prohlížečový“ User-Agent bez cookies → pro Yahoo se posílá jen
    `Mozilla/5.0`. Obecně: HTTP 429/502/503/504 se 2× zopakuje (po 2 s a 5 s), pak varování, ne pád.
    Z odpovědi se bere i `longName` → plný název akcie. Mapování `.UK`→`.L`, `.NL`→`.AS`, `.US`→bez přípony; GBp ÷ 100.
  - Země akcie: prefix ISIN, jinak země burzy. Kód `GB`, ne `UK`.
  - ISIN akcie (mimo `.DE`): onvista vyhledávání `api/v1/instruments/search/facet?searchValue={symbol}` – posílá se jen
    symbol bez přípony burzy; ISIN se vezme **jen při jednoznačné shodě** (název/symbol = ticker a země burzy sedí).
    Když přesná shoda není (onvista vede „KBC Group“ se symbolem KDB, ne „KBC“), vezmou se akcie stejné země, jejichž
    název začíná tickerem (`onvistaStockCandidates`), a ISIN se přijme jen u **jediné**, jejíž cena na domácí burze
    (`onvistaHomePrice`) je do ±10 % od aktuální ceny z výpisu XTB (KBC Group 117 € vs. KBC Ancora 94 €). Jinak nic.
  - **Složení (země, sektory, pozice) jen pro držené instrumenty** (`open_lots`) – u prodaných se nepoužívá, takže se
    ani nestahuje a nedělá zbytečná varování. Prodaným se stahují jen ceny (historie) a ETF i ISIN (ceny justETF).
  - **Zrušený/sloučený fond**: justETF ho označí textem „This fund has been liquidated or merged“ (`EtfProfile.closed`)
    → varování s návodem. Ruční `compositionIsin` (ISIN jiného ETF na stejný index) převezme země, sektory a pozice
    z něj; ceny zůstávají vlastní. S `compositionIsin` se složení obnovuje při každém běhu, aby se změna hned projevila.
  - **Sektory** (`sector_weights`, `instrument_meta.sector_source`): ETF → onvista `breakdowns` (`branchBreakdown`, úplný
    rozpad), záložně justETF profil (jen top 4 + „Other“); akcie → onvista `stocks/ISIN:{isin}/snapshot`
    (`company.branch.sector`). Názvy (EN/DE) mapuje `sectorKey()` regexy na **hrubou taxonomii** 10 sektorů
    (`SECTORS`): technologie + komunikace a cyklické + necyklické spotřební zboží jsou **sloučené**, protože onvista
    u části ETF vrací jen „IT/Telekommunikation“ a jediné „Konsumgüter“ – jemnější dělení by ETF nešlo porovnat.
    Zbytek do 100 % = `other`. ETF se obnovují po 30 dnech, sektor akcie se stáhne jednou. Neznámý název → varování
    a `other`. CSG.NL onvista vede jako „Sonstige Technologie“ (ve skutečnosti obrana) → ruční `"sector": "industrials"`.
  - **Největší pozice ETF** (`fund_holdings`, `instrument_meta.holdings_updated`): justETF profil (top 10, ISIN
    z odkazu `/stock-profiles/{ISIN}`, anglické názvy), záložně onvista `breakdowns` (`fundsHoldingList`, top 10).
    Obnova po 30 dnech; když je nemá žádný zdroj, zkusí se to znovu až za 30 dní (varování jen poprvé).
    Zamítnuto: extraETF (také jen top 10, nový server), stahování úplného složení od správců fondů (viz §6).
- **Zamítnuto:** Stooq (vyžaduje JS), OpenFIGI (nevrací ISIN), vyhledávání Börse Frankfurt/Euronext (prázdné),
  automatické „proxy ETF“ přes podobné ETF z justETF (nespolehlivé) → místo toho ruční `compositionIsin` nebo `countries`.
- Ruční přepisy: `data/instruments.json` (vzor `config/instruments.example.json`, klíče začínající `$` se ignorují):
  `isin`, `compositionIsin`, `countries`/`country`, `sector`/`sectors` (klíče z `SECTORS`), `priceSource` (`justetf`|`yahoo`|`none`), `yahooSymbol`.
  Swapové/aktivní ETF (LEER, DEGT) nemají na justETF země → onvista; teprve když selže i ta, `??` = „Neznámé složení“.
- **Ceny se stahují od společného hrubého data** (1. 12. roku před prvním nákupem) pro všechny tickery, aby
  z požadavků nešlo vyčíst, kdy byl který instrument koupen. Dál inkrementálně od posledního data − 7 dní.
- Selhání zdroje = varování, nikdy pád celého běhu.
- **Kontrola stažených dat na škodlivý obsah** (`src/net/inspect.ts`, přání uživatele; čistý soubor bez importů,
  sdílí ho CLI i report). Hledá: HTML/`<script>` značky, `on…=` handlery, `javascript:`/`vbscript:`, `data:text/html`,
  řídicí znaky C0/C1 (mimo tab/CR/LF – ochrana terminálu před escape sekvencemi), bidi přepisy, klíče
  `__proto__`/`constructor`/`prototype`, hloubku > 64, > 2 mil. uzlů a nekonečná čísla. JSON (`getJson`) se kontroluje
  celý; u HTML/CSV/textu (justETF profil, Xetra CSV, ČNB) **jen vytažené hodnoty** přes `http.checkExtracted` – surové
  HTML justETF legitimně obsahuje skripty. Nález = `UnsafeDataError` → celá odpověď se zahodí (nic se neuloží),
  audit `status: 'unsafe'`, instrument dostane varování a použije se zbytek řetězce zdrojů / hodnota z výpisu.
  `pnpm market` na konci vypíše blok „⛔ Bezpečnostní kontrola“ (host + důvod). Ověřeno na reálných odpovědích
  všech zdrojů – žádné falešné poplachy. Report vše vykresluje přes `textContent`, takže jde o obranu do hloubky.

## 6. Report – `src/report`

- **Jeden samostatný HTML soubor** `out/stockera.html` – funguje offline, i na mobilu (přenos ručně: AirDrop/USB).
  Žádný server, žádná PWA, žádný hosting.
- **Vždy zašifrovaný heslem** (rozhodnutí uživatele): gzip → AES-256-GCM (IV 12 B), klíč PBKDF2-SHA256
  **600 000 iterací**, sůl 16 B; nová sůl i IV při každém sestavení. Dešifruje se v prohlížeči (WebCrypto +
  `DecompressionStream`). Heslo se nikam neukládá; *Zamknout* zahodí data z paměti.
  Testy používají 1000 iterací (`buildReport(a, pw, { iterations })`).
- Heslo: interaktivně (skryté, 2×, raw mode – funguje i ve Windows Terminal/PowerShell/cmd), nebo
  `STOCKERA_PASSWORD` (varování o historii příkazů, proměnná se po přečtení smaže). Bez minimální délky (přání uživatele – volba je na něm), jen neprázdné; při psaní se zobrazují `*`.
- **CSP** v `<meta>`: `default-src 'none'`, `script-src`/`style-src` jen **sha256 hash** vložených bloků,
  `form-action`/`base-uri` `'none'`, `img-src data:` (jen vložená favicona – logo jako base64 SVG v `<link rel="icon">`;
  `data:` obrázek nic nestahuje ani neodesílá), **`connect-src https://api.onvista.de https://api.frankfurter.dev https://www.tradegatebsx.com https://data-api.ecb.europa.eu`**
  (jen živé ceny, viz níže) → stránka nemůže nic načíst ani odeslat nikam jinam (formuláře, vzdálené obrázky, odkazy jsou blokované).
  Důsledky pro kód frontendu:
  - **žádné `style="…"` atributy v markupu** (CSP je blokuje) – barvy/šířky jen přes CSSOM (`el.style.setProperty`, helper `paint()`),
  - SVG barvy přes `var()` nastavovat přes `style`, ne prezentační atributy,
  - žádné externí fonty, obrázky, knihovny; žádné inline `on*=` handlery,
  - data vkládat jen přes `textContent`/`append`/`setAttribute` (nikdy `innerHTML` s daty), nevytvářet odkazy.
- Frontend je psaný v TS (`app.ts` + sdílený `crypto.ts`), `build.ts` ho převede `stripTypeScriptTypes`, odstraní
  **jednořádkové** `import … from '…'` a prefixy `export`, zabalí do IIFE. Víceřádkové importy → build selže (záměrně).
  Ve frontendu tedy jen typové importy + soubory, které `frontendScript()` přibalí (`crypto.ts`,
  `analysis/breakdown.ts`, `live.ts`); jiné runtime importy nefungují.
- Payload je v `<script type="application/json" id="payload">` (jen base64 + JSON).
- **Živé ceny v reportu** (`src/report/live.ts`, zadání uživatele): po odemknutí se hned vykreslí uložený snímek a
  pak se stáhnou aktuální ceny (tlačítko *Aktualizovat ceny* to zopakuje). Ven jde **jen GET s ISINem nebo kódy měn**
  (`credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, `cache: 'no-store'`, `redirect: 'error'`, timeout 10 s,
  4 souběžné požadavky). Testy to hlídají (`tests/live.test.ts`).
  - Kurzy: Frankfurter (ECB) `v1/latest?base=EUR&symbols=…`; `czkPer(EUR) = rates.CZK`, ostatní `rates.CZK / rates[X]`.
    Když kurzy selžou → stav „bez připojení“ a zobrazí se snímek beze změny.
  - Ceny: onvista `funds/ISIN:{isin}/snapshot` (ETF, `quote`) a `stocks/ISIN:{isin}/snapshot` (akcie: nejnovější
    kotace v měně instrumentu, jinak nejnovější z `_XET/_GAT/_FRA/_STU/_TRO/_AMS` v EUR; `_LST` a `_PNK` se
    ignorují – zastaralé/nelikvidní). Instrument bez ISINu nebo s chybou zůstane z výpisu.
  - **Záložní zdroje** (přání uživatele – aby výpadek jednoho API nevadil a uživatel o něm věděl):
    - ceny: když onvista u instrumentu selže nebo nevrátí použitelnou kotaci → Tradegate
      `www.tradegatebsx.com/refresh.php?isin=` (`last`, vždy EUR; čísla někdy jako text s desetinnou čárkou). Odpověď
      nemá datum → bere se poslední obchodní den Tradegate (Po–Pá od 8:00 Berlín, svátky neznáme). Volá se přímo
      `tradegatebsx.com`, protože `tradegate.de` přesměrovává (a `redirect: 'error'`).
    - kurzy: když selže Frankfurter → oficiální API ECB `data-api.ecb.europa.eu/service/data/EXR/D.CZK+USD….EUR.SP00.A?lastNObservations=1&format=jsondata` (SDMX-JSON, stejná data ECB).
    - V reportu se pak pod stavem ukáže upozornění „Hlavní zdroj (…) teď nefunguje. N z M cen je ze záložního zdroje
      Tradegate. Kurzy jsou ze záložního zdroje ECB.“ a technická příčina jde do konzole prohlížeče.
  - **Kontrola odpovědí** (`get()` v `live.ts`): `content-type` musí obsahovat `json`, max 2 MB, pak `parseSafeJson`
    (viz §5). Podezřelá odpověď se zahodí, zkusí se záloha a nad stavem se ukáže červené upozornění (`role=alert`)
    „Bezpečnostní kontrola zahodila podezřelá data (…)“. Když selžou oba zdroje kurzů, report zůstane u snímku.
  - **Proč tyto zdroje:** jediné ověřené s CORS `*` i pro `Origin: null` (soubor z disku). justETF, Yahoo, Börse
    Frankfurt, Consorsbank, finanzen.net ani L&S CORS nemají; Euronext má CORS, ale data šifruje. onvista je rychlá
    (~0,1 s, jeden dotaz vrátí všechny burzy) – primární zůstává. (onvista vrací 429 jen na ne-prohlížečový User-Agent.)
  - Přepočet v paměti na kopii snímku (`applyLive`, idempotentní): u lotů s cenou stejného nebo novějšího dne než
    `valueDate` se přepočte `currentPrice`, `value`, `profit`, `profitPct`; pak součty instrumentů, `summary`,
    země a sektory (sdílený `src/analysis/breakdown.ts`, bundlovaný i do reportu), poslední bod `history` a cenová
    řada instrumentu. Cena odlišná o > 50 % od uložené se zahodí (špatný trh/jednotka). **Nákupní náklady, prodeje
    a daně se nemění** (zafixované kurzem ČNB ke dni obchodu); živé hodnoty používají dnešní kurz ECB – proto může
    nerealizovaný zisk nepatrně odbočit od `pnpm report`. Pořadí instrumentů a barvy zůstávají podle snímku.
  - Hlavička hodnoty ukazuje stav: „aktualizuji ceny…“, „Živé ceny k …“ (příp. kolik instrumentů z kolika),
    „novější ceny zatím nejsou“, „bez připojení – ceny z výpisu“. *Zamknout* zahodí i živá data.
- Testy (`tests/report.test.ts`) hlídají: round-trip šifrování, nepřítomnost plaintextu (tickery, účty), shodu CSP
  hashů, přesný `connect-src`, jediné URL v HTML jsou SVG namespace a čtyři API živých cen, žádné `style=`/`on*=`/`<link>`/`<img>`/`<iframe>`, přesně 2 `<script>`.
- Nešifrovaný `out/analysis.json` vzniká **jen** s `pnpm analyze --json` (práva 600); bez přepínače se starý smaže.
  `update-data` = `ingest → market → report` (bez analyze).

### Blbuvzdornost a hlášky (pro uživatele, který u vývoje nebyl)
- Každá chyba = co se stalo + **„Co dělat“** (číslované kroky). Společné nástroje v `src/cli/friendly.ts`:
  `paths`, `fail()`, `explain()` (SQLITE_BUSY/EBUSY, EACCES/EPERM, ENOSPC → konkrétní rada), `logError()`.
- `friendly.ts` instaluje `uncaughtException` handler: stack trace jde do `data/logs/chyby.log` (práva 600),
  uživatel vidí jen srozumitelnou větu. Každé CLI ho importuje.
- `src/cli/update.ts` = průvodce „Krok 1/3 … 3/3“; kroky spouští jako podprocesy se `stdio: 'inherit'` (kvůli TTY
  dotazu na heslo). Bez XLSX i bez DB vypíše postup exportu z xStation (exit 1). Na konci shrnutí + „Co dál“.
- Exit kódy: 0 OK, 1 chyba, `market` 2 = nejde internet (všechny požadavky selhaly) → report se přesto vytvoří
  se staršími cenami.
- Import: ignoruje ne-XLSX soubory s vysvětlením (PDF/CSV/XLS nejde), upozorní na zámkové soubory Excelu `~$`,
  chyba jednoho souboru neblokuje ostatní. `instruments.json` s BOM (Poznámkový blok) se načte.
- Report (prohlížeč): kontrola `crypto.subtle` + `DecompressionStream` (starý prohlížeč), poškozený payload,
  nápověda u špatného hesla, `<noscript>` pro náhledy bez JS (mail, Files na iPhonu).
- Hlášky skriptů `.cmd` jsou bez diakritiky (ASCII), výstup Node je UTF-8 (`chcp 65001`).
- Uživatelský návod s tabulkou „Problém → Co dělat“ je `NAVOD.md` – při nové hlášce ji tam doplnit.

### UI / design
- Dva taby: **Portfolio** (hodnota + graf vývoje s rozsahy 1M–Vše, souhrnné statistiky, **pruhy podle instrumentů**
  (klik → graf instrumentu), **donut podle zemí** (top 8 + Ostatní + Neznámé), „Brzy bez daně“, akordeon instrumentů → nákupy s časovým testem; „Zobrazit graf“ přepne hlavní
  graf na cenu/hodnotu instrumentu s body nákupů/prodejů) a **Prodané** (realizovaný zisk, daně podle let s limitem
  100 tis., akordeon prodaných instrumentů → jednotlivé prodeje se ziskem v měně i %). Přepínač Kč / €.
- Statistika **FIRE renta** = aktuální hodnota × 4 % / 12 v měně přepínače (počítá se při vykreslení, takže se
  mění i s živými cenami). Bez daní a inflace, sazba je konstanta `FIRE_RATE` v `app.ts`.
- Patička ukazuje `lastTransactionDate` (nejnovější obchod nebo peněžní pohyb ve výpisech, pražské datum) vedle data
  výpisu XTB – uživatel tak pozná, jestli nahrál poslední výpisy.
- Rozsah grafů: předvolby 1M–Vše a **„Vlastní“** se dvěma poli `<input type="date">` (Od / Do, min/max = data grafu).
  Rozsah je jeden společný pro graf portfolia i instrumentů (`state.range` + `state.custom`), prohozené Od > Do se
  srovná, prázdné pole = od začátku / do konce. Text „Od … do …: zisk“ porovnává první a poslední bod v rozsahu.
  Žádné tažení myší po grafu – nativní pole data fungují stejně na mobilu i bez nové knihovny.
- Na telefonu jsou *Aktualizovat ceny* a *Zamknout* jen ikony (text zůstává v `aria-label` a `title`), aby se
  hlavička vešla na jeden řádek; zkratky typu „Ceny“ nepoužívat – nebyly srozumitelné.
- Řádky instrumentů ukazují **plný název** (justETF/Yahoo z `instrument_meta`, jinak krátký z XTB) a pod ním ticker + ks.
  Jednotkové ceny (nákup/prodej) jsou vždy v **měně instrumentu** s jejím symbolem; součty se řídí přepínačem Kč / €.
- Rozbalený řádek instrumentu (`.acc[open] > summary`) je **sticky** pod hlavičkou stránky; výšku hlavičky (mění se
  zalomením na mobilu) měří `ResizeObserver` do CSS proměnné `--header-h`.
- Body nákupů/prodejů v grafu instrumentu: částka (zaplaceno / utrženo + zisk, v měně instrumentu i v Kč/€) se ukazuje
  v **tooltipu** nejbližšího bodu grafu (funguje i dotykem, `<title>` na mobilu nejde); max 3 obchody, zbytek jen počtem.
  V režimu „Hodnota pozice“ leží body na křivce hodnoty.
- Panel **Podle sektorů** (Portfolio, pod zeměmi): skládaný pruh + seznam sektorů s hodnotou v Kč/€ a podílem;
  ETF jsou rozpočítané podle sektorů firem uvnitř. Řádek instrumentu ukazuje v detailu top 3 sektory.
- **Design = moderní trading aplikace** (přání uživatele; zamítnuté směry „úřední razítko“ a „vkladní knížka“).
  Jediný výrazný prvek: **tmavě modrý pás s hodnotou portfolia a grafem** (`.hero`, `--band #0f1d3a`, přepisuje
  barevné proměnné uvnitř). Okolí klidné: pozadí #eef1f6, bílé panely bez stínů, text #14213d, akcent #2f5bff,
  zisk #0b9a6d, ztráta #e03a55 (tmavý režim bg #0a1222). Čísla a nadpisy v `--fig` (Bahnschrift / DIN Alternate –
  systémové „burzovní“ fonty, CSP blokuje webfonty), UI v systémovém sans, tabulkové číslice.
  Taby = podtržené tlačítka s počtem, změny jako **pill `chip()`** (zelená/červená), **sparkline** posledních ~3 měsíců
  v řádku pozice, kulaté avatary tickerů. Jediná nevyžádaná animace: jednorázové vykreslení čáry grafu po odemčení
  (respektuje `prefers-reduced-motion`).
  Pravidla (skill frontend-design): žádné VERZÁLKY u popisků, žádné meta řetězce s „·“, žádné šipky „→/←“ v textu
  odkazů, žádné stíny/gradienty jako dekorace, šedé pro „Ostatní/Neznámé“ studené (#9aa3b2 / #cfd5de).
- Světlý i tmavý režim: výchozí podle `prefers-color-scheme`, tlačítko v hlavičce (ikona) přepíná cyklicky
  podle systému → světlý → tmavý (přání uživatele). Volba = `data-theme` na `<html>` + `localStorage`
  (`stockera-theme`; jde i u souboru z disku, při zákazu úložiště platí do zavření). Tmavé proměnné jsou v CSS
  dvakrát (media query s `:not([data-theme="light"])` a `[data-theme="dark"]`) – při změně barev upravit obě.
- Panel **Akcie uvnitř ETF** (Portfolio, pod sektory; přání uživatele): ETF rozložené na jednotlivé akcie a stejná
  akcie (podle ISIN) sečtená přes všechna ETF i přímý nákup (`lookThrough()` v `src/analysis/breakdown.ts`, sdílené
  s živými cenami). Řazeno podle podílu na celém portfoliu, ukazuje 10, tlačítkem po 10 až do 100 (v analýze max 100),
  od 11. řádku se seznam posouvá uvnitř panelu (`max-height`). Řádek se rozbalí na rozpad „z kterého ETF kolik %“.
  **Jen 10 největších pozic každého ETF** – úplné složení zveřejňuje každý správce jinak (iShares, Amundi, SPDR…,
  části přes POST/XLSX), uživatel zvolil top 10 bez nových serverů. Panel proto poctivě ukazuje, kolik % portfolia
  známé pozice tvoří, a vyjmenuje ETF bez známých pozic (LEER, DEGT – nemá je justETF ani onvista).
- Responzivita: < 960 px řádek pozice na 2 řádky, < 860 px jeden sloupec, < 640 px statistiky 2×, bez sparkline, taby na celou šířku, **tabulky → karty**
  (`td[data-label]` + `td::before`). Každá buňka tabulky musí mít `data-label`.
- Vlastní SVG grafy bez knihoven. Výkon: decimace na ~2 body/px, hover přes `requestAnimationFrame`, binární
  hledání bodu, min/max cyklem (ne spread – velká pole). Změřeno na 40 instrumentech × 10 let při 4× zpomaleném
  CPU: odemčení ~270 ms, interakce < 80 ms, ~2,3k DOM uzlů.

## 7. Bezpečnostní revize (11/2026)

Revize celého projektu nenašla zneužitelnou chybu (allowlist, XSS, CSP, krypto, SQL – vše parametrizované,
ZIP – názvy jen jako klíče v paměti). Zapracovaná zpevnění: `analysis.json` jen na vyžádání, varování u hesla z env, společné datum začátku cen, limit 20 MB odpovědi, kontrola importů při buildu, práva 600.
Vědomě neřešeno: zip bomb (jen DoS vlastního počítače vlastním souborem), prototype pollution v
`data/instruments.json` (vlastní lokální konfigurace).

## 8. Ověřování a testy

### Kontroly dat pro uživatele
- **Shrnutí importu** (`src/cli/import.ts`): soubory nové / načtené dříve / přeskočené / s chybou, záznamy nové vs.
  „už v databázi (přepoužito)“ (u znovu nahraného souboru = počet záznamů z jeho prvního načtení, podle `import_id`),
  stav otevřených pozic, celkové počty v DB s přírůstky. Kontrola konzistence: přírůstek řádků v DB = součet nových
  záznamů ze souborů.
- **Kontrola dat** (`src/analysis/validation.ts`, `Analysis.checks.validation`): vypíše se v kroku 3 před dotazem
  na heslo, v `pnpm analyze` a v reportu (panel „Kontrola dat“ na konci Portfolia, sbalený, když je vše ✓).
  Kontroly: součet hodnot nákupů = souhrn „Open position value“ z výpisu (tolerance 0,1 %); nákupní cena = hodnota −
  zisk podle XTB (0,5 %); stažená cena ke dni výpisu vs cena XTB (**5 %** – 3 % dávalo falešné poplachy u akcií
  s cenou z předchozího dne; chyby symbolu/měny/pencí jsou řádově větší); stáří výpisu (> 31 dní ⚠); změna hodnoty
  od výpisu (> 15 % ⚠); kurzy ČNB; FIFO; úplnost historie. Stav `info` = jen kontext, ne chyba.
  Párování kusů přes peněžní operace se nedělá – export nemusí mít peněžní operace za celé období.

- `pnpm check` (typecheck + testy) a `pnpm audit` musí projít před každým commitem.
- Testy jsou offline: syntetické XLSX (`tests/helpers/xlsxBuilder.ts`, `fakeXtb.ts`), `fakeFetch` místo sítě,
  in-memory DB. Testy nesmí volat skutečné API ani číst `data/`.
- Vizuální kontrola reportu probíhala jednorázově headless Chrome (CDP) **mimo projekt, se svolením uživatele**;
  není to součást projektu ani závislost. Nepřidávat Playwright/Puppeteer bez souhlasu.
- Commity obsahují trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

## 9. Otevřené body

- Splity, skutečné názvy dividend / srážkové daně / výběrů (čeká se na anonymizovaný vzorek).
- Export CZK subúčtu (čeká se na uživatele).
- Zda se prodeje splňující časový test započítávají do limitu 100 000 Kč (teď konzervativně ano).
- Volitelné: zaokrouhlení čísel v payloadu reportu (menší soubor) – pak upravit `deepEqual` v testu.
