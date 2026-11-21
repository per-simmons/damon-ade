import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sessionConversation } from "./claude-code-sessions";
import { ExportError, loadClaudeExport } from "./claude-export";
import { pathKey } from "./repo-identity";
import { loadTranscriptFile } from "./transcript-file";
import type {
	Association,
	ConversationOrigin,
	HistoryScope,
	OriginStatus,
	ParsedConversation,
	StoredConversation,
} from "./types";

/**
 * Imported conversations of one ADE project, as copies in ADE's own folder:
 *
 *   <ADE home>/workflow/projects/<key>/history/conversations/<id>.json
 *
 * Each project has its own folder (the key comes from the repository root),
 * so two projects never share history. Within a project a copy is scoped to
 * the whole project or to one worktree. Removing or refreshing a copy never
 * touches the original transcript or export.
 */

export interface HistoryProject {
	/** ADE's workflow folder for the project. */
	dir: string;
	root: string;
}

const ID = /^[a-f0-9]{16}$/;

export function historyDir(project: HistoryProject): string {
	return join(project.dir, "history", "conversations");
}

export function originKey(origin: ConversationOrigin): string {
	switch (origin.kind) {
		case "claude-code":
			return `claude-code:${origin.sessionId}`;
		case "claude-export":
			return `claude-export:${origin.conversationUuid}`;
		case "transcript-file":
			return `file:${pathKey(origin.path)}`;
	}
}

export function conversationId(origin: ConversationOrigin): string {
	return createHash("sha256")
		.update(originKey(origin))
		.digest("hex")
		.slice(0, 16);
}

function hashContent(conversation: ParsedConversation): string {
	return createHash("sha256")
		.update(JSON.stringify([conversation.title, conversation.messages]))
		.digest("hex")
		.slice(0, 24);
}

function originFile(origin: ConversationOrigin): string {
	switch (origin.kind) {
		case "claude-code":
			return origin.transcriptPath;
		case "claude-export":
			return origin.exportPath;
		case "transcript-file":
			return origin.path;
	}
}

function stampOf(path: string): StoredConversation["originStamp"] {
	try {
		const stat = statSync(path);
		return stat.isFile()
			? { size: stat.size, mtimeMs: stat.mtimeMs }
			: undefined;
	} catch {
		return undefined;
	}
}

