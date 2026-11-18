import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type ParsedTranscript, parseTranscript } from "./transcript";

/**
 * Local usage metrics, as plain files under <ADE home>/metrics:
 * - sessions/<session id>.json — one summary per Claude Code session, rebuilt
 *   from its transcript on every Stop, so re-recording never double-counts.
 * - results.jsonl — pass/fail outcomes per run label, appended; latest wins.
 *
 * A run label ("<task>/<arm>", e.g. "T1/B") ties sessions to an M4 run. It is
 * read from <session cwd>/.ade/run-label the first time a session is recorded
 * and kept from then on.
 */

export const METRICS_SCHEMA_VERSION = 1;
const RUN_LABEL = /^[A-Za-z0-9._-]{1,32}\/[A-Za-z0-9._-]{1,16}$/;

export interface TaskProgressSnapshot {
	status?: string;
	/** Sum of per-step attempt counters. */
	attempts: number;
	/** Sum of per-step escalation counters. */
	escalations: number;
	/** Files in escalations/. */
	escalationReports: number;
}

export interface SessionMetrics extends ParsedTranscript {
	schemaVersion: number;
	transcriptPath: string;
	workspaceId?: string;
	label?: string;
	recordedAt: string;
	tasks: Record<string, TaskProgressSnapshot>;
}

export interface RunResult {
	label: string;
	outcome: "pass" | "fail";
	at: string;
	source: "manual" | "check";
	details?: string;
}

export function isValidRunLabel(label: string): boolean {
	return RUN_LABEL.test(label);
}

export function sessionsDir(metricsDir: string): string {
	return join(metricsDir, "sessions");
}

function resultsPath(metricsDir: string): string {
	return join(metricsDir, "results.jsonl");
}

/** Read <cwd>/.ade/run-label; undefined when missing or not a valid label. */
export function readRunLabel(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	try {
		const label = readFileSync(join(cwd, ".ade", "run-label"), "utf8").trim();
		return isValidRunLabel(label) ? label : undefined;
	} catch {
		return undefined;
	}
}

export function readTaskProgress(
	cwd: string,
	slug: string,
): TaskProgressSnapshot | undefined {
	const taskDir = join(cwd, ".ade", "tasks", slug);
	let progress: string;
	try {
		progress = readFileSync(join(taskDir, "progress.md"), "utf8");
	} catch {
		return undefined;
	}
	const sum = (pattern: RegExp) =>
		[...progress.matchAll(pattern)].reduce((n, m) => n + Number(m[1]), 0);
	let escalationReports = 0;
	try {
		escalationReports = readdirSync(join(taskDir, "escalations")).filter(
			(name) => name.endsWith(".md"),
		).length;
	} catch {
		// No escalations directory.
	}
	return {
		status: progress.match(/^Status:\s*(.+?)\s*$/m)?.[1],
		attempts: sum(/attempts:\s*(\d+)/g),
		escalations: sum(/escalations:\s*(\d+)/g),
		escalationReports,
	};
}

function readSession(path: string): SessionMetrics | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as SessionMetrics;
		return parsed.schemaVersion === METRICS_SCHEMA_VERSION ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value)}\n`, "utf8");
	renameSync(tmp, path);
}

/**
 * Rebuild and store the summary for one session. Returns undefined when the
 * transcript has no usage yet. Safe to call repeatedly for the same session.
 */
export function recordSessionUsage(params: {
	transcriptPath: string;
	metricsDir: string;
	workspaceId?: string;
	now?: Date;
}): SessionMetrics | undefined {
	const parsed = parseTranscript(params.transcriptPath);
	if (parsed.records.length === 0) return undefined;

	const dir = sessionsDir(params.metricsDir);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${parsed.sessionId}.json`);
	const previous = existsSync(path) ? readSession(path) : undefined;

	const tasks: Record<string, TaskProgressSnapshot> = {};
	if (parsed.cwd) {
		for (const slug of parsed.taskSlugs) {
			const snapshot = readTaskProgress(parsed.cwd, slug);
			if (snapshot) tasks[slug] = snapshot;
		}
	}

	const metrics: SessionMetrics = {
		...parsed,
		schemaVersion: METRICS_SCHEMA_VERSION,
		transcriptPath: params.transcriptPath,
		workspaceId: params.workspaceId ?? previous?.workspaceId,
		// The first label seen sticks, so changing .ade/run-label later only
		// affects new sessions.
		label: previous?.label ?? readRunLabel(parsed.cwd),
		recordedAt: (params.now ?? new Date()).toISOString(),
		tasks,
	};
	writeJsonAtomic(path, metrics);
	return metrics;
}

export function loadSessions(metricsDir: string): SessionMetrics[] {
	const dir = sessionsDir(metricsDir);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => readSession(join(dir, name)))
		.filter((session): session is SessionMetrics => session !== undefined);
}

export function appendRunResult(metricsDir: string, result: RunResult): void {
	if (!isValidRunLabel(result.label)) {
		throw new Error(`Invalid run label: ${result.label}`);
	}
	mkdirSync(metricsDir, { recursive: true });
	appendFileSync(
		resultsPath(metricsDir),
		`${JSON.stringify(result)}\n`,
		"utf8",
	);
}

/** Latest result per label. */
export function loadRunResults(metricsDir: string): Map<string, RunResult> {
	const results = new Map<string, RunResult>();
	let text: string;
	try {
		text = readFileSync(resultsPath(metricsDir), "utf8");
	} catch {
		return results;
	}
	for (const raw of text.split("\n")) {
		if (!raw.trim()) continue;
		try {
			const result = JSON.parse(raw) as RunResult;
			if (
				result?.label &&
				(result.outcome === "pass" || result.outcome === "fail")
			) {
				results.set(result.label, result);
			}
		} catch {
			// Skip a corrupt line.
		}
	}
	return results;
}
