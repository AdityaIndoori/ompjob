# install.ps1 - add an `ompjob` function to your PowerShell profile.
#
# Run from the repo:  .\install.ps1
# The shim points at THIS checkout, so `git pull` updates the tool in place.
[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = 'Stop'

$cli = Join-Path (Split-Path -Parent $PSCommandPath) 'ompjob.ps1'
if (-not (Test-Path -LiteralPath $cli)) { throw "ompjob.ps1 not found next to installer: $cli" }

if (-not (Test-Path -LiteralPath $PROFILE)) {
    New-Item -ItemType File -Path $PROFILE -Force | Out-Null
    Write-Host "created profile $PROFILE"
}

$body = Get-Content -LiteralPath $PROFILE -Raw -ErrorAction SilentlyContinue
if ($body -match 'function ompjob' -and -not $Force) {
    Write-Host "ompjob is already in your profile. Re-run with -Force to repoint it." -ForegroundColor Yellow
    Write-Host "  profile: $PROFILE"
    return
}

if ($body -match 'function ompjob') {
    # Drop the previous shim (marker line + function) before writing the new one.
    $kept = (Get-Content -LiteralPath $PROFILE) |
            Where-Object { $_ -notmatch 'function ompjob' -and $_ -notmatch '^# ompjob ' }
    Set-Content -LiteralPath $PROFILE -Value $kept -Encoding UTF8
}

Add-Content -LiteralPath $PROFILE -Value ''
Add-Content -LiteralPath $PROFILE -Value '# ompjob - detached, reboot-surviving interactive omp jobs'
Add-Content -LiteralPath $PROFILE -Value "function ompjob { & '$cli' @args }"

Write-Host "installed" -ForegroundColor Green
Write-Host "  profile   $PROFILE"
Write-Host "  points at $cli"
Write-Host ""
Write-Host "Open a new shell (or run: . `$PROFILE) then try:  ompjob list"
