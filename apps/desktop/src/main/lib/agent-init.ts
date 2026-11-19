import type { AgentRuntime } from "@superset/local-db";
import { projects, workspaces, worktrees } from "@superset/local-db";
import { toAgentType } from "@superset/shared/agent-command";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import { workspaceInitManager } from "main/lib/workspace-init-manager";
import { type AgentRepoSource, setupAgentRepo } from "./agent-repo";
import { scaffoldAgentMemory } from "./agent-scaffold";
import { resolveAgentWorktreePath } from "./agent-worktree";
import { MEMORY_SCAFFOLD_ENABLED } from "./feature-flags";
import { getUserName } from "./user-profile";

/**
 * ADE agent creation runs as a background job so a slow clone never blocks the
 * modal. createAgent inserts the DB rows immediately (worktree.gitStatus=null,
 * so the content view shows the checklist), then calls beginAgentInit(), which
 * builds the repo + memory scaffold while streaming progress through the shared
 * workspaceInitManager (the same channel WorkspaceInitializingView listens to).
 *
 * Retry context is held in-memory, consistent with workspaceInitManager's own
 * in-memory model (a documented cross-restart limitation). On a cross-restart
 * retry with no context we fall back to a fresh init.
 */

interface AgentInitContext {
	categoryId: string;
	worktreeId: string;
	agentName: string;
	/** Optional free-text role captured at creation; seeds the memory scaffold. */
	role?: string;
	runtime: AgentRuntime;
	source: AgentRepoSource;
}

const contexts = new Map<string, AgentInitContext>();

/** The branch a new agent of a team works on: ade/<name>-<short id>. */
export function agentBranchName(agentName: string, agentId: string): string {
	const slug =
		agentName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "agent";
	return `ade/${slug}-${agentId.slice(0, 6)}`;
}

/** Where a team agent's worktree starts: the team's base branch. */
export function teamWorktreeSource(
	team: {
		mainRepoPath: string;
		workspaceBaseBranch: string | null;
		defaultBranch: string | null;
	},
	branch: string,
): AgentRepoSource {
	return {
		type: "team",
		repoPath: team.mainRepoPath,
		branch,
		startPoint: team.workspaceBaseBranch || team.defaultBranch || "HEAD",
	};
}

export function isAgentInit(agentId: string): boolean {
	return contexts.has(agentId);
}

/** Start the background init job for a freshly-created agent. */
export function beginAgentInit(agentId: string, ctx: AgentInitContext): void {
	contexts.set(agentId, ctx);
	workspaceInitManager.clearJob(agentId);
	workspaceInitManager.startJob(agentId, ctx.categoryId);
	// Fire and forget — progress is streamed via workspaceInitManager.
	void runAgentInit(agentId);
}

/**
 * Retry a failed/interrupted agent init. Returns false if this is not an ADE
 * agent we can retry (caller should fall back to the legacy path).
 */
export function retryAgentInit(agentId: string): boolean {
	let ctx = contexts.get(agentId);
	if (!ctx) {
		// Cross-restart: reconstruct minimal context from the DB and re-init.
		const workspace = localDb
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, agentId))
			.get();
		if (!workspace?.worktreeId || !workspace.runtime) return false;
		const team = localDb
			.select()
			.from(projects)
			.where(eq(projects.id, workspace.projectId))
			.get();
		ctx = {
			categoryId: workspace.projectId,
			worktreeId: workspace.worktreeId,
			agentName: workspace.name,
			runtime: toAgentType(workspace.runtime),
			// A team's agent is a worktree of the team's repository; only a
			// repo-less legacy team's agent gets a repository of its own.
			source: team?.mainRepoPath
				? teamWorktreeSource(team, workspace.branch)
				: { type: "init" },
		};
		contexts.set(agentId, ctx);
	}
	workspaceInitManager.clearJob(agentId);
	workspaceInitManager.startJob(agentId, ctx.categoryId);
	void runAgentInit(agentId);
	return true;
}

async function runAgentInit(agentId: string): Promise<void> {
	const ctx = contexts.get(agentId);
	if (!ctx) return;

	try {
		workspaceInitManager.updateProgress(
			agentId,
			"creating_repo",
			ctx.source.type === "team"
				? "Creating the agent's worktree of the team repository..."
				: ctx.source.type === "clone"
					? "Cloning repository..."
					: "Creating repository...",
		);

		const { worktreePath, branch } = await setupAgentRepo({
			agentId,
			source: ctx.source,
		});
		workspaceInitManager.markWorktreeCreated(agentId);

		// Persist the resolved branch + path (a clone may not be on "main").
		localDb
			.update(worktrees)
			.set({ branch, path: worktreePath })
			.where(eq(worktrees.id, ctx.worktreeId))
			.run();
		localDb
			.update(workspaces)
			.set({ branch })
			.where(eq(workspaces.id, agentId))
			.run();

		workspaceInitManager.updateProgress(
			agentId,
			"scaffolding_memory",
			"Initializing memory files...",
		);
		// Memory scaffold (default ON — the revealed final state): write the
		// canonical memory/*.md files and the per-runtime bridges. Set
		// ADE_MEMORY_SCAFFOLD=false only as an escape hatch, in which case new
		// agents keep their repo + an empty memory/ dir (created by setupAgentRepo)
		// with no template files and no bridges.
		if (MEMORY_SCAFFOLD_ENABLED) {
			// Resolve the worktree from the DB (the source of truth we just
			// persisted) rather than assuming the derived path, so bridges land in
			// the real repo — including an external worktree for a local-path
			// agent. For the standard init/clone flows this equals the derived
			// path, so behavior is unchanged.
			scaffoldAgentMemory({
				agentId,
				agentName: ctx.agentName,
				role: ctx.role,
				runtime: ctx.runtime,
				userName: getUserName(),
				worktreePath: resolveAgentWorktreePath(agentId, ctx.worktreeId),
				// A worktree of the team's repository gets no ADE files.
				writeBridges: ctx.source.type !== "team",
			});
		}

		// A non-null gitStatus marks the worktree as set up so the content view
		// shows the terminal instead of "setup incomplete".
		localDb
			.update(worktrees)
			.set({
				gitStatus: {
					branch,
					needsRebase: false,
					ahead: 0,
					behind: 0,
					lastRefreshed: Date.now(),
				},
			})
			.where(eq(worktrees.id, ctx.worktreeId))
			.run();

		workspaceInitManager.updateProgress(agentId, "ready", "Ready");
		workspaceInitManager.finalizeJob(agentId);
		contexts.delete(agentId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[agent-init] Failed for ${agentId}:`, error);
		workspaceInitManager.updateProgress(
			agentId,
			"failed",
			"Agent setup failed",
			message,
		);
		workspaceInitManager.finalizeJob(agentId);
		// Keep the context so Retry can reuse the original repo source.
	}
}
