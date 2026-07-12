/**
 * Models offered in the ModelBar launch row. `runtime` maps to the agent
 * runtime / launch command (see AGENT_PRESET_COMMANDS); `iconName` is the
 * getPresetIcon key. Display labels are a product decision and live here rather
 * than deriving from AGENT_LABELS so the row reads the way the user asked
 * (e.g. the OpenAI mark for the Codex runtime).
 *
 * The OpenRouter-proxied runtimes (kimi, minimax, glm) require a bring-your-own
 * OpenRouter key before they can launch.
 */
import type { AgentRuntime } from "@superset/local-db";

export interface ModelDescriptor {
	/** Agent runtime slug — drives the launch command. */
	runtime: AgentRuntime;
	/** getPresetIcon key. */
	iconName: string;
	/** Tooltip / display name. */
	label: string;
	/** Needs a stored OpenRouter key before it can spawn. */
	needsOpenRouterKey: boolean;
	/** Marked as the default model (subtle emphasis). */
	isDefault?: boolean;
}

export const MODEL_BAR_MODELS: ModelDescriptor[] = [
	{
		runtime: "orchestrator",
		iconName: "orchestrator",
		label: "Orchestrator Router",
		needsOpenRouterKey: false,
		isDefault: true,
	},
	{
		runtime: "claude",
		iconName: "claude",
		label: "Claude",
		needsOpenRouterKey: false,
	},
	{
		runtime: "codex",
		iconName: "codex",
		label: "OpenAI",
		needsOpenRouterKey: false,
	},
	{
		runtime: "kimi",
		iconName: "kimi",
		label: "Kimi K2.7",
		needsOpenRouterKey: true,
	},
	{
		runtime: "minimax",
		iconName: "minimax",
		label: "MiniMax M3",
		needsOpenRouterKey: true,
	},
	{
		runtime: "glm",
		iconName: "glm",
		label: "GLM 5.2",
		needsOpenRouterKey: true,
	},
];
