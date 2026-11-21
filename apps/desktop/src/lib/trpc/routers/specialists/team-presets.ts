import { workspaces } from "@superset/local-db";
import { eq } from "drizzle-orm";
import {
	allTemplates,
	listSpecialists,
	saveSpecialist,
} from "main/lib/agent-workflow";
import {
	findTeamPreset,
	planPreset,
	TEAM_PRESETS,
} from "main/lib/agent-workflow/team-presets";
import { localDb } from "main/lib/local-db";
import { z } from "zod";
import { publicProcedure } from "../..";
import type { WorkspaceContext } from "../workflow/workflow";
import { createAgentWorkspace } from "../workspaces/procedures/create-agent";
import { getBranchWorkspace } from "../workspaces/utils/db-helpers";

interface PresetDeps {
	resolveWorkspace: (workspaceId: string) => WorkspaceContext;
	homeDir: () => string;
}

/**
 * Default setup: a team preset adds a group of agents, each with its
 * specialty already assigned ("<Template> Agent" owning the template's
 * specialist). Offered when a team is created and from the team's menu.
 */
export function teamPresetProcedures(deps: PresetDeps) {
	return {
		/** The presets, with the templates (and agent names) each adds. */
		presets: publicProcedure.query(() => {
			const templates = allTemplates(deps.homeDir());
			return TEAM_PRESETS.map((preset) => ({
				...preset,
				agents: preset.templates
					.map((id) => templates.find((t) => t.id === id))
					.filter((t): t is NonNullable<typeof t> => !!t)
					.map((t) => ({ templateId: t.id, name: `${t.name} Agent` })),
			}));
		}),

		/** Add the preset's agents and specialists that the team lacks. */
		applyPreset: publicProcedure
			.input(z.object({ projectId: z.string(), presetId: z.string() }))
			.mutation(({ input }) => {
				const preset = findTeamPreset(input.presetId);
				if (!preset) throw new Error("Unknown team preset");
				const main = getBranchWorkspace(input.projectId);
				if (!main) {
					throw new Error(
						"This team has no repository yet. Choose its repository first.",
					);
				}
				const ctx = deps.resolveWorkspace(main.id);
				const home = deps.homeDir();
				const templates = allTemplates(home);
				const agents = localDb
					.select()
					.from(workspaces)
					.where(eq(workspaces.projectId, input.projectId))
					.all()
					.filter((w) => !w.deletingAt)
					.map((w) => ({ workspaceId: w.id, name: w.name }));
				const steps = planPreset(
					preset,
					templates,
					agents,
					listSpecialists(ctx.project),
				);

				const agentsAdded: string[] = [];
				let specialistsAdded = 0;
				for (const step of steps) {
					const template = templates.find((t) => t.id === step.templateId);
					let agentId = step.agentWorkspaceId;
					if (!agentId) {
						agentId = createAgentWorkspace({
							projectId: input.projectId,
							name: step.agentName,
							role: template?.specialty,
							runtime: "claude",
						}).workspace.id;
						agentsAdded.push(step.agentName);
					}
					if (step.specialist === "create") {
						saveSpecialist(
							ctx.project,
							{
								name: step.templateName,
								specialty: template?.specialty || step.templateName,
								templateId: step.templateId,
								templateUses: { instructions: true, models: true },
								agentWorkspaceId: agentId,
							},
							new Date(),
							home,
						);
						specialistsAdded++;
					} else if (step.specialist === "assign") {
						const existing = listSpecialists(ctx.project).find(
							(s) => s.id === step.specialistId,
						);
						if (existing) {
							saveSpecialist(
								ctx.project,
								{ ...existing, agentWorkspaceId: agentId },
								new Date(),
								home,
							);
						}
					}
				}
				return {
					preset: preset.name,
					agentsAdded,
					specialistsAdded,
					alreadyThere: steps.length - agentsAdded.length,
				};
			}),
	};
}
