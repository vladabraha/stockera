# Stockera – příprava na Windows: Node.js 24+, pnpm, závislosti projektu. Spouští se přes 1-instalace-windows.cmd.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Update-PathFromSystem {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Get-NodeMajor {
  try { $v = & node --version 2>$null; if ($v -match '^v(\d+)') { return [int]$Matches[1] } } catch {}
  return 0
}
function Test-Pnpm {
  # Bez přepínání verzí: jinak by pnpm sám stahoval jinou verzi mimo složku projektu.
  $env:npm_config_manage_package_manager_versions = 'false'
  try { $v = & pnpm --version 2>$null; return ($v -eq $PnpmVersion) } catch { return $false }
  finally { Remove-Item Env:npm_config_manage_package_manager_versions -ErrorAction SilentlyContinue }
}
function Stop-Setup([string]$Message, [string[]]$Steps) {
  Write-Host ''
  Write-Host "[CHYBA] $Message" -ForegroundColor Red
  if ($Steps) {
    Write-Host ''
    Write-Host 'Co dělat:'
    $i = 1
    foreach ($s in $Steps) { Write-Host "  $i. $s"; $i++ }
  }
  exit 1
}

try {
  Write-Host '== Stockera: příprava ==' -ForegroundColor Cyan
  Write-Host 'Stáhne a nainstaluje Node.js a pnpm (potřebuje internet, trvá pár minut). Tvoje data se nikam neposílají.'
  Write-Host ''

  if ((Get-NodeMajor) -lt 24) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      Stop-Setup 'Chybí Node.js 24+ a tento Windows ho neumí nainstalovat automaticky.' @(
        'Otevři https://nodejs.org a stáhni verzi LTS (tlačítko vlevo).',
        'Nainstaluj ji (stačí pořád klikat Další).',
        'Spusť 1-instalace-windows.cmd znovu.')
    }
    Write-Host '[1/3] Instaluji Node.js (LTS)…'
    Write-Host '      Windows se může zeptat „Chcete aplikaci povolit provádět změny?“ – potvrď Ano.' -ForegroundColor Yellow
    & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    Update-PathFromSystem
    if ((Get-NodeMajor) -lt 24) {
      Stop-Setup 'Node.js 24+ se nepodařilo nainstalovat.' @(
        'Zkontroluj připojení k internetu.',
        'Zavři toto okno a spusť 1-instalace-windows.cmd znovu.',
        'Když to nepomůže, nainstaluj Node.js (LTS) ručně z https://nodejs.org.')
    }
  }
  Write-Host "[1/3] Node.js $(& node --version) ✓" -ForegroundColor Green

  $PnpmVersion = (Get-Content 'package.json' -Raw | ConvertFrom-Json).packageManager.Split('@')[1]
  if (-not (Test-Pnpm)) {
    Write-Host "[2/3] Instaluji pnpm $PnpmVersion…"
    & npm install -g "pnpm@$PnpmVersion"
    Update-PathFromSystem
    if (-not (Test-Pnpm)) {
      Stop-Setup 'pnpm se nepodařilo nainstalovat.' @(
        'Zkontroluj připojení k internetu.',
        'Zavři toto okno a spusť 1-instalace-windows.cmd znovu (nové okno načte nové nastavení).')
    }
  }
  Write-Host "[2/3] pnpm $(& pnpm --version) ✓" -ForegroundColor Green

  Write-Host '[3/3] Instaluji pomocné nástroje projektu…'
  & pnpm install
  if ($LASTEXITCODE -ne 0) {
    Stop-Setup 'Instalace nástrojů projektu selhala (podrobnosti výše).' @(
      'Zkontroluj připojení k internetu a spusť 1-instalace-windows.cmd znovu.',
      'Pokud je složka na síťovém disku nebo v OneDrive, přesuň ji do Dokumentů.')
  }
  Write-Host '[3/3] Nástroje projektu ✓' -ForegroundColor Green

  New-Item -ItemType Directory -Force -Path 'data\input' | Out-Null
  Write-Host ''
  Write-Host 'Hotovo ✓' -ForegroundColor Green
  Write-Host 'Další krok: ulož export z XTB do složky data\input a spusť 2-vytvorit-report-windows.cmd.'
  if (Test-Path 'data\input') { Start-Process explorer.exe (Resolve-Path 'data\input') }
} catch {
  Stop-Setup "Nečekaná chyba: $($_.Exception.Message)" @(
    'Zavři okno a spusť 1-instalace-windows.cmd znovu.',
    'Když chyba trvá, nainstaluj Node.js (LTS) ručně z https://nodejs.org a zkus to znovu.')
}
