import type { TaskRoute } from "shared/utils/task-routing";
import type { EffortLevel } from "./agent-workflow";
import type { RoleName } from "./workflow-settings";

/**
 * Team requests: one request split across the team's specialists.
 *
 * A Coordinator run (Sonnet, medium effort, read-only) reads the request and
 * the code it touches and splits it into a few self-contained subtasks, in
 * dependency order, each owned by one specialist and given a route and
 * models. ADE turns them into ordinary tasks and runs them one after
 * another (one writer at a time), each with its own checks, review and
 * limits. The request is done when every subtask is.
 */

export const SPLIT_ROUTING = {
	model: "sonnet",
	effort: "medium" as EffortLevel,
	maxTurns: 10,
};

export const MAX_SUBTASKS = 6;

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

export interface Subtask {
	title: string;
	description: string;
	/** A specialist's name, or undefined for the default workflow. */
	specialist?: string;
	route: TaskRoute;
	models: Partial<Record<RoleName, Model>>;
	/** Earlier subtasks (indexes in this plan) whose work this one needs. */
	dependsOn: number[];
}

export interface SplitPlan {
	subtasks: Subtask[];
	reason: string;
}

function text(value: unknown, max: number): string {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Read the Coordinator's plan from its reply (a JSON block). */
export function parseSplit(reply: string | undefined): SplitPlan | undefined {
	if (!reply) return undefined;
	const blocks = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(
		(m) => m[1],
	);
	const candidates = [
		...blocks,
		reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1),
	];
	for (const raw of candidates.reverse()) {
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(raw.trim());
		} catch {
			continue;
		}
		if (!Array.isArray(data.subtasks)) continue;
		const subtasks: Subtask[] = [];
		// The Coordinator numbers subtasks from 1 in its own list; skipped
		// entries must not shift what the others depend on.
		const indexOf = new Map<number, number>();
		const items = data.subtasks.slice(0, MAX_SUBTASKS);
		for (const [position, item] of items.entries()) {
			if (!item || typeof item !== "object") continue;
			const entry = item as Record<string, unknown>;
			const title = text(entry.title, 120);
			const description = text(entry.description, 4000);
			if (!title || !description) continue;
			const route = String(
				entry.route ?? "implement",
			).toLowerCase() as TaskRoute;
			const models: Partial<Record<RoleName, Model>> = {};
			for (const [key, value] of Object.entries(
				(entry.models ?? {}) as Record<string, unknown>,
			)) {
				const role = ROLE_KEYS[key.toLowerCase()];
				const model = String(value ?? "").toLowerCase() as Model;
				if (role && MODELS.includes(model)) models[role] = model;
			}
			const specialist = text(entry.specialist, 80);
			// Without dependsOn a subtask builds on the one before it.
			const dependsOn = Array.isArray(entry.dependsOn)
				? [
						...new Set(
							entry.dependsOn
								.map((n) => indexOf.get(Number(n) - 1))
								.filter((i): i is number => i !== undefined),
						),
					]
				: subtasks.length > 0
					? [subtasks.length - 1]
					: [];
			indexOf.set(position, subtasks.length);
			subtasks.push({
				dependsOn,
				title,
				description,
				specialist:
					specialist && specialist.toLowerCase() !== "none"
						? specialist
						: undefined,
				route: ROUTES.includes(route) ? route : "implement",
				models,
			});
		}
		if (subtasks.length === 0) continue;
		return { subtasks, reason: text(data.reason, 500) || "no reason given" };
	}
	return undefined;
}
