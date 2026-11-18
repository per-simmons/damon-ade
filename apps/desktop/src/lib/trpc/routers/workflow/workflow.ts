import { TRPCError } from "@trpc/server";
import { syncAgentWorkflowFiles } from "main/lib/agent-workflow/agent-workflow-sync";
import {
	defaultWorkflowSettings,
	EFFORT_LEVELS,
	loadWorkflowSettings,
	ROLE_NAMES,
	saveWorkflowSettings,
	validateWorkflowSettings,
	type WorkflowSettings,
} from "main/lib/agent-workflow/workflow-settings";
import { getSupersetHomeDir } from "main/lib/app-environment";
import {
	costOf,
	dedupeAcrossSessions,
	getMetricsDir,
	loadSessions,
} from "main/lib/usage-metrics";
import { z } from "zod";
import { publicProcedure, router } from "../..";

/**
 * Model routing and cost settings for the multi-model workflow
 * (Settings > Models). Settings live in <ADE home>/workflow-settings.json;
 * saving re-applies routing to every agent (unedited files only).
 */

const roleRoutingSchema = z.object({
	model: z.string(),
	effort: z.enum(EFFORT_LEVELS),
	maxTurns: z.number(),
});

const settingsInputSchema = z.object({
	mainModel: z.string(),
	roles: z.object(
		Object.fromEntries(
			ROLE_NAMES.map((role) => [role, roleRoutingSchema]),
		) as Record<(typeof ROLE_NAMES)[number], typeof roleRoutingSchema>,
	),
	budgets: z.object({
		sessionWarnUsd: z.number().nullable(),
		dailyWarnUsd: z.number().nullable(),
		headlessMaxBudgetUsd: z.number(),
		headlessMaxTurns: z.number(),
	}),
});

function localDay(date: Date): string {
	return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export const createWorkflowRouter = () =>
	router({
		getSettings: publicProcedure.query(() => ({
			settings: loadWorkflowSettings(getSupersetHomeDir()),
			defaults: defaultWorkflowSettings(),
		})),

		setSettings: publicProcedure
			.input(settingsInputSchema)
			.mutation(({ input }) => {
				const home = getSupersetHomeDir();
				const current = loadWorkflowSettings(home);
				const result = validateWorkflowSettings({
					...input,
					version: 1,
					// Keep ADE's record of what it last wrote; the sync updates it.
					appliedMainModel: current.appliedMainModel,
				} satisfies Omit<WorkflowSettings, "version"> & { version: 1 });
				if (!result.ok) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: result.errors.join("; "),
					});
				}
				saveWorkflowSettings(home, result.settings);
				const sync = syncAgentWorkflowFiles(home);
				return { settings: loadWorkflowSettings(home), sync };
			}),

		/** Estimated cost today and per model, from recorded sessions. */
		getUsageSummary: publicProcedure.query(() => {
			const sessions = loadSessions(getMetricsDir());
			const owned = dedupeAcrossSessions(sessions);
			const today = localDay(new Date());
			const all = [...owned.values()].flat();
			const todays = all.filter((record) => {
				const at = new Date(record.timestamp);
				return !Number.isNaN(at.getTime()) && localDay(at) === today;
			});
			const todayCost = costOf(todays);
			return {
				sessions: sessions.length,
				todayUsd: todayCost.usd,
				todayByModel: Object.fromEntries(
					Object.entries(todayCost.byModel).map(([model, value]) => [
						model,
						value.usd,
					]),
				),
				allTimeUsd: costOf(all).usd,
			};
		}),
	});
