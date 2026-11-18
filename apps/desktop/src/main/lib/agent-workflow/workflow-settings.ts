import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	renderSubagent,
	WORKFLOW_MAIN_MODEL,
	WORKFLOW_SUBAGENTS,
	type WorkflowSubagent,
} from "./agent-workflow";
import { isPlausibleModel, parseFrontmatter } from "./workflow-check";

/**
 * User settings for the multi-model workflow, stored as
 * <ADE home>/workflow-settings.json (like ~/agents/registry.json: plain JSON,
 * editable without a rebuild). Missing or invalid values fall back to the
 * built-in defaults.
 */

export const ROLE_NAMES = [
	"planner",
	"architect",
	"implementer",
	"quick",
	"reviewer",
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const MAX_TURNS_LIMIT = 500;
export const DEFAULT_SESSION_WARN_USD = 10;
export const DEFAULT_DAILY_WARN_USD = 50;

export interface RoleRouting {
	model: string;
	effort: EffortLevel;
	maxTurns: number;
}

export interface WorkflowSettings {
	version: 1;
	/** Main (coordinator) session model, written to .claude/settings.json. */
	mainModel: string;
	roles: Record<RoleName, RoleRouting>;
	budgets: {
		/** Notify when one session's estimated cost passes this (USD); null = off. */
		sessionWarnUsd: number | null;
		/** Notify when today's estimated cost passes this (USD); null = off. */
		dailyWarnUsd: number | null;
	};
	/**
	 * Main model ADE last wrote into agents' settings. Used to tell ADE's value
	 * apart from one the user chose, so a routing change never overwrites the
	 * user's choice. Maintained by ADE.
	 */
	appliedMainModel?: string;
}

function defaultRoles(): Record<RoleName, RoleRouting> {
	const roles = {} as Record<RoleName, RoleRouting>;
	for (const agent of WORKFLOW_SUBAGENTS) {
		roles[agent.name as RoleName] = {
			model: agent.model,
			effort: agent.effort,
			maxTurns: agent.maxTurns,
		};
	}
	return roles;
}

export function defaultWorkflowSettings(): WorkflowSettings {
	return {
		version: 1,
		mainModel: WORKFLOW_MAIN_MODEL,
		roles: defaultRoles(),
		// Defaults are estimates at list price; adjust in Settings > Models.
		budgets: {
			sessionWarnUsd: DEFAULT_SESSION_WARN_USD,
			dailyWarnUsd: DEFAULT_DAILY_WARN_USD,
		},
	};
}

export type ValidationResult =
	| { ok: true; settings: WorkflowSettings }
	| { ok: false; errors: string[] };

function validBudget(value: unknown): value is number | null {
	return (
		value === null ||
		(typeof value === "number" && Number.isFinite(value) && value > 0)
	);
}

/** Validate a complete settings object (as sent by the settings page). */
export function validateWorkflowSettings(input: unknown): ValidationResult {
	const errors: string[] = [];
	if (!input || typeof input !== "object") {
		return { ok: false, errors: ["settings must be an object"] };
	}
	const value = input as Partial<WorkflowSettings>;

	if (
		typeof value.mainModel !== "string" ||
		!isPlausibleModel(value.mainModel)
	) {
		errors.push("main model must be a model alias or a claude-* model ID");
	}
	for (const role of ROLE_NAMES) {
		const routing = value.roles?.[role];
		if (!routing) {
			errors.push(`${role}: missing`);
			continue;
		}
		if (typeof routing.model !== "string" || !isPlausibleModel(routing.model)) {
			errors.push(
				`${role}: model must be a model alias or a claude-* model ID`,
			);
		}
		if (!EFFORT_LEVELS.includes(routing.effort)) {
			errors.push(`${role}: effort must be one of ${EFFORT_LEVELS.join(", ")}`);
		}
		if (
			!Number.isInteger(routing.maxTurns) ||
			routing.maxTurns < 1 ||
			routing.maxTurns > MAX_TURNS_LIMIT
		) {
			errors.push(
				`${role}: max turns must be a whole number from 1 to ${MAX_TURNS_LIMIT}`,
			);
		}
	}
	if (!value.budgets || !validBudget(value.budgets.sessionWarnUsd)) {
		errors.push("session warning must be a positive number or off");
	}
	if (!value.budgets || !validBudget(value.budgets.dailyWarnUsd)) {
		errors.push("daily warning must be a positive number or off");
	}
	if (errors.length) return { ok: false, errors };

	return {
		ok: true,
		settings: {
			version: 1,
			mainModel: (value.mainModel as string).trim(),
			roles: Object.fromEntries(
				ROLE_NAMES.map((role) => {
					const routing = value.roles?.[role] as RoleRouting;
					return [
						role,
						{
							model: routing.model.trim(),
							effort: routing.effort,
							maxTurns: routing.maxTurns,
						},
					];
				}),
			) as Record<RoleName, RoleRouting>,
			budgets: {
				sessionWarnUsd: value.budgets?.sessionWarnUsd ?? null,
				dailyWarnUsd: value.budgets?.dailyWarnUsd ?? null,
			},
			appliedMainModel:
				typeof value.appliedMainModel === "string"
					? value.appliedMainModel
					: undefined,
		},
	};
}

export function workflowSettingsPath(homeDir: string): string {
	return join(homeDir, "workflow-settings.json");
}

/**
 * Load settings, filling anything missing from the defaults. An unreadable or
 * invalid file yields the defaults (the error is logged), never a throw.
 */
export function loadWorkflowSettings(homeDir: string): WorkflowSettings {
	const defaults = defaultWorkflowSettings();
	const path = workflowSettingsPath(homeDir);
	if (!existsSync(path)) return defaults;
	try {
		const stored = JSON.parse(
			readFileSync(path, "utf8"),
		) as Partial<WorkflowSettings>;
		const merged = {
			...defaults,
			...stored,
			roles: Object.fromEntries(
				ROLE_NAMES.map((role) => [
					role,
					{ ...defaults.roles[role], ...(stored.roles?.[role] ?? {}) },
				]),
			),
			budgets: { ...defaults.budgets, ...(stored.budgets ?? {}) },
		};
		const result = validateWorkflowSettings(merged);
		if (result.ok) return result.settings;
		console.warn(
			`[workflow-settings] Ignoring invalid ${path}: ${result.errors.join("; ")}`,
		);
	} catch (error) {
		console.warn(`[workflow-settings] Could not read ${path}:`, error);
	}
	return defaults;
}

export function saveWorkflowSettings(
	homeDir: string,
	settings: WorkflowSettings,
): void {
	mkdirSync(homeDir, { recursive: true });
	const path = workflowSettingsPath(homeDir);
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

/** The workflow subagents with the user's routing applied. */
export function resolveSubagents(
	settings: WorkflowSettings,
): WorkflowSubagent[] {
	return WORKFLOW_SUBAGENTS.map((agent) => ({
		...agent,
		...settings.roles[agent.name as RoleName],
	}));
}

/**
 * True when `content` is exactly what ADE generates for `agent` with some
 * model/effort/turn values, i.e. nobody has edited the prompt, description or
 * tools. Only such files are rewritten when routing changes.
 */
export function isUneditedGeneratedFile(
	content: string,
	agent: WorkflowSubagent,
): boolean {
	const fields = parseFrontmatter(content);
	if (!fields?.model || !fields.effort || !fields.maxTurns) return false;
	const maxTurns = Number(fields.maxTurns);
	if (!Number.isInteger(maxTurns)) return false;
	return (
		content ===
		renderSubagent({
			...agent,
			model: fields.model,
			effort: fields.effort as EffortLevel,
			maxTurns,
		})
	);
}

/**
 * Apply model routing to one agent worktree. Rewrites a role file only when it
 * is an unedited ADE file whose routing differs, and changes the main session
 * model only when it still holds the value ADE last wrote. Anything the user
 * edited is left alone. Returns the changed paths, relative to the worktree.
 */
export function applyRouting(
	worktreePath: string,
	settings: WorkflowSettings,
	previousMainModel: string | undefined,
): string[] {
	const changes: string[] = [];
	for (const agent of resolveSubagents(settings)) {
		const rel = join(".claude", "agents", `${agent.name}.md`);
		const path = join(worktreePath, rel);
		if (!existsSync(path)) continue;
		const content = readFileSync(path, "utf8");
		const desired = renderSubagent(agent);
		if (content !== desired && isUneditedGeneratedFile(content, agent)) {
			writeFileSync(path, desired, "utf8");
			changes.push(rel);
		}
	}

	const settingsPath = join(worktreePath, ".claude", "settings.json");
	if (
		previousMainModel &&
		previousMainModel !== settings.mainModel &&
		existsSync(settingsPath)
	) {
		try {
			const claudeSettings = JSON.parse(
				readFileSync(settingsPath, "utf8"),
			) as Record<string, unknown>;
			if (claudeSettings.model === previousMainModel) {
				claudeSettings.model = settings.mainModel;
				writeFileSync(
					settingsPath,
					`${JSON.stringify(claudeSettings, null, 2)}\n`,
					"utf8",
				);
				changes.push(join(".claude", "settings.json"));
			}
		} catch {
			// Invalid JSON: leave it for the user.
		}
	}
	return changes;
}
