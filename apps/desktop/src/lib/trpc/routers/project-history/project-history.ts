import { existsSync } from "node:fs";
import { projects } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { type BrowserWindow, dialog } from "electron";
import {
	buildResumeCommand,
	ensureProjectWorkflow,
	portablePath,
} from "main/lib/agent-workflow";
import { getSupersetHomeDir } from "main/lib/app-environment";
import { localDb } from "main/lib/local-db";
import {
	type Association,
	entrypointLabel,
	getStored,
	importConversations,
	isWithin,
	type LoadedExport,
	listStored,
	listTranscripts,
	loadClaudeExport,
	loadTranscriptFile,
	matchRepository,
	moveStored,
	normalizeRemote,
	originStatus,
	pathKey,
	type RepoIdentity,
	readSession,
	refreshStored,
	removeStored,
	repoIdentity,
	type StoredConversation,
	sessionConversation,
	setIncluded,
	setScope,
	sourceLabel,
} from "main/lib/project-history";
import { claudeProjectsRoot } from "main/lib/usage-metrics/transcript";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import {
	defaultWorkflowRouterDeps,
	type WorkspaceContext,
} from "../workflow/workflow";
import { execWithShellEnv } from "../workspaces/utils/shell-env";

/**
 * Project history: link earlier conversations to an ADE project so its
 * tasks can draw on them (see main/lib/project-history).
 *
 * Sources, and what each can really do:
 * - Claude Code sessions (CLI, and the Claude desktop app's Code tab): read
 *   from their local transcripts and matched to this project by the git
 *   repository their folder belongs to. These can also be resumed natively.
 * - Claude app chats and Projects: only through the user's official data
 *   export; there is no API a personal account can list them with. Exports
 *   carry no repository information, so the user confirms the association.
 * - A single transcript file the user selects.
 * - GitHub: the user's repositories via the gh CLI they are already signed
 *   in to, to open an existing clone or clone one with the existing flow.
 *
 * Originals are only ever read. Every copy lives in this project's own
 * folder, so similar or unrelated projects never share history.
 */

type GhResult = { ok: true; stdout: string } | { ok: false; error: string };

export interface ProjectHistoryRouterDeps {
	resolveWorkspace: (workspaceId: string) => WorkspaceContext;
	homeDir: () => string;
	claudeRoot: () => string;
	pickPath: (kind: PickKind) => Promise<string | null>;
	runGh: (args: string[]) => Promise<GhResult>;
	listProjects: () => Array<{ id: string; name: string; mainRepoPath: string }>;
}

const PICK_KINDS = ["export-file", "export-folder", "transcript"] as const;
type PickKind = (typeof PICK_KINDS)[number];

function pickPathWith(getWindow: () => BrowserWindow | null) {
	return async (kind: PickKind): Promise<string | null> => {
		const window = getWindow();
		const options: Electron.OpenDialogOptions =
			kind === "export-folder"
				? {
						title: "Select the extracted Claude export folder",
						properties: ["openDirectory"],
					}
				: kind === "export-file"
					? {
							title: "Select a Claude data export",
							properties: ["openFile"],
							filters: [{ name: "Claude export", extensions: ["zip", "json"] }],
						}
					: {
							title: "Select a transcript",
							properties: ["openFile"],
							filters: [
								{
									name: "Transcripts",
									extensions: ["jsonl", "md", "markdown", "txt"],
								},
							],
						};
		const result = window
			? await dialog.showOpenDialog(window, options)
			: await dialog.showOpenDialog(options);
		return result.canceled || result.filePaths.length === 0
			? null
			: result.filePaths[0];
	};
}

async function runGhCli(args: string[]): Promise<GhResult> {
	try {
		const { stdout } = await execWithShellEnv("gh", args, { timeout: 30_000 });
		return { ok: true, stdout };
	} catch (error) {
		const err = error as NodeJS.ErrnoException & { stderr?: string };
		if (err.code === "ENOENT") {
			return {
				ok: false,
				error:
					"The GitHub CLI (gh) is not installed. Paste the repository URL instead.",
			};
		}
		const detail = (err.stderr ?? err.message ?? "").trim();
		return {
			ok: false,
			error: /auth|login|token/i.test(detail)
				? "The GitHub CLI is not signed in (run `gh auth login`). Paste the repository URL instead."
				: `GitHub CLI failed: ${detail.split("\n")[0]}`,
		};
	}
}

