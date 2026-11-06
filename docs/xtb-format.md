# Formáty výpisů XTB

## Historie účtu – export z xStation (XLSX) – **hlavní zdroj**
Jeden soubor = jeden subúčet (CZK / EUR) za zvolené období. Tři listy, každý začíná metadaty:
`A1=Account number | B1=<číslo>`, `A2=<název listu>`, pak období / čas generování, pak hlavička tabulky.
Datumy jsou **Excel serial číslo v UTC** (např. `45425.6246…`). Čísla jsou numerické buňky.

### List `Closed Positions`
Metadata: `Date from (UTC)`, `Date to (UTC)`. Hlavička (řádek 5):
`Instrument, Ticker, Category, Type, Volume, Open Price, Open Time (UTC), Close Price, Close Time (UTC), Product, Profit/Loss, Gross Profit, Purchase Value, Sale Value, Stop Loss, Take Profit, Commission, Margin, Swap, Rollover, Open Conversion Rate, Close Conversion Rate, Close Origin, Position ID, Comment`
- Jeden řádek = jeden uzavřený lot (spárování nákup→prodej provedl XTB).
- `Position ID` není unikátní – jeden nákup prodaný po částech má více řádků se stejným ID (např. 0,4 a 0,3 ks).
- `Open/Close Conversion Rate` = kurz měny instrumentu → měna účtu.
- Poslední řádek `Profit/loss` = součet (kontrolní).

### List `Cash Operations`
Metadata: `Date from (UTC)`, `Date to (UTC)`. Hlavička:
`Type, Instrument, Ticker, Category, Time, Amount, ID, Comment, Product, Position ID`
Typy v ukázce: `Stock purchase`, `Stock sell`, `Deposit`, `Free funds interest`, `Free funds interest tax`.
Očekávané další (zatím bez vzorku): dividenda, srážková daň, výběr, poplatky, korporátní akce (split).
- `Comment` u obchodů: `OPEN BUY <qty>[/<celkem>] @ <cena>`, `CLOSE BUY <qty>/<celkem> @ <cena>`.
- `ID` = unikátní ID operace → klíč pro idempotentní import.
- Poslední řádek `Total`.

### List `Open Positions`
Snapshot **k okamžiku vygenerování** (`Data as of report generated`), ne ke konci období.
Souhrn (`Open position value`, `Open position profit`), pak hlavička (řádek 9):
`Product, Instrument/Position, Ticker, Category, Type, Volume, Value, Current price, Open price, Open time (UTC), Stop Loss, Take Profit, Net Profit %, Net Profit, Gross Profit, Margin, Open Commission, Swap, Rollover`
- Řádky jsou seskupené: **souhrnný řádek instrumentu** (`Instrument/Position` = název, `Category` vyplněna, `Type` prázdný), pod ním **loty** (`Instrument/Position` = Position ID, `Type`=BUY, `Open time` vyplněn).

### Kategorie a symboly
`Category`: `ETF`, `STOCK`. Ticker `SYMBOL.BURZA` (`.DE` Xetra, `.NL` Euronext Amsterdam, `.US`, `.UK`…).

## Fiscal Report (roční daňový výpis, XLSX)
Jeden list, sekce pod sebou (nadpis sekce ve sloupci B, pak hlavička, pak řádky; prázdné řádky mezi sekcemi).
Datum/čas: `DD.MM.YYYY HH:MM:SS`. Čísla jako text s desetinnou tečkou.

| Sekce | Sloupce | Pozn. |
|---|---|---|
| `Fiscal Report: YYYY/MM/DD - YYYY/MM/DD` | – | období výpisu |
| `List of Open Trades - <datum>` | Client's Login, Currency, Deal ID, System, Open Time, Type, Lots, Symbol, Commission, Swap, Gross Profit, Net Profit, Assetclass name | **chybí nákupní cena** – jen nerealizovaný zisk ke konci roku |
| `Profit Loss Summary CFD/STC/Fractional Rights` | souhrny | pro kontrolu součtů |
| `List of CFD Transactions` | … Open Time, Type, Lots, Symbol, Close Time, Commission, Swap, Profit | |
| `List of Stock Transactions` | Client's Login, Currency, Deal ID, System, Open Time, Type, Lots/Volume, Symbol, Instrument Currency, Purchase value in Account Currency, Sale value in Account Currency, Close Time, Holding Period Days, Commission, Gross Profit, Net Profit | uzavřené loty již spárované XTB |
| `List of Fractional Shares Transactions` | stejné jako Stock | **samostatné** loty; stejné Deal ID se může objevit i ve Stock (jiný objem) → klíč nesmí být jen Deal ID |
| `List of Dividends and other cash operations` | Client's Login, Currency, Tax domicile, Comment, Transaction Date, Amount | |
| `List of Fees, Bonuses, Interest Rates cashflows` | Client's Login, Currency, Comment, Transaction Date, Amount, Name | úroky, daň z úroků |
| `Transaction adjustments` | Client's Login, Currency, Comment, Type, Asset class name, Transaction Date, Amount | |

Symboly: `TICKER.BURZA` (např. `.DE` = Xetra). ISIN ve výpisu není.

### Omezení pro naše použití
- Otevřené pozice nemají nákupní cenu → nelze přesně spočítat nákupní hodnotu lotu.
- Neobsahuje vklady/výběry.
- Jeden soubor = jeden rok.
