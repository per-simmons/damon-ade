import { ensureProjectWorkflow, portablePath } from "./project-workflow";
import { listSpecialists, resolveSpecialist } from "./specialists";
import { loadWorkflowSettings } from "./workflow-settings";

/**
 * Terminal environment for the multi-model workflow. A terminal belongs to a
 * project root (the project's main repo) or, for an ADE agent whose category
 * has no repo, to its own worktree. Any folder works; nothing in it changes.
 */

export const WORKFLOW_ENV = {
	projectKey: "SUPERSET_PROJECT_KEY",
	agentsFile: "SUPERSET_WORKFLOW_AGENTS",
	tasksDir: "SUPERSET_WORKFLOW_TASKS_DIR",
	/** An agent's interactive Claude Code sessions: its specialist's model. */
	sessionModel: "SUPERSET_SESSION_MODEL",
	sessionEffort: "SUPERSET_SESSION_EFFORT",
} as const;

export function workflowEnvFor(
	homeDir: string,
	project: { rootPath?: string; workspacePath?: string; workspaceId?: string },
): Record<string, string> | null {
	const root = project.rootPath?.trim() || project.workspacePath?.trim();
	if (!root) return null;
	const workflow = ensureProjectWorkflow(homeDir, root);
	return {
		[WORKFLOW_ENV.projectKey]: workflow.key,
		[WORKFLOW_ENV.agentsFile]: portablePath(workflow.agentsFile),
		[WORKFLOW_ENV.tasksDir]: portablePath(workflow.tasksDir),
		...sessionModelEnv(homeDir, workflow, project.workspaceId),
	};
}

/**
 * The model an agent's own Claude Code sessions use: the Implementer of the
 * specialist the agent owns (the agent doing the work). The team's own
 * folder and agents without a specialty keep Claude Code's default.
 */
export function sessionModelEnv(
	homeDir: string,
	workflow: ReturnType<typeof ensureProjectWorkflow>,
	workspaceId: string | undefined,
): Record<string, string> {
	if (!workspaceId) return {};
	const owned = listSpecialists(workflow).find(
		(s) => s.agentWorkspaceId === workspaceId,
	);
	if (!owned) return {};
	const role = resolveSpecialist(owned, loadWorkflowSettings(homeDir), homeDir)
		.roles.implementer;
	return {
		[WORKFLOW_ENV.sessionModel]: role.model,
		[WORKFLOW_ENV.sessionEffort]: role.effort,
	};
}
