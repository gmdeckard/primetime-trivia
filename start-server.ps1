# Start PrimeTime Trivia on Windows.
#
#   .\start-server.ps1
#
# The companion to start-server.sh, for running the whole thing on the laptop
# that drives the TV instead of on a separate box. That arrangement has one
# real advantage beyond simplicity: the browser's wake lock only works in a
# secure context, which http://localhost is and http://192.168.x.x is not. Open
# the big screen at the localhost address this prints and the page can hold the
# screen awake by itself, which it can never do when the server is elsewhere.
#
# Stop it with Ctrl+C in this window.

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node is not installed, or not on PATH. Install Node 20 or newer from nodejs.org." -ForegroundColor Red
  exit 1
}

$nodeMajor = [int](((node --version) -replace '^v', '') -split '\.')[0]
if ($nodeMajor -lt 20) {
  Write-Host "Node $nodeMajor is too old. This needs Node 20 or newer." -ForegroundColor Red
  exit 1
}

# dist/ is not in git, so a pull brings source only. Rebuild whenever any source
# is newer than what was built from it — the same rule as start-server.sh.
# content/ is read at run time and is not a build input.
function Test-NeedsBuild {
  foreach ($ref in @('dist\src\server\index.js', 'dist\client\index.html')) {
    if (-not (Test-Path $ref)) { return $true }
    $built = (Get-Item $ref).LastWriteTimeUtc
    $newer = Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue `
      -Path 'src', 'shared', 'package.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.server.json' |
      Where-Object { $_.LastWriteTimeUtc -gt $built } | Select-Object -First 1
    if ($newer) { return $true }
  }
  return $false
}

if (Test-NeedsBuild) {
  if (Test-Path 'dist\client\index.html') {
    Write-Host "Sources changed since the last build - rebuilding..."
  } else {
    Write-Host "Not built yet - building (a few minutes the first time)..."
  }
  npm install --no-fund --no-audit
  npm run build
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed. The old build is still in place; fix the error above and run this again." -ForegroundColor Red
    exit 1
  }
}

if (-not $env:PORT) { $env:PORT = '8080' }
if (-not $env:PRIMETIME_VENUE) { $env:PRIMETIME_VENUE = 'PrimeTime Trivia' }

# The firewall is what actually stops a night: Windows blocks inbound Node by
# default, and blocks almost everything when the network is classified Public.
# Checked rather than assumed, because the symptom is "my phone just spins".
$profileName = (Get-NetConnectionProfile -ErrorAction SilentlyContinue |
  Where-Object { $_.IPv4Connectivity -ne 'Disconnected' } |
  Select-Object -First 1).NetworkCategory
if ($profileName -eq 'Public') {
  Write-Host ""
  Write-Host "  WARNING: this network is classified Public, so Windows will block players." -ForegroundColor Yellow
  Write-Host "  Settings > Network & internet > Wi-Fi > (your network) > set to Private." -ForegroundColor Yellow
}

$rule = Get-NetFirewallRule -DisplayName 'PrimeTime Trivia' -ErrorAction SilentlyContinue
if (-not $rule) {
  Write-Host ""
  Write-Host "  No firewall rule for this app yet. If phones cannot reach it, run once as" -ForegroundColor Yellow
  Write-Host "  Administrator:" -ForegroundColor Yellow
  Write-Host "    New-NetFirewallRule -DisplayName 'PrimeTime Trivia' -Direction Inbound ``" -ForegroundColor Yellow
  Write-Host "      -Action Allow -Protocol TCP -LocalPort $env:PORT -Profile Private" -ForegroundColor Yellow
}

# ------------------------------------------------- which address the room uses
# The companion to choose_host_ip in start-server.sh, and the same reasoning:
# the wrong address on the QR code is the failure that looks healthy here and
# stops every phone in the room. The candidate list comes from the server
# (dist\src\server\interfaces.js) so there is one implementation of "which
# address can the room reach", not two that disagree.
#
# Skipped when input is redirected, so a scripted start is never left waiting
# on a prompt nobody is there to answer.
function Select-HostIp {
  if ($env:PRIMETIME_HOST_IP) {
    Write-Host "  Using PRIMETIME_HOST_IP=$($env:PRIMETIME_HOST_IP) (already set)."
    return
  }
  if ($env:PRIMETIME_NO_PICK) { return }
  if ([Console]::IsInputRedirected) { return }

  $raw = @(& node 'dist\src\server\interfaces.js' 2>$null | Where-Object { $_ -match '\S' })
  # One candidate is not a choice worth stopping for.
  if ($raw.Count -le 1) { return }

  $candidates = $raw | ForEach-Object {
    $parts = $_ -split "`t", 3
    [pscustomobject]@{ Address = $parts[0]; Iface = $parts[1]; Note = $parts[2] }
  }

  Write-Host ""
  Write-Host "  Which address will the phones use?"
  for ($i = 0; $i -lt $candidates.Count; $i++) {
    $c = $candidates[$i]
    $line = "    {0}) {1,-15} {2,-16}" -f ($i + 1), $c.Address, $c.Iface
    if ($c.Note) { $line += " $($c.Note)" }
    # A flagged adapter is the trap; colour it so it is not read past at speed.
    if ($c.Note) { Write-Host $line -ForegroundColor DarkYellow } else { Write-Host $line }
  }
  Write-Host "    o) something else - type an address"
  Write-Host ""

  foreach ($attempt in 1..3) {
    $reply = (Read-Host "  Pick 1-$($candidates.Count), o, or Enter for 1").Trim()
    if (-not $reply) { $reply = '1' }
    if ($reply -eq 'o' -or $reply -eq 'O') {
      $typed = (Read-Host "  Address").Trim()
      # No validation beyond non-empty: an operator overriding our guess on
      # purpose may know something we do not.
      if ($typed) {
        $env:PRIMETIME_HOST_IP = $typed
        Write-Host "  Using $typed."
        return
      }
      Write-Host "  Nothing typed."
      continue
    }
    if ($reply -notmatch '^\d+$') { Write-Host "  Not a number."; continue }
    $n = [int]$reply
    if ($n -lt 1 -or $n -gt $candidates.Count) { Write-Host "  Out of range."; continue }
    $env:PRIMETIME_HOST_IP = $candidates[$n - 1].Address
    Write-Host "  Using $($env:PRIMETIME_HOST_IP)."
    return
  }
  # Three bad answers in a row: fall through to the server's ranking rather
  # than block a night on a prompt.
  Write-Host "  Falling back to the automatic pick."
}

Select-HostIp

Write-Host ""
Write-Host "Starting on port $($env:PORT). Leave this window open - closing it ends the night."
Write-Host "Open the big screen at http://localhost:$($env:PORT)/host so it can keep itself awake."
Write-Host ""

node dist\src\server\index.js
