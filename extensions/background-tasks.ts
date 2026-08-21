/**
 * Background Shell Tasks — a lightweight, first-class "background shell command"
 * primitive for pi, aiming at tool-layer parity with grok's task system.
 *
 * Tools:
 *   - run_background          One-shot detached shell command; returns a task id
 *                             immediately. Completion auto-notifies the session.
 *   - monitor                 Run a long-running command; EACH line of merged
 *                             stdout/stderr becomes a notification that wakes a
 *                             new turn. For real-time event streams (log tailing,
 *                             file watching, CI polling). Volume-capped.
 *   - get_background_output   Read status + output tail of any task; optionally
 *                             block up to timeoutMs (non-blocking by default).
 *   - wait_tasks              Block until one (wait_any) or all (wait_all) of the
 *                             given task ids finish, with a timeout.
 *   - kill_task               Terminate a running task (SIGTERM -> SIGKILL to the
 *                             whole process group).
 *
 * Wake mechanism: all "auto-tell" behaviour is just child-process events
 * (exit / stdout line) observed by pi's own event loop, calling
 * pi.sendMessage({ triggerTurn: true }). Everything is session-resident: it dies
 * with pi or on /reload. No external daemon.
 *
 * State: per-task metadata + logs under ~/.pi/background-tasks/<id>.{json,log}
 * Install: ~/.pi/agent/extensions/background-tasks.ts   Activate: /reload
 */

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TASKS_DIR = join(homedir(), ".pi", "background-tasks");
const MAX_WAIT_IDS = 20;
const DEFAULT_MAX_EVENTS = 50; // monitor volume cap (auto-stop threshold)

type TaskType = "command" | "monitor";
type TaskStatus = "running" | "completed" | "failed" | "killed";

interface TaskMeta {
	id: string;
	type: TaskType;
	command: string;
	cwd: string;
	pid: number;
	ownerPid?: number; // pi process that spawned the task; orphans (dead owner) are adopted and re-homed on restart
	sessionId?: string; // pi session that spawned the task; lets a resumed session reclaim its own tasks after a crash
	description?: string;
	persistent?: boolean;
	maxEvents?: number;
	startedAt: string;
	status: TaskStatus;
	exitCode: number | null;
	signal: string | null;
	finishedAt: string | null;
	lineCount?: number;
	stoppedReason?: string; // monitor: "volume" | "exited" | "killed"
}

// In-memory handle registry. Lost on /reload or restart; on-disk meta + pid
// probing lets get_background_output / wait_tasks reconcile state afterwards.
interface Handle {
	meta: TaskMeta;
	child: ChildProcess;
}
const tasks = new Map<string, Handle>();

// --- persistence helpers -------------------------------------------------
function ensureDir() {
	mkdirSync(TASKS_DIR, { recursive: true });
}
function metaPath(id: string) {
	return join(TASKS_DIR, `${id}.json`);
}function logPath(id: string) {
	return join(TASKS_DIR, `${id}.log`);
}
function genId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function readMeta(id: string): TaskMeta | null {
	try {
		return JSON.parse(readFileSync(metaPath(id), "utf8")) as TaskMeta;
	} catch {
		return null;
	}
}
function writeMeta(meta: TaskMeta) {
	try {
		writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2));
	} catch {}
}
function isAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
function safeSessionId(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}
// Reconcile on-disk "running" meta with reality (pid may have died after reload).
function reconcile(id: string): TaskMeta | null {
	const meta = readMeta(id);
	if (!meta) return null;
	if (meta.status === "running" && !isAlive(meta.pid)) {
		meta.status = meta.type === "monitor" ? "completed" : "completed";
		meta.finishedAt = new Date().toISOString();
		writeMeta(meta);
	}
	return meta;
}
function tailLog(id: string, maxChars: number): string {
	try {
		const data = readFileSync(logPath(id), "utf8");
		if (data.length <= maxChars) return data;
		return "...(truncated)...\n" + data.slice(data.length - maxChars);
	} catch {
		return "";
	}
}
function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}
function appendLine(id: string, line: string) {
	try {
		appendFileSync(logPath(id), line + "\n");
	} catch {}
}
function notify(pi: ExtensionAPI, content: string, details: Record<string, unknown>) {
	try {
		pi.sendMessage(
			{ customType: "background-task", content, display: true, details },
			{ triggerTurn: true, deliverAs: "steer" },
		);
	} catch {}
}
function finalize(handle: Handle, status: TaskStatus, exitCode: number | null, signal: string | null) {
	handle.meta.status = status;
	handle.meta.exitCode = exitCode;
	handle.meta.signal = signal;
	handle.meta.finishedAt = new Date().toISOString();
	writeMeta(handle.meta);
}

