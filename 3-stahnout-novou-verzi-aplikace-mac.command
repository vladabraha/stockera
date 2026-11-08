#!/bin/sh
# Stockera – stáhne novou verzi aplikace z GitHubu (git pull), doinstaluje nástroje a přegeneruje report.
# Tvoje data (data/, out/) git ignoruje, takže zůstanou beze změny.
# Celá logika je ve funkci: sh čte skript průběžně a git pull může tento soubor přepsat.
main() {
  cd "$(dirname "$0")" || exit 1
  for p in /opt/homebrew/bin /usr/local/bin; do [ -d "$p" ] && PATH="$p:$PATH"; done
  export PATH

  fail() {
    printf '\n✗ %s\n\nCo dělat:\n' "$1"; shift
    i=1; for s in "$@"; do printf '  %d. %s\n' "$i" "$s"; i=$((i+1)); done
    printf '\nOkno můžeš zavřít.\n'; exit 1
  }

  echo "== Stockera: stažení nové verze aplikace =="
  echo "Stáhne novou verzi programu. Tvoje výpisy, databáze ani report se nikam neposílají ani nemažou."
  echo

  git --version >/dev/null 2>&1 || fail "Na tomto Macu chybí git." \
    "Pokud se otevřelo okno s nabídkou „Nástroje příkazového řádku“, klikni na Instalovat." \
    "Po dokončení spusť 3-stahnout-novou-verzi-aplikace-mac.command znovu."
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "Tato složka není stažená přes git (nejspíš z ZIPu)." \
    "Stáhni aplikaci znovu příkazem git clone (viz NAVOD.md, část 4. Nová verze aplikace)." \
    "Do nové složky přesuň svou složku data (výpisy, databáze, nastavení)."
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    git status --short --untracked-files=no
    fail "Soubory programu (výše) jsou na tomto počítači upravené – nová verze by je přepsala." \
      "Pokud úpravy nepotřebuješ, vrať je příkazem: git checkout -- ." \
      "Pak spusť 3-stahnout-novou-verzi-aplikace-mac.command znovu."
  fi

  before=$(git rev-parse HEAD)
  echo "[1/2] Stahuji novou verzi…"
  git pull --ff-only || fail "Novou verzi se nepodařilo stáhnout (podrobnosti výše)." \
    "Zkontroluj připojení k internetu a spusť skript znovu."
  if [ "$before" = "$(git rev-parse HEAD)" ]; then
    printf '\nUž máš nejnovější verzi ✓\n\nOkno můžeš zavřít.\n'; exit 0
  fi
  echo "      Novinky:"; git --no-pager log --format='      • %s' "$before..HEAD"

  echo "[2/2] Doinstalovávám nástroje projektu…"
  command -v pnpm >/dev/null 2>&1 || fail "Chybí pnpm." "Spusť 1-instalace-mac.command." "Pak spusť 3-stahnout-novou-verzi-aplikace-mac.command znovu."
  pv=$(node -p "require('./package.json').packageManager.split('@')[1]")
  # Bez přepínání verzí: jinak by pnpm sám stahoval jinou verzi mimo složku projektu.
  if [ "$(npm_config_manage_package_manager_versions=false pnpm --version 2>/dev/null)" != "$pv" ]; then
    echo "      Povyšuji pnpm na ${pv}…"
    npm install -g "pnpm@$pv" || fail "pnpm se nepodařilo povýšit." \
      "Zkontroluj připojení k internetu a spusť skript znovu." \
      "Když to hlásí oprávnění (EACCES), otevři Terminál a zadej: sudo npm install -g pnpm@$pv"
  fi
  pnpm install --frozen-lockfile || fail "Instalace nástrojů projektu selhala (podrobnosti výše)." \
    "Zkontroluj připojení k internetu a spusť skript znovu."

  printf '\nNová verze aplikace je nainstalovaná ✓\n'
  if ! ls data/input 2>/dev/null | grep -qiE '\.(xlsx|csv)$'; then
    printf '\nDalší krok: ulož výpisy z XTB (XLSX) nebo Trading 212 (CSV) do složky data/input\na spusť 2-vytvorit-report-mac.command.\n\nOkno můžeš zavřít.\n'
    exit 0
  fi
  printf '\n== Přegenerování reportu novou verzí ==\n'
  exec ./2-vytvorit-report-mac.command
}
main "$@"; exit
