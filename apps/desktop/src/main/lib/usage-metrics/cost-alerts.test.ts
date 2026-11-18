import { describe, expect, it } from "bun:test";
import { type CostAlert, createCostAlertListener } from "./cost-alerts";
import type { SessionMetrics } from "./store";

const NOW = new Date(2026, 10, 17, 15, 0, 0);
const TODAY = new Date(2026, 10, 17, 9, 0, 0).toISOString();
const YESTERDAY = new Date(2026, 10, 16, 9, 0, 0).toISOString();

/** A response costing `usd` on Sonnet 5.5 ($2 per million input tokens). */
function response(id: string, usd: number, timestamp = TODAY) {
	return {
		id,
		model: "claude-sonnet-5-5",
		agentType: "main",
		timestamp,
		input: usd * 500_000,
		output: 0,
		cacheRead: 0,
		cacheWrite5m: 0,
		cacheWrite1h: 0,
	};
}

function session(
	id: string,
	records: SessionMetrics["records"],
): SessionMetrics {
	return {
		schemaVersion: 1,
		sessionId: id,
		transcriptPath: `/t/${id}.jsonl`,
		cwd: "/work/my-agent",
		recordedAt: TODAY,
		firstAt: records[0]?.timestamp,
		lastAt: records[0]?.timestamp,
		activeMs: 0,
		humanPrompts: 1,
		subagentCalls: {},
		apiErrors: 0,
		taskSlugs: [],
		tasks: {},
		records,
	};
}

function setup(
	budgets: { sessionWarnUsd: number | null; dailyWarnUsd: number | null },
	sessions: SessionMetrics[],
) {
	const alerts: CostAlert[] = [];
	const listener = createCostAlertListener({
		getBudgets: () => budgets,
		loadAllSessions: () => sessions,
		notify: (alert) => alerts.push(alert),
		now: () => NOW,
	});
	return { alerts, listener };
}

describe("cost alerts", () => {
	it("warns once when a session passes its threshold", () => {
		const s = session("s1", [response("a", 6), response("b", 5)]);
		const { alerts, listener } = setup(
			{ sessionWarnUsd: 10, dailyWarnUsd: null },
			[s],
		);
		listener(s);
		listener(s);
		expect(alerts).toHaveLength(1);
		expect(alerts[0].kind).toBe("session");
		expect(alerts[0].usd).toBeCloseTo(11, 10);
		expect(alerts[0].body).toContain("in my-agent");
		expect(alerts[0].body).toContain("$11.00");
	});

	it("stays quiet under the threshold", () => {
		const s = session("s1", [response("a", 3)]);
		const { alerts, listener } = setup(
			{ sessionWarnUsd: 10, dailyWarnUsd: 50 },
			[s],
		);
		listener(s);
		expect(alerts).toEqual([]);
	});

	it("warns once a day when today's total across sessions passes", () => {
		const s1 = session("s1", [response("a", 20)]);
		const s2 = session("s2", [
			response("b", 25),
			response("old", 100, YESTERDAY),
		]);
		const { alerts, listener } = setup(
			{ sessionWarnUsd: null, dailyWarnUsd: 40 },
			[s1, s2],
		);
		listener(s2);
		listener(s1);
		expect(alerts).toHaveLength(1);
		expect(alerts[0].kind).toBe("daily");
		// Yesterday's $100 is not counted.
		expect(alerts[0].usd).toBeCloseTo(45, 10);
	});

	it("does not count a resumed session's copied responses twice", () => {
		const original = session("s1", [response("a", 6)]);
		const resumed = {
			...session("s2", [response("a", 6), response("b", 1)]),
			firstAt: new Date(2026, 10, 17, 10).toISOString(),
		};
		const { alerts, listener } = setup(
			{ sessionWarnUsd: 6.5, dailyWarnUsd: 12 },
			[original, resumed],
		);
		listener(resumed);
		// The resumed session owns only "b" ($1); today totals $7.
		expect(alerts).toEqual([]);
	});

	it("does nothing when both warnings are off", () => {
		const s = session("s1", [response("a", 1000)]);
		let loaded = false;
		const listener = createCostAlertListener({
			getBudgets: () => ({ sessionWarnUsd: null, dailyWarnUsd: null }),
			loadAllSessions: () => {
				loaded = true;
				return [s];
			},
			notify: () => {
				throw new Error("should not notify");
			},
		});
		listener(s);
		expect(loaded).toBe(false);
	});
});
