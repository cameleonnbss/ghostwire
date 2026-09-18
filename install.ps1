# GhostWire — installateur Windows (PowerShell 5+)
# Usage : powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Stop'

function Say($m) { Write-Host "[ghostwire] $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "[ghostwire] OK  $m" -ForegroundColor Green }
function Die($m) { Write-Host "[ghostwire] ERREUR  $m" -ForegroundColor Red; exit 1 }

$RepoUrl = if ($env:GW_REPO_URL) { $env:GW_REPO_URL } else { 'https://github.com/OWNER/ghostwire' }
$Branch  = if ($env:GW_BRANCH)   { $env:GW_BRANCH }   else { 'main' }
$Dir     = if ($env:GW_INSTALL_DIR) { $env:GW_INSTALL_DIR } else { Join-Path $env:USERPROFILE 'ghostwire' }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die 'git requis : https://git-scm.com/download/win' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'Node.js >= 18 requis : https://nodejs.org' }

$nodeMajor = [int]((node -p 'process.versions.node.split(".")[0]'))
if ($nodeMajor -lt 18) { Die "Node >= 18 requis, trouve : $(node -v)" }

if (Test-Path (Join-Path $Dir '.git')) {
  Say "Mise a jour de $Dir..."
  git -C $Dir pull --ff-only
} else {
  Say "Clonage dans $Dir..."
  git clone --depth 1 -b $Branch $RepoUrl $Dir
}

Set-Location $Dir
Say 'Installation des dependances npm...'
npm install --omit=dev --no-audit --no-fund

Say 'Telechargement de wireproxy...'
node bin/ghostwire.js setup

$token = -join ((1..24) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
Ok "Installe dans $Dir"
Say "Demarrage :   node bin\ghostwire.js start"
Say "Avec token :  `$env:GW_TOKEN='$token'; node bin\ghostwire.js start"