function write(
	project: HistoryProject,
	conversation: StoredConversation,
): void {
	const dir = historyDir(project);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${conversation.id}.json`);
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(conversation, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

export function getStored(
	project: HistoryProject,
	id: string,
): StoredConversation | undefined {
	if (!ID.test(id)) return undefined;
	try {
		const parsed = JSON.parse(
			readFileSync(join(historyDir(project), `${id}.json`), "utf8"),
		) as StoredConversation;
		return parsed.version === 1 ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** All imported conversations, most recently active first. */
export function listStored(project: HistoryProject): StoredConversation[] {
	const dir = historyDir(project);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => getStored(project, name.slice(0, -5)))
		.filter((c): c is StoredConversation => c !== undefined)
		.sort((a, b) =>
			(b.updatedAt ?? b.importedAt).localeCompare(a.updatedAt ?? a.importedAt),
		);
}

export interface ImportItem {
	conversation: ParsedConversation;
	association: Association;
}

export interface ImportResult {
	added: string[];
	updated: string[];
	unchanged: string[];
}

/**
 * Store copies. Importing a conversation again never duplicates it: an
 * unchanged one is left alone, a changed one is updated in place, keeping
 * the user's include and scope choices.
 */
export function importConversations(
	project: HistoryProject,
	items: ImportItem[],
	options: {
		scope: HistoryScope;
		repository: StoredConversation["repository"];
		now?: Date;
	},
): ImportResult {
	const now = (options.now ?? new Date()).toISOString();
	const result: ImportResult = { added: [], updated: [], unchanged: [] };
	for (const { conversation, association } of items) {
		const id = conversationId(conversation.origin);
		const contentHash = hashContent(conversation);
		const existing = getStored(project, id);
		if (existing && existing.contentHash === contentHash) {
			result.unchanged.push(id);
			continue;
		}
		const stored: StoredConversation = {
			...conversation,
			version: 1,
			id,
			contentHash,
			importedAt: existing?.importedAt ?? now,
			refreshedAt: existing ? now : undefined,
			originStamp: stampOf(originFile(conversation.origin)),
			included: existing?.included ?? true,
			scope: existing?.scope ?? options.scope,
			association: existing?.association ?? association,
			repository: existing?.repository ?? options.repository,
		};
		write(project, stored);
		(existing ? result.updated : result.added).push(id);
	}
	return result;
}

function mustGet(project: HistoryProject, id: string): StoredConversation {
	const stored = getStored(project, id);
	if (!stored) throw new Error("That conversation is not imported here");
	return stored;
}

export function setIncluded(
	project: HistoryProject,
	id: string,
	included: boolean,
): StoredConversation {
	const stored = { ...mustGet(project, id), included };
	write(project, stored);
	return stored;
}

export function setScope(
	project: HistoryProject,
	id: string,
	scope: HistoryScope,
): StoredConversation {
	if (scope.kind === "worktree" && !scope.path.trim()) {
		throw new Error("Choose a worktree");
	}
	const stored = { ...mustGet(project, id), scope };
	write(project, stored);
	return stored;
}

/** Remove ADE's copy only; the original is never touched. */
export function removeStored(project: HistoryProject, id: string): void {
	mustGet(project, id);
	rmSync(join(historyDir(project), `${id}.json`), { force: true });
}

/**
 * Move a copy to another project (correcting a wrong association). The user
 * chose the target, so the association becomes user-confirmed.
 */
export function moveStored(
	from: HistoryProject,
	to: HistoryProject & { remote?: string },
	id: string,
): StoredConversation {
	const stored = mustGet(from, id);
	if (getStored(to, id)) {
		throw new Error("That project already has this conversation");
	}
	const moved: StoredConversation = {
		...stored,
		scope: { kind: "project" },
		association: "user-confirmed",
		repository: { root: to.root, remote: to.remote },
	};
	write(to, moved);
	rmSync(join(historyDir(from), `${id}.json`), { force: true });
	return moved;
}

export function originStatus(stored: StoredConversation): OriginStatus {
	const path = originFile(stored.origin);
	if (!existsSync(path)) return "missing";
	if (stored.origin.kind === "claude-export") return "current";
	const stamp = stampOf(path);
	if (
		stamp &&
		stored.originStamp &&
		(stamp.size !== stored.originStamp.size ||
			stamp.mtimeMs !== stored.originStamp.mtimeMs)
	) {
		return "changed";
	}
	return "current";
}

export type RefreshOutcome = "updated" | "unchanged" | "missing" | "failed";

/**
 * Re-read originals and update the copies. A missing original leaves the
 * copy as it is (and says so); an export is read once for all its chats.
 */
export function refreshStored(
	project: HistoryProject,
	ids: string[],
	now: Date = new Date(),
): Record<string, { outcome: RefreshOutcome; message?: string }> {
	const results: Record<string, { outcome: RefreshOutcome; message?: string }> =
		{};
	const exports = new Map<
		string,
		ReturnType<typeof loadClaudeExport> | Error
	>();
	for (const id of ids) {
		const stored = getStored(project, id);
		if (!stored) {
			results[id] = { outcome: "failed", message: "Not imported here" };
			continue;
		}
		const origin = stored.origin;
		if (!existsSync(originFile(origin))) {
			results[id] = {
				outcome: "missing",
				message: "The original is gone; the imported copy is kept.",
			};
			continue;
		}
		let fresh: ParsedConversation | undefined;
		try {
			if (origin.kind === "claude-code") {
				fresh = sessionConversation(origin.transcriptPath);
			} else if (origin.kind === "transcript-file") {
				fresh = loadTranscriptFile(origin.path);
			} else {
				let loaded = exports.get(origin.exportPath);
				if (!loaded) {
					try {
						loaded = loadClaudeExport(origin.exportPath);
					} catch (error) {
						loaded = error as Error;
					}
					exports.set(origin.exportPath, loaded);
				}
				if (loaded instanceof Error) throw loaded;
				fresh = loaded.conversations.find(
					(c) => c.origin.conversationUuid === origin.conversationUuid,
				);
				if (!fresh) {
					results[id] = {
						outcome: "missing",
						message: "The chat is no longer in that export; the copy is kept.",
					};
					continue;
				}
			}
		} catch (error) {
			results[id] = {
				outcome: "failed",
				message:
					error instanceof ExportError || error instanceof Error
						? error.message
						: String(error),
			};
			continue;
		}
		const contentHash = hashContent(fresh);
		const updated: StoredConversation = {
			...stored,
			...fresh,
			origin: { ...fresh.origin },
			contentHash,
			refreshedAt: now.toISOString(),
			originStamp: stampOf(originFile(fresh.origin)),
		};
		write(project, updated);
		results[id] = {
			outcome: contentHash === stored.contentHash ? "unchanged" : "updated",
		};
	}
	return results;
}

/** Whether a copy applies to work in this worktree. */
export function inScope(
	stored: StoredConversation,
	worktreePath: string,
): boolean {
	return (
		stored.scope.kind === "project" ||
		pathKey(stored.scope.path) === pathKey(worktreePath)
	);
}
