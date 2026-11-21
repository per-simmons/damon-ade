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

/** The worktree's checked-out branch ("HEAD" when detached), if a git repo. */
export function currentBranch(worktree: string): string | undefined {
	return (
		git(resolve(worktree), ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() ||
		undefined
	);
}

/**
 * A fingerprint of the worktree's code: HEAD plus the content of every
 * changed or untracked (not ignored) file. Check and review results are
 * valid only for the code state they ran on. Undefined outside git.
 */
export function codeState(worktree: string): string | undefined {
	const cwd = resolve(worktree);
	const head = git(cwd, ["rev-parse", "HEAD"])?.trim();
	if (head === undefined) return undefined;
	const hash = createHash("sha256").update(head);
	for (const path of dirtyPaths(cwd).sort()) {
		hash.update(`\0${path}\0${contentHash(join(cwd, path))}`);
	}
	return hash.digest("hex").slice(0, 32);
}

export function captureIdentity(
	workspaceId: string,
	worktree: string,
): TaskIdentity {
	const worktreePath = resolve(worktree);
	const head = git(worktreePath, ["rev-parse", "HEAD"])?.trim();
	const branch = currentBranch(worktreePath);
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
	/** The worktree's branch now; pass it to catch a branch switch. */
	branchNow?: string,
): string | undefined {
	if (samePath(task.identity.worktreePath, worktree)) {
		return branchChange(task.identity, branchNow);
	}
	const where = task.identity.branch
		? `${task.identity.worktreePath} (branch ${task.identity.branch})`
		: task.identity.worktreePath;
	return `This task belongs to ${where}. Open that workspace, or move the task here.`;
}

/**
 * The task's worktree switched branches since the task was created (or
 * moved): its plan and changes belong to the old branch.
 */
export function branchChange(
	identity: TaskIdentity,
	branchNow: string | undefined,
): string | undefined {
	if (!identity.branch || !branchNow || identity.branch === branchNow) {
		return undefined;
	}
	return `This task runs on branch ${identity.branch}, but the worktree is now on ${branchNow}. Switch back to ${identity.branch}, or move the task to ${branchNow} (its results will be verified again).`;
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
