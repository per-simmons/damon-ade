import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
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
import { join, relative } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Acceptance, from the application boundary: the workflow tRPC router (what
 * the Tasks panel calls) with the real TaskController, the real `claude -p`
 * runner and real check commands, against real git repositories. Only the
 * model is fake: a script that plays a scenario. Guards fail the test if a
 * real claude/codex would run or the network would be reached.
 *
 * Nothing here clicks Build or Review: Auto tasks go from one request to a
 * verified finish (or a stated stop) on their own.
 */

const TEST_HOME = mkdtempSync(join(tmpdir(), "ade-accept-home-"));
process.env.ADE_HOME_DIR = TEST_HOME;

const bashPath = Bun.which("bash");
const bash = bashPath && !/System32/i.test(bashPath) ? bashPath : null;
const git = Bun.which("git");

type Modules = {
	router: typeof import("./workflow");
	controller: typeof import("main/lib/agent-workflow/controller");
	runner: typeof import("main/lib/agent-workflow/stage-runner");
	checks: typeof import("main/lib/agent-workflow/checks");
	identity: typeof import("main/lib/agent-workflow/identity");
	project: typeof import("main/lib/agent-workflow/project-workflow");
	settings: typeof import("main/lib/agent-workflow/workflow-settings");
	tasks: typeof import("main/lib/agent-workflow/tasks");
	fake: typeof import("main/lib/agent-workflow/testing/fake-claude");
	treeKill: typeof import("main/lib/tree-kill");
	panel: typeof import("renderer/screens/main/components/WorkspaceView/ContentView/ModelBar/components/TasksSheet/components/TasksPanelView");
};

let m: Modules;
let root: string;
let fake: import("main/lib/agent-workflow/testing/fake-claude").FakeClaude;
let restoreNetwork: () => void;
let controller: import("main/lib/agent-workflow/controller").TaskController;
let caller: ReturnType<
	ReturnType<typeof import("./workflow").createWorkflowRouter>["createCaller"]
>;
const workspaces = new Map<string, { root: string; worktree: string }>();
let claudeFound = true;

const CHECK = `"${process.execPath.replace(/\\/g, "/")}" check.js`;

function sh(cwd: string, ...args: string[]) {
	const result = spawnSync(git as string, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

/** An existing repo with its own rules and its own "reviewer" agent. */
function makeRepo(name: string): string {
	const dir = join(root, name);
	mkdirSync(join(dir, "src"), { recursive: true });
	mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
	writeFileSync(join(dir, "CLAUDE.md"), "# House rules\nUse tabs.\n");
	writeFileSync(
		join(dir, ".claude", "agents", "reviewer.md"),
		"---\nname: reviewer\ndescription: the team's own reviewer\n---\nReview.\n",
	);
	writeFileSync(join(dir, "src", "cart.js"), "export const total = 1;\n");
	writeFileSync(join(dir, "README.md"), "# Shop\nTeh shop.\n");
	// The project's check: fails while a file named BROKEN exists.
	writeFileSync(
		join(dir, "check.js"),
		'const fs = require("node:fs");\nif (fs.existsSync("BROKEN")) { console.log("cart.test: expected 2, got 1"); process.exit(1); }\nconsole.log("ok");\n',
	);
	sh(dir, "init", "-q");
	sh(dir, "config", "user.email", "test@example.com");
	sh(dir, "config", "user.name", "Test");
	sh(dir, "add", "-A");
	sh(dir, "commit", "-qm", "initial");
	return dir;
}

function addWorkspace(id: string, repoRoot: string, worktree = repoRoot) {
	workspaces.set(id, { root: repoRoot, worktree });
}

/** Every file under `dir` except .git. */
function snapshot(dir: string): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (current: string) => {
		for (const name of readdirSync(current)) {
			if (name === ".git") continue;
			const path = join(current, name);
			if (statSync(path).isDirectory()) walk(path);
			else
				files[relative(dir, path).replace(/\\/g, "/")] = readFileSync(
					path,
					"utf8",
				);
		}
	};
	walk(dir);
	return files;
}

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

async function settle() {
	await controller.idle();
}

function saveSettings(
	patch: (
		s: ReturnType<Modules["settings"]["defaultWorkflowSettings"]>,
	) => void,
) {
	const settings = m.settings.defaultWorkflowSettings();
	patch(settings);
	m.settings.saveWorkflowSettings(TEST_HOME, settings);
}

async function tasksOf(workspaceId: string) {
	return caller.getProjectTasks({ workspaceId });
}

async function taskOf(workspaceId: string, slug: string) {
	const data = await tasksOf(workspaceId);
	const task = data.tasks.find((t) => t.slug === slug);
	if (!task) throw new Error(`no task ${slug}`);
	return task;
}

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "ade-accept-"));
	m = {
		router: await import("./workflow"),
		controller: await import("main/lib/agent-workflow/controller"),
		runner: await import("main/lib/agent-workflow/stage-runner"),
		checks: await import("main/lib/agent-workflow/checks"),
		identity: await import("main/lib/agent-workflow/identity"),
		project: await import("main/lib/agent-workflow/project-workflow"),
		settings: await import("main/lib/agent-workflow/workflow-settings"),
		tasks: await import("main/lib/agent-workflow/tasks"),
		fake: await import("main/lib/agent-workflow/testing/fake-claude"),
		treeKill: await import("main/lib/tree-kill"),
		panel: await import(
			"renderer/screens/main/components/WorkspaceView/ContentView/ModelBar/components/TasksSheet/components/TasksPanelView"
		),
	};
	fake = m.fake.createFakeClaude(root);
	restoreNetwork = m.fake.blockNetwork();
	const spawnFn = m.fake.guardedSpawn(fake, bash ? [bash] : []);
	const killTree = async (pid: number) => {
		await m.treeKill.treeKillWithEscalation({ pid, escalationTimeoutMs: 1000 });
	};
	controller = new m.controller.TaskController({
		homeDir: TEST_HOME,
		loadSettings: () => m.settings.loadWorkflowSettings(TEST_HOME),
		resolveClaude: () => (claudeFound ? fake.command : null),
		startRun: (spec, onProgress) =>
			m.runner.startStageRun(spec, { spawnFn, killTree, onProgress }),
		runChecks: ({ cwd, commands, signal }) =>
			m.checks.runChecks({
				cwd,
				commands,
				signal,
				shell: [bash as string, "-c"],
				spawnFn,
				killTree,
			}),
		newId: randomUUID,
		now: () => new Date(),
		env: { ...process.env, ...fake.env },
		progressSaveIntervalMs: 0,
	});
	const router = m.router.createWorkflowRouter({
		homeDir: () => TEST_HOME,
		resolveWorkspace: (workspaceId) => {
			const ws = workspaces.get(workspaceId);
			if (!ws) throw new Error(`unknown workspace ${workspaceId}`);
			return {
				workspaceId,
				project: m.project.ensureProjectWorkflow(TEST_HOME, ws.root),
				worktreePath: ws.worktree,
				runtime: "claude",
			};
		},
		controller: () => controller,
		captureIdentity: m.identity.captureIdentity,
		events: new EventEmitter(),
	});
	caller = router.createCaller({});
});

