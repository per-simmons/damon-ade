import { estimateCost } from "./pricing";
import type { RunResult, SessionMetrics } from "./store";
import type { UsageRecord } from "./transcript";

/**
 * Turns stored session metrics into costs per session, per run and per arm.
 * Costs are computed here from token counts, so a price correction applies to
 * everything already recorded.
 */

export interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite5m: number;
	cacheWrite1h: number;
}

export interface CostBreakdown {
	usd: number;
	messages: number;
	unpricedMessages: number;
	unpricedReasons: string[];
	tokens: TokenTotals;
	byModel: Record<
		string,
		{ usd: number; messages: number; tokens: TokenTotals }
	>;
	/** "main" or the subagent type (planner, implementer, ...). */
	byAgent: Record<string, { usd: number; messages: number; models: string[] }>;
}

function emptyTokens(): TokenTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite5m: 0,
		cacheWrite1h: 0,
	};
}

function addTokens(into: TokenTotals, record: UsageRecord): void {
	into.input += record.input;
	into.output += record.output;
	into.cacheRead += record.cacheRead;
	into.cacheWrite5m += record.cacheWrite5m;
	into.cacheWrite1h += record.cacheWrite1h;
}

export function costOf(records: UsageRecord[]): CostBreakdown {
	const breakdown: CostBreakdown = {
		usd: 0,
		messages: 0,
		unpricedMessages: 0,
		unpricedReasons: [],
		tokens: emptyTokens(),
		byModel: {},
		byAgent: {},
	};
	const reasons = new Set<string>();

	for (const record of records) {
		const cost = estimateCost(record.model, record);
		const usd = cost.usd ?? 0;
		if (cost.usd === null) {
			breakdown.unpricedMessages++;
			reasons.add(cost.unpricedReason);
		}
		breakdown.usd += usd;
		breakdown.messages++;
		addTokens(breakdown.tokens, record);

		const model = breakdown.byModel[record.model] ?? {
			usd: 0,
			messages: 0,
			tokens: emptyTokens(),
		};
		breakdown.byModel[record.model] = model;
		model.usd += usd;
		model.messages++;
		addTokens(model.tokens, record);

		const agent = breakdown.byAgent[record.agentType] ?? {
			usd: 0,
			messages: 0,
			models: [],
		};
		breakdown.byAgent[record.agentType] = agent;
		agent.usd += usd;
		agent.messages++;
		if (!agent.models.includes(record.model)) agent.models.push(record.model);
	}
	breakdown.unpricedReasons = [...reasons].sort();
	return breakdown;
}

/**
 * Give every API message to exactly one session. A resumed or forked session
 * can repeat earlier messages under a new session id; each message id is
 * counted once, in the earliest session that contains it.
 */
export function dedupeAcrossSessions(
	sessions: SessionMetrics[],
): Map<string, UsageRecord[]> {
	const ordered = [...sessions].sort((a, b) =>
		(a.firstAt ?? "").localeCompare(b.firstAt ?? ""),
	);
	const seen = new Set<string>();
	const owned = new Map<string, UsageRecord[]>();
	for (const session of ordered) {
		const records: UsageRecord[] = [];
		for (const record of session.records) {
			if (seen.has(record.id)) continue;
			seen.add(record.id);
			records.push(record);
		}
		owned.set(session.sessionId, records);
	}
	return owned;
}

export interface RunSummary {
	label: string;
	task: string;
	arm: string;
	sessionIds: string[];
	cost: CostBreakdown;
	/** First to last transcript timestamp across the run's sessions. */
	wallMs: number;
	/** Sum of turn durations (human prompt to last response). */
	activeMs: number;
	humanPrompts: number;
	subagentCalls: Record<string, number>;
	/** Architect calls: escalations to the reasoning model. */
	escalations: number;
	reviewRounds: number;
	/** Reviewer rounds beyond the first, plus recorded step retries. */
	retries: number;
	apiErrors: number;
	/** Status from the task's progress.md, when the run used the workflow. */
	workflowStatus?: string;
	result?: RunResult;
}

