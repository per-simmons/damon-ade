import { existsSync, readFileSync } from "node:fs";
import { checksPassed, loadProjectChecks } from "./checks";
import { taskChanges } from "./identity";
import { cheaperFallback, resolveRunModel } from "./models";
import { type ProjectWorkflow, portablePath } from "./project-workflow";
import { parseVerdict, stagePrompt } from "./stage-prompts";
import type {
	PermissionMode,
	StageProgress,
	StageRunHandle,
	StageRunResult,
	StageRunSpec,
} from "./stage-runner";
import {
	activeRun,
	type CheckResult,
	getTask,
	type ModelStage,
	type RunKind,
	readTaskFiles,
	saveTask,
	type TaskFiles,
	type TaskIdentity,
	type TaskLimits,
	type TaskRecord,
	type TaskRun,
	withTaskLock,
} from "./tasks";
import type { RoleName, WorkflowSettings } from "./workflow-settings";

/**
 * The app-owned stage controller. A deterministic state machine decides each
 * next step from the task record (runs and their outcomes), the files the
 * agents wrote, the approved checks and the limits. Model runs are child
 * processes ADE starts and watches; checks are commands ADE runs itself.
 *
 * Auto mode advances after every run until the task is verified done, or
 * stops for a real reason: a question only the user can answer, a failure it
 * may not retry, an exhausted limit or budget, or Pause/Cancel. Manual mode
 * runs one requested step at a time, with the same prerequisites and lock.
 *
 * Done means: the approved checks passed after the last change, and an
 * independent review run returned PASS (quick tasks with passing checks skip
 * the review; without checks, every task needs the review).
 */

const IMPLEMENTATION_KINDS: RunKind[] = ["quick", "implement", "build", "fix"];

export const STAGE_ROLE: Record<ModelStage, RoleName> = {
	quick: "quick",
	implement: "implementer",
	plan: "planner",
	build: "implementer",
	fix: "implementer",
	review: "reviewer",
	escalate: "architect",
};

const READ_ONLY_GIT = [
	"Bash(git diff:*)",
	"Bash(git status:*)",
	"Bash(git log:*)",
	"Bash(git show:*)",
];

export type Decision =
	| { type: "wait" }
	| { type: "none" }
	| { type: "run"; kind: ModelStage; fallbackFrom?: string; reason: string }
	| { type: "checks"; reason: string }
	| { type: "done"; reason: string }
	| { type: "pause"; reason: string }
	| { type: "needs-input"; reason: string }
	| { type: "block"; reason: string }
	| { type: "reroute"; route: "implement"; reason: string };

export interface ApprovedChecks {
	commands: string[];
}

export interface TaskSpend {
	/** Known spend: Claude Code's reported cost, else ADE's estimate. */
	usd: number;
	/** Runs still in progress (their cost is still growing). */
	pendingRuns: number;
	/** Finished runs with no usage at all: their cost is unknown. */
	unknownRuns: number;
	/** Runs where some responses could not be priced: the total is low. */
	partialRuns: number;
}

/** What a task's model runs have cost, each run counted once. */
export function taskSpend(task: TaskRecord): TaskSpend {
	const spend: TaskSpend = {
		usd: 0,
		pendingRuns: 0,
		unknownRuns: 0,
		partialRuns: 0,
	};
	for (const run of task.runs) {
		if (run.kind === "checks") continue;
		if (run.status === "queued") continue;
		if (run.status === "running") spend.pendingRuns++;
		const cost = run.reportedCostUsd ?? run.liveCostUsd;
		if (cost !== undefined) spend.usd += cost;
		else if (run.status !== "running" && run.failure !== "launch")
			spend.unknownRuns++;
		if (run.costState === "partial") spend.partialRuns++;
	}
	return spend;
}

function lastIndex(task: TaskRecord, test: (run: TaskRun) => boolean): number {
	for (let i = task.runs.length - 1; i >= 0; i--) {
		if (test(task.runs[i])) return i;
	}
	return -1;
}

const count = (task: TaskRecord, kind: RunKind) =>
	task.runs.filter((run) => run.kind === kind && run.status !== "queued")
		.length;

/**
 * The next step, decided from recorded facts only. Pure: no I/O, so every
 * transition is unit-testable.
 */
