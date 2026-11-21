import type { ArmSummary, RunSummary } from "./aggregate";
import { PRICING_SOURCE } from "./pricing";

/**
 * Renders recorded M4 runs as markdown for docs/plans/multi-model-workflow/
 * measurements.md, between the report markers.
 */

export const REPORT_START = "<!-- m4-report:start -->";
export const REPORT_END = "<!-- m4-report:end -->";

export const ARM_DESCRIPTIONS: Record<string, string> = {
	A: "Current baseline (your usual model, no workflow)",
	A2: "Efficient single model (one strong model at lower effort)",
	B: "Multi-model workflow (/plan, /build, /review)",
};

/** Proposed decision rule from measurements.md. */
export const MAX_COST_RATIO = 0.7;

const usd = (value: number | null) =>
	value === null ? "–" : `$${value.toFixed(value < 1 ? 4 : 2)}`;
const pct = (value: number | null) =>
	value === null ? "–" : `${Math.round(value * 100)}%`;
const minutes = (ms: number | null) =>
	ms === null ? "–" : `${(ms / 60_000).toFixed(1)} min`;
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

function costList(entries: Record<string, { usd: number }>): string {
	const sorted = Object.entries(entries).sort(([, a], [, b]) => b.usd - a.usd);
	return sorted.length
		? sorted.map(([name, value]) => `${name} ${usd(value.usd)}`).join(", ")
		: "–";
}

export interface ReportInput {
	runs: RunSummary[];
	arms: ArmSummary[];
	unlabeledSessions: number;
	unlabeledUsd: number;
	generatedAt: Date;
}

/** Compare the workflow arm (B) with the better of the baselines (A, A2). */
export function compareArms(arms: ArmSummary[]): string[] {
	const byArm = new Map(arms.map((arm) => [arm.arm, arm]));
	const workflow = byArm.get("B");
	const baselines = ["A", "A2"]
		.map((name) => byArm.get(name))
		.filter((arm): arm is ArmSummary => arm?.costPerSuccess != null);
	if (!workflow || workflow.costPerSuccess === null || baselines.length === 0) {
		return [
			"Not enough results to compare yet: arm B and at least one baseline (A or A2) each need a passing run.",
		];
	}
	const best = baselines.reduce((a, b) =>
		(a.costPerSuccess ?? Infinity) <= (b.costPerSuccess ?? Infinity) ? a : b,
	);
	const ratio =
		(workflow.costPerSuccess as number) / (best.costPerSuccess as number);
	const successOk = (workflow.successRate ?? 0) >= (best.successRate ?? 0);
	const costOk = ratio <= MAX_COST_RATIO;
	const lines = [
		`Arm B costs ${pct(ratio)} of arm ${best.arm} per successful task (${usd(workflow.costPerSuccess)} vs ${usd(best.costPerSuccess)}).`,
		`Success rate: B ${pct(workflow.successRate)}, ${best.arm} ${pct(best.successRate)}.`,
	];
	lines.push(
		successOk && costOk
			? `Meets the proposed rule (success rate not lower, cost at most ${pct(MAX_COST_RATIO)}): keep the workflow.`
			: `Does not meet the proposed rule (success rate not lower, cost at most ${pct(MAX_COST_RATIO)}): see section 6.`,
	);
	return lines;
}

export function renderM4Report(input: ReportInput): string {
	const lines: string[] = [];
	lines.push(
		`_Generated ${input.generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC from recorded sessions. Costs are list-price estimates (${PRICING_SOURCE})._`,
		"",
	);

	if (input.runs.length === 0) {
		lines.push("No labeled runs recorded yet.");
	} else {
		lines.push(
			"### By arm",
			"",
			"| Arm | What it is | Runs | Judged | Passed | Success rate | Total est. cost | **Cost per success** | Median active time | Escalations | Retries | Unpriced responses |",
			"|---|---|---|---|---|---|---|---|---|---|---|---|",
		);
		for (const arm of input.arms) {
			lines.push(
				`| ${cell(arm.arm)} | ${cell(ARM_DESCRIPTIONS[arm.arm] ?? "–")} | ${arm.runs} | ${arm.judged} | ${arm.successes} | ${pct(arm.successRate)} | ${usd(arm.totalUsd)} | **${usd(arm.costPerSuccess)}** | ${minutes(arm.medianActiveMs)} | ${arm.escalations} | ${arm.retries} | ${arm.unpricedMessages} |`,
			);
		}
		lines.push("", ...compareArms(input.arms).map((line) => `- ${line}`), "");

		lines.push(
			"### By run",
			"",
			"| Run | Result | Workflow status | Est. cost | Active time | Cost by model | Cost by role | Escalations | Review rounds | Retries | API errors |",
			"|---|---|---|---|---|---|---|---|---|---|---|",
		);
		for (const run of input.runs) {
			const result = run.result
				? `${run.result.outcome}${run.result.source === "check" ? " (checks)" : ""}`
				: "not judged";
			lines.push(
				`| ${cell(run.label)} | ${result} | ${cell(run.workflowStatus ?? "–")} | ${usd(run.cost.usd)} | ${minutes(run.activeMs)} | ${cell(costList(run.cost.byModel))} | ${cell(costList(run.cost.byAgent))} | ${run.escalations} | ${run.reviewRounds} | ${run.retries} | ${run.apiErrors} |`,
			);
		}
		lines.push("");

		const reasons = [
			...new Set(input.runs.flatMap((run) => run.cost.unpricedReasons)),
		];
		if (reasons.length) {
			lines.push(
				`Some responses could not be priced and count as $0: ${reasons.join("; ")}.`,
				"",
			);
		}
	}

	if (input.unlabeledSessions > 0) {
		lines.push(
			`${input.unlabeledSessions} recorded session(s) had no run label and are not included above (${usd(input.unlabeledUsd)} est.).`,
		);
	}
	return `${lines.join("\n").trim()}\n`;
}

/** Replace the text between the report markers; throws if they are missing. */
export function replaceReportSection(document: string, report: string): string {
	const start = document.indexOf(REPORT_START);
	const end = document.indexOf(REPORT_END);
	if (start === -1 || end === -1 || end < start) {
		throw new Error(
			`Report markers not found; add ${REPORT_START} and ${REPORT_END} to the file.`,
		);
	}
	return `${document.slice(0, start + REPORT_START.length)}\n${report}${document.slice(end)}`;
}
