import { spawnSync } from "node:child_process";

/**
 * Handing work from one agent to another in a team request. Agents work in
 * their own worktrees of the team's repository, on their own branches. When
 * a subtask depends on one another agent finished, ADE commits that
 * subtask's own files on its agent's branch and merges the commit into the
 * dependent agent's branch before it starts. Nothing else is committed,
 * nothing is pushed, and the team's main branch is never merged into.
 */

function git(
	cwd: string,
	args: string[],
): { ok: boolean; out: string; err: string } {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		windowsHide: true,
		maxBuffer: 32 * 1024 * 1024,
	});
	return {
		ok: result.status === 0,
		out: (result.stdout ?? "").trim(),
		err: (result.stderr || result.stdout || result.error?.message || "").trim(),
	};
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim()) ?? "git failed";
}

/**
 * Commit exactly these files (a finished subtask's own changes) on the
 * worktree's current branch. Returns the commit, or why it failed.
 */
export function commitFiles(
	worktree: string,
	files: string[],
	message: string,
): { commit: string } | { error: string } {
	if (files.length === 0) return { error: "no files to commit" };
	const add = git(worktree, ["add", "-A", "--", ...files]);
	if (!add.ok) return { error: firstLine(add.err) };
	const commit = git(worktree, [
		"commit",
		"--no-verify",
		"-m",
		message,
		"--",
		...files,
	]);
	if (!commit.ok) return { error: firstLine(commit.err) };
	const head = git(worktree, ["rev-parse", "HEAD"]);
	return head.ok ? { commit: head.out } : { error: firstLine(head.err) };
}

/**
 * Merge a commit into the worktree's branch. On a conflict the merge is
 * undone and the reason returned; the worktree is left as it was.
 */
export function mergeCommit(
	worktree: string,
	commit: string,
	message: string,
): string | undefined {
	const merge = git(worktree, ["merge", "--no-edit", "-m", message, commit]);
	if (merge.ok) return undefined;
	const conflicted = git(worktree, ["diff", "--name-only", "--diff-filter=U"]);
	git(worktree, ["merge", "--abort"]);
	return conflicted.ok && conflicted.out
		? `merge conflict in ${conflicted.out.split("\n").join(", ")}`
		: firstLine(merge.err);
}
