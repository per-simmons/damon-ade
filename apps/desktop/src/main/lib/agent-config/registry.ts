import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Registry mapping an agent name → its folder (cwd, where the agent runtime
 * reads CLAUDE.md + .claude/skills + MCP config), the ADE workspace that
 * surfaces its session, and a stable per-agent session id (so the
 * thread/memory accumulates across invocations).
 *
 * Lives at ~/agents/registry.json so it's editable without rebuilding the app.
 */
export interface AgentRegistryEntry {
	/** Absolute path to the agent's folder (its CLAUDE.md / skills / mcp). */
	cwd: string;
	/** The ADE workspace id that surfaces this agent's session. */
	workspaceId: string;
	/** Stable session id for this agent (persistent thread). */
	sessionId: string;
	/** Optional model override, e.g. "anthropic/claude-opus-4-5". */
	model?: string;
	/**
	 * Claude Code permission mode for invoked runs: "acceptEdits" (default),
	 * "default", "plan" or "bypassPermissions". The bypass is never implied.
	 */
	permissionMode?: string;
}

export type AgentRegistry = Record<string, AgentRegistryEntry>;

export const AGENT_REGISTRY_PATH = join(homedir(), "agents", "registry.json");

/** Reads the registry fresh (so edits apply without an app restart). */
export function loadAgentRegistry(): AgentRegistry {
	try {
		const raw = readFileSync(AGENT_REGISTRY_PATH, "utf8");
		const parsed = JSON.parse(raw) as AgentRegistry;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export function getAgentEntry(name: string): AgentRegistryEntry | undefined {
	const reg = loadAgentRegistry();
	return reg[name];
}

/**
 * Reverse lookup: find the agent whose ADE workspace matches `workspaceId`.
 * Used by the feed so "talking" in an agent's workspace routes to that agent.
 */
export function getAgentByWorkspaceId(
	workspaceId: string,
): { name: string; entry: AgentRegistryEntry } | undefined {
	const reg = loadAgentRegistry();
	for (const [name, entry] of Object.entries(reg)) {
		if (entry.workspaceId === workspaceId) return { name, entry };
	}
	return undefined;
}
