import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Association } from "./types";

/**
 * Which repository a folder belongs to, from git itself: the shared git
 * directory (identical for a repository and all its worktrees) and the
 * remote. Names are never compared, so two projects called "shop" and
 * "shop-api", or two folders both called "app", are never confused.
 */

export interface RepoIdentity {
	/** The folder exists. */
	exists: boolean;
	/** Top of the working tree. */
	toplevel?: string;
	/** The repository's shared .git directory (normalized). */
	commonDir?: string;
	/** The fetch remote ("origin" first), normalized as host/owner/repo. */
	remote?: string;
	/** The remote as configured, for display. */
	remoteUrl?: string;
}

function git(cwd: string, args: string[]): string | undefined {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		windowsHide: true,
		timeout: 10_000,
	});
	return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Path comparison key: resolved, no trailing separator, case-folded on Windows. */
export function pathKey(path: string): string {
	const resolved = resolve(path).replace(/[\\/]+$/, "");
	return process.platform === "win32"
		? resolved.toLowerCase().replace(/\//g, "\\")
		: resolved;
}

/** Whether `child` is `parent` or inside it. */
export function isWithin(child: string, parent: string): boolean {
	const c = pathKey(child);
	const p = pathKey(parent);
	return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * host/owner/repo for a git remote URL, lowercase (GitHub names are
 * case-insensitive): https, ssh and scp-like forms all agree.
 */
export function normalizeRemote(url: string): string | undefined {
	const trimmed = url.trim();
	if (!trimmed) return undefined;
	let host: string;
	let path: string;
	const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(trimmed);
	if (scp && !/^[a-z]+:\/\//i.test(trimmed)) {
		host = scp[1];
		path = scp[2];
	} else {
		try {
			const parsed = new URL(trimmed);
			host = parsed.hostname;
			path = parsed.pathname;
		} catch {
			return undefined;
		}
	}
	const clean = path
		.replace(/^\/+/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "");
	if (!host || !clean) return undefined;
	return `${host}/${clean}`.toLowerCase();
}

export function repoIdentity(folder: string): RepoIdentity {
	if (!existsSync(folder)) return { exists: false };
	const toplevel = git(folder, ["rev-parse", "--show-toplevel"]);
	if (!toplevel) return { exists: true };
	const common = git(folder, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	const remotes = (git(folder, ["remote"]) ?? "").split(/\s+/).filter(Boolean);
	const name = remotes.includes("origin") ? "origin" : remotes[0];
	const remoteUrl = name ? git(folder, ["remote", "get-url", name]) : undefined;
	return {
		exists: true,
		toplevel: resolve(toplevel),
		commonDir: common ? pathKey(common) : undefined,
		remote: remoteUrl ? normalizeRemote(remoteUrl) : undefined,
		remoteUrl,
	};
}

export interface RepoMatch {
	association: Exclude<Association, "user-confirmed"> | null;
	reason: string;
}

/**
 * Whether a session folder belongs to a project. A folder that no longer
 * exists can only match by path (inside the project root).
 */
export function matchRepository(
	project: { root: string; identity: RepoIdentity },
	folder: string | undefined,
	folderIdentity: RepoIdentity | undefined,
): RepoMatch {
	if (!folder) {
		return { association: null, reason: "The session has no working folder" };
	}
	const theirs = folderIdentity ?? repoIdentity(folder);
	const ours = project.identity;
	if (!theirs.exists) {
		return isWithin(folder, project.root)
			? {
					association: "path",
					reason: "Its folder no longer exists, but it was inside this project",
				}
			: {
					association: null,
					reason: "Its folder no longer exists and was outside this project",
				};
	}
	if (
		theirs.commonDir &&
		ours.commonDir &&
		theirs.commonDir === ours.commonDir
	) {
		return {
			association: "same-repository",
			reason:
				theirs.toplevel && pathKey(theirs.toplevel) !== pathKey(project.root)
					? "Same repository (another worktree)"
					: "Same repository",
		};
	}
	if (theirs.remote && ours.remote && theirs.remote === ours.remote) {
		return {
			association: "same-remote",
			reason: `Another clone of ${theirs.remote}`,
		};
	}
	if (!theirs.commonDir) {
		return isWithin(folder, project.root)
			? { association: "path", reason: "Inside this project's folder" }
			: { association: null, reason: "Not a git repository" };
	}
	return {
		association: null,
		reason: theirs.remote
			? `A different repository (${theirs.remote})`
			: "A different repository",
	};
}
