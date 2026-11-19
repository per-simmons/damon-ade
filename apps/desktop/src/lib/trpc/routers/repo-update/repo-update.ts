import { TRPCError } from "@trpc/server";
import { listTaskRecords } from "main/lib/agent-workflow";
import { pathKey } from "main/lib/project-history";
import { fastForward, remoteStatus } from "main/lib/repo-update";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import {
	defaultWorkflowRouterDeps,
	type WorkspaceContext,
} from "../workflow/workflow";

/**
 * "Update from GitHub" for a workspace's checkout: how far behind its
 * remote branch it is, and a fast-forward-only update (see
 * main/lib/repo-update). An update waits while an ADE task is running in the
 * same worktree, so a run never sees its files change underneath it.
 */

export interface RepoUpdateRouterDeps {
	resolveWorkspace: (workspaceId: string) => WorkspaceContext;
}

function guarded<T>(fn: () => T): T {
	try {
		return fn();
	} catch (error) {
		if (error instanceof TRPCError) throw error;
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export const createRepoUpdateRouter = (
	deps: RepoUpdateRouterDeps = {
		resolveWorkspace: defaultWorkflowRouterDeps.resolveWorkspace,
	},
) =>
	router({
		/** Behind/ahead counts against the upstream, fetching first if asked. */
		status: publicProcedure
			.input(z.object({ workspaceId: z.string(), fetch: z.boolean() }))
			.query(({ input }) =>
				guarded(() => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					return remoteStatus(ctx.worktreePath, { fetch: input.fetch });
				}),
			),

		update: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.mutation(({ input }) =>
				guarded(() => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					const here = pathKey(ctx.worktreePath);
					const running = listTaskRecords(ctx.project).find(
						(task) =>
							task.state === "running" &&
							pathKey(task.identity.worktreePath) === here,
					);
					if (running) {
						return {
							outcome: "blocked" as const,
							reason: `Task "${running.title}" is running in this worktree. Update after it finishes or pause it.`,
						};
					}
					return fastForward(ctx.worktreePath);
				}),
			),
	});
