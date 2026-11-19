import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "ade-team-agent-home-"));
process.env.ADE_HOME_DIR = HOME;
const root = mkdtempSync(join(tmpdir(), "ade-team-agent-"));
const git = Bun.which("git");

function sh(cwd: string, ...args: string[]) {
	const r = spawnSync(git as string, args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(r.stderr);
	return r.stdout.trim();
}

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(HOME, { recursive: true, force: true });
});

describe.if(git !== null)("a team agent inherits the team's repository", () => {
	it("gets its own worktree and branch of the team repo, and no ADE files in it", async () => {
		const { setupAgentRepo } = await import("./agent-repo");
		const { scaffoldAgentMemory } = await import("./agent-scaffold");
		const { agentBranchName, teamWorktreeSource } = await import(
			"./agent-init"
		);
		const repo = join(root, "shop");
		spawnSync(git as string, ["init", "-q", "-b", "main", repo]);
		sh(repo, "config", "user.email", "t@example.com");
		sh(repo, "config", "user.name", "T");
		writeFileSync(join(repo, "app.js"), "v1\n");
		sh(repo, "add", "-A");
		sh(repo, "commit", "-qm", "init");
		writeFileSync(join(repo, "wip.txt"), "team checkout work\n");

		const team = {
			mainRepoPath: repo,
			workspaceBaseBranch: null,
			defaultBranch: "main",
		};
		const ids = ["11111111-aaaa", "22222222-bbbb"];
		const made = [];
		for (const id of ids) {
			const branch = agentBranchName("Builder", id);
			const result = await setupAgentRepo({
				agentId: id,
				source: teamWorktreeSource(team, branch),
			});
			scaffoldAgentMemory({
				agentId: id,
				agentName: "Builder",
				runtime: "claude",
				worktreePath: result.worktreePath,
				writeBridges: false,
			});
			made.push(result);
		}
		const [a, b] = made;
		expect(a.branch).toBe("ade/builder-111111");
		expect(b.branch).toBe("ade/builder-222222");
		// Separate folders, same repository (shared git dir), team files present.
		expect(resolve(a.worktreePath)).not.toBe(resolve(b.worktreePath));
		const common = (p: string) =>
			resolve(p, sh(p, "rev-parse", "--git-common-dir"));
		expect(common(a.worktreePath)).toBe(common(repo));
		expect(
			readFileSync(join(a.worktreePath, "app.js"), "utf8").replace(
				/\r\n/g,
				"\n",
			),
		).toBe("v1\n");
		expect(sh(a.worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
			a.branch,
		);
		// No clone, no new repository, no ADE files in the repository.
		expect(sh(repo, "worktree", "list").split("\n")).toHaveLength(3);
		for (const f of ["CLAUDE.md", ".claude"]) {
			expect(existsSync(join(a.worktreePath, f))).toBe(false);
			expect(existsSync(join(repo, f))).toBe(false);
		}
		expect(existsSync(join(HOME, "agents", ids[0], "memory", "AGENT.md"))).toBe(
			true,
		);
		// The team's own checkout is untouched.
		expect(sh(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
		expect(readFileSync(join(repo, "wip.txt"), "utf8")).toBe(
			"team checkout work\n",
		);
		// A retry reuses the existing worktree.
		const again = await setupAgentRepo({
			agentId: ids[0],
			source: teamWorktreeSource(team, a.branch),
		});
		expect(resolve(again.worktreePath)).toBe(resolve(a.worktreePath));
	});
});
