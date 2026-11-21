import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	type EffortLevel,
	WORKFLOW_SUBAGENTS,
	type WorkflowSubagent,
} from "./agent-workflow";
import { isPlausibleModel } from "./workflow-check";

/**
 * App-level settings for the multi-model workflow, stored as
 * <ADE home>/workflow-settings.json (plain JSON, editable without a rebuild).
 * They apply to every project: each Claude session gets the roles from these
 * settings at launch. Missing or invalid values fall back to the defaults.
 */

export const ROLE_NAMES = [
	"planner",
	"architect",
	"implementer",
	"quick",
	"reviewer",
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const EFFORT_LEVELS: readonly EffortLevel[] = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
export type { EffortLevel };

export const MAX_TURNS_LIMIT = 500;
export const DEFAULT_SESSION_WARN_USD = 10;
export const DEFAULT_DAILY_WARN_USD = 50;
export const DEFAULT_HEADLESS_MAX_BUDGET_USD = 5;
export const DEFAULT_HEADLESS_MAX_TURNS = 50;
export const DEFAULT_TASK_BUDGET_USD = 10;

/**
 * What managed task runs may do without asking (print-mode runs cannot ask):
 * - "edits": edit files; shell commands are denied.
 * - "edits-and-checks": also run the project's approved check commands.
 * - "bypass": everything (--permission-mode bypassPermissions). Only when the
 *   user chooses it.
 */
export const PERMISSION_PROFILES = [
	"edits",
	"edits-and-checks",
	"bypass",
] as const;
export type PermissionProfile = (typeof PERMISSION_PROFILES)[number];

export interface ExecutionSettings {
	permissions: PermissionProfile;
	/** Default spending cap per task, across all its runs (USD, list price). */
	taskBudgetUsd: number;
	/** Fix rounds after failed checks or a failed review. */
	maxCorrections: number;
	maxReviewRounds: number;
	/** Escalations to the architect per task. */
	maxEscalations: number;
	/** Pin aliases to exact model IDs (see models.ts). */
	pinModels: boolean;
	/** On an unavailable model, retry once on the next cheaper tier. */
	cheaperFallback: boolean;
}

export interface RoleRouting {
	model: string;
	effort: EffortLevel;
	maxTurns: number;
}

export interface WorkflowSettings {
	version: 1;
	roles: Record<RoleName, RoleRouting>;
	budgets: {
		/** Notify when one session's estimated cost passes this (USD); null = off. */
		sessionWarnUsd: number | null;
		/** Notify when today's estimated cost passes this (USD); null = off. */
		dailyWarnUsd: number | null;
		/**
		 * Hard cap for a headless /agent/invoke run (`--max-budget-usd`). A
		 * request may ask for less, never more.
		 */
		headlessMaxBudgetUsd: number;
		/** Turn cap for a headless run (`--max-turns`). */
		headlessMaxTurns: number;
	};
	execution: ExecutionSettings;
}

export function defaultExecutionSettings(): ExecutionSettings {
	return {
		permissions: "edits-and-checks",
		taskBudgetUsd: DEFAULT_TASK_BUDGET_USD,
		maxCorrections: 2,
		maxReviewRounds: 3,
		maxEscalations: 2,
		pinModels: true,
		cheaperFallback: true,
	};
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
		roles: defaultRoles(),
		// Defaults are estimates at list price; adjust in Settings > Models & Cost.
		budgets: {
			sessionWarnUsd: DEFAULT_SESSION_WARN_USD,
			dailyWarnUsd: DEFAULT_DAILY_WARN_USD,
			headlessMaxBudgetUsd: DEFAULT_HEADLESS_MAX_BUDGET_USD,
			headlessMaxTurns: DEFAULT_HEADLESS_MAX_TURNS,
		},
		execution: defaultExecutionSettings(),
	};
}

export type ValidationResult =
	| { ok: true; settings: WorkflowSettings }
	| { ok: false; errors: string[] };