// --- "waiting" widget above the editor --------------------------------------
// While any background task is running, show a persistent one-liner above the
// input box (same slot as the todo widget): "✻ Waiting for N background tasks
// to finish". Follows the setWidget contract used by rpiv-todo: factory-form
// registration once, requestRender() on later updates, cleared when the count
// reaches zero, re-registered on session_start (identity change on /reload).
const WIDGET_KEY = "background-tasks";
const WIDGET_FRAMES = ["✻", "✽", "✾", "✽"];
let uiCtx: ExtensionUIContext | undefined;
let widgetTui: { requestRender: (force?: boolean) => void } | undefined;
let widgetRegistered = false;
let widgetFrame = 0;
let widgetTimer: ReturnType<typeof setInterval> | undefined;
// RPC 模式（pi-web 等宿主）：factory 形式的 setWidget 会被 pi 忽略（wire 上什么都发不出去），
// 但宿主的进程回收需要"扩展在托管后台工作"的语义信号。任务数变化时改用 setStatus 广播
// （setStatus 在 RPC 下是 wire 事件；TUI 模式下完全不调，交互观感零变化）。
let isRpcMode = false;
let lastStatusCount = 0;
// Ids of tasks started before a /reload or restart: no in-memory handle remains,
// but the on-disk meta still says running and the pid is alive. Reconciled lazily.
const stragglers = new Set<string>();
// Extension API captured at registration so module-scope timers (straggler
// completion notifications) can send messages.
let piRef: ExtensionAPI | undefined;

function runningTaskCount(): number {
	let n = tasks.size;
	for (const id of stragglers) {
		const m = reconcile(id); // flips dead pids to completed on disk
		if (m && m.status === "running") n++;
		else stragglers.delete(id);
	}
	return n;
}

function updateWidget() {
	if (!uiCtx) return;
	const n = runningTaskCount();
	// RPC 豁免信号：任务数 0↔非0（及数量变化）时广播；pi-web 按 statusKey="background-tasks"
	// 豁免进程回收。statusText 为空 = 清除忙态。
	if (isRpcMode && n !== lastStatusCount) {
		lastStatusCount = n;
		try {
			uiCtx.setStatus(WIDGET_KEY, n > 0 ? `${n} running` : undefined);
		} catch {}
	}
	if (n === 0) {
		if (widgetTimer) {
			clearInterval(widgetTimer);
			widgetTimer = undefined;
		}
		if (widgetRegistered) {
			uiCtx.setWidget(WIDGET_KEY, undefined);
			widgetRegistered = false;
			widgetTui = undefined;
		}
		return;
	}
	// animation + straggler reconciliation tick
	if (!widgetTimer) {
		widgetTimer = setInterval(() => {
			widgetFrame++;
			// Stragglers have no parent process watching for exit events (the
			// original pi died) — detect completion here and deliver the
			// notification the original session never sent.
			for (const id of [...stragglers]) {
				const m = reconcile(id);
				if (!m) {
					stragglers.delete(id);
					continue;
				}
				if (m.ownerPid !== undefined && m.ownerPid !== process.pid) {
					// re-homed to another session (e.g. it resumed and reclaimed
					// its own task) — let go silently
					stragglers.delete(id);
					continue;
				}
				if (m.status !== "running") {
					stragglers.delete(id);
					if (piRef) {
						notify(
							piRef,
							`Background task ${id} finished (adopted after pi restart) — status: ${m.status}.`,
							{ summary: `Task ${id}\nstatus: ${m.status}\ncommand: ${m.command}\n\n--- output tail ---\n${tailLog(id, 1200)}`, taskId: id, status: m.status, adopted: true },
						);
					}
				}
			}
			if (runningTaskCount() === 0) {
				updateWidget();
				return;
			}
			widgetTui?.requestRender();
		}, 700);
		widgetTimer.unref?.();
	}
	if (!widgetRegistered) {
		uiCtx.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				widgetTui = tui;
				return {
					render: (width: number) => {
						const count = runningTaskCount();
						if (count === 0 || width < 2) return [];
						const glyph = theme.fg("accent", WIDGET_FRAMES[widgetFrame % WIDGET_FRAMES.length]);
						const label = count === 1 ? "task" : "tasks";
						// Truncate to the viewport width: pi-tui throws (crashing pi) if any
						// rendered line exceeds the terminal width (e.g. narrow panes).
						let text = `Waiting for ${count} background ${label} to finish`;
						const maxLabel = Math.max(0, width - 2); // glyph + space
						if (text.length > maxLabel) {
							text = maxLabel >= 2 ? text.slice(0, maxLabel - 1) + "…" : text.slice(0, maxLabel);
						}
						// trailing blank line so the widget isn't glued to the editor box
						return [glyph + " " + theme.fg("muted", text), ""];
					},
					invalidate: () => {},
				};
			},
			{ placement: "aboveEditor" },
		);
		widgetRegistered = true;
	} else {
		widgetTui?.requestRender();
	}
}

