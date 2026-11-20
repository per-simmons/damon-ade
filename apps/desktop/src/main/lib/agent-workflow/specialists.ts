import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EffortLevel } from "./agent-workflow";
import { WORKFLOW_SUBAGENTS } from "./agent-workflow";
import type { ProjectWorkflow } from "./project-workflow";
import { BUILT_IN_TEMPLATES } from "./specialist-templates";
import { isPlausibleModel } from "./workflow-check";
import {
	EFFORT_LEVELS,
	MAX_TURNS_LIMIT,
	ROLE_NAMES,
	type RoleName,
	type WorkflowSettings,
} from "./workflow-settings";

/**
 * Specialists, workflow roles and templates.
 *
 * - A specialist (UI, Backend, Security, anything) belongs to one team, i.e.
 *   one repository. It is configuration, not a process: it has specialty
 *   instructions and settings for the five base roles plus custom roles.
 * - A base role (planner, architect, implementer, reviewer, quick) keeps its
 *   identity; only its model, effort, turn limit and extra instructions
 *   change.
 * - Values resolve in layers: global default (Settings) → template →
 *   specialist → task. Only explicitly set values override; unset inherit.
 * - Templates: built-in ones (specialist-templates.ts) are read live; user
 *   edits never touch them. Personal templates are saved in ADE's home.
 *
 * Stored outside the repository: <project workflow dir>/specialists.json and
 * <ADE home>/workflow-templates.json.
 */

export interface RoleOverride {
	model?: string;
	effort?: EffortLevel;
	maxTurns?: number;
	/** Added to the role's built-in instructions. */
	instructions?: string;
}

export const CUSTOM_ROLE_TRIGGERS = [
	"before-implementation",
	"after-implementation",
	"on-request",
] as const;
export type CustomRoleTrigger = (typeof CUSTOM_ROLE_TRIGGERS)[number];

export interface CustomRole {
	id: string;
	name: string;
	description: string;
	instructions: string;
	/** Read-only roles report a verdict; editing roles change code. */
	access: "read-only" | "edit";
	/**
	 * When the manager runs it: before the first implementation (after a
	 * plan), after implementation and passing checks (before the review),
	 * or only when the user runs it in Manual mode.
	 */
	trigger: CustomRoleTrigger;
	/** Run only when the task mentions one of these (empty = always). */
	keywords: string[];
	/**
	 * Also run when a file the task changed has one of these in its path
	 * (after-implementation roles only), so a sensitive change is reviewed
	 * even when the request never named it.
	 */
	paths?: string[];
	expectedOutput: string;
	model?: string;
	effort?: EffortLevel;
	maxTurns?: number;
	/** The template that added this role, if any (for display only). */
	fromTemplate?: string;
}

export interface SpecialistTemplate {
	id: string;
	builtIn: boolean;
	name: string;
	specialty: string;
	instructions: string;
	/** Words in a task that make Auto pick this specialty. */
	keywords: string[];
	roles: Partial<Record<RoleName, RoleOverride>>;
	customRoles: CustomRole[];
}

export interface Specialist {
	id: string;
	name: string;
	specialty: string;
	/** The template it starts from, if any. */
	templateId?: string;
	/** What it takes from the template. */
	templateUses: { instructions: boolean; models: boolean };
	/** Own instructions; when unset the template's are used. */
	instructions?: string;
	/** Own routing keywords; when unset the template's are used. */
	keywords?: string[];
	roles: Partial<Record<RoleName, RoleOverride>>;
	customRoles: CustomRole[];
	/**
	 * Legacy: template roles the user switched off, from before template
	 * roles were copied into the specialist's own list.
	 */
	disabledTemplateRoles: string[];
	/**
	 * Templates whose roles have been copied into `customRoles`. Once set,
	 * the specialist's own list is the only list: applying the same template
	 * again adds nothing, and a removed role stays removed.
	 */
	appliedTemplates?: string[];
	/** The agent (workspace id) that does this specialist's subtasks. */
	agentWorkspaceId?: string;
	createdAt: string;
	updatedAt: string;
}

