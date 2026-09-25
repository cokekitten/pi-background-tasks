/**
 * Regression test for task ownership + release semantics.
 *
 * Bug being pinned down: session_start adopted *any* running task whose
 * recorded ownerPid looked dead — including tasks spawned by a *different*
 * pi session whose child is detached and still running. The next session to
 * start therefore inherited someone else's dev server and rendered
 * "Waiting for 1 background task to finish" for work it never started.
 *
 * Ownership is sessionId-scoped: a task may only be claimed by the session
 * that spawned it (or by the same pi process after /reload).
 *
 * Run: node --experimental-strip-types test/ownership.test.ts
 *      (or: ~/.pi/agent/npm/node_modules/.bin/tsx test/ownership.test.ts)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- isolate state dir BEFORE the extension module is loaded --------------
const HOME = mkdtempSync(join(tmpdir(), "pi-bg-test-"));
process.env.HOME = HOME;
const DIR = join(HOME, ".pi", "background-tasks");
mkdirSync(DIR, { recursive: true });

const { Value } = await import("typebox/value");
const ext = (await import("../extensions/background-tasks.ts")).default;

const MY_SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
const DEAD_PID = 999_999; // beyond max pid on macOS -> isAlive() false

type Tool = { name: string; parameters: unknown; execute: (...a: any[]) => Promise<any> };
const tools = new Map<string, Tool>();
const handlers = new Map<string, (e: any, ctx: any) => void>();
let sent: string[] = [];
let widgetFactory: any;
let widgetCleared = 0;

const pi: any = {
	registerTool: (t: Tool) => tools.set(t.name, t),
	on: (ev: string, fn: any) => handlers.set(ev, fn),
	sendMessage: (m: any) => sent.push(String(m?.content ?? "")),
};
ext(pi);

const theme = { fg: (_k: string, text: string) => text };
const ui: any = {
	setWidget: (_key: string, factory: any) => {
		if (factory === undefined) widgetCleared++;
		widgetFactory = factory;
	},
	setStatus: () => {},
};
function makeCtx(sessionId: string) {
	return {
		hasUI: true,
		mode: "tui" as const,
		ui,
		sessionManager: { getSessionId: () => sessionId },
	};
}
/** The exact string a user would see above the input box ("" = no widget). */
function widgetText(width = 100): string {
	if (!widgetFactory) return "";
	const w = widgetFactory({ requestRender: () => {} }, theme);
	const lines: string[] = w.render(width);
	return lines.join("").replace(/[✻✽✾]/g, "").trim();
}

