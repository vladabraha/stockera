# Návod

Vše běží jen na tvém počítači. Z internetu se stahují pouze ceny a kurzy, tvoje data se nikam neposílají.

## Tři skripty – co který dělá
Ve složce jsou očíslované v pořadí, jak se používají (každý ve verzi `-mac.command` a `-windows.cmd`):

| Skript | Co dělá | Kdy |
|---|---|---|
| `1-instalace` | Připraví počítač: Node.js, pnpm, nástroje projektu. | Jednou na novém počítači. |
| `2-vytvorit-report` | Načte výpisy z `data/input`, stáhne ceny a kurzy a vytvoří `out/stockera.html`. | Pokaždé, když chceš aktuální čísla (nový výpis). |
| `3-stahnout-novou-verzi-aplikace` | Stáhne z GitHubu novou verzi **programu** (tvoje data nemění) a pak sám spustí krok 2. | Když vyjde nová verze aplikace. |

## 1. Poprvé (jednou na počítači)
1. Aplikaci si stáhni přes git (nové verze pak stáhneš jedním kliknutím, viz část 4) – např. do Dokumentů:
   `git clone https://github.com/vladabraha/stockera.git Stockera`. Případně složku **rozbal** ze ZIPu.
2. Dvakrát klikni na:
   - **Windows:** `1-instalace-windows.cmd`
   - **Mac:** `1-instalace-mac.command`
3. Počkej na „Hotovo ✓“. Otevře se složka `data/input`.

## 2. Vytvoření reportu (pokaždé, když chceš nová čísla)
1. V xStation exportuj **historii účtu do Excelu (XLSX)**:
   - období **od založení účtu** až do dneška,
   - každý podúčet (EUR, CZK) zvlášť.
   - **Trading 212:** Historie → Export → zaškrtni všechny typy → CSV. Jeden export má nejvýš 12 měsíců, stáhni
     proto víc souborů, aby dohromady pokryly celou dobu od založení účtu (můžou se překrývat).
2. Soubory ulož do `data/input/` (staré výpisy tam klidně nech).
3. Dvakrát klikni na `2-vytvorit-report-windows.cmd` / `2-vytvorit-report-mac.command`.
   - Po načtení výpisů uvidíš **Shrnutí importu** (kolik záznamů je nových a kolik už v databázi bylo).
   - Před zadáním hesla uvidíš **Kontrolu dat** – ✓ = v pořádku, ⚠ = přečti si, co dělat. Stejný přehled je v reportu dole na Portfoliu.
4. Až se program zeptá, zadej heslo k reportu (místo znaků se ukazují hvězdičky) a pak ho zopakuj.
5. Report se sám otevře v prohlížeči.

## 3. Prohlížení
- Počítač: `out/stockera.html` → dvojklik → heslo.
- Mobil: soubor zkopíruj (AirDrop, kabel, cloud) a otevři ho v prohlížeči. Funguje i offline.
- Po odemknutí si report sám stáhne **aktuální ceny** (nahoře „Živé ceny k …“, znovu tlačítkem *Aktualizovat ceny*; na mobilu ikona kruhové šipky, vedle ní zámek = *Zamknout*).
  Odchází jen kód instrumentu (ISIN), nikdy tvoje počty kusů ani částky. Bez internetu uvidíš hodnoty z poslední aktualizace.
  Když hlavní zdroj nefunguje, použije se záložní a report to napíše žlutě pod datem.
- **FIRE renta** (pod grafem): kolik by šlo měsíčně vybírat, kdybys každý rok prodal 4 % dnešní hodnoty portfolia (před daní).
- Dole na stránce je datum **poslední transakce ve výpisech** – podle něj poznáš, jestli máš nahrané aktuální výpisy.
- Rozsah grafu zvolíš nad grafem (1M–Vše). **Vlastní** ukáže pole Od a Do pro libovolné období.
- Tlačítko s kolečkem vedle *Aktualizovat ceny* přepíná vzhled: podle systému → světlý → tmavý.
- **Akcie uvnitř ETF**: které firmy skutečně vlastníš přes všechna ETF dohromady. Řádek rozklikneš a uvidíš, z kterého ETF kolik je. U každého ETF je známých jen 10 největších pozic.

