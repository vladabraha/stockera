#!/bin/sh
# Stockera – příprava na macOS: Node.js 24+, pnpm, závislosti projektu. Stačí spustit dvojklikem.
cd "$(dirname "$0")" || exit 1
PNPM_VERSION=10.18.1
for p in /opt/homebrew/bin /usr/local/bin; do [ -d "$p" ] && PATH="$p:$PATH"; done
export PATH

fail() { printf '\n%s\n' "$1"; exit 1; }
node_major() { v=$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'); echo "${v:-0}"; }

echo "== Stockera: příprava =="

if [ "$(node_major)" -lt 24 ]; then
  if command -v brew >/dev/null 2>&1; then
    echo "Instaluji Node.js přes Homebrew…"
    brew install node || brew upgrade node
  else
    open https://nodejs.org/ 2>/dev/null
    fail "Chybí Node.js 24+. Stáhni instalátor (LTS) z https://nodejs.org, nainstaluj a spusť tento soubor znovu."
  fi
  [ "$(node_major)" -ge 24 ] || fail "Node.js 24+ se nepodařilo připravit – nainstaluj ho z https://nodejs.org."
fi
echo "Node.js $(node --version) ✓"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "Instaluji pnpm $PNPM_VERSION…"
  npm install -g "pnpm@$PNPM_VERSION" || fail "pnpm se nepodařilo nainstalovat. Zkus v Terminálu: sudo npm install -g pnpm@$PNPM_VERSION"
fi
echo "pnpm $(pnpm --version) ✓"

echo "Instaluji závislosti projektu…"
pnpm install || fail "pnpm install selhal (výpis je výše)."

mkdir -p data/input
printf '\nHotovo ✓  Ulož export z XTB do složky data/input a spusť aktualizovat-mac.command.\n'
