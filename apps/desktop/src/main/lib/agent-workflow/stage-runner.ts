import { type ChildProcess, spawn } from "node:child_process";
import { estimateCost } from "../usage-metrics/pricing";
import type { CostState, TaskRun } from "./tasks";

/**
 * One managed stage run: `claude -p` as a child process of ADE.
 *
 * - The prompt is written to stdin; it never appears in process arguments.
 * - Arguments are an array (no shell). Variadic options (--allowedTools,
 *   --add-dir, ...) are always followed by another option, and there is no
 *   positional argument for them to swallow.
 * - Model, effort, turn limit, budget and permissions are set on this process,
 *   so what ADE shows is what runs.
 * - `--output-format stream-json` gives progress while it runs: ADE prices
 *   each response as it arrives, so spend is visible before the run ends.
 * - Cancel and timeout kill the whole process tree.
 */

export type PermissionMode = "acceptEdits" | "default" | "bypassPermissions";

export interface StageRunSpec {
	/** Executable and leading arguments. */
	command: string[];
	cwd: string;
	prompt: string;
	model: string;
	effort: string;
	maxTurns: number;
	/** Claude Code stops the run when its estimate reaches this. */
	maxBudgetUsd?: number;
	permissionMode: PermissionMode;
	allowedTools?: string[];
	disallowedTools?: string[];
	addDirs?: string[];
	/** The workflow roles as --agents JSON. */
	agentsJson?: string;
	sessionId: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

export interface StageProgress {
	liveCostUsd: number;
	costState: CostState;
	observedModels: string[];
	responses: number;
	lastText?: string;
}

export interface StageRunResult {
	exitCode: number | null;
	timedOut: boolean;
	cancelled: boolean;
	sessionId?: string;
	reportedCostUsd?: number;
	numTurns?: number;
	isError?: boolean;
	subtype?: string;
	/** The run's final text. */
	text?: string;
	liveCostUsd: number;
	costState: CostState;
	observedModels: string[];
	unpricedModels: string[];
	failure?: TaskRun["failure"];
	error?: string;
	stderrTail: string;
}

export interface StageRunHandle {
	pid?: number;
	done: Promise<StageRunResult>;
	cancel: () => Promise<void>;
}

export interface StageRunDeps {
	spawnFn?: typeof spawn;
	/** Kill a process and its children. */
	killTree: (pid: number) => Promise<void>;
	onProgress?: (progress: StageProgress) => void;
}

export const DEFAULT_STAGE_TIMEOUT_MS = 60 * 60 * 1000;

export function buildStageArgs(spec: StageRunSpec): string[] {
	const args = [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--model",
		spec.model,
		"--effort",
		spec.effort,
		"--max-turns",
		String(spec.maxTurns),
		"--permission-mode",
		spec.permissionMode,
	];
	if (spec.maxBudgetUsd !== undefined) {
		args.push("--max-budget-usd", spec.maxBudgetUsd.toFixed(2));
	}
	if (spec.allowedTools?.length)
		args.push("--allowedTools", ...spec.allowedTools);
	if (spec.disallowedTools?.length) {
		args.push("--disallowedTools", ...spec.disallowedTools);
	}
	if (spec.addDirs?.length) args.push("--add-dir", ...spec.addDirs);
	if (spec.agentsJson) args.push("--agents", spec.agentsJson);
	// Last, and a single-value option: ends any variadic list above.
	args.push("--session-id", spec.sessionId);
	return args;
}

interface StreamUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_creation?: {
		ephemeral_5m_input_tokens?: number;
		ephemeral_1h_input_tokens?: number;
	};
	speed?: string;
	inference_geo?: string;
}

const num = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) ? value : 0;

/** Classify why a run did not succeed, from its result and stderr. */
export function classifyFailure(input: {
	exitCode: number | null;
	timedOut: boolean;
	cancelled: boolean;
	launchError?: string;
	isError?: boolean;
	subtype?: string;
	text?: string;
	stderr: string;
	hasResult: boolean;
}): TaskRun["failure"] | undefined {
	if (input.cancelled) return "cancelled";
	if (input.timedOut) return "timeout";
	if (input.launchError) return "launch";
	const succeeded = input.exitCode === 0 && input.hasResult && !input.isError;
	if (succeeded) return undefined;
	if (input.subtype === "error_max_turns") return "max-turns";
	if (input.subtype?.includes("budget")) return "budget";
	const text = `${input.text ?? ""}\n${input.stderr}`;
	// Temporary: wait and resume (never a reason to switch models).
	if (
		/rate.?limit|\b429\b|too many requests|usage limit|overloaded|\b529\b/i.test(
			text,
		)
	) {
		return "rate-limited";
	}
	if (
		/\b(401|403)\b|authentication|invalid api key|not logged in|\/login|unauthori[sz]ed/i.test(
			text,
		)
	) {
		return "auth";
	}
	if (
		/model[^\n]{0,80}(not found|not available|unavailable|does not exist|not supported|no access)|not_found_error|invalid model/i.test(
			text,
		)
	) {
		return "model-unavailable";
	}
	return "error";
}