// --- helpers --------------------------------------------------------------
function liveDetachedPid(cmd = "sleep 300"): number {
	const c = spawn(cmd, { shell: true, detached: true, stdio: "ignore" });
	const pid = c.pid!;
	c.unref();
	cleanup.push(pid);
	return pid;
}
const cleanup: number[] = [];
const seed = (meta: Record<string, unknown>) => {
	writeFileSync(join(DIR, `${meta.id}.json`), JSON.stringify(meta));
};
const read = (id: string) => JSON.parse(readFileSync(join(DIR, `${id}.json`), "utf8"));
const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const fails: string[] = [];
function check(name: string, cond: boolean, extra = "") {
	console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra && !cond ? `\n         ${extra}` : ""}`);
	if (!cond) fails.push(name);
}

// --- fixtures: one task from ANOTHER session, one from ours --------------
const foreignPid = liveDetachedPid();
seed({
	id: "bg_foreign", type: "command", command: "pnpm dsh web", cwd: "/tmp",
	pid: foreignPid, ownerPid: DEAD_PID, sessionId: OTHER_SESSION, // owner session已退出
	startedAt: "2026-09-24T15:41:32.703Z", status: "running", exitCode: null, signal: null, finishedAt: null,
});
const foreignBefore = readFileSync(join(DIR, "bg_foreign.json"), "utf8");

const minePid = liveDetachedPid();
seed({
	id: "bg_mine", type: "command", command: "sleep 400", cwd: "/tmp",
	pid: minePid, ownerPid: DEAD_PID, sessionId: MY_SESSION, // 本会话重启前的任务
	startedAt: "2026-09-25T01:00:00.000Z", status: "running", exitCode: null, signal: null, finishedAt: null,
});

// A legacy meta with no sessionId at all (pre-fix leftovers) must not be grabbed either.
const legacyPid = liveDetachedPid();
seed({
	id: "bg_legacy", type: "command", command: "sleep 500", cwd: "/tmp",
	pid: legacyPid, startedAt: "2026-08-01T01:00:00.000Z", status: "running",
	exitCode: null, signal: null, finishedAt: null,
});

// --- T1: session_start must not adopt foreign tasks ----------------------
console.log("\nT1 ownership");
handlers.get("session_start")!({}, makeCtx(MY_SESSION));
check("foreign task untouched on disk", readFileSync(join(DIR, "bg_foreign.json"), "utf8") === foreignBefore);
check("legacy (no sessionId) task untouched", !read("bg_legacy").released && read("bg_legacy").ownerPid === undefined);
check("own task reclaimed after restart", read("bg_mine").ownerPid === process.pid);
check("widget counts only our own task", widgetText().includes("Waiting for 1 background task to finish"), widgetText());

// --- T2: list_tasks reports ownership instead of silently absorbing ------
console.log("\nT2 list_tasks");
const listed = await tools.get("list_tasks")!.execute("t", { status: "running" }, undefined, undefined, makeCtx(MY_SESSION));
console.log(listed.content[0].text.replace(/^/gm, "    "));
check("lists foreign task as other-session", /other-session/.test(listed.content[0].text));
check("counts all 3 running on disk, only ours watched here", /3 running \(1 watched by this session\)/.test(listed.content[0].text));

// --- T3: release un-watches without killing -----------------------------
console.log("\nT3 release");
const rel = await tools.get("kill_task")!.execute("t", { id: "bg_mine", mode: "release" }, undefined, undefined, makeCtx(MY_SESSION));
check("release reported success", rel.details?.released === true, JSON.stringify(rel.details));
check("process still alive after release", isAlive(minePid));
check("meta marked released + unowned", read("bg_mine").released === true && read("bg_mine").ownerPid === 0);
check("widget cleared", widgetText() === "" && widgetCleared > 0, widgetText());
handlers.get("session_start")!({}, makeCtx(MY_SESSION));
check("released task is not re-adopted on next start", widgetText() === "", widgetText());
const relForeign = await tools.get("kill_task")!.execute("t", { id: "bg_legacy", mode: "release" }, undefined, undefined, makeCtx(MY_SESSION));
check("release works for a straggler we never owned", relForeign.details?.released === true);

// --- T4: kill still terminates the group ---------------------------------
console.log("\nT4 kill");
const killRes = await tools.get("kill_task")!.execute("t", { id: "bg_mine" }, undefined, undefined, makeCtx(MY_SESSION));
await new Promise((r) => setTimeout(r, 400));
check("kill says killed", killRes.details?.killed === true);
check("process group gone", !isAlive(minePid), `pid ${minePid} still alive`);

// --- T5: monitors refuse release (pipe backpressure) ---------------------
console.log("\nT5 monitor guard");
const mon = await tools.get("monitor")!.execute("t", { command: "for i in 1 2 3; do echo line$i; sleep 0.2; done", maxEvents: 10 }, undefined, undefined, makeCtx(MY_SESSION));
const monId = mon.details?.taskId as string;
const relMon = await tools.get("kill_task")!.execute("t", { id: monId, mode: "release" }, undefined, undefined, makeCtx(MY_SESSION));
check("monitor release rejected", relMon.isError === true);
await new Promise((r) => setTimeout(r, 900));
const monKill = await tools.get("kill_task")!.execute("t", { id: monId }, undefined, undefined, makeCtx(MY_SESSION));
check("monitor kill accepted", monKill.details?.killed === true || monKill.isError !== true, JSON.stringify(monKill.details));

// --- T6: schema still validates against the LLM contract ----------------
console.log("\nT6 schema");
const killSchema = tools.get("kill_task")!.parameters;
check("mode accepts kill/release", Value.Check(killSchema, { id: "x", mode: "release" }) && Value.Check(killSchema, { id: "x" }));
check("mode rejects bogus value", !Value.Check(killSchema, { id: "x", mode: "nope" }));
check("list_tasks status validates", Value.Check(tools.get("list_tasks")!.parameters, { status: "all" }) && !Value.Check(tools.get("list_tasks")!.parameters, { status: 3 }));

// --- T7: dead pid self-heals to completed -------------------------------
console.log("\nT7 reconcile");
const deadPid = liveDetachedPid("sleep 0.05");
seed({
	id: "bg_dead", type: "command", command: "true", cwd: "/tmp", pid: deadPid,
	sessionId: OTHER_SESSION, startedAt: "2026-09-25T02:00:00.000Z", status: "running",
	exitCode: null, signal: null, finishedAt: null,
});
await new Promise((r) => setTimeout(r, 200));
await tools.get("list_tasks")!.execute("t", { status: "all" }, undefined, undefined, makeCtx(MY_SESSION));
check("dead pid flipped to completed", read("bg_dead").status === "completed");

for (const pid of cleanup) {
	try { process.kill(-pid, "SIGKILL"); } catch {}
	try { process.kill(pid, "SIGKILL"); } catch {}
}
console.log(`\n${fails.length === 0 ? "ALL PASS" : `FAILURES: ${fails.join(", ")}`}  (state dir ${DIR}, ${readdirSync(DIR).length} files)`);
process.exit(fails.length === 0 ? 0 : 1);
