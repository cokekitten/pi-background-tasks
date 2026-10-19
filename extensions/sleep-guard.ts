/**
 * Foreground-sleep guard — detection and policy only, no pi imports, so it can
 * be unit-tested without a pi runtime.
 *
 * Why this exists: `sleep 170; <check>` is a *guess* that some slow external job
 * finished. It holds the session for the whole duration (nobody can steer it)
 * and is wrong often enough that the guess has to be repeated. The two correct
 * shapes are `wait_until` (return the moment a condition holds — no guess) and
 * `run_background` (leave the turn, get woken on exit).
 *
 * Policy — the ability to sleep is never taken away:
 *   - mode "off"   : do nothing.
 *   - `PI_FG_SLEEP=1` anywhere in the command opts that command out entirely.
 *   - sleeps shorter than `minSeconds` are untouched (pacing, animation timing).
 *   - only a *leading* `sleep N` counts: `for … do sleep 4; done` and
 *     `curl …; sleep 20; curl …` are pacing, not waiting-for-a-job.
 *   - the first `escalateAfter - 1` occurrences per session are NOT blocked —
 *     the command runs normally and a hint is appended to its result.
 *   - from occurrence `escalateAfter` on, the command is promoted to a
 *     background task so the session stays interactive.
 */

export type SleepGuardMode = "off" | "warn" | "escalate";

export interface SleepGuardConfig {
	mode: SleepGuardMode;
	/** Leading sleeps shorter than this are left alone (seconds). */
	minSeconds: number;
	/** Per-session occurrence at which a matching command is promoted instead of hinted. */
	escalateAfter: number;
}

export const DEFAULT_SLEEP_GUARD: SleepGuardConfig = {
	mode: "escalate",
	minSeconds: 15,
	escalateAfter: 3,
};

/** Per-command opt-out marker: `PI_FG_SLEEP=1 sleep 90; …` runs untouched. */
export const EXEMPT_MARKER = "PI_FG_SLEEP";

const EXEMPT_RE = /\bPI_FG_SLEEP\s*=\s*(?:1|true|yes|on)\b/i;
// Leading `sleep N[smhd]` followed by a command separator, a newline, or nothing.
const LEADING_SLEEP_RE = /^\s*sleep\s+(\d+(?:\.\d+)?)\s*([smhd]?)\s*(?:[;&|\n]|$)/;
const UNIT_SECONDS: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

/** Normalise a raw `config.json` `.sleepGuard` object (unknown/invalid → defaults). */
export function resolveSleepGuardConfig(raw: unknown): SleepGuardConfig {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_SLEEP_GUARD };
	const r = raw as Record<string, unknown>;
	const mode = r.mode;
	return {
		mode: mode === "off" || mode === "warn" || mode === "escalate" ? mode : DEFAULT_SLEEP_GUARD.mode,
		minSeconds:
			typeof r.minSeconds === "number" && Number.isFinite(r.minSeconds) && r.minSeconds >= 0
				? r.minSeconds
				: DEFAULT_SLEEP_GUARD.minSeconds,
		escalateAfter:
			typeof r.escalateAfter === "number" && Number.isFinite(r.escalateAfter) && r.escalateAfter >= 1
				? Math.floor(r.escalateAfter)
				: DEFAULT_SLEEP_GUARD.escalateAfter,
	};
}

/** The command explicitly opted out of the guard. */
export function isExempt(command: string): boolean {
	return EXEMPT_RE.test(command ?? "");
}

/**
 * Parse a *leading* `sleep` out of a shell command.
 * Returns null when the command does not start with a sleep (pacing sleeps in
 * the middle of a command, or inside a loop, are not what this guard is about).
 */
export function parseForegroundSleep(command: string): { seconds: number; text: string } | null {
	const m = LEADING_SLEEP_RE.exec(command ?? "");
	if (!m) return null;
	const seconds = Number(m[1]) * (UNIT_SECONDS[m[2]] ?? 1);
	if (!Number.isFinite(seconds) || seconds <= 0) return null;
	return { seconds, text: m[0].trim() };
}

