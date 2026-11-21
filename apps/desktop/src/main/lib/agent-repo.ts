import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import simpleGit from "simple-git";
import {
	getAgentHome,
	getAgentMemoryDir,
	getAgentWorktreePath,
} from "./agent-home";

/**
 * How an agent's working folder is populated at creation time.
 * - team:  a git worktree of the team's repository on the agent's own branch
 *          (one team = one repository; agents never get repositories of
 *          their own)
 * - init:  a fresh empty git repo (`git init` + empty initial commit); only
 *          for agents of teams created before teams had a repository
 * - clone: clone a remote URL or a local path into the worktree (legacy)
 */
export type AgentRepoSource =
	| { type: "team"; repoPath: string; branch: string; startPoint: string }
	| { type: "init" }
	| { type: "clone"; url: string };

export interface AgentRepoResult {
	agentHome: string;
	worktreePath: string;
	memoryDir: string;
	branch: string;
}

/**
 * Build an Agent's standalone repo + home layout on disk (ADE Phase B, risk #1).
 *
 * Unlike the shared-repo model (`git worktree add` off a project's
 * mainRepoPath), each ADE agent owns its OWN git repo at
 * <agent-home>/worktree. The canonical `memory/` dir is created as a sibling
 * (templates are written later, in the Phase E scaffolder). Returns the paths
 * and the checked-out branch so the caller can persist a `worktrees` row.
 */
export async function setupAgentRepo({
	agentId,
	source,
}: {
	agentId: string;
	source: AgentRepoSource;
}): Promise<AgentRepoResult> {
	const agentHome = getAgentHome(agentId);
	const worktreePath = getAgentWorktreePath(agentId);
	const memoryDir = getAgentMemoryDir(agentId);

	// Create the memory dir (this also creates <agent-home>). worktree/ is
	// created below by init/clone.
	mkdirSync(memoryDir, { recursive: true });

	// Retry-safety: if a valid repo already exists (previous attempt got this
	// far), reuse it. If a partial/non-repo dir exists, clear it so init/clone
	// starts clean.
	if (existsSync(join(worktreePath, ".git"))) {
		const branch =
			(
				await simpleGit(worktreePath)
					.revparse(["--abbrev-ref", "HEAD"])
					.catch(() => "main")
			).trim() || "main";
		return { agentHome, worktreePath, memoryDir, branch };
	}
	if (existsSync(worktreePath)) {
		rmSync(worktreePath, { recursive: true, force: true });
	}

	let branch: string;
	if (source.type === "team") {
		// A worktree of the team's repository: the agent works on its own
		// branch in its own folder, so it never edits the team's checkout or
		// another agent's files. Nothing is cloned or created elsewhere.
		const repo = simpleGit(source.repoPath);
		// Forget registrations of worktree folders that no longer exist.
		await repo.raw(["worktree", "prune"]).catch(() => undefined);
		// A retry after a partial attempt reuses the branch it created.
		const branchExists = await repo
			.raw(["rev-parse", "--verify", "--quiet", `refs/heads/${source.branch}`])
			.then((out) => out.trim().length > 0)
			.catch(() => false);
		// Start from the team's base branch if it exists locally, else from the
		// repository's current HEAD.
		const startPoint = await repo
			.raw([
				"rev-parse",
				"--verify",
				"--quiet",
				`${source.startPoint}^{commit}`,
			])
			.then((out) => (out.trim() ? source.startPoint : "HEAD"))
			.catch(() => "HEAD");
		await repo.raw(
			branchExists
				? ["worktree", "add", worktreePath, source.branch]
				: [
						"worktree",
						"add",
						"-b",
						source.branch,
						worktreePath,
						`${startPoint}^{commit}`,
					],
		);
		branch = source.branch;
	} else if (source.type === "clone") {
		await simpleGit().clone(source.url, worktreePath);
		branch =
			(await simpleGit(worktreePath)
				.revparse(["--abbrev-ref", "HEAD"])
				.catch(() => "main")) || "main";
		branch = branch.trim();
	} else {
		mkdirSync(worktreePath, { recursive: true });
		const git = simpleGit(worktreePath);
		try {
			await git.init(["--initial-branch=main"]);
		} catch {
			await git.init();
		}
		// Set a local identity so the empty initial commit works even when the
		// machine has no global git user configured. Fresh agent repos are
		// standalone, so a local identity is appropriate.
		await git.addConfig("user.name", "ADE Agent", false, "local");
		await git.addConfig("user.email", "agent@ade.local", false, "local");
		await git.raw(["commit", "--allow-empty", "-m", "Initial commit"]);
		branch =
			(await git.revparse(["--abbrev-ref", "HEAD"]).catch(() => "main")) ||
			"main";
		branch = branch.trim();
	}

	return { agentHome, worktreePath, memoryDir, branch };
}
