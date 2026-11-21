import type { TaskRoute } from "shared/utils/task-routing";
import type { EffortLevel } from "./agent-workflow";
import type { TaskRecord } from "./tasks";
import type { RoleName } from "./workflow-settings";

/**
 * AI pathway choice ("Chosen by AI"). Before an Auto task starts, one short,
 * read-only run (Sonnet, low effort, a few turns) reads the request and the
 * project and decides the pathway: the route (quick change, direct
 * implementation, plan first, or exceptional) and which model each role
 * should use for this task. ADE then runs that pathway with its own
 * controller, limits and budget; escalation to the Architect stays
 * automatic when implementation gets stuck. If the choice cannot be read,
 * ADE falls back to its rule-based route and says so.
 */

export const TRIAGE_ROUTING = {
	model: "sonnet",
	effort: "low" as EffortLevel,
	maxTurns: 8,
};

const ROUTES: TaskRoute[] = ["quick", "implement", "plan", "exceptional"];
const MODELS = ["haiku", "sonnet", "opus", "fable"] as const;
type Model = (typeof MODELS)[number];
const ROLE_KEYS: Record<string, RoleName> = {
	planner: "planner",
	architect: "architect",
	implementer: "implementer",
	reviewer: "reviewer",
	quick: "quick",
	"quick worker": "quick",
};

export interface TriageDecision {
	/** Whether the AI's choice was applied (false: rule-based fallback). */
	applied: boolean;
	route: TaskRoute;
	/** Models the AI chose per role, for this task only. */
	models: Partial<Record<RoleName, Model>>;
	specialist?: string;
	reason: string;
}

/** Read the decision from the triage run's reply (a JSON block). */
export function parseTriage(
	text: string | undefined,
): Omit<TriageDecision, "applied"> | undefined {
	if (!text) return undefined;
	const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(
		(m) => m[1],
	);
	const candidates = [
		...blocks,
		text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
	];
	for (const raw of candidates.reverse()) {
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(raw.trim());
		} catch {
			continue;
		}
		const route = String(data.route ?? "").toLowerCase() as TaskRoute;
		if (!ROUTES.includes(route)) continue;
		const models: Partial<Record<RoleName, Model>> = {};
		const given = (data.models ?? {}) as Record<string, unknown>;
		for (const [key, value] of Object.entries(given)) {
			const role = ROLE_KEYS[key.toLowerCase()];
			const model = String(value ?? "").toLowerCase() as Model;
			if (role && MODELS.includes(model)) models[role] = model;
		}
		const specialist =
			typeof data.specialist === "string" &&
			data.specialist.trim() &&
			data.specialist.toLowerCase() !== "none"
				? data.specialist.trim()
				: undefined;
		const reason =
			typeof data.reason === "string" ? data.reason.trim().slice(0, 500) : "";
		return { route, models, specialist, reason: reason || "no reason given" };
	}
	return undefined;
}

/**
 * Apply a decision to the task: its route, and the chosen models as this
 * task's own role settings. A model the user set for this task is kept.
 */
export function applyTriage(
	task: TaskRecord,
	decision: Omit<TriageDecision, "applied">,
	specialistId: string | undefined,
): TaskRecord {
	const overrides = { ...(task.roleOverrides ?? {}) };
	for (const [role, model] of Object.entries(decision.models) as Array<
		[RoleName, Model]
	>) {
		if (!overrides[role]?.model)
			overrides[role] = { ...overrides[role], model };
	}
	return {
		...task,
		route: decision.route,
		routeReasons: [`chosen by AI: ${decision.reason}`],
		roleOverrides: overrides,
		...(specialistId
			? {
					specialistId,
					supportingSpecialistIds: [],
					specialistReason: "chosen by AI",
				}
			: {}),
		triage: { ...decision, applied: true },
	};
}
