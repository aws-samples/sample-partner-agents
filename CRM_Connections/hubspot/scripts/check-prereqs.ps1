<#
.SYNOPSIS
  Workshop prerequisite checker / installer for Windows.

.DESCRIPTION
  Verifies every tool the HubSpot <-> AWS Partner Central workshops need,
  prints a status table, and (with -Install) installs anything missing
  via winget (preferred) or Chocolatey.

.PARAMETER Install
  Install missing/outdated tools instead of only reporting them.

.PARAMETER Agent
  Agent workshop mode - skips the Python check (CRM mode only).

.EXAMPLE
  .\scripts\check-prereqs.ps1
  .\scripts\check-prereqs.ps1 -Install
  .\scripts\check-prereqs.ps1 -Agent

.NOTES
  Run in PowerShell. The deploy scripts themselves still require Git Bash,
  but this checker is pure PowerShell so it runs on a vanilla Windows box
  before Git Bash is even installed.

  Exit code: 0 if all required tools satisfied, 1 otherwise.
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Agent
)

$ErrorActionPreference = 'Continue'

# ---- installer detection ----------------------------------------------------
$pkgMgr = $null
if (Get-Command winget -ErrorAction SilentlyContinue) { $pkgMgr = 'winget' }
elseif (Get-Command choco -ErrorAction SilentlyContinue) { $pkgMgr = 'choco' }

$missing = New-Object System.Collections.Generic.List[string]

function Get-Version {
  param([string]$Text)
  if ($Text -match '(\d+)\.(\d+)(\.\d+)?') { return $Matches[0] }
  return $null
}

function Compare-Version {
  # returns $true if $Have >= $Need
  param([string]$Have, [string]$Need)
  try {
    $h = [version]([regex]::Match($Have, '\d+(\.\d+){0,3}').Value)
    $n = [version]([regex]::Match($Need, '\d+(\.\d+){0,3}').Value)
    return $h -ge $n
  } catch { return $false }
}

function Test-Tool {
  param(
    [string]$Key, [string]$Label, [string]$Cmd,
    [string]$VersionArg, [string]$MinVersion, [string]$WingetId, [string]$ChocoId
  )
  $exe = Get-Command $Cmd -ErrorAction SilentlyContinue
  if (-not $exe) {
    Write-Host ("  {0,-16} " -f $Label) -NoNewline
    Write-Host "X not found" -ForegroundColor Red
    $script:missing.Add($Key)
    return
  }
  $raw = ''
  try { $raw = (& $Cmd $VersionArg 2>&1 | Select-Object -First 1) } catch { $raw = '' }
  $cur = Get-Version ([string]$raw)
  Write-Host ("  {0,-16} " -f $Label) -NoNewline
  if ([string]::IsNullOrEmpty($MinVersion) -or [string]::IsNullOrEmpty($cur)) {
    $shown = if ($cur) { $cur } else { 'installed' }
    Write-Host ("OK {0}" -f $shown) -ForegroundColor Green
    return
  }
  if (Compare-Version $cur $MinVersion) {
    Write-Host ("OK {0} (>= {1})" -f $cur, $MinVersion) -ForegroundColor Green
  } else {
    Write-Host ("! {0} (need >= {1})" -f $cur, $MinVersion) -ForegroundColor Yellow
    $script:missing.Add($Key)
  }
}

Write-Host ""
Write-Host "=== Workshop prerequisite check (Windows) ===" -ForegroundColor Cyan
$pkgShown = if ($pkgMgr) { $pkgMgr } else { 'none detected' }
Write-Host ("Package manager: {0}" -f $pkgShown)
Write-Host ""

# Tool table: key, label, command, version-arg, min-version, winget-id, choco-id
Test-Tool node   'Node.js'     'node'   '--version'  '22'    'OpenJS.NodeJS.LTS'      'nodejs-lts'
Test-Tool npm    'npm'         'npm'    '--version'  ''      ''                        ''
Test-Tool aws    'AWS CLI'     'aws'    '--version'  '2.15'  'Amazon.AWSCLI'           'awscli'
Test-Tool git    'Git'         'git'    '--version'  ''      'Git.Git'                 'git'
Test-Tool hs     'HubSpot CLI' 'hs'     '--version'  '8.6'   ''                        ''
if (-not $Agent) {
  Test-Tool python 'Python 3'  'python' '--version'  '3.11'  'Python.Python.3.11'     'python'
}

Write-Host ""
if ($missing.Count -eq 0) {
  Write-Host "All required tools satisfied." -ForegroundColor Green
  Write-Host ""
  exit 0
}

Write-Host ("Missing or outdated: {0}" -f ($missing -join ', ')) -ForegroundColor Yellow
Write-Host ""

if (-not $Install) {
  Write-Host "Re-run with -Install to install the missing tools," -ForegroundColor DarkGray
  Write-Host "or install them manually (see docs/workshop.md section 0)." -ForegroundColor DarkGray
  Write-Host ""
  exit 1
}

# ---- install path -----------------------------------------------------------
if (-not $pkgMgr) {
  Write-Host "No package manager found." -ForegroundColor Red
  Write-Host "Install winget (App Installer from the Microsoft Store) or Chocolatey,"
  Write-Host "then re-run with -Install. Manual install steps are in docs/workshop.md section 0."
  exit 1
}

$wingetIds = @{ node='OpenJS.NodeJS.LTS'; aws='Amazon.AWSCLI'; git='Git.Git'; python='Python.Python.3.11' }
$chocoIds  = @{ node='nodejs-lts';        aws='awscli';        git='git';     python='python' }

$failed = New-Object System.Collections.Generic.List[string]
Write-Host ("=== Installing missing tools via {0} ===" -f $pkgMgr) -ForegroundColor Cyan

foreach ($key in $missing) {
  # HubSpot CLI + npm ship with / via node, so install via npm once node exists.
  if ($key -eq 'hs') {
    Write-Host "  -> npm i -g @hubspot/cli@latest"
    npm i -g '@hubspot/cli@latest'
    if ($LASTEXITCODE -ne 0) { $failed.Add('hs') }
    continue
  }
  if ($key -eq 'npm') { continue }   # comes with node

  if ($pkgMgr -eq 'winget') {
    $id = $wingetIds[$key]
    if (-not $id) { continue }
    Write-Host ("  -> winget install --id {0} -e --silent" -f $id)
    winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { $failed.Add($key) }
  } else {
    $id = $chocoIds[$key]
    if (-not $id) { continue }
    Write-Host ("  -> choco install {0} -y" -f $id)
    choco install $id -y
    if ($LASTEXITCODE -ne 0) { $failed.Add($key) }
  }
}

Write-Host ""
if ($failed.Count -eq 0) {
  Write-Host "Install complete. Open a NEW terminal (so PATH refreshes), then re-run without -Install to verify." -ForegroundColor Green
  Write-Host ""
  exit 0
}
Write-Host ("Some installs failed: {0}" -f ($failed -join ', ')) -ForegroundColor Red
Write-Host "Install those manually - see docs/workshop.md section 0."
Write-Host ""
exit 1
