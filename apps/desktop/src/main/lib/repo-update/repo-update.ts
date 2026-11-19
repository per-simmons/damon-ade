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
