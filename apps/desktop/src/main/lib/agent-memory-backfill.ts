import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { workspaces } from "@superset/local-db";
import { isNotNull } from "drizzle-orm";
import { getAgentMemoryDir } from "./agent-home";
import { scaffoldAgentMemory } from "./agent-scaffold";
import { resolveAgentWorktreePath } from "./agent-worktree";
import { MEMORY_SCAFFOLD_ENABLED } from "./feature-flags";
import { localDb } from "./local-db";
import { getUserName } from "./user-profile";

/**
 * One-time backfill of the per-agent memory scaffold (docs/memory.md).
 *
 * Agents created while ADE_MEMORY_SCAFFOLD was OFF have a repo + an empty
 * memory/ dir but no canonical files or bridges. Now that the scaffold is
 * enabled by default we bring those agents up to spec at app launch.
 *
 * Conservative + idempotent by construction:
 * - Only touches ADE agents (workspaces.runtime set) whose repo is already set
 *   up (worktree/.git exists). A still-initializing or failed agent is left to
 *   its own init job.
 * - Skips any agent whose memory/ dir already holds a non-empty *.md file, so a
 *   scaffolded (or hand-authored) memory is never re-processed.
 * - Delegates to scaffoldAgentMemory, which is write-if-empty: even if it runs,
 *   it never overwrites a non-empty canonical file or an existing bridge.
 * - Per-agent try/catch so one bad agent never blocks the others or app launch.
 */
export function backfillAgentMemory(): void {
	if (!MEMORY_SCAFFOLD_ENABLED) return;

	let agents: Array<typeof workspaces.$inferSelect>;
	try {
		agents = localDb
			.select()
			.from(workspaces)
			.where(isNotNull(workspaces.runtime))
			.all();
	} catch (error) {
		console.error("[memory-backfill] Failed to list agents:", error);
		return;
	}

	const userName = getUserName();
	let scaffolded = 0;

	for (const agent of agents) {
		try {
			if (!agent.runtime || agent.deletingAt) continue;

			// Resolve the agent's REAL worktree from its DB row. The derived
			// <agent-home>/worktree is correct for the standard flow, but a
			// local-path agent's worktree is an external repo stored on its
			// worktrees row — using the derived path would skip it (no .git there)
			// and, worse, drop bridges into a non-existent dir. Fall back to the
			// derived path when the row has none.
			const worktreePath = resolveAgentWorktreePath(agent.id, agent.worktreeId);
			// Repo must already exist and be a git repo; this guard also filters
			// out any non-ADE workspace that happens to carry a runtime value.
			if (!existsSync(join(worktreePath, ".git"))) continue;

			if (!memoryDirIsEmpty(getAgentMemoryDir(agent.id))) continue;

			scaffoldAgentMemory({
				agentId: agent.id,
				agentName: agent.name || "Agent",
				runtime: agent.runtime,
				userName,
				worktreePath,
			});
			scaffolded++;
		} catch (error) {
			console.error(`[memory-backfill] Failed for ${agent.id}:`, error);
		}
	}

	if (scaffolded > 0) {
		console.log(
			`[memory-backfill] Scaffolded memory for ${scaffolded} agent(s).`,
		);
	}
}

/**
 * A memory dir "needs scaffolding" when it is missing or holds no non-empty
 * markdown file. Any non-empty *.md (AGENT/USER/MEMORY, the write-back
 * protocol, or a hand-written topic file) means the agent is already set up.
 */
function memoryDirIsEmpty(dir: string): boolean {
	if (!existsSync(dir)) return true;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return true;
	}
	for (const name of entries) {
		if (!name.endsWith(".md")) continue;
		try {
			if (statSync(join(dir, name)).size > 0) return false;
		} catch {
			// Unreadable entry — ignore and keep looking.
		}
	}
	return true;
}
