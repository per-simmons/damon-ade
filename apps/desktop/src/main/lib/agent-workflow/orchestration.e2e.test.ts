import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";

/**
 * End to end, without calling a model: ADE's real claude wrapper script runs
 * in bash in front of a fake `claude` that records its arguments. Covers a
 * project ADE did not create and a newly scaffolded ADE agent.
 */

const TEST_HOME = mkdtempSync(join(tmpdir(), "ade-e2e-home-"));
process.env.ADE_HOME_DIR = TEST_HOME;

mock.module("shared/env.shared", () => ({
	env: { DESKTOP_NOTIFICATIONS_PORT: 7777, NODE_ENV: "test" },
	getWorkspaceName: () => undefined,
}));

const bash = Bun.which("bash");
const usableBash = bash !== null && !/System32/i.test(bash);

let root: string;
let wrapperBin: string;
let realBin: string;
let argsFile: string;
let settingsPath: string;

/** Every file under `dir` (except .git) with its content. */
function snapshot(dir: string): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (current: string) => {
		for (const name of readdirSync(current)) {
			if (name === ".git") continue;
			const path = join(current, name);
			if (statSync(path).isDirectory()) walk(path);
			else files[relative(dir, path)] = readFileSync(path, "utf8");
		}
	};
	walk(dir);
	return files;
}

/** Run `script` in bash with ADE's wrapper on PATH; returns claude's argv. */
function runClaude(
	script: string,
	cwd: string,
	env: Record<string, string>,
): string[] {
	rmSync(argsFile, { force: true });
	const result = spawnSync(bash as string, ["-c", script], {
		cwd,
		env: {
			...process.env,
			...env,
			PATH: `${wrapperBin}${delimiter}${realBin}${delimiter}${process.env.PATH ?? ""}`,
			FAKE_CLAUDE_OUT: argsFile,
		},
		encoding: "utf8",
	});
	if (result.status !== 0) throw new Error(result.stderr);
	return readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
}

function flag(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
}

let workflowEnvFor: typeof import("./workflow-env").workflowEnvFor;
let createTask: typeof import("./tasks").createTask;
let listTaskRecords: typeof import("./tasks").listTaskRecords;
let captureIdentity: typeof import("./identity").captureIdentity;
let projectWorkflowFor: typeof import("./project-workflow").projectWorkflowFor;

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "ade-e2e-"));
	wrapperBin = join(root, "ade-bin");
	realBin = join(root, "real-bin");
	argsFile = join(root, "argv.bin");
	mkdirSync(wrapperBin, { recursive: true });
	mkdirSync(realBin, { recursive: true });

	// Stand-in for the real Claude Code: records each argument.
	writeFileSync(
		join(realBin, "claude"),
		'#!/usr/bin/env bash\n: > "$FAKE_CLAUDE_OUT"\nfor a in "$@"; do printf \'%s\\0\' "$a" >> "$FAKE_CLAUDE_OUT"; done\n',
		{ encoding: "utf8", mode: 0o755 },
	);

	// ADE's own wrapper, exactly as agent-setup writes it.
	const { buildWrapperScript } = await import(
		"../agent-setup/agent-wrappers-common"
	);
	const { buildClaudeExecLine } = await import(
		"../agent-setup/agent-wrappers-claude-codex"
	);
	settingsPath = `${TEST_HOME.replace(/\\/g, "/")}/hooks/claude-settings.json`;
	writeFileSync(
		join(wrapperBin, "claude"),
		buildWrapperScript("claude", buildClaudeExecLine(settingsPath)),
		{ encoding: "utf8", mode: 0o755 },
	);

	({ workflowEnvFor } = await import("./workflow-env"));
	({ createTask, listTaskRecords } = await import("./tasks"));
	({ captureIdentity } = await import("./identity"));
	({ projectWorkflowFor } = await import("./project-workflow"));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(TEST_HOME, { recursive: true, force: true });
});