afterAll(async () => {
	await controller?.shutdown();
	restoreNetwork?.();
	rmSync(root, { recursive: true, force: true });
	rmSync(TEST_HOME, { recursive: true, force: true });
});

describe.if(bash !== null && git !== null)("Auto mode, end to end", () => {
	it("imports an existing repo and takes one Auto request to a verified finish", async () => {
		saveSettings(() => {});
		const repo = makeRepo("shop");
		addWorkspace("ws-shop", repo);
		// Already changed before the task: the review must not blame the task.
		writeFileSync(join(repo, "README.md"), "# Shop\nWork in progress.\n");
		const before = snapshot(repo);

		await caller.setChecks({ workspaceId: "ws-shop", commands: [CHECK] });
		fake.setSteps([
			{
				name: "plan",
				write: {
					"{task}/plan.md":
						"# Plan\n\n## Steps\n1. Split the cart\n\n## Questions for the user\nNone\n",
				},
				cost: 0.3,
			},
			{
				name: "build",
				write: {
					"src/cart.js": "export const total = 2;\n",
					"{task}/progress.md": "Status: implemented\n",
				},
				cost: 0.2,
			},
			{ name: "review", text: "Checked the diff.\nVERDICT: PASS", cost: 0.05 },
		]);

		const created = await caller.createTask({
			workspaceId: "ws-shop",
			description: "Refactor the cart and migrate its database schema",
		});
		expect(created.mode).toBe("auto");
		expect(created.route).toBe("plan");
		await settle();

		const task = await taskOf("ws-shop", created.slug);
		expect(task.state).toBe("done");
		expect(task.stateReason).toContain(
			"the checks passed and the review passed",
		);
		expect(task.runs.map((r) => [r.kind, r.status, r.model])).toEqual([
			["plan", "succeeded", "claude-opus-5-5"],
			["build", "succeeded", "claude-sonnet-5-5"],
			["checks", "succeeded", null],
			["review", "succeeded", "claude-sonnet-5-5"],
		]);
		expect(task.runs[3].verdict).toBe("PASS");
		expect(fake.remainingSteps()).toBe(0);

		// Effort, turns and permissions are set on the processes that ran.
		const calls = fake.calls().slice(-3);
		expect(calls.map((c) => flag(c.args, "--effort"))).toEqual([
			"high",
			"medium",
			"medium",
		]);
		expect(calls.map((c) => flag(c.args, "--max-turns"))).toEqual([
			"30",
			"40",
			"25",
		]);
		for (const call of calls) {
			expect(flag(call.args, "--permission-mode")).toBe("acceptEdits");
			expect(call.args).not.toContain("--dangerously-skip-permissions");
			expect(call.cwd.replace(/\\/g, "/")).toBe(repo.replace(/\\/g, "/"));
			// ADE's roles are namespaced: the project's own reviewer is untouched.
			const agents = JSON.parse(flag(call.args, "--agents"));
			expect(Object.keys(agents)).toContain("ade-reviewer");
			expect(Object.keys(agents)).not.toContain("reviewer");
		}
		// The reviewer cannot edit, and reviews only the task's own change.
		expect(calls[2].args).toContain("--disallowedTools");
		expect(calls[2].stdin).toContain("- src/cart.js");
		expect(calls[2].stdin).toContain("already changed before the task");
		expect(calls[2].stdin).toMatch(
			/ignore their pre-existing edits:\n- README\.md/,
		);
		expect(calls[1].stdin).not.toContain("start the next stage");

		// Cost: each run once, reported by Claude Code.
		expect(task.spend.usd).toBeCloseTo(0.55, 5);
		expect(task.spend.unknownRuns).toBe(0);
		const data = await tasksOf("ws-shop");
		expect(data.usage.tasks.usd).toBeCloseTo(0.55, 5);

		// No workflow files were written into the repository.
		const after = snapshot(repo);
		expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
		expect(after["src/cart.js"]).toBe("export const total = 2;\n");
		expect(existsSync(join(repo, ".ade"))).toBe(false);
		expect(after[".claude/agents/reviewer.md"]).toBe(
			before[".claude/agents/reviewer.md"],
		);

		// The panel renders this state: done, models, no stage buttons in Auto.
		const html = renderToStaticMarkup(
			<m.panel.TasksPanelView
				data={data}
				checks={await caller.getChecks({ workspaceId: "ws-shop" })}
				description=""
				preview={undefined}
				actions={noActions}
			/>,
		);
		expect(html).toContain("Done (verified)");
		expect(html).toContain("claude-opus-5-5");
		expect(html).toContain(">PASS<");
		expect(html).toContain("API-equivalent estimates");
		// No stage buttons: Auto needed no Build or Review click.
		expect(html).not.toMatch(/<button[^>]*>(Build|Review|Plan)[^<]*<\/button>/);
	}, 60_000);

	it("skips planning and review for a trivial change when the checks pass", async () => {
		const repo = makeRepo("typo");
		addWorkspace("ws-typo", repo);
		await caller.setChecks({ workspaceId: "ws-typo", commands: [CHECK] });
		fake.setSteps([
			{
				name: "quick",
				write: { "README.md": "# Shop\nThe shop.\n" },
				cost: 0.01,
			},
		]);
		const created = await caller.createTask({
			workspaceId: "ws-typo",
			description: "Fix typo in README",
		});
		await settle();
		const task = await taskOf("ws-typo", created.slug);
		expect(task.route).toBe("quick");
		expect(task.state).toBe("done");
		expect(task.runs.map((r) => r.kind)).toEqual(["quick", "checks"]);
		expect(task.runs[0].model).toBe("claude-haiku-5-5");
		expect(fake.remainingSteps()).toBe(0);
	}, 30_000);

	it("asks the user when the plan has a question, then continues after the answer", async () => {
		const repo = makeRepo("ask");
		addWorkspace("ws-ask", repo);
		await caller.setChecks({ workspaceId: "ws-ask", commands: [] });
		fake.setSteps([
			{
				name: "plan",
				write: {
					"{task}/plan.md":
						"# Plan\n\n## Questions for the user\n- Keep the old table?\n",
				},
			},
		]);
		const created = await caller.createTask({
			workspaceId: "ws-ask",
			description: "Refactor the cart and migrate its database schema",
		});
		await settle();
		let task = await taskOf("ws-ask", created.slug);
		expect(task.state).toBe("needs-input");
		expect(task.planQuestions).toEqual(["Keep the old table?"]);

		fake.setSteps([
			{
				name: "build",
				write: { "src/cart.js": "export const total = 3;\n" },
			},
			{ name: "review", text: "VERDICT: PASS" },
		]);
		await caller.answer({
			workspaceId: "ws-ask",
			slug: created.slug,
			answers: "Drop it.",
		});
		await settle();
		task = await taskOf("ws-ask", created.slug);
		expect(task.state).toBe("done");
		// Without checks, the independent review alone decides.
		expect(task.stateReason).toContain("no checks configured");
		expect(fake.calls().at(-2)?.stdin).toContain("Drop it.");
	}, 30_000);

	it("corrects after a failed review and passes on re-review", async () => {
		const repo = makeRepo("fixit");
		addWorkspace("ws-fix", repo);
		await caller.setChecks({ workspaceId: "ws-fix", commands: [CHECK] });
		fake.setSteps([
			{
				name: "implement",
				write: { "src/cart.js": "export const total = 0;\n" },
			},
			{ name: "review-1", text: "total is wrong\nVERDICT: FAIL" },
			{ name: "fix", write: { "src/cart.js": "export const total = 2;\n" } },
			{ name: "review-2", text: "VERDICT: PASS" },
		]);
		const created = await caller.createTask({
			workspaceId: "ws-fix",
			description: "Add a discount field to the cart total",
		});
		await settle();
		const task = await taskOf("ws-fix", created.slug);
		expect(task.state).toBe("done");
		expect(task.runs.map((r) => `${r.kind}:${r.verdict ?? r.status}`)).toEqual([
			"implement:succeeded",
			"checks:succeeded",
			"review:FAIL",
			"fix:succeeded",
			"checks:succeeded",
			"review:PASS",
		]);
		// The fix run got the reviewer's findings.
		const fixCall = fake.calls().find((c) => c.step === "fix");
		expect(fixCall?.stdin).toContain("total is wrong");
	}, 60_000);

	it("stops after the correction limit when checks keep failing", async () => {
		const repo = makeRepo("broken");
		addWorkspace("ws-broken", repo);
		await caller.setChecks({ workspaceId: "ws-broken", commands: [CHECK] });
		fake.setSteps([
			{ name: "implement", write: { BROKEN: "1" } },
			{ name: "fix-1" },
			{ name: "fix-2" },
		]);
		const created = await caller.createTask({
			workspaceId: "ws-broken",
			description: "Add a discount field to the cart total",
		});
		await settle();
		const task = await taskOf("ws-broken", created.slug);
		expect(task.state).toBe("blocked");
		expect(task.stateReason).toBe("Checks still fail after 2 correction(s).");
		expect(task.runs.filter((r) => r.kind === "fix")).toHaveLength(2);
		expect(task.runs.filter((r) => r.kind === "checks")).toHaveLength(3);
		const fixCall = fake.calls().find((c) => c.step === "fix-1");
		expect(fixCall?.stdin).toContain("expected 2, got 1");
		expect(fake.remainingSteps()).toBe(0);
	}, 60_000);

	it("retries an unavailable model once on a cheaper one, never a pricier one", async () => {
		const repo = makeRepo("nomodel");
		addWorkspace("ws-nomodel", repo);
		await caller.setChecks({ workspaceId: "ws-nomodel", commands: [] });
		fake.setSteps([
			{
				name: "plan-opus",
				isError: true,
				exit: 1,
				text: "API Error: model claude-opus-5-5 not_found_error",
				// Claude Code reports the (zero) cost of a request it never billed.
				cost: 0,
			},
			{
				name: "plan-sonnet",
				write: {
					"{task}/plan.md": "# Plan\n\n## Questions for the user\nNone\n",
				},
			},
			{ name: "build", write: { "src/cart.js": "export const total = 4;\n" } },
			{ name: "review", text: "VERDICT: PASS" },
		]);
		const created = await caller.createTask({
			workspaceId: "ws-nomodel",
			description: "Refactor the cart and migrate its database schema",
		});
		await settle();
		const task = await taskOf("ws-nomodel", created.slug);
		expect(task.state).toBe("done");
		expect(task.runs[0]).toMatchObject({
			kind: "plan",
			status: "failed",
			failure: "model-unavailable",
			model: "claude-opus-5-5",
		});
		expect(task.runs[1]).toMatchObject({
			kind: "plan",
			status: "succeeded",
			model: "claude-sonnet-5-5",
			fallbackFrom: "claude-opus-5-5",
		});

		// Haiku has nothing cheaper: the task stops instead.
		fake.setSteps([
			{
				name: "quick",
				isError: true,
				exit: 1,
				text: "model claude-haiku-5-5 not available",
				cost: 0,
			},
		]);
		const quick = await caller.createTask({
			workspaceId: "ws-nomodel",
			description: "Fix typo in README",
		});
		await settle();
		const stopped = await taskOf("ws-nomodel", quick.slug);
		expect(stopped.state).toBe("blocked");
		expect(stopped.stateReason).toContain("unavailable");
		expect(stopped.runs).toHaveLength(1);
	}, 60_000);

	it("stops automatic launches when the task budget is used up", async () => {
		saveSettings((s) => {
			s.execution.taskBudgetUsd = 0.05;
		});
		const repo = makeRepo("budget");
		addWorkspace("ws-budget", repo);
		await caller.setChecks({ workspaceId: "ws-budget", commands: [] });
		fake.setSteps([
			{ name: "implement", write: { "src/cart.js": "x\n" }, cost: 0.06 },
		]);
		const created = await caller.createTask({
			workspaceId: "ws-budget",
			description: "Add a discount field to the cart total",
		});
		await settle();
		const task = await taskOf("ws-budget", created.slug);
		expect(task.state).toBe("blocked");
		expect(task.stateReason).toContain("budget");
		expect(task.runs).toHaveLength(1);
		// The run itself was capped at what was left of the budget.
		expect(flag(fake.calls().at(-1)?.args ?? [], "--max-budget-usd")).toBe(
			"0.05",
		);
		expect(task.manualBlockers.review).toContain("budget");
		saveSettings(() => {});
	}, 30_000);

	it("keeps an unpriced run's cost uncertain and never counts it as zero", async () => {
		const repo = makeRepo("unpriced");
		addWorkspace("ws-unpriced", repo);
		await caller.setChecks({ workspaceId: "ws-unpriced", commands: [] });
		fake.setSteps([
			{
				name: "implement",
				usage: [{ model: "claude-mystery-9", input: 1000, output: 100 }],
				write: { "src/cart.js": "y\n" },
			},
			{ name: "review", text: "VERDICT: PASS", cost: 0.01 },
		]);
		const created = await caller.createTask({
			workspaceId: "ws-unpriced",
			description: "Add a discount field to the cart total",
		});
		await settle();
		const task = await taskOf("ws-unpriced", created.slug);
		expect(task.runs[0].costState).toBe("partial");
		expect(task.runs[0].unpricedModels).toEqual(["claude-mystery-9"]);
		expect(task.runs[0].observedModels).toEqual(["claude-mystery-9"]);
		expect(task.spend.partialRuns).toBe(1);
		// The run might have used its whole cap: Auto stops instead of
		// assuming it cost nothing.
		expect(task.spend.uncertainRuns).toBe(1);
		expect(task.spend.worstCaseUsd).toBeCloseTo(10, 5);
		expect(task.state).toBe("blocked");
		expect(task.stateReason).toContain("may be used up");
		expect(task.runs).toHaveLength(1);
		const html = renderToStaticMarkup(
			<m.panel.TasksPanelView
				data={await tasksOf("ws-unpriced")}
				checks={undefined}
				description=""
				preview={undefined}
				actions={noActions}
			/>,
		);
		expect(html).toContain("1 run(s) uncertain");
		expect(html).toContain("some responses unpriced");

		// Raising the budget lets it continue.
		await caller.setBudget({
			workspaceId: "ws-unpriced",
			slug: created.slug,
			budgetUsd: 20,
		});
		await caller.resume({ workspaceId: "ws-unpriced", slug: created.slug });
		await settle();
		const resumed = await taskOf("ws-unpriced", created.slug);
		expect(resumed.state).toBe("done");
		expect(fake.remainingSteps()).toBe(0);
	}, 30_000);

	it("surfaces a launch that cannot start", async () => {
		const repo = makeRepo("nolaunch");
		addWorkspace("ws-nolaunch", repo);
		claudeFound = false;
		try {
			const created = await caller.createTask({
				workspaceId: "ws-nolaunch",
				description: "Add a discount field to the cart total",
			});
			expect(created.state).toBe("blocked");
			expect(created.stateReason).toContain("not found");
		} finally {
			claudeFound = true;
		}
	});

	it("cancels a running task and kills its process tree", async () => {
		const repo = makeRepo("cancel");
		addWorkspace("ws-cancel", repo);
		rmSync(fake.childPidFile, { force: true });
		fake.setSteps([{ name: "hang", hang: true }]);
		const created = await caller.createTask({
			workspaceId: "ws-cancel",
			description: "Add a discount field to the cart total",
		});
		expect(created.state).toBe("running");
		expect(await m.fake.waitFor(() => existsSync(fake.childPidFile))).toBe(
			true,
		);
		const child = Number(readFileSync(fake.childPidFile, "utf8"));

		// While it runs, its cost counts at its cap (the whole budget), but the
		// card must not ask to raise the budget for a normal run in progress.
		const runningHtml = renderToStaticMarkup(
			<m.panel.TasksPanelView
				data={await tasksOf("ws-cancel")}
				checks={undefined}
				description=""
				preview={undefined}
				actions={noActions}
			/>,
		);
		expect(runningHtml).toContain("Running");
		expect(runningHtml).toContain("run(s) uncertain");
		expect(runningHtml).not.toContain("Raise budget");

		const result = await caller.cancel({
			workspaceId: "ws-cancel",
			slug: created.slug,
		});
		expect(result.state).toBe("cancelled");
		const task = await taskOf("ws-cancel", created.slug);
		expect(task.runs[0].status).toBe("cancelled");
		expect(await m.fake.waitFor(() => !m.fake.isAlive(child), 5000)).toBe(true);
	}, 30_000);

	it("handles concurrent clicks and duplicate or stale completions once", async () => {
		const repo = makeRepo("dupes");
		addWorkspace("ws-dupes", repo);
		await caller.setChecks({ workspaceId: "ws-dupes", commands: [] });
		const created = await caller.createTask({
			workspaceId: "ws-dupes",
			description: "Add a discount field to the cart total",
			mode: "manual",
		});
		await caller.setMode({
			workspaceId: "ws-dupes",
			slug: created.slug,
			mode: "auto",
		});
		fake.setSteps([
			{ name: "implement", write: { "src/cart.js": "z\n" } },
			{ name: "review", text: "VERDICT: PASS" },
		]);
		const callsBefore = fake.calls().length;
		const clicks = await Promise.allSettled([
			caller.start({ workspaceId: "ws-dupes", slug: created.slug }),
			caller.start({ workspaceId: "ws-dupes", slug: created.slug }),
			caller.start({ workspaceId: "ws-dupes", slug: created.slug }),
		]);
		expect(clicks.filter((c) => c.status === "fulfilled")).toHaveLength(1);
		expect(
			clicks.filter(
				(c) =>
					c.status === "rejected" &&
					String(c.reason).includes("already running"),
			),
		).toHaveLength(2);
		await settle();
		expect(fake.calls().length - callsBefore).toBe(2);

		const project = m.project.ensureProjectWorkflow(TEST_HOME, repo);
		const before = m.tasks.getTask(project, created.slug);
		expect(before?.state).toBe("done");
		// A duplicate completion of the finished run, and one for a run that
		// never existed, change nothing.
		const fakeResult = {
			exitCode: 1,
			timedOut: false,
			cancelled: false,
			liveCostUsd: 99,
			costState: "estimated" as const,
			observedModels: [],
			unpricedModels: [],
			failure: "error" as const,
			error: "late duplicate",
			stderrTail: "",
		};
		await controller.finishModelRun(
			project,
			created.slug,
			before?.runs[0].id ?? "",
			fakeResult,
			true,
		);
		await controller.finishModelRun(
			project,
			created.slug,
			"no-such-run",
			fakeResult,
			true,
		);
		expect(m.tasks.getTask(project, created.slug)).toEqual(before);
	}, 30_000);

	it("recovers after a restart without replaying paid work, then resumes on request", async () => {
		const repo = makeRepo("restart");
		addWorkspace("ws-restart", repo);
		await caller.setChecks({ workspaceId: "ws-restart", commands: [] });
		fake.setSteps([{ name: "hang", hang: true }]);
		const created = await caller.createTask({
			workspaceId: "ws-restart",
			description: "Add a discount field to the cart total",
		});
		expect(created.state).toBe("running");
		// ADE quits: the run's process tree is killed, its record still says running.
		await controller.shutdown();
		const project = m.project.ensureProjectWorkflow(TEST_HOME, repo);
		expect(m.tasks.getTask(project, created.slug)?.runs[0].status).toBe(
			"running",
		);

		// Next start: a fresh controller recovers; nothing is re-run.
		const callsBefore = fake.calls().length;
		const restarted = new m.controller.TaskController({
			homeDir: TEST_HOME,
			loadSettings: () => m.settings.defaultWorkflowSettings(),
			resolveClaude: () => fake.command,
			startRun: () => {
				throw new Error("must not run during recovery");
			},
			runChecks: async () => [],
			newId: randomUUID,
			now: () => new Date(),
		});
		expect(
			restarted.recover([project], (p) =>
				m.tasks.listTaskRecords(p).map((t) => t.slug),
			),
		).toBeGreaterThanOrEqual(1);
		await settle();
		const task = await taskOf("ws-restart", created.slug);
		expect(task.state).toBe("paused");
		expect(task.runs[0].status).toBe("interrupted");
		expect(fake.calls().length).toBe(callsBefore);

		// The interrupted run's cost is uncertain: it counts at its cap, so the
		// budget must be raised before ADE launches more.
		const paused = await taskOf("ws-restart", created.slug);
		expect(paused.spend.uncertainRuns).toBe(1);
		await caller.setBudget({
			workspaceId: "ws-restart",
			slug: created.slug,
			budgetUsd: 25,
		});

		// The user resumes: the stage runs again (once), then review.
		fake.setSteps([
			{ name: "implement-again", write: { "src/cart.js": "w\n" } },
			{ name: "review", text: "VERDICT: PASS" },
		]);
		await caller.resume({ workspaceId: "ws-restart", slug: created.slug });
		await settle();
		const resumed = await taskOf("ws-restart", created.slug);
		expect(resumed.state).toBe("done");
		expect(
			resumed.runs.map((r) => `${r.kind}#${r.attempt}:${r.status}`),
		).toEqual([
			"implement#1:interrupted",
			"implement#2:succeeded",
			"review#1:succeeded",
		]);
	}, 30_000);
});

