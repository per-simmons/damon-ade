import { TRPCError } from "@trpc/server";
import {
	allTemplates,
	baseRoleLabel,
	CUSTOM_ROLE_TRIGGERS,
	EFFORT_LEVELS,
	listSpecialists,
	loadWorkflowSettings,
	MAX_TURNS_LIMIT,
	PINNED_MODEL_IDS,
	ROLE_NAMES,
	removePersonalTemplate,
	removeSpecialist,
	resolveSpecialist,
	savePersonalTemplate,
	saveSpecialist,
} from "main/lib/agent-workflow";
import type { TeamAgent } from "main/lib/agent-workflow/tasks";
import { MODEL_PRICES } from "main/lib/usage-metrics/pricing";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import {
	defaultWorkflowRouterDeps,
	type WorkspaceContext,
} from "../workflow/workflow";

/**
 * Specialists of a team (one repository), their roles and templates.
 * Everything is stored by ADE outside the repository; the Tasks runner
 * reads the same files, so what is saved here is what runs.
 */

export interface SpecialistsRouterDeps {
	resolveWorkspace: (workspaceId: string) => WorkspaceContext;
	homeDir: () => string;
	/** The agents of the workspace's team. */
	listAgents?: (workspaceId: string) => TeamAgent[];
}

const roleOverride = z.object({
	model: z.string().max(100).optional(),
	effort: z.enum(EFFORT_LEVELS as [string, ...string[]]).optional(),
	maxTurns: z.number().int().min(1).max(MAX_TURNS_LIMIT).optional(),
	instructions: z.string().max(20_000).optional(),
});
const roleOverrides = z.object(
	Object.fromEntries(
		ROLE_NAMES.map((r) => [r, roleOverride.optional()]),
	) as Record<(typeof ROLE_NAMES)[number], z.ZodOptional<typeof roleOverride>>,
);
const customRole = z.object({
	id: z.string().max(100).default(""),
	name: z.string().min(1).max(80),
	description: z.string().max(2000).default(""),
	instructions: z.string().max(20_000),
	access: z.enum(["read-only", "edit"]),
	trigger: z.enum(CUSTOM_ROLE_TRIGGERS),
	keywords: z.array(z.string().max(60)).max(50).default([]),
	expectedOutput: z.string().max(4000).default(""),
	model: z.string().max(100).optional(),
	effort: z.enum(EFFORT_LEVELS as [string, ...string[]]).optional(),
	maxTurns: z.number().int().min(1).max(MAX_TURNS_LIMIT).optional(),
	fromTemplate: z.string().max(100).optional(),
});
const specialistInput = z.object({
	id: z.string().optional(),
	name: z.string().min(1).max(80),
	specialty: z.string().max(80).default(""),
	templateId: z.string().max(100).optional(),
	templateUses: z
		.object({ instructions: z.boolean(), models: z.boolean() })
		.default({ instructions: true, models: true }),
	instructions: z.string().max(20_000).optional(),
	keywords: z.array(z.string().max(60)).max(80).optional(),
	roles: roleOverrides.default({}),
	customRoles: z.array(customRole).max(30).default([]),
	disabledTemplateRoles: z.array(z.string()).default([]),
	appliedTemplates: z.array(z.string()).optional(),
	/** The agent that does this specialist's subtasks; null clears it. */
	agentWorkspaceId: z.string().max(100).nullable().optional(),
});

