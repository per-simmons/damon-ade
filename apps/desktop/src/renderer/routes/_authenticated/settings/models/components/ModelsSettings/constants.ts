/** Mirrors ROLE_NAMES / EFFORT_LEVELS in main/lib/agent-workflow/workflow-settings. */
export const ROLES = [
	{
		name: "planner",
		label: "Planner",
		description: "Writes the plan before any code (/plan)",
	},
	{
		name: "architect",
		label: "Architect",
		description: "Unblocks escalations (/escalate)",
	},
	{
		name: "implementer",
		label: "Implementer",
		description: "Carries out the plan step by step (/build)",
	},
	{
		name: "quick",
		label: "Quick",
		description: "Small, fully specified edits",
	},
	{
		name: "reviewer",
		label: "Reviewer",
		description: "Checks the work against the plan (/review)",
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
