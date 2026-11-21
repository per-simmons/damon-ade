import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checksPassed,
	loadProjectChecks,
	saveProjectChecks,
	suggestChecks,
} from "./checks";
import {
	branchChange,
	captureIdentity,
	codeState,
	currentBranch,
	identityMismatch,
	taskChanges,
} from "./identity";
import { ensureProjectWorkflow } from "./project-workflow";
import type { TaskRecord } from "./tasks";

const git = Bun.which("git");
let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "ade-identity-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function repo(name: string): string {
	const dir = join(root, name);
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src", "a.ts"), "a\n");
	writeFileSync(join(dir, "src", "b.ts"), "b\n");
	for (const args of [
		["init", "-q"],
		["config", "user.email", "t@example.com"],
		["config", "user.name", "T"],
		["add", "-A"],
		["commit", "-qm", "init"],
	]) {
		spawnSync(git as string, args, { cwd: dir });
	}
	return dir;
}

describe.if(git !== null)("task identity and changes", () => {
	it("separates the task's changes from edits made before it started", () => {
		const dir = repo("changes");
		writeFileSync(join(dir, "src", "a.ts"), "a, edited before the task\n");
		writeFileSync(join(dir, "notes.txt"), "untracked before\n");
		const identity = captureIdentity("ws", dir);
		expect(identity.branch).toBeDefined();
		expect(identity.baselineHead).toMatch(/^[0-9a-f]{40}$/);
		expect(Object.keys(identity.baselineDirty).sort()).toEqual([
			"notes.txt",
			"src/a.ts",
		]);

		// The task edits b.ts, adds c.ts, and edits a.ts further.
		writeFileSync(join(dir, "src", "b.ts"), "b, by the task\n");
		writeFileSync(join(dir, "src", "c.ts"), "new\n");
		expect(taskChanges(identity)).toEqual({
			files: ["src/b.ts", "src/c.ts"],
			preexisting: ["notes.txt", "src/a.ts"],
			tracked: true,
		});
		writeFileSync(join(dir, "src", "a.ts"), "a, edited by the task too\n");
		expect(taskChanges(identity).files).toContain("src/a.ts");

		// A commit made during the task still counts as the task's change.
		spawnSync(git as string, ["add", "src/c.ts"], { cwd: dir });
		spawnSync(git as string, ["commit", "-qm", "c"], { cwd: dir });
		expect(taskChanges(identity).files).toContain("src/c.ts");
	});

	it("flags a task opened from another worktree", () => {
		const dir = repo("mismatch");
		const task = {
			identity: captureIdentity("ws-a", dir),
		} as TaskRecord;
		expect(identityMismatch(task, "ws-a", dir)).toBeUndefined();
		expect(identityMismatch(task, "ws-b", join(root, "elsewhere"))).toContain(
			"belongs to",
		);
	});

	it("detects a branch switch in the same worktree", () => {
		const dir = repo("branches");
		const identity = captureIdentity("ws", dir);
		const task = { identity } as TaskRecord;
		expect(
			identityMismatch(task, "ws", dir, currentBranch(dir)),
		).toBeUndefined();
		spawnSync(git as string, ["checkout", "-q", "-b", "other"], { cwd: dir });
		expect(currentBranch(dir)).toBe("other");
		expect(identityMismatch(task, "ws", dir, currentBranch(dir))).toContain(
			"now on other",
		);
		expect(branchChange(identity, "other")).toContain("Switch back");
	});

	it("fingerprints the code: edits, new files and commits change it", () => {
		const dir = repo("state");
		const first = codeState(dir);
		expect(first).toMatch(/^[0-9a-f]{32}$/);
		expect(codeState(dir)).toBe(first);
		writeFileSync(join(dir, "src", "a.ts"), "changed\n");
		const edited = codeState(dir);
		expect(edited).not.toBe(first);
		writeFileSync(join(dir, "src", "new.ts"), "x\n");
		expect(codeState(dir)).not.toBe(edited);
		expect(codeState(join(root, "not-a-repo-anywhere"))).toBeUndefined();
	});

	it("reports a folder that is not a git repository as untracked", () => {
		const dir = join(root, "plain");
		mkdirSync(dir, { recursive: true });
		const identity = captureIdentity("ws", dir);
		expect(taskChanges(identity)).toEqual({
			files: [],
			preexisting: [],
			tracked: false,
		});
	});
});

describe("project checks", () => {
	it("suggests commands from package.json and stores approval outside the repo", () => {
		const dir = join(root, "pkg");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ scripts: { test: "x", lint: "y", dev: "z" } }),
		);
		writeFileSync(join(dir, "bun.lock"), "");
		expect(suggestChecks(dir)).toEqual(["bun run lint", "bun run test"]);

		const home = join(root, "home");
		const project = ensureProjectWorkflow(home, dir);
		expect(loadProjectChecks(project).approvedAt).toBeUndefined();
		const saved = saveProjectChecks(project, [" bun run test ", ""]);
		expect(saved.commands).toEqual(["bun run test"]);
		expect(saved.approvedAt).toBeDefined();
		expect(() => saveProjectChecks(project, ["a\nb"])).toThrow();
	});

	it("passes only when every expected check ran and passed", () => {
		const ok = {
			command: "a",
			exitCode: 0,
			timedOut: false,
			durationMs: 1,
			outputTail: "",
		};
		expect(checksPassed([ok, ok], 2)).toBe(true);
		expect(checksPassed([ok], 2)).toBe(false);
		expect(checksPassed([{ ...ok, timedOut: true }], 1)).toBe(false);
		expect(checksPassed([{ ...ok, exitCode: 1 }], 1)).toBe(false);
	});
});
