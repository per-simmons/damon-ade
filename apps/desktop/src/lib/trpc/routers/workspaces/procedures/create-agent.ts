import { workspaces, worktrees } from "@superset/local-db";
import { getAgentWorktreePath } from "main/lib/agent-home";
import {
	agentBranchName,
	beginAgentInit,
	teamWorktreeSource,
} from "main/lib/agent-init";
import { localDb } from "main/lib/local-db";
import { v4 as uuidv4 } from "uuid";
import type { z } from "zod";
import { publicProcedure, router } from "../../..";
import {
	activateProject,
	getMaxWorkspaceTabOrder,
	getProject,
	setLastActiveWorkspace,
} from "../utils/db-helpers";
import { createAgentInput } from "./create-agent-input";

/**
 * ADE: create an Agent (a `workspaces` row) in a team. One team = one
 * repository: the agent inherits it and works in its own git worktree of
 * that repository at <agent-home>/worktree, on its own branch, so agents
 * never edit the same folder or create repositories of their own. The DB
 * rows are inserted immediately with a null gitStatus, then a BACKGROUND job
 * (beginAgentInit) creates the worktree + memory and streams progress to
 * WorkspaceInitializingView.
 */
/** Create an agent in a team (rows now, its worktree in the background). */
export function createAgentWorkspace(input: {
	projectId: string;
	name: string;
	role?: string;
	runtime: z.infer<typeof createAgentInput>["runtime"];
}) {
	const project = getProject(input.projectId);
	if (!project) {
		throw new Error(`Team ${input.projectId} not found`);
	}
	if (!project.mainRepoPath) {
		throw new Error(
			"This team has no repository yet. Choose the team's repository first (the team's header shows how).",
		);
	}

	const agentId = uuidv4();
	const worktreePath = getAgentWorktreePath(agentId);
	const branch = agentBranchName(input.name, agentId);

	// gitStatus is null until the init job completes, so the content
	// view shows the checklist (see workspace/$workspaceId/page.tsx
	// hasIncompleteInit) rather than a broken terminal.
	const worktree = localDb
		.insert(worktrees)
		.values({
			projectId: input.projectId,
			path: worktreePath,
			branch,
			baseBranch: branch,
			gitStatus: null,
		})
		.returning()
		.get();

	const maxTabOrder = getMaxWorkspaceTabOrder(input.projectId);
	const workspace = localDb
		.insert(workspaces)
		.values({
			id: agentId,
			projectId: input.projectId,
			worktreeId: worktree.id,
			type: "worktree",
			branch,
			name: input.name,
			runtime: input.runtime,
			isUnnamed: false,
			tabOrder: maxTabOrder + 1,
		})
		.returning()
		.get();

	activateProject(project);
	setLastActiveWorkspace(agentId);

	// Build the repo + memory scaffold in the background.
	beginAgentInit(agentId, {
		categoryId: input.projectId,
		worktreeId: worktree.id,
		agentName: input.name,
		role: input.role,
		runtime: input.runtime,
		source: teamWorktreeSource(project, branch),
	});

	return {
		workspace,
		worktreePath,
		worktreeId: worktree.id,
		isInitializing: true,
	};
}

export const createAgentProcedures = () => {
	return router({
		createAgent: publicProcedure
			.input(createAgentInput)
			.mutation(({ input }) => createAgentWorkspace(input)),
	});
};