/** A task's own role settings (temporary, for this task only). */
export type TaskRoleOverrides = Partial<Record<RoleName, RoleOverride>>;

// ---------------------------------------------------------------- storage

function readJson<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

export function specialistsPath(project: Pick<ProjectWorkflow, "dir">): string {
	return join(project.dir, "specialists.json");
}

export function listSpecialists(
	project: Pick<ProjectWorkflow, "dir">,
): Specialist[] {
	const data = readJson<{ specialists?: Specialist[] }>(
		specialistsPath(project),
		{},
	);
	return Array.isArray(data.specialists) ? data.specialists : [];
}

function saveSpecialists(
	project: Pick<ProjectWorkflow, "dir">,
	specialists: Specialist[],
): void {
	writeJson(specialistsPath(project), { version: 1, specialists });
}

export function templatesPath(homeDir: string): string {
	return join(homeDir, "workflow-templates.json");
}

export function listPersonalTemplates(homeDir: string): SpecialistTemplate[] {
	const data = readJson<{ templates?: SpecialistTemplate[] }>(
		templatesPath(homeDir),
		{},
	);
	return (Array.isArray(data.templates) ? data.templates : []).map((t) => ({
		...t,
		builtIn: false,
	}));
}

export function allTemplates(homeDir: string): SpecialistTemplate[] {
	return [...BUILT_IN_TEMPLATES, ...listPersonalTemplates(homeDir)];
}

export function findTemplate(
	homeDir: string,
	id: string | undefined,
): SpecialistTemplate | undefined {
	if (!id) return undefined;
	return allTemplates(homeDir).find((t) => t.id === id);
}

// ------------------------------------------------------------- validation

const BASE_ROLE_LABELS: Record<RoleName, string> = {
	planner: "Planner",
	architect: "Architect",
	implementer: "Implementer",
	reviewer: "Reviewer",
	quick: "Quick Worker",
};
export function baseRoleLabel(role: RoleName): string {
	return BASE_ROLE_LABELS[role];
}

function validOverride(
	override: RoleOverride | undefined,
	where: string,
): string[] {
	if (!override) return [];
	const errors: string[] = [];
	if (override.model !== undefined && !isPlausibleModel(override.model)) {
		errors.push(`${where}: "${override.model}" is not a Claude Code model`);
	}
	if (
		override.effort !== undefined &&
		!EFFORT_LEVELS.includes(override.effort)
	) {
		errors.push(`${where}: unknown effort "${override.effort}"`);
	}
	if (
		override.maxTurns !== undefined &&
		(!Number.isInteger(override.maxTurns) ||
			override.maxTurns < 1 ||
			override.maxTurns > MAX_TURNS_LIMIT)
	) {
		errors.push(`${where}: maximum turns must be 1–${MAX_TURNS_LIMIT}`);
	}
	return errors;
}

/** Problems that would make a configuration fail or misbehave at launch. */
export function validateConfig(config: {
	roles: Partial<Record<RoleName, RoleOverride>>;
	customRoles: CustomRole[];
}): string[] {
	const errors: string[] = [];
	for (const role of ROLE_NAMES) {
		errors.push(...validOverride(config.roles[role], baseRoleLabel(role)));
	}
	const names = new Set<string>(
		ROLE_NAMES.map((r) => baseRoleLabel(r).toLowerCase()),
	);
	for (const r of ROLE_NAMES) names.add(r);
	const seen = new Set<string>();
	for (const role of config.customRoles) {
		const key = role.name.trim().toLowerCase();
		if (!key) errors.push("A custom role needs a name");
		else if (names.has(key)) {
			errors.push(`"${role.name}" is a built-in role's name; choose another`);
		} else if (seen.has(key)) {
			errors.push(`Two custom roles are called "${role.name}"`);
		}
		seen.add(key);
		if (!role.instructions.trim()) {
			errors.push(`Custom role "${role.name}" needs instructions`);
		}
		if (!CUSTOM_ROLE_TRIGGERS.includes(role.trigger)) {
			errors.push(`Custom role "${role.name}" has an unknown trigger`);
		}
		if (role.access === "edit" && role.trigger === "after-implementation") {
			errors.push(
				`Custom role "${role.name}" edits files, so it cannot run after implementation (it would invalidate the checks it follows). Make it read-only, or run it before implementation or on request.`,
			);
		}
		errors.push(
			...validOverride(
				{ model: role.model, effort: role.effort, maxTurns: role.maxTurns },
				role.name,
			),
		);
	}
	return errors;
}

