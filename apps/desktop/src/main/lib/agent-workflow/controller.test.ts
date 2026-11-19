import { describe, expect, it } from "bun:test";
import { decideNext, taskSpend } from "./controller";
import type { TaskFiles, TaskRecord, TaskRun } from "./tasks";
import { defaultWorkflowSettings } from "./workflow-settings";

/** The transition rules, from recorded facts only (no processes). */

const settings = defaultWorkflowSettings();
const noFiles: TaskFiles = {
	hasPlan: false,
	planQuestions: [],
	openEscalations: [],
};
const noChecks = { commands: [] };
const checks = { commands: ["bun run test"] };

let n = 0;
function run(kind: TaskRun["kind"], extra: Partial<TaskRun> = {}): TaskRun {
	n++;
	// As ADE records them: every model run has a cap, and one that finished
	// normally reports its cost.
	const model = kind !== "checks";
	const reported = {
		...(model ? { maxBudgetUsd: 1 } : {}),
		...(model && (extra.status ?? "succeeded") === "succeeded"
			? { reportedCostUsd: 0.01, costState: "reported" as const }
			: {}),
	};
	return {
		id: `r${n}`,
		kind,
		status: "succeeded",
		attempt: 1,
		queuedAt: new Date(n * 1000).toISOString(),
		...reported,
		...extra,
	};
}

function task(
	route: TaskRecord["route"],
	runs: TaskRun[],
	extra: Partial<TaskRecord> = {},
): TaskRecord {
	return {
		version: 2,
		slug: "t",
		title: "t",
		description: "t",
		route,
		routeReasons: [],
		createdAt: new Date(0).toISOString(),
		mode: "auto",
		state: "idle",
		identity: { workspaceId: "w", worktreePath: "/w", baselineDirty: {} },
		limits: {
			budgetUsd: 10,
			maxCorrections: 2,
			maxReviewRounds: 3,
			maxEscalations: 1,
		},
		runs,
		...extra,
	};
}

const passed = (command = "bun run test") => ({
	command,
	exitCode: 0,
	timedOut: false,
	durationMs: 1,
	outputTail: "",
});

describe("decideNext", () => {
	it("starts each route at its first step", () => {
		expect(
			decideNext(task("quick", []), noFiles, checks, settings),
		).toMatchObject({
			type: "run",
			kind: "quick",
		});
		expect(
			decideNext(task("implement", []), noFiles, checks, settings),
		).toMatchObject({
			type: "run",
			kind: "implement",
		});
		expect(
			decideNext(task("plan", []), noFiles, checks, settings),
		).toMatchObject({
			type: "run",
			kind: "plan",
		});
	});

	it("waits while a run is in progress, whatever else is true", () => {
		const t = task("implement", [run("implement", { status: "running" })]);
		expect(decideNext(t, noFiles, checks, settings)).toEqual({ type: "wait" });
	});

	it("reroutes a quick task the quick run found too big", () => {
		const t = task("quick", [
			run("quick", { summary: "Needs implementer: touches 9 files" }),
		]);
		expect(decideNext(t, noFiles, checks, settings)).toMatchObject({
			type: "reroute",
			route: "implement",
		});
	});

	it("escalates an open report, within the escalation limit", () => {
		const files = { ...noFiles, openEscalations: ["001.md"] };
		const first = task("implement", [run("implement")]);
		expect(decideNext(first, files, checks, settings)).toMatchObject({
			type: "run",
			kind: "escalate",
		});
		const again = task("implement", [
			run("implement"),
			run("escalate"),
			run("fix"),
		]);
		expect(decideNext(again, files, checks, settings)).toMatchObject({
			type: "block",
		});
	});

	it("continues the build after an escalation is resolved", () => {
		const t = task("plan", [run("plan"), run("build"), run("escalate")]);
		expect(
			decideNext(t, { ...noFiles, hasPlan: true }, checks, settings),
		).toMatchObject({ type: "run", kind: "build" });
	});

	it("bounds review rounds", () => {
		const runs = [run("implement")];
		for (let i = 0; i < 3; i++) {
			runs.push(run("review", { status: "failed", failure: "error" }));
		}
		// Each failed review was acknowledged (resumed) by the user.
		const t = task("implement", runs, { acknowledgedRunId: runs[3].id });
		expect(decideNext(t, noFiles, noChecks, settings)).toMatchObject({
			type: "block",
			reason: "No passing review after 3 review round(s).",
		});
	});

	it("stops on a turn limit instead of retrying it", () => {
		const t = task("implement", [
			run("implement", { status: "failed", failure: "max-turns" }),
		]);
		expect(decideNext(t, noFiles, checks, settings)).toMatchObject({
			type: "block",
		});
	});

	it("pauses on a rate limit (temporary) instead of switching models", () => {
		const t = task("implement", [
			run("implement", {
				status: "failed",
				failure: "rate-limited",
				model: "claude-opus-5-5",
			}),
		]);
		expect(decideNext(t, noFiles, checks, settings)).toMatchObject({
			type: "pause",
		});
	});

	it("does not fall back when the setting is off", () => {
		const off = defaultWorkflowSettings();
		off.execution.cheaperFallback = false;
		const t = task("implement", [
			run("implement", {
				status: "failed",
				failure: "model-unavailable",
				model: "claude-sonnet-5-5",
			}),
		]);
		expect(decideNext(t, noFiles, checks, off)).toMatchObject({
			type: "block",
		});
		expect(decideNext(t, noFiles, checks, settings)).toMatchObject({
			type: "run",
			kind: "implement",
			fallbackFrom: "claude-sonnet-5-5",
		});
	});

	it("re-runs checks after every new change, never trusting old results", () => {
		const t = task("implement", [
			run("implement"),
			run("checks", { checks: [passed()] }),
			run("review", { verdict: "FAIL" }),
			run("fix"),
		]);
		expect(decideNext(t, noFiles, checks, settings)).toMatchObject({
			type: "checks",
		});
	});

	it("runs the implementer after a quick run that says it needs one", () => {
		// Regression: the flagged quick run used to count as the implementation,
		// so checks and review ran on code nobody changed.
		const flagged = run("quick", {
			summary: "Needs implementer: this touches the schema and 6 files",
		});
		const quick = task("quick", [flagged]);
		expect(decideNext(quick, noFiles, checks, settings)).toMatchObject({
			type: "reroute",
			route: "implement",
		});
		// After the reroute: the implementer, not checks or review.
		const rerouted = task("implement", [flagged]);
		expect(decideNext(rerouted, noFiles, checks, settings)).toMatchObject({
			type: "run",
			kind: "implement",
		});
		expect(decideNext(rerouted, noFiles, noChecks, settings)).toMatchObject({
			type: "run",
			kind: "implement",
		});
		// Once implemented, verification follows.
		const implemented = task("implement", [flagged, run("implement")]);
		expect(decideNext(implemented, noFiles, checks, settings)).toMatchObject({
			type: "checks",
		});
	});
});

