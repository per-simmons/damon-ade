import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Headless Claude Code runs for unattended /agent/invoke calls, with a hard
 * spending cap: `claude -p --output-format json --max-budget-usd N
 * --max-turns M`. Both caps exist only in print mode, which is why the
 * interactive terminal path can only warn.
 *
 * The process is started with an argument array and no shell, so the prompt
 * is passed to Claude Code exactly as given, whatever characters it contains.
 */

/** Windows limits a whole command line to 32,767 characters. */
export const MAX_HEADLESS_PROMPT_LENGTH = 30_000;
export const DEFAULT_HEADLESS_TIMEOUT_MS = 60 * 60 * 1000;

export interface HeadlessRunParams {
	/** Command and leading arguments, e.g. ["/usr/local/bin/claude"]. */
	command: string[];
	cwd: string;
	prompt: string;
	maxBudgetUsd: number;
	maxTurns: number;
	model?: string;
	claudeSessionId?: string;
	/** true = new session pinned with --session-id; false = --resume. */
	fresh: boolean;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

/** Fields read from `claude -p --output-format json`; all optional. */
export interface HeadlessReport {
	sessionId?: string;
	totalCostUsd?: number;
	numTurns?: number;
	isError?: boolean;
	subtype?: string;
	durationMs?: number;
}

export interface HeadlessRunResult {
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	report?: HeadlessReport;
	/** Last part of stderr, for diagnosing failures. */
	stderrTail: string;
	/** Set when stdout was not the expected JSON. */
	parseError?: string;
}

export function buildHeadlessArgs(
	params: Omit<HeadlessRunParams, "command" | "cwd">,
): string[] {
	const args = [
		"-p",
		"--output-format",
		"json",
		"--max-budget-usd",
		String(params.maxBudgetUsd),
		"--max-turns",
		String(params.maxTurns),
		"--dangerously-skip-permissions",
	];
	if (params.model) args.push("--model", params.model);
	if (params.claudeSessionId) {
		args.push(
			params.fresh ? "--session-id" : "--resume",
			params.claudeSessionId,
		);
	}
	// A leading "-" would be read as an option; a leading space is harmless.
	args.push(
		params.prompt.startsWith("-") ? ` ${params.prompt}` : params.prompt,
	);
	return args;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

export function parseHeadlessOutput(
	stdout: string,
): HeadlessReport | undefined {
	const text = stdout.trim();
	if (!text) return undefined;
	// The JSON result is the last line in case anything was printed before it.
	const last = text.slice(text.lastIndexOf("\n") + 1);
	const parsed = JSON.parse(last) as Record<string, unknown>;
	return {
		sessionId:
			typeof parsed.session_id === "string" ? parsed.session_id : undefined,
		totalCostUsd: num(parsed.total_cost_usd),
		numTurns: num(parsed.num_turns),
		isError: typeof parsed.is_error === "boolean" ? parsed.is_error : undefined,
		subtype: typeof parsed.subtype === "string" ? parsed.subtype : undefined,
		durationMs: num(parsed.duration_ms),
	};
}

export function runHeadlessClaude(
	params: HeadlessRunParams,
): Promise<HeadlessRunResult> {
	const [executable, ...leading] = params.command;
	const started = Date.now();
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn(executable, [...leading, ...buildHeadlessArgs(params)], {
				cwd: params.cwd,
				env: params.env ?? process.env,
				shell: false,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			resolve({
				exitCode: null,
				timedOut: false,
				durationMs: 0,
				stderrTail: String(error),
			});
			return;
		}

		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr = (stderr + chunk).slice(-4000);
		});

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, params.timeoutMs ?? DEFAULT_HEADLESS_TIMEOUT_MS);

		const finish = (exitCode: number | null, extraError?: string) => {
			clearTimeout(timer);
			let report: HeadlessReport | undefined;
			let parseError: string | undefined;
			try {
				report = parseHeadlessOutput(stdout);
				if (!report) parseError = "no output";
			} catch (error) {
				parseError = `output was not JSON: ${String(error)}`;
			}
			resolve({
				exitCode,
				timedOut,
				durationMs: Date.now() - started,
				report,
				stderrTail: `${stderr}${extraError ? `\n${extraError}` : ""}`.trim(),
				parseError,
			});
		};
		child.on("error", (error) => finish(null, String(error)));
		child.on("close", (code) => finish(code));
	});
}

/**
 * The real Claude Code executable. `found` is a PATH lookup result. An npm
 * install on Windows puts a shell/.cmd shim on PATH, which cannot be spawned
 * without a shell, so the package's own executable is used instead.
 */
export function resolveClaudeExecutable(found: string | null): string | null {
	const override = process.env.ADE_CLAUDE_BINARY;
	if (override) return existsSync(override) ? override : null;
	if (!found) return null;
	if (process.platform !== "win32" || found.toLowerCase().endsWith(".exe")) {
		return found;
	}
	const packaged = join(
		dirname(found),
		"node_modules",
		"@anthropic-ai",
		"claude-code",
		"bin",
		"claude.exe",
	);
	return existsSync(packaged) ? packaged : null;
}

/** Agents with a headless run in progress; one at a time per agent. */
const running = new Set<string>();

export function tryStartHeadlessRun(agent: string): boolean {
	if (running.has(agent)) return false;
	running.add(agent);
	return true;
}

export function finishHeadlessRun(agent: string): void {
	running.delete(agent);
}
