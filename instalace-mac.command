#!/bin/sh
# Stockera – příprava na macOS: Node.js 24+, pnpm, závislosti projektu. Stačí spustit dvojklikem.
cd "$(dirname "$0")" || exit 1
PNPM_VERSION=10.18.1
for p in /opt/homebrew/bin /usr/local/bin; do [ -d "$p" ] && PATH="$p:$PATH"; done
export PATH

fail() {
  printf '\n✗ %s\n\nCo dělat:\n' "$1"; shift
  i=1; for s in "$@"; do printf '  %d. %s\n' "$i" "$s"; i=$((i+1)); done
  printf '\nOkno můžeš zavřít.\n'; exit 1
}
node_major() { v=$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'); echo "${v:-0}"; }

echo "== Stockera: příprava =="
echo "Stáhne a nainstaluje Node.js a pnpm (potřebuje internet, trvá pár minut). Tvoje data se nikam neposílají."
echo

if [ "$(node_major)" -lt 24 ]; then
  if command -v brew >/dev/null 2>&1; then
    echo "[1/3] Instaluji Node.js přes Homebrew…"
    brew install node || brew upgrade node
  else
    open https://nodejs.org/ 2>/dev/null
    fail "Chybí Node.js 24+." \
      "V prohlížeči se otevřela stránka nodejs.org – stáhni verzi LTS (soubor .pkg)." \
      "Nainstaluj ji (pořád Pokračovat, nakonec zadej heslo k Macu)." \
      "Spusť instalace-mac.command znovu."
  fi
  [ "$(node_major)" -ge 24 ] || fail "Node.js 24+ se nepodařilo nainstalovat." \
    "Zkontroluj připojení k internetu a spusť instalaci znovu." \
    "Případně nainstaluj Node.js (LTS) ručně z https://nodejs.org."
fi
echo "[1/3] Node.js $(node --version) ✓"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[2/3] Instaluji pnpm $PNPM_VERSION…"
  npm install -g "pnpm@$PNPM_VERSION" || fail "pnpm se nepodařilo nainstalovat." \
    "Zkontroluj připojení k internetu a spusť instalaci znovu." \
    "Když to hlásí oprávnění (EACCES), otevři Terminál a zadej: sudo npm install -g pnpm@$PNPM_VERSION"
fi
echo "[2/3] pnpm $(pnpm --version) ✓"

echo "[3/3] Instaluji pomocné nástroje projektu…"
pnpm install || fail "Instalace nástrojů projektu selhala (podrobnosti výše)." \
  "Zkontroluj připojení k internetu a spusť instalaci znovu." \
  "Pokud je složka v iCloudu nebo na síťovém disku, přesuň ji do Dokumentů."
echo "[3/3] Nástroje projektu ✓"

mkdir -p data/input
printf '\nHotovo ✓\nDalší krok: ulož export z XTB do složky data/input (právě se otevřela) a spusť aktualizovat-mac.command.\n'
open data/input
printf '\nOkno můžeš zavřít.\n'
