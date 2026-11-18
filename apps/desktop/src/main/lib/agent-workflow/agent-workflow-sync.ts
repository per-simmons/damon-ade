import { existsSync } from "node:fs";
import { join } from "node:path";
import { workspaces } from "@superset/local-db";
import { isNotNull } from "drizzle-orm";
import { resolveAgentWorktreePath } from "../agent-worktree";
import { MEMORY_SCAFFOLD_ENABLED } from "../feature-flags";
import { localDb } from "../local-db";
import { upgradeAgentWorkflow } from "./agent-workflow";

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
export function syncAgentWorkflowFiles(): void {
	if (!MEMORY_SCAFFOLD_ENABLED) return;

	let agents: Array<typeof workspaces.$inferSelect>;
	try {
		agents = localDb
			.select()
			.from(workspaces)
			.where(isNotNull(workspaces.runtime))
			.all();
	} catch (error) {
		console.error("[workflow-sync] Failed to list agents:", error);
		return;
	}

	let updated = 0;
	for (const agent of agents) {
		try {
			if (!agent.runtime || agent.deletingAt) continue;
			const worktreePath = resolveAgentWorktreePath(agent.id, agent.worktreeId);
			if (!existsSync(join(worktreePath, ".git"))) continue;

			const changes = upgradeAgentWorkflow(worktreePath);
			if (changes.length > 0) {
				updated++;
				console.log(
					`[workflow-sync] ${agent.id}: updated ${changes.join(", ")}`,
				);
			}
		} catch (error) {
			console.error(`[workflow-sync] Failed for ${agent.id}:`, error);
		}
	}

	if (updated > 0) {
		console.log(`[workflow-sync] Updated ${updated} agent(s).`);
	}
}