export function decideNext(
	task: TaskRecord,
	files: TaskFiles,
	checks: ApprovedChecks,
	settings: Pick<WorkflowSettings, "execution">,
): Decision {
	if (activeRun(task)) return { type: "wait" };
	if (task.state === "done" || task.state === "cancelled")
		return { type: "none" };

	const spend = taskSpend(task);
	if (spend.usd >= task.limits.budgetUsd) {
		return {
			type: "block",
			reason: `The task's budget of $${task.limits.budgetUsd.toFixed(2)} is used up ($${spend.usd.toFixed(2)} estimated).`,
		};
	}

	// A failed last run decides first, unless the user resumed past it.
	const last = task.runs[task.runs.length - 1];
	if (
		last &&
		last.status !== "succeeded" &&
		last.id !== task.acknowledgedRunId
	) {
		const kind = last.kind;
		switch (last.failure) {
			case "model-unavailable": {
				const fallback =
					kind !== "checks" &&
					settings.execution.cheaperFallback &&
					!last.fallbackFrom &&
					last.model
						? cheaperFallback(last.model)
						: undefined;
				if (fallback && kind !== "checks") {
					return {
						type: "run",
						kind,
						fallbackFrom: last.model,
						reason: `${last.model} is unavailable; trying the cheaper ${fallback} once`,
					};
				}
				return {
					type: "block",
					reason: `${last.model ?? "The model"} is unavailable for this account or provider.`,
				};
			}
			case "rate-limited":
				return {
					type: "pause",
					reason: "Rate limited. Resume when the limit resets.",
				};
			case "auth":
				return {
					type: "block",
					reason:
						"Claude Code is not signed in or not authorized for this model.",
				};
			case "budget":
				return { type: "block", reason: "The run hit its spending cap." };
			case "max-turns":
				return {
					type: "block",
					reason: `The ${kind} run hit its turn limit. Raise the limit or narrow the task, then resume.`,
				};
			case "cancelled":
				return { type: "none" };
			case "interrupted":
				return {
					type: "pause",
					reason: "ADE stopped while this ran. Check the work, then resume.",
				};
			case "launch":
				return {
					type: "block",
					reason: `The ${kind} run could not start: ${last.error ?? ""}`.trim(),
				};
			default:
				return {
					type: "block",
					reason: `The ${kind} run failed: ${(last.error ?? "unknown error").slice(0, 300)}`,
				};
		}
	}

	const limits = task.limits;
	const lastImpl = lastIndex(
		task,
		(run) =>
			IMPLEMENTATION_KINDS.includes(run.kind) && run.status === "succeeded",
	);

	// Routing for quick tasks that turned out not to be small.
	if (task.route === "quick" && lastImpl >= 0) {
		const quick = task.runs[lastImpl];
		if (
			quick.kind === "quick" &&
			/Needs implementer/i.test(quick.summary ?? "")
		) {
			return {
				type: "reroute",
				route: "implement",
				reason: "the quick run found the change is not small",
			};
		}
	}

	// Plan first for planned routes.
	const planned = task.route === "plan" || task.route === "exceptional";
	if (planned) {
		const planRun = lastIndex(
			task,
			(run) => run.kind === "plan" && run.status === "succeeded",
		);
		if (!files.hasPlan) {
			if (planRun >= 0) {
				return {
					type: "block",
					reason: "The planner finished without writing plan.md.",
				};
			}
			return { type: "run", kind: "plan", reason: "complex task: plan first" };
		}
		if (files.planQuestions.length > 0 && !task.answers) {
			return {
				type: "needs-input",
				reason: `The plan needs your decision: ${files.planQuestions.join("; ")}`,
			};
		}
	}

	if (lastImpl < 0) {
		const first: ModelStage =
			task.route === "quick"
				? "quick"
				: task.route === "implement"
					? "implement"
					: "build";
		return { type: "run", kind: first, reason: "implement the task" };
	}

	// Escalation: an open report after the last implementation run.
	if (files.openEscalations.length > 0) {
		if (count(task, "escalate") >= limits.maxEscalations) {
			return {
				type: "block",
				reason: `Still blocked after ${limits.maxEscalations} escalation(s): ${files.openEscalations.join(", ")}`,
			};
		}
		return {
			type: "run",
			kind: "escalate",
			reason: `blocked: ${files.openEscalations[0]}`,
		};
	}
	const lastEscalate = lastIndex(
		task,
		(run) => run.kind === "escalate" && run.status === "succeeded",
	);
	if (lastEscalate > lastImpl) {
		return {
			type: "run",
			kind: planned ? "build" : "fix",
			reason: "continue after the escalation was resolved",
		};
	}
	if (
		/^blocked\b/i.test(files.progressStatus ?? "") &&
		lastEscalate < lastImpl
	) {
		return {
			type: "needs-input",
			reason:
				"The implementation reports it is blocked but wrote no escalation report.",
		};
	}

	const corrections = count(task, "fix");
	const correctOrBlock = (what: string, feedbackReason: string): Decision =>
		corrections >= limits.maxCorrections
			? {
					type: "block",
					reason: `${what} after ${limits.maxCorrections} correction(s).`,
				}
			: { type: "run", kind: "fix", reason: feedbackReason };

	// Checks after the last change.
	if (checks.commands.length > 0) {
		const lastChecks = lastIndex(task, (run) => run.kind === "checks");
		if (lastChecks < lastImpl)
			return { type: "checks", reason: "verify the change" };
		const run = task.runs[lastChecks];
		if (!checksPassed(run.checks ?? [], checks.commands.length)) {
			return correctOrBlock("Checks still fail", "checks failed");
		}
		if (task.route === "quick") {
			return { type: "done", reason: "small change; the checks passed" };
		}
	}

	// Independent review after the last change.
	const lastReview = lastIndex(
		task,
		(run) => run.kind === "review" && run.status === "succeeded",
	);
	if (lastReview < lastImpl) {
		if (count(task, "review") >= limits.maxReviewRounds) {
			return {
				type: "block",
				reason: `No passing review after ${limits.maxReviewRounds} review round(s).`,
			};
		}
		return { type: "run", kind: "review", reason: "independent review" };
	}
	const verdict = task.runs[lastReview].verdict;
	if (verdict === "PASS") {
		return {
			type: "done",
			reason:
				checks.commands.length > 0
					? "the checks passed and the review passed"
					: "the review passed (no checks configured)",
		};
	}
	if (verdict === undefined) {
		return { type: "block", reason: "The review finished without a verdict." };
	}
	return correctOrBlock("The review still fails", "the review failed");
}