describe("decideNext: check and review evidence", () => {
	const approved = { commands: ["bun run test", "bun run lint"] };
	const checksRun = (commands: string[], state = "S1") =>
		run("checks", {
			commands,
			codeState: state,
			checks: commands.map((command) => passed(command)),
		});

	it("accepts results only for the exact approved commands", () => {
		const t = task("quick", [
			run("quick"),
			checksRun(["bun run test", "bun run lint"]),
		]);
		expect(
			decideNext(t, noFiles, approved, settings, { codeState: "S1" }),
		).toMatchObject({ type: "done" });
		// Same number of commands, one changed: the old results do not count.
		expect(
			decideNext(
				t,
				noFiles,
				{ commands: ["bun run test", "bun run typecheck"] },
				settings,
				{ codeState: "S1" },
			),
		).toEqual({ type: "checks", reason: "the approved checks changed" });
		// A different order is a different approval too.
		expect(
			decideNext(
				t,
				noFiles,
				{ commands: ["bun run lint", "bun run test"] },
				settings,
				{ codeState: "S1" },
			),
		).toMatchObject({ type: "checks" });
		// A result recorded without its commands (older record) does not count.
		const legacy = task("quick", [
			run("quick"),
			run("checks", { codeState: "S1", checks: [passed(), passed()] }),
		]);
		expect(
			decideNext(legacy, noFiles, approved, settings, { codeState: "S1" }),
		).toMatchObject({ type: "checks" });
	});

	it("accepts results only for the code they ran on", () => {
		const t = task("quick", [
			run("quick"),
			checksRun(["bun run test", "bun run lint"], "S1"),
		]);
		expect(
			decideNext(t, noFiles, approved, settings, { codeState: "S2" }),
		).toEqual({
			type: "checks",
			reason: "the code changed since the checks ran",
		});
		// Outside git there is no code state: results stand.
		expect(decideNext(t, noFiles, approved, settings, {})).toMatchObject({
			type: "done",
		});
	});

	it("stops re-running checks when the code keeps changing under them", () => {
		const t = task("quick", [
			run("quick"),
			checksRun(approved.commands, "S1"),
			checksRun(approved.commands, "S2"),
			checksRun(approved.commands, "S3"),
		]);
		expect(
			decideNext(t, noFiles, approved, settings, { codeState: "S4" }),
		).toMatchObject({ type: "block" });
	});

	it("re-reviews when the code changed after a passing review", () => {
		const t = task("implement", [
			run("implement"),
			run("review", { verdict: "PASS", codeState: "S1" }),
		]);
		expect(
			decideNext(t, noFiles, noChecks, settings, { codeState: "S1" }),
		).toMatchObject({ type: "done" });
		expect(
			decideNext(t, noFiles, noChecks, settings, { codeState: "S2" }),
		).toEqual({
			type: "run",
			kind: "review",
			reason: "the code changed since the review",
		});
	});
});

