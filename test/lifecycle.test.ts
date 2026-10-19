/**
 * Regression tests for the two "waiting" failures this extension now guards:
 *
 * 1. A foreground `sleep N; <check>` is a *guessed* wait: it holds the whole
 *    session and is wrong often enough to need repeating. Covered here:
 *    detection/precision (leading sleeps only, pacing sleeps untouched), the
 *    per-command opt-out marker, the per-session escalation ladder (hint first,
 *    promote to a background task only after `escalateAfter` occurrences), and
 *    the wait_until primitive that replaces the guess.
 *
 * 2. A background task that outlives the pi that started it: monitors die with
 *    pi and go quiet-timeout / lifetime-capped; run_background tasks survive pi
 *    but self-kill after the orphan grace; `persist: true` opts out of all of it.
 *
 * Run: node --experimental-strip-types test/lifecycle.test.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "pi-bg-life-"));
process.env.HOME = HOME;
const DIR = join(HOME, ".pi", "background-tasks");
mkdirSync(DIR, { recursive: true });

const guard = await import("../extensions/sleep-guard.ts");
const ext = (await import("../extensions/background-tasks.ts")).default;
const { spawnWatcher } = await import("../extensions/background-tasks.ts");

const MY_SESSION = "33333333-3333-4333-8333-333333333333";

type Tool = { name: string; parameters: unknown; execute: (...a: any[]) => Promise<any> };
const tools = new Map<string, Tool>();
const handlers = new Map<string, (e: any, ctx: any) => any>();
let sent: { content: string; details?: any }[] = [];
const pi: any = {
	registerTool: (t: Tool) => tools.set(t.name, t),
	on: (ev: string, fn: any) => handlers.set(ev, fn),
	sendMessage: (m: any) => sent.push({ content: String(m?.content ?? ""), details: m?.details }),
};
ext(pi);
const ui: any = { setWidget: () => {}, setStatus: () => {} };
function makeCtx(sessionId = MY_SESSION) {
	return { hasUI: false, mode: "tui" as const, ui, sessionManager: { getSessionId: () => sessionId } };
}
const ctx = makeCtx();
const read = (id: string) => JSON.parse(readFileSync(join(DIR, `${id}.json`), "utf8"));
const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanup: number[] = [];
const fails: string[] = [];
function check(name: string, cond: boolean, extra = "") {
	console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra && !cond ? `\n         ${extra}` : ""}`);
	if (!cond) fails.push(name);
}
function livePid(cmd: string): number {
	const c = spawn(cmd, { shell: true, detached: true, stdio: "ignore" });
	c.unref();
	cleanup.push(c.pid!);
	return c.pid!;
}

// =========================================================================
console.log("\nT1 sleep detection precision");
{
	const p = (cmd: string) => guard.parseForegroundSleep(cmd);
	check("leading `sleep 170; …` is detected", p("sleep 170; cd /tmp && ls")?.seconds === 170);
	check("unit suffix: `sleep 2m;` = 120s", p("sleep 2m; curl x")?.seconds === 120);
	check("fractional `sleep 1.5 && …`", p("sleep 1.5 && curl x")?.seconds === 1.5);
	check("bare `sleep 30` (whole command)", p("sleep 30")?.seconds === 30);
	check("pacing sleep in a loop is NOT a wait", p("for i in 1 2 3; do sleep 4; done") === null);
	check("mid-command sleep is NOT a wait", p("curl a; sleep 20; curl b") === null);
	check("`sleep 5` followed by nothing else matches", p("sleep 5\n")?.seconds === 5);
	check("multiline leading sleep matches", p("sleep 40\ncd /tmp && ls")?.seconds === 40);
	check("opt-out marker recognised", guard.isExempt("PI_FG_SLEEP=1 sleep 300; ls"));
	check("marker as a plain word is not an opt-out", !guard.isExempt("echo PI_FG_SLEEP"));
}

console.log("\nT2 escalation ladder (nothing is taken away)");
{
	const cfg = guard.DEFAULT_SLEEP_GUARD;
	const cmd = "sleep 170; ls";
	check("1st occurrence only hints", guard.decideSleepGuard(cmd, 1, cfg).action === "warn");
	check("2nd occurrence still only hints", guard.decideSleepGuard(cmd, 2, cfg).action === "warn");
	check("3rd occurrence is promoted", guard.decideSleepGuard(cmd, 3, cfg).action === "promote");
	check(
		"short sleep untouched",
		guard.decideSleepGuard("sleep 5; curl x", 9, cfg).reason === "below-threshold",
	);
	check(
		"opt-out marker untouched even at occurrence 9",
		guard.decideSleepGuard("PI_FG_SLEEP=1 sleep 900; ls", 9, cfg).reason === "exempt",
	);
	check(
		"pacing loop untouched even at occurrence 9",
		guard.decideSleepGuard("for i in 1 2; do sleep 30; done", 9, cfg).reason === "no-leading-sleep",
	);
	check("mode=warn never promotes", guard.decideSleepGuard(cmd, 99, { ...cfg, mode: "warn" }).action === "warn");
	check("mode=off is silent", guard.decideSleepGuard(cmd, 99, { ...cfg, mode: "off" }).action === "allow");
	check("escalateAfter is honoured", guard.decideSleepGuard(cmd, 5, { ...cfg, escalateAfter: 5 }).action === "promote");
	const hint = guard.sleepHint(guard.decideSleepGuard(cmd, 1, cfg), cfg);
	check("hint names wait_until and run_background", /wait_until/.test(hint) && /run_background/.test(hint), hint);
	check("hint documents the opt-out marker", hint.includes("PI_FG_SLEEP=1"), hint);
}

console.log("\nT3 guard wiring through tool_call/tool_result");
{
	// Lower the thresholds for this block so a promoted command can finish fast:
	// the config file is read on every decision, no reload needed.
	writeFileSync(join(DIR, "config.json"), JSON.stringify({ sleepGuard: { minSeconds: 1, escalateAfter: 3 } }));
	const toolCall = handlers.get("tool_call")!;
	const toolResult = handlers.get("tool_result")!;
	const bashEvent = (command: string, id: string, extra: Record<string, unknown> = {}) => ({
		type: "tool_call", toolName: "bash", toolCallId: id, input: { command }, ...extra,
	});

	const first = await toolCall(bashEvent("sleep 20; echo hi", "c1"), ctx);
	check("1st matching sleep is not blocked", first === undefined, JSON.stringify(first));
	const res = await toolResult({
		type: "tool_result", toolName: "bash", toolCallId: "c1", input: { command: "sleep 20; echo hi" },
		content: [{ type: "text", text: "hi" }], isError: false, details: undefined,
	});
	const appended = res?.content?.[res.content.length - 1]?.text ?? "";
	check("hint is appended to the bash result", /background-tasks/.test(appended), JSON.stringify(res?.content));
	check("original output preserved", res?.content?.[0]?.text === "hi");

	const shortSleep = await toolCall(bashEvent("sleep 0.5; echo hi", "c2"), ctx);
	check("short sleep is ignored", shortSleep === undefined);
	const pacing = await toolCall(bashEvent("for i in 1 2; do sleep 30; done", "c3"), ctx);
	check("pacing loop is ignored", pacing === undefined);
	const exempt = await toolCall(bashEvent("PI_FG_SLEEP=1 sleep 300; ls", "c4"), ctx);
	check("opt-out marker is ignored", exempt === undefined);

	// 2nd occurrence of a long leading sleep → still just a hint
	const second = await toolCall(bashEvent("sleep 25; echo again", "c5"), ctx);
	check("2nd occurrence still not blocked", second === undefined);

	// 3rd occurrence → promoted to a real background task
	const marker = join(HOME, "promoted-marker.txt");
	const third = await toolCall(bashEvent(`sleep 1; echo promoted > ${marker}`, "c6"), ctx);
	check("3rd occurrence is blocked", third?.block === true, JSON.stringify(third));
	check("block reason carries a task id", /bg_[a-z0-9_]+/.test(third?.reason ?? ""), third?.reason ?? "");
	check("block reason explains the opt-out", /PI_FG_SLEEP=1/.test(third?.reason ?? ""));
	const promotedId = /bg_[a-z0-9_]+/.exec(third?.reason ?? "")?.[0] ?? "";
	await sleepMs(2600);
	check("promoted command actually ran", existsSync(marker), marker);
	const promotedMeta = read(promotedId);
	check("promoted task is labelled", promotedMeta.description === "auto-promoted foreground sleep", JSON.stringify(promotedMeta));
	check("promoted task got a deadman watchdog", typeof promotedMeta.watcherPid === "number");

	// nested calls (codemode scripts) never get promoted
	const nested = await toolCall(bashEvent("sleep 90; ls", "c7", { parentToolCallId: "c1/1" }), ctx);
	check("nested call is hinted, never promoted", nested === undefined);

	// A model that re-issues the blocked command verbatim must not duplicate the work.
	const again = await toolCall(bashEvent(`sleep 1; echo promoted > ${marker}`, "c8"), ctx);
	check("duplicate promotion is blocked", again?.block === true, JSON.stringify(again));
	check("duplicate points at the running task instead of spawning", /already running as background task bg_/.test(again?.reason ?? ""), again?.reason ?? "");
	const copies = (await import("node:fs")).readdirSync(DIR).filter((f) => f.endsWith(".json"));
	const promotedCopies = copies.filter((f) => {
		try { const m = JSON.parse(readFileSync(join(DIR, f), "utf8")); return m.description === "auto-promoted foreground sleep"; } catch { return false; }
	});
	check("only one promoted task exists", promotedCopies.length === 1, promotedCopies.join(","));
}

console.log("\nT4 wait_until replaces the guess");
{
	const waitUntil = tools.get("wait_until")!;
	const target = join(HOME, "ready.flag");
	// a detached job that becomes ready after ~600ms
	spawn(`sleep 0.6; touch ${target}`, { shell: true, detached: true, stdio: "ignore" }).unref();
	const ok = await waitUntil.execute("w", { condition: `test -f ${target}`, timeoutMs: 8000, intervalMs: 100 }, undefined, undefined, ctx);
	check("returns satisfied", ok.details?.satisfied === true, ok.content[0].text);
	check("returned early instead of a fixed duration", (ok.details?.elapsedMs ?? 9999) < 4000, String(ok.details?.elapsedMs));
	check("polls rather than sleeping once", (ok.details?.attempts ?? 0) >= 2, String(ok.details?.attempts));

	const t0 = Date.now();
	const bad = await waitUntil.execute("w", { condition: "false", timeoutMs: 700, intervalMs: 100 }, undefined, undefined, ctx);
	check("timeout is an error result", bad.isError === true && bad.details?.satisfied === false);
	check("timeout respects the budget", Date.now() - t0 < 4000, `${Date.now() - t0}ms`);
	check("timeout tells the model to read output, not wait longer", /read the output/i.test(bad.content[0].text));
}

console.log("\nT5 lifecycle: watchdog, idle/lifetime caps, persist");
{
	const runBackground = tools.get("run_background")!;
	const monitor = tools.get("monitor")!;
	const killTask = tools.get("kill_task")!;

	const plain = await runBackground.execute("r", { command: "sleep 30", cwd: HOME, notify: false }, undefined, undefined, ctx);
	const plainMeta = read(plain.details.taskId);
	check("run_background task gets a deadman watchdog", typeof plainMeta.watcherPid === "number", JSON.stringify(plainMeta));
	check("run_background is not persistent by default", plainMeta.persistent === undefined);

	const persistent = await runBackground.execute("r", { command: "sleep 30", cwd: HOME, notify: false, persist: true }, undefined, undefined, ctx);
	const persistentMeta = read(persistent.details.taskId);
	check("persist:true → no watchdog", persistentMeta.watcherPid === undefined, JSON.stringify(persistentMeta));
	check("persist:true recorded in meta", persistentMeta.persistent === true);

	const silent = await monitor.execute(
		"m",
		{ command: "sleep 30", description: "silent", idleTimeoutMs: 400, maxLifetimeMs: 0, maxEvents: 100 },
		undefined,
		undefined,
		ctx,
	);
	check("monitor gets a watchdog (dies with pi)", typeof read(silent.details.taskId).watcherPid === "number");
	await sleepMs(1400);
	const silentMeta = read(silent.details.taskId);
	check("silent monitor auto-stopped", silentMeta.status === "killed" && silentMeta.stoppedReason === "idle", JSON.stringify(silentMeta));
	check("idle stop notifies with a reason", sent.some((m) => /of silence/.test(m.content)), sent.map((m) => m.content).join(" | ").slice(-300));

	const chatty = await monitor.execute(
		"m",
		{ command: "for i in $(seq 40); do echo tick$i; sleep 0.1; done", description: "chatty", idleTimeoutMs: 5000, maxLifetimeMs: 500, maxEvents: 100 },
		undefined,
		undefined,
		ctx,
	);
	await sleepMs(1200);
	const chattyMeta = read(chatty.details.taskId);
	check("lifetime cap stops a noisy monitor", chattyMeta.status === "killed" && chattyMeta.stoppedReason === "lifetime", JSON.stringify(chattyMeta));

	const persistMon = await monitor.execute(
		"m",
		{ command: "sleep 30", description: "kept", persistent: true },
		undefined,
		undefined,
		ctx,
	);
	const persistMonMeta = read(persistMon.details.taskId);
	check("persistent monitor has no watchdog and no caps", persistMonMeta.watcherPid === undefined && persistMonMeta.idleTimeoutMs === 0 && persistMonMeta.maxLifetimeMs === 0, JSON.stringify(persistMonMeta));

	const swept = await killTask.execute("k", { all: true }, undefined, undefined, ctx);
	check("kill_task all sweeps this session", (swept.details?.killed?.length ?? 0) >= 2, JSON.stringify(swept.details));
	await sleepMs(400);
	check("swept processes are gone", !isAlive(plainMeta.pid) && !isAlive(persistMonMeta.pid));
}

console.log("\nT6 deadman watchdog really kills once its pi is gone");
{
	// The "pi" this task belongs to is a throwaway process that exits immediately.
	const fakePi = livePid("sleep 0.2");
	const target = spawn("sleep 60", { shell: true, detached: true, stdio: "ignore" });
	target.unref();
	cleanup.push(target.pid!);
	const deadmanId = "bg_deadman_test";
	writeFileSync(
		join(DIR, `${deadmanId}.json`),
		JSON.stringify({
			id: deadmanId, type: "command", command: "sleep 60", cwd: HOME, pid: target.pid,
			ownerPid: fakePi, sessionId: MY_SESSION, startedAt: new Date().toISOString(),
			status: "running", exitCode: null, signal: null, finishedAt: null,
		}),
	);
	const watcher = spawnWatcher(deadmanId, target.pid!, fakePi, 0);
	check("watcher spawned", typeof watcher === "number");
	let gone = false;
	for (let i = 0; i < 40; i++) {
		await sleepMs(300);
		if (!isAlive(target.pid!)) { gone = true; break; }
	}
	check("task killed after its pi died (grace 0)", gone, `pid ${target.pid} still alive`);
	check("watcher left a deadman marker", existsSync(join(DIR, `${deadmanId}.deadman`)));
	// config.json shares the tasks directory: it must never be parsed as a task
	// (that crashed list_tasks before the shape guard).
	const listed = await tools.get("list_tasks")!.execute("t", { status: "all" }, undefined, undefined, ctx);
	check("config.json is not listed as a task", !/config\.json/.test(listed.content[0].text), listed.content[0].text.slice(0, 200));
	const deadmanMeta = read(deadmanId);
	check("reaped task reports status killed + stoppedReason deadman", deadmanMeta.status === "killed" && deadmanMeta.stoppedReason === "deadman", JSON.stringify(deadmanMeta));
}

for (const pid of cleanup) {
	try { process.kill(-pid, "SIGKILL"); } catch {}
	try { process.kill(pid, "SIGKILL"); } catch {}
}
console.log(`\n${fails.length === 0 ? "ALL PASS" : `FAILURES: ${fails.join(", ")}`}`);
process.exit(fails.length === 0 ? 0 : 1);
