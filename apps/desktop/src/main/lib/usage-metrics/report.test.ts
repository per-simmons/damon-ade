import { describe, expect, it } from "bun:test";
import type { ArmSummary, RunSummary } from "./aggregate";
import { costOf } from "./aggregate";
import {
	compareArms,
	REPORT_END,
	REPORT_START,
	renderM4Report,
	replaceReportSection,
} from "./report";
import { encodeProjectDir } from "./transcript";

function arm(
	name: string,
	costPerSuccess: number | null,
	successRate: number | null,
): ArmSummary {
	return {
		arm: name,
		runs: 2,
		judged: 2,
		successes: successRate === null ? 0 : Math.round(successRate * 2),
		successRate,
		totalUsd: (costPerSuccess ?? 0) * 2,
		costPerSuccess,
		medianActiveMs: 120_000,
		escalations: 0,
		retries: 0,
		unpricedMessages: 0,
	};
}

describe("compareArms", () => {
	it("keeps the workflow when it is cheaper per success and no less reliable", () => {
		const lines = compareArms([
			arm("A", 10, 1),
			arm("A2", 8, 1),
			arm("B", 4, 1),
		]);
		expect(lines[0]).toBe(
			"Arm B costs 50% of arm A2 per successful task ($4.00 vs $8.00).",
		);
		expect(lines[2]).toContain("Meets the proposed rule");
	});

	it("does not keep it when the success rate drops", () => {
		const lines = compareArms([arm("A", 10, 1), arm("B", 4, 0.5)]);
		expect(lines[2]).toContain("Does not meet the proposed rule");
	});

	it("does not keep it when savings are under 30%", () => {
		const lines = compareArms([arm("A", 10, 1), arm("B", 8, 1)]);
		expect(lines[2]).toContain("Does not meet");
	});

	it("waits for results", () => {
		expect(compareArms([arm("A", null, 0), arm("B", 4, 1)])[0]).toContain(
			"Not enough results",
		);
	});
});

describe("renderM4Report", () => {
	const run: RunSummary = {
		label: "T1/B",
		task: "T1",
		arm: "B",
		sessionIds: ["s"],
		cost: costOf([
			{
				id: "1",
				model: "claude-fable-5-2",
				agentType: "planner",
				timestamp: "",
				input: 100_000,
				output: 0,
				cacheRead: 0,
				cacheWrite5m: 0,
				cacheWrite1h: 0,
			},
			{
				id: "2",
				model: "claude-new-9",
				agentType: "main",
				timestamp: "",
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite5m: 0,
				cacheWrite1h: 0,
			},
		]),
		wallMs: 0,
		activeMs: 300_000,
		humanPrompts: 3,
		subagentCalls: { planner: 1 },
		escalations: 0,
		reviewRounds: 1,
		retries: 0,
		apiErrors: 0,
		workflowStatus: "done",
		result: { label: "T1/B", outcome: "pass", at: "", source: "check" },
	};

	it("shows arms, runs, cost by role and unpriced models", () => {
		const markdown = renderM4Report({
			runs: [run],
			arms: [arm("B", 0.8, 1)],
			unlabeledSessions: 2,
			unlabeledUsd: 1.5,
			generatedAt: new Date("2026-11-17T12:00:00Z"),
		});
		expect(markdown).toContain("Multi-model workflow");
		expect(markdown).toContain(
			"| T1/B | pass (checks) | done | $0.8000 | 5.0 min |",
		);
		expect(markdown).toContain("planner $0.8000");
		expect(markdown).toContain("no price for claude-new-9");
		expect(markdown).toContain("2 recorded session(s) had no run label");
	});

	it("says when nothing is recorded", () => {
		expect(
			renderM4Report({
				runs: [],
				arms: [],
				unlabeledSessions: 0,
				unlabeledUsd: 0,
				generatedAt: new Date(),
			}),
		).toContain("No labeled runs recorded yet.");
	});
});

describe("replaceReportSection", () => {
	it("replaces only the text between the markers", () => {
		const doc = `# Title\n${REPORT_START}\nold\n${REPORT_END}\nfooter\n`;
		expect(replaceReportSection(doc, "new\n")).toBe(
			`# Title\n${REPORT_START}\nnew\n${REPORT_END}\nfooter\n`,
		);
	});

	it("refuses a file without markers", () => {
		expect(() => replaceReportSection("# no markers", "x")).toThrow();
	});
});

describe("encodeProjectDir", () => {
	it("matches Claude Code's project folder names", () => {
		expect(
			encodeProjectDir(
				"D:\\damon-ade\\.claude\\worktrees\\fable-director-model-architecture-d45385",
			),
		).toBe(
			"D--damon-ade--claude-worktrees-fable-director-model-architecture-d45385",
		);
		expect(encodeProjectDir("/Users/pat/my repo")).toBe("-Users-pat-my-repo");
	});
});
