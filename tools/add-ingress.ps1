# Add the ompjob.aindoori.com ingress rule to the live cloudflared config.
#
# Safety properties, in order:
#   1. timestamped backup + hash recorded before any write
#   2. the new rule is INSERTED BEFORE the terminal http_status:404 catch-all
#      (appending after it is a hard cloudflared validation failure, and would
#      take every hostname down on the next restart)
#   3. `ingress validate` must pass, and every pre-existing hostname must still
#      resolve to its original service, or the backup is restored immediately
#   4. NOTHING is restarted here. Restart happens out-of-band.
$ErrorActionPreference = 'Stop'

$cfExe = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$cfg   = "$env:USERPROFILE\.cloudflared\config.yml"
$new   = 'ompjob.aindoori.com'
$svc   = 'http://127.0.0.1:8795'

if (-not (Test-Path -LiteralPath $cfg)) { throw "config not found: $cfg" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak   = "$cfg.bak-$stamp"
Copy-Item -LiteralPath $cfg -Destination $bak -Force
'backup      = ' + $bak
'backup_hash = ' + (Get-FileHash -LiteralPath $bak -Algorithm SHA256).Hash

$lines = [IO.File]::ReadAllLines($cfg)

if ($lines -match [regex]::Escape($new)) { 'ALREADY_PRESENT - no change'; return }

# Locate the terminal catch-all: a rule with a service but no hostname.
$idx = -1
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i] -match '^\s*-\s*service:\s*http_status:404') { $idx = $i; break }
}
if ($idx -lt 0) { throw 'catch-all (- service: http_status:404) not found; refusing to guess placement' }
'catchall_at = line ' + ($idx + 1)

$before = $lines[0..($idx - 1)]
$after  = $lines[$idx..($lines.Length - 1)]
$insert = @("  - hostname: $new", "    service: $svc")

# ASCII only, LF, no BOM: the same discipline the .ps1 files require.
$out = New-Object System.Text.StringBuilder
foreach ($l in ($before + $insert + $after)) { [void]$out.Append($l); [void]$out.Append("`n") }
[IO.File]::WriteAllText($cfg, $out.ToString(), (New-Object System.Text.UTF8Encoding($false)))

# ---- validate, and restore on ANY doubt -----------------------------------
$fail = $null

$v = & $cfExe tunnel --config $cfg ingress validate 2>&1 | Out-String
'validate    = ' + ($v -replace "`r?`n", ' | ').Trim()
if ($v -notmatch 'OK') { $fail = 'ingress validate did not report OK' }

if (-not $fail) {
    # Every hostname, old and new, must map to the service we expect.
    $expect = @{
        'https://ssh.aindoori.com'        = 'ssh://127.0.0.1:22'
        'https://oc.aindoori.com'         = 'http://127.0.0.1:4096'
        'https://openclaw.aindoori.com'   = 'http://127.0.0.1:18789'
        'https://nexus.aindoori.com'      = 'http://127.0.0.1:8757'
        'https://nexuscity.aindoori.com'  = 'http://127.0.0.1:8757'
        'https://forge.aindoori.com'      = 'http://127.0.0.1:8791'
        "https://$new"                    = $svc
    }
    foreach ($k in $expect.Keys) {
        $r = & $cfExe tunnel --config $cfg ingress rule $k 2>&1 | Out-String
        if ($r -notmatch [regex]::Escape($expect[$k])) {
            $fail = "rule check failed for $k (expected $($expect[$k]))"
            break
        }
    }
    'rule_checks = ' + $(if ($fail) { 'FAILED - ' + $fail } else { 'all ' + $expect.Count + ' hostnames map correctly' })
}

# The catch-all must still be the final ingress entry.
$tail = ([IO.File]::ReadAllLines($cfg) | Where-Object { $_.Trim() } )[-1]
'last_line   = ' + $tail.Trim()
if ($tail -notmatch 'http_status:404') { $fail = 'catch-all is no longer the last ingress rule' }

if ($fail) {
    Copy-Item -LiteralPath $bak -Destination $cfg -Force
    'RESULT      = ROLLED BACK (' + $fail + ')'
    exit 1
}

'RESULT      = OK - config staged, service NOT yet restarted'
