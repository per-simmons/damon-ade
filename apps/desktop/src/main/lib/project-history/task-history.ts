import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderHistory, selectExcerpts } from "./excerpts";
import { type HistoryProject, inScope, listStored } from "./store";
import type { StoredConversation, TaskHistory } from "./types";

/**
 * A task's history: the excerpts chosen for it when it was created (or when
 * the user refreshed it), written to history.md in the task folder so the
 * user can read exactly what the models were given. Only conversations that
 * are included, in scope for the task's worktree and not removed from this
 * task are searched.
 */

export const HISTORY_FILE = "history.md";

export function eligibleConversations(
	project: HistoryProject,
	worktreePath: string,
	excluded: string[] = [],
): StoredConversation[] {
	const skip = new Set(excluded);
	return listStored(project).filter(
		(c) => c.included && !skip.has(c.id) && inScope(c, worktreePath),
	);
}

export function buildTaskHistory(input: {
	project: HistoryProject;
	/** The task's folder. */
	taskDir: string;
	query: string;
	worktreePath: string;
	excluded?: string[];
	now?: Date;
}): TaskHistory {
	const excluded = input.excluded ?? [];
	const conversations = eligibleConversations(
		input.project,
		input.worktreePath,
		excluded,
	);
	const excerpts = selectExcerpts(conversations, input.query);
	const file = join(input.taskDir, HISTORY_FILE);
	if (excerpts.length > 0) {
		writeFileSync(file, renderHistory(excerpts, conversations), "utf8");
	} else {
		rmSync(file, { force: true });
	}
	const counts = new Map<string, number>();
	for (const excerpt of excerpts) {
		counts.set(
			excerpt.conversationId,
			(counts.get(excerpt.conversationId) ?? 0) + 1,
		);
	}
	return {
		builtAt: (input.now ?? new Date()).toISOString(),
		excluded,
		excerpts: excerpts.length,
		sources: conversations
			.filter((c) => counts.has(c.id))
			.map((c) => ({
				conversationId: c.id,
				title: c.title,
				originKind: c.origin.kind,
				excerpts: counts.get(c.id) ?? 0,
			})),
	};
}

export function clearTaskHistory(taskDir: string): void {
	rmSync(join(taskDir, HISTORY_FILE), { force: true });
}

export function readTaskHistory(taskDir: string): string | undefined {
	const file = join(taskDir, HISTORY_FILE);
	if (!existsSync(file)) return undefined;
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}
