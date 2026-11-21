import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "ade-repo-update-home-"));
process.env.ADE_HOME_DIR = HOME;
const root = mkdtempSync(join(tmpdir(), "ade-repo-update-router-"));
const git = Bun.which("git");

function sh(cwd: string, ...args: string[]) {
	const result = spawnSync(git as string, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(HOME, { recursive: true, force: true });
});

describe.if(git !== null)("repoUpdate router", () => {
	it("waits while a task is running in the same worktree", async () => {
		const { ensureProjectWorkflow, createTask, saveTask } = await import(
			"main/lib/agent-workflow"
		);
		const { createRepoUpdateRouter } = await import("./repo-update");

		const remote = join(root, "remote.git");
		sh(root, "init", "-q", "--bare", "-b", "main", remote);
		const seed = join(root, "seed");
		sh(root, "clone", "-q", remote, seed);
		sh(seed, "config", "user.email", "t@example.com");
		sh(seed, "config", "user.name", "T");
		sh(seed, "checkout", "-q", "-b", "main");
		writeFileSync(join(seed, "a.txt"), "1\n");
		sh(seed, "add", "-A");
		sh(seed, "commit", "-qm", "1");
		sh(seed, "push", "-q", "-u", "origin", "main");
		const mine = join(root, "mine");
		sh(root, "clone", "-q", remote, mine);
		writeFileSync(join(seed, "a.txt"), "2\n");
		sh(seed, "commit", "-qam", "2");
		sh(seed, "push", "-q");

		const project = ensureProjectWorkflow(HOME, mine);
		const caller = createRepoUpdateRouter({
			resolveWorkspace: (workspaceId) => ({
				workspaceId,
				project,
				worktreePath: mine,
				runtime: "claude",
			}),
		}).createCaller({});

		expect(
			(await caller.status({ workspaceId: "w", fetch: true })).behind,
		).toBe(1);

		const task = createTask(project, {
			description: "Busy task",
			identity: { workspaceId: "w", worktreePath: mine, baselineDirty: {} },
			limits: {
				budgetUsd: 1,
				maxCorrections: 1,
				maxReviewRounds: 1,
				maxEscalations: 1,
			},
		});
		saveTask(project, { ...task, state: "running" });
		const blocked = await caller.update({ workspaceId: "w" });
		expect(blocked.outcome).toBe("blocked");
		expect(blocked.outcome === "blocked" && blocked.reason).toContain(
			'Task "Busy task" is running in this worktree',
		);

		saveTask(project, { ...task, state: "done" });
		expect((await caller.update({ workspaceId: "w" })).outcome).toBe("updated");
		expect(
			(await caller.status({ workspaceId: "w", fetch: false })).behind,
		).toBe(0);
	});
});
