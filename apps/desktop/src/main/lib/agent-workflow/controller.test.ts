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
	return {
		id: `r${n}`,
		kind,
		status: "succeeded",
		attempt: 1,
		queuedAt: new Date(n * 1000).toISOString(),
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

	it("treats checks that changed since the run as not passed", () => {
		const t = task("quick", [
			run("quick"),
			run("checks", { checks: [passed()] }),
		]);
		// The project now has two approved checks; one result is not enough.
		expect(
			decideNext(
				t,
				noFiles,
				{ commands: ["bun run test", "bun run lint"] },
				settings,
			),
		).toMatchObject({ type: "run", kind: "fix" });
	});
});

describe("taskSpend", () => {
	it("counts each run once and says what is pending or unknown", () => {
		const t = task("implement", [
			run("implement", {
				reportedCostUsd: 0.4,
				liveCostUsd: 0.39,
				costState: "reported",
			}),
			run("checks"),
			run("review", {
				status: "running",
				liveCostUsd: 0.02,
				costState: "pending",
			}),
			run("fix", { status: "failed", failure: "error" }),
			run("fix", { liveCostUsd: 0.1, costState: "partial" }),
			run("review", { status: "failed", failure: "launch" }),
		]);
		expect(taskSpend(t)).toEqual({
			usd: 0.52,
			pendingRuns: 1,
			unknownRuns: 1,
			partialRuns: 1,
		});
	});
});