describe.if(bash !== null && git !== null)("Manual mode and isolation", () => {
	it("runs single steps with a model override, and explains blocked steps", async () => {
		const repo = makeRepo("manual");
		addWorkspace("ws-manual", repo);
		await caller.setChecks({ workspaceId: "ws-manual", commands: [CHECK] });
		const created = await caller.createTask({
			workspaceId: "ws-manual",
			description: "Add a discount field to the cart total",
			mode: "manual",
		});
		expect(created.state).toBe("idle");
		let task = await taskOf("ws-manual", created.slug);
		expect(task.runs).toHaveLength(0);
		expect(task.manualBlockers.review).toBe("Nothing has been implemented yet");
		await expect(
			caller.runStep({
				workspaceId: "ws-manual",
				slug: created.slug,
				kind: "review",
			}),
		).rejects.toThrow("Nothing has been implemented yet");

		fake.setSteps([{ name: "implement", write: { "src/cart.js": "m\n" } }]);
		await caller.runStep({
			workspaceId: "ws-manual",
			slug: created.slug,
			kind: "implement",
			model: "opus",
		});
		await settle();
		task = await taskOf("ws-manual", created.slug);
		expect(task.runs[0].model).toBe("claude-opus-5-5");
		// Manual mode does not advance on its own.
		expect(task.runs).toHaveLength(1);
		expect(task.state).toBe("idle");
		expect(task.manualBlockers.checks).toBeNull();
		await caller.runStep({
			workspaceId: "ws-manual",
			slug: created.slug,
			kind: "checks",
		});
		await settle();
		task = await taskOf("ws-manual", created.slug);
		expect(task.runs.map((r) => r.kind)).toEqual(["implement", "checks"]);

		const html = renderToStaticMarkup(
			<m.panel.TasksPanelView
				data={await tasksOf("ws-manual")}
				checks={await caller.getChecks({ workspaceId: "ws-manual" })}
				description=""
				preview={undefined}
				actions={noActions}
			/>,
		);
		expect(html).toContain("Manual");
		expect(html).toContain("Run checks");
		expect(html).toContain('title="There is no failed check or review to fix"');
	}, 30_000);

	it("keeps two projects and two worktrees of one project apart", async () => {
		const shop = makeRepo("iso-shop");
		const blog = makeRepo("iso-blog");
		const shopB = join(root, "iso-shop-b");
		sh(shop, "worktree", "add", "-q", shopB, "-b", "feature-b");
		addWorkspace("ws-a", shop);
		addWorkspace("ws-b", shop, shopB);
		addWorkspace("ws-blog", blog);

		const created = await caller.createTask({
			workspaceId: "ws-a",
			description: "Add a discount field to the cart total",
			mode: "manual",
		});
		// Same project: worktree B sees the task, flagged as belonging to A.
		const fromB = await taskOf("ws-b", created.slug);
		expect(fromB.mismatch).toContain(
			"Open that workspace, or move the task here",
		);
		expect(fromB.identity.worktreePath).toBe(shop);
		await expect(
			caller.runStep({
				workspaceId: "ws-b",
				slug: created.slug,
				kind: "implement",
			}),
		).rejects.toThrow("belongs to");
		// Another project never sees it.
		expect((await tasksOf("ws-blog")).tasks).toHaveLength(0);

		// An explicit move: runs then happen in worktree B, on its branch.
		await caller.moveHere({ workspaceId: "ws-b", slug: created.slug });
		const moved = await taskOf("ws-b", created.slug);
		expect(moved.mismatch).toBeNull();
		expect(moved.identity.branch).toBe("feature-b");
		expect((await taskOf("ws-a", created.slug)).mismatch).not.toBeNull();
		fake.setSteps([{ name: "implement-b", write: { "src/cart.js": "b\n" } }]);
		await caller.runStep({
			workspaceId: "ws-b",
			slug: created.slug,
			kind: "implement",
		});
		await settle();
		expect(fake.calls().at(-1)?.cwd.replace(/\\/g, "/")).toBe(
			shopB.replace(/\\/g, "/"),
		);
		// Worktree A is untouched.
		expect(readFileSync(join(shop, "src", "cart.js"), "utf8")).toBe(
			"export const total = 1;\n",
		);
	}, 30_000);
});

