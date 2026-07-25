#requires -Version 5.1
<#
  _launch.ps1 - executed by the Windows Scheduled Task; supervises the broker.

  Kept deliberately thin: the broker owns all agent logic. This wrapper only
  handles crash-vs-clean-exit and marks the run terminal so an AtStartup
  trigger never re-runs finished work.
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$RunDir)

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false)

$metaPath = Join-Path $RunDir 'meta.json'
$donePath = Join-Path $RunDir 'done.json'
if (-not (Test-Path -LiteralPath $metaPath)) { throw "missing meta.json in $RunDir" }

# Terminal states are sticky: the AtStartup trigger must not restart a job the
# user already stopped or that already ran to completion.
if (Test-Path -LiteralPath $donePath) { exit 0 }

$meta = [IO.File]::ReadAllText($metaPath) | ConvertFrom-Json

# A live broker means the job is already up (duplicate trigger); do nothing.
if ([IO.Directory]::GetFiles('\\.\pipe\') -contains ('\\.\pipe\ompjob-' + $meta.name)) { exit 0 }

# On any relaunch after the first, resume the omp session instead of restarting.
$statusPath = Join-Path $RunDir 'status.json'
if (Test-Path -LiteralPath $statusPath) {
    $meta | Add-Member -NotePropertyName resume -NotePropertyValue $true -Force
    [IO.File]::WriteAllText($metaPath, ($meta | ConvertTo-Json -Depth 6), $utf8)
}

$broker = Join-Path (Split-Path -Parent $PSCommandPath) 'broker.js'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found on PATH' }

& $node $broker $RunDir 2>> (Join-Path $RunDir 'err.log')
$code = $LASTEXITCODE

[IO.File]::WriteAllText($donePath, (@{
    endedAt  = (Get-Date).ToString('o')
    exitCode = $code
} | ConvertTo-Json), $utf8)

exit $code
