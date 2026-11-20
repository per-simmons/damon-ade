import { join } from "node:path";
import { projects, workspaces } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { eq } from "drizzle-orm";
import {
	activeRun,
	buildResumeCommand,
	captureIdentity,
	changedFilesOf,
	chooseSpecialists,
	codeState,
	createTask,
	currentBranch,
	customRoleContext,
	decideNext,
	defaultWorkflowSettings,
	EFFORT_LEVELS,
	ensureProjectWorkflow,
	getTask,
	identityMismatch,
	listSpecialists,
	listTaskRecords,
	loadProjectChecks,
	loadWorkflowSettings,
	PERMISSION_PROFILES,
	type ProjectWorkflow,
	ROLE_NAMES,
	RUN_KINDS,
	readTaskFiles,
	refreshAllProjectWorkflows,
	resolveSpecialist,
	saveProjectChecks,
	saveTask,
	saveWorkflowSettings,
	stageModel,
	stageRouting,
	suggestChecks,
	TaskController,
	type TaskIdentity,
	type TaskRecord,
	taskDir,
	taskSpecialists,
	taskSpend,
	validateWorkflowSettings,
} from "main/lib/agent-workflow";
import {
	getTaskController,
	type TaskChangeEvent,
	workflowEvents,
} from "main/lib/agent-workflow/service";
import { getSupersetHomeDir } from "main/lib/app-environment";
import { localDb } from "main/lib/local-db";
import {
	buildTaskHistory,
	clearTaskHistory,
	eligibleConversations,
} from "main/lib/project-history";
import {
	costOf,
	dedupeAcrossSessions,
	getMetricsDir,
	loadSessions,
} from "main/lib/usage-metrics";
import { classifyTask, TASK_ROUTES } from "shared/utils/task-routing";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { getWorkspacePath } from "../workspaces/utils/worktree";

/**
 * The multi-model workflow in the app (Settings > Models & Cost, and the
 * Tasks panel of every workspace). Settings are app-wide; tasks and usage are
 * per project, in <ADE home>/workflow/projects/<key>.
 *
 * Every task action goes through the TaskController (agent-workflow/
 * controller.ts): it owns the stages, runs them as child processes, holds the
 * per-task lock and records each run's outcome. The router only resolves
 * which project and worktree a request comes from, and refuses actions on a
 * task that belongs to another worktree unless the user moves it.
 */

const roleRoutingSchema = z.object({
	model: z.string(),
	effort: z.enum(EFFORT_LEVELS as [string, ...string[]]),
	maxTurns: z.number(),
});

const executionSchema = z.object({
	permissions: z.enum(PERMISSION_PROFILES),
	taskBudgetUsd: z.number(),
	maxCorrections: z.number(),
	maxReviewRounds: z.number(),
	maxEscalations: z.number(),
	pinModels: z.boolean(),
	cheaperFallback: z.boolean(),
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
	execution: executionSchema.optional(),
});

function localDay(date: Date): string {
	return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export interface WorkspaceContext {
	workspaceId: string;
	project: ProjectWorkflow;
	/** The workspace's own folder (its worktree). */
	worktreePath: string;
	runtime: "claude" | "codex";
}

export interface WorkflowRouterDeps {
	homeDir: () => string;
	resolveWorkspace: (workspaceId: string) => WorkspaceContext;
	controller: () => TaskController;
	captureIdentity: (workspaceId: string, worktreePath: string) => TaskIdentity;
	events: NodeJS.EventEmitter;
	/** Worktree probes (default: git). */
	branchOf?: (worktree: string) => string | undefined;
	codeStateOf?: (worktree: string) => string | undefined;
}

/**
 * The workflow project of a workspace: the project's main repo, or the
 * workspace's own folder when the project has none (ADE agents). Same rule as
 * the terminal environment, so the panel and the terminals agree.
 */
function resolveWorkspaceFromDb(workspaceId: string): WorkspaceContext {
	const workspace = localDb
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.get();
	if (!workspace) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
	}
	const worktreePath = getWorkspacePath(workspace);
	const project = localDb
		.select()
		.from(projects)
		.where(eq(projects.id, workspace.projectId))
		.get();
	const root = project?.mainRepoPath?.trim() || worktreePath;
	if (!root || !worktreePath) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "This workspace has no folder yet",
		});
	}
	return {
		workspaceId,
		project: ensureProjectWorkflow(getSupersetHomeDir(), root),
		worktreePath,
		runtime: workspace.runtime === "codex" ? "codex" : "claude",
	};
}

