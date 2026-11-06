# Stockera – příprava na Windows: Node.js 24+, pnpm, závislosti projektu. Spouští se přes instalace-windows.cmd.
$ErrorActionPreference = 'Stop'
$PnpmVersion = '10.18.1'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Update-PathFromSystem {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Get-NodeMajor {
  try { $v = & node --version 2>$null; if ($v -match '^v(\d+)') { return [int]$Matches[1] } } catch {}
  return 0
}
function Test-Pnpm {
  try { $v = & pnpm --version 2>$null; return [bool]$v } catch { return $false }
}
function Stop-Setup([string]$Message) {
  Write-Host ''
  Write-Host $Message -ForegroundColor Red
  exit 1
}

Write-Host '== Stockera: příprava ==' -ForegroundColor Cyan

if ((Get-NodeMajor) -lt 24) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Stop-Setup 'Chybí Node.js 24+. Nainstaluj ho z https://nodejs.org (verze LTS) a spusť instalaci znovu.'
  }
  Write-Host 'Instaluji Node.js (LTS) přes winget…'
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  Update-PathFromSystem
  if ((Get-NodeMajor) -lt 24) {
    Stop-Setup 'Node.js 24+ se nepodařilo připravit. Zavři okno a spusť instalaci znovu, případně nainstaluj Node.js z https://nodejs.org.'
  }
}
Write-Host "Node.js $(& node --version) ✓"

if (-not (Test-Pnpm)) {
  Write-Host "Instaluji pnpm $PnpmVersion…"
  & npm install -g "pnpm@$PnpmVersion"
  Update-PathFromSystem
  if (-not (Test-Pnpm)) { Stop-Setup "pnpm se nepodařilo nainstalovat. Zkus ručně: npm install -g pnpm@$PnpmVersion" }
}
Write-Host "pnpm $(& pnpm --version) ✓"

Write-Host 'Instaluji závislosti projektu…'
& pnpm install
if ($LASTEXITCODE -ne 0) { Stop-Setup 'pnpm install selhal (výpis je výše).' }

New-Item -ItemType Directory -Force -Path 'data\input' | Out-Null
Write-Host ''
Write-Host 'Hotovo ✓  Ulož export z XTB do složky data\input a spusť aktualizovat-windows.cmd.' -ForegroundColor Green
