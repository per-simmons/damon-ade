import { spawnSync } from "node:child_process";

/**
 * Keep a checkout up to date with its remote, safely: fetch, then
 * fast-forward only. Nothing is ever merged, rebased, stashed or reset, so
 * local work cannot be lost: a checkout with uncommitted changes, local
 * commits that are not on the remote, no upstream branch or a detached HEAD
 * is left exactly as it is, with the reason.
 */

export interface RemoteStatus {
	/** The checked-out branch, or null when detached. */
	branch: string | null;
	/** Its upstream, e.g. "origin/main", or null when it has none. */
	upstream: string | null;
	/** Local commits not on the upstream. */
	ahead: number;
	/** Upstream commits not in the checkout. */
	behind: number;
	/** Tracked files with uncommitted changes. */
	dirty: boolean;
	/** Whether the remote was reached this time (else counts are from the last fetch). */
	fetched: boolean;
	fetchError: string | null;
	/** Why an update cannot run now, or null when it can (or is not needed). */
	blocked: string | null;
}

export type UpdateResult =
	| { outcome: "updated"; from: string; to: string; commits: number }
	| { outcome: "up-to-date" }
	| { outcome: "blocked"; reason: string };

type Git = (
	args: string[],
	timeoutMs?: number,
) => {
	ok: boolean;
	stdout: string;
	stderr: string;
};

