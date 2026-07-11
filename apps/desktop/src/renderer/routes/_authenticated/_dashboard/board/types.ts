import type { AgentRuntime, SelectAgentTask } from "@superset/local-db";

export type BoardTask = SelectAgentTask;

/** Flattened agent option for assignment/dispatch (a workspace with a runtime). */
export interface BoardAgent {
	id: string;
	name: string;
	runtime: AgentRuntime | null;
	worktreePath: string;
	iconUrl: string | null;
	teamName: string;
}
