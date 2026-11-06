# Stockera – zadání

## Cíl
Lokální aplikace pro analýzu portfolia z výpisů XTB. **Všechna data i výpočty zůstávají na počítači** – ven jdou pouze dotazy na veřejné ceny instrumentů, kurzy ČNB a složení ETF (pouze tickery, nikdy množství/hodnoty).

## Architektura
1. **Zpracovací aplikace (Node/TypeScript, lokálně na PC)**
   - Import výpisů XTB ve formátu **XLSX** (CZK i EUR subúčty).
   - Uložení do lokální **SQLite** DB (idempotentní import – opakované nahrání nevytvoří duplicity).
   - Stažení cen (veřejné API), kurzů ČNB (denní).
   - Složení ETF podle zemí – kaskáda zdrojů: (1) data emitenta (iShares, Vanguard…), (2) proxy přes stejný index (S&P 500, MSCI World, FTSE All-World…), (3) justETF dle ISIN, (4) ruční konfigurace. U každého ETF evidovat zdroj a stáří dat.
   - Výpočty: párování FIFO, časový test, zisky/ztráty, dividendy, splity.
   - Vygeneruje **jeden samostatný HTML soubor** s daty uvnitř.
2. **Frontend (single HTML, responzivní)** – funguje offline na desktopu i mobilu (přenos ručně AirDrop/kabel), pouze čte předpřipravená data.

## Provoz bez AI
- Zpracování je čistě deterministický program – žádná AI za běhu.
- Aktualizace = vložit nový výpis do `data/input/` a spustit jeden příkaz (`pnpm update-data`).
- Při neznámém formátu výpisu nebo nedohledaném instrumentu program skončí srozumitelnou chybou / reportem (nikdy tiše nepočítá špatně).
- Ruční zásahy pouze přes konfigurační soubor (přepis tickeru, země, složení ETF).

## Bezpečnost a soukromí
- Veškerá síťová komunikace přes jediný HTTP wrapper s **allowlistem domén** (Yahoo Finance, ČNB, OpenFIGI, emitenti ETF, justETF); jiné domény blokovány.
- Ven odchází pouze ticker / ISIN / datum – nikdy množství, ceny, hodnoty, čísla účtů (ověřeno testy).
- Audit log všech odchozích požadavků.
- Výsledné HTML: všechny knihovny inline, CSP `default-src 'none'` (+ inline skripty/styly) → prohlížeč zablokuje jakoukoliv síť.
- Minimum závislostí, zamčené verze, `npm ci --ignore-scripts`, `npm audit`.
- `data/` a vygenerované výstupy nikdy necommitovat (`.gitignore`).
- Volitelně: šifrování HTML heslem (WebCrypto, dešifrování v prohlížeči).
- Při vývoji s AI používat pouze **anonymizované/smyšlené** vzorové výpisy – skutečná data AI nikdy nečte.

## Výpočetní pravidla
- Zdroj dat: export **historie účtu** z xStation (XLSX), každý subúčet zvlášť. Daňový výpis (Fiscal Report) jen případně ke kontrole.
- Párování prodejů s nákupy: použít **párování z XTB** (Closed Positions / Position ID), **FIFO** přepočítat jako kontrolu a upozornit na rozdíly.
- Kalendářní data (časový test, roky pro limit) počítat v časové zóně **Europe/Prague**; v DB ukládat UTC.
- Přepočet do CZK: **denní kurz ČNB ke dni obchodu**.
- Časový test: 3 roky od nákupu daného lotu → zobrazit, co už splnilo a kdy splní zbytek.
- Hlídání limitu **100 000 Kč** ročních hrubých příjmů z prodeje (osvobození).
- Dividendy včetně sražené daně.
- Akciové splity.
- Vklady/výběry → výnos vs. vložené peníze.

## Frontend
- Přepínání měny zobrazení **CZK / EUR**.
- **Tab 1 – Aktuální portfolio**
  - Nahoře grafy: koláčový (alokace), geografický (země; ETF podle složení), vývoj hodnoty portfolia v čase.
  - Celková hodnota.
  - Akordeon instrumentů v držení → rozkliknutí na jednotlivé nákupy (loty) se stavem časového testu / datem, kdy lze prodat bez daně.
  - Graf vývoje hodnoty jednotlivého instrumentu (přepnutí hlavního grafu nebo modal).
- **Tab 2 – Prodané**
  - Akordeon po instrumentech: celkem prodáno za X, zisk/ztráta v měně i %.
  - Rozkliknutí: jednotlivé prodeje (datum, zisk/ztráta v měně i %).
- Procházení historie nákupů.

## Dokumentace a testy
Vše vedeno v tomto repozitáři (`docs/`, testy u kódu). Vstupní výpisy patří do `data/input/` (nikdy necommitovat).
