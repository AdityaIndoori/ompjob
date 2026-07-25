#requires -Version 5.1
<#
  ompjob - detached, reboot-surviving, INTERACTIVE omp jobs.

  Each job is a broker process (owning `omp --mode rpc`) launched by a Windows
  Scheduled Task with LogonType=S4U. That makes it independent of any SSH
  session, console, or interactive logon, needing no stored password.

  Attach and detach freely: the broker exposes a named pipe, replays the whole
  conversation on connect, then streams live. Typing while the agent works
  steers it mid-turn; typing while idle starts a new turn.

    ompjob start  <name> [-Prompt <t>|-PromptFile <p>] [-Cwd <d>] [-Model <m>] [-Attach] [-Force]
    ompjob attach <name>                  # replay history, then live; type to talk
    ompjob say    <name> <text...>        # one-shot message, no attach
    ompjob revive <name>                  # restart an interrupted job, resuming its session
    ompjob list
    ompjob status <name>
    ompjob logs   <name> [-Tail n] [-Follow]
    ompjob stop   <name>
    ompjob rm     <name> [-Force]

  Set OMPJOB_ROOT to relocate job state (default C:\ompjob).
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Command = 'list',
    [Parameter(Position = 1)][string]$Name,
    [Parameter(Position = 2, ValueFromRemainingArguments = $true)][string[]]$Rest,
    [string]$Prompt,
    [string]$PromptFile,
    [string]$Cwd,
    [string]$Model,
    [int]$Tail = 40,
    [switch]$Follow,
    [switch]$Attach,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
# Job root. Override with OMPJOB_ROOT to relocate (e.g. a machine with no D:).
# Bin defaults alongside this script so a cloned repo works without env setup.
$Root    = if ($env:OMPJOB_ROOT) { $env:OMPJOB_ROOT } else { 'C:\ompjob' }
$Bin     = Split-Path -Parent $PSCommandPath
$RunsDir = Join-Path $Root 'runs'
$utf8    = New-Object System.Text.UTF8Encoding($false)