describe.if(bash !== null && git !== null)("release regressions", () => {
	it("runs the implementer when a quick run says it needs one", async () => {
		const repo = makeRepo("reroute");
		addWorkspace("ws-reroute", repo);
		await caller.setChecks({ workspaceId: "ws-reroute", commands: [CHECK] });
		fake.setSteps([
			{
				name: "quick",
				text: "Needs implementer: the README fix also needs the cart totals changed",
			},
			{
				name: "implement",
				write: {
					"README.md": "# Shop\nThe shop.\n",
					"src/cart.js": "export const total = 5;\n",
				},
			},
			{ name: "review", text: "VERDICT: PASS" },
		]);
		const created = await caller.createTask({
			workspaceId: "ws-reroute",
			description: "Fix typo in README",
		});
		await settle();
		const task = await taskOf("ws-reroute", created.slug);
		expect(task.route).toBe("implement");
		expect(task.state).toBe("done");
		expect(task.runs.map((r) => r.kind)).toEqual([
			"quick",
			"implement",
			"checks",
			"review",
		]);
		expect(task.runs[1].model).toBe("claude-sonnet-5-5");
		const implementCall = fake
			.calls()
			.filter((c) => c.step === "implement")
			.at(-1);
		expect(implementCall?.stdin).toContain(
			"also needs the cart totals changed",
		);
		expect(readFileSync(join(repo, "src", "cart.js"), "utf8")).toContain("5");
	}, 30_000);

	it("re-runs checks when the approved commands change or the code changes", async () => {
		const repo = makeRepo("rechecks");
		addWorkspace("ws-rechecks", repo);
		writeFileSync(join(repo, "lint.js"), 'console.log("lint ok");\n');
		const LINT = `"${process.execPath.replace(/\\/g, "/")}" lint.js`;
		await caller.setChecks({ workspaceId: "ws-rechecks", commands: [CHECK] });
		const created = await caller.createTask({
			workspaceId: "ws-rechecks",
			description: "Add a discount field to the cart total",
			mode: "manual",
		});
		const slug = created.slug;
		const ws = "ws-rechecks";
		fake.setSteps([{ name: "implement", write: { "src/cart.js": "c\n" } }]);
		await caller.runStep({ workspaceId: ws, slug, kind: "implement" });
		await settle();
		await caller.runStep({ workspaceId: ws, slug, kind: "checks" });
		await settle();
		// The panel's next step is the review: the checks are current.
		expect((await taskOf(ws, slug)).next).toMatchObject({
			type: "run",
			kind: "review",
		});

		// Same number of commands, a different command: the old pass is void.
		await caller.setChecks({ workspaceId: ws, commands: [LINT] });
		expect((await taskOf(ws, slug)).next).toEqual({
			type: "checks",
			reason: "the approved checks changed",
		});
		await caller.runStep({ workspaceId: ws, slug, kind: "checks" });
		await settle();
		let task = await taskOf(ws, slug);
		expect(task.runs.at(-1)?.checks?.map((c) => c.command)).toEqual([LINT]);
		expect(task.next).toMatchObject({ type: "run", kind: "review" });

		// Someone edits the code after the checks ran: they must run again.
		writeFileSync(join(repo, "src", "cart.js"), "edited by hand\n");
		task = await taskOf(ws, slug);
		expect(task.next).toEqual({
			type: "checks",
			reason: "the code changed since the checks ran",
		});

		// In Auto, ADE re-runs the checks itself before the review.
		fake.setSteps([{ name: "review", text: "VERDICT: PASS" }]);
		await caller.setMode({ workspaceId: ws, slug, mode: "auto" });
		await caller.start({ workspaceId: ws, slug });
		await settle();
		task = await taskOf(ws, slug);
		expect(task.state).toBe("done");
		expect(task.runs.map((r) => r.kind)).toEqual([
			"implement",
			"checks",
			"checks",
			"checks",
			"review",
		]);
	}, 30_000);

	it("stops before the next stage when the worktree switched branches", async () => {
		const repo = makeRepo("branch");
		addWorkspace("ws-branch", repo);
		const original = sh(repo, "rev-parse", "--abbrev-ref", "HEAD");
		await caller.setChecks({ workspaceId: "ws-branch", commands: [CHECK] });
		fake.setSteps([
			{
				name: "implement",
				write: { "src/cart.js": "b\n" },
				// Something switches the branch while the task is running.
				git: [["checkout", "-q", "-b", "experiment"]],
			},
		]);
		const created = await caller.createTask({
			workspaceId: "ws-branch",
			description: "Add a discount field to the cart total",
		});
		await settle();
		let task = await taskOf("ws-branch", created.slug);
		// No checks or review ran on the other branch.
		expect(task.runs.map((r) => r.kind)).toEqual(["implement"]);
		expect(task.state).toBe("blocked");
		expect(task.stateReason).toContain(`runs on branch ${original}`);
		expect(task.mismatch).toContain("now on experiment");
		await expect(
			caller.resume({ workspaceId: "ws-branch", slug: created.slug }),
		).rejects.toThrow("now on experiment");

		// Switching back lets it continue.
		sh(repo, "checkout", "-q", original);
		fake.setSteps([{ name: "review", text: "VERDICT: PASS" }]);
		await caller.resume({ workspaceId: "ws-branch", slug: created.slug });
		await settle();
		task = await taskOf("ws-branch", created.slug);
		expect(task.state).toBe("done");
	}, 30_000);

	it("moving a task voids its completion evidence and verifies it again", async () => {
		const repo = makeRepo("move");
		const other = join(root, "move-b");
		sh(repo, "worktree", "add", "-q", other, "-b", "move-b");
		addWorkspace("ws-move-a", repo);
		addWorkspace("ws-move-b", repo, other);
		await caller.setChecks({ workspaceId: "ws-move-a", commands: [CHECK] });
		fake.setSteps([
			{ name: "implement-a", write: { "src/cart.js": "a\n" } },
			{ name: "review-a", text: "VERDICT: PASS" },
		]);
		const created = await caller.createTask({
			workspaceId: "ws-move-a",
			description: "Add a discount field to the cart total",
		});
		await settle();
		expect((await taskOf("ws-move-a", created.slug)).state).toBe("done");

		await caller.moveHere({ workspaceId: "ws-move-b", slug: created.slug });
		let task = await taskOf("ws-move-b", created.slug);
		expect(task.state).toBe("paused");
		expect(task.stateReason).toContain("verify it again");
		expect(task.moves).toHaveLength(1);
		// History is kept, but none of it is evidence any more.
		expect(task.runs.map((r) => r.history)).toEqual([true, true, true]);
		expect(task.next).toEqual({
			type: "run",
			kind: "implement",
			reason: "reconcile the work in this worktree",
		});

		fake.setSteps([
			{ name: "reconcile-b", write: { "src/cart.js": "a\n" } },
			{ name: "review-b", text: "VERDICT: PASS" },
		]);
		await caller.resume({ workspaceId: "ws-move-b", slug: created.slug });
		await settle();
		task = await taskOf("ws-move-b", created.slug);
		expect(task.state).toBe("done");
		expect(
			task.runs.map((r) => `${r.kind}${r.history ? "(old)" : ""}`),
		).toEqual([
			"implement(old)",
			"checks(old)",
			"review(old)",
			"implement",
			"checks",
			"review",
		]);
		const reconcile = fake.calls().find((c) => c.step === "reconcile-b");
		expect(reconcile?.cwd.replace(/\\/g, "/")).toBe(other.replace(/\\/g, "/"));
		expect(reconcile?.stdin).toContain("This task was moved");
		// Spend still covers every run, history included.
		expect(task.spend.usd).toBeGreaterThan(0);
	}, 60_000);

	it("cancelling one task does not wait for another task's run", async () => {
		const first = makeRepo("cancel-one");
		const second = makeRepo("cancel-two");
		addWorkspace("ws-c1", first);
		addWorkspace("ws-c2", second);
		await caller.setChecks({ workspaceId: "ws-c1", commands: [] });
		await caller.setChecks({ workspaceId: "ws-c2", commands: [] });
		fake.setSteps([
			{ name: "hang-1", hang: true },
			{ name: "hang-2", hang: true },
		]);
		const one = await caller.createTask({
			workspaceId: "ws-c1",
			description: "Add a discount field to the cart total",
		});
		const two = await caller.createTask({
			workspaceId: "ws-c2",
			description: "Add a discount field to the cart total",
		});
		expect(one.state).toBe("running");
		expect(two.state).toBe("running");

		const started = Date.now();
		const cancelled = await caller.cancel({
			workspaceId: "ws-c1",
			slug: one.slug,
		});
		expect(cancelled.state).toBe("cancelled");
		expect(Date.now() - started).toBeLessThan(8_000);
		// The other task is untouched and still running.
		const other = await taskOf("ws-c2", two.slug);
		expect(other.state).toBe("running");
		expect(other.runs[0].status).toBe("running");

		await caller.cancel({ workspaceId: "ws-c2", slug: two.slug });
	}, 30_000);
});

const noop = () => {};
const noActions = {
	busy: false,
	onCreate: noop,
	onStart: noop,
	onResume: noop,
	onPause: noop,
	onCancel: noop,
	onSetMode: noop,
	onAnswer: noop,
	onRunStep: noop,
	onMoveHere: noop,
	onSetBudget: noop,
	onOpenSession: noop,
	onSaveChecks: noop,
	onDescriptionChange: noop,
	onRefreshHistory: noop,
	onExcludeHistory: noop,
	onClearHistory: noop,
};
