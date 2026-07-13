import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntime } from "@superset/local-db";
import { workspaces, worktrees } from "@superset/local-db";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import { workspaceInitManager } from "main/lib/workspace-init-manager";
import { getAgentHome } from "./agent-home";
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
 * Retry context is held in-memory, with the repo source also persisted to a
 * sidecar file in the agent home. Without that, a retry after an app restart
 * would silently downgrade a clone into a fresh empty repo — the agent would
 * "lose" the codebase it was created for.
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

const INIT_SOURCE_FILE = ".init-source.json";

/** Persist the repo source so a cross-restart retry can still clone. */
function writeInitSource(agentId: string, source: AgentRepoSource): void {
	try {
		const agentHome = getAgentHome(agentId);
		mkdirSync(agentHome, { recursive: true });
		writeFileSync(
			join(agentHome, INIT_SOURCE_FILE),
			JSON.stringify(source),
			"utf8",
		);
	} catch (error) {
		console.warn(`[agent-init] Could not persist init source:`, error);
	}
}

function readInitSource(agentId: string): AgentRepoSource | null {
	try {
		const raw = readFileSync(
			join(getAgentHome(agentId), INIT_SOURCE_FILE),
			"utf8",
		);
		const parsed = JSON.parse(raw);
		if (parsed?.type === "init") return { type: "init" };
		if (parsed?.type === "clone" && typeof parsed.url === "string") {
			return { type: "clone", url: parsed.url };
		}
		return null;
	} catch {
		return null;
	}
}

export function isAgentInit(agentId: string): boolean {
	return contexts.has(agentId);
}

/** Start the background init job for a freshly-created agent. */
export function beginAgentInit(agentId: string, ctx: AgentInitContext): void {
	contexts.set(agentId, ctx);
	writeInitSource(agentId, ctx.source);
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
		ctx = {
			categoryId: workspace.projectId,
			worktreeId: workspace.worktreeId,
			agentName: workspace.name,
			runtime: workspace.runtime,
			// The sidecar keeps the original clone URL across restarts; only a
			// missing/corrupt sidecar degrades to a fresh init.
			source: readInitSource(agentId) ?? { type: "init" },
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
			ctx.source.type === "clone"
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
