# pi-background-tasks

A first-class **background shell command** primitive for [pi](https://github.com/earendil-works/pi-coding-agent) - tool-layer parity with grok's task system.

**Repo:** https://github.com/cokekitten/pi-background-tasks

## Tools

| Tool | Description |
| --- | --- |
| `run_background` | One-shot detached shell command; returns a task id immediately. Completion auto-notifies the session. |
| `monitor` | Run a long-running command; EACH line of merged stdout/stderr becomes a notification that wakes a new turn. For real-time event streams (log tailing, file watching, CI polling). Volume-capped. |
| `get_background_output` | Read status + output tail of any task; optionally block up to `timeoutMs` (non-blocking by default). |
| `wait_tasks` | Block until one (`wait_any`) or all (`wait_all`) of the given task ids finish, with a timeout. |
| `kill_task` | Terminate a running task (SIGTERM -> SIGKILL to the whole process group). |

## How it works

- **Wake mechanism**: all "auto-tell" behaviour is just child-process events (exit / stdout line) observed by pi's own event loop, calling `pi.sendMessage({ triggerTurn: true })`.
- **Session-resident**: everything dies with pi or on `/reload`. No external daemon.
- **State**: per-task metadata + logs under `~/.pi/background-tasks/<id>.{json,log}`.

## Install

From GitHub:

```bash
pi install git:github.com/cokekitten/pi-background-tasks
```

Or try it for one run without installing:

```bash
pi -e git:github.com/cokekitten/pi-background-tasks
```

Local checkout:

```bash
# e.g. in ~/.pi/agent/settings.json packages:
#   "../../dev/pi-expansion/pi-background-tasks"
pi install /path/to/pi-background-tasks
# or
pi -e /path/to/pi-background-tasks
```

After installing, restart pi or run `/reload`.

## Notes

Only adds tools; does not modify LLM context, provider payloads, or TUI rendering. Tasks are session-resident - they die with pi or on `/reload`, with no external daemon.

## Development

Package entry: `package.json` -> `pi.extensions` -> `./extensions/background-tasks.ts`.

## License

MIT
