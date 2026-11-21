import type { ElectronRouterOutputs } from "renderer/lib/electron-trpc";

export type ProjectTasks = ElectronRouterOutputs["workflow"]["getProjectTasks"];
export type TaskView = ProjectTasks["tasks"][number];
export type ChatMessageView = NonNullable<TaskView["chat"]>[number];
export type PlanView = NonNullable<ChatMessageView["plan"]>;

export const ROUTE_LABELS: Record<string, string> = {
	quick: "Quick edit",
	implement: "Implement directly",
	plan: "Plan first",
	exceptional: "Exceptional",
};

export const STATE_LABELS: Record<string, string> = {
	idle: "Waiting",
	running: "Running",
	paused: "Paused",
	"needs-input": "Needs you",
	blocked: "Blocked",
	done: "Done (verified)",
	failed: "Failed",
	cancelled: "Cancelled",
};
