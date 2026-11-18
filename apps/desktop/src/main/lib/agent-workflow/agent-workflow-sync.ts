import { existsSync } from "node:fs";
import { join } from "node:path";
import { workspaces } from "@superset/local-db";
import { isNotNull } from "drizzle-orm";
import { resolveAgentWorktreePath } from "../agent-worktree";
import { getSupersetHomeDir } from "../app-environment";
import { MEMORY_SCAFFOLD_ENABLED } from "../feature-flags";
import { localDb } from "../local-db";
import { upgradeAgentWorkflow, WORKFLOW_MAIN_MODEL } from "./agent-workflow";
import {
	applyRouting,
	loadWorkflowSettings,
	resolveSubagents,
	saveWorkflowSettings,
	workflowSettingsPath,
} from "./workflow-settings";

/**
 * Launch-time sync that brings agents created before the multi-model workflow
 * up to date (docs/plans/multi-model-workflow/plan.md, M2).
 *
 * Kept out of the module's index so the scaffold (which imports the workflow
 * templates) does not pull in the database.
 *
 * - Only touches ADE agents (workspaces.runtime set) that are not being
 *   deleted and whose worktree is already a git repo.
 * - upgradeAgentWorkflow is additive and idempotent: a second launch changes
 *   nothing, and user-edited files are never rewritten.
 * - Per-agent try/catch so one bad agent never blocks the others.
 *
 * Runs after backfillAgentMemory, so an agent the backfill just scaffolded is
 * already current and this is a no-op for it.
 */
export interface WorkflowSyncResult {
	agents: number;
	updated: number;
}

/**
 * Also applies model routing from <ADE home>/workflow-settings.json: unedited
 * role files get the configured model, effort and turn limit, and the main
 * session model follows the setting where it still holds ADE's last value.
 * Called at launch and after the settings page saves.
 */
export function syncAgentWorkflowFiles(
	homeDir: string = getSupersetHomeDir(),
): WorkflowSyncResult {
	const result: WorkflowSyncResult = { agents: 0, updated: 0 };
	if (!MEMORY_SCAFFOLD_ENABLED) return result;

	const settings = loadWorkflowSettings(homeDir);
	const subagents = resolveSubagents(settings);
	const previousMainModel = settings.appliedMainModel ?? WORKFLOW_MAIN_MODEL;

	let agents: Array<typeof workspaces.$inferSelect>;
	try {
		agents = localDb
			.select()
			.from(workspaces)
			.where(isNotNull(workspaces.runtime))
			.all();
	} catch (error) {
		console.error("[workflow-sync] Failed to list agents:", error);
		return result;
	}

	for (const agent of agents) {
		try {
			if (!agent.runtime || agent.deletingAt) continue;
			const worktreePath = resolveAgentWorktreePath(agent.id, agent.worktreeId);
			if (!existsSync(join(worktreePath, ".git"))) continue;

			result.agents++;
			const changes = [
				...upgradeAgentWorkflow(worktreePath, {
					subagents,
					mainModel: settings.mainModel,
				}),
				...applyRouting(worktreePath, settings, previousMainModel),
			];
			if (changes.length > 0) {
				result.updated++;
				console.log(
					`[workflow-sync] ${agent.id}: updated ${changes.join(", ")}`,
				);
			}
		} catch (error) {
			console.error(`[workflow-sync] Failed for ${agent.id}:`, error);
		}
	}

	// Remember which main model ADE has now written, so the next change can
	// tell ADE's value apart from one the user set by hand.
	if (
		settings.appliedMainModel !== settings.mainModel &&
		existsSync(workflowSettingsPath(homeDir))
	) {
		saveWorkflowSettings(homeDir, {
			...settings,
			appliedMainModel: settings.mainModel,
		});
	}

	if (result.updated > 0) {
		console.log(`[workflow-sync] Updated ${result.updated} agent(s).`);
	}
	return result;
}
