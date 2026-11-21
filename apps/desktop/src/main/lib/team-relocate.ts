import { spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { projectWorkflowFor } from "main/lib/agent-workflow/project-workflow";
import { listTaskRecords, saveTask } from "main/lib/agent-workflow/tasks";

/**
 * Changing a team's folder. "move" moves the team's repository folder
 * into another folder; "relink" points the team at the place the user
 * already moved it to. Either way the agents come along: they work in git
 * worktrees of that repository (their own folders, which do not move), and
 * `git worktree repair` re-links both sides. ADE's own record of the team
 * (its tasks and specialists, kept under a key derived from the folder)
 * follows too. Nothing is deleted.
 */

export type RelocateMode = "move" | "relink";

function samePath(a: string, b: string): boolean {
	const norm = (p: string) => {
		const r = resolve(p).replace(/[\\/]+$/, "");
		return process.platform === "win32" ? r.toLowerCase() : r;
	};
	return norm(a) === norm(b);
}

function moveError(error: unknown): Error {
	const code = (error as NodeJS.ErrnoException)?.code;
	if (code === "EXDEV") {
		return new Error(
			'That folder is on another drive. Move the team\'s folder there yourself, then use "I already moved it".',
		);
	}
	if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
		return new Error(
			"The team's folder is in use. Close the programs and terminals using it (an editor, Team chat, the team's own terminals), then try again.",
		);
	}
	return error instanceof Error ? error : new Error(String(error));
}

/**
 * Move or re-link the repository and repair its agents' worktrees. For
 * "move", `target` is the folder to move it into (the folder keeps its
 * name); for "relink", `target` is where the repository is now. Returns
 * the repository's new path.
 */
export function relocateRepository(input: {
	from: string;
	target: string;
	mode: RelocateMode;
	agentWorktrees: string[];
}): string {
	const from = resolve(input.from);
	let to: string;
	if (input.mode === "move") {
		to = join(resolve(input.target), basename(from));
		if (samePath(to, from))
			throw new Error("The team's folder is already there.");
		const target = resolve(input.target);
		if (
			samePath(target, from) ||
			target.toLowerCase().startsWith(`${from.toLowerCase()}${sep}`)
		) {
			throw new Error("Choose a folder outside the team's own folder.");
		}
		if (!existsSync(from)) {
			throw new Error(
				`The team's folder is no longer at ${from}. If you moved it, use "I already moved it".`,
			);
		}
		if (existsSync(to)) throw new Error(`${to} already exists.`);
		try {
			renameSync(from, to);
		} catch (error) {
			throw moveError(error);
		}
	} else {
		to = resolve(input.target);
		if (samePath(to, from))
			throw new Error("That is the team's current folder.");
		if (!existsSync(join(to, ".git"))) {
			throw new Error(
				"That folder is not the repository's top folder (it has no .git).",
			);
		}
		if (existsSync(join(from, ".git"))) {
			throw new Error(
				`The team's repository is still at ${from}. Use "Move the folder" instead.`,
			);
		}
	}
	const agents = input.agentWorktrees.filter((p) => existsSync(p));
	if (agents.length) {
		const repair = spawnSync("git", ["worktree", "repair", ...agents], {
			cwd: to,
			encoding: "utf8",
			windowsHide: true,
		});
		if (repair.status !== 0) {
			throw new Error(
				`The folder is at ${to}, but its agents could not be re-linked: ${(repair.stderr || repair.stdout).trim()}. Run "git worktree repair" there.`,
			);
		}
	}
	return to;
}

/**
 * Carry ADE's record of the team (tasks, specialists, checks) from the old
 * folder's key to the new one, and point tasks that ran in the team's own
 * folder at its new path.
 */
export function moveWorkflowRecord(
	homeDir: string,
	fromRoot: string,
	toRoot: string,
): void {
	const before = projectWorkflowFor(homeDir, fromRoot);
	const after = projectWorkflowFor(homeDir, toRoot);
	if (before.key === after.key) return;
	if (existsSync(before.dir) && !existsSync(after.dir)) {
		renameSync(before.dir, after.dir);
	}
	if (!existsSync(after.dir)) return;
	for (const task of listTaskRecords(after)) {
		if (samePath(task.identity.worktreePath, fromRoot)) {
			saveTask(after, {
				...task,
				identity: { ...task.identity, worktreePath: after.root },
			});
		}
	}
}
