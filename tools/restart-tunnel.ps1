# Restart cloudflared OUT-OF-BAND, with automatic rollback.
#
# Why a scheduled task instead of `Restart-Service` here: restarting the tunnel
# severs every connection it carries, including the SSH session that would be
# running the command. A child of that session can be torn down mid-restart,
# leaving the service STOPPED with nothing alive to start it -- and no way back
# in, because SSH rides the same tunnel.
#
# So: register a one-shot S4U task that owns the whole restart-and-verify cycle,
# start it, and let the SSH session die. If the service does not come back
# Running, the task restores the newest backup and starts it again.
$ErrorActionPreference = 'Stop'

$log = 'D:\ompjob-site\restart.log'
$sid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value

# Single-quoted here-string: this body is data, expanded only inside the task.
$body = @'
$log = 'D:\ompjob-site\restart.log'
function W($m) { Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o') + '  ' + $m) }
$cfg = 'C:\Users\indoo\.cloudflared\config.yml'

W 'restart requested'
try { Stop-Service cloudflared -Force -ErrorAction Stop } catch { W ('stop threw: ' + $_.Exception.Message) }
Start-Sleep -Seconds 3
try { Start-Service cloudflared -ErrorAction Stop } catch { W ('start threw: ' + $_.Exception.Message) }

Start-Sleep -Seconds 12
$st = (Get-Service cloudflared).Status
W ('status after restart = ' + $st)

if ($st -ne 'Running') {
    $bak = Get-ChildItem "$cfg.bak-*" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($bak) {
        W ('ROLLING BACK to ' + $bak.Name)
        Copy-Item -LiteralPath $bak.FullName -Destination $cfg -Force
    }
    Start-Sleep -Seconds 2
    try { Start-Service cloudflared -ErrorAction Stop } catch { W ('rollback start threw: ' + $_.Exception.Message) }
    Start-Sleep -Seconds 8
    W ('status after rollback = ' + (Get-Service cloudflared).Status)
} else {
    W 'OK - service Running with new config'
}
'@

$scriptPath = 'D:\ompjob-site\tools\_do-restart.ps1'
[IO.File]::WriteAllText($scriptPath, $body, (New-Object System.Text.UTF8Encoding($false)))
Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue

$act = New-ScheduledTaskAction -Execute 'powershell.exe' `
         -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`""
$pri = New-ScheduledTaskPrincipal -UserId $sid -LogonType S4U -RunLevel Highest
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
         -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'ompjob-cf-restart' -Action $act -Principal $pri `
    -Settings $set -Force | Out-Null

Start-ScheduledTask -TaskName 'ompjob-cf-restart'
'restart task started out-of-band; this SSH session may now drop'
'watch: D:\ompjob-site\restart.log'
