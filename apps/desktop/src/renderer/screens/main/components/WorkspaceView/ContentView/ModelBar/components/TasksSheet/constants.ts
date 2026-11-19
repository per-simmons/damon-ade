import type { Route, RunKind } from "./types";

export const ROUTE_LABELS: Record<Route, string> = {
	quick: "Quick edit",
	implement: "Implement directly",
	plan: "Plan first",
	exceptional: "Exceptional (Fable plans)",
};

export const RUN_LABELS: Record<RunKind, string> = {
	quick: "Quick change",
	implement: "Implement",
	plan: "Plan",
	build: "Build",
	fix: "Fix",
	review: "Review",
	escalate: "Escalate",
	checks: "Run checks",
};

/** Manual steps each route offers, in order. */
export const ROUTE_STEPS: Record<Route, RunKind[]> = {
	quick: ["quick", "checks", "review", "fix", "escalate"],
	implement: ["implement", "checks", "review", "fix", "escalate"],
	plan: ["plan", "build", "checks", "review", "fix", "escalate"],
	exceptional: ["plan", "build", "checks", "review", "fix", "escalate"],
};

export const STATE_LABELS: Record<string, string> = {
	idle: "Ready",
	running: "Running",
	paused: "Paused",
	"needs-input": "Needs your answer",
	blocked: "Blocked",
	done: "Done (verified)",
	failed: "Failed",
	cancelled: "Cancelled",
};

export const MODEL_CHOICES = ["fable", "opus", "sonnet", "haiku"] as const;
export const BY_ROLE = "by-role";
export const AUTOMATIC = "automatic";