/** Feedback for a fix run: the failing checks and/or the failed review. */
export function correctionFeedback(task: TaskRecord): string {
	const parts: string[] = [];
	const lastChecks = [...task.runs]
		.reverse()
		.find((run) => run.kind === "checks");
	for (const check of lastChecks?.checks ?? []) {
		if (check.exitCode !== 0 || check.timedOut) {
			parts.push(
				`Check \`${check.command}\` ${check.timedOut ? "timed out" : `failed (exit ${check.exitCode})`}:\n\`\`\`\n${check.outputTail.slice(-2500)}\n\`\`\``,
			);
		}
	}
	const lastReview = [...task.runs]
		.reverse()
		.find((run) => run.kind === "review");
	if (lastReview?.verdict === "FAIL") {
		parts.push(
			`The independent review failed:\n${(lastReview.summary ?? "").slice(-3000)}`,
		);
	}
	return parts.join("\n\n") || "(no failure details recorded)";
}

export interface ControllerDeps {
	homeDir: string;
	loadSettings: () => WorkflowSettings;
	/** The Claude Code command (executable + leading args), or null if missing. */
	resolveClaude: () => string[] | null;
	startRun: (
		spec: StageRunSpec,
		onProgress: (progress: StageProgress) => void,
	) => StageRunHandle;
	runChecks: (options: {
		cwd: string;
		commands: string[];
		signal: AbortSignal;
	}) => Promise<CheckResult[]>;
	newId: () => string;
	now: () => Date;
	env?: NodeJS.ProcessEnv;
	/** Called after every change to a task (the UI refreshes). */
	onChange?: (project: ProjectWorkflow, slug: string) => void;
	/** Called once when a model run has finished (usage recording). */
	onRunFinished?: (
		project: ProjectWorkflow,
		task: TaskRecord,
		run: TaskRun,
	) => void;
	/** How often live progress is written to task.json (ms). */
	progressSaveIntervalMs?: number;
}

interface LiveRun {
	project: ProjectWorkflow;
	slug: string;
	cancel: () => Promise<void>;
}

export class TaskController {
	private readonly live = new Map<string, LiveRun>();
	/** Settles when every run started so far has been handled (for tests). */
	private pending = new Set<Promise<unknown>>();

	constructor(private readonly deps: ControllerDeps) {}

