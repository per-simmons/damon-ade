import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { listTaskRecords, type ProjectWorkflow } from "main/lib/agent-workflow";
import { pathKey, repoIdentity } from "main/lib/project-history";
import {
	connectRemote,
	fastForward,
	pushToUpstream,
	remoteStatus,
	syncWithRemote,
} from "main/lib/repo-update";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import {
	defaultWorkflowRouterDeps,
	type WorkspaceContext,
} from "../workflow/workflow";
import { execWithShellEnv } from "../workspaces/utils/shell-env";

/**
 * Keep a team's local repository and its GitHub repository the same.
 *
 * - Update: fetch and fast-forward (see main/lib/repo-update).
 * - Push: send local commits to the remote branch, never forced.
 * - Sync: both, in that order; anything that would need a merge, a rebase or
 *   discarding work is reported instead of done.
 * - Connect: add a GitHub repository as origin (it must be empty or share
 *   history), or create one with the gh CLI the user is signed in to.
 * - Keep in sync automatically: an opt-in per team, run by the app while it
 *   is open; it never runs while a task is working in the same folder.
 */

export interface RepoUpdateRouterDeps {
	resolveWorkspace: (workspaceId: string) => WorkspaceContext;
	runGh?: (args: string[], cwd: string) => Promise<string>;
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

/** A task running in this folder, which a pull must not change under it. */
function runningTaskIn(ctx: WorkspaceContext) {
	const here = pathKey(ctx.worktreePath);
	return listTaskRecords(ctx.project).find(
		(task) =>
			task.state === "running" && pathKey(task.identity.worktreePath) === here,
	);
}

function syncFile(project: ProjectWorkflow): string {
	return join(project.dir, "sync.json");
}

function readAutoSync(project: ProjectWorkflow): boolean {
	try {
		return !!JSON.parse(readFileSync(syncFile(project), "utf8")).auto;
	} catch {
		return false;
	}
}

async function defaultRunGh(args: string[], cwd: string): Promise<string> {
	try {
		const { stdout } = await execWithShellEnv("gh", args, {
			cwd,
			timeout: 180_000,
		});
		return stdout;
	} catch (error) {
		const err = error as NodeJS.ErrnoException & { stderr?: string };
		if (err.code === "ENOENT") {
			throw new Error("The GitHub CLI (gh) is not installed.");
		}
		const detail = (err.stderr ?? err.message ?? "").trim().split("\n")[0];
		throw new Error(
			/auth|login|token/i.test(detail)
				? "The GitHub CLI is not signed in (run `gh auth login`)."
				: `GitHub CLI failed: ${detail}`,
		);
	}
}

export const createRepoUpdateRouter = (
	deps: RepoUpdateRouterDeps = {
		resolveWorkspace: defaultWorkflowRouterDeps.resolveWorkspace,
	},
) => {
	const runGh = deps.runGh ?? defaultRunGh;
	const blockedByTask = (ctx: WorkspaceContext, verb: string) => {
		const running = runningTaskIn(ctx);
		return running
			? {
					outcome: "blocked" as const,
					reason: `Task "${running.title}" is running in this worktree. ${verb} after it finishes or pause it.`,
				}
			: null;
	};

	return router({
		/** Ahead/behind counts against the upstream, fetching first if asked. */
		status: publicProcedure
			.input(z.object({ workspaceId: z.string(), fetch: z.boolean() }))
			.query(({ input }) =>
				guarded(() => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					const status = remoteStatus(ctx.worktreePath, { fetch: input.fetch });
					const identity = repoIdentity(ctx.worktreePath);
					return {
						...status,
						remote: identity.remote ?? null,
						remoteUrl: identity.remoteUrl ?? null,
						autoSync: readAutoSync(ctx.project),
					};
				}),
			),

		update: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.mutation(({ input }) =>
				guarded(() => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					return blockedByTask(ctx, "Update") ?? fastForward(ctx.worktreePath);
				}),
			),

		push: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.mutation(({ input }) =>
				guarded(() =>
					pushToUpstream(deps.resolveWorkspace(input.workspaceId).worktreePath),
				),
			),

		/** Pull (fast-forward) then push, so both sides end up the same. */
		sync: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.mutation(({ input }) =>
				guarded(() => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					const blocked = blockedByTask(ctx, "Sync");
					if (blocked) {
						return {
							pull: blocked,
							push: { outcome: "up-to-date" as const },
							inSync: false,
						};
					}
					return syncWithRemote(ctx.worktreePath);
				}),
			),

		/** Connect this repository to an existing GitHub repository. */
		connect: publicProcedure
			.input(
				z.object({ workspaceId: z.string(), url: z.string().min(1).max(500) }),
			)
			.mutation(({ input }) =>
				guarded(() => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					return connectRemote(ctx.project.root, input.url);
				}),
			),

		/**
		 * Create a GitHub repository from this one and push it, with the gh
		 * CLI the user is signed in to. Publishes the code, so the UI asks
		 * first and the user chooses private or public.
		 */
		createOnGitHub: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					name: z
						.string()
						.min(1)
						.max(100)
						.regex(
							/^[A-Za-z0-9._-]+$/,
							"Use letters, numbers, dots, dashes or underscores",
						),
					visibility: z.enum(["private", "public"]),
				}),
			)
			.mutation(async ({ input }) => {
				const ctx = deps.resolveWorkspace(input.workspaceId);
				const root = ctx.project.root;
				if (repoIdentity(root).remote) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "This repository is already connected to a remote",
					});
				}
				try {
					await runGh(
						[
							"repo",
							"create",
							input.name,
							`--${input.visibility}`,
							"--source",
							root,
							"--remote",
							"origin",
							"--push",
						],
						root,
					);
				} catch (error) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: error instanceof Error ? error.message : String(error),
					});
				}
				return { remote: repoIdentity(root).remote ?? null };
			}),

		/** Keep this team in sync automatically while ADE is open. */
		setAutoSync: publicProcedure
			.input(z.object({ workspaceId: z.string(), auto: z.boolean() }))
			.mutation(({ input }) =>
				guarded(() => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					writeFileSync(
						syncFile(ctx.project),
						`${JSON.stringify({ auto: input.auto }, null, 2)}\n`,
						"utf8",
					);
					return { auto: input.auto };
				}),
			),
	});
};
