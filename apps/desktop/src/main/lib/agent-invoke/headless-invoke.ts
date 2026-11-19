import type { ParsedInvokeRequest } from "./agent-invoke";
import {
	finishHeadlessRun,
	type HeadlessRunParams,
	type HeadlessRunResult,
	tryStartHeadlessRun,
} from "./headless-run";

/**
 * Starts a headless (`claude -p`) agent run for POST /agent/invoke with
 * mode "headless". Returns the HTTP response at once; the run continues in
 * the background and reports through `onFinished`.
 */

export interface HeadlessLimits {
	headlessMaxBudgetUsd: number;
	headlessMaxTurns: number;
}

export interface HeadlessFinished {
	agent: string;
	cwd: string;
	model?: string;
	maxBudgetUsd: number;
	maxTurns: number;
	result: HeadlessRunResult;
}

export interface HeadlessInvokeDeps {
	limits: () => HeadlessLimits;
	findExecutable: () => string | null;
	run: (params: HeadlessRunParams) => Promise<HeadlessRunResult>;
	onFinished: (finished: HeadlessFinished) => void;
}

export type StartHeadlessResult =
	| {
			status: 202;
			body: {
				success: true;
				agent: string;
				mode: "headless";
				maxBudgetUsd: number;
				maxTurns: number;
			};
			/** Settles when the run has finished and been reported (for tests). */
			done: Promise<void>;
	  }
	| { status: 409 | 503; body: { success: false; error: string } };

export function startHeadlessInvoke(
	request: ParsedInvokeRequest,
	deps: HeadlessInvokeDeps,
): StartHeadlessResult {
	const limits = deps.limits();
	// A request may lower the spending cap, never raise it.
	const maxBudgetUsd = Math.min(
		request.maxBudgetUsd ?? limits.headlessMaxBudgetUsd,
		limits.headlessMaxBudgetUsd,
	);
	const maxTurns = limits.headlessMaxTurns;

	const executable = deps.findExecutable();
	if (!executable) {
		return {
			status: 503,
			body: { success: false, error: "Claude Code (claude) was not found" },
		};
	}
	// One unattended run per agent, so a misfiring trigger cannot pile up runs.
	if (!tryStartHeadlessRun(request.agent)) {
		return {
			status: 409,
			body: {
				success: false,
				error: `A headless run for ${request.agent} is already in progress`,
			},
		};
	}

	const done = deps
		.run({
			command: [executable],
			cwd: request.entry.cwd,
			prompt: request.prompt,
			maxBudgetUsd,
			maxTurns,
			model: request.model,
			claudeSessionId: request.claudeSessionId,
			fresh: request.fresh,
			permissionMode: request.permissionMode,
		})
		.catch(
			(error): HeadlessRunResult => ({
				exitCode: null,
				timedOut: false,
				durationMs: 0,
				stderrTail: String(error),
			}),
		)
		.then((result) => {
			try {
				deps.onFinished({
					agent: request.agent,
					cwd: request.entry.cwd,
					model: request.model,
					maxBudgetUsd,
					maxTurns,
					result,
				});
			} catch (error) {
				console.error("[agent-invoke] Reporting a headless run failed:", error);
			}
		})
		.finally(() => finishHeadlessRun(request.agent));

	return {
		status: 202,
		body: {
			success: true,
			agent: request.agent,
			mode: "headless",
			maxBudgetUsd,
			maxTurns,
		},
		done,
	};
}
