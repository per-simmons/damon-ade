import {
	AGENT_LABELS,
	getAgentPresetCommands,
} from "@superset/shared/agent-command";
import type { AgentRuntime, TerminalPreset } from "@superset/local-db";
import { useCallback } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsWithPresets } from "./useTabsWithPresets";

/** Minimal shape needed to spawn an agent's runtime CLI session. */
export interface AgentSessionWorkspace {
	id: string;
	runtime?: AgentRuntime | null;
	worktreePath?: string | null;
}

/**
 * Finds a user terminal preset that customizes an agent runtime's launch
 * command: a preset named "agent:<runtime>" or "agent:<label>" (case- and
 * whitespace-insensitive, e.g. "agent:claude" or "Agent: Claude"). Lets users
 * edit agent launch flags in Settings → Terminal without code changes.
 *
 * The explicit "agent:" prefix is deliberate — plain runtime names would
 * collide with the seeded default presets (settings seeds presets named
 * "claude", "codex", …), silently repurposing presets users edited for
 * ordinary terminal tabs.
 */
function findRuntimeOverridePreset(
	presets: TerminalPreset[] | undefined,
	runtime: AgentRuntime,
): TerminalPreset | undefined {
	if (!presets) return undefined;
	const targets = new Set(
		[runtime, AGENT_LABELS[runtime]]
			.filter(Boolean)
			.map((n) => `agent:${n.toLowerCase()}`),
	);
	return presets.find((p) => {
		if (!p.name || !p.commands?.length) return false;
		const normalized = p.name.trim().toLowerCase().replace(/\s+/g, " ");
		return targets.has(normalized.replace(/^agent:\s*/, "agent:"));
	});
}

/**
 * Spawns an agent's runtime CLI in a new terminal session tab.
 *
 * A "session" is just a normal terminal tab. Given an agent (workspace) with a
 * runtime, we build a synthetic TerminalPreset that launches the runtime's CLI
 * (via AGENT_PRESET_COMMANDS) in the agent's worktree and open it as a new tab.
 * A user preset named "agent:<runtime>" overrides the default launch command.
 * When the agent has no runtime we fall back to a plain shell tab.
 */
export function useAgentSession() {
	const { openPreset, addTab } = useTabsWithPresets();
	const utils = electronTrpc.useUtils();
	const { data: platform } = electronTrpc.window.getPlatform.useQuery();

	const spawnAgentSession = useCallback(
		async (workspace: AgentSessionWorkspace) => {
			const { id, runtime, worktreePath } = workspace;
			const cwd = worktreePath || undefined;

			if (!runtime) {
				// No runtime configured — open a plain shell in the worktree.
				return addTab(id, { initialCwd: cwd });
			}

			// The platform query can race the first auto-spawn on mount;
			// navigator.platform is available synchronously and reports "Win32"
			// in Electron renderers on Windows.
			const isWindows =
				platform !== undefined
					? platform === "win32"
					: navigator.platform.toLowerCase().startsWith("win");

			// Await the presets cache rather than reading a possibly-in-flight
			// query — otherwise an "agent:claude" override configured to drop
			// dangerous flags would be silently ignored on the first spawn.
			let presets: TerminalPreset[] | undefined;
			try {
				presets = await utils.settings.getTerminalPresets.ensureData();
			} catch {
				presets = undefined;
			}

			const override = findRuntimeOverridePreset(presets, runtime);
			const commands =
				override?.commands ??
				getAgentPresetCommands({ windows: isWindows })[runtime];

			const preset: TerminalPreset = {
				id: `agent-${runtime}`,
				name: AGENT_LABELS[runtime] ?? runtime,
				// The agent's worktree always wins over the override preset's cwd —
				// sessions must run inside the agent's own checkout.
				cwd: worktreePath ?? "",
				commands,
				executionMode: "new-tab",
			};

			return openPreset(id, preset, { target: "new-tab" });
		},
		[openPreset, addTab, utils, platform],
	);

	return { spawnAgentSession };
}
