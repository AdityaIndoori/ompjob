# Security

`ompjob` runs an AI agent **unattended, with administrator privileges, and with
tool approval disabled**. Read this before installing it.

## What the threat model actually is

| Property | Consequence |
|---|---|
| Jobs run via a Scheduled Task with `RunLevel: Highest` | The agent has full local administrator rights. |
| Jobs run `omp --auto-approve` | Every tool call the agent makes is approved automatically. No human gate. |
| The broker auto-answers extension confirmations | An extension asking "are you sure?" gets `yes` even with nobody attached. |
| `LogonType: S4U` + `AtStartup` trigger | An interrupted job is revived after reboot and resumed, unattended. |
| The control pipe has a default DACL | Any local process able to open `\\.\pipe\ompjob-<name>` can inject instructions into that elevated agent. |
| Transcripts are plaintext | `transcript.jsonl`, `render.log`, `inbox.jsonl` and `status.json` contain the full conversation, unencrypted, under your job root. |

**Only run `ompjob` on a machine you fully control, whose local accounts you
trust, and whose contents you would be willing to hand to a script.**

## Reducing the blast radius

- **Drop the elevation.** If your jobs do not need admin, edit the
  `New-ScheduledTaskPrincipal` call in `ompjob.ps1` and remove
  `-RunLevel Highest`. Everything else keeps working; S4U is what provides
  logon independence, not the elevation.
- **Scope the prompt.** Pass `-Cwd` so the agent starts in the project it is
  meant to touch.
- **Protect the job root.** Treat it as secret material. Restrict it with
  `icacls` if other accounts exist on the machine.
- **Stop reboot revival** for a job you are done with: `ompjob rm <name>`
  removes the task and the `AtStartup` trigger with it.

## Full teardown

```powershell
ompjob stop <name>
ompjob rm   <name>          # unregisters the task, deletes the run directory

# verify nothing is left behind
Get-ScheduledTask -TaskName 'ompjob-*'
[IO.Directory]::GetFiles('\\.\pipe\') -like '*ompjob-*'
```

Then remove the `function ompjob` line from your PowerShell `$PROFILE`.

## Reporting a vulnerability

Open a GitHub issue, or use GitHub's private vulnerability reporting on this
repository. Please do not include transcripts or prompts in a public report --
they routinely contain source code and credentials.
