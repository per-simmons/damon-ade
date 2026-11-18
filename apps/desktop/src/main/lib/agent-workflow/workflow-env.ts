import { ensureProjectWorkflow, portablePath } from "./project-workflow";

/**
 * Terminal environment for the multi-model workflow. A terminal belongs to a
 * project root (the project's main repo) or, for an ADE agent whose category
 * has no repo, to its own worktree. Any folder works; nothing in it changes.
 */

export const WORKFLOW_ENV = {
	projectKey: "SUPERSET_PROJECT_KEY",
	agentsFile: "SUPERSET_WORKFLOW_AGENTS",
	tasksDir: "SUPERSET_WORKFLOW_TASKS_DIR",
} as const;

export function workflowEnvFor(
	homeDir: string,
	project: { rootPath?: string; workspacePath?: string },
): Record<string, string> | null {
	const root = project.rootPath?.trim() || project.workspacePath?.trim();
	if (!root) return null;
	const workflow = ensureProjectWorkflow(homeDir, root);
	return {
		[WORKFLOW_ENV.projectKey]: workflow.key,
		[WORKFLOW_ENV.agentsFile]: portablePath(workflow.agentsFile),
		[WORKFLOW_ENV.tasksDir]: portablePath(workflow.tasksDir),
	};
}
