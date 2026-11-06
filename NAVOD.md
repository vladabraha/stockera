# Návod

Vše běží jen na tvém počítači. Z internetu se stahují pouze ceny a kurzy, tvoje data se nikam neposílají.

## 1. Poprvé (jednou na počítači)
1. Složku Stockera **rozbal** (pokud je v ZIPu) – např. do Dokumentů.
2. Dvakrát klikni na:
   - **Windows:** `instalace-windows.cmd`
   - **Mac:** `instalace-mac.command`
3. Počkej na „Hotovo ✓“. Otevře se složka `data/input`.

## 2. Aktualizace dat (pokaždé, když chceš nová čísla)
1. V xStation exportuj **historii účtu do Excelu (XLSX)**:
   - období **od založení účtu** až do dneška,
   - každý podúčet (EUR, CZK) zvlášť.
2. Soubory ulož do `data/input/` (staré výpisy tam klidně nech).
3. Dvakrát klikni na `aktualizovat-windows.cmd` / `aktualizovat-mac.command`.
4. Až se program zeptá, zadej heslo k reportu (aspoň 12 znaků) a pak ho zopakuj.
   **Při psaní se nic nezobrazuje – to je v pořádku.**
5. Report se sám otevře v prohlížeči.

## 3. Prohlížení
- Počítač: `out/stockera.html` → dvojklik → heslo.
- Mobil: soubor zkopíruj (AirDrop, kabel, cloud) a otevři ho v prohlížeči. Funguje i offline.

## Když něco nejde
Program vždy napíše, co se stalo, a pod tím **„Co dělat“**. Nejčastější situace:

| Problém | Co dělat |
|---|---|
| Windows: „Systém Windows ochránil váš počítač“ | Klikni **Další informace → Přesto spustit**. |
| Mac: „nelze otevřít, protože pochází od neidentifikovaného vývojáře“ | Pravé tlačítko na soubor → **Otevřít** → Otevřít. |
| „Složka je ještě zabalená v ZIPu“ | ZIP rozbal (pravé tlačítko → Extrahovat vše) a spouštěj z rozbalené složky. |
| „Chybí Node.js“ | Spusť nejdřív instalační skript (krok 1). |
| „Zatím není žádný výpis z XTB“ | Ulož XLSX export do `data/input/`. |
| „Soubor se nepodařilo načíst“ / „nejsou XLSX“ | Stáhni z xStation znovu export **XLSX** a neotevírej ho/neukládej v Excelu. PDF ani CSV nejde. |
| „Nepodařilo se spojit s žádným serverem“ | Zkontroluj připojení a spusť aktualizaci znovu. |
| Upozornění „⚠“ u některého instrumentu | Report se vytvoří i tak, jen u něj chybí část údajů. Zkus později, nebo ho doplň do `data/instruments.json` (vzor: `config/instruments.example.json`). |
| „Databázi právě používá jiný program“ | Zavři druhé okno se Stockerou a zkus to znovu. |
| Report: „Nesprávné heslo“ | Pozor na velká písmena a českou/anglickou klávesnici. |
| Report: zapomenuté heslo | Spusť znovu aktualizaci a zvol nové heslo. Data se nic neztratí. |
| Report na mobilu ukazuje jen text | Otevři soubor v prohlížeči (Safari/Chrome), ne v náhledu. |

Technické podrobnosti chyb se ukládají do `data/logs/chyby.log` – hodí se, když budeš někoho žádat o pomoc
(neobsahuje hesla, ale může obsahovat cesty k souborům).

## Přenos na jiný počítač
Zkopíruj celou složku **včetně `data/`** a na novém počítači spusť instalační skript (krok 1).