function gitIn(cwd: string): Git {
	return (args, timeoutMs = 15_000) => {
		const result = spawnSync("git", args, {
			cwd,
			encoding: "utf8",
			windowsHide: true,
			timeout: timeoutMs,
			// Never prompt for credentials: a fetch that needs them fails instead.
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		return {
			ok: result.status === 0,
			stdout: (result.stdout ?? "").trim(),
			stderr: (result.stderr ?? "").trim(),
		};
	};
}

function firstLine(text: string): string {
	return (
		text
			.split("\n")
			.map((l) => l.trim())
			.find(Boolean) ?? "unknown error"
	);
}

export function remoteStatus(
	worktree: string,
	options: { fetch: boolean },
): RemoteStatus {
	const git = gitIn(worktree);
	const head = git(["rev-parse", "--abbrev-ref", "HEAD"]);
	if (!head.ok) throw new Error("This folder is not a git repository");
	const branch = head.stdout === "HEAD" ? null : head.stdout;
	const upstreamRef = branch
		? git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
		: { ok: false, stdout: "", stderr: "" };
	const upstream = upstreamRef.ok ? upstreamRef.stdout : null;

	let fetched = false;
	let fetchError: string | null = null;
	if (options.fetch && upstream) {
		const remote =
			git(["config", `branch.${branch}.remote`]).stdout || "origin";
		const result = git(["fetch", "--quiet", remote], 60_000);
		fetched = result.ok;
		if (!result.ok) fetchError = firstLine(result.stderr);
	}

	let ahead = 0;
	let behind = 0;
	if (upstream) {
		const counts = git(["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
		if (counts.ok) {
			const [a, b] = counts.stdout.split(/\s+/).map(Number);
			ahead = a || 0;
			behind = b || 0;
		}
	}
	const dirty =
		git(["status", "--porcelain", "--untracked-files=no"]).stdout.length > 0;

	let blocked: string | null = null;
	if (!branch) {
		blocked = "The checkout is not on a branch (detached HEAD)";
	} else if (!upstream) {
		blocked = `Branch ${branch} does not track a remote branch`;
	} else if (behind > 0 && ahead > 0) {
		blocked = `Branch ${branch} has ${ahead} local commit(s) that are not on ${upstream}, and ${upstream} has ${behind} new one(s). Merge or rebase it yourself.`;
	} else if (behind > 0 && dirty) {
		blocked =
			"There are uncommitted changes. Commit or stash them first, then update.";
	}
	return {
		branch,
		upstream,
		ahead,
		behind,
		dirty,
		fetched,
		fetchError,
		blocked,
	};
}

/** Fetch, then fast-forward the checkout to its upstream if that is safe. */
export function fastForward(worktree: string): UpdateResult {
	const status = remoteStatus(worktree, { fetch: true });
	if (status.fetchError) {
		return {
			outcome: "blocked",
			reason: `Could not reach the remote: ${status.fetchError}`,
		};
	}
	if (status.blocked) return { outcome: "blocked", reason: status.blocked };
	if (status.behind === 0) return { outcome: "up-to-date" };

	const git = gitIn(worktree);
	const from = git(["rev-parse", "--short", "HEAD"]).stdout;
	const merge = git(["merge", "--ff-only", "--quiet", "@{u}"], 60_000);
	if (!merge.ok) {
		// e.g. an untracked file would be overwritten. Git changed nothing.
		return { outcome: "blocked", reason: firstLine(merge.stderr) };
	}
	const to = git(["rev-parse", "--short", "HEAD"]).stdout;
	return { outcome: "updated", from, to, commits: status.behind };
}

export type PushResult =
	| { outcome: "pushed"; commits: number; branch: string; upstream: string }
	| { outcome: "up-to-date" }
	| { outcome: "blocked"; reason: string };

function remoteNames(git: Git): string[] {
	return git(["remote"]).stdout.split(/\s+/).filter(Boolean);
}

/**
 * Push the checked-out branch's own commits to its remote branch. Never
 * forces: a branch that has diverged from its remote is left for the user.
 * A branch without an upstream is pushed to origin under the same name and
 * starts tracking it.
 */
export function pushToUpstream(worktree: string): PushResult {
	const status = remoteStatus(worktree, { fetch: true });
	if (status.fetchError) {
		return {
			outcome: "blocked",
			reason: `Could not reach the remote: ${status.fetchError}`,
		};
	}
	if (!status.branch) {
		return { outcome: "blocked", reason: "The checkout is not on a branch" };
	}
	const git = gitIn(worktree);
	if (!status.upstream) {
		if (!remoteNames(git).includes("origin")) {
			return {
				outcome: "blocked",
				reason: "This repository is not connected to GitHub yet",
			};
		}
		const pushed = git(
			["push", "--quiet", "-u", "origin", status.branch],
			120_000,
		);
		if (!pushed.ok)
			return { outcome: "blocked", reason: firstLine(pushed.stderr) };
		const count = Number(git(["rev-list", "--count", "HEAD"]).stdout) || 0;
		return {
			outcome: "pushed",
			commits: count,
			branch: status.branch,
			upstream: `origin/${status.branch}`,
		};
	}
	if (status.ahead > 0 && status.behind > 0) {
		return {
			outcome: "blocked",
			reason: `Branch ${status.branch} and ${status.upstream} have both changed (${status.ahead} local, ${status.behind} remote commit(s)). Merge or rebase it yourself; ADE never force-pushes.`,
		};
	}
	if (status.ahead === 0) return { outcome: "up-to-date" };
	const remote =
		git(["config", `branch.${status.branch}.remote`]).stdout || "origin";
	const merge =
		git(["config", `branch.${status.branch}.merge`]).stdout.replace(
			/^refs\/heads\//,
			"",
		) || status.branch;
	const pushed = git(
		["push", "--quiet", remote, `HEAD:refs/heads/${merge}`],
		120_000,
	);
	if (!pushed.ok)
		return { outcome: "blocked", reason: firstLine(pushed.stderr) };
	return {
		outcome: "pushed",
		commits: status.ahead,
		branch: status.branch,
		upstream: status.upstream,
	};
}

export interface SyncResult {
	pull: UpdateResult;
	push: PushResult;
	/** Both sides now have the same commits on this branch. */
	inSync: boolean;
}

/**
 * Make the local branch and its GitHub branch the same: bring in remote
 * commits (fast-forward only), then send local commits (no force). Anything
 * that would need a merge, a rebase or discarding work is reported instead.
 */
export function syncWithRemote(worktree: string): SyncResult {
	const before = remoteStatus(worktree, { fetch: true });
	const pull: UpdateResult =
		before.upstream && before.behind > 0
			? fastForward(worktree)
			: { outcome: "up-to-date" };
	const push: PushResult =
		pull.outcome === "blocked"
			? { outcome: "up-to-date" }
			: pushToUpstream(worktree);
	const after = remoteStatus(worktree, { fetch: false });
	return {
		pull,
		push,
		inSync: !!after.upstream && after.ahead === 0 && after.behind === 0,
	};
}

/**
 * Connect a local repository to a GitHub (or any git) remote as origin. The
 * remote must be empty or share history with this repository; unrelated
 * histories are refused and nothing is left behind.
 */
export function connectRemote(
	worktree: string,
	url: string,
): { connected: string; tracking: string | null; remoteEmpty: boolean } {
	const git = gitIn(worktree);
	if (!git(["rev-parse", "--is-inside-work-tree"]).ok) {
		throw new Error("This folder is not a git repository");
	}
	const existing = git(["remote", "get-url", "origin"]);
	if (existing.ok) {
		throw new Error(`Already connected to ${existing.stdout}`);
	}
	if (!/^(https:\/\/|git@|ssh:\/\/)/.test(url.trim())) {
		throw new Error("Use an https:// or git@ repository URL");
	}
	const added = git(["remote", "add", "origin", url.trim()]);
	if (!added.ok) throw new Error(firstLine(added.stderr));
	const undo = (reason: string): never => {
		git(["remote", "remove", "origin"]);
		throw new Error(reason);
	};
	const fetched = git(["fetch", "--quiet", "origin"], 120_000);
	if (!fetched.ok) {
		undo(`Could not reach ${url.trim()}: ${firstLine(fetched.stderr)}`);
	}
	const heads = git(["ls-remote", "--heads", "origin"]).stdout.trim();
	const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
	if (!heads)
		return { connected: url.trim(), tracking: null, remoteEmpty: true };
	const remoteBranches = heads
		.split("\n")
		.map((line) => line.split(/\s+/)[1]?.replace(/^refs\/heads\//, ""))
		.filter((b): b is string => !!b);
	const related = remoteBranches.some(
		(b) => git(["merge-base", "HEAD", `origin/${b}`]).ok,
	);
	if (!related) {
		undo(
			"That repository has a different history from this one (no common commits). Choose the matching GitHub repository, or an empty one.",
		);
	}
	if (branch !== "HEAD" && remoteBranches.includes(branch)) {
		git(["branch", `--set-upstream-to=origin/${branch}`, branch]);
		return {
			connected: url.trim(),
			tracking: `origin/${branch}`,
			remoteEmpty: false,
		};
	}
	return { connected: url.trim(), tracking: null, remoteEmpty: false };
}