// ------------------------------------------------------------ resolution

export type ValueSource = "global" | "template" | "specialist" | "task";

export interface ResolvedRole {
	role: RoleName;
	label: string;
	model: string;
	effort: EffortLevel;
	maxTurns: number;
	/** Extra instructions from template, specialist and task, in order. */
	instructions: string[];
	source: {
		model: ValueSource;
		effort: ValueSource;
		maxTurns: ValueSource;
	};
}

function layered<K extends "model" | "effort" | "maxTurns">(
	key: K,
	layers: Array<[ValueSource, RoleOverride | undefined]>,
	base: NonNullable<RoleOverride[K]>,
): { value: NonNullable<RoleOverride[K]>; source: ValueSource } {
	let value = base;
	let source: ValueSource = "global";
	for (const [name, layer] of layers) {
		const v = layer?.[key];
		if (v !== undefined && v !== null && v !== "") {
			value = v as NonNullable<RoleOverride[K]>;
			source = name;
		}
	}
	return { value, source };
}

/** The effective settings of one base role for a specialist and task. */
export function resolveRole(
	role: RoleName,
	settings: Pick<WorkflowSettings, "roles">,
	template: SpecialistTemplate | undefined,
	specialist: Specialist | undefined,
	task: TaskRoleOverrides | undefined,
): ResolvedRole {
	const global = settings.roles[role];
	const useTemplateModels = specialist?.templateUses.models ?? true;
	const useTemplateInstructions = specialist?.templateUses.instructions ?? true;
	const templateLayer = template?.roles[role];
	const layers: Array<[ValueSource, RoleOverride | undefined]> = [
		["template", useTemplateModels ? templateLayer : undefined],
		["specialist", specialist?.roles[role]],
		["task", task?.[role]],
	];
	const model = layered("model", layers, global.model);
	const effort = layered("effort", layers, global.effort);
	const maxTurns = layered("maxTurns", layers, global.maxTurns);
	const instructions = [
		useTemplateInstructions ? templateLayer?.instructions : undefined,
		specialist?.roles[role]?.instructions,
		task?.[role]?.instructions,
	].filter((text): text is string => !!text?.trim());
	return {
		role,
		label: baseRoleLabel(role),
		model: model.value,
		effort: effort.value,
		maxTurns: maxTurns.value,
		instructions,
		source: {
			model: model.source,
			effort: effort.source,
			maxTurns: maxTurns.source,
		},
	};
}

export interface ResolvedSpecialist {
	specialist: Specialist;
	template?: SpecialistTemplate;
	/** Specialty instructions that reach every prompt. */
	instructions: string;
	instructionsSource: "template" | "specialist" | "none";
	keywords: string[];
	roles: Record<RoleName, ResolvedRole>;
	/** Custom roles in force (template roles not switched off + own). */
	customRoles: Array<CustomRole & { from: "template" | "specialist" }>;
	/** Template problems, e.g. a template naming a model ADE cannot run. */
	problems: string[];
}

