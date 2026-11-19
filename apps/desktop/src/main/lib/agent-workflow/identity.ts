import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TaskIdentity, TaskRecord } from "./tasks";

/**
 * Where a task runs and which changes are its own. A project's worktrees
 * share its task folder, so each task records the worktree, branch and HEAD
 * it was created on, plus the files that were already changed then. Its
 * changes are measured against that baseline, so edits that predate the task
 * are never attributed to it.
 */

function git(cwd: string, args: string[]): string | undefined {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		windowsHide: true,
		maxBuffer: 32 * 1024 * 1024,
	});
	return result.status === 0 ? result.stdout : undefined;
}

function contentHash(path: string): string {
	try {
		return createHash("sha1").update(readFileSync(path)).digest("hex");
	} catch {
		return existsSync(path) ? "unreadable" : "deleted";
	}
}

/** Paths git reports as changed or untracked (relative to the worktree). */
export function dirtyPaths(worktree: string): string[] {
	const out = git(worktree, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=all",
	]);
	if (out === undefined) return [];
	const paths: string[] = [];
	const entries = out.split("\0");
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.length < 4) continue;
		const status = entry.slice(0, 2);
		paths.push(entry.slice(3));
		// A rename or copy is followed by its original path.
		if (status.includes("R") || status.includes("C")) i++;
	}
	return paths;
}

export function captureIdentity(
	workspaceId: string,
	worktree: string,
): TaskIdentity {
	const worktreePath = resolve(worktree);
	const head = git(worktreePath, ["rev-parse", "HEAD"])?.trim();
	const branch = git(worktreePath, [
		"rev-parse",
		"--abbrev-ref",
		"HEAD",
	])?.trim();
	const baselineDirty: Record<string, string> = {};
	for (const path of dirtyPaths(worktreePath)) {
		baselineDirty[path] = contentHash(join(worktreePath, path));
	}
	return {
		workspaceId,
		worktreePath,
		branch: branch || undefined,
		baselineHead: head || undefined,
		baselineDirty,
	};
}

function samePath(a: string, b: string): boolean {
	const norm = (p: string) => {
		const r = resolve(p).replace(/[\\/]+$/, "");
		return process.platform === "win32" ? r.toLowerCase() : r;
	};
	return norm(a) === norm(b);
}

/**
 * Whether a task may run from this workspace. A task belongs to the worktree
 * it was created in; running it elsewhere would apply its plan to a different
 * branch, so it needs an explicit move.
 */
export function identityMismatch(
	task: TaskRecord,
	_workspaceId: string,
	worktree: string,
): string | undefined {
	if (samePath(task.identity.worktreePath, worktree)) return undefined;
	const where = task.identity.branch
		? `${task.identity.worktreePath} (branch ${task.identity.branch})`
		: task.identity.worktreePath;
	return `This task belongs to ${where}. Open that workspace, or move the task here.`;
}

export interface TaskChanges {
	/** Files the task changed (relative paths). */
	files: string[];
	/** Files that were already changed when the task started. */
	preexisting: string[];
	/** False when the worktree is not a git repository. */
	tracked: boolean;
}

/** The task's own changes: since its baseline, minus pre-existing edits. */
export function taskChanges(identity: TaskIdentity): TaskChanges {
	const cwd = identity.worktreePath;
	if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) === undefined) {
		return { files: [], preexisting: [], tracked: false };
	}
	const changed = new Set<string>();
	if (identity.baselineHead) {
		const committed = git(cwd, [
			"diff",
			"--name-only",
			"-z",
			identity.baselineHead,
			"HEAD",
		]);
		for (const path of committed?.split("\0") ?? [])
			if (path) changed.add(path);
	}
	for (const path of dirtyPaths(cwd)) changed.add(path);

	const files: string[] = [];
	const preexisting: string[] = [];
	for (const path of [...changed].sort()) {
		const before = identity.baselineDirty[path];
		if (before !== undefined && before === contentHash(join(cwd, path))) {
			preexisting.push(path);
		} else {
			files.push(path);
		}
	}
	return { files, preexisting, tracked: true };
}