export const defaultWorkflowRouterDeps: WorkflowRouterDeps = {
	homeDir: getSupersetHomeDir,
	resolveWorkspace: resolveWorkspaceFromDb,
	controller: getTaskController,
	captureIdentity,
	events: workflowEvents,
};

function badRequest(error: unknown): TRPCError {
	if (error instanceof TRPCError) return error;
	return new TRPCError({
		code: "BAD_REQUEST",
		message: error instanceof Error ? error.message : String(error),
	});
}

/** Runs `fn`, turning thrown errors into BAD_REQUEST. */
async function guarded<T>(fn: () => Promise<T> | T): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw badRequest(error);
	}
}

/**
 * Choose the task's history excerpts (deterministic search, no model) and
 * record which conversations they came from. A task with no relevant
 * excerpts records an empty history, so the panel can say so.
 */
function withHistory(
	project: ProjectWorkflow,
	task: TaskRecord,
	excluded: string[],
): TaskRecord {
	const history = buildTaskHistory({
		project,
		taskDir: taskDir(project, task.slug),
		query: `${task.title}
${task.description}`,
		worktreePath: task.identity.worktreePath,
		excluded,
	});
	const updated = { ...task, history };
	saveTask(project, updated);
	return updated;
}

const roleOverrideSchema = z.object({
	model: z.string().max(100).optional(),
	effort: z.enum(EFFORT_LEVELS as [string, ...string[]]).optional(),
	maxTurns: z.number().int().min(1).max(500).optional(),
	instructions: z.string().max(10_000).optional(),
});
const roleOverridesSchema = z.object(
	Object.fromEntries(
		ROLE_NAMES.map((role) => [role, roleOverrideSchema.optional()]),
	) as Record<
		(typeof ROLE_NAMES)[number],
		z.ZodOptional<typeof roleOverrideSchema>
	>,
);

/**
 * The task's specialist: the user's choice, or Auto's keyword match against
 * the team's specialists (no model call). No specialists: default workflow.
 */
function assignSpecialist(
	homeDir: string,
	project: ProjectWorkflow,
	task: TaskRecord,
	choice: string,
	roleOverrides: Record<string, unknown> | undefined,
): TaskRecord {
	const settings = loadWorkflowSettings(homeDir);
	const specialists = listSpecialists(project).map((s) =>
		resolveSpecialist(s, settings, homeDir),
	);
	let updated: TaskRecord = {
		...task,
		roleOverrides: roleOverrides as TaskRecord["roleOverrides"],
	};
	if (choice === "none") {
		updated = {
			...updated,
			specialistReason: "default workflow (chosen by you)",
		};
	} else if (choice === "auto") {
		const picked = chooseSpecialists(
			`${task.title}\n${task.description}`,
			specialists,
		);
		updated = {
			...updated,
			specialistId: picked.primary?.specialist.id,
			supportingSpecialistIds: picked.supporting.map((s) => s.specialist.id),
			specialistReason: picked.reason,
		};
	} else {
		const chosen = specialists.find((s) => s.specialist.id === choice);
		if (!chosen) throw new Error("That specialist is not part of this team");
		updated = {
			...updated,
			specialistId: chosen.specialist.id,
			specialistReason: "chosen by you",
		};
	}
	saveTask(project, updated);
	return updated;
}

interface Probes {
	/** The workspace's branch now. */
	branchNow: string | undefined;
	/** Code state of a worktree now (cached per request). */
	codeStateOf: (worktree: string) => string | undefined;
}

