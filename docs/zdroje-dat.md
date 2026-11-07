# Zdroje tržních dat (`pnpm market`)

Všechny požadavky jdou přes `src/net/http.ts` (allowlist, jen GET, HTTPS, bez cookies, audit log `data/logs/network.log`).
Ven se posílá jen ticker, ISIN, rok nebo datum (živé ceny v reportu: ISIN a kódy měn).

| Data | Zdroj | Požadavek | Kdy se stahuje |
|---|---|---|---|
| Kurzy CZK | ČNB – roční soubor denních kurzů (`rok.txt?rok=RRRR`) | rok | chybějící roky + vždy aktuální rok |
| Ticker → ISIN (`.DE`) | Deutsche Börse – seznam všech instrumentů Xetra (CSV, ~5 MB) | nic (celý seznam) | jen když se objeví nový `.DE` ticker bez ISIN |
| Země ETF | justETF – profil ETF (`etf-profile.html?isin=`) | ISIN | jednou za 30 dní |
| Země ETF (záloha) | onvista – `api.onvista.de/api/v1/funds/ISIN:{ISIN}/breakdowns` | ISIN | když justETF země neuvádí |
| Sektory ETF | onvista `…/funds/ISIN:{ISIN}/breakdowns` (`branchBreakdown`), záložně justETF profil | ISIN | jednou za 30 dní |
| Největší pozice ETF (top 10) | justETF profil, záložně onvista `…/breakdowns` (`fundsHoldingList`); pozice bez ISIN → onvista `…/search/facet` podle názvu firmy | ISIN ETF, veřejný název firmy z pozic | jednou za 30 dní (bez známých pozic při každém běhu) |
| ISIN akcie / ETF mimo Xetra | onvista – `api/v1/instruments/search/facet?searchValue={symbol}`; u akcií bez přesné shody ověření ceny přes `stocks/ISIN:{ISIN}/snapshot` | symbol bez burzy, ISIN kandidátů | jednou, když chybí ISIN |
| Sektor akcie | onvista – `api/v1/stocks/ISIN:{ISIN}/snapshot` | ISIN | jednou |
| Ceny ETF (EUR) | justETF – `api/etfs/{ISIN}/performance-chart` | ISIN + období | od posledního uloženého dne − 7 dní |
| Ceny akcií | Yahoo Finance – `v8/finance/chart/{symbol}` | symbol + období | od posledního uloženého dne − 7 dní |

## Živé ceny v otevřeném reportu (`out/stockera.html`)
Prohlížeč po odemknutí stáhne aktuální ceny a kurzy (CSP povoluje jen tyto čtyři hosty). Odchází jen ISIN nebo kódy měn.

| Data | Zdroj | Požadavek |
|---|---|---|
| Kurzy (ECB) | Frankfurter – `api.frankfurter.dev/v1/latest?base=EUR&symbols=CZK,USD,…` | kódy měn |
| Cena ETF | onvista – `api.onvista.de/api/v1/funds/ISIN:{ISIN}/snapshot` | ISIN |
| Cena akcie | onvista – `api.onvista.de/api/v1/stocks/ISIN:{ISIN}/snapshot` | ISIN |
| Cena – záloha | Tradegate – `www.tradegatebsx.com/refresh.php?isin={ISIN}` (EUR, poslední obchodní den) | ISIN |
| Kurzy – záloha | ECB – `data-api.ecb.europa.eu/service/data/EXR/D.CZK+USD….EUR.SP00.A` | kódy měn |

Když hlavní zdroj selže, použije se záložní a report na to upozorní. Bez připojení report ukáže hodnoty z poslední aktualizace. Ostatní zdroje (justETF, Yahoo, burzy) prohlížeči přístup nepovolují (CORS).

## Pravidla a omezení
- **Bezpečnostní kontrola:** každá stažená odpověď se před použitím zkontroluje (HTML/skripty, `javascript:` odkazy, řídicí znaky, podivná struktura JSON – `src/net/inspect.ts`). Podezřelá se celá zahodí, nic z ní se neuloží ani nezobrazí; `pnpm market` vypíše „⛔ Bezpečnostní kontrola“, report červené upozornění. V `network.log` má stav `unsafe`.
- **Ocenění:** použije se stažená cena, pokud je novější než stav ve výpisu XTB; jinak hodnota z výpisu.
- **Země ETF:** justETF ukazuje hlavní země a zbytek jako „Other“ → v grafu „Ostatní“ (`XX`). Některé ETF (swapové, nové, aktivně řízené – např. LEER, DEGT) tam rozpad nemají → použije se onvista; až když nemá ani ta, „Neznámé složení“ (`??`) a doplnění ručně (`countries`).
- **Sektory:** názvy ze zdrojů se převádí na 10 hrubých sektorů (technologie a komunikace, finance, zdravotnictví, průmysl, spotřební zboží, energie, suroviny, veřejné služby, nemovitosti, ostatní). Zbytek do 100 % = „Ostatní“. Když sektor chybí nebo nesedí, doplň `sector`/`sectors`.
- **Země akcií:** ruční `country` → prefix ISIN (sídlo) → země burzy (hrubý odhad, např. CSG.NL = NL, ve skutečnosti CZ).
- **Yahoo** vrací HTTP 429 na prohlížečový User-Agent bez cookies, proto se mu posílá jen `Mozilla/5.0`. Při 429/5xx program 2× zopakuje dotaz; když to nepomůže, varuje, použije hodnotu z výpisu a při dalším běhu to zkusí znovu.
- **Mapování XTB → Yahoo:** `.US` bez přípony, `.UK` → `.L`, `.NL` → `.AS`, `.DE` → `.DE`, … (`src/market/sources.ts`), přepis přes `yahooSymbol`.
- Zdroje nemají oficiální API se smlouvou – při změně formátu program skončí srozumitelným varováním a hodnoty se doplní z výpisu XTB.

## Ruční konfigurace `data/instruments.json`
Vzor: `config/instruments.example.json`. Pole: `isin`, `compositionIsin` (ISIN jiného ETF na stejný index – z něj země, sektory a pozice, např. u zrušeného fondu), `priceSource` (`justetf` | `yahoo` | `none`), `yahooSymbol`, `country`, `countries` (v %, `XX` = ostatní), `sector` nebo `sectors` (v %; klíče `technology`, `financials`, `health`, `industrials`, `consumer`, `energy`, `materials`, `utilities`, `real_estate`, `other`).
