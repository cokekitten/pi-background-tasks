# pi-background-tasks

A first-class **background shell command** primitive for [pi](https://github.com/earendil-works/pi-coding-agent) - tool-layer parity with grok's task system.

**Repo:** https://github.com/cokekitten/pi-background-tasks

## Tools

| Tool | Description |
| --- | --- |
| `run_background` | One-shot detached shell command; returns a task id immediately. Completion auto-notifies the session. |
| `monitor` | Run a long-running command; EACH line of merged stdout/stderr becomes a notification that wakes a new turn. For real-time event streams (log tailing, file watching, CI polling). Volume-capped. |
| `list_tasks` | Enumerate tasks across sessions with status/pid/command and **ownership** (`mine` / `other-session` / `unowned` / `released`). Answers "what is hanging in the background right now". |
| `get_background_output` | Read status + output tail of any task; optionally block up to `timeoutMs` (non-blocking by default). |
| `wait_tasks` | Block until one (`wait_any`) or all (`wait_all`) of the given task ids finish, with a timeout. |
| `kill_task` | `mode: "kill"` (default) SIGTERM → SIGKILL the whole process group. `mode: "release"` un-watches a `run_background` task **without** touching the process. |

## Ownership and lifetimes

Ownership key is **`sessionId`**; `ownerPid` is only a "who is watching this right now" hint, never proof of ownership.

- A session counts (and auto-notifies for) **only tasks it spawned**. The `Waiting for N background tasks to finish` indicator above the input box reflects *this session's* count.
- The child is detached (own process group, `unref`'d), so a task **outlives its session**: exit pi and a dev server keeps running. Nobody watches it, nobody claims it — `list_tasks` shows it as `other-session`/`unowned` and `get_background_output` still reads its log.
- **Resuming** the session that spawned a task (`/resume`, or `--continue`) re-claims its still-running tasks and starts watching them again. Foreign tasks are never adopted: doing that (the old behaviour, keyed on "is the recorded owner pid alive?") made a fresh session inherit another session's server and advertise a busy state for work it never started — and it broke under PID reuse.
- Want a task to keep running but stop it showing in the indicator? `kill_task { id, mode: "release" }`. (`monitor` cannot be released — it pumps lines through this process's pipes, and leaving them unread would backpressure the child; kill it or let `maxEvents` cap it.)

## How it works

- **Wake mechanism**: all "auto-tell" behaviour is just child-process events (exit / stdout line) observed by pi's own event loop, calling `pi.sendMessage({ triggerTurn: true })`.
- **Session-resident watchers, detached workers**: the in-memory handles, listeners and timers die with pi or `/reload`; the child processes themselves are detached and keep running (see [Ownership and lifetimes](#ownership-and-lifetimes)). No external daemon.
- **State**: per-task metadata + logs under `~/.pi/background-tasks/<id>.{json,log}`. Dead pids are lazily reconciled to `completed` by whoever reads them next (the exit code is unrecoverable; a monitor also records `stopped: exited`).

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

Only adds tools; does not modify LLM context, provider payloads, or TUI rendering (the one widget is the waiting indicator above the editor).

## Development

Package entry: `package.json` -> `pi.extensions` -> `./extensions/background-tasks.ts`.

```bash
npm test   # node >= 23.6 (native TS); drives the extension with a fake ExtensionAPI + temp $HOME
```

The test seeds a task owned by *another* session plus one owned by the current session, fires `session_start`, and asserts the foreign meta is untouched, the widget counts 1, `release` leaves the process alive, and `kill` reaps the group.

## License

MIT
