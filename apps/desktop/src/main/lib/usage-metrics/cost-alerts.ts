import { basename } from "node:path";
import { costOf, dedupeAcrossSessions } from "./aggregate";
import type { SessionMetrics } from "./store";

/**
 * Spending warnings, checked each time a session is recorded:
 * - a session's estimated cost passes the session threshold, and
 * - today's estimated cost across all sessions passes the daily threshold.
 *
 * Interactive Claude Code sessions cannot be capped from outside, so these
 * warn rather than stop. Each threshold warns once (per session, or per day).
 */

export interface CostBudgets {
	sessionWarnUsd: number | null;
	dailyWarnUsd: number | null;
}

export interface CostAlert {
	kind: "session" | "daily";
	title: string;
	body: string;
	usd: number;
	thresholdUsd: number;
}

function localDay(date: Date): string {
	return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

export function createCostAlertListener(deps: {
	getBudgets: () => CostBudgets;
	loadAllSessions: () => SessionMetrics[];
	notify: (alert: CostAlert) => void;
	now?: () => Date;
}): (metrics: SessionMetrics) => void {
	const warnedSessions = new Set<string>();
	let warnedDay: string | undefined;

	return (metrics) => {
		const budgets = deps.getBudgets();
		if (budgets.sessionWarnUsd === null && budgets.dailyWarnUsd === null)
			return;

		const sessions = deps.loadAllSessions();
		// Count each response once, even across resumed sessions.
		const owned = dedupeAcrossSessions(sessions);

		if (
			budgets.sessionWarnUsd !== null &&
			!warnedSessions.has(metrics.sessionId)
		) {
			const usd = costOf(owned.get(metrics.sessionId) ?? metrics.records).usd;
			if (usd >= budgets.sessionWarnUsd) {
				warnedSessions.add(metrics.sessionId);
				const where = metrics.cwd ? ` in ${basename(metrics.cwd)}` : "";
				deps.notify({
					kind: "session",
					title: "Claude session cost",
					body: `A session${where} is at about ${money(usd)} (list price), past your ${money(budgets.sessionWarnUsd)} warning.`,
					usd,
					thresholdUsd: budgets.sessionWarnUsd,
				});
			}
		}

		const today = localDay((deps.now ?? (() => new Date()))());
		if (budgets.dailyWarnUsd !== null && warnedDay !== today) {
			const todays = [...owned.values()].flat().filter((record) => {
				const at = new Date(record.timestamp);
				return !Number.isNaN(at.getTime()) && localDay(at) === today;
			});
			const usd = costOf(todays).usd;
			if (usd >= budgets.dailyWarnUsd) {
				warnedDay = today;
				deps.notify({
					kind: "daily",
					title: "Claude cost today",
					body: `Today's Claude Code usage is about ${money(usd)} (list price), past your ${money(budgets.dailyWarnUsd)} daily warning.`,
					usd,
					thresholdUsd: budgets.dailyWarnUsd,
				});
			}
		}
	};
}