	/** Wait until no run is in flight (tests and shutdown). */
	async idle(): Promise<void> {
		while (this.pending.size > 0) {
			await Promise.all([...this.pending]);
		}
	}

	/** Runs in progress, by run id (for the UI and shutdown). */
	liveRunIds(): string[] {
		return [...this.live.keys()];
	}

	/**
	 * App quit: kill every run's process tree (bounded wait). Their records
	 * stay "running" and are marked interrupted at the next start (recover).
	 */
	async shutdown(timeoutMs = 3000): Promise<void> {
		const kills = [...this.live.values()].map((live) =>
			live.cancel().catch(() => undefined),
		);
		await Promise.race([
			Promise.all(kills),
			new Promise((resolve) => setTimeout(resolve, timeoutMs)),
		]);
	}

	private track<T>(promise: Promise<T>): Promise<T> {
		this.pending.add(promise);
		void promise.finally(() => this.pending.delete(promise));
		return promise;
	}

	private changed(project: ProjectWorkflow, slug: string): void {
		this.deps.onChange?.(project, slug);
	}

	private load(project: ProjectWorkflow, slug: string): TaskRecord {
		const task = getTask(project, slug);
		if (!task) throw new Error(`Unknown task: ${slug}`);
		return task;
	}

	private approvedChecks(project: ProjectWorkflow): ApprovedChecks {
		const checks = loadProjectChecks(project);
		return { commands: checks.approvedAt ? checks.commands : [] };
	}

	/**
	 * After an app restart: runs that were in flight are marked interrupted
	 * and their tasks paused. Nothing is re-run automatically.
	 */
	recover(
		projects: ProjectWorkflow[],
		listSlugs: (p: ProjectWorkflow) => string[],
	): number {
		let recovered = 0;
		for (const project of projects) {
			for (const slug of listSlugs(project)) {
				const task = getTask(project, slug);
				if (!task) continue;
				let changed = false;
				for (const run of task.runs) {
					if (run.status === "running" || run.status === "queued") {
						run.status = "interrupted";
						run.failure = "interrupted";
						run.endedAt = this.deps.now().toISOString();
						run.error = "ADE stopped while this run was in progress";
						changed = true;
					}
				}
				if (changed) {
					task.state = "paused";
					task.stateReason =
						"ADE stopped while a run was in progress. Check the work, then resume.";
					saveTask(project, task);
					recovered++;
				}
			}
		}
		return recovered;
	}

	/** Start or continue a task in its mode (Auto advances; Manual waits). */
	start(project: ProjectWorkflow, slug: string): Promise<TaskRecord> {
		return withTaskLock(project, slug, () => {
			const task = this.load(project, slug);
			if (activeRun(task)) throw new Error("This task is already running");
			if (task.state === "done" || task.state === "cancelled") {
				throw new Error(`This task is ${task.state}`);
			}
			task.pauseRequested = false;
			if (task.mode === "manual") {
				task.state = "idle";
				task.stateReason = undefined;
				saveTask(project, task);
				return task;
			}
			return this.advance(project, task);
		});
	}

	/**
	 * Resume after a pause or block: the last failure is acknowledged (it may
	 * be retried once), then the task continues in its mode.
	 */
	resume(project: ProjectWorkflow, slug: string): Promise<TaskRecord> {
		return withTaskLock(project, slug, () => {
			const task = this.load(project, slug);
			if (activeRun(task)) throw new Error("This task is already running");
			if (task.state === "done" || task.state === "cancelled") {
				throw new Error(`This task is ${task.state}`);
			}
			const last = task.runs[task.runs.length - 1];
			if (last && last.status !== "succeeded") task.acknowledgedRunId = last.id;
			task.pauseRequested = false;
			task.state = "idle";
			task.stateReason = undefined;
			if (task.mode === "manual") {
				saveTask(project, task);
				return task;
			}
			return this.advance(project, task);
		});
	}

	/** Auto: finish the current run, then stop. */
	pause(project: ProjectWorkflow, slug: string): Promise<TaskRecord> {
		return withTaskLock(project, slug, () => {
			const task = this.load(project, slug);
			task.pauseRequested = true;
			if (!activeRun(task)) {
				task.state = "paused";
				task.stateReason = "Paused.";
			} else {
				task.stateReason = "Pausing after the current run.";
			}
			saveTask(project, task);
			this.changed(project, slug);
			return task;
		});
	}

