# Stockera – zadání

## Cíl
Lokální aplikace pro analýzu portfolia z výpisů XTB. **Všechna data i výpočty zůstávají na počítači** – ven jdou pouze dotazy na veřejné ceny instrumentů, kurzy ČNB a složení ETF (pouze tickery, nikdy množství/hodnoty).

## Architektura
1. **Zpracovací aplikace (Node/TypeScript, lokálně na PC)**
   - Import výpisů XTB ve formátu **XLSX** (CZK i EUR subúčty).
   - Uložení do lokální **SQLite** DB (idempotentní import – opakované nahrání nevytvoří duplicity).
   - Stažení cen (veřejné API), kurzů ČNB (denní).
   - Složení ETF podle zemí – původně plánovaná kaskáda: (1) data emitenta, (2) proxy přes stejný index, (3) justETF dle ISIN, (4) ruční konfigurace. **Implementováno (fáze 3):** justETF dle ISIN → ruční konfigurace; emitenti vyžadují JavaScript a „související ETF“ na justETF nejsou spolehlivá proxy (viz [zdroje-dat.md](zdroje-dat.md)). U každého ETF se eviduje zdroj a datum.
   - Výpočty: párování FIFO, časový test, zisky/ztráty, dividendy, splity.
   - Vygeneruje **jeden samostatný HTML soubor** s daty uvnitř.
2. **Frontend (single HTML, responzivní)** – funguje offline na desktopu i mobilu (přenos ručně AirDrop/kabel), pouze čte předpřipravená data.

## Provoz bez AI
- Zpracování je čistě deterministický program – žádná AI za běhu.
- Aktualizace = vložit nový výpis do `data/input/` a spustit jeden příkaz (`pnpm update-data`).
- Při neznámém formátu výpisu nebo nedohledaném instrumentu program skončí srozumitelnou chybou / reportem (nikdy tiše nepočítá špatně).
- Ruční zásahy pouze přes konfigurační soubor (přepis tickeru, země, složení ETF).

## Bezpečnost a soukromí
- Veškerá síťová komunikace přes jediný HTTP wrapper s **allowlistem domén** (implementováno: ČNB, Deutsche Börse/Xetra, justETF, Yahoo Finance); jiné domény blokovány.
- Ven odchází pouze ticker / ISIN / datum – nikdy množství, ceny, hodnoty, čísla účtů (ověřeno testy).
- Audit log všech odchozích požadavků; ceny se stahují od společného hrubého data (nevyzradí data nákupů); limit velikosti odpovědi 20 MB.
- Nešifrovaný JSON s výsledky jen na vyžádání (`pnpm analyze --json`); DB a log s právy jen pro vlastníka. Heslo reportu min. 12 znaků.
- Výsledné HTML: vše inline, bez knihoven (vlastní SVG grafy), CSP `default-src 'none'; connect-src 'none'`, inline skript a styl povolené jen přes sha256 hash → prohlížeč zablokuje jakoukoliv síť. **Implementováno (fáze 4):** `pnpm report` → `out/stockera.html`.
- Přenositelnost: celá aplikace i data jsou ve složce projektu; po zkopírování na jiný počítač (i Windows) stačí Node ≥ 24, pnpm a `pnpm install`.
- Minimum závislostí, zamčené verze, `npm ci --ignore-scripts`, `npm audit`.
- `data/` a vygenerované výstupy nikdy necommitovat (`.gitignore`).
- **Rozhodnuto:** HTML report je uložený lokálně a **vždy chráněný heslem** – data v souboru zašifrovaná (AES-GCM, klíč z hesla přes PBKDF2/WebCrypto), dešifrování až v prohlížeči po zadání hesla. Heslo se nikam neukládá.
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

### Podrobnosti daňových výpočtů (implementováno ve fázi 2, `src/analysis/`)
- Časový test se posuzuje **po lotech**: první den bez daně = 3. výročí nákupu + 1 den (29. 2. → 28. 2. + 1 den).
- Limit 100 000 Kč: součet **hrubých příjmů z prodejů** v roce (ne zisků), vše-nebo-nic. Konzervativně se započítávají všechny prodeje včetně těch po časovém testu.
- Při překročení limitu: základ = zisky − ztráty z prodejů bez časového testu v daném roce, nejméně 0; ztráty se nepřevádějí do dalších let.
- Strop 40 mil. Kč pro příjmy osvobozené časovým testem se hlídá jen pro rok 2025 (od 2026 u cenných papírů zrušen).
- Kurzy: náklad kurzem ČNB ke dni nákupu, příjem ke dni prodeje; víkend/svátek = poslední fixing (max. 7 dní starý). Bez kurzu jsou částky v Kč/EUR `null` a limit má stav „nelze posoudit“.
- Hodnota pořízení/prodeje: přednostně částka peněžní operace XTB, jinak sloupce XTB, jinak cena × objem.
- Kontrola úplnosti: pokud peněžní operace začínají později než nejstarší nákup, analýza varuje (vklady a zůstatek by nesouhlasily).

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