export function resolveSpecialist(
	specialist: Specialist,
	settings: Pick<WorkflowSettings, "roles">,
	homeDir: string,
	task?: TaskRoleOverrides,
): ResolvedSpecialist {
	const template = findTemplate(homeDir, specialist.templateId);
	const problems: string[] = [];
	if (specialist.templateId && !template) {
		problems.push(
			`Template "${specialist.templateId}" no longer exists; the specialist keeps its own settings.`,
		);
	}
	if (template) problems.push(...validateConfig(template));
	const own = specialist.instructions?.trim();
	const fromTemplate =
		specialist.templateUses.instructions && template?.instructions.trim();
	const roles = Object.fromEntries(
		ROLE_NAMES.map((role) => [
			role,
			resolveRole(role, settings, template, specialist, task),
		]),
	) as Record<RoleName, ResolvedRole>;
	// Older specialists read their template's roles live; newer ones have
	// them copied into their own list (see applyTemplateRoles).
	const legacyTemplateRoles =
		specialist.appliedTemplates === undefined &&
		specialist.templateUses.instructions
			? (template?.customRoles ?? []).filter(
					(r) =>
						!specialist.disabledTemplateRoles.includes(r.id) &&
						!specialist.customRoles.some((own) => own.id === r.id),
				)
			: [];
	const templateRoles = legacyTemplateRoles.map((r) => ({
		...r,
		fromTemplate: template?.id,
		from: "template" as const,
	}));
	return {
		specialist,
		template,
		instructions: own || fromTemplate || "",
		instructionsSource: own ? "specialist" : fromTemplate ? "template" : "none",
		keywords:
			specialist.keywords && specialist.keywords.length > 0
				? specialist.keywords
				: (template?.keywords ?? []),
		roles,
		customRoles: [
			...templateRoles,
			...specialist.customRoles.map((r) => ({
				...r,
				from: "specialist" as const,
			})),
		],
		problems,
	};
}

// --------------------------------------------------------------- routing

function words(text: string): string {
	return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
}

/** Whether a task's text mentions a keyword (word or word prefix). */
export function mentions(text: string, keyword: string): boolean {
	const k = keyword.toLowerCase().trim();
	if (!k) return false;
	return words(text).includes(` ${k.replace(/[^a-z0-9]+/g, " ").trim()}`);
}

export interface SpecialistChoice {
	primary?: ResolvedSpecialist;
	/** Other specialists whose specialty the task also touches. */
	supporting: ResolvedSpecialist[];
	reason: string;
}

/**
 * Auto's specialist choice: deterministic keyword match against each
 * specialist's specialty and keywords, no model call. No match, or no
 * specialists at all, means the default workflow without a specialty.
 */
export function chooseSpecialists(
	description: string,
	specialists: ResolvedSpecialist[],
): SpecialistChoice {
	const scored = specialists
		.map((s) => {
			const hits = [
				...new Set(
					[s.specialist.specialty, s.specialist.name, ...s.keywords].filter(
						(k) => mentions(description, k),
					),
				),
			];
			return { s, hits };
		})
		.filter((x) => x.hits.length > 0)
		.sort((a, b) => b.hits.length - a.hits.length);
	if (scored.length === 0) {
		return {
			supporting: [],
			reason:
				specialists.length === 0
					? "no specialists in this team: default workflow"
					: "no specialist matches the task: default workflow",
		};
	}
	const [first, ...rest] = scored;
	return {
		primary: first.s,
		supporting: rest.slice(0, 2).map((x) => x.s),
		reason: `matches ${first.s.specialist.name} (${first.hits.slice(0, 4).join(", ")})${
			rest.length
				? `; also touches ${rest
						.slice(0, 2)
						.map((x) => x.s.specialist.name)
						.join(", ")}`
				: ""
		}`,
	};
}

/** Custom roles that apply to this task at this trigger. */
export function applicableCustomRoles(
	resolved: ResolvedSpecialist | undefined,
	description: string,
	trigger: CustomRoleTrigger,
	changedFiles: string[] = [],
): ResolvedSpecialist["customRoles"] {
	if (!resolved) return [];
	const files = changedFiles.map((f) => f.replace(/\\/g, "/").toLowerCase());
	return resolved.customRoles.filter(
		(role) =>
			role.trigger === trigger &&
			(role.keywords.length === 0 ||
				role.keywords.some((k) => mentions(description, k)) ||
				(role.paths ?? []).some((fragment) =>
					files.some((f) => f.includes(fragment.toLowerCase())),
				)),
	);
}

// ---------------------------------------------------------------- editing