// =========================================================================
export default function backgroundTasksExtension(pi: ExtensionAPI) {
	ensureDir();
	piRef = pi;

	// --- tool: run_background ----------------------------------------------
	pi.registerTool({
		name: "run_background",
		label: "Run Background Command",
		description:
			"Run a one-shot shell command in the background (detached process). Returns immediately with a task id — does not block the turn. " +
			"On completion a notification (status + output tail) is auto-injected unless notify=false. " +
			"Use this instead of a subagent for plain shell work like dev servers, builds, tests, sleeps, or watchers. " +
			"For a real-time event stream where EACH line should wake a turn (log/file/CI watching), use monitor instead.",
		promptSnippet: "Run a one-shot shell command in the background and return a task id (non-blocking)",
		promptGuidelines: [
			"Use run_background for long-running or fire-and-forget shell commands (servers, builds, tests, sleeps) where you should NOT block the current turn.",
			"After run_background returns a task id, END your turn immediately. Do NOT call get_background_output/wait_tasks with a timeout just to wait — that blocks the session. Completion is auto-delivered as a notification.",
			"Call get_background_output (timeoutMs omitted/0) only to peek at progress. Use wait_tasks only when the user explicitly asks to wait for several tasks.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run" }),
			cwd: Type.Optional(Type.String({ description: "Working directory (defaults to the session cwd)" })),
			notify: Type.Optional(
				Type.Boolean({ description: "Auto-inject a completion notification into the session (default true)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const command = params.command;
			const cwd = params.cwd || process.cwd();
			const doNotify = params.notify !== false;
			const id = genId("bg");
			ensureDir();

			const outFd = openSync(logPath(id), "w");
			const errFd = openSync(logPath(id), "a");
			let child: ChildProcess;
			try {
				child = spawn(command, { shell: true, cwd, detached: true, stdio: ["ignore", outFd, errFd] });
			} catch (e) {
				try { closeSync(outFd); } catch {}
				try { closeSync(errFd); } catch {}
				return { content: [{ type: "text", text: `Failed to spawn: ${(e as Error).message}` }], isError: true };
			} finally {
				try { closeSync(outFd); } catch {}
				try { closeSync(errFd); } catch {}
			}

			const meta: TaskMeta = {
				id, type: "command", command, cwd, pid: child.pid ?? -1,
				ownerPid: process.pid,
				sessionId: safeSessionId(ctx),
				startedAt: new Date().toISOString(), status: "running",
				exitCode: null, signal: null, finishedAt: null,
			};
			writeMeta(meta);
			tasks.set(id, { meta, child });
			updateWidget();

			child.on("exit", (code, signal) => {
				const h = tasks.get(id);
				if (h) finalize(h, code === 0 ? "completed" : "failed", code, signal ?? null);
				tasks.delete(id);
				updateWidget();
				if (doNotify) {
					notify(
						pi,
						`Background task ${id} finished — status: ${meta.status === "running" ? (code === 0 ? "completed" : "failed") : meta.status}, exit: ${code ?? signal}.`,
						{ summary: `Task ${id}\nstatus: ${code === 0 ? "completed" : "failed"}\nexit: ${code ?? signal}\ncommand: ${command}\n\n--- output tail ---\n${tailLog(id, 1200)}`, taskId: id, status: code === 0 ? "completed" : "failed", exitCode: code },
					);
				}
			});

			return {
				content: [{
					type: "text",
					text: `Started background task.\nid: ${id}\npid: ${meta.pid}\ncommand: ${command}\ncwd: ${cwd}\n\nA notification will arrive when it finishes. Use get_background_output with this id to peek.`,
				}],
				details: { taskId: id, pid: meta.pid },
			};
		},
	});

	// --- tool: monitor ------------------------------------------------------
	pi.registerTool({
		name: "monitor",
		label: "Monitor a Streaming Command",
		description:
			"Run a long-running shell command and turn EACH line of its merged stdout/stderr into a notification that wakes a new turn — for real-time event streams (log tailing, file watching, CI polling). " +
			"Auto-stops after maxEvents lines (default 50) to protect against floods. Stop sooner with kill_task. " +
			"Keep filters tight: pipe through `grep --line-buffered`, never stream raw logs. For a one-shot command that should only notify on completion, use run_background instead.",
		promptSnippet: "Stream a command's output; each line wakes a turn (logs, file/CI watching)",
		promptGuidelines: [
			"Use monitor for real-time event streams where each matching line should wake you: `tail -f log | grep --line-buffered ERROR`, `inotifywait -m ...`, or a poll loop. Use run_background for one-shot commands.",
			"ALWAYS filter aggressively — every emitted line becomes a separate turn. Use `grep --line-buffered` in pipes (without it buffering delays events by minutes) and never pipe raw logs.",
			"Use `|| true` in poll loops so one failed request does not kill the monitor. Poll remote APIs at 30s+; local checks 0.5–1s.",
			"Do NOT block after starting a monitor — END your turn; events arrive as notifications. Use kill_task to stop it.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Long-running shell command whose stdout/stderr lines are events" }),
			description: Type.Optional(Type.String({ description: "Short label included in each event notification" })),
			cwd: Type.Optional(Type.String({ description: "Working directory (defaults to the session cwd)" })),
			persistent: Type.Optional(Type.Boolean({ description: "Mark as session-lifetime monitor (metadata; still volume-capped)" })),
			maxEvents: Type.Optional(Type.Number({ description: `Auto-stop after this many event lines (default ${DEFAULT_MAX_EVENTS})` })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const command = params.command;
			const cwd = params.cwd || process.cwd();
			const description = params.description ?? "monitor";
			const persistent = params.persistent === true;
			const maxEvents = params.maxEvents ?? DEFAULT_MAX_EVENTS;
			const id = genId("mon");
			ensureDir();

			let child: ChildProcess;
			try {
				// detached so kill_task can signal the whole group; piped so we can
				// split lines in-process and emit an event per line.
				child = spawn(command, { shell: true, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
			} catch (e) {
				return { content: [{ type: "text", text: `Failed to spawn: ${(e as Error).message}` }], isError: true };
			}

			// truncate a fresh log for this monitor's event history
			try { writeFileSync(logPath(id), ""); } catch {}

			const meta: TaskMeta = {
				id, type: "monitor", command, cwd, pid: child.pid ?? -1,
				ownerPid: process.pid,
				sessionId: safeSessionId(ctx),
				description, persistent, maxEvents,
				startedAt: new Date().toISOString(), status: "running",
				exitCode: null, signal: null, finishedAt: null, lineCount: 0, stoppedReason: undefined,
			};
			writeMeta(meta);
			tasks.set(id, { meta, child });
			updateWidget();

			let stopped = false;
			let lineCount = 0;

			const onLine = (raw: string) => {
				const line = raw.replace(/\r$/, "");
				if (!line || stopped) return;
				lineCount++;
				meta.lineCount = lineCount;
				appendLine(id, line);
				writeMeta(meta);
				notify(pi, `[${description}] ${line}`, { taskId: id, type: "monitor-event", line, lineCount });
				if (lineCount >= maxEvents) {
					stopMonitor(id, "volume");
				}
			};

			const split = (stream: NodeJS.ReadableStream) => {
				let buf = "";
				stream.on("data", (chunk: Buffer | string) => {
					buf += typeof chunk === "string" ? chunk : chunk.toString();
					let i: number;
					while ((i = buf.indexOf("\n")) >= 0) {
						onLine(buf.slice(0, i));
						buf = buf.slice(i + 1);
					}
				});
				stream.on("end", () => { if (buf) onLine(buf); });
			};
			if (child.stdout) split(child.stdout);
			if (child.stderr) split(child.stderr);

			child.on("exit", (code, signal) => {
				if (stopped) return; // already finalized via stopMonitor
				stopped = true;
				const h = tasks.get(id);
				if (h) {
					h.meta.stoppedReason = "exited";
					finalize(h, code === 0 || code === null ? "completed" : "failed", code, signal ?? null);
				}
				tasks.delete(id);
				updateWidget();
				notify(
					pi,
					`Monitor ${id} ended (exited${code !== null ? `, code ${code}` : ""}; ${lineCount} events).`,
					{ taskId: id, type: "monitor-ended", status: "completed", lineCount },
				);
			});

			// local closure so the exit path and volume path share it
			function stopMonitor(taskId: string, reason: "volume" | "killed") {
				if (stopped) return;
				stopped = true;
				const h = tasks.get(taskId);
				if (!h) return;
				try { process.kill(-h.child.pid!, "SIGTERM"); } catch {}
				setTimeout(() => { try { process.kill(-h.child.pid!, "SIGKILL"); } catch {} }, 1200);
				h.meta.stoppedReason = reason;
				finalize(h, "killed", null, "SIGTERM");
				tasks.delete(taskId);
				updateWidget();
				notify(
					pi,
					reason === "volume"
						? `Monitor ${taskId} auto-stopped after ${lineCount} events — too noisy. Restart with a tighter filter (grep --line-buffered).`
						: `Monitor ${taskId} killed.`,
					{ taskId, type: "monitor-ended", reason, lineCount },
				);
			}
			// expose stopMonitor to kill_task via a side channel keyed by id
			stopFns.set(id, stopMonitor);

			return {
				content: [{
					type: "text",
					text: `Started monitor.\nid: ${id}\npid: ${meta.pid}\ncommand: ${command}\ndescription: ${description}\nmaxEvents: ${maxEvents}\n\nEach output line will arrive as a notification. Use kill_task to stop it.`,
				}],
				details: { taskId: id, pid: meta.pid, type: "monitor" },
			};
		},
	});

	// --- tool: get_background_output ---------------------------------------
	pi.registerTool({
		name: "get_background_output",
		label: "Get Task Output",
		description:
			"Get status and output tail of any task (run_background or monitor). Returns immediately by default; only pass timeoutMs to block when the user EXPLICITLY asks to wait for a specific task in this turn.",
		promptSnippet: "Get status/output of any task; non-blocking by default",
		promptGuidelines: [
			"Non-blocking by default (timeoutMs omitted/0 returns instantly). Do NOT pass a timeoutMs right after starting a task just to wait — that blocks the session.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Task id returned by run_background or monitor" }),
			timeoutMs: Type.Optional(Type.Number({ description: "If still running, block up to this many ms (default 0 = return immediately)" })),
			tail: Type.Optional(Type.Number({ description: "Max chars of trailing output to return (default 4000)" })),
		}),
		async execute(_toolCallId, params) {
			const id = params.id;
			const timeoutMs = params.timeoutMs ?? 0;
			const tail = params.tail ?? 4000;
			if (!existsSync(metaPath(id))) {
				return { content: [{ type: "text", text: `No such task: ${id}` }], isError: true };
			}
			if (timeoutMs > 0) {
				const deadline = Date.now() + timeoutMs;
				while (Date.now() < deadline) {
					if (reconcile(id)?.status !== "running") break;
					await sleep(200);
				}
			}
			const meta = reconcile(id);
			if (!meta) return { content: [{ type: "text", text: `No such task: ${id}` }], isError: true };
			const output = tailLog(id, tail);
			const text =
				`Task ${id}\n` +
				`type: ${meta.type}\n` +
				`status: ${meta.status}\n` +
				`command: ${meta.command}\n` +
				`pid: ${meta.pid}\n` +
				`started: ${meta.startedAt}\n` +
				`finished: ${meta.finishedAt ?? "(still running)"}\n` +
				(meta.exitCode !== null ? `exit code: ${meta.exitCode}\n` : "") +
				(meta.signal ? `signal: ${meta.signal}\n` : "") +
				(meta.lineCount !== undefined ? `events: ${meta.lineCount}\n` : "") +
				(meta.stoppedReason ? `stopped: ${meta.stoppedReason}\n` : "") +
				`\n--- output (tail ${output.length} chars) ---\n${output}`;
			return {
				content: [{ type: "text", text }],
				details: { taskId: id, status: meta.status, exitCode: meta.exitCode, lineCount: meta.lineCount },
			};
		},
	});

	// --- tool: wait_tasks ---------------------------------------------------
	pi.registerTool({
		name: "wait_tasks",
		label: "Wait for Multiple Tasks",
		description:
			"Block until one (mode=wait_any) or all (mode=wait_all) of the given task ids finish, or until timeoutMs elapses. " +
			"Use this when the user explicitly wants to wait for several background tasks at once. Returns status + output tail for every listed task.",
		promptSnippet: "Block until any/all of several tasks finish (explicit wait only)",
		promptGuidelines: [
			"Use wait_tasks ONLY when the user explicitly asks to wait for multiple tasks in the current turn. It blocks. Do not call it reflexively after run_background — completion is already auto-notified.",
		],
		parameters: Type.Object({
			task_ids: Type.Array(Type.String(), { description: "Task ids to wait on" }),
			mode: Type.Optional(Type.Union([Type.Literal("wait_any"), Type.Literal("wait_all")], { description: "wait_any = return when first finishes; wait_all = wait for all (default wait_all)" })),
			timeoutMs: Type.Optional(Type.Number({ description: "Max ms to wait (default 30000)" })),
			tail: Type.Optional(Type.Number({ description: "Max chars of trailing output per task (default 1500)" })),
		}),
		async execute(_toolCallId, params) {
			const ids = (params.task_ids ?? []).slice(0, MAX_WAIT_IDS);
			const mode = params.mode === "wait_any" ? "wait_any" : "wait_all";
			const timeoutMs = params.timeoutMs ?? 30000;
			const tail = params.tail ?? 1500;
			if (ids.length === 0) {
				return { content: [{ type: "text", text: "No task ids provided." }], isError: true };
			}
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const metas = ids.map((id) => reconcile(id));
				const doneCount = metas.filter((m) => m && m.status !== "running").length;
				if (mode === "wait_any" && doneCount >= 1) break;
				if (mode === "wait_all" && doneCount === ids.length) break;
				await sleep(150);
			}
			const blocks = ids.map((id) => {
				const m = reconcile(id);
				if (!m) return `• ${id}: NOT FOUND`;
				const head = `• ${id} [${m.type}] status: ${m.status}` + (m.exitCode !== null ? `, exit: ${m.exitCode}` : "") + (m.lineCount !== undefined ? `, events: ${m.lineCount}` : "");
				return `${head}\n  ${tailLog(id, tail).split("\n").slice(-4).join("\n  ")}`;
			});
			return {
				content: [{ type: "text", text: `wait_tasks (${mode}, ${timeoutMs}ms)\n\n${blocks.join("\n")}` }],
				details: { mode, ids, statuses: ids.map((id) => ({ id, status: reconcile(id)?.status ?? "unknown" })) },
			};
		},
	});

	// --- tool: kill_task ----------------------------------------------------
	pi.registerTool({
		name: "kill_task",
		label: "Kill a Background Task",
		description:
			"Terminate a running background task or monitor. Sends SIGTERM then SIGKILL to the whole process group. Reports success if the task was killed or had already exited.",
		promptSnippet: "Kill a running background task or monitor",
		parameters: Type.Object({
			id: Type.String({ description: "Task id to kill" }),
		}),
		async execute(_toolCallId, params) {
			const id = params.id;
			// monitor-specific stop (notifies reason=killed) if applicable
			const stop = stopFns.get(id);
			if (stop) {
				stop(id, "killed");
				stopFns.delete(id);
				return { content: [{ type: "text", text: `Killed monitor ${id}.` }], details: { taskId: id, killed: true } };
			}
			const handle = tasks.get(id);
			if (handle) {
				try { process.kill(-handle.child.pid!, "SIGTERM"); } catch {}
				setTimeout(() => { try { process.kill(-handle.child.pid!, "SIGKILL"); } catch {} }, 1200);
				finalize(handle, "killed", null, "SIGTERM");
				tasks.delete(id);
				updateWidget();
				return { content: [{ type: "text", text: `Killed task ${id} (pid ${handle.meta.pid}).` }], details: { taskId: id, killed: true } };
			}
			// no in-memory handle: reconcile from disk
			const meta = reconcile(id);
			if (!meta) return { content: [{ type: "text", text: `No such task: ${id}` }], isError: true };
			if (meta.status === "running" && isAlive(meta.pid)) {
				try { process.kill(-meta.pid, "SIGTERM"); } catch {}
				setTimeout(() => { try { process.kill(-meta.pid, "SIGKILL"); } catch {} }, 1200);
				meta.status = "killed";
				meta.signal = "SIGTERM";
				meta.finishedAt = new Date().toISOString();
				writeMeta(meta);
				updateWidget();
				return { content: [{ type: "text", text: `Killed task ${id} (pid ${meta.pid}).` }], details: { taskId: id, killed: true } };
			}
			return {
				content: [{ type: "text", text: `Task ${id} already ${meta.status}; nothing to kill.` }],
				details: { taskId: id, killed: false, status: meta.status },
			};
		},
	});

	// capture the UI context and re-register the widget for each session
	// (identity changes on /reload; tasks still alive become stragglers)
	pi.on("session_start", (_event, ctx) => {
		uiCtx = ctx.hasUI ? ctx.ui : undefined;
		isRpcMode = ctx.mode === "rpc";
		lastStatusCount = 0;
		widgetRegistered = false;
		widgetTui = undefined;
		stragglers.clear();
		if (uiCtx) {
			const mySessionId = safeSessionId(ctx);
			try {
				for (const f of readdirSync(TASKS_DIR)) {
					if (!f.endsWith(".json")) continue;
					const m = reconcile(f.slice(0, -".json".length));
					if (!m || m.status !== "running") continue;
					// already have a live handle in this process (e.g. session switch
					// within the same pi): not a straggler — avoid double-count/notify
					if (tasks.has(m.id)) continue;
					if (m.ownerPid === process.pid) {
						// Same process (e.g. after /reload): still ours.
						stragglers.add(m.id);
					} else if (mySessionId && m.sessionId === mySessionId) {
						// Our own session's task, resumed after crash/restart. Claim it
						// back even if another session adopted it in the meantime.
						m.ownerPid = process.pid;
						writeMeta(m);
						stragglers.add(m.id);
					} else if (m.ownerPid === undefined || !isAlive(m.ownerPid)) {
						// Orphan: the owning pi process is gone (crash/restart) or
						// this is a legacy meta without ownerPid. Adopt it and
						// re-home on disk so other live sessions don't double-adopt.
						m.ownerPid = process.pid;
						writeMeta(m);
						stragglers.add(m.id);
					}
					// else: owned by another live pi session — leave it alone.
				}
			} catch {}
		}
		updateWidget();
	});

	// release child handles on shutdown so they never block pi from exiting
	pi.on("session_shutdown", () => {
		for (const child of [...tasks.values()].map((h) => h.child)) {
			try { child.unref(); } catch {}
		}
		tasks.clear();
		stopFns.clear();
		if (widgetTimer) {
			clearInterval(widgetTimer);
			widgetTimer = undefined;
		}
		if (uiCtx && widgetRegistered) {
			try { uiCtx.setWidget(WIDGET_KEY, undefined); } catch {} // ctx may be stale after session replacement
		}
		widgetRegistered = false;
		widgetTui = undefined;
		uiCtx = undefined;
	});
}

// side channel: monitor id -> its stop closure (so kill_task can stop a monitor)
const stopFns = new Map<string, (taskId: string, reason: "volume" | "killed") => void>();
