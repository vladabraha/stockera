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

  echo "== Stockera: aktualizace aplikace =="
  echo "Stáhne novou verzi programu. Tvoje výpisy, databáze ani report se nikam neposílají ani nemažou."
  echo

  git --version >/dev/null 2>&1 || fail "Na tomto Macu chybí git." \
    "Pokud se otevřelo okno s nabídkou „Nástroje příkazového řádku“, klikni na Instalovat." \
    "Po dokončení spusť aktualizovat-aplikaci-mac.command znovu."
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "Tato složka není stažená přes git (nejspíš z ZIPu)." \
    "Stáhni aplikaci znovu příkazem git clone (viz NAVOD.md, část Aktualizace aplikace)." \
    "Do nové složky přesuň svou složku data (výpisy, databáze, nastavení)."
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    git status --short --untracked-files=no
    fail "Soubory programu (výše) jsou na tomto počítači upravené – aktualizace by je přepsala." \
      "Pokud úpravy nepotřebuješ, vrať je příkazem: git checkout -- ." \
      "Pak spusť aktualizovat-aplikaci-mac.command znovu."
  fi

  before=$(git rev-parse HEAD)
  echo "[1/3] Stahuji novou verzi…"
  git pull --ff-only || fail "Novou verzi se nepodařilo stáhnout (podrobnosti výše)." \
    "Zkontroluj připojení k internetu a spusť skript znovu."
  if [ "$before" = "$(git rev-parse HEAD)" ]; then
    printf '\nUž máš nejnovější verzi ✓\n\nOkno můžeš zavřít.\n'; exit 0
  fi
  echo "      Novinky:"; git --no-pager log --format='      • %s' "$before..HEAD"

  echo "[2/3] Doinstalovávám nástroje projektu…"
  command -v pnpm >/dev/null 2>&1 || fail "Chybí pnpm." "Spusť instalace-mac.command." "Pak spusť aktualizovat-aplikaci-mac.command znovu."
  pnpm install --frozen-lockfile || fail "Instalace nástrojů projektu selhala (podrobnosti výše)." \
    "Zkontroluj připojení k internetu a spusť skript znovu."

  echo "[3/3] Přegeneruji report novou verzí…"
  exec ./aktualizovat-mac.command
}
main "$@"; exit