function guarded<T>(fn: () => T): T {
	try {
		return fn();
	} catch (error) {
		if (error instanceof TRPCError) throw error;
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Models managed task runs can use. Managed runs execute through Claude Code
 * only; Codex is available in terminals but not for managed task stages, so
 * it is not offered here. Exact IDs are listed for the aliases ADE pins
 * (models.ts); other Claude model IDs can be typed in and run unpriced.
 */
export function modelCatalog() {
	const labels: Record<string, string> = {
		fable: "Fable 5.2",
		opus: "Opus 5.5",
		sonnet: "Sonnet 5.5",
		haiku: "Haiku 5.5",
	};
	return {
		runtime: "Claude Code",
		note: "Managed task stages run through Claude Code. Codex runs only in terminals, so it cannot be chosen for a role here.",
		models: Object.entries(PINNED_MODEL_IDS).map(([alias, id]) => ({
			value: alias,
			label: labels[alias] ?? alias,
			exactId: id,
			priced: id in MODEL_PRICES,
		})),
	};
}

export const createSpecialistsRouter = (
	deps: SpecialistsRouterDeps = {
		resolveWorkspace: defaultWorkflowRouterDeps.resolveWorkspace,
		homeDir: defaultWorkflowRouterDeps.homeDir,
		listAgents: defaultWorkflowRouterDeps.listAgents,
	},
) =>
	router({
		/** The team's specialists with their effective role settings. */
		list: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(({ input }) =>
				guarded(() => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					const home = deps.homeDir();
					const settings = loadWorkflowSettings(home);
					return {
						team: { name: ctx.project.name, root: ctx.project.root },
						global: Object.fromEntries(
							ROLE_NAMES.map((role) => [role, settings.roles[role]]),
						),
						baseRoles: ROLE_NAMES.map((role) => ({
							role,
							label: baseRoleLabel(role),
						})),
						specialists: listSpecialists(ctx.project).map((s) => {
							const resolved = resolveSpecialist(s, settings, home);
							return {
								...s,
								effective: {
									instructions: resolved.instructions,
									instructionsSource: resolved.instructionsSource,
									keywords: resolved.keywords,
									roles: resolved.roles,
									customRoles: resolved.customRoles,
									problems: resolved.problems,
									templateName: resolved.template?.name ?? null,
								},
							};
						}),
					};
				}),
			),

		templates: publicProcedure.query(() =>
			allTemplates(deps.homeDir()).map((t) => ({
				...t,
				customRoleCount: t.customRoles.length,
			})),
		),

		models: publicProcedure.query(() => modelCatalog()),

		/** The team's agents, each with the specialties it does. */
		agents: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(({ input }) =>
				guarded(() => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					const specialists = listSpecialists(ctx.project);
					return (deps.listAgents?.(input.workspaceId) ?? []).map((agent) => ({
						workspaceId: agent.workspaceId,
						name: agent.name,
						current: agent.workspaceId === input.workspaceId,
						specialties: specialists
							.filter((s) => s.agentWorkspaceId === agent.workspaceId)
							.map((s) => ({ id: s.id, name: s.name, specialty: s.specialty })),
					}));
				}),
			),

		save: publicProcedure
			.input(z.object({ workspaceId: z.string(), specialist: specialistInput }))
			.mutation(({ input }) =>
				guarded(() => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					return saveSpecialist(
						ctx.project,
						input.specialist as Parameters<typeof saveSpecialist>[1],
						new Date(),
						deps.homeDir(),
					);
				}),
			),

		remove: publicProcedure
			.input(z.object({ workspaceId: z.string(), id: z.string() }))
			.mutation(({ input }) =>
				guarded(() => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					removeSpecialist(ctx.project, input.id);
					return { removed: input.id };
				}),
			),

		/** Save a specialist's setup as a personal template (or update one). */
		saveTemplate: publicProcedure
			.input(
				z.object({
					id: z.string().optional(),
					name: z.string().min(1).max(80),
					specialty: z.string().max(80).default(""),
					instructions: z.string().max(20_000).default(""),
					keywords: z.array(z.string().max(60)).max(80).default([]),
					roles: roleOverrides.default({}),
					customRoles: z.array(customRole).max(30).default([]),
				}),
			)
			.mutation(({ input }) =>
				guarded(() =>
					savePersonalTemplate(
						deps.homeDir(),
						input as Parameters<typeof savePersonalTemplate>[1],
					),
				),
			),

		removeTemplate: publicProcedure
			.input(z.object({ id: z.string() }))
			.mutation(({ input }) =>
				guarded(() => {
					removePersonalTemplate(deps.homeDir(), input.id);
					return { removed: input.id };
				}),
			),
	});
