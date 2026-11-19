import type { RunView, TaskView } from "../../types";

export const usd = (value: number) => `$${value.toFixed(value < 1 ? 3 : 2)}`;

/**
 * A run's cost as honestly as ADE knows it. All amounts are API-equivalent
 * estimates; on a subscription they are not charges.
 */
export function runCostLabel(run: RunView): string | null {
	if (run.kind === "checks") return null;
	const amount = run.reportedCostUsd ?? run.liveCostUsd;
	switch (run.costState) {
		case "pending":
			return amount !== null ? `${usd(amount)} so far` : "pending";
		case "reported":
			return amount !== null ? usd(amount) : "reported";
		case "estimated":
			return amount !== null ? `~${usd(amount)} (estimate)` : "estimate";
		case "partial":
			return amount !== null
				? `at least ${usd(amount)} (some responses unpriced)`
				: "partly unpriced";
		default:
			return amount !== null ? `~${usd(amount)}` : "cost unknown";
	}
}

/** A task's total, with what is still pending or unknown. */
export function taskCostLabel(spend: TaskView["spend"]): string {
	const parts = [usd(spend.usd)];
	if (spend.pendingRuns > 0) parts.push("running");
	if (spend.partialRuns > 0) parts.push("partly unpriced");
	if (spend.unknownRuns > 0) parts.push(`${spend.unknownRuns} run(s) unknown`);
	return parts.length > 1
		? `${parts[0]} (${parts.slice(1).join(", ")})`
		: parts[0];
}