describe("decideNext: after a move", () => {
	it("keeps history but requires reconciliation and fresh verification", () => {
		const before = [
			run("implement"),
			checksRun2(),
			run("review", { verdict: "PASS", codeState: "S1" }),
		];
		const moved = task("implement", before, { evidenceStart: before.length });
		// None of the earlier runs counts: implement (reconcile) again.
		expect(
			decideNext(moved, noFiles, checks, settings, { codeState: "S1" }),
		).toEqual({
			type: "run",
			kind: "implement",
			reason: "reconcile the work in this worktree",
		});
		// Then checks and review again, though old ones passed on the same code.
		const reconciled = task("implement", [...before, run("implement")], {
			evidenceStart: before.length,
		});
		expect(
			decideNext(reconciled, noFiles, checks, settings, { codeState: "S1" }),
		).toMatchObject({ type: "checks" });
	});

	it("counts corrections and old failures only since the move", () => {
		const before = [
			run("implement"),
			run("fix"),
			run("fix"),
			run("review", { status: "failed", failure: "error" }),
		];
		const moved = task("implement", [...before, run("implement")], {
			evidenceStart: before.length,
		});
		const failing = task(
			"implement",
			[
				...moved.runs,
				run("checks", {
					commands: checks.commands,
					codeState: "S1",
					checks: [{ ...passed(), exitCode: 1 }],
				}),
			],
			{ evidenceStart: before.length },
		);
		// Two fixes before the move do not exhaust the limit of 2.
		expect(
			decideNext(failing, noFiles, checks, settings, { codeState: "S1" }),
		).toMatchObject({ type: "run", kind: "fix" });
	});

	function checksRun2() {
		return run("checks", {
			commands: checks.commands,
			codeState: "S1",
			checks: [passed()],
		});
	}
});

describe("taskSpend and the budget", () => {
	it("counts each run once and keeps uncertain costs visible", () => {
		const t = task("implement", [
			run("implement", {
				reportedCostUsd: 0.4,
				liveCostUsd: 0.39,
				costState: "reported",
				maxBudgetUsd: 10,
			}),
			run("checks"),
			run("review", {
				status: "running",
				liveCostUsd: 0.02,
				costState: "pending",
				maxBudgetUsd: 9.6,
			}),
			run("fix", { status: "failed", failure: "error", maxBudgetUsd: 1 }),
			run("fix", {
				liveCostUsd: 0.1,
				reportedCostUsd: undefined,
				costState: "partial",
				maxBudgetUsd: 2,
			}),
			run("review", { status: "failed", failure: "launch" }),
		]);
		const spend = taskSpend(t);
		expect(spend.usd).toBeCloseTo(0.52, 6);
		// The running, unknown and partial runs count at their caps.
		expect(spend.worstCaseUsd).toBeCloseTo(0.4 + 9.6 + 1 + 2, 6);
		expect(spend).toMatchObject({
			pendingRuns: 1,
			unknownRuns: 1,
			partialRuns: 1,
			uncertainRuns: 3,
			unboundedRuns: 0,
		});
	});

	it("never treats an unknown cost as zero when deciding to launch", () => {
		// Regression: a run with no cost used to count as $0 of the budget.
		const t = task(
			"implement",
			[
				run("implement", {
					status: "cancelled",
					failure: "cancelled",
					maxBudgetUsd: 4,
				}),
			],
			{
				limits: {
					budgetUsd: 4,
					maxCorrections: 2,
					maxReviewRounds: 3,
					maxEscalations: 1,
				},
				acknowledgedRunId: "x",
			},
		);
		const decision = decideNext(t, noFiles, noChecks, settings);
		expect(decision.type).toBe("block");
		expect(decision.type === "block" && decision.reason).toContain(
			"may be used up",
		);
	});

	it("refuses Auto launches when an earlier run has no cost or cap", () => {
		const t = task("implement", [
			// Recorded before ADE set caps (upgraded first-version task).
			run("implement", {
				status: "interrupted",
				failure: "interrupted",
				maxBudgetUsd: undefined,
			}),
		]);
		expect(decideNext(t, noFiles, noChecks, settings)).toMatchObject({
			type: "block",
		});
	});
});