/** What the panel shows for one task. */
function describeTask(
	homeDir: string,
	project: ProjectWorkflow,
	task: TaskRecord,
	ctx: WorkspaceContext,
	settings: ReturnType<typeof loadWorkflowSettings>,
	checks: { commands: string[] },
	probes: Probes,
) {
	const files = readTaskFiles(project, task.slug);
	const spend = taskSpend(task);
	const mismatch = identityMismatch(
		task,
		ctx.workspaceId,
		ctx.worktreePath,
		probes.branchNow,
	);
	const specialists = taskSpecialists(homeDir, project, task, settings);
	const next =
		task.state === "done" ||
		task.state === "cancelled" ||
		activeRun(task) ||
		mismatch
			? undefined
			: decideNext(task, files, checks, settings, {
					codeState: probes.codeStateOf(task.identity.worktreePath),
					customRoles: customRoleContext(
						specialists,
						task,
						changedFilesOf(task),
					),
				});
	let nextRouting: ReturnType<typeof stageRouting>["routing"] | null = null;
	if (next?.type === "run") {
		try {
			nextRouting = stageRouting(
				specialists,
				task,
				settings,
				next.kind,
				next.customRoleId,
			).routing;
		} catch {
			nextRouting = null;
		}
	}
	const manualBlockers = Object.fromEntries(
		RUN_KINDS.map((kind) => [
			kind,
			mismatch ??
				TaskController.manualBlocker(task, files, checks, kind) ??
				null,
		]),
	) as Record<(typeof RUN_KINDS)[number], string | null>;
	return {
		slug: task.slug,
		title: task.title,
		description: task.description,
		route: task.route,
		routeReasons: task.routeReasons,
		createdAt: task.createdAt,
		mode: task.mode,
		state: task.state,
		stateReason: task.stateReason ?? null,
		pauseRequested: task.pauseRequested ?? false,
		answers: task.answers ?? null,
		planQuestions: files.planQuestions,
		openEscalations: files.openEscalations,
		limits: task.limits,
		identity: {
			worktreePath: task.identity.worktreePath,
			branch: task.identity.branch ?? null,
		},
		/** Set when this workspace is not the task's worktree or branch. */
		mismatch: mismatch ?? null,
		moves: task.moves ?? [],
		/** Earlier conversations this task draws on (history.md). */
		history: task.history
			? {
					builtAt: task.history.builtAt,
					excerpts: task.history.excerpts,
					sources: task.history.sources,
					excluded: task.history.excluded,
					file: join(project.tasksDir, task.slug, "history.md"),
				}
			: null,
		spend,
		next: next ?? null,
		manualBlockers,
		/** The model the next stage will run on (the runner uses the same). */
		nextModel: nextRouting?.model ?? null,
		nextRole: nextRouting?.role ?? null,
		nextModelSource: nextRouting?.modelSource ?? null,
		specialist: specialists.primary
			? {
					id: specialists.primary.specialist.id,
					name: specialists.primary.specialist.name,
					specialty: specialists.primary.specialist.specialty,
				}
			: null,
		supportingSpecialists: specialists.supporting.map((s) => s.specialist.name),
		specialistReason: task.specialistReason ?? null,
		/** Specialist roles this task can run (Manual). */
		customRoles: (specialists.primary?.customRoles ?? []).map((r) => ({
			id: r.id,
			name: r.name,
			trigger: r.trigger,
			access: r.access,
		})),
		roleOverrides: task.roleOverrides ?? {},
		routeBy: task.routeBy ?? null,
		/** The AI pathway choice, once made. */
		triage: task.triage ?? null,
		/** A team request: the Coordinator splits it into subtasks. */
		isRequest: task.isRequest ?? false,
		subtaskSlugs: task.subtaskSlugs ?? [],
		splitReason: task.splitReason ?? null,
		parentSlug: task.parentSlug ?? null,
		runs: task.runs.map((run, index) => ({
			id: run.id,
			role: run.role ?? null,
			specialist: run.specialist ?? null,
			/** Before the task's last move: history, not evidence. */
			history: index < (task.evidenceStart ?? 0),
			kind: run.kind,
			status: run.status,
			attempt: run.attempt,
			queuedAt: run.queuedAt,
			startedAt: run.startedAt ?? null,
			endedAt: run.endedAt ?? null,
			model: run.model ?? null,
			observedModels: run.observedModels ?? [],
			effort: run.effort ?? null,
			effortNote: run.effortNote ?? null,
			maxTurns: run.maxTurns ?? null,
			permissionMode: run.permissionMode ?? null,
			maxBudgetUsd: run.maxBudgetUsd ?? null,
			sessionId: run.sessionId ?? null,
			fallbackFrom: run.fallbackFrom ?? null,
			reportedCostUsd: run.reportedCostUsd ?? null,
			liveCostUsd: run.liveCostUsd ?? null,
			costState: run.costState ?? (run.kind === "checks" ? null : "unknown"),
			unpricedModels: run.unpricedModels ?? [],
			failure: run.failure ?? null,
			error: run.error ?? null,
			verdict: run.verdict ?? null,
			checks: run.checks ?? null,
			summary: run.summary ? run.summary.slice(-1500) : null,
		})),
	};
}

