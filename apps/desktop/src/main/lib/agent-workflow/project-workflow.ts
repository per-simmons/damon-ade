import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { buildAgentsDefinition } from "./agent-workflow";
import {
	loadWorkflowSettings,
	resolveSubagents,
	type WorkflowSettings,
} from "./workflow-settings";

/**
 * Per-project workflow state, kept by ADE outside the project:
 *
 *   <ADE home>/workflow/projects/<key>/
 *   ├── project.json   which folder this is
 *   ├── agents.json    the roles, as Claude Code `--agents` JSON
 *   └── tasks/<slug>/  task.json, task.md, plan.md, progress.md, escalations/
 *
 * Any folder opened in ADE gets one, whether or not ADE created it, and the
 * project's own files are never changed. The key is derived from the
 * project's root path, so reopening a project (or switching back to it)
 * finds the same plans and progress, and two projects never share them.
 */

export interface ProjectWorkflow {
	key: string;
	root: string;
	name: string;
	dir: string;
	tasksDir: string;
	agentsFile: string;
}

/** Paths written into prompts and shell commands use forward slashes. */
export function portablePath(path: string): string {
	return path.replace(/\\/g, "/");
}

function normalizeRoot(root: string): string {
	const resolved = resolve(root).replace(/[\\/]+$/, "");
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Stable, readable key for a project root: "<name>-<hash>". */
export function projectKeyFor(root: string): string {
	const normalized = normalizeRoot(root);
	const hash = createHash("sha256")
		.update(normalized)
		.digest("hex")
		.slice(0, 10);
	const name =
		basename(normalized)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "project";
	return `${name}-${hash}`;
}

export function workflowProjectsDir(homeDir: string): string {
	return join(homeDir, "workflow", "projects");
}

export function projectWorkflowFor(
	homeDir: string,
	root: string,
): ProjectWorkflow {
	const key = projectKeyFor(root);
	const dir = join(workflowProjectsDir(homeDir), key);
	return {
		key,
		root: resolve(root),
		name: basename(resolve(root)),
		dir,
		tasksDir: join(dir, "tasks"),
		agentsFile: join(dir, "agents.json"),
	};
}

function writeIfChanged(path: string, content: string): void {
	try {
		if (readFileSync(path, "utf8") === content) return;
	} catch {
		// Missing: write it.
	}
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path);
}

/** The `--agents` JSON for a project, from the current settings. */
export function renderAgentsJson(
	project: Pick<ProjectWorkflow, "tasksDir">,
	settings: WorkflowSettings,
): string {
	return `${JSON.stringify(
		buildAgentsDefinition(
			resolveSubagents(settings),
			portablePath(project.tasksDir),
		),
		null,
		2,
	)}\n`;
}

/**
 * Create or refresh a project's workflow folder. Cheap and idempotent: called
 * whenever a terminal opens in the project, so agents.json always reflects
 * the current settings.
 */
export function ensureProjectWorkflow(
	homeDir: string,
	root: string,
	settings: WorkflowSettings = loadWorkflowSettings(homeDir),
): ProjectWorkflow {
	const project = projectWorkflowFor(homeDir, root);
	mkdirSync(project.tasksDir, { recursive: true });
	writeIfChanged(
		join(project.dir, "project.json"),
		`${JSON.stringify({ key: project.key, root: project.root, name: project.name }, null, 2)}\n`,
	);
	writeIfChanged(project.agentsFile, renderAgentsJson(project, settings));
	return project;
}

/** Every project ADE has a workflow folder for. */
export function listWorkflowProjects(homeDir: string): ProjectWorkflow[] {
	const dir = workflowProjectsDir(homeDir);
	if (!existsSync(dir)) return [];
	const projects: ProjectWorkflow[] = [];
	for (const key of readdirSync(dir)) {
		try {
			const meta = JSON.parse(
				readFileSync(join(dir, key, "project.json"), "utf8"),
			) as { root?: unknown };
			if (typeof meta.root === "string") {
				projects.push(projectWorkflowFor(homeDir, meta.root));
			}
		} catch {
			// Not a project folder.
		}
	}
	return projects;
}

/** Re-render agents.json for every project (after the settings change). */
export function refreshAllProjectWorkflows(homeDir: string): number {
	const settings = loadWorkflowSettings(homeDir);
	const projects = listWorkflowProjects(homeDir);
	for (const project of projects) {
		writeIfChanged(project.agentsFile, renderAgentsJson(project, settings));
	}
	return projects.length;
}
