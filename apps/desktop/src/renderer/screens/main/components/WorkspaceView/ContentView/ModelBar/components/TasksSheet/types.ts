import type { ElectronRouterOutputs } from "renderer/lib/electron-trpc";

export type ProjectTasks = ElectronRouterOutputs["workflow"]["getProjectTasks"];
export type TaskView = ProjectTasks["tasks"][number];
export type RunView = TaskView["runs"][number];
export type RunKind = keyof TaskView["manualBlockers"];
export type ChecksView = ElectronRouterOutputs["workflow"]["getChecks"];
export type RoutePreview = ElectronRouterOutputs["workflow"]["classify"];

export type Route = "quick" | "implement" | "plan" | "exceptional";
export type Mode = "auto" | "manual";

/** Everything the panel can ask ADE to do. */
export interface TaskActions {
	busy: boolean;
	onCreate: (input: { description: string; route?: Route; mode: Mode }) => void;
	onStart: (slug: string) => void;
	onResume: (slug: string) => void;
	onPause: (slug: string) => void;
	onCancel: (slug: string) => void;
	onSetMode: (slug: string, mode: Mode) => void;
	onAnswer: (slug: string, answers: string) => void;
	onRunStep: (slug: string, kind: RunKind, model?: string) => void;
	onMoveHere: (slug: string) => void;
	onSetBudget: (slug: string, budgetUsd: number) => void;
	onOpenSession: (slug: string, runId: string) => void;
	onSaveChecks: (commands: string[]) => void;
	onDescriptionChange: (description: string) => void;
}
