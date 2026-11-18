import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	classifyTask,
	slugForTask,
	type TaskRoute,
} from "shared/utils/task-routing";
import type { ProjectWorkflow } from "./project-workflow";

/**
 * Tasks of one project, stored in its workflow folder (project-workflow.ts).
 * task.json is ADE's record (route, stages launched, which Claude session ran
 * each one); plan.md and progress.md are written by the agents.
 */

export const TASK_STAGES = [
	"quick",
	"implement",
	"plan",
	"build",
	"review",
	"escalate",
] as const;
export type TaskStage = (typeof TASK_STAGES)[number];

export interface StageLaunch {
	stage: TaskStage;
	at: string;
	model: string;
	runtime: "claude" | "codex";
	/** Claude session id ADE pinned with --session-id (claude runtime). */
	sessionId?: string;
}

export interface TaskRecord {
	slug: string;
	title: string;
	description: string;
	route: TaskRoute;
	/** How the route was chosen: the router's reasons, or "chosen by you". */
	routeReasons: string[];
	createdAt: string;
	stages: StageLaunch[];
}

export interface TaskSummary extends TaskRecord {
	/** From progress.md, else derived from the stages launched. */
	status: string;
	hasPlan: boolean;
	openEscalations: number;
	/** The stage the UI should offer next. */
	nextStage: TaskStage | null;
}

const MAX_DESCRIPTION_LENGTH = 20_000;

function taskDir(project: ProjectWorkflow, slug: string): string {
	return join(project.tasksDir, slug);
}

function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

function readTask(
	project: ProjectWorkflow,
	slug: string,
): TaskRecord | undefined {
	try {
		return JSON.parse(
			readFileSync(join(taskDir(project, slug), "task.json"), "utf8"),
		) as TaskRecord;
	} catch {
		return undefined;
	}
}

export function getTask(
	project: ProjectWorkflow,
	slug: string,
): TaskRecord | undefined {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return undefined;
	return readTask(project, slug);
}

export function createTask(
	project: ProjectWorkflow,
	input: { description: string; route?: TaskRoute },
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
		slug,
		title: description.split("\n")[0].slice(0, 120),
		description,
		route: input.route ?? decision.route,
		routeReasons: input.route ? ["chosen by you"] : decision.reasons,
		createdAt: now.toISOString(),
		stages: [],
	};
	const dir = taskDir(project, slug);
	mkdirSync(join(dir, "escalations"), { recursive: true });
	writeFileSync(
		join(dir, "task.md"),
		`# ${task.title}\n\n${description}\n`,
		"utf8",
	);
	writeJsonAtomic(join(dir, "task.json"), task);
	return task;
}

export function recordStageLaunch(
	project: ProjectWorkflow,
	slug: string,
	launch: StageLaunch,
): TaskRecord {
	const task = readTask(project, slug);
	if (!task) throw new Error(`Unknown task: ${slug}`);
	task.stages.push(launch);
	writeJsonAtomic(join(taskDir(project, slug), "task.json"), task);
	return task;
}

function openEscalations(dir: string): number {
	try {
		return readdirSync(join(dir, "escalations")).filter((name) => {
			if (!name.endsWith(".md")) return false;
			return !readFileSync(join(dir, "escalations", name), "utf8").includes(
				"## Resolution",
			);
		}).length;
	} catch {
		return 0;
	}
}

/** The stage to offer next, from the route and what has happened so far. */
export function nextStageFor(
	task: TaskRecord,
	status: string,
	hasPlan: boolean,
	escalations: number,
): TaskStage | null {
	const done = /^done\b/i.test(status);
	if (done) return null;
	if (escalations > 0 || /^blocked\b/i.test(status)) return "escalate";
	const launched = new Set(task.stages.map((s) => s.stage));
	if (task.route === "quick") return launched.has("quick") ? "review" : "quick";
	if (task.route === "implement") {
		return launched.has("implement") ? "review" : "implement";
	}
	if (!hasPlan) return "plan";
	if (!launched.has("build")) return "build";
	return "review";
}

export function summarizeTask(
	project: ProjectWorkflow,
	task: TaskRecord,
): TaskSummary {
	const dir = taskDir(project, task.slug);
	let status = "";
	try {
		status =
			readFileSync(join(dir, "progress.md"), "utf8").match(
				/^Status:\s*(.+?)\s*$/m,
			)?.[1] ?? "";
	} catch {
		// No progress yet.
	}
	if (!status) {
		const last = task.stages[task.stages.length - 1];
		status = last ? `${last.stage} started` : "new";
	}
	const hasPlan = existsSync(join(dir, "plan.md"));
	const escalations = openEscalations(dir);
	return {
		...task,
		status,
		hasPlan,
		openEscalations: escalations,
		nextStage: nextStageFor(task, status, hasPlan, escalations),
	};
}

/** All tasks of a project, newest first. */
export function listTasks(project: ProjectWorkflow): TaskSummary[] {
	if (!existsSync(project.tasksDir)) return [];
	return readdirSync(project.tasksDir)
		.map((slug) => readTask(project, slug))
		.filter((task): task is TaskRecord => task !== undefined)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
		.map((task) => summarizeTask(project, task));
}
