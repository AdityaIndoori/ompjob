# Register the ompjob docs site as a reboot-surviving Scheduled Task.
# Run on the host that serves the site. Requires admin (S4U registration).
$ErrorActionPreference = 'Stop'

$root = 'D:\ompjob-site'
$node = (Get-Command node -ErrorAction Stop).Source
$sid  = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value

$act = New-ScheduledTaskAction -Execute $node `
         -Argument "`"$root\tools\serve-site.js`" `"$root\site`" 8795" `
         -WorkingDirectory $root

# Deliberately NOT -RunLevel Highest: this is a publicly reachable web process
# and needs no privilege beyond reading its own document root.
$pri = New-ScheduledTaskPrincipal -UserId $sid -LogonType S4U

$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
         -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
         -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName 'ompjob-docs-site' -Action $act -Principal $pri `
    -Settings $set -Trigger (New-ScheduledTaskTrigger -AtStartup) -Force | Out-Null

Start-ScheduledTask -TaskName 'ompjob-docs-site'
Start-Sleep -Seconds 4

$listen = Get-NetTCPConnection -LocalPort 8795 -State Listen -ErrorAction SilentlyContinue
'task_state = ' + (Get-ScheduledTask -TaskName 'ompjob-docs-site').State
'listening  = ' + (($listen | ForEach-Object { $_.LocalAddress + ':' + $_.LocalPort }) -join ', ')
try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8795/' -UseBasicParsing -TimeoutSec 10
    'local_http  = ' + $r.StatusCode + ' ' + $r.Headers['Content-Type']
} catch {
    'local_http  = FAILED ' + $_.Exception.Message
}
