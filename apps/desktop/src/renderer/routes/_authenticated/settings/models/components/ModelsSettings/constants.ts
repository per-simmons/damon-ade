/** Mirrors ROLE_NAMES / EFFORT_LEVELS in main/lib/agent-workflow/workflow-settings. */
export const ROLES = [
	{
		name: "planner",
		label: "Planner",
		description: "Plans complex tasks before any code is written",
	},
	{
		name: "architect",
		label: "Architect",
		description: "Handles exceptional problems: blocked steps and escalations",
	},
	{
		name: "implementer",
		label: "Implementer",
		description: "Implements tasks and builds plans step by step",
	},
	{
		name: "quick",
		label: "Quick",
		description: "Small, fully specified edits",
	},
	{
		name: "reviewer",
		label: "Reviewer",
		description: "Checks finished work independently",
	},
] as const;

export type RoleName = (typeof ROLES)[number]["name"];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Claude Code model aliases; they resolve to the newest model of each tier. */
export const MODEL_ALIASES = [
	{ value: "fable", label: "Fable (most capable)" },
	{ value: "opus", label: "Opus" },
	{ value: "sonnet", label: "Sonnet" },
	{ value: "haiku", label: "Haiku (cheapest)" },
] as const;