## 4. Nová verze aplikace
Dvakrát klikni na `3-stahnout-novou-verzi-aplikace-windows.cmd` / `3-stahnout-novou-verzi-aplikace-mac.command`. Stáhne novou verzi z GitHubu,
vypíše novinky, doinstaluje nástroje a přegeneruje report. Tvoje složky `data/` a `out/` se nemění – v gitu nikdy nejsou.
- Potřebuje git (Mac ho nabídne doinstalovat sám, Windows: https://git-scm.com).
- Funguje jen ve složce stažené přes `git clone`. Složku ze ZIPu nahraď klonem a přesuň do něj svou složku `data`.

## Když něco nejde
Program vždy napíše, co se stalo, a pod tím **„Co dělat“**. Nejčastější situace:

| Problém | Co dělat |
|---|---|
| Windows: „Systém Windows ochránil váš počítač“ | Klikni **Další informace → Přesto spustit**. |
| Mac: „nelze otevřít, protože pochází od neidentifikovaného vývojáře“ | Pravé tlačítko na soubor → **Otevřít** → Otevřít. |
| „Složka je ještě zabalená v ZIPu“ | ZIP rozbal (pravé tlačítko → Extrahovat vše) a spouštěj z rozbalené složky. |
| „Chybí Node.js“ | Spusť nejdřív instalační skript (krok 1). |
| „Soubory programu jsou upravené“ (`3-stahnout-novou-verzi-aplikace`) | Vrať úpravy příkazem `git checkout -- .` (tvoje data to nezmění) a spusť skript znovu. |
| „Zatím není žádný výpis z XTB ani Trading 212“ | Ulož XLSX export z XTB nebo CSV z Trading 212 do `data/input/`. |
| „Soubor se nepodařilo načíst“ / „nejsou XLSX ani CSV“ | Stáhni znovu export (**XLSX** z xStation, **CSV** z Trading 212) a neotevírej ho/neukládej v Excelu. PDF nejde. |
| „…chybí nákup – nahraj exporty za celé období“ | Z Trading 212 stáhni exporty i za starší roky a ulož je do `data/input/`. |
| „Nepodařilo se spojit s žádným serverem“ | Zkontroluj připojení a spusť znovu `2-vytvorit-report`. |
| Upozornění „⚠“ u některého instrumentu | Report se vytvoří i tak, jen u něj chybí část údajů. Zkus později, nebo ho doplň do `data/instruments.json` (vzor: `config/instruments.example.json`). |
| „fond je zrušený nebo sloučený“ | Do `data/instruments.json` doplň `"compositionIsin"`: ISIN jiného ETF na stejný index (např. MSCI World = `IE00B4L5Y983`). Vzor je v `config/instruments.example.json`. |
| „⛔ Bezpečnostní kontrola“ nebo červené upozornění v reportu | Některý server poslal podivná data, program je zahodil a nic z nich nepoužil. Nic nedělej, zkus to později; když to trvá, pošli správci `data/logs/network.log`. |
| „Databázi právě používá jiný program“ | Zavři druhé okno se Stockerou a zkus to znovu. |
| Report: „Nesprávné heslo“ | Pozor na velká písmena a českou/anglickou klávesnici. |
| Report: zapomenuté heslo | Spusť znovu `2-vytvorit-report` a zvol nové heslo. Data se nic neztratí. |
| Report na mobilu ukazuje jen text | Otevři soubor v prohlížeči (Safari/Chrome), ne v náhledu. |

Technické podrobnosti chyb se ukládají do `data/logs/chyby.log` – hodí se, když budeš někoho žádat o pomoc
(neobsahuje hesla, ale může obsahovat cesty k souborům).

## Přenos na jiný počítač
Zkopíruj celou složku **včetně `data/`** a na novém počítači spusť instalační skript (krok 1).
