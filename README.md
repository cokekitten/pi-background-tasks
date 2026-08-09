# pi-background-tasks

A [pi](https://github.com/earendil-works/pi-coding-agent) tools extension: a
lightweight, first-class **background shell command** primitive, aiming at
tool-layer parity with grok's task system.

## Tools

| Tool | Description |
| --- | --- |
| `run_background` | One-shot detached shell command; returns a task id immediately. Completion auto-notifies the session. |
| `monitor` | Run a long-running command; EACH line of merged stdout/stderr becomes a notification that wakes a new turn. For real-time event streams (log tailing, file watching, CI polling). Volume-capped. |
| `get_background_output` | Read status + output tail of any task; optionally block up to `timeoutMs` (non-blocking by default). |
| `wait_tasks` | Block until one (`wait_any`) or all (`wait_all`) of the given task ids finish, with a timeout. |
| `kill_task` | Terminate a running task (SIGTERM → SIGKILL to the whole process group). |

## How it works

- **Wake mechanism**: all "auto-tell" behaviour is just child-process events
  (exit / stdout line) observed by pi's own event loop, calling
  `pi.sendMessage({ triggerTurn: true })`.
- **Session-resident**: everything dies with pi or on `/reload`. No external
  daemon.
- **State**: per-task metadata + logs under `~/.pi/background-tasks/<id>.{json,log}`.

## Install

Add to `~/.pi/agent/settings.json` `packages`:

```json
"../../dev/pi-expansion/pi-background-tasks"
```

Activate with `/reload` (or restart pi).