describe.if(usableBash)("multi-model workflow in any project", () => {
	let existing: string;
	let before: Record<string, string>;

	beforeAll(() => {
		// A project ADE did not create, with its own Claude configuration.
		existing = join(root, "existing-shop");
		mkdirSync(join(existing, "src"), { recursive: true });
		mkdirSync(join(existing, ".claude", "agents"), { recursive: true });
		writeFileSync(join(existing, "src", "cart.ts"), "export {};\n", "utf8");
		writeFileSync(join(existing, "CLAUDE.md"), "# Shop rules\n", "utf8");
		writeFileSync(
			join(existing, ".claude", "agents", "my-helper.md"),
			"---\nname: my-helper\ndescription: mine\n---\nHelp.\n",
			"utf8",
		);
		spawnSync("git", ["init", "-q"], { cwd: existing });
		before = snapshot(existing);
	});

	it("gives an ordinary claude session in an existing project the workflow roles", () => {
		const env = workflowEnvFor(TEST_HOME, { rootPath: existing });
		expect(env).not.toBeNull();
		const argv = runClaude(
			'claude "fix the checkout bug"',
			existing,
			env ?? {},
		);

		const tasksDir = flag(argv, "--add-dir");
		const project = projectWorkflowFor(TEST_HOME, existing);
		expect(tasksDir).toBe(project.tasksDir.replace(/\\/g, "/"));
		const agents = JSON.parse(flag(argv, "--agents") ?? "{}");
		// ADE's roles are namespaced: the project's own agents (my-helper, or
		// one it might call "reviewer") keep their names and definitions.
		expect(Object.keys(agents).sort()).toEqual([
			"ade-architect",
			"ade-implementer",
			"ade-planner",
			"ade-quick",
			"ade-reviewer",
		]);
		expect(agents["ade-planner"].model).toBe("opus");
		expect(agents["ade-architect"].model).toBe("fable");
		expect(agents["ade-implementer"].prompt).toContain(tasksDir);
		// ADE's hooks are still passed, and the user's prompt arrives last.
		expect(flag(argv, "--settings")).toBe(settingsPath);
		expect(argv[argv.length - 1]).toBe("fix the checkout bug");
	});

	it("keeps a task's files in ADE's project folder, not in the repository", () => {
		const project = projectWorkflowFor(TEST_HOME, existing);
		const task = createTask(project, {
			description: "Refactor the cart and migrate its database schema",
			identity: captureIdentity("ws-shop", existing),
			limits: {
				budgetUsd: 10,
				maxCorrections: 2,
				maxReviewRounds: 3,
				maxEscalations: 2,
			},
		});
		expect(task.route).toBe("plan");
		expect(task.mode).toBe("auto");
		expect(task.identity.worktreePath).toBe(existing);
		expect(existsSync(join(project.tasksDir, task.slug, "task.json"))).toBe(
			true,
		);
	});

	it("leaves the existing project's files exactly as they were", () => {
		expect(snapshot(existing)).toEqual(before);
	});

	it("does not add workflow flags to claude subcommands", () => {
		const env = workflowEnvFor(TEST_HOME, { rootPath: existing }) ?? {};
		expect(runClaude("claude update", existing, env)).toEqual([
			"--settings",
			settingsPath,
			"update",
		]);
		expect(runClaude("claude mcp list", existing, env)).toEqual([
			"--settings",
			settingsPath,
			"mcp",
			"list",
		]);
	});

	it("runs plain claude unchanged outside an ADE project", () => {
		expect(runClaude('claude "hi"', existing, {})).toEqual([
			"--settings",
			settingsPath,
			"hi",
		]);
	});

	it("gives a newly created ADE agent its own, separate workflow", async () => {
		const { setupAgentRepo } = await import("../agent-repo");
		const { scaffoldAgentMemory } = await import("../agent-scaffold");
		const { getAgentWorktreePath } = await import("../agent-home");
		await setupAgentRepo({ agentId: "e2e-agent", source: { type: "init" } });
		scaffoldAgentMemory({
			agentId: "e2e-agent",
			agentName: "Testy",
			runtime: "claude",
			userName: "Pat",
		});
		const worktree = getAgentWorktreePath("e2e-agent");

		// Agent categories have no repo of their own, so the worktree is the root.
		const env = workflowEnvFor(TEST_HOME, {
			rootPath: "",
			workspacePath: worktree,
		});
		const argv = runClaude(
			'claude "write the weekly summary"',
			worktree,
			env ?? {},
		);
		const agentProject = projectWorkflowFor(TEST_HOME, worktree);
		expect(flag(argv, "--add-dir")).toBe(
			agentProject.tasksDir.replace(/\\/g, "/"),
		);
		expect(agentProject.key).not.toBe(
			projectWorkflowFor(TEST_HOME, existing).key,
		);

		// No workflow files in the agent's repository, and no tasks shared.
		expect(existsSync(join(worktree, ".claude", "agents"))).toBe(false);
		expect(existsSync(join(worktree, ".ade"))).toBe(false);
		expect(listTaskRecords(agentProject)).toHaveLength(0);
		expect(
			listTaskRecords(projectWorkflowFor(TEST_HOME, existing)),
		).toHaveLength(1);
	});
});