export interface SpecialistInput {
	name: string;
	specialty: string;
	templateId?: string;
	templateUses?: { instructions: boolean; models: boolean };
	instructions?: string;
	keywords?: string[];
	roles?: Partial<Record<RoleName, RoleOverride>>;
	customRoles?: CustomRole[];
	disabledTemplateRoles?: string[];
	appliedTemplates?: string[];
	/** The agent that does its subtasks; null clears, undefined keeps. */
	agentWorkspaceId?: string | null;
}

/** Drop empty strings so an unset field inherits instead of overriding. */
function cleanOverrides(
	roles: Partial<Record<RoleName, RoleOverride>> | undefined,
): Partial<Record<RoleName, RoleOverride>> {
	const out: Partial<Record<RoleName, RoleOverride>> = {};
	for (const role of ROLE_NAMES) {
		const o = roles?.[role];
		if (!o) continue;
		const clean: RoleOverride = {};
		if (o.model?.trim()) clean.model = o.model.trim();
		if (o.effort) clean.effort = o.effort;
		if (o.maxTurns !== undefined && o.maxTurns !== null)
			clean.maxTurns = o.maxTurns;
		if (o.instructions?.trim()) clean.instructions = o.instructions.trim();
		if (Object.keys(clean).length) out[role] = clean;
	}
	return out;
}

function normalizeCustomRoles(roles: CustomRole[] | undefined): CustomRole[] {
	return (roles ?? []).map((r) => ({
		...r,
		id: r.id || `role-${randomUUID().slice(0, 8)}`,
		name: r.name.trim(),
		description: r.description?.trim() ?? "",
		instructions: r.instructions?.trim() ?? "",
		keywords: (r.keywords ?? []).map((k) => k.trim()).filter(Boolean),
		paths: r.paths?.map((k) => k.trim()).filter(Boolean),
		expectedOutput:
			r.expectedOutput?.trim() ||
			(r.access === "read-only"
				? "Findings, then exactly one line `VERDICT: PASS` or `VERDICT: FAIL`."
				: "A short summary of the changes."),
		model: r.model?.trim() || undefined,
	}));
}

/**
 * Copy a template's roles into a specialist's own role list, matched by the
 * roles' stable ids: a role already in the list (the user's edited copy, or
 * a role of theirs with the same name) is kept as it is, and a template
 * whose roles were applied before adds nothing, so removed roles stay
 * removed and nothing is duplicated.
 */
export function applyTemplateRoles(
	customRoles: CustomRole[],
	template: SpecialistTemplate | undefined,
	applied: string[] | undefined,
	disabled: string[] = [],
): { customRoles: CustomRole[]; appliedTemplates: string[] } {
	const done = applied ?? [];
	if (!template || done.includes(template.id)) {
		return { customRoles, appliedTemplates: done };
	}
	const ids = new Set(customRoles.map((r) => r.id));
	const names = new Set(customRoles.map((r) => r.name.trim().toLowerCase()));
	const added = template.customRoles
		.filter(
			(r) =>
				!ids.has(r.id) &&
				!names.has(r.name.trim().toLowerCase()) &&
				!disabled.includes(r.id),
		)
		.map((r) => ({ ...r, fromTemplate: template.id }));
	return {
		customRoles: [...customRoles, ...added],
		appliedTemplates: [...done, template.id],
	};
}