	/** Stop the current run (and its child processes) and cancel the task. */
	async cancel(project: ProjectWorkflow, slug: string): Promise<TaskRecord> {
		const liveRuns = [...this.live.entries()].filter(
			([, live]) => live.project.key === project.key && live.slug === slug,
		);
		await withTaskLock(project, slug, () => {
			const task = this.load(project, slug);
			task.state = "cancelled";
			task.stateReason = "Cancelled.";
			task.pauseRequested = true;
			saveTask(project, task);
		});
		await Promise.all(liveRuns.map(([, live]) => live.cancel()));
		await this.idle();
		return this.load(project, slug);
	}

	setMode(
		project: ProjectWorkflow,
		slug: string,
		mode: "auto" | "manual",
	): Promise<TaskRecord> {
		return withTaskLock(project, slug, () => {
			const task = this.load(project, slug);
			task.mode = mode;
			saveTask(project, task);
			this.changed(project, slug);
			return task;
		});
	}

	answer(
		project: ProjectWorkflow,
		slug: string,
		answers: string,
	): Promise<TaskRecord> {
		return withTaskLock(project, slug, () => {
			const task = this.load(project, slug);
			const text = answers.trim();
			if (!text) throw new Error("Write an answer first");
			task.answers = text.slice(0, 10_000);
			if (task.state === "needs-input") {
				task.state = "idle";
				task.stateReason = undefined;
				if (task.mode === "auto" && !activeRun(task)) {
					return this.advance(project, task);
				}
			}
			saveTask(project, task);
			this.changed(project, slug);
			return task;
		});
	}

	/** Change a task's limits (e.g. raise its budget), then continue if Auto. */
	setLimits(
		project: ProjectWorkflow,
		slug: string,
		limits: Partial<TaskLimits>,
	): Promise<TaskRecord> {
		return withTaskLock(project, slug, () => {
			const task = this.load(project, slug);
			task.limits = { ...task.limits, ...limits };
			saveTask(project, task);
			this.changed(project, slug);
			return task;
		});
	}

	/**
	 * Explicitly move a task to another worktree (the user chose to continue it
	 * there). The change baseline is the new worktree's current state.
	 */
	adopt(
		project: ProjectWorkflow,
		slug: string,
		identity: TaskIdentity,
	): Promise<TaskRecord> {
		return withTaskLock(project, slug, () => {
			const task = this.load(project, slug);
			if (activeRun(task))
				throw new Error("Wait for the current run to finish");
			task.identity = identity;
			task.routeReasons = [
				...task.routeReasons,
				`moved to ${identity.worktreePath}${identity.branch ? ` (${identity.branch})` : ""}`,
			];
			saveTask(project, task);
			this.changed(project, slug);
			return task;
		});
	}

	/** Why a manual step may not run now, or undefined if it may. */
	static manualBlocker(
		task: TaskRecord,
		files: TaskFiles,
		checks: ApprovedChecks,
		kind: RunKind,
	): string | undefined {
		if (activeRun(task)) return "Another run of this task is in progress";
		if (task.state === "done" || task.state === "cancelled")
			return `The task is ${task.state}`;
		if (kind !== "checks" && taskSpend(task).usd >= task.limits.budgetUsd) {
			return "The task's budget is used up; raise it to continue";
		}
		const implemented = task.runs.some(
			(run) =>
				IMPLEMENTATION_KINDS.includes(run.kind) && run.status === "succeeded",
		);
		switch (kind) {
			case "build":
				return files.hasPlan ? undefined : "Build needs a plan first";
			case "review":
			case "checks":
				if (kind === "checks" && checks.commands.length === 0) {
					return "No approved check commands for this project";
				}
				return implemented ? undefined : "Nothing has been implemented yet";
			case "fix": {
				const failed =
					task.runs.some(
						(run) => run.kind === "review" && run.verdict === "FAIL",
					) ||
					task.runs.some(
						(run) =>
							run.kind === "checks" &&
							(run.checks ?? []).some((c) => c.exitCode !== 0 || c.timedOut),
					);
				return failed ? undefined : "There is no failed check or review to fix";
			}
			case "escalate":
				return files.openEscalations.length > 0
					? undefined
					: "There is no open escalation report";
			default:
				return undefined;
		}
	}