function validWarning(value: unknown): value is number | null {
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
	const budgets = value.budgets;
	if (!budgets || !validWarning(budgets.sessionWarnUsd)) {
		errors.push("session warning must be a positive number or off");
	}
	if (!budgets || !validWarning(budgets.dailyWarnUsd)) {
		errors.push("daily warning must be a positive number or off");
	}
	const headlessBudget = budgets?.headlessMaxBudgetUsd;
	if (
		typeof headlessBudget !== "number" ||
		!Number.isFinite(headlessBudget) ||
		headlessBudget <= 0
	) {
		errors.push("headless budget must be a positive number");
	}
	const headlessTurns = budgets?.headlessMaxTurns;
	if (
		typeof headlessTurns !== "number" ||
		!Number.isInteger(headlessTurns) ||
		headlessTurns < 1 ||
		headlessTurns > MAX_TURNS_LIMIT
	) {
		errors.push(
			`headless turn limit must be a whole number from 1 to ${MAX_TURNS_LIMIT}`,
		);
	}
	const execution = value.execution;
	if (!execution || !PERMISSION_PROFILES.includes(execution.permissions)) {
		errors.push(`permissions must be one of ${PERMISSION_PROFILES.join(", ")}`);
	}
	if (
		!execution ||
		typeof execution.taskBudgetUsd !== "number" ||
		!Number.isFinite(execution.taskBudgetUsd) ||
		execution.taskBudgetUsd <= 0
	) {
		errors.push("task budget must be a positive number");
	}
	for (const key of [
		"maxCorrections",
		"maxReviewRounds",
		"maxEscalations",
	] as const) {
		const limit = execution?.[key];
		if (
			typeof limit !== "number" ||
			!Number.isInteger(limit) ||
			limit < 0 ||
			limit > 20
		) {
			errors.push(`${key} must be a whole number from 0 to 20`);
		}
	}
	for (const key of ["pinModels", "cheaperFallback"] as const) {
		if (typeof execution?.[key] !== "boolean")
			errors.push(`${key} must be true or false`);
	}
	if (errors.length) return { ok: false, errors };

	return {
		ok: true,
		settings: {
			version: 1,
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
				sessionWarnUsd: budgets?.sessionWarnUsd ?? null,
				dailyWarnUsd: budgets?.dailyWarnUsd ?? null,
				headlessMaxBudgetUsd: headlessBudget as number,
				headlessMaxTurns: headlessTurns as number,
			},
			execution: {
				permissions: (execution as ExecutionSettings).permissions,
				taskBudgetUsd: (execution as ExecutionSettings).taskBudgetUsd,
				maxCorrections: (execution as ExecutionSettings).maxCorrections,
				maxReviewRounds: (execution as ExecutionSettings).maxReviewRounds,
				maxEscalations: (execution as ExecutionSettings).maxEscalations,
				pinModels: (execution as ExecutionSettings).pinModels,
				cheaperFallback: (execution as ExecutionSettings).cheaperFallback,
			},
		},
	};
}

export function workflowSettingsPath(homeDir: string): string {
	return join(homeDir, "workflow-settings.json");
}

/**
 * Load settings, filling anything missing from the defaults. An unreadable or
 * invalid file yields the defaults (the error is logged), never a throw.
 * Keys from older versions (mainModel, appliedMainModel) are ignored.
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
			version: 1,
			roles: Object.fromEntries(
				ROLE_NAMES.map((role) => [
					role,
					{ ...defaults.roles[role], ...(stored.roles?.[role] ?? {}) },
				]),
			),
			budgets: { ...defaults.budgets, ...(stored.budgets ?? {}) },
			execution: { ...defaults.execution, ...(stored.execution ?? {}) },
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

/** The workflow roles with the user's routing applied. */
export function resolveSubagents(
	settings: WorkflowSettings,
): WorkflowSubagent[] {
	return WORKFLOW_SUBAGENTS.map((agent) => ({
		...agent,
		...settings.roles[agent.name as RoleName],
	}));
}
