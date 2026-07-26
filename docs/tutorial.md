# Tutorial

A guided first hour with `ompjob`. Every step has an expected output, so you can
tell a working setup from a broken one at each stage rather than at the end.

Follow it on the **machine that will run your jobs** — the always-on desktop or
server, not your laptop.

---

## Before you start

You need four things. Check all of them now; three of the four failure modes
later in this tutorial trace back to skipping this.

```powershell
# 1. Windows PowerShell 5.1 or later
$PSVersionTable.PSVersion

# 2. Administrator (required to register an S4U scheduled task)
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# 3. Node 18+
node --version

# 4. omp, installed AND authenticated -- this is the one people miss
omp -p "Reply with exactly SETUP_OK"
```

Expected from the last command: `SETUP_OK`. If it prints an auth error or hangs,
stop here and fix `omp` first. `ompjob` is a *supervisor*, not an agent — it can
only babysit an `omp` that already works.

## Step 1 — Install

```powershell
git clone https://github.com/AdityaIndoori/ompjob.git
cd ompjob
.\install.ps1
. $PROFILE
ompjob list
```

Expected:

```
installed
  profile   C:\Users\you\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1
  points at C:\path\to\ompjob\ompjob.ps1
...
no jobs
```

`no jobs` is success. The shim points at your clone, so `git pull` upgrades the
tool with no reinstall.

## Step 2 — Your first job

Start something trivial, and stay attached to watch it work.

```powershell
cd C:\some\project
ompjob start tour -Prompt "Tell me what this project is in one sentence" -Attach
```

You will see the job register, then the transcript begin:

```
started 'tour'
  cwd     C:\some\project
  detach  safe to close this terminal; survives reboot
  talk    ompjob attach tour

attached to "tour" - replaying history...
  job=tour  cwd=C:\some\project  state=waiting  turns=0
--- live --- (type to talk - Ctrl+C interrupt - Ctrl+D detach - /status /abort /stop /detach)
you   | Tell me what this project is in one sentence
agent | This is a ...
>
```

You are now at a prompt. **Type anything and press Enter** — it goes to the
agent. Try a follow-up question before moving on.

## Step 3 — Detach, and prove the job survived

Press **Ctrl+D**. You return to your shell:

```
detached (job keeps running)
```

Now prove the job is genuinely independent. Do not log out politely — kill the
connection the way a dead Wi-Fi link would.

```powershell
# from the machine you SSH'd FROM:
#   Windows:      taskkill /F /IM ssh.exe
#   macOS/Linux:  pkill -9 ssh
```

Reconnect and look:

```powershell
ssh myhost
ompjob list
```

Expected — note `Clients 0`, meaning it is alive with nobody watching:

```
Job  State   Live Turns Clients Updated
---  -----   ---- ----- ------- -------
tour waiting True     2       0 2026-07-25T22:38:16.729Z
```

## Step 4 — Reattach and continue the conversation

```powershell
ompjob attach tour
```

The whole prior conversation replays in dim text, then a `--- live ---` marker,
then your prompt. **Ask it something that requires memory of Step 2** — for
example "what did I ask you first?" It will answer, because the session was
resumed, not restarted.

This is the point of the tool. Everything else is operations.

## Step 5 — Steer a job while it is working

Interactivity is not just talking between turns. Start something slow:

```powershell
ompjob attach tour
> Run bash 'sleep 60', then summarise what you have learned
```

While the tool call is running — the agent is busy — **type another message and
press Enter**:

```
> actually, keep the summary under 20 words
```

Your message lands mid-turn and the agent adapts. Under the hood the broker
sends `steer` instead of `prompt` when a turn is live; you never choose.

> [!NOTE]
> The agent never asks *you* questions. `omp`'s `ask` tool does not exist in RPC
> mode, deliberately — an unattended job that blocked for input would hang
> forever. Interaction is one-directional: you steer.

## Step 6 — Fire-and-forget messages

You do not always want a live terminal. Send one message and walk away:

```powershell
ompjob say tour "When you finish, write the summary to notes.md"
ompjob status tour
```

`status` shows the agent's most recent line, which is usually all you need:

```
  job        tour
  state      thinking (agent is working)
  broker     live, pipe ompjob-tour
  turns      4
  attached   0 client(s)
  last say   Writing notes.md now
```

## Step 7 — Recover an interrupted job

This is the step everyone skips and later needs. Simulate a crash — power loss,
a killed process, a forced reboot:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*tour*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

ompjob status tour
```

Expected — and note it says `interrupted`, **not** `finished`:

```
  state      interrupted
  broker     not running
  revive it:  ompjob revive tour
```

Bring it back:

```powershell
ompjob revive tour
```

```
revived 'tour' (session resumed)
```

`revive` restarts the broker with `omp -c`, so the conversation continues rather
than starting over. Interrupted jobs are also revived automatically at the next
reboot — which is exactly what you want, unless you don't, in which case
`ompjob rm` the job.

## Step 8 — Read the transcript without attaching

```powershell
ompjob logs tour -Tail 20
ompjob logs tour -Follow      # live tail, Ctrl+C to stop
```

Output is one labelled line per event:

```
user      | Tell me what this project is in one sentence
assistant | This is a ...
tool      | > bash {"command":"sleep 60"}
system    | broker up on \\.\pipe\ompjob-tour (resumed)
```

## Step 9 — Clean up

```powershell
ompjob stop tour       # shut the agent down, keep the transcript
ompjob rm   tour       # delete the job, its task, and its run directory
ompjob list
```

Expected: `no jobs`.

`stop` is reversible with `revive`. **`rm` is not** — it deletes the transcript
and unregisters the scheduled task.

---

## A realistic workflow

What this looks like once you stop testing and start using it:

```powershell
# Monday, 6pm, before leaving
ssh myhost
cd D:\projects\bigrefactor
ompjob start refactor -PromptFile .\plan.md -Model opus
# close the laptop

# Tuesday morning, from a coffee shop
ssh myhost
ompjob status refactor            # what did it get done?
ompjob attach refactor            # read the reasoning, correct course
> the migration script missed the audit tables, handle those too
# Ctrl+D

# Tuesday evening
ompjob logs refactor -Tail 50
```

Use `-PromptFile` for anything longer than a sentence. A carefully written brief
in a file beats a long quoted string on a PowerShell command line, where quoting
rules will eventually bite you.

## Where to go next

- **[Reference](reference.html)** — every command, flag, state, and file
- **[Security](security.html)** — read before you trust this with admin rights