export function summarizeRuns(
	sessions: SessionMetrics[],
	results: Map<string, RunResult>,
): RunSummary[] {
	const owned = dedupeAcrossSessions(sessions);
	const byLabel = new Map<string, SessionMetrics[]>();
	for (const session of sessions) {
		if (!session.label) continue;
		const list = byLabel.get(session.label) ?? [];
		list.push(session);
		byLabel.set(session.label, list);
	}

	const runs: RunSummary[] = [];
	for (const [label, runSessions] of byLabel) {
		const [task, arm] = label.split("/");
		const records = runSessions.flatMap(
			(session) => owned.get(session.sessionId) ?? [],
		);
		const subagentCalls: Record<string, number> = {};
		let activeMs = 0;
		let humanPrompts = 0;
		let apiErrors = 0;
		let stepRetries = 0;
		let workflowStatus: string | undefined;
		const times: string[] = [];

		for (const session of runSessions) {
			activeMs += session.activeMs;
			humanPrompts += session.humanPrompts;
			apiErrors += session.apiErrors;
			if (session.firstAt) times.push(session.firstAt);
			if (session.lastAt) times.push(session.lastAt);
			for (const [type, count] of Object.entries(session.subagentCalls)) {
				subagentCalls[type] = (subagentCalls[type] ?? 0) + count;
			}
		}
		// Task progress from the most recently recorded session.
		const latest = [...runSessions].sort((a, b) =>
			b.recordedAt.localeCompare(a.recordedAt),
		)[0];
		for (const snapshot of Object.values(latest?.tasks ?? {})) {
			workflowStatus = snapshot.status ?? workflowStatus;
			// The first attempt at each step is not a retry; counters record
			// attempts after a failed check, so they are retries already.
			stepRetries += snapshot.attempts;
		}

		times.sort();
		const reviewRounds = subagentCalls.reviewer ?? 0;
		runs.push({
			label,
			task: task ?? label,
			arm: arm ?? "",
			sessionIds: runSessions.map((session) => session.sessionId).sort(),
			cost: costOf(records),
			wallMs:
				times.length > 1
					? Date.parse(times[times.length - 1]) - Date.parse(times[0])
					: 0,
			activeMs,
			humanPrompts,
			subagentCalls,
			escalations: subagentCalls.architect ?? 0,
			reviewRounds,
			retries: Math.max(0, reviewRounds - 1) + stepRetries,
			apiErrors,
			workflowStatus,
			result: results.get(label),
		});
	}
	return runs.sort((a, b) => a.label.localeCompare(b.label));
}

export interface ArmSummary {
	arm: string;
	runs: number;
	/** Runs with a recorded result. */
	judged: number;
	successes: number;
	successRate: number | null;
	totalUsd: number;
	/** Total cost of all runs (failed ones included) / successes. */
	costPerSuccess: number | null;
	medianActiveMs: number | null;
	escalations: number;
	retries: number;
	unpricedMessages: number;
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarizeArms(runs: RunSummary[]): ArmSummary[] {
	const byArm = new Map<string, RunSummary[]>();
	for (const run of runs) {
		const list = byArm.get(run.arm) ?? [];
		list.push(run);
		byArm.set(run.arm, list);
	}
	return [...byArm.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([arm, armRuns]) => {
			const judged = armRuns.filter((run) => run.result);
			const successes = judged.filter((run) => run.result?.outcome === "pass");
			const totalUsd = armRuns.reduce((sum, run) => sum + run.cost.usd, 0);
			return {
				arm,
				runs: armRuns.length,
				judged: judged.length,
				successes: successes.length,
				successRate: judged.length ? successes.length / judged.length : null,
				totalUsd,
				costPerSuccess: successes.length ? totalUsd / successes.length : null,
				medianActiveMs: median(armRuns.map((run) => run.activeMs)),
				escalations: armRuns.reduce((sum, run) => sum + run.escalations, 0),
				retries: armRuns.reduce((sum, run) => sum + run.retries, 0),
				unpricedMessages: armRuns.reduce(
					(sum, run) => sum + run.cost.unpricedMessages,
					0,
				),
			};
		});
}