export const createWorkflowRouter = (
	deps: WorkflowRouterDeps = defaultWorkflowRouterDeps,
) => {
	const branchOf = deps.branchOf ?? currentBranch;
	const codeStateOf = deps.codeStateOf ?? codeState;

	/** The task, after checking it may be acted on from this workspace. */
	function taskFor(
		workspaceId: string,
		slug: string,
		options: { allowOtherWorktree?: boolean } = {},
	): { ctx: WorkspaceContext; task: TaskRecord } {
		const ctx = deps.resolveWorkspace(workspaceId);
		const task = getTask(ctx.project, slug);
		if (!task)
			throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
		if (!options.allowOtherWorktree) {
			const mismatch = identityMismatch(
				task,
				workspaceId,
				ctx.worktreePath,
				branchOf(ctx.worktreePath),
			);
			if (mismatch)
				throw new TRPCError({ code: "CONFLICT", message: mismatch });
		}
		return { ctx, task };
	}

	const taskInput = z.object({ workspaceId: z.string(), slug: z.string() });

	/** A task whose history may change: not while a run is using it. */
	function historyTask(workspaceId: string, slug: string) {
		const found = taskFor(workspaceId, slug);
		if (activeRun(found.task)) {
			throw new TRPCError({
				code: "CONFLICT",
				message:
					"Wait for the current run to finish before changing its history",
			});
		}
		return found;
	}

	return router({
		getSettings: publicProcedure.query(() => ({
			settings: loadWorkflowSettings(deps.homeDir()),
			defaults: defaultWorkflowSettings(),
		})),

		setSettings: publicProcedure
			.input(settingsInputSchema)
			.mutation(({ input }) => {
				const home = deps.homeDir();
				const current = loadWorkflowSettings(home);
				const result = validateWorkflowSettings({
					...input,
					execution: input.execution ?? current.execution,
					version: 1,
				});
				if (!result.ok) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: result.errors.join("; "),
					});
				}
				saveWorkflowSettings(home, result.settings);
				// Every project's roles file follows the new routing.
				const projectsUpdated = refreshAllProjectWorkflows(home);
				return { settings: result.settings, projectsUpdated };
			}),

		/**
		 * Interactive sessions recorded from transcripts: API-equivalent
		 * estimates (on a subscription they are not charges). Unpriced
		 * responses are counted so the total is never shown as complete when
		 * it is not.
		 */
		getUsageSummary: publicProcedure.query(() => {
			const sessions = loadSessions(getMetricsDir());
			const owned = dedupeAcrossSessions(sessions);
			const today = localDay(new Date());
			const all = [...owned.values()].flat();
			const todays = all.filter((record) => {
				const at = new Date(record.timestamp);
				return !Number.isNaN(at.getTime()) && localDay(at) === today;
			});
			const allCost = costOf(all);
			const todayCost = costOf(todays);
			return {
				sessions: sessions.length,
				todayUsd: todayCost.usd,
				todayUnpriced: todayCost.unpricedMessages,
				allTimeUsd: allCost.usd,
				allTimeUnpriced: allCost.unpricedMessages,
			};
		}),

		/** The Tasks panel: this workspace's project, its tasks and spend. */
		getProjectTasks: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(({ input }) => {
				const ctx = deps.resolveWorkspace(input.workspaceId);
				const { project } = ctx;
				const settings = loadWorkflowSettings(deps.homeDir());
				const projectChecks = loadProjectChecks(project);
				const approved = {
					commands: projectChecks.approvedAt ? projectChecks.commands : [],
				};
				const states = new Map<string, string | undefined>();
				const probes: Probes = {
					branchNow: branchOf(ctx.worktreePath),
					codeStateOf: (worktree) => {
						if (!states.has(worktree))
							states.set(worktree, codeStateOf(worktree));
						return states.get(worktree);
					},
				};
				const tasks = listTaskRecords(project).map((task) =>
					describeTask(
						deps.homeDir(),
						project,
						task,
						ctx,
						settings,
						approved,
						probes,
					),
				);

				// Task runs: Claude Code's reported cost (each run once, child
				// subagents included). Interactive sessions in this project:
				// estimated from transcripts, kept separate.
				const taskTotals = tasks.reduce(
					(sum, task) => ({
						usd: sum.usd + task.spend.usd,
						worstCaseUsd: sum.worstCaseUsd + task.spend.worstCaseUsd,
						pendingRuns: sum.pendingRuns + task.spend.pendingRuns,
						unknownRuns: sum.unknownRuns + task.spend.unknownRuns,
						partialRuns: sum.partialRuns + task.spend.partialRuns,
						uncertainRuns: sum.uncertainRuns + task.spend.uncertainRuns,
					}),
					{
						usd: 0,
						worstCaseUsd: 0,
						pendingRuns: 0,
						unknownRuns: 0,
						partialRuns: 0,
						uncertainRuns: 0,
					},
				);
				// Task runs' transcripts are recorded too (for reports); here they
				// are already counted from task.json, so leave them out.
				const runSessions = new Set(
					tasks.flatMap((task) => task.runs.map((run) => run.sessionId)),
				);
				const sessions = loadSessions(getMetricsDir()).filter(
					(session) =>
						session.projectKey === project.key &&
						!runSessions.has(session.sessionId),
				);
				const owned = dedupeAcrossSessions(sessions);
				const sessionCost = costOf([...owned.values()].flat());

				return {
					project: {
						key: project.key,
						name: project.name,
						root: project.root,
						tasksDir: project.tasksDir,
					},
					worktreePath: ctx.worktreePath,
					/** Imported conversations a new task here would search. */
					historyAvailable: eligibleConversations(project, ctx.worktreePath)
						.length,
					runtime: ctx.runtime,
					/** Managed stages always run on Claude Code, even in Codex workspaces. */
					executor: "claude-code" as const,
					permissions: settings.execution.permissions,
					checks: {
						commands: projectChecks.commands,
						approved: !!projectChecks.approvedAt,
					},
					tasks,
					usage: {
						tasks: taskTotals,
						sessions: {
							count: sessions.length,
							usd: sessionCost.usd,
							unpricedMessages: sessionCost.unpricedMessages,
						},
					},
				};
			}),

		/** Pushes a refresh signal when any task changes. */
		onTaskChanged: publicProcedure.subscription(() =>
			observable<TaskChangeEvent>((emit) => {
				const handler = (event: TaskChangeEvent) => emit.next(event);
				deps.events.on("task-changed", handler);
				return () => {
					deps.events.off("task-changed", handler);
				};
			}),
		),

		/** Preview how a description would be routed, before creating it. */
		classify: publicProcedure
			.input(z.object({ description: z.string().max(20_000) }))
			.query(({ input }) => {
				const decision = classifyTask(input.description);
				const settings = loadWorkflowSettings(deps.homeDir());
				const firstStage = decision.route === "plan" ? "plan" : decision.route;
				return {
					...decision,
					model: stageModel(firstStage, decision, settings),
				};
			}),

		/** The project's check commands: saved, approved, and suggestions. */
		getChecks: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(({ input }) => {
				const ctx = deps.resolveWorkspace(input.workspaceId);
				const checks = loadProjectChecks(ctx.project);
				return {
					commands: checks.commands,
					approved: !!checks.approvedAt,
					suggestions: suggestChecks(ctx.worktreePath),
				};
			}),

		/** Save and approve the commands ADE runs to verify every task. */
		setChecks: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					commands: z.array(z.string()).max(10),
				}),
			)
			.mutation(({ input }) =>
				guarded(() => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					const saved = saveProjectChecks(ctx.project, input.commands);
					return { commands: saved.commands, approved: !!saved.approvedAt };
				}),
			),

		/**
		 * One request in, one task out. In Auto mode ADE starts it at once and
		 * keeps going to a verified finish; in Manual mode it waits for steps.
		 * The result carries the task's state, so a failed launch is visible.
		 */
		createTask: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					description: z.string().min(1).max(20_000),
					route: z.enum(TASK_ROUTES).optional(),
					mode: z.enum(["auto", "manual"]).default("auto"),
					/** Give the task excerpts of the project's imported history. */
					useHistory: z.boolean().default(true),
					/** Let a short AI run choose the pathway and models (Auto only). */
					aiRouting: z.boolean().default(false),
					/** A team request: a Coordinator splits it across the specialists (Auto only). */
					split: z.boolean().default(false),
					/** "auto": ADE picks from the team's specialists; "none": default workflow. */
					specialist: z.string().default("auto"),
					/** Model settings for this task only. */
					roleOverrides: roleOverridesSchema.optional(),
				}),
			)
			.mutation(({ input }) =>
				guarded(async () => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					const execution = loadWorkflowSettings(deps.homeDir()).execution;
					const created = createTask(ctx.project, {
						description: input.description,
						route: input.route,
						mode: input.mode,
						identity: deps.captureIdentity(input.workspaceId, ctx.worktreePath),
						limits: {
							budgetUsd: execution.taskBudgetUsd,
							maxCorrections: execution.maxCorrections,
							maxReviewRounds: execution.maxReviewRounds,
							maxEscalations: execution.maxEscalations,
						},
					});
					const withSpecialist = assignSpecialist(
						deps.homeDir(),
						ctx.project,
						created,
						input.specialist,
						input.roleOverrides,
					);
					const routed: TaskRecord =
						input.split && input.mode === "auto"
							? {
									...created,
									isRequest: true,
									routeBy: "ai",
									routeReasons: ["a team request: the Coordinator splits it"],
									specialistReason:
										"the Coordinator assigns a specialist to each subtask",
								}
							: input.aiRouting && input.mode === "auto" && !input.route
								? { ...withSpecialist, routeBy: "ai" }
								: {
										...withSpecialist,
										routeBy: input.route ? "user" : "rules",
									};
					saveTask(ctx.project, routed);
					const task = input.useHistory
						? withHistory(ctx.project, routed, [])
						: routed;
					const started =
						input.mode === "auto"
							? await deps.controller().start(ctx.project, task.slug)
							: task;
					return {
						slug: started.slug,
						route: started.route,
						mode: started.mode,
						state: started.state,
						stateReason: started.stateReason ?? null,
					};
				}),
			),

		/**
		 * Choose the task's history again from the project's current imports
		 * (after importing, refreshing or removing conversations).
		 */
		refreshTaskHistory: publicProcedure.input(taskInput).mutation(({ input }) =>
			guarded(() => {
				const { ctx, task } = historyTask(input.workspaceId, input.slug);
				const updated = withHistory(
					ctx.project,
					task,
					task.history?.excluded ?? [],
				);
				return { excerpts: updated.history?.excerpts ?? 0 };
			}),
		),

		/** Stop using one conversation in this task (the import is kept). */
		excludeTaskHistory: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					slug: z.string(),
					conversationId: z.string(),
				}),
			)
			.mutation(({ input }) =>
				guarded(() => {
					const { ctx, task } = historyTask(input.workspaceId, input.slug);
					const excluded = [
						...new Set([
							...(task.history?.excluded ?? []),
							input.conversationId,
						]),
					];
					const updated = withHistory(ctx.project, task, excluded);
					return { excerpts: updated.history?.excerpts ?? 0 };
				}),
			),

		/** Run this task without any project history. */
		clearTaskHistory: publicProcedure.input(taskInput).mutation(({ input }) =>
			guarded(() => {
				const { ctx, task } = historyTask(input.workspaceId, input.slug);
				clearTaskHistory(taskDir(ctx.project, task.slug));
				const { history: _history, ...rest } = task;
				saveTask(ctx.project, rest);
				return { cleared: true };
			}),
		),

		/** Manual: choose the task's specialist (not while a run is going). */
		setTaskSpecialist: publicProcedure
			.input(taskInput.extend({ specialist: z.string() }))
			.mutation(({ input }) =>
				guarded(() => {
					const { ctx, task } = historyTask(input.workspaceId, input.slug);
					const updated = assignSpecialist(
						deps.homeDir(),
						ctx.project,
						{
							...task,
							specialistId: undefined,
							supportingSpecialistIds: [],
						},
						input.specialist,
						task.roleOverrides,
					);
					return { specialistId: updated.specialistId ?? null };
				}),
			),

		/** This task's own role settings (they never change saved settings). */
		setTaskRoleOverrides: publicProcedure
			.input(taskInput.extend({ roleOverrides: roleOverridesSchema }))
			.mutation(({ input }) =>
				guarded(() => {
					const { ctx, task } = historyTask(input.workspaceId, input.slug);
					saveTask(ctx.project, {
						...task,
						roleOverrides: input.roleOverrides as TaskRecord["roleOverrides"],
					});
					return { ok: true };
				}),
			),

		start: publicProcedure.input(taskInput).mutation(({ input }) =>
			guarded(async () => {
				const { ctx } = taskFor(input.workspaceId, input.slug);
				const task = await deps.controller().start(ctx.project, input.slug);
				return { state: task.state, stateReason: task.stateReason ?? null };
			}),
		),

		resume: publicProcedure.input(taskInput).mutation(({ input }) =>
			guarded(async () => {
				const { ctx } = taskFor(input.workspaceId, input.slug);
				const task = await deps.controller().resume(ctx.project, input.slug);
				return { state: task.state, stateReason: task.stateReason ?? null };
			}),
		),

		/** Pause and Cancel always work, from any worktree of the project. */
		pause: publicProcedure.input(taskInput).mutation(({ input }) =>
			guarded(async () => {
				const { ctx } = taskFor(input.workspaceId, input.slug, {
					allowOtherWorktree: true,
				});
				const task = await deps.controller().pause(ctx.project, input.slug);
				return { state: task.state, stateReason: task.stateReason ?? null };
			}),
		),

		cancel: publicProcedure.input(taskInput).mutation(({ input }) =>
			guarded(async () => {
				const { ctx } = taskFor(input.workspaceId, input.slug, {
					allowOtherWorktree: true,
				});
				const task = await deps.controller().cancel(ctx.project, input.slug);
				return { state: task.state, stateReason: task.stateReason ?? null };
			}),
		),

		setMode: publicProcedure
			.input(taskInput.extend({ mode: z.enum(["auto", "manual"]) }))
			.mutation(({ input }) =>
				guarded(async () => {
					const { ctx } = taskFor(input.workspaceId, input.slug);
					const task = await deps
						.controller()
						.setMode(ctx.project, input.slug, input.mode);
					return { mode: task.mode, state: task.state };
				}),
			),

		answer: publicProcedure
			.input(taskInput.extend({ answers: z.string().min(1).max(10_000) }))
			.mutation(({ input }) =>
				guarded(async () => {
					const { ctx } = taskFor(input.workspaceId, input.slug);
					const task = await deps
						.controller()
						.answer(ctx.project, input.slug, input.answers);
					return { state: task.state, stateReason: task.stateReason ?? null };
				}),
			),

		setBudget: publicProcedure
			.input(taskInput.extend({ budgetUsd: z.number().positive().max(10_000) }))
			.mutation(({ input }) =>
				guarded(async () => {
					const { ctx } = taskFor(input.workspaceId, input.slug, {
						allowOtherWorktree: true,
					});
					const task = await deps
						.controller()
						.setLimits(ctx.project, input.slug, { budgetUsd: input.budgetUsd });
					return { limits: task.limits };
				}),
			),

		/** Manual mode (or a paused Auto task): run one step. */
		runStep: publicProcedure
			.input(
				taskInput.extend({
					kind: z.enum(RUN_KINDS),
					model: z.string().max(100).optional(),
					customRoleId: z.string().max(100).optional(),
				}),
			)
			.mutation(({ input }) =>
				guarded(async () => {
					const { ctx } = taskFor(input.workspaceId, input.slug);
					const task = await deps
						.controller()
						.runStep(
							ctx.project,
							input.slug,
							input.kind,
							input.model,
							input.customRoleId,
						);
					return { state: task.state, stateReason: task.stateReason ?? null };
				}),
			),

		/** Explicitly move a task from another worktree to this one. */
		moveHere: publicProcedure.input(taskInput).mutation(({ input }) =>
			guarded(async () => {
				const { ctx } = taskFor(input.workspaceId, input.slug, {
					allowOtherWorktree: true,
				});
				const task = await deps
					.controller()
					.adopt(
						ctx.project,
						input.slug,
						deps.captureIdentity(input.workspaceId, ctx.worktreePath),
					);
				return { worktreePath: task.identity.worktreePath };
			}),
		),

		/**
		 * The command to open a run's Claude session in a terminal of the task's
		 * worktree. Interactive: ADE's permissions, budget and turn limits do not
		 * apply there (the panel says so).
		 */
		sessionCommand: publicProcedure
			.input(taskInput.extend({ runId: z.string() }))
			.query(({ input }) => {
				const { task } = taskFor(input.workspaceId, input.slug);
				const run = task.runs.find((r) => r.id === input.runId);
				if (!run?.sessionId) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "This run has no session",
					});
				}
				return {
					command: buildResumeCommand(run.sessionId),
					cwd: task.identity.worktreePath,
				};
			}),
	});
};