export const createDefaultProjectHistoryDeps = (
	getWindow: () => BrowserWindow | null,
): ProjectHistoryRouterDeps => ({
	resolveWorkspace: defaultWorkflowRouterDeps.resolveWorkspace,
	homeDir: getSupersetHomeDir,
	claudeRoot: () => claudeProjectsRoot(),
	pickPath: pickPathWith(getWindow),
	runGh: runGhCli,
	listProjects: () =>
		localDb
			.select({
				id: projects.id,
				name: projects.name,
				mainRepoPath: projects.mainRepoPath,
			})
			.from(projects)
			.all(),
});

function guarded<T>(fn: () => Promise<T> | T): Promise<T> {
	return Promise.resolve()
		.then(fn)
		.catch((error: unknown) => {
			if (error instanceof TRPCError) throw error;
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: error instanceof Error ? error.message : String(error),
			});
		});
}

const scopeInput = z.enum(["project", "worktree"]);

function scopeFor(kind: "project" | "worktree", ctx: WorkspaceContext) {
	return kind === "project"
		? ({ kind: "project" } as const)
		: ({ kind: "worktree", path: ctx.worktreePath } as const);
}

export const createProjectHistoryRouter = (deps: ProjectHistoryRouterDeps) => {
	/** Repository identity per folder, for one request. */
	const identities = () => {
		const cache = new Map<string, RepoIdentity>();
		return (folder: string) => {
			const key = pathKey(folder);
			let identity = cache.get(key);
			if (!identity) {
				identity = repoIdentity(folder);
				cache.set(key, identity);
			}
			return identity;
		};
	};

	function projectOf(workspaceId: string) {
		const ctx = deps.resolveWorkspace(workspaceId);
		const identity = repoIdentity(ctx.project.root);
		return { ctx, identity };
	}

	/** The last export previewed, so importing does not parse it twice. */
	let lastExport: LoadedExport | undefined;
	function exportAt(path: string): LoadedExport {
		if (lastExport?.exportPath !== path) lastExport = loadClaudeExport(path);
		return lastExport;
	}

	function describe(stored: StoredConversation, ctx: WorkspaceContext) {
		const origin = stored.origin;
		const status = originStatus(stored);
		return {
			id: stored.id,
			title: stored.title,
			kind: origin.kind,
			source: sourceLabel(stored),
			createdAt: stored.createdAt ?? null,
			updatedAt: stored.updatedAt ?? null,
			importedAt: stored.importedAt,
			refreshedAt: stored.refreshedAt ?? null,
			messageCount: stored.messages.length,
			included: stored.included,
			scope: stored.scope.kind,
			scopePath: stored.scope.kind === "worktree" ? stored.scope.path : null,
			/** Applies to this workspace's worktree. */
			inThisWorktree:
				stored.scope.kind === "project" ||
				pathKey(stored.scope.path) === pathKey(ctx.worktreePath),
			association: stored.association,
			status,
			projectName:
				origin.kind === "claude-export" ? (origin.projectName ?? null) : null,
			cwd: origin.kind === "claude-code" ? (origin.cwd ?? null) : null,
			branch: origin.kind === "claude-code" ? (origin.branch ?? null) : null,
			/** Native resume: a Claude Code session whose transcript and folder exist. */
			canResume:
				origin.kind === "claude-code" &&
				status !== "missing" &&
				!!origin.cwd &&
				existsSync(origin.cwd),
		};
	}

	return router({
		/** This project's repository identity and its imported conversations. */
		overview: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(({ input }) =>
				guarded(() => {
					const { ctx, identity } = projectOf(input.workspaceId);
					return {
						project: {
							name: ctx.project.name,
							root: ctx.project.root,
							worktreePath: ctx.worktreePath,
							isGitRepository: !!identity.commonDir,
							remote: identity.remote ?? null,
							remoteUrl: identity.remoteUrl ?? null,
						},
						conversations: listStored(ctx.project).map((c) => describe(c, ctx)),
					};
				}),
			),

		/**
		 * Claude Code sessions that ran in this repository (any of its
		 * worktrees, or another clone of the same remote). With showAll, the
		 * others too, each with the reason it does not match.
		 */
		listSessions: publicProcedure
			.input(z.object({ workspaceId: z.string(), showAll: z.boolean() }))
			.query(({ input }) =>
				guarded(() => {
					const { ctx, identity } = projectOf(input.workspaceId);
					const identityOf = identities();
					const imported = new Map(
						listStored(ctx.project)
							.filter((c) => c.origin.kind === "claude-code")
							.map((c) => [
								c.origin.kind === "claude-code" ? c.origin.sessionId : "",
								c,
							]),
					);
					const project = { root: ctx.project.root, identity };
					const sessions = [];
					let others = 0;
					for (const ref of listTranscripts(deps.claudeRoot())) {
						const match = ref.cwd
							? matchRepository(project, ref.cwd, identityOf(ref.cwd))
							: { association: null, reason: "No working folder recorded" };
						if (!match.association && !input.showAll) {
							others++;
							continue;
						}
						let summary: ReturnType<typeof readSession>["summary"];
						try {
							summary = readSession(ref.path).summary;
						} catch {
							continue;
						}
						if (summary.messageCount === 0) continue;
						const stored = imported.get(summary.sessionId);
						sessions.push({
							transcriptPath: ref.path,
							sessionId: summary.sessionId,
							title: summary.title,
							cwd: summary.cwd ?? null,
							branch: summary.branch ?? null,
							firstAt: summary.firstAt ?? null,
							lastAt: summary.lastAt ?? null,
							messageCount: summary.messageCount,
							source: entrypointLabel(summary.entrypoint),
							headless: summary.entrypoint === "sdk-cli",
							matches: !!match.association,
							reason: match.reason,
							importedId: stored?.id ?? null,
						});
					}
					sessions.sort((a, b) =>
						(b.lastAt ?? "").localeCompare(a.lastAt ?? ""),
					);
					return { sessions, otherCount: others };
				}),
			),

		importSessions: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					transcriptPaths: z.array(z.string()).min(1),
					scope: scopeInput,
					/** The user confirmed sessions from another repository. */
					confirmOtherRepository: z.boolean().default(false),
				}),
			)
			.mutation(({ input }) =>
				guarded(() => {
					const { ctx, identity } = projectOf(input.workspaceId);
					const root = deps.claudeRoot();
					const identityOf = identities();
					const items = [];
					const mismatched: string[] = [];
					for (const path of input.transcriptPaths) {
						// Only Claude Code's own transcripts, never arbitrary files.
						if (!isWithin(path, root) || !path.endsWith(".jsonl")) {
							throw new Error("Not a Claude Code session transcript");
						}
						const conversation = sessionConversation(path);
						const cwd =
							conversation.origin.kind === "claude-code"
								? conversation.origin.cwd
								: undefined;
						const match = matchRepository(
							{ root: ctx.project.root, identity },
							cwd,
							cwd ? identityOf(cwd) : undefined,
						);
						if (!match.association) mismatched.push(conversation.title);
						items.push({
							conversation,
							association: (match.association ??
								"user-confirmed") as Association,
						});
					}
					if (mismatched.length > 0 && !input.confirmOtherRepository) {
						throw new TRPCError({
							code: "CONFLICT",
							message: `${mismatched.length} session(s) ran outside this repository (${mismatched.slice(0, 3).join(", ")}). Confirm to associate them with ${ctx.project.name} anyway.`,
						});
					}
					return importConversations(ctx.project, items, {
						scope: scopeFor(input.scope, ctx),
						repository: { root: ctx.project.root, remote: identity.remote },
					});
				}),
			),

		pickPath: publicProcedure
			.input(z.object({ kind: z.enum(PICK_KINDS) }))
			.mutation(({ input }) => deps.pickPath(input.kind)),

		/** The chats in a Claude data export, for the user to choose from. */
		previewExport: publicProcedure
			.input(z.object({ workspaceId: z.string(), path: z.string() }))
			.query(({ input }) =>
				guarded(() => {
					const { ctx } = projectOf(input.workspaceId);
					lastExport = undefined;
					const loaded = exportAt(input.path);
					const imported = new Map(
						listStored(ctx.project)
							.filter((c) => c.origin.kind === "claude-export")
							.map((c) => [
								c.origin.kind === "claude-export"
									? c.origin.conversationUuid
									: "",
								c,
							]),
					);
					return {
						exportPath: loaded.exportPath,
						hasProjectLinks: loaded.hasProjectLinks,
						projects: loaded.projects,
						warnings: loaded.warnings,
						conversations: loaded.conversations.map((c) => {
							const stored = imported.get(c.origin.conversationUuid);
							return {
								uuid: c.origin.conversationUuid,
								title: c.title,
								createdAt: c.createdAt ?? null,
								updatedAt: c.updatedAt ?? null,
								messageCount: c.messages.length,
								projectUuid: c.origin.projectUuid ?? null,
								projectName: c.origin.projectName ?? null,
								importedId: stored?.id ?? null,
							};
						}),
					};
				}),
			),

		importExport: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					path: z.string(),
					uuids: z.array(z.string()).min(1),
					scope: scopeInput,
				}),
			)
			.mutation(({ input }) =>
				guarded(() => {
					const { ctx, identity } = projectOf(input.workspaceId);
					const loaded = exportAt(input.path);
					const wanted = new Set(input.uuids);
					const chosen = loaded.conversations.filter((c) =>
						wanted.has(c.origin.conversationUuid),
					);
					if (chosen.length !== wanted.size) {
						throw new Error(
							"Some selected chats are not in this export any more; preview it again.",
						);
					}
					// Exports carry no repository information: importing them here
					// is the user's own association.
					return importConversations(
						ctx.project,
						chosen.map((conversation) => ({
							conversation,
							association: "user-confirmed" as const,
						})),
						{
							scope: scopeFor(input.scope, ctx),
							repository: {
								root: ctx.project.root,
								remote: identity.remote,
							},
						},
					);
				}),
			),

		/** One selected transcript file, to preview before importing. */
		previewTranscript: publicProcedure
			.input(z.object({ path: z.string() }))
			.query(({ input }) =>
				guarded(() => {
					const conversation = loadTranscriptFile(input.path);
					return {
						title: conversation.title,
						kind: conversation.origin.kind,
						messageCount: conversation.messages.length,
						updatedAt: conversation.updatedAt ?? null,
						firstMessage: conversation.messages[0]?.text.slice(0, 300) ?? "",
					};
				}),
			),

		importTranscript: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					path: z.string(),
					scope: scopeInput,
				}),
			)
			.mutation(({ input }) =>
				guarded(() => {
					const { ctx, identity } = projectOf(input.workspaceId);
					const conversation = loadTranscriptFile(input.path);
					const cwd =
						conversation.origin.kind === "claude-code"
							? conversation.origin.cwd
							: undefined;
					const match = cwd
						? matchRepository(
								{ root: ctx.project.root, identity },
								cwd,
								undefined,
							)
						: undefined;
					return importConversations(
						ctx.project,
						[
							{
								conversation,
								association: match?.association ?? "user-confirmed",
							},
						],
						{
							scope: scopeFor(input.scope, ctx),
							repository: {
								root: ctx.project.root,
								remote: identity.remote,
							},
						},
					);
				}),
			),

		setIncluded: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					id: z.string(),
					included: z.boolean(),
				}),
			)
			.mutation(({ input }) =>
				guarded(() => {
					const { ctx } = projectOf(input.workspaceId);
					return describe(
						setIncluded(ctx.project, input.id, input.included),
						ctx,
					);
				}),
			),

		setScope: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					id: z.string(),
					scope: scopeInput,
				}),
			)
			.mutation(({ input }) =>
				guarded(() => {
					const { ctx } = projectOf(input.workspaceId);
					return describe(
						setScope(ctx.project, input.id, scopeFor(input.scope, ctx)),
						ctx,
					);
				}),
			),

		/** Remove ADE's copy; the original conversation is not touched. */
		remove: publicProcedure
			.input(z.object({ workspaceId: z.string(), id: z.string() }))
			.mutation(({ input }) =>
				guarded(() => {
					const { ctx } = projectOf(input.workspaceId);
					removeStored(ctx.project, input.id);
					return { removed: input.id };
				}),
			),

		/** Re-read originals into the copies (all, or the given ones). */
		refresh: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					ids: z.array(z.string()).optional(),
				}),
			)
			.mutation(({ input }) =>
				guarded(() => {
					const { ctx } = projectOf(input.workspaceId);
					lastExport = undefined;
					const ids = input.ids ?? listStored(ctx.project).map((c) => c.id);
					return refreshStored(ctx.project, ids);
				}),
			),

		/** Other ADE projects, to move a wrongly associated conversation to. */
		otherProjects: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(({ input }) =>
				guarded(() => {
					const { ctx } = projectOf(input.workspaceId);
					return deps
						.listProjects()
						.filter(
							(p) =>
								p.mainRepoPath &&
								pathKey(p.mainRepoPath) !== pathKey(ctx.project.root),
						)
						.map((p) => ({ id: p.id, name: p.name, root: p.mainRepoPath }));
				}),
			),

		move: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					id: z.string(),
					targetProjectId: z.string(),
				}),
			)
			.mutation(({ input }) =>
				guarded(() => {
					const { ctx } = projectOf(input.workspaceId);
					const target = deps
						.listProjects()
						.find((p) => p.id === input.targetProjectId);
					if (!target?.mainRepoPath) throw new Error("Project not found");
					const targetWorkflow = ensureProjectWorkflow(
						deps.homeDir(),
						target.mainRepoPath,
					);
					moveStored(
						ctx.project,
						{
							...targetWorkflow,
							remote: repoIdentity(target.mainRepoPath).remote,
						},
						input.id,
					);
					return { movedTo: target.name };
				}),
			),

		/**
		 * Resume a Claude Code session natively, in the folder it ran in.
		 * Exported chats cannot be resumed: they start new tasks instead.
		 */
		resumeCommand: publicProcedure
			.input(z.object({ workspaceId: z.string(), id: z.string() }))
			.query(({ input }) =>
				guarded(() => {
					const { ctx } = projectOf(input.workspaceId);
					const stored = getStored(ctx.project, input.id);
					if (!stored)
						throw new Error("That conversation is not imported here");
					const origin = stored.origin;
					if (origin.kind !== "claude-code") {
						throw new Error(
							"Only Claude Code sessions can be resumed. Start a new task instead; it uses this conversation as history.",
						);
					}
					if (!existsSync(origin.transcriptPath)) {
						throw new Error(
							"Claude Code no longer has this session (its transcript was removed), so it cannot be resumed.",
						);
					}
					if (!origin.cwd || !existsSync(origin.cwd)) {
						throw new Error(
							"The folder this session ran in no longer exists, so it cannot be resumed there.",
						);
					}
					const folder = portablePath(origin.cwd).replace(/'/g, "'\\''");
					return {
						command: `cd '${folder}' && ${buildResumeCommand(origin.sessionId)}`,
						cwd: origin.cwd,
					};
				}),
			),

		/** The user's GitHub repositories, via the gh CLI they are signed in to. */
		listGitHubRepos: publicProcedure.query(async () => {
			const result = await deps.runGh([
				"repo",
				"list",
				"--limit",
				"100",
				"--json",
				"nameWithOwner,url,updatedAt,isPrivate,description",
			]);
			if (!result.ok) {
				return { available: false as const, reason: result.error, repos: [] };
			}
			try {
				const repos = JSON.parse(result.stdout) as Array<{
					nameWithOwner: string;
					url: string;
					updatedAt?: string;
					isPrivate?: boolean;
					description?: string | null;
				}>;
				return {
					available: true as const,
					reason: null,
					repos: repos.map((r) => ({
						nameWithOwner: r.nameWithOwner,
						url: r.url,
						updatedAt: r.updatedAt ?? null,
						isPrivate: !!r.isPrivate,
						description: r.description ?? null,
					})),
				};
			} catch {
				return {
					available: false as const,
					reason: "The GitHub CLI returned an unexpected answer.",
					repos: [],
				};
			}
		}),

		/**
		 * An ADE project whose repository has this remote, so connecting a
		 * GitHub repository opens the existing clone instead of cloning again.
		 */
		findProjectByRemote: publicProcedure
			.input(z.object({ url: z.string() }))
			.query(({ input }) => {
				const wanted = normalizeRemote(input.url);
				if (!wanted) return { project: null, remote: null };
				for (const project of deps.listProjects()) {
					if (!project.mainRepoPath || !existsSync(project.mainRepoPath))
						continue;
					if (repoIdentity(project.mainRepoPath).remote === wanted) {
						return {
							project: {
								id: project.id,
								name: project.name,
								root: project.mainRepoPath,
							},
							remote: wanted,
						};
					}
				}
				return { project: null, remote: wanted };
			}),
	});
};
