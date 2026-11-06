#!/bin/sh
# Stockera – načte výpisy z data/input, stáhne ceny a vytvoří out/stockera.html.
cd "$(dirname "$0")" || exit 1
for p in /opt/homebrew/bin /usr/local/bin; do [ -d "$p" ] && PATH="$p:$PATH"; done
export PATH

finish() { printf '\n'; printf 'Okno můžeš zavřít.\n'; exit "$1"; }

v=$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')
if [ "${v:-0}" -lt 24 ]; then
  printf '\n✗ Na tomto Macu chybí Node.js 24 nebo novější.\n\nCo dělat:\n  1. Spusť nejdřív instalace-mac.command (dvojklikem).\n  2. Pak spusť aktualizovat-mac.command znovu.\n'
  finish 1
fi

if node --disable-warning=ExperimentalWarning src/cli/update.ts; then
  printf '\nOtevírám report v prohlížeči…\n'
  open out/stockera.html
  finish 0
else
  printf '\nAktualizace se nedokončila – co udělat, je vypsané výše.\n'
  [ -f data/logs/chyby.log ] && printf 'Technické podrobnosti pro případnou pomoc: data/logs/chyby.log\n'
  finish 1
fi
