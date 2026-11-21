import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureProjectWorkflow,
	projectWorkflowFor,
} from "main/lib/agent-workflow/project-workflow";
import { createTask, getTask, saveTask } from "main/lib/agent-workflow/tasks";
import { moveWorkflowRecord, relocateRepository } from "./team-relocate";

const root = mkdtempSync(join(tmpdir(), "ade-relocate-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(r.stderr);
	return r.stdout.trim();
}

/** A team repository with one agent worktree in a folder of its own. */
function team(name: string) {
	const repo = join(root, "projects", name);
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@example.com");
	git(repo, "config", "user.name", "T");
	writeFileSync(join(repo, "README.md"), "# app\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "init");
	const agent = join(root, "agents", name, "worktree");
	mkdirSync(join(root, "agents", name), { recursive: true });
	git(repo, "worktree", "add", "-q", "-b", "agent/ui", agent);
	return { repo, agent };
}

describe("changing a team's folder", () => {
	it("moves the repository into another folder and keeps its agents linked", () => {
		const { repo, agent } = team("move-me");
		const dest = join(root, "elsewhere");
		mkdirSync(dest);
		const to = relocateRepository({
			from: repo,
			target: dest,
			mode: "move",
			agentWorktrees: [agent],
		});
		expect(to).toBe(join(dest, "move-me"));
		expect(existsSync(repo)).toBe(false);
		// The agent still works, and the repository knows where it is.
		expect(git(agent, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/ui");
		expect(git(agent, "status", "--porcelain")).toBe("");
		expect(git(to, "worktree", "list").replace(/\\/g, "/")).toContain(
			agent.replace(/\\/g, "/"),
		);
		// A commit in the agent's folder is on the moved repository's branch.
		writeFileSync(join(agent, "ui.txt"), "x\n");
		git(agent, "add", "-A");
		git(agent, "commit", "-qm", "ui");
		expect(git(to, "log", "-1", "--format=%s", "agent/ui")).toBe("ui");
	});

	it("re-links a repository the user moved, and refuses wrong targets", () => {
		const { repo, agent } = team("relink-me");
		const moved = join(root, "moved-by-hand");
		renameSync(repo, moved);
		expect(() =>
			relocateRepository({
				from: repo,
				target: root,
				mode: "relink",
				agentWorktrees: [agent],
			}),
		).toThrow("has no .git");
		const to = relocateRepository({
			from: repo,
			target: moved,
			mode: "relink",
			agentWorktrees: [agent],
		});
		expect(to).toBe(moved);
		expect(git(agent, "status", "--porcelain")).toBe("");
		// Moving a folder that is no longer there, or into itself, is refused.
		expect(() =>
			relocateRepository({
				from: repo,
				target: root,
				mode: "move",
				agentWorktrees: [],
			}),
		).toThrow("no longer at");
		expect(() =>
			relocateRepository({
				from: moved,
				target: join(moved, "sub"),
				mode: "move",
				agentWorktrees: [],
			}),
		).toThrow("outside the team's own folder");
	});

	it("carries the team's tasks and specialists to the new folder's record", () => {
		const home = join(root, "home");
		const from = join(root, "old-place", "shop");
		const to = join(root, "new-place", "shop");
		const before = ensureProjectWorkflow(home, from);
		writeFileSync(join(before.dir, "specialists.json"), "[]\n");
		const task = createTask(before, {
			description: "Fix the cart",
			mode: "manual",
			identity: { workspaceId: "w", worktreePath: from, baselineDirty: {} },
			limits: {
				budgetUsd: 1,
				maxCorrections: 1,
				maxReviewRounds: 1,
				maxEscalations: 0,
			},
		});
		saveTask(before, task);
		moveWorkflowRecord(home, from, to);
		const after = projectWorkflowFor(home, to);
		expect(existsSync(before.dir)).toBe(false);
		expect(existsSync(join(after.dir, "specialists.json"))).toBe(true);
		expect(getTask(after, task.slug)?.identity.worktreePath).toBe(after.root);
	});
});
