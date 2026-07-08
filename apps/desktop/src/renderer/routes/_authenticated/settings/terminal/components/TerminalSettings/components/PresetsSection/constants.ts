import {
	AGENT_PRESET_DESCRIPTIONS,
	AGENT_TYPES,
	getAgentPresetCommands,
} from "@superset/shared/agent-command";

export type AutoApplyField = "applyOnWorkspaceCreated" | "applyOnNewTab";

export interface PresetTemplate {
	name: string;
	preset: {
		name: string;
		description: string;
		cwd: string;
		commands: string[];
	};
}

/**
 * Suggested preset templates for the Settings UI. Platform-aware because the
 * OpenRouter runtimes' commands use shell-specific env-var syntax — a POSIX
 * template stored on Windows would fail in cmd/PowerShell.
 */
export function getPresetTemplates(windows: boolean): PresetTemplate[] {
	const commands = getAgentPresetCommands({ windows });
	return AGENT_TYPES.map((agent) => ({
		name: agent,
		preset: {
			name: agent,
			description: AGENT_PRESET_DESCRIPTIONS[agent],
			cwd: "",
			commands: commands[agent],
		},
	}));
}
