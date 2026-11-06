# Zdroje tržních dat (`pnpm market`)

Všechny požadavky jdou přes `src/net/http.ts` (allowlist, jen GET, HTTPS, bez cookies, audit log `data/logs/network.log`).
Ven se posílá jen ticker, ISIN, rok nebo datum.

| Data | Zdroj | Požadavek | Kdy se stahuje |
|---|---|---|---|
| Kurzy CZK | ČNB – roční soubor denních kurzů (`rok.txt?rok=RRRR`) | rok | chybějící roky + vždy aktuální rok |
| Ticker → ISIN (`.DE`) | Deutsche Börse – seznam všech instrumentů Xetra (CSV, ~5 MB) | nic (celý seznam) | jen když se objeví nový `.DE` ticker bez ISIN |
| Země ETF | justETF – profil ETF (`etf-profile.html?isin=`) | ISIN | jednou za 30 dní |
| Země ETF (záloha) | onvista – `api.onvista.de/api/v1/funds/ISIN:{ISIN}/breakdowns` | ISIN | když justETF země neuvádí |
| Ceny ETF (EUR) | justETF – `api/etfs/{ISIN}/performance-chart` | ISIN + období | od posledního uloženého dne − 7 dní |
| Ceny akcií | Yahoo Finance – `v8/finance/chart/{symbol}` | symbol + období | od posledního uloženého dne − 7 dní |

## Pravidla a omezení
- **Ocenění:** použije se stažená cena, pokud je novější než stav ve výpisu XTB; jinak hodnota z výpisu.
- **Země ETF:** justETF ukazuje hlavní země a zbytek jako „Other“ → v grafu „Ostatní“ (`XX`). Některé ETF (swapové, nové, aktivně řízené – např. LEER, DEGT) tam rozpad nemají → použije se onvista; až když nemá ani ta, „Neznámé složení“ (`??`) a doplnění ručně (`countries`).
- **Země akcií:** ruční `country` → prefix ISIN (sídlo) → země burzy (hrubý odhad, např. CSG.NL = NL, ve skutečnosti CZ).
- **Yahoo** vrací HTTP 429 na prohlížečový User-Agent bez cookies, proto se mu posílá jen `Mozilla/5.0`. Při 429/5xx program 2× zopakuje dotaz; když to nepomůže, varuje, použije hodnotu z výpisu a při dalším běhu to zkusí znovu.
- **Mapování XTB → Yahoo:** `.US` bez přípony, `.UK` → `.L`, `.NL` → `.AS`, `.DE` → `.DE`, … (`src/market/sources.ts`), přepis přes `yahooSymbol`.
- Zdroje nemají oficiální API se smlouvou – při změně formátu program skončí srozumitelným varováním a hodnoty se doplní z výpisu XTB.

## Ruční konfigurace `data/instruments.json`
Vzor: `config/instruments.example.json`. Pole: `isin`, `priceSource` (`justetf` | `yahoo` | `none`), `yahooSymbol`, `country`, `countries` (v %, `XX` = ostatní).
