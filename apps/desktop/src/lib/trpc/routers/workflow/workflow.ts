import { projects, workspaces } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { shellKindFor } from "main/lib/agent-invoke";
import {
	createTask,
	defaultWorkflowSettings,
	EFFORT_LEVELS,
	ensureProjectWorkflow,
	getTask,
	listTasks,
	loadWorkflowSettings,
	type ProjectWorkflow,
	prepareStageLaunch,
	ROLE_NAMES,
	refreshAllProjectWorkflows,
	saveWorkflowSettings,
	stageModel,
	TASK_STAGES,
	validateWorkflowSettings,
	type WorkflowRuntime,
} from "main/lib/agent-workflow";
import { getSupersetHomeDir } from "main/lib/app-environment";
import { localDb } from "main/lib/local-db";
import { getDefaultShell } from "main/lib/terminal/env";
import {
	costOf,
	dedupeAcrossSessions,
	getMetricsDir,
	loadSessions,
	type SessionMetrics,
} from "main/lib/usage-metrics";
import { classifyTask, TASK_ROUTES } from "shared/utils/task-routing";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { getWorkspacePath } from "../workspaces/utils/worktree";

/**
 * The multi-model workflow in the app (Settings > Models & Cost, and the
 * Tasks panel of every workspace). Settings are app-wide; tasks, plans,
 * progress and usage are per project, in <ADE home>/workflow/projects/<key>.
 */

const roleRoutingSchema = z.object({
	model: z.string(),
	effort: z.enum(EFFORT_LEVELS as [string, ...string[]]),
	maxTurns: z.number(),
});

const settingsInputSchema = z.object({
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

interface WorkspaceProject {
	project: ProjectWorkflow;
	workspacePath: string;
	runtime: WorkflowRuntime;
}

/**
 * The workflow project of a workspace: the project's main repo, or the
 * workspace's own folder when the project has none (ADE agents). Same rule as
 * the terminal environment, so the panel and the terminals agree.
 */
function resolveWorkspaceProject(workspaceId: string): WorkspaceProject {
	const workspace = localDb
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.get();
	if (!workspace) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
	}
	const workspacePath = getWorkspacePath(workspace);
	const project = localDb
		.select()
		.from(projects)
		.where(eq(projects.id, workspace.projectId))
		.get();
	const root = project?.mainRepoPath?.trim() || workspacePath;
	if (!root || !workspacePath) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "This workspace has no folder yet",
		});
	}
	return {
		project: ensureProjectWorkflow(getSupersetHomeDir(), root),
		workspacePath,
		runtime: workspace.runtime === "codex" ? "codex" : "claude",
	};
}

function sessionCosts(sessions: SessionMetrics[]) {
	const owned = dedupeAcrossSessions(sessions);
	return (session: SessionMetrics) =>
		costOf(owned.get(session.sessionId) ?? []);
}