	/** Manual mode (or a paused Auto task): run exactly one step. */
	runStep(
		project: ProjectWorkflow,
		slug: string,
		kind: RunKind,
		modelOverride?: string,
	): Promise<TaskRecord> {
		return withTaskLock(project, slug, () => {
			const task = this.load(project, slug);
			const blocker = TaskController.manualBlocker(
				task,
				readTaskFiles(project, slug),
				this.approvedChecks(project),
				kind,
			);
			if (blocker) throw new Error(blocker);
			if (!existsSync(task.identity.worktreePath)) {
				throw new Error(
					`The task's worktree is gone: ${task.identity.worktreePath}`,
				);
			}
			if (
				task.mode === "auto" &&
				!task.pauseRequested &&
				task.state !== "paused" &&
				task.state !== "blocked"
			) {
				throw new Error(
					"Pause the task, or switch it to Manual, to run a single step",
				);
			}
			task.state = "idle";
			task.stateReason = undefined;
			if (kind === "checks") return this.launchChecks(project, task, false);
			return this.launchModel(project, task, kind, {
				modelOverride,
				continueAfter: false,
			});
		});
	}

	/** Decide and act. Caller holds the task lock. */
	private advance(project: ProjectWorkflow, task: TaskRecord): TaskRecord {
		if (!existsSync(task.identity.worktreePath)) {
			task.state = "blocked";
			task.stateReason = `The task's worktree is gone: ${task.identity.worktreePath}. Move the task to a worktree to continue.`;
			saveTask(project, task);
			this.changed(project, task.slug);
			return task;
		}
		const settings = this.deps.loadSettings();
		const decision = decideNext(
			task,
			readTaskFiles(project, task.slug),
			this.approvedChecks(project),
			settings,
		);
		switch (decision.type) {
			case "wait":
			case "none":
				saveTask(project, task);
				break;
			case "reroute":
				task.route = decision.route;
				task.routeReasons = [
					...task.routeReasons,
					`rerouted: ${decision.reason}`,
				];
				saveTask(project, task);
				return this.advance(project, task);
			case "run":
				return this.launchModel(project, task, decision.kind, {
					fallbackFrom: decision.fallbackFrom,
					continueAfter: true,
				});
			case "checks":
				return this.launchChecks(project, task, true);
			case "done":
				task.state = "done";
				task.stateReason = `Verified: ${decision.reason}.`;
				saveTask(project, task);
				break;
			case "pause":
				task.state = "paused";
				task.stateReason = decision.reason;
				saveTask(project, task);
				break;
			case "needs-input":
				task.state = "needs-input";
				task.stateReason = decision.reason;
				saveTask(project, task);
				break;
			case "block":
				task.state = "blocked";
				task.stateReason = decision.reason;
				saveTask(project, task);
				break;
		}
		this.changed(project, task.slug);
		return task;
	}

	private nextAttempt(task: TaskRecord, kind: RunKind): number {
		return task.runs.filter((run) => run.kind === kind).length + 1;
	}

