import { randomUUID } from "node:crypto";
import { AGENT_PROMPT_BASE_COMMANDS } from "@superset/shared/agent-command";
import {
	buildAgentInvokeCommand,
	type InvokeShellKind,
	isSafeCliToken,
	promptArgument,
} from "shared/utils/agent-invoke-command";
import { getInvokePromptDir, writeInvokePromptFile } from "../agent-invoke";
import { type ProjectWorkflow, portablePath } from "./project-workflow";
import { stagePrompt } from "./stage-prompts";
import {
	getTask,
	recordStageLaunch,
	type StageLaunch,
	type TaskRecord,
	type TaskStage,
} from "./tasks";
import type { RoleName, WorkflowSettings } from "./workflow-settings";

/**
 * Turns "run stage X of task Y" into the command ADE types into a terminal in
 * the project. The model is chosen here (the stage's role from settings, or
 * the user's override) and passed to the CLI, so the routing is what actually
 * runs. The Claude session id is pinned, so usage can be attributed to the
 * task exactly.
 */

/** Which role's model runs each stage. */
export const STAGE_ROLES: Record<TaskStage, RoleName> = {
	quick: "quick",
	implement: "implementer",
	plan: "planner",
	build: "implementer",
	review: "reviewer",
	escalate: "architect",
};

export type WorkflowRuntime = "claude" | "codex";

export interface StageLaunchPlan {
	stage: TaskStage;
	runtime: WorkflowRuntime;
	model: string;
	sessionId?: string;
	command: string;
	task: TaskRecord;
}

/** The model a stage runs on, before any override. */
export function stageModel(
	stage: TaskStage,
	task: Pick<TaskRecord, "route">,
	settings: WorkflowSettings,
): string {
	// "exceptional" tasks are planned by the strongest role (the architect).
	if (stage === "plan" && task.route === "exceptional") {
		return settings.roles.architect.model;
	}
	return settings.roles[STAGE_ROLES[stage]].model;
}

export function prepareStageLaunch(params: {
	homeDir: string;
	project: ProjectWorkflow;
	slug: string;
	stage: TaskStage;
	settings: WorkflowSettings;
	shell: InvokeShellKind;
	runtime: WorkflowRuntime;
	modelOverride?: string;
	now?: Date;
}): StageLaunchPlan {
	const task = getTask(params.project, params.slug);
	if (!task) throw new Error(`Unknown task: ${params.slug}`);

	const override = params.modelOverride?.trim();
	if (override && !isSafeCliToken(override)) {
		throw new Error("The model may contain only letters, digits and . _ - [ ]");
	}

	const prompt = stagePrompt({
		stage: params.stage,
		task,
		tasksDir: portablePath(params.project.tasksDir),
		canDelegate: params.runtime === "claude",
	});
	const promptFile = writeInvokePromptFile(
		getInvokePromptDir(params.homeDir),
		prompt,
	);

	let launch: StageLaunch;
	let command: string;
	if (params.runtime === "claude") {
		const model = override || stageModel(params.stage, task, params.settings);
		const sessionId = randomUUID();
		// Typed through ADE's claude wrapper, which adds the workflow roles
		// (--agents) and the task folder (--add-dir) for this project.
		command = buildAgentInvokeCommand({
			promptFile,
			shell: params.shell,
			model,
			claudeSessionId: sessionId,
			fresh: true,
		});
		launch = {
			stage: params.stage,
			at: (params.now ?? new Date()).toISOString(),
			model,
			runtime: "claude",
			sessionId,
		};
	} else {
		// Codex runs its configured model; there are no subagents to route.
		command = `${AGENT_PROMPT_BASE_COMMANDS.codex} ${promptArgument(promptFile, params.shell)}`;
		launch = {
			stage: params.stage,
			at: (params.now ?? new Date()).toISOString(),
			model: "codex",
			runtime: "codex",
		};
	}

	const updated = recordStageLaunch(params.project, task.slug, launch);
	return {
		stage: params.stage,
		runtime: params.runtime,
		model: launch.model,
		sessionId: launch.sessionId,
		command,
		task: updated,
	};
}
