import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TaskHistory } from "main/lib/project-history/types";
import {
	classifyTask,
	slugForTask,
	type TaskRoute,
} from "shared/utils/task-routing";
import type { ProjectWorkflow } from "./project-workflow";
import type { TaskRoleOverrides } from "./specialists";
import type { TriageDecision } from "./triage";

/**
 * Tasks of one project, stored in its workflow folder (project-workflow.ts).
 * task.json is ADE's record: mode, state, where the task runs, every run with
 * its outcome, and the counters that bound retries. plan.md, progress.md and
 * escalations/ are written by the agents; ADE treats them as inputs, never as
 * proof of completion.
 */

/** Stages that run a model. "fix" is a correction after failed checks/review. */
export const MODEL_STAGES = [
	"quick",
	"implement",
	"plan",
	"build",
	"fix",
	"review",
	"escalate",
	/** A specialist's custom role (see specialists.ts). */
	"custom",
	/** The AI pathway choice before an Auto task starts (see triage.ts). */
	"triage",
	/** A team request's Coordinator, which splits it into subtasks. */
	"split",
] as const;
export type ModelStage = (typeof MODEL_STAGES)[number];

/** Everything a run can be: a model stage, or ADE running the checks. */
export const RUN_KINDS = [...MODEL_STAGES, "checks"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/** Kept for callers of the first version; equals MODEL_STAGES. */
export const TASK_STAGES = MODEL_STAGES;
export type TaskStage = ModelStage;

export type ExecutionMode = "auto" | "manual";

export const RUN_STATUSES = [
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
	"blocked",
	"interrupted",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type TaskState =
	| "idle"
	| "running"
	| "paused"
	| "needs-input"
	| "blocked"
	| "done"
	| "failed"
	| "cancelled";

export interface CheckResult {
	command: string;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	/** Last part of the output. */
	outputTail: string;
}

export type CostState =
	| "pending"
	| "reported"
	| "estimated"
	| "partial"
	| "unknown";

export interface TaskRun {
	id: string;
	kind: RunKind;
	status: RunStatus;
	/** Attempt number of this kind within the task (1-based). */
	attempt: number;
	queuedAt: string;
	startedAt?: string;
	endedAt?: string;
	/** Model passed to the CLI, and the one the run reported using. */
	model?: string;
	observedModels?: string[];
	effort?: string;
	maxTurns?: number;
	permissionMode?: string;
	maxBudgetUsd?: number;
	sessionId?: string;
	/** Set when this run is a cheaper-model retry of an unavailable model. */
	fallbackFrom?: string;
	exitCode?: number | null;
	/** Cost Claude Code reported for the run (includes its subagents). */
	reportedCostUsd?: number;
	/** ADE's running estimate from streamed usage, while and after it runs. */
	liveCostUsd?: number;
	costState?: CostState;
	unpricedModels?: string[];
	/** Machine-readable reason a run did not succeed. */
	failure?:
		| "launch"
		| "model-unavailable"
		| "rate-limited"
		| "auth"
		| "max-turns"
		| "budget"
		| "timeout"
		| "cancelled"
		| "error"
		| "interrupted";
	error?: string;
	/** The workflow role that ran (e.g. "Reviewer", or a custom role's name). */
	role?: string;
	/** The specialist whose configuration the run used. */
	specialist?: string;
	/** Set when the environment overrides the requested effort. */
	effortNote?: string;
	/** For a custom-role run: which role, and whether it could edit files. */
	customRoleId?: string;
	customAccess?: "read-only" | "edit";
	/** Reviewer verdict, parsed from the review run's final text. */
	verdict?: "PASS" | "FAIL";
	/** Checks run by ADE (kind "checks"). */
	checks?: CheckResult[];
	/** The exact approved commands a checks run ran (kind "checks"). */
	commands?: string[];
	/**
	 * The worktree's code state (identity.ts codeState) when the run ended.
	 * Check and review results count only while the code is unchanged.
	 */
	codeState?: string;
	/** The run's final text, trimmed. */
	summary?: string;
}

/** Where the task runs, and the state of the tree when it was created. */
export interface TaskIdentity {
	workspaceId: string;
	worktreePath: string;
	branch?: string;
	/** HEAD when the task was created; the task's changes are relative to it. */
	baselineHead?: string;
	/** Files already changed when the task was created: path -> content hash. */
	baselineDirty: Record<string, string>;
}

export interface TaskLimits {
	budgetUsd: number;
	maxCorrections: number;
	maxReviewRounds: number;
	maxEscalations: number;
}

export interface TaskRecord {
	version: 2;
	slug: string;
	title: string;
	description: string;
	route: TaskRoute;
	/** How the route was chosen: the router's reasons, or "chosen by you". */
	routeReasons: string[];
	createdAt: string;
	mode: ExecutionMode;
	state: TaskState;
	/** Why the task is paused, blocked, failed or needs input. */
	stateReason?: string;
	/** Auto mode: do not start another run (set by Pause). */
	pauseRequested?: boolean;
	/** The user's answers to the plan's questions. */
	answers?: string;
	/**
	 * A failed run the user resumed past: its failure no longer blocks, and
	 * the stage may be tried again.
	 */
	acknowledgedRunId?: string;
	identity: TaskIdentity;
	limits: TaskLimits;
	runs: TaskRun[];
	/**
	 * Index of the first run that counts as evidence. Set when the task moves
	 * to another worktree or branch: earlier runs stay as history (and in the
	 * spend), but the work must be reconciled and verified again.
	 */
	evidenceStart?: number;
	/** Explicit moves between worktrees or branches. */
	moves?: Array<{ at: string; from: string; to: string }>;
	/**
	 * Earlier conversations this task draws on (excerpts in history.md in the
	 * task folder). Absent when the task was created without history.
	 */
	history?: TaskHistory;
	/** The specialist whose instructions and role settings the task uses. */
	specialistId?: string;
	/** Other specialists whose guidance the task also gets (one writer). */
	supportingSpecialistIds?: string[];
	/** Why Auto chose them, or "chosen by you". */
	specialistReason?: string;
	/** Role settings for this task only (they override the specialist's). */
	roleOverrides?: TaskRoleOverrides;
	/** "ai": a triage run chooses the pathway before the work starts. */
	routeBy?: "ai" | "rules" | "user";
	/** The AI pathway choice, once made (or why ADE's rules were used). */
	triage?: TriageDecision;
	/** A team request: split into subtasks for the team's specialists. */
	isRequest?: boolean;
	/** For a team request: its subtasks, in the order they run. */
	subtaskSlugs?: string[];
	/** For a team request: the Coordinator's reason for the split. */
	splitReason?: string;
	/** For a subtask: the team request it belongs to. */
	parentSlug?: string;
}

const MAX_DESCRIPTION_LENGTH = 20_000;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function taskDir(project: ProjectWorkflow, slug: string): string {
	return join(project.tasksDir, slug);
}

function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

interface LegacyLaunch {
	stage: ModelStage;
	at: string;
	model: string;
	runtime: string;
	sessionId?: string;
}

/** Read task.json, upgrading a first-version record in memory. */
function readTask(
	project: ProjectWorkflow,
	slug: string,
): TaskRecord | undefined {
	let raw: Partial<TaskRecord> & { stages?: LegacyLaunch[] };
	try {
		raw = JSON.parse(
			readFileSync(join(taskDir(project, slug), "task.json"), "utf8"),
		);
	} catch {
		return undefined;
	}
	if (raw.version === 2) return raw as TaskRecord;
	// First version: launches were recorded without outcomes.
	return {
		version: 2,
		slug: raw.slug ?? slug,
		title: raw.title ?? slug,
		description: raw.description ?? "",
		route: raw.route ?? "implement",
		routeReasons: raw.routeReasons ?? [],
		createdAt: raw.createdAt ?? new Date(0).toISOString(),
		mode: "manual",
		state: "paused",
		stateReason:
			"Created before ADE tracked runs; check the work, then resume.",
		identity: {
			workspaceId: "",
			worktreePath: project.root,
			baselineDirty: {},
		},
		limits: {
			budgetUsd: 10,
			maxCorrections: 2,
			maxReviewRounds: 3,
			maxEscalations: 2,
		},
		runs: (raw.stages ?? []).map((launch, index) => ({
			id: `legacy-${index + 1}`,
			kind: launch.stage,
			status: "interrupted" as const,
			attempt: 1,
			queuedAt: launch.at,
			model: launch.model,
			sessionId: launch.sessionId,
			failure: "interrupted" as const,
			error: "Launched in a terminal before ADE tracked outcomes",
		})),
	};
}

export function getTask(
	project: ProjectWorkflow,
	slug: string,
): TaskRecord | undefined {
	if (!SLUG.test(slug)) return undefined;
	return readTask(project, slug);
}

export function saveTask(project: ProjectWorkflow, task: TaskRecord): void {
	writeJsonAtomic(join(taskDir(project, task.slug), "task.json"), task);
}

export function createTask(
	project: ProjectWorkflow,
	input: {
		description: string;
		route?: TaskRoute;
		mode?: ExecutionMode;
		identity: TaskIdentity;
		limits: TaskLimits;
	},
	now: Date = new Date(),
): TaskRecord {
	const description = input.description.trim();
	if (!description) throw new Error("Describe the task first");
	if (description.length > MAX_DESCRIPTION_LENGTH) {
		throw new Error(
			`A task description is limited to ${MAX_DESCRIPTION_LENGTH} characters`,
		);
	}
	mkdirSync(project.tasksDir, { recursive: true });
	const existing = new Set(readdirSync(project.tasksDir));
	const slug = slugForTask(description, existing);
	const decision = classifyTask(description);
	const task: TaskRecord = {
		version: 2,
		slug,
		title: description.split("\n")[0].slice(0, 120),
		description,
		route: input.route ?? decision.route,
		routeReasons: input.route ? ["chosen by you"] : decision.reasons,
		createdAt: now.toISOString(),
		mode: input.mode ?? "auto",
		state: "idle",
		identity: input.identity,
		limits: input.limits,
		runs: [],
	};
	const dir = taskDir(project, slug);
	mkdirSync(join(dir, "escalations"), { recursive: true });
	writeFileSync(
		join(dir, "task.md"),
		`# ${task.title}\n\n${description}\n`,
		"utf8",
	);
	saveTask(project, task);
	return task;
}

/** All tasks of a project, newest first. */
export function listTaskRecords(project: ProjectWorkflow): TaskRecord[] {
	if (!existsSync(project.tasksDir)) return [];
	return readdirSync(project.tasksDir)
		.filter((slug) => SLUG.test(slug))
		.map((slug) => readTask(project, slug))
		.filter((task): task is TaskRecord => task !== undefined)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** What the agents have written in the task folder. */
export interface TaskFiles {
	hasPlan: boolean;
	/** plan.md has a non-empty "Questions for the user" section. */
	planQuestions: string[];
	progressStatus?: string;
	openEscalations: string[];
}

export function readTaskFiles(
	project: ProjectWorkflow,
	slug: string,
): TaskFiles {
	const dir = taskDir(project, slug);
	let plan = "";
	try {
		plan = readFileSync(join(dir, "plan.md"), "utf8");
	} catch {
		// No plan.
	}
	const questionsSection =
		plan.match(
			/^##\s*Questions for the user\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im,
		)?.[1] ?? "";
	const planQuestions = questionsSection
		.split("\n")
		.map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
		.filter((line) => line && !/^(none|n\/a|-)$/i.test(line));

	let progressStatus: string | undefined;
	try {
		progressStatus = readFileSync(join(dir, "progress.md"), "utf8").match(
			/^Status:\s*(.+?)\s*$/m,
		)?.[1];
	} catch {
		// No progress yet.
	}

	const openEscalations: string[] = [];
	try {
		for (const name of readdirSync(join(dir, "escalations")).sort()) {
			if (!name.endsWith(".md")) continue;
			const text = readFileSync(join(dir, "escalations", name), "utf8");
			if (!text.includes("## Resolution")) openEscalations.push(name);
		}
	} catch {
		// No escalations folder.
	}

	return {
		hasPlan: plan.trim().length > 0,
		planQuestions,
		progressStatus,
		openEscalations,
	};
}

/**
 * Serializes work on one task within this process: every state change runs
 * after the previous one finished, so clicks and run events cannot interleave.
 */
const taskQueues = new Map<string, Promise<unknown>>();

export function withTaskLock<T>(
	project: ProjectWorkflow,
	slug: string,
	fn: () => Promise<T> | T,
): Promise<T> {
	const key = `${project.key}/${slug}`;
	const previous = taskQueues.get(key) ?? Promise.resolve();
	const next = previous.then(fn, fn);
	taskQueues.set(
		key,
		next.catch(() => undefined),
	);
	return next;
}

export function activeRun(task: TaskRecord): TaskRun | undefined {
	return task.runs.find(
		(run) => run.status === "queued" || run.status === "running",
	);
}

export function countRuns(
	task: TaskRecord,
	kind: RunKind,
	status?: RunStatus,
): number {
	return task.runs.filter(
		(run) =>
			run.kind === kind && (status === undefined || run.status === status),
	).length;
}