	private launchModel(
		project: ProjectWorkflow,
		task: TaskRecord,
		kind: ModelStage,
		options: {
			modelOverride?: string;
			fallbackFrom?: string;
			continueAfter: boolean;
		},
	): TaskRecord {
		const settings = this.deps.loadSettings();
		const role =
			kind === "plan" && task.route === "exceptional"
				? "architect"
				: STAGE_ROLE[kind];
		const routing = settings.roles[role];
		const configured =
			options.modelOverride?.trim() ||
			(options.fallbackFrom
				? (cheaperFallback(options.fallbackFrom) ?? routing.model)
				: routing.model);
		const model = resolveRunModel(configured, {
			pin: settings.execution.pinModels,
			env: this.deps.env,
		}).model;

		const checks = this.approvedChecks(project);
		const mayRunChecks =
			settings.execution.permissions !== "edits" && checks.commands.length > 0;
		const permissionMode: PermissionMode =
			settings.execution.permissions === "bypass"
				? "bypassPermissions"
				: "acceptEdits";
		const allowedTools = [
			...(mayRunChecks ? checks.commands.map((c) => `Bash(${c}:*)`) : []),
			...(kind === "review" || kind === "plan" || kind === "escalate"
				? READ_ONLY_GIT
				: []),
		];
		const disallowedTools =
			kind === "review"
				? ["Write", "Edit", "MultiEdit", "NotebookEdit"]
				: kind === "plan"
					? ["Edit", "MultiEdit", "NotebookEdit"]
					: [];

		const files = readTaskFiles(project, task.slug);
		const prompt =
			stagePrompt({
				stage: kind,
				task,
				tasksDir: portablePath(project.tasksDir),
				checks: checks.commands,
				mayRunChecks,
				feedback: kind === "fix" ? correctionFeedback(task) : undefined,
				changes: kind === "review" ? taskChanges(task.identity) : undefined,
				escalationReport:
					kind === "escalate" && files.openEscalations[0]
						? `${portablePath(project.tasksDir)}/${task.slug}/escalations/${files.openEscalations[0]}`
						: undefined,
			}) +
			(task.answers
				? `\n\n## The user's answers to the plan's questions\n${task.answers}\n`
				: "");

		const spend = taskSpend(task);
		const remaining = Math.max(task.limits.budgetUsd - spend.usd, 0.01);
		const run: TaskRun = {
			id: this.deps.newId(),
			kind,
			status: "queued",
			attempt: this.nextAttempt(task, kind),
			queuedAt: this.deps.now().toISOString(),
			model,
			effort: routing.effort,
			maxTurns: routing.maxTurns,
			permissionMode,
			maxBudgetUsd: Number(remaining.toFixed(2)),
			sessionId: this.deps.newId(),
			fallbackFrom: options.fallbackFrom,
			costState: "pending",
		};
		task.runs.push(run);
		task.state = "running";
		task.stateReason = `${kind} on ${model}`;

		const command = this.deps.resolveClaude();
		if (!command) {
			Object.assign(run, {
				status: "failed",
				failure: "launch",
				error: "Claude Code (claude) was not found",
				endedAt: this.deps.now().toISOString(),
				costState: "unknown",
			});
			task.state = "blocked";
			task.stateReason = "Claude Code (claude) was not found";
			saveTask(project, task);
			this.changed(project, task.slug);
			return task;
		}

		let agentsJson: string | undefined;
		try {
			agentsJson = readFileSync(project.agentsFile, "utf8");
		} catch {
			agentsJson = undefined;
		}
		saveTask(project, task);

		let lastSave = 0;
		let handle: StageRunHandle;
		try {
			handle = this.deps.startRun(
				{
					command,
					cwd: task.identity.worktreePath,
					prompt,
					model,
					effort: routing.effort,
					maxTurns: routing.maxTurns,
					maxBudgetUsd: run.maxBudgetUsd,
					permissionMode,
					allowedTools,
					disallowedTools,
					addDirs: [portablePath(project.tasksDir)],
					agentsJson,
					sessionId: run.sessionId as string,
					env: this.deps.env,
				},
				(progress) => {
					const now = Date.now();
					if (now - lastSave < (this.deps.progressSaveIntervalMs ?? 2000))
						return;
					lastSave = now;
					void withTaskLock(project, task.slug, () => {
						const current = getTask(project, task.slug);
						const live = current?.runs.find((r) => r.id === run.id);
						if (!current || !live || live.status !== "running") return;
						live.liveCostUsd = progress.liveCostUsd;
						live.costState = progress.costState;
						live.observedModels = progress.observedModels;
						saveTask(project, current);
						this.changed(project, task.slug);
					});
				},
			);
		} catch (error) {
			Object.assign(run, {
				status: "failed",
				failure: "launch",
				error: error instanceof Error ? error.message : String(error),
				endedAt: this.deps.now().toISOString(),
				costState: "unknown",
			});
			task.state = "blocked";
			task.stateReason = `The ${kind} run could not start: ${run.error}`;
			saveTask(project, task);
			this.changed(project, task.slug);
			return task;
		}
		run.status = "running";
		run.startedAt = this.deps.now().toISOString();
		saveTask(project, task);
		this.changed(project, task.slug);

		this.live.set(run.id, { project, slug: task.slug, cancel: handle.cancel });
		this.track(
			handle.done.then((result) =>
				this.finishModelRun(
					project,
					task.slug,
					run.id,
					result,
					options.continueAfter,
				),
			),
		);
		return task;
	}

