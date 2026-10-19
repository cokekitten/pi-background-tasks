# pi-background-tasks

A first-class **background shell command** primitive for [pi](https://github.com/earendil-works/pi-coding-agent) - tool-layer parity with grok's task system.

**Repo:** https://github.com/cokekitten/pi-background-tasks

## Tools

| Tool | Description |
| --- | --- |
| `run_background` | One-shot detached shell command; returns a task id immediately. Completion auto-notifies the session. Kills itself 1h after the pi that started it exits (deadman watchdog) unless `persist: true`. |
| `monitor` | Run a long-running command; EACH line of merged stdout/stderr becomes a notification that wakes a new turn. For real-time event streams (log tailing, file watching, CI polling). Volume-capped, dies with pi, and auto-stops after `idleTimeoutMs` of silence (10 min) or `maxLifetimeMs` (30 min). |
| `wait_until` | Poll a shell condition until it exits 0, then return — the **no-guessing** replacement for `sleep N; <check>`. Bounded by `timeoutMs`, reports elapsed time and attempts. |
| `list_tasks` | Enumerate tasks across sessions with status/pid/command and **ownership** (`mine` / `other-session` / `unowned` / `released`). Answers "what is hanging in the background right now". |
| `get_background_output` | Read status + output tail of any task; optionally block up to `timeoutMs` (non-blocking by default). |
| `wait_tasks` | Block until one (`wait_any`) or all (`wait_all`) of the given task ids finish, with a timeout. |
| `kill_task` | `mode: "kill"` (default) SIGTERM → SIGKILL the whole process group. `mode: "release"` un-watches a `run_background` task **without** touching the process. `all: true` sweeps every task of the current session. |

## Waiting without guessing

`sleep 170; <check>` is the shape every model reaches for, and it is wrong twice over: the duration is a guess (too short → check again, too long → wasted wall clock) and the session is unusable for its whole length. Two correct shapes:

- **`wait_until { condition: "pgrep -f build.sh >/dev/null", timeoutMs: 600000 }`** — returns the moment the condition holds. Use it when you need the result this turn.
- **`run_background "<whole command, wait included>"`** — ends the turn, wakes you on exit. Use it when you do not.

A bash command that *starts* with `sleep N` (N ≥ `minSeconds`, default 15s) is treated as a guessed wait:

| occurrence in the session | what happens |
| --- | --- |
| 1 … `escalateAfter - 1` (default 1–2) | runs normally; a hint is appended to the tool result |
| `escalateAfter` and later (default 3+) | **not run in the foreground** — promoted to a `run_background` task, blocked with the task id |

The ability to sleep is not taken away: sleeps shorter than `minSeconds` are ignored (rate-limit pacing, animation timing), a *mid-command* or in-loop `sleep` is ignored, and `PI_FG_SLEEP=1` anywhere in the command opts that command out entirely. Re-issuing a promoted command verbatim is deduped (no second copy is started).

## Configuration

`~/.pi/background-tasks/config.json`, read on every decision (no reload needed):

```json
{
  "sleepGuard": { "mode": "escalate", "minSeconds": 15, "escalateAfter": 3 },
  "orphanGraceMs": 3600000,
  "monitorIdleTimeoutMs": 600000,
  "monitorMaxLifetimeMs": 1800000
}
```

- `sleepGuard.mode`: `"escalate"` (default) | `"warn"` (hint only, never promote) | `"off"`.
- `orphanGraceMs`: how long a non-persistent task may outlive its pi (default 1h).
- `monitorIdleTimeoutMs` / `monitorMaxLifetimeMs`: silence and lifetime caps for monitors.

## Ownership and lifetimes

Ownership key is **`sessionId`**; `ownerPid` is only a "who is watching this right now" hint, never proof of ownership.

- The child is detached (own process group, `unref`'d), so a `run_background` task **outlives its session**: exit pi and a dev server keeps running. That is also how a forgotten `ffmpeg`/`tail -f`/`sleep 900` burns hours, so every non-persistent task carries a **deadman watchdog**: a tiny `/bin/sh` that polls the owning pi pid and, once it is gone (clean exit, crash and SIGKILL all look identical from there), waits the grace period and kills the task's process group.
  - `monitor`: grace 0 → dies with pi.
  - `run_background`: grace `orphanGraceMs` (default 1h) → a rebuild gets an hour to finish on its own.
  - `persist: true`: no watchdog at all — the real "must survive pi" escape hatch (dev servers). It also has no monitor caps.
  - A reaped task is recorded as `status: killed`, `stopped: deadman` (the watcher drops a `<id>.deadman` marker that the next reader turns into that reason).
- A session counts (and auto-notifies for) **only tasks it spawned**. The `Waiting for N background tasks to finish` indicator above the input box reflects *this session's* count.
- **Resuming** the session that spawned a task (`/resume`, or `--continue`) re-claims its still-running tasks and starts watching them again. Foreign tasks are never adopted: doing that (the old behaviour, keyed on "is the recorded owner pid alive?") made a fresh session inherit another session's server and advertise a busy state for work it never started — and it broke under PID reuse.
- Want a task to keep running but stop it showing in the indicator? `kill_task { id, mode: "release" }`. (`monitor` cannot be released — it pumps lines through this process's pipes, and leaving them unread would backpressure the child; kill it or let `maxEvents` cap it.)

## How it works

- **Wake mechanism**: all "auto-tell" behaviour is just child-process events (exit / stdout line) observed by pi's own event loop, calling `pi.sendMessage({ triggerTurn: true })`.
- **Session-resident watchers, detached workers**: the in-memory handles, listeners and timers die with pi or `/reload`; the child processes themselves are detached and keep running (see [Ownership and lifetimes](#ownership-and-lifetimes)). No external daemon.
- **State**: per-task metadata + logs under `~/.pi/background-tasks/<id>.{json,log}` (plus the operator's `config.json` in the same directory, which is never mistaken for a task). Dead pids are lazily reconciled by whoever reads them next: `stopped: deadman` when the watchdog reaped it, otherwise the neutral `completed` (the exit code is unrecoverable; a monitor also records `stopped: exited`).

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