export function saveSpecialist(
	project: Pick<ProjectWorkflow, "dir">,
	input: SpecialistInput & { id?: string },
	now: Date = new Date(),
	homeDir?: string,
): Specialist {
	const name = input.name.trim();
	if (!name) throw new Error("Give the specialist a name");
	const specialty = input.specialty.trim() || name;
	const roles = cleanOverrides(input.roles);
	const all = listSpecialists(project);
	const existingRecord = input.id
		? all.find((s) => s.id === input.id)
		: undefined;
	const templateUses = input.templateUses ?? {
		instructions: true,
		models: true,
	};
	// Applying a template's role settings adds its roles to the one Roles list.
	const applied =
		input.templateId && templateUses.models && homeDir
			? applyTemplateRoles(
					normalizeCustomRoles(input.customRoles),
					findTemplate(homeDir, input.templateId),
					input.appliedTemplates ?? existingRecord?.appliedTemplates,
					input.disabledTemplateRoles ?? existingRecord?.disabledTemplateRoles,
				)
			: {
					customRoles: normalizeCustomRoles(input.customRoles),
					appliedTemplates:
						input.appliedTemplates ?? existingRecord?.appliedTemplates ?? [],
				};
	const customRoles = applied.customRoles;
	const errors = validateConfig({ roles, customRoles });
	if (errors.length) throw new Error(errors.join("; "));
	if (
		all.some(
			(s) => s.id !== input.id && s.name.toLowerCase() === name.toLowerCase(),
		)
	) {
		throw new Error(`This team already has a specialist called "${name}"`);
	}
	const existing = input.id ? all.find((s) => s.id === input.id) : undefined;
	if (input.id && !existing) throw new Error("Specialist not found");
	const specialist: Specialist = {
		id: existing?.id ?? `spec-${randomUUID().slice(0, 8)}`,
		name,
		specialty,
		templateId: input.templateId || undefined,
		templateUses,
		instructions: input.instructions?.trim() || undefined,
		keywords: input.keywords?.map((k) => k.trim()).filter(Boolean),
		roles,
		customRoles,
		disabledTemplateRoles: [],
		appliedTemplates: applied.appliedTemplates,
		agentWorkspaceId:
			input.agentWorkspaceId === undefined
				? existing?.agentWorkspaceId
				: input.agentWorkspaceId || undefined,
		createdAt: existing?.createdAt ?? now.toISOString(),
		updatedAt: now.toISOString(),
	};
	saveSpecialists(project, [
		...all.filter((s) => s.id !== specialist.id),
		specialist,
	]);
	return specialist;
}

export function removeSpecialist(
	project: Pick<ProjectWorkflow, "dir">,
	id: string,
): void {
	const all = listSpecialists(project);
	if (!all.some((s) => s.id === id)) throw new Error("Specialist not found");
	saveSpecialists(
		project,
		all.filter((s) => s.id !== id),
	);
}

/** Save a specialist's effective setup as a personal template. */
export function savePersonalTemplate(
	homeDir: string,
	input: Omit<SpecialistTemplate, "builtIn" | "id"> & { id?: string },
): SpecialistTemplate {
	const name = input.name.trim();
	if (!name) throw new Error("Give the template a name");
	const roles = cleanOverrides(input.roles);
	const customRoles = normalizeCustomRoles(input.customRoles);
	const errors = validateConfig({ roles, customRoles });
	if (errors.length) throw new Error(errors.join("; "));
	if (BUILT_IN_TEMPLATES.some((t) => t.id === input.id)) {
		throw new Error("Built-in templates cannot be changed; save a copy");
	}
	const personal = listPersonalTemplates(homeDir);
	const template: SpecialistTemplate = {
		id: input.id ?? `personal-${randomUUID().slice(0, 8)}`,
		builtIn: false,
		name,
		specialty: input.specialty.trim() || name,
		instructions: input.instructions.trim(),
		keywords: input.keywords.map((k) => k.trim()).filter(Boolean),
		roles,
		customRoles,
	};
	writeJson(templatesPath(homeDir), {
		version: 1,
		templates: [...personal.filter((t) => t.id !== template.id), template],
	});
	return template;
}

export function removePersonalTemplate(homeDir: string, id: string): void {
	const personal = listPersonalTemplates(homeDir);
	if (!personal.some((t) => t.id === id)) {
		throw new Error("Only your own templates can be removed");
	}
	writeJson(templatesPath(homeDir), {
		version: 1,
		templates: personal.filter((t) => t.id !== id),
	});
}

/** The built-in prompt body of a base role (for display). */
export function baseRolePrompt(role: RoleName): string {
	return WORKFLOW_SUBAGENTS.find((a) => a.name === role)?.prompt ?? "";
}
