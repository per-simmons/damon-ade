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
	onCreate: (input: {
		description: string;
		route?: Route;
		mode: Mode;
		useHistory: boolean;
		/** "auto", "none", or a specialist id. */
		specialist: string;
		/** Let a short AI run choose the pathway and models (Auto only). */
		aiRouting: boolean;
	}) => void;
	onStart: (slug: string) => void;
	onResume: (slug: string) => void;
	onPause: (slug: string) => void;
	onCancel: (slug: string) => void;
	onSetMode: (slug: string, mode: Mode) => void;
	onAnswer: (slug: string, answers: string) => void;
	onRunStep: (
		slug: string,
		kind: RunKind,
		model?: string,
		customRoleId?: string,
	) => void;
	/** Manual: change the task's specialist ("auto", "none" or an id). */
	onSetSpecialist: (slug: string, specialist: string) => void;
	onMoveHere: (slug: string) => void;
	onSetBudget: (slug: string, budgetUsd: number) => void;
	onOpenSession: (slug: string, runId: string) => void;
	onSaveChecks: (commands: string[]) => void;
	onDescriptionChange: (description: string) => void;
	/** Choose the task's history again from the project's current imports. */
	onRefreshHistory: (slug: string) => void;
	/** Stop using one conversation in this task. */
	onExcludeHistory: (slug: string, conversationId: string) => void;
	/** Run the task without project history. */
	onClearHistory: (slug: string) => void;
}

/** A team's specialists, for choosing one. */
export interface SpecialistOption {
	id: string;
	name: string;
	specialty: string;
}
