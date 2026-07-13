import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { workspaces, worktrees } from "@superset/local-db";
import { getAgentHome, getAgentWorktreePath } from "main/lib/agent-home";
import { beginAgentInit, NEEDS_ONBOARDING_FILE } from "main/lib/agent-init";
import { localDb } from "main/lib/local-db";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { publicProcedure, router } from "../../..";
import {
	activateProject,
	getMaxWorkspaceTabOrder,
	getProject,
	setLastActiveWorkspace,
} from "../utils/db-helpers";
import { createAgentInput } from "./create-agent-input";

/**
 * ADE: create an Agent (a `workspaces` row) with its OWN standalone git repo.
 *
 * Unlike the shared-repo `create` procedure (`git worktree add` off the
 * project's mainRepoPath), an Agent owns a repo at <agent-home>/worktree. The
 * DB rows are inserted immediately with a null gitStatus, then a BACKGROUND job
 * (beginAgentInit) builds the repo + memory scaffold and streams progress to
 * WorkspaceInitializingView — a slow clone must never block this call. The
 * Agent's Category is the `projectId`; project.mainRepoPath is not read.
 */
export const createAgentProcedures = () => {
	return router({
		createAgent: publicProcedure
			.input(createAgentInput)
			.mutation(({ input }) => {
				const project = getProject(input.projectId);
				if (!project) {
					throw new Error(`Category ${input.projectId} not found`);
				}

				const agentId = uuidv4();
				const worktreePath = getAgentWorktreePath(agentId);
				// Placeholder branch; the init job resolves the real branch (a
				// clone may not be on "main") and updates these rows.
				const branch = "main";

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
					source: input.repo,
				});

				return {
					workspace,
					worktreePath,
					worktreeId: worktree.id,
					isInitializing: true,
				};
			}),

		// One-time repo onboarding for cloned agents: the marker is written by
		// the init job, read before the first auto-spawned session, and cleared
		// once that session launches with the onboarding prompt.
		needsOnboarding: publicProcedure
			.input(z.object({ id: z.string() }))
			.query(({ input }) => {
				return existsSync(join(getAgentHome(input.id), NEEDS_ONBOARDING_FILE));
			}),

		markOnboarded: publicProcedure
			.input(z.object({ id: z.string() }))
			.mutation(({ input }) => {
				rmSync(join(getAgentHome(input.id), NEEDS_ONBOARDING_FILE), {
					force: true,
				});
				return { success: true };
			}),
	});
};