	/**
	 * Record a finished model run. Idempotent: an event for a run that is not
	 * the task's running run (a duplicate, or a stale run) changes nothing.
	 */
	finishModelRun(
		project: ProjectWorkflow,
		slug: string,
		runId: string,
		result: StageRunResult,
		continueAfter: boolean,
	): Promise<TaskRecord | undefined> {
		this.live.delete(runId);
		return withTaskLock(project, slug, () => {
			const task = getTask(project, slug);
			const run = task?.runs.find((r) => r.id === runId);
			if (!task || !run || run.status !== "running") return task;

			run.endedAt = this.deps.now().toISOString();
			run.exitCode = result.exitCode;
			run.reportedCostUsd = result.reportedCostUsd;
			run.liveCostUsd = result.liveCostUsd;
			run.costState = result.costState;
			run.observedModels = result.observedModels;
			run.unpricedModels = result.unpricedModels.length
				? result.unpricedModels
				: undefined;
			run.summary = result.text;
			if (result.sessionId) run.sessionId = result.sessionId;
			try {
				this.deps.onRunFinished?.(project, task, run);
			} catch (error) {
				console.warn("[workflow] Recording a run's usage failed:", error);
			}

			if (task.state === "cancelled" || result.cancelled) {
				run.status = "cancelled";
				run.failure = "cancelled";
				saveTask(project, task);
				this.changed(project, slug);
				return task;
			}
			if (result.failure) {
				run.status = "failed";
				run.failure = result.failure;
				run.error = result.error;
			} else {
				run.status = "succeeded";
				if (run.kind === "review") run.verdict = parseVerdict(result.text);
			}

			if (task.mode === "manual" || !continueAfter) {
				task.state = run.status === "succeeded" ? "idle" : "blocked";
				task.stateReason =
					run.status === "succeeded"
						? `${run.kind} finished`
						: `${run.kind} failed: ${(run.error ?? run.failure ?? "").slice(0, 300)}`;
				saveTask(project, task);
				this.changed(project, slug);
				return task;
			}
			if (task.pauseRequested) {
				task.state = "paused";
				task.stateReason = "Paused.";
				saveTask(project, task);
				this.changed(project, slug);
				return task;
			}
			return this.advance(project, task);
		});
	}

	private launchChecks(
		project: ProjectWorkflow,
		task: TaskRecord,
		continueAfter: boolean,
	): TaskRecord {
		const checks = this.approvedChecks(project);
		const run: TaskRun = {
			id: this.deps.newId(),
			kind: "checks",
			status: "running",
			attempt: this.nextAttempt(task, "checks"),
			queuedAt: this.deps.now().toISOString(),
			startedAt: this.deps.now().toISOString(),
		};
		task.runs.push(run);
		task.state = "running";
		task.stateReason = "running the project's checks";
		saveTask(project, task);
		this.changed(project, task.slug);

		const abort = new AbortController();
		this.live.set(run.id, {
			project,
			slug: task.slug,
			cancel: async () => abort.abort(),
		});
		this.track(
			this.deps
				.runChecks({
					cwd: task.identity.worktreePath,
					commands: checks.commands,
					signal: abort.signal,
				})
				.catch((error): CheckResult[] => [
					{
						command: "(checks)",
						exitCode: null,
						timedOut: false,
						durationMs: 0,
						outputTail: String(error),
					},
				])
				.then((results) =>
					this.finishChecks(
						project,
						task.slug,
						run.id,
						results,
						abort.signal.aborted,
						continueAfter,
					),
				),
		);
		return task;
	}

	private finishChecks(
		project: ProjectWorkflow,
		slug: string,
		runId: string,
		results: CheckResult[],
		aborted: boolean,
		continueAfter: boolean,
	): Promise<TaskRecord | undefined> {
		this.live.delete(runId);
		return withTaskLock(project, slug, () => {
			const task = getTask(project, slug);
			const run = task?.runs.find((r) => r.id === runId);
			if (!task || !run || run.status !== "running") return task;
			run.endedAt = this.deps.now().toISOString();
			run.checks = results;
			if (aborted || task.state === "cancelled") {
				run.status = "cancelled";
				run.failure = "cancelled";
				saveTask(project, task);
				this.changed(project, slug);
				return task;
			}
			// Failing checks are a recorded result, not a failed run.
			run.status = "succeeded";
			if (task.mode === "manual" || !continueAfter) {
				task.state = "idle";
				task.stateReason = checksPassed(results, results.length)
					? "checks passed"
					: "checks failed";
				saveTask(project, task);
				this.changed(project, slug);
				return task;
			}
			if (task.pauseRequested) {
				task.state = "paused";
				task.stateReason = "Paused.";
				saveTask(project, task);
				this.changed(project, slug);
				return task;
			}
			return this.advance(project, task);
		});
	}
}