export function startStageRun(
	spec: StageRunSpec,
	deps: StageRunDeps,
): StageRunHandle {
	const spawnFn = deps.spawnFn ?? spawn;
	const [executable, ...leading] = spec.command;
	const records = new Map<string, { model: string; usd: number | null }>();
	const observed = new Set<string>();
	const unpriced = new Set<string>();
	let lastText: string | undefined;
	let resultLine: Record<string, unknown> | undefined;
	let stderr = "";
	let cancelled = false;
	let timedOut = false;

	const progress = (): StageProgress => {
		let usd = 0;
		let anyUnpriced = false;
		for (const record of records.values()) {
			if (record.usd === null) anyUnpriced = true;
			else usd += record.usd;
		}
		return {
			liveCostUsd: usd,
			costState:
				records.size === 0 ? "pending" : anyUnpriced ? "partial" : "estimated",
			observedModels: [...observed],
			responses: records.size,
			lastText,
		};
	};

	const handleLine = (line: string) => {
		if (!line.trim()) return;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event.type === "result") {
			resultLine = event;
			return;
		}
		if (event.type !== "assistant") return;
		const message = event.message as
			| { id?: string; model?: string; usage?: StreamUsage; content?: unknown }
			| undefined;
		if (!message?.id || !message.model || message.model === "<synthetic>")
			return;
		observed.add(message.model);
		const usage = message.usage ?? {};
		const write1h = num(usage.cache_creation?.ephemeral_1h_input_tokens);
		const write5m = usage.cache_creation
			? num(usage.cache_creation.ephemeral_5m_input_tokens)
			: num(usage.cache_creation_input_tokens);
		const cost = estimateCost(message.model, {
			input: num(usage.input_tokens),
			output: num(usage.output_tokens),
			cacheRead: num(usage.cache_read_input_tokens),
			cacheWrite5m: write5m,
			cacheWrite1h: write1h,
			speed: usage.speed,
			geo: usage.inference_geo,
		});
		if (cost.usd === null) unpriced.add(message.model);
		records.set(message.id, { model: message.model, usd: cost.usd });
		if (Array.isArray(message.content)) {
			for (const block of message.content as Array<{
				type?: string;
				text?: string;
			}>) {
				if (block?.type === "text" && block.text)
					lastText = block.text.slice(-500);
			}
		}
		deps.onProgress?.(progress());
	};

	let child: ChildProcess | undefined;
	let launchError: string | undefined;
	try {
		child = spawnFn(executable, [...leading, ...buildStageArgs(spec)], {
			cwd: spec.cwd,
			env: spec.env ?? process.env,
			shell: false,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		launchError = String(error);
	}

	const done = new Promise<StageRunResult>((resolveDone) => {
		let finished = false;
		const finish = (exitCode: number | null, extraError?: string) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			const live = progress();
			const reported = resultLine ? resultLine.total_cost_usd : undefined;
			const text =
				typeof resultLine?.result === "string" ? resultLine.result : undefined;
			const subtype =
				typeof resultLine?.subtype === "string"
					? resultLine.subtype
					: undefined;
			const isError =
				typeof resultLine?.is_error === "boolean"
					? resultLine.is_error
					: undefined;
			const failure = classifyFailure({
				exitCode,
				timedOut,
				cancelled,
				launchError: launchError ?? extraError,
				isError,
				subtype,
				text,
				stderr,
				hasResult: resultLine !== undefined,
			});
			const reportedCostUsd =
				typeof reported === "number" && Number.isFinite(reported)
					? reported
					: undefined;
			resolveDone({
				exitCode,
				timedOut,
				cancelled,
				sessionId:
					typeof resultLine?.session_id === "string"
						? resultLine.session_id
						: undefined,
				reportedCostUsd,
				numTurns:
					typeof resultLine?.num_turns === "number"
						? resultLine.num_turns
						: undefined,
				isError,
				subtype,
				text: text?.slice(-4000),
				liveCostUsd: live.liveCostUsd,
				costState:
					reportedCostUsd !== undefined
						? "reported"
						: live.costState === "pending"
							? "unknown"
							: live.costState,
				observedModels: live.observedModels,
				unpricedModels: [...unpriced],
				failure,
				error: failure
					? (
							launchError ??
							extraError ??
							(text || stderr.trim() || `exit ${exitCode}`)
						).slice(-2000)
					: undefined,
				stderrTail: stderr.slice(-4000),
			});
		};

		const timer = setTimeout(() => {
			timedOut = true;
			if (child?.pid) void deps.killTree(child.pid);
		}, spec.timeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS);

		if (!child) {
			finish(null);
			return;
		}
		let buffered = "";
		child.stdout?.on("data", (chunk) => {
			buffered += chunk;
			let newline = buffered.indexOf("\n");
			while (newline !== -1) {
				handleLine(buffered.slice(0, newline));
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
			}
		});
		child.stderr?.on("data", (chunk) => {
			stderr = (stderr + chunk).slice(-8000);
		});
		child.on("error", (error) => {
			launchError = String(error);
			// A process that never started may not emit "close".
			setTimeout(() => finish(null), 100);
		});
		child.on("close", (code) => {
			if (buffered) handleLine(buffered);
			finish(launchError ? null : code);
		});
		child.stdin?.on("error", () => {
			// The process exited before reading its prompt; reported via close.
		});
		child.stdin?.end(spec.prompt, "utf8");
	});

	return {
		pid: child?.pid,
		done,
		cancel: async () => {
			cancelled = true;
			if (child?.pid) await deps.killTree(child.pid);
		},
	};
}
