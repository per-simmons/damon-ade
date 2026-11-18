/**
 * Models offered in the ModelBar launch row. `runtime` maps to the agent
 * runtime / launch command (see AGENT_PRESET_COMMANDS); `iconName` is the
 * getPresetIcon key. Display labels are a product decision and live here rather
 * than deriving from AGENT_LABELS so the row reads the way the user asked
 * (e.g. the OpenAI mark for the Codex runtime).
 */
import type { AgentRuntime } from "@superset/local-db";

export interface ModelDescriptor {
	/** Agent runtime slug — drives the launch command. */
	runtime: AgentRuntime;
	/** getPresetIcon key. */
	iconName: string;
	/** Tooltip / display name. */
	label: string;
	/** Marked as the default model (subtle emphasis). */
	isDefault?: boolean;
}

export const MODEL_BAR_MODELS: ModelDescriptor[] = [
	{
		runtime: "claude",
		iconName: "claude",
		label: "Claude Code",
		isDefault: true,
	},
	{
		runtime: "codex",
		iconName: "codex",
		label: "Codex",
	},
];