function launchStage(
	workspaceId: string,
	slug: string,
	stage: (typeof TASK_STAGES)[number],
	modelOverride?: string,
) {
	const { project, workspacePath, runtime } =
		resolveWorkspaceProject(workspaceId);
	try {
		const plan = prepareStageLaunch({
			homeDir: getSupersetHomeDir(),
			project,
			slug,
			stage,
			settings: loadWorkflowSettings(getSupersetHomeDir()),
			shell: shellKindFor(getDefaultShell()),
			runtime,
			modelOverride,
		});
		return {
			command: plan.command,
			cwd: workspacePath,
			stage: plan.stage,
			model: plan.model,
			runtime: plan.runtime,
			slug: plan.task.slug,
		};
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: error instanceof Error ? error.message : String(error),
		});
	}
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
				const result = validateWorkflowSettings({ ...input, version: 1 });
				if (!result.ok) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: result.errors.join("; "),
					});
				}
				saveWorkflowSettings(home, result.settings);
				// Every project's roles file follows the new routing; sessions started
				// from now on use it.
				const projectsUpdated = refreshAllProjectWorkflows(home);
				return { settings: result.settings, projectsUpdated };
			}),

		/** Estimated cost today and overall, from recorded sessions. */
		getUsageSummary: publicProcedure.query(() => {
			const sessions = loadSessions(getMetricsDir());
			const owned = dedupeAcrossSessions(sessions);
			const today = localDay(new Date());
			const all = [...owned.values()].flat();
			const todays = all.filter((record) => {
				const at = new Date(record.timestamp);
				return !Number.isNaN(at.getTime()) && localDay(at) === today;
			});
			return {
				sessions: sessions.length,
				todayUsd: costOf(todays).usd,
				allTimeUsd: costOf(all).usd,
			};
		}),

		/** The Tasks panel: this workspace's project, its tasks and usage. */
		getProjectTasks: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(({ input }) => {
				const { project, runtime } = resolveWorkspaceProject(input.workspaceId);
				const settings = loadWorkflowSettings(getSupersetHomeDir());
				const sessions = loadSessions(getMetricsDir());
				const cost = sessionCosts(sessions);
				const bySessionId = new Map(sessions.map((s) => [s.sessionId, s]));
				const projectSessions = sessions.filter(
					(session) => session.projectKey === project.key,
				);

				const tasks = listTasks(project).map((task) => {
					const taskSessions = task.stages
						.map((stage) => stage.sessionId && bySessionId.get(stage.sessionId))
						.filter((session): session is SessionMetrics => !!session);
					const costs = taskSessions.map(cost);
					return {
						...task,
						usd: costs.reduce((sum, c) => sum + c.usd, 0),
						models: [...new Set(costs.flatMap((c) => Object.keys(c.byModel)))],
						nextStageModel: task.nextStage
							? stageModel(task.nextStage, task, settings)
							: null,
					};
				});

				return {
					project: {
						key: project.key,
						name: project.name,
						root: project.root,
						tasksDir: project.tasksDir,
					},
					runtime,
					tasks,
					usage: {
						sessions: projectSessions.length,
						usd: projectSessions.map(cost).reduce((sum, c) => sum + c.usd, 0),
					},
				};
			}),

		/** Preview how a description would be routed, before creating it. */
		classify: publicProcedure
			.input(z.object({ description: z.string().max(20_000) }))
			.query(({ input }) => {
				const decision = classifyTask(input.description);
				const settings = loadWorkflowSettings(getSupersetHomeDir());
				const firstStage = decision.route === "plan" ? "plan" : decision.route;
				return {
					...decision,
					model: stageModel(firstStage, decision, settings),
				};
			}),

		/** Create a task and return the command for its first stage. */
		createTask: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					description: z.string().min(1).max(20_000),
					route: z.enum(TASK_ROUTES).optional(),
					model: z.string().optional(),
				}),
			)
			.mutation(({ input }) => {
				const { project } = resolveWorkspaceProject(input.workspaceId);
				let task: ReturnType<typeof createTask>;
				try {
					task = createTask(project, {
						description: input.description,
						route: input.route,
					});
				} catch (error) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: error instanceof Error ? error.message : String(error),
					});
				}
				const firstStage =
					task.route === "quick"
						? "quick"
						: task.route === "implement"
							? "implement"
							: "plan";
				return launchStage(
					input.workspaceId,
					task.slug,
					firstStage,
					input.model,
				);
			}),

		/** Return the command for a stage of an existing task. */
		launchStage: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					slug: z.string(),
					stage: z.enum(TASK_STAGES),
					model: z.string().optional(),
				}),
			)
			.mutation(({ input }) => {
				const { project } = resolveWorkspaceProject(input.workspaceId);
				if (!getTask(project, input.slug)) {
					throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
				}
				return launchStage(
					input.workspaceId,
					input.slug,
					input.stage,
					input.model,
				);
			}),
	});
