import type { AgentRuntime, TerminalPreset } from "@superset/local-db";
import {
	AGENT_LABELS,
	AGENT_PRESET_COMMANDS,
} from "@superset/shared/agent-command";
import { useCallback } from "react";
import { useTabsWithPresets } from "./useTabsWithPresets";

/** Minimal shape needed to spawn an agent's runtime CLI session. */
export interface AgentSessionWorkspace {
	id: string;
	runtime?: AgentRuntime | null;
	worktreePath?: string | null;
}

/** Optional per-launch overrides (e.g. a specific pi model variant). */
export interface AgentSessionOptions {
	/** Replaces the runtime's preset launch commands. */
	commands?: string[];
	/** Tab label override (defaults to the runtime's AGENT_LABELS entry). */
	label?: string;
}

/**
 * Spawns an agent's runtime CLI in a new terminal session tab.
 *
 * A "session" is just a normal terminal tab. Given an agent (workspace) with a
 * runtime, we build a synthetic TerminalPreset that launches the runtime's CLI
 * (via AGENT_PRESET_COMMANDS) in the agent's worktree and open it as a new tab.
 * When the agent has no runtime we fall back to a plain shell tab.
 */
export function useAgentSession() {
	const { openPreset, addTab } = useTabsWithPresets();

	const spawnAgentSession = useCallback(
		(workspace: AgentSessionWorkspace, options?: AgentSessionOptions) => {
			const { id, runtime, worktreePath } = workspace;
			const cwd = worktreePath || undefined;

			if (!runtime) {
				// No runtime configured — open a plain shell in the worktree.
				return addTab(id, { initialCwd: cwd });
			}

			const preset: TerminalPreset = {
				id: `agent-${runtime}`,
				name: options?.label ?? AGENT_LABELS[runtime] ?? runtime,
				cwd: worktreePath ?? "",
				commands: options?.commands ?? AGENT_PRESET_COMMANDS[runtime],
				executionMode: "new-tab",
			};

			return openPreset(id, preset, { target: "new-tab" });
		},
		[openPreset, addTab],
	);

	return { spawnAgentSession };
}
