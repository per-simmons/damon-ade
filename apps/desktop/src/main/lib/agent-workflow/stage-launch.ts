import { isSafeCliToken } from "shared/utils/agent-invoke-command";
import { STAGE_ROLE } from "./controller";
import type { ModelStage, TaskRecord } from "./tasks";
import type { WorkflowSettings } from "./workflow-settings";

/**
 * Stage runs are managed by the controller (controller.ts) as child processes
 * of ADE. What remains for terminals: opening a run's Claude session so the
 * user can read it or continue it by hand. That interactive session is the
 * user's own, so ADE adds no permission bypass, budget or turn limit to it
 * (the UI says so).
 */

/** Kept for callers of the first version; see controller.ts. */
export const STAGE_ROLES = STAGE_ROLE;

/** The configured model of a stage, before pinning or overrides. */
export function stageModel(
	stage: ModelStage,
	task: Pick<TaskRecord, "route">,
	settings: WorkflowSettings,
): string {
	if (stage === "plan" && task.route === "exceptional") {
		return settings.roles.architect.model;
	}
	return settings.roles[STAGE_ROLE[stage]].model;
}

/** `claude --resume <session>`: open a run's session in a terminal. */
export function buildResumeCommand(sessionId: string): string {
	if (!isSafeCliToken(sessionId)) throw new Error("Invalid session id");
	return `claude --resume ${sessionId}`;
}
