#!/bin/sh
# Stockera – načte nové výpisy z data/input, stáhne ceny a vytvoří out/stockera.html.
cd "$(dirname "$0")" || exit 1
for p in /opt/homebrew/bin /usr/local/bin; do [ -d "$p" ] && PATH="$p:$PATH"; done
export PATH
pnpm update-data && open out