export type GuardAction = "allow" | "warn" | "promote";
export type GuardReason = "off" | "exempt" | "no-leading-sleep" | "below-threshold" | "hint" | "escalated";

export interface GuardDecision {
	action: GuardAction;
	reason: GuardReason;
	/** Seconds of the leading sleep (0 when nothing was parsed). */
	seconds: number;
	/** 1-based occurrence of a matching foreground sleep in this session. */
	occurrence: number;
}

/**
 * Decide what to do with one bash command.
 * `occurrence` is 1-based and counts *matching* (≥ minSeconds, non-exempt)
 * foreground sleeps seen so far in the session, including this one.
 */
export function decideSleepGuard(
	command: string,
	occurrence: number,
	config: SleepGuardConfig = DEFAULT_SLEEP_GUARD,
): GuardDecision {
	const occurrence_ = Math.max(1, occurrence);
	if (config.mode === "off") return { action: "allow", reason: "off", seconds: 0, occurrence: occurrence_ };
	if (isExempt(command)) return { action: "allow", reason: "exempt", seconds: 0, occurrence: occurrence_ };
	const parsed = parseForegroundSleep(command);
	if (!parsed) return { action: "allow", reason: "no-leading-sleep", seconds: 0, occurrence: occurrence_ };
	if (parsed.seconds < config.minSeconds) {
		return { action: "allow", reason: "below-threshold", seconds: parsed.seconds, occurrence: occurrence_ };
	}
	if (config.mode === "warn" || occurrence_ < config.escalateAfter) {
		return { action: "warn", reason: "hint", seconds: parsed.seconds, occurrence: occurrence_ };
	}
	return { action: "promote", reason: "escalated", seconds: parsed.seconds, occurrence: occurrence_ };
}

function fmtSeconds(s: number): string {
	return Number.isInteger(s) ? String(s) : String(Math.round(s * 10) / 10);
}

/** Appended to the bash result on a "warn" decision (nothing is blocked). */
export function sleepHint(decision: GuardDecision, config: SleepGuardConfig): string {
	const n = fmtSeconds(decision.seconds);
	const left = Math.max(0, config.escalateAfter - decision.occurrence);
	const tail =
		config.mode === "escalate" && left > 0
			? `\n(${decision.occurrence}/${config.escalateAfter} in this session — from #${config.escalateAfter} this shape is auto-promoted to a background task.)`
			: "";
	return (
		`\n\n[background-tasks] This call started with \`sleep ${n}\`, so it blocked the session for ~${n}s before running the check — that duration was a guess.` +
		`\n  • waiting for something to become true → \`wait_until { condition: "<exits 0 when ready>", timeoutMs: 600000 }\` returns the moment it holds (never early, never wasted).` +
		`\n  • waiting for a job to finish → \`run_background "<whole command, wait included>"\` ends the turn and wakes you on exit.` +
		`\n  • deliberate fixed sleep (rate-limit pacing, animation timing) → put \`${EXEMPT_MARKER}=1\` in the command and this guard leaves it alone.` +
		tail
	);
}

/** Block reason on a "promote" decision: the command already runs in the background. */
export function sleepPromoted(decision: GuardDecision, taskId: string, logFile: string): string {
	const n = fmtSeconds(decision.seconds);
	return (
		`[background-tasks] Not run in the foreground: this command starts with \`sleep ${n}\` (a guessed wait), and this session already paid for ${decision.occurrence - 1} of them.` +
		`\nIt is now running as background task ${taskId} (log: ${logFile}); the session stays interactive and you will be woken when it exits.` +
		`\nDo NOT re-issue the same command. If the sleep was deliberate, re-issue it with \`${EXEMPT_MARKER}=1\` and it runs in the foreground.` +
		`\nCorrect shapes: \`wait_until\` (condition-based, returns early) or \`run_background\` (whole wait inside the task).`
	);
}