function Fail($m) { Write-Host "ompjob: $m" -ForegroundColor Red; exit 1 }
function TaskName($n) { "ompjob-$n" }
function RunDir($n)   { Join-Path $RunsDir $n }
function PipeLive($n) { [IO.Directory]::GetFiles('\\.\pipe\') -contains ('\\.\pipe\ompjob-' + $n) }

function Get-Status($n) {
    $p = Join-Path (RunDir $n) 'status.json'
    if (-not (Test-Path -LiteralPath $p)) { return $null }
    try { [IO.File]::ReadAllText($p) | ConvertFrom-Json } catch { $null }
}

# The pipe is ground truth for liveness; status.json can be stale if the broker
# was killed hard. Reconcile rather than trusting either alone.
function Get-Truth($n) {
    $rd = RunDir $n
    if (-not (Test-Path -LiteralPath $rd)) { return [pscustomobject]@{ state = 'unknown' } }
    $st   = Get-Status $n
    $live = PipeLive $n
    $done = Test-Path -LiteralPath (Join-Path $rd 'done.json')
    # PS 5.1 has no if-expression; assign in statement form.
    $state = 'registered'
    if ($live) {
        $state = 'starting'
        if ($st -and $st.state) { $state = $st.state }
    }
    elseif ($done) { $state = 'finished' }
    elseif ($st)   { $state = 'interrupted' }
    [pscustomobject]@{
        state = $state; live = $live; raw = $st
        task  = (Get-ScheduledTask -TaskName (TaskName $n) -EA SilentlyContinue)
    }
}

function Require-Node {
    if (-not (Get-Command node -EA SilentlyContinue)) { Fail 'node not found on PATH' }
}

switch ($Command.ToLower()) {

  'start' {
    if (-not $Name) { Fail 'need a job name' }
    if ($Name -notmatch '^[A-Za-z0-9._-]+$') { Fail 'name must be [A-Za-z0-9._-]+' }
    Require-Node
    if ($PromptFile) {
        if (-not (Test-Path -LiteralPath $PromptFile)) { Fail "no such prompt file: $PromptFile" }
        $Prompt = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $PromptFile))
    }
    if (-not $Cwd) { $Cwd = (Get-Location).Path }
    if (-not (Test-Path -LiteralPath $Cwd)) { Fail "no such cwd: $Cwd" }
    $Cwd = (Resolve-Path -LiteralPath $Cwd).Path

    $t = Get-Truth $Name
    if ($t.live) { Fail "job '$Name' is already live (use: ompjob attach $Name)" }
    if ($t.state -ne 'unknown' -and -not $Force) {
        Fail "job '$Name' exists in state '$($t.state)' (use -Force to recreate, or: ompjob rm $Name)"
    }

    $rd = RunDir $Name
    Remove-Item -LiteralPath $rd -Recurse -Force -EA SilentlyContinue
    New-Item -ItemType Directory -Force -Path $rd | Out-Null
    [IO.File]::WriteAllText((Join-Path $rd 'meta.json'), (@{
        name = $Name; cwd = $Cwd; model = $Model
        prompt = $Prompt; resume = $false
        created = (Get-Date).ToString('o')
    } | ConvertTo-Json -Depth 5), $utf8)

    $sid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
    $act = New-ScheduledTaskAction -Execute 'powershell.exe' `
             -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Bin\_launch.ps1`" -RunDir `"$rd`"" `
             -WorkingDirectory $Cwd
    $pri = New-ScheduledTaskPrincipal -UserId $sid -LogonType S4U -RunLevel Highest
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
    Register-ScheduledTask -TaskName (TaskName $Name) -Action $act -Principal $pri -Settings $set `
             -Trigger (New-ScheduledTaskTrigger -AtStartup) -Force | Out-Null
    Start-ScheduledTask -TaskName (TaskName $Name)

    # Wait for the pipe so `-Attach` never races the broker's startup.
    $deadline = (Get-Date).AddSeconds(45)
    while (-not (PipeLive $Name) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 400 }
    if (-not (PipeLive $Name)) {
        Write-Host "started '$Name' but the broker pipe has not appeared yet" -ForegroundColor Yellow
        Write-Host "  check: ompjob status $Name   /   ompjob logs $Name"
        break
    }

    Write-Host "started '$Name'" -ForegroundColor Green
    Write-Host "  cwd     $Cwd"
    Write-Host "  detach  safe to close this terminal; survives reboot"
    Write-Host "  talk    ompjob attach $Name"
    if ($Attach) { & node (Join-Path $Bin 'attach.js') $Name }
  }

  'attach' {
    if (-not $Name) { Fail 'need a job name' }
    Require-Node
    $t = Get-Truth $Name
    if ($t.state -eq 'unknown') { Fail "no such job '$Name'" }
    if (-not $t.live) {
        Write-Host "job '$Name' is '$($t.state)' - no live broker to attach to." -ForegroundColor Yellow
        if ($t.state -eq 'interrupted') { Write-Host "  revive with: ompjob revive $Name" -ForegroundColor Yellow }
        Write-Host "  transcript:  ompjob logs $Name"
        exit 1
    }
    & node (Join-Path $Bin 'attach.js') $Name
  }

  'revive' {
    if (-not $Name) { Fail 'need a job name' }
    $t = Get-Truth $Name
    if ($t.state -eq 'unknown') { Fail "no such job '$Name'" }
    if ($t.live) { Fail "'$Name' is already live" }
    Remove-Item -LiteralPath (Join-Path (RunDir $Name) 'done.json') -Force -EA SilentlyContinue
    Start-ScheduledTask -TaskName (TaskName $Name)
    $deadline = (Get-Date).AddSeconds(45)
    while (-not (PipeLive $Name) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 400 }
    if (PipeLive $Name) { Write-Host "revived '$Name' (session resumed)" -ForegroundColor Green }
    else { Fail "revive did not bring up a broker; see: ompjob logs $Name" }
  }

  'say' {
    if (-not $Name) { Fail 'need a job name' }
    $text = ($Rest -join ' ').Trim()
    if (-not $text) { Fail 'need something to say' }
    if (-not (PipeLive $Name)) { Fail "job '$Name' has no live broker" }
    $pipe = New-Object IO.Pipes.NamedPipeClientStream('.', "ompjob-$Name", [IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(5000)
    $sw = New-Object IO.StreamWriter($pipe); $sw.AutoFlush = $true
    $sw.WriteLine((@{ type = 'input'; text = $text; who = $env:USERNAME } | ConvertTo-Json -Compress))
    Start-Sleep -Milliseconds 400
    $sw.Dispose(); $pipe.Dispose()
    Write-Host "sent to '$Name'" -ForegroundColor Green
  }

  'list' {
    if (-not (Test-Path -LiteralPath $RunsDir)) { Write-Host 'no jobs'; break }
    $rows = Get-ChildItem $RunsDir -Directory -EA SilentlyContinue | ForEach-Object {
        $t = Get-Truth $_.Name
        [pscustomobject]@{
            Job = $_.Name; State = $t.state; Live = $t.live
            Turns = $t.raw.turns; Clients = $t.raw.clients; Updated = $t.raw.updatedAt
        }
    }
    if (-not $rows) { Write-Host 'no jobs' } else { $rows | Format-Table -AutoSize }
  }

  'status' {
    if (-not $Name) { Fail 'need a job name' }
    $t = Get-Truth $Name
    if ($t.state -eq 'unknown') { Fail "no such job '$Name'" }
    $meta = [IO.File]::ReadAllText((Join-Path (RunDir $Name) 'meta.json')) | ConvertFrom-Json
    Write-Host ""
    Write-Host "  job        $Name"
    Write-Host "  state      $($t.state)$(if ($t.raw.streaming) { ' (agent is working)' })"
    Write-Host "  broker     $(if ($t.live) { 'live, pipe ompjob-' + $Name } else { 'not running' })"
    Write-Host "  cwd        $($meta.cwd)"
    Write-Host "  turns      $($t.raw.turns)"
    Write-Host "  attached   $($t.raw.clients) client(s)"
    Write-Host "  updated    $($t.raw.updatedAt)"
    if ($t.raw.lastText) {
        Write-Host "  last say   " -NoNewline
        Write-Host (($t.raw.lastText -split "`n")[-1].Trim()) -ForegroundColor Cyan
    }
    Write-Host ""
    if ($t.live)                     { Write-Host "  talk to it: ompjob attach $Name" -ForegroundColor Green }
    elseif ($t.state -eq 'interrupted') { Write-Host "  revive it:  ompjob revive $Name" -ForegroundColor Yellow }
    Write-Host ""
  }

  'logs' {
    if (-not $Name) { Fail 'need a job name' }
    $f = Join-Path (RunDir $Name) 'render.log'
    if (-not (Test-Path -LiteralPath $f)) { Fail "no transcript yet for '$Name'" }
    $fmt = {
        param($l)
        try { $o = $l | ConvertFrom-Json } catch { return $l }
        '{0,-9} | {1}' -f $o.kind, $o.text
    }
    if ($Follow) { Get-Content -LiteralPath $f -Tail $Tail -Wait | ForEach-Object { & $fmt $_ } }
    else         { Get-Content -LiteralPath $f -Tail $Tail      | ForEach-Object { & $fmt $_ } }
  }

  'stop' {
    if (-not $Name) { Fail 'need a job name' }
    if (PipeLive $Name) {
        $pipe = New-Object IO.Pipes.NamedPipeClientStream('.', "ompjob-$Name", [IO.Pipes.PipeDirection]::InOut)
        try {
            $pipe.Connect(4000)
            $sw = New-Object IO.StreamWriter($pipe); $sw.AutoFlush = $true
            $sw.WriteLine('{"type":"shutdown"}')
            Start-Sleep -Milliseconds 800
            $sw.Dispose()
        } catch { } finally { $pipe.Dispose() }
    }
    Start-Sleep -Milliseconds 500
    Stop-ScheduledTask -TaskName (TaskName $Name) -EA SilentlyContinue
    Write-Host "stopped '$Name'" -ForegroundColor Yellow
  }

  'rm' {
    if (-not $Name) { Fail 'need a job name' }
    if ((PipeLive $Name) -and -not $Force) { Fail "'$Name' is live; use: ompjob stop $Name (or -Force)" }
    Stop-ScheduledTask       -TaskName (TaskName $Name) -EA SilentlyContinue
    Unregister-ScheduledTask -TaskName (TaskName $Name) -Confirm:$false -EA SilentlyContinue
    Start-Sleep -Milliseconds 400
    Remove-Item -LiteralPath (RunDir $Name) -Recurse -Force -EA SilentlyContinue
    Write-Host "removed '$Name'" -ForegroundColor Yellow
  }

  default { Fail "unknown '$Command' (start|attach|say|revive|list|status|logs|stop|rm)" }
}
