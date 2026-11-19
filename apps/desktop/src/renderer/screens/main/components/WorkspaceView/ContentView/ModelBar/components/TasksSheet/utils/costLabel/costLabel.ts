import type { RunView, TaskView } from "../../types";

export const usd = (value: number) => `$${value.toFixed(value < 1 ? 3 : 2)}`;

/**
 * A run's cost as honestly as ADE knows it. All amounts are API-equivalent
 * estimates; on a subscription they are not charges. Only a cost Claude Code
 * reported, or an estimate of a run that finished normally, is shown without
 * a qualifier.
 */
export function runCostLabel(run: RunView): string | null {
	if (run.kind === "checks") return null;
	if (run.failure === "launch" && run.liveCostUsd === null) return null;
	if (run.reportedCostUsd !== null) return usd(run.reportedCostUsd);
	const amount = run.liveCostUsd;
	const cap = run.maxBudgetUsd !== null ? `, cap ${usd(run.maxBudgetUsd)}` : "";
	if (run.status === "running" || run.status === "queued") {
		return amount !== null ? `${usd(amount)} so far` : "pending";
	}
	if (run.costState === "partial") {
		return amount !== null
			? `at least ${usd(amount)} (some responses unpriced${cap})`
			: `unknown (some responses unpriced${cap})`;
	}
	if (run.status === "succeeded" && run.costState === "estimated") {
		return amount !== null ? `~${usd(amount)} (estimate)` : "estimate";
	}
	// Cut short or failed without a reported cost: what ADE saw is a floor.
	return amount !== null && amount > 0
		? `at least ${usd(amount)} (not reported${cap})`
		: `unknown${cap ? ` (${cap.slice(2)})` : ""}`;
}

/**
 * A task's total. When some runs' cost is uncertain, the range goes up to
 * the worst case ADE uses for the budget (uncertain runs at their cap).
 */
export function taskCostLabel(spend: TaskView["spend"]): string {
	const notes: string[] = [];
	if (spend.pendingRuns > 0) notes.push("running");
	if (spend.uncertainRuns > 0) {
		notes.push(`${spend.uncertainRuns} run(s) uncertain`);
	}
	const amount =
		spend.worstCaseUsd > spend.usd + 0.0005
			? `${usd(spend.usd)}–${usd(spend.worstCaseUsd)}`
			: usd(spend.usd);
	return notes.length ? `${amount} (${notes.join(", ")})` : amount;
}
