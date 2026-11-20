import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Specialists, roles and templates from the application boundary: the
 * specialists router (the editor) and the workflow router (Tasks) with the
 * real TaskController and runner against real git repositories. Only the
 * model is fake; guards fail the test if a real claude would run.
 */

const TEST_HOME = mkdtempSync(join(tmpdir(), "ade-spec-home-"));
process.env.ADE_HOME_DIR = TEST_HOME;
const bashPath = Bun.which("bash");
const bash = bashPath && !/System32/i.test(bashPath) ? bashPath : null;
const git = Bun.which("git");

let root: string;
let fake: import("main/lib/agent-workflow/testing/fake-claude").FakeClaude;
let restoreNetwork: () => void;
let controller: import("main/lib/agent-workflow/controller").TaskController;
let tasks: ReturnType<
	ReturnType<
		typeof import("../workflow/workflow").createWorkflowRouter
	>["createCaller"]
>;
let specialists: ReturnType<
	ReturnType<
		typeof import("./specialists").createSpecialistsRouter
	>["createCaller"]
>;
let settingsModule: typeof import("main/lib/agent-workflow/workflow-settings");
const workspaces = new Map<string, { root: string; worktree: string }>();
/** The team's agents, as ADE's database would list them. */
const agentsByWorkspace = new Map<
	string,
	Array<{ workspaceId: string; name: string; worktreePath: string }>
>();

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
const CHECK = `"${process.execPath.replace(/\\/g, "/")}" check.js`;

function sh(cwd: string, ...args: string[]) {
	const r = spawnSync(git as string, args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(r.stderr);
	return r.stdout.trim();
}

function makeRepo(name: string): string {
	const dir = join(root, name);
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src", "api.js"), "export const route = 1;\n");
	writeFileSync(join(dir, "check.js"), 'console.log("ok");\n');
	sh(dir, "init", "-q");
	sh(dir, "config", "user.email", "t@example.com");
	sh(dir, "config", "user.name", "T");
	sh(dir, "add", "-A");
	sh(dir, "commit", "-qm", "init");
	return dir;
}

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "ade-spec-"));
	const project = await import("main/lib/agent-workflow/project-workflow");
	const controllerModule = await import("main/lib/agent-workflow/controller");
	const runner = await import("main/lib/agent-workflow/stage-runner");
	const checks = await import("main/lib/agent-workflow/checks");
	const identity = await import("main/lib/agent-workflow/identity");
	settingsModule = await import("main/lib/agent-workflow/workflow-settings");
	const fakeModule = await import(
		"main/lib/agent-workflow/testing/fake-claude"
	);
	const treeKill = await import("main/lib/tree-kill");
	const workflowRouter = await import("../workflow/workflow");
	const specialistsRouter = await import("./specialists");

	settingsModule.saveWorkflowSettings(
		TEST_HOME,
		settingsModule.defaultWorkflowSettings(),
	);
	fake = fakeModule.createFakeClaude(root);
	restoreNetwork = fakeModule.blockNetwork();
	const spawnFn = fakeModule.guardedSpawn(fake, bash ? [bash] : []);
	const killTree = async (pid: number) => {
		await treeKill.treeKillWithEscalation({ pid, escalationTimeoutMs: 1000 });
	};
	controller = new controllerModule.TaskController({
		homeDir: TEST_HOME,
		loadSettings: () => settingsModule.loadWorkflowSettings(TEST_HOME),
		resolveClaude: () => fake.command,
		startRun: (spec, onProgress) =>
			runner.startStageRun(spec, { spawnFn, killTree, onProgress }),
		runChecks: ({ cwd, commands, signal }) =>
			checks.runChecks({
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
	const resolveWorkspace = (workspaceId: string) => {
		const ws = workspaces.get(workspaceId);
		if (!ws) throw new Error(`unknown workspace ${workspaceId}`);
		return {
			workspaceId,
			project: project.ensureProjectWorkflow(TEST_HOME, ws.root),
			worktreePath: ws.worktree,
			runtime: "claude" as const,
		};
	};
	tasks = workflowRouter
		.createWorkflowRouter({
			homeDir: () => TEST_HOME,
			resolveWorkspace,
			controller: () => controller,
			captureIdentity: identity.captureIdentity,
			listAgents: (id) => agentsByWorkspace.get(id) ?? [],
			events: new EventEmitter(),
		})
		.createCaller({});
	specialists = specialistsRouter
		.createSpecialistsRouter({
			resolveWorkspace,
			homeDir: () => TEST_HOME,
			listAgents: (id) => agentsByWorkspace.get(id) ?? [],
		})
		.createCaller({});
});

afterAll(async () => {
	await controller?.shutdown();
	restoreNetwork?.();
	rmSync(root, { recursive: true, force: true });
	rmSync(TEST_HOME, { recursive: true, force: true });
});

describe.if(bash !== null && git !== null)("specialists and roles", () => {
	it("works with no specialist: the default workflow", async () => {
		const repo = makeRepo("plain");
		workspaces.set("ws-plain", { root: repo, worktree: repo });
		await tasks.setChecks({ workspaceId: "ws-plain", commands: [] });
		fake.setSteps([
			{ name: "quick", write: { "README.md": "# Fixed\n" }, cost: 0.01 },
			{ name: "review", text: "VERDICT: PASS", cost: 0.01 },
		]);
		const created = await tasks.createTask({
			workspaceId: "ws-plain",
			description: "Fix typo in README",
		});
		await controller.idle();
		const task = (
			await tasks.getProjectTasks({ workspaceId: "ws-plain" })
		).tasks.find((t) => t.slug === created.slug);
		expect(task?.specialist).toBeNull();
		expect(task?.specialistReason).toContain("no specialists in this team");
		expect(task?.state).toBe("done");
		expect(fake.calls().at(-2)?.stdin).not.toContain("## Specialty:");
	}, 30_000);

	it("templates, overrides and inheritance resolve predictably", async () => {
		const repo = makeRepo("shop");
		workspaces.set("ws-shop", { root: repo, worktree: repo });
		const templates = await specialists.templates();
		expect(templates.map((t) => t.id)).toEqual(
			expect.arrayContaining([
				"ui",
				"ux",
				"backend",
				"database",
				"security",
				"gamedev",
			]),
		);
		const backend = templates.find((t) => t.id === "backend");
		expect(backend?.instructions).toContain("authorization");
		expect(backend?.customRoles.map((r) => r.name)).toEqual([
			"API Contract Reviewer",
		]);

		await specialists.save({
			workspaceId: "ws-shop",
			specialist: {
				name: "Backend",
				specialty: "Backend",
				templateId: "backend",
				// Every role's model can change; the reviewer differs here.
				roles: { reviewer: { model: "opus" }, implementer: { maxTurns: 12 } },
			},
		});
		const list = await specialists.list({ workspaceId: "ws-shop" });
		const spec = list.specialists[0];
		expect(spec.effective.instructionsSource).toBe("template");
		expect(spec.effective.roles.reviewer).toMatchObject({
			model: "opus",
			source: { model: "specialist" },
		});
		// The Backend preset sets every role's model and effort explicitly.
		expect(spec.effective.roles.implementer).toMatchObject({
			model: "sonnet",
			effort: "medium",
			maxTurns: 12,
			source: { model: "template", effort: "template", maxTurns: "specialist" },
		});
		expect(spec.effective.roles.planner.instructions[0]).toContain(
			"Cover validation, authorization",
		);

		// Changing a global default leaves explicit customizations alone.
		const s = settingsModule.loadWorkflowSettings(TEST_HOME);
		s.roles.reviewer.model = "haiku";
		s.roles.implementer.model = "opus";
		settingsModule.saveWorkflowSettings(TEST_HOME, s);
		const after = (await specialists.list({ workspaceId: "ws-shop" }))
			.specialists[0];
		// The specialist's own choice and the template's preset both outrank
		// the global default.
		expect(after.effective.roles.reviewer.model).toBe("opus");
		expect(after.effective.roles.implementer.model).toBe("sonnet");
		settingsModule.saveWorkflowSettings(
			TEST_HOME,
			settingsModule.defaultWorkflowSettings(),
		);

		// Invalid combinations are refused before anything runs.
		await expect(
			specialists.save({
				workspaceId: "ws-shop",
				specialist: {
					name: "Bad",
					roles: { planner: { model: "gpt-5-codex" } },
				},
			}),
		).rejects.toThrow("not a Claude Code model");
		await expect(
			specialists.save({
				workspaceId: "ws-shop",
				specialist: {
					name: "Bad",
					customRoles: [
						{
							name: "Reviewer",
							instructions: "x",
							access: "read-only",
							trigger: "on-request",
						},
					],
				},
			}),
		).rejects.toThrow("built-in role");

		// Personal templates persist in ADE's home, separate from built-ins.
		const mine = await specialists.saveTemplate({
			name: "My API team",
			specialty: "API",
			instructions: "Prefer tRPC procedures.",
			roles: { reviewer: { model: "sonnet" } },
		});
		expect(mine.builtIn).toBe(false);
		const again = await specialists.templates();
		expect(again.find((t) => t.id === mine.id)?.instructions).toBe(
			"Prefer tRPC procedures.",
		);
		await expect(specialists.removeTemplate({ id: "backend" })).rejects.toThrow(
			"Only your own templates",
		);
	});

	it("Auto routes to the specialist, runs its custom role, corrects on FAIL, and the runner uses the resolved models", async () => {
		await tasks.setChecks({ workspaceId: "ws-shop", commands: [CHECK] });
		fake.setSteps([
			{
				name: "implement",
				write: {
					"src/api.js": "export const route = 2;\n",
					"{task}/progress.md": "Status: implemented\n",
				},
				cost: 0.05,
			},
			{
				name: "contract-1",
				text: "Breaks clients.\nVERDICT: FAIL",
				cost: 0.01,
			},
			{
				name: "fix",
				write: { "src/api.js": "export const route = 3;\n" },
				cost: 0.02,
			},
			{
				name: "contract-2",
				text: "Compatible now.\nVERDICT: PASS",
				cost: 0.01,
			},
			{ name: "review", text: "Looks good.\nVERDICT: PASS", cost: 0.02 },
		]);
		const before = fake.calls().length;
		const created = await tasks.createTask({
			workspaceId: "ws-shop",
			description: "Add a validation step to the orders API endpoint",
			route: "implement",
		});
		await controller.idle();
		const data = await tasks.getProjectTasks({ workspaceId: "ws-shop" });
		const task = data.tasks.find((t) => t.slug === created.slug);
		expect(task?.specialist?.name).toBe("Backend");
		expect(task?.specialistReason).toContain("matches Backend");
		expect(task?.state).toBe("done");
		expect(task?.runs.map((r) => [r.kind, r.role, r.specialist])).toEqual([
			["implement", "Implementer", "Backend"],
			["checks", null, null],
			["custom", "API Contract Reviewer", "Backend"],
			["fix", "Implementer", "Backend"],
			["checks", null, null],
			["custom", "API Contract Reviewer", "Backend"],
			["review", "Reviewer", "Backend"],
		]);
		const calls = fake.calls().slice(before);
		// The specialty and role instructions reach the prompts.
		expect(calls[0].stdin).toContain("## Specialty: Backend (Backend)");
		expect(calls[0].stdin).toContain(
			"Enforce authentication and authorization",
		);
		// Effort reaches the runner too: Backend implementer medium, reviewer high.
		expect(flag(calls[0].args, "--effort")).toBe("medium");
		expect(flag(calls[4].args, "--effort")).toBe("high");
		expect(calls[1].stdin).toContain("You are the API Contract Reviewer");
		expect(calls[1].args).toContain("--disallowedTools");
		expect(calls[2].stdin).toContain("API Contract Reviewer found problems");
		// The runner gets the resolved models and limits.
		expect(flag(calls[0].args, "--model")).toBe("claude-sonnet-5-5");
		expect(flag(calls[0].args, "--max-turns")).toBe("12");
		expect(flag(calls[4].args, "--model")).toBe("claude-opus-5-5");
		expect(calls[4].stdin).toContain(
			"Check validation, authorization, transactions",
		);
		for (const call of calls) {
			expect(call.args).not.toContain("--dangerously-skip-permissions");
		}
	}, 60_000);

	it("skips optional roles when the task does not need them, and honours task and stage overrides", async () => {
		fake.setSteps([
			{
				name: "implement",
				write: {
					"src/api.js": "export const route = 4;\n",
					"{task}/progress.md": "Status: implemented\n",
				},
				cost: 0.05,
			},
			{ name: "review", text: "VERDICT: PASS", cost: 0.02 },
		]);
		const before = fake.calls().length;
		const created = await tasks.createTask({
			workspaceId: "ws-shop",
			description: "Refactor the backend service logging",
			route: "implement",
			roleOverrides: { implementer: { model: "haiku" } },
		});
		await controller.idle();
		const task = (
			await tasks.getProjectTasks({ workspaceId: "ws-shop" })
		).tasks.find((t) => t.slug === created.slug);
		expect(task?.state).toBe("done");
		// No API words: the contract reviewer did not run.
		expect(task?.runs.map((r) => r.kind)).toEqual([
			"implement",
			"checks",
			"review",
		]);
		expect(flag(fake.calls()[before].args, "--model")).toBe("claude-haiku-5-5");
		// The specialist's saved settings did not change.
		const spec = (await specialists.list({ workspaceId: "ws-shop" }))
			.specialists[0];
		expect(spec.effective.roles.implementer.model).toBe("sonnet");
	}, 60_000);

	it("Manual runs a chosen custom role, and the next model shown is the one that runs", async () => {
		const created = await tasks.createTask({
			workspaceId: "ws-shop",
			description: "Change the orders endpoint response",
			mode: "manual",
			route: "implement",
		});
		let task = (
			await tasks.getProjectTasks({ workspaceId: "ws-shop" })
		).tasks.find((t) => t.slug === created.slug);
		expect(task?.customRoles.map((r) => r.name)).toEqual([
			"API Contract Reviewer",
		]);
		expect(task?.nextRole).toBe("Implementer");
		expect(task?.nextModel).toBe("sonnet");
		await expect(
			tasks.runStep({
				workspaceId: "ws-shop",
				slug: created.slug,
				kind: "custom",
			}),
		).rejects.toThrow("Choose which specialist role");
		fake.setSteps([{ name: "contract", text: "VERDICT: PASS", cost: 0.01 }]);
		await tasks.runStep({
			workspaceId: "ws-shop",
			slug: created.slug,
			kind: "custom",
			customRoleId: task?.customRoles[0].id,
		});
		await controller.idle();
		task = (await tasks.getProjectTasks({ workspaceId: "ws-shop" })).tasks.find(
			(t) => t.slug === created.slug,
		);
		expect(task?.runs.map((r) => [r.kind, r.role, r.verdict])).toEqual([
			["custom", "API Contract Reviewer", "PASS"],
		]);
		// Run history keeps the role's name after the role is removed from
		// the Roles list; saving again does not bring it back.
		const current = (await specialists.list({ workspaceId: "ws-shop" }))
			.specialists[0];
		await specialists.save({
			workspaceId: "ws-shop",
			specialist: { ...current, customRoles: [] },
		});
		await specialists.save({
			workspaceId: "ws-shop",
			specialist: (await specialists.list({ workspaceId: "ws-shop" }))
				.specialists[0],
		});
		task = (await tasks.getProjectTasks({ workspaceId: "ws-shop" })).tasks.find(
			(t) => t.slug === created.slug,
		);
		expect(task?.customRoles).toEqual([]);
		expect(task?.runs[0].role).toBe("API Contract Reviewer");
	}, 60_000);

	it("a template's roles join the one Roles list, keep their edits, never duplicate, and run when their condition applies", async () => {
		const repo = makeRepo("web");
		workspaces.set("ws-web", { root: repo, worktree: repo });
		await tasks.setChecks({ workspaceId: "ws-web", commands: [] });
		const mine = {
			id: "",
			name: "Copy Editor",
			description: "Checks wording",
			instructions: "Check user-facing text.",
			access: "read-only" as const,
			trigger: "on-request" as const,
		};
		// 1. Applying the UI template adds its Accessibility Reviewer to the
		// same list as the user's own role (and next to the workflow's roles).
		const saved = await specialists.save({
			workspaceId: "ws-web",
			specialist: {
				name: "UI",
				specialty: "UI",
				templateId: "ui",
				customRoles: [mine],
			},
		});
		expect(
			saved.customRoles.map((r) => [r.name, r.fromTemplate ?? null]),
		).toEqual([
			["Copy Editor", null],
			["Accessibility Reviewer", "ui"],
			["Visual Consistency Reviewer", "ui"],
		]);
		expect(saved.appliedTemplates).toEqual(["ui"]);
		let spec = (await specialists.list({ workspaceId: "ws-web" }))
			.specialists[0];
		expect(spec.effective.customRoles.map((r) => r.name)).toEqual([
			"Copy Editor",
			"Accessibility Reviewer",
			"Visual Consistency Reviewer",
		]);

		// 2. Its model and instructions are edited like any role.
		const edited = spec.customRoles.map((r) =>
			r.name === "Accessibility Reviewer"
				? {
						...r,
						model: "haiku",
						instructions: "Check focus order and labels only.",
					}
				: r,
		);
		await specialists.save({
			workspaceId: "ws-web",
			specialist: { ...spec, customRoles: edited },
		});

		// 3 and 4. Applying the template again adds nothing and keeps the edits,
		// whether the saved list already has the role or the client re-adds it.
		for (const customRoles of [edited, [...edited, ...spec.customRoles]]) {
			spec = (await specialists.list({ workspaceId: "ws-web" })).specialists[0];
			const again = await specialists.save({
				workspaceId: "ws-web",
				specialist: {
					...spec,
					templateId: "ui",
					appliedTemplates: [],
					customRoles: customRoles.filter(
						(r, i, all) => all.findIndex((x) => x.id === r.id) === i,
					),
				},
			});
			expect(again.customRoles.map((r) => r.name)).toEqual([
				"Copy Editor",
				"Accessibility Reviewer",
				"Visual Consistency Reviewer",
			]);
			const reviewer = again.customRoles.find(
				(r) => r.name === "Accessibility Reviewer",
			);
			expect(reviewer?.model).toBe("haiku");
			expect(reviewer?.instructions).toBe("Check focus order and labels only.");
		}

		// 5. It runs when its condition applies, on its own model.
		fake.setSteps([
			{
				name: "implement",
				write: {
					"src/api.js": "export const route = 9;\n",
					"{task}/progress.md": "Status: implemented\n",
				},
				cost: 0.05,
			},
			{ name: "a11y", text: "Labels fine.\nVERDICT: PASS", cost: 0.01 },
			{ name: "review", text: "VERDICT: PASS", cost: 0.02 },
		]);
		const before = fake.calls().length;
		const created = await tasks.createTask({
			workspaceId: "ws-web",
			description: "Add a keyboard shortcut to close the settings dialog",
			route: "implement",
		});
		await controller.idle();
		const task = (
			await tasks.getProjectTasks({ workspaceId: "ws-web" })
		).tasks.find((t) => t.slug === created.slug);
		expect(task?.specialist?.name).toBe("UI");
		expect(task?.state).toBe("done");
		expect(task?.runs.map((r) => [r.kind, r.role])).toEqual([
			["implement", "Implementer"],
			["custom", "Accessibility Reviewer"],
			["review", "Reviewer"],
		]);
		const a11y = fake.calls()[before + 1];
		expect(a11y.stdin).toContain("Check focus order and labels only.");
		expect(flag(a11y.args, "--model")).toBe("claude-haiku-5-5");

		// Order and settings survive a reload from disk.
		const reloaded = (await specialists.list({ workspaceId: "ws-web" }))
			.specialists[0];
		expect(reloaded.customRoles.map((r) => r.name)).toEqual([
			"Copy Editor",
			"Accessibility Reviewer",
			"Visual Consistency Reviewer",
		]);
	}, 60_000);

	it("Chosen by AI: a short triage run picks the pathway and models, then ADE runs it", async () => {
		const repo = makeRepo("mail");
		workspaces.set("ws-mail", { root: repo, worktree: repo });
		await tasks.setChecks({ workspaceId: "ws-mail", commands: [] });
		fake.setSteps([
			{
				name: "triage",
				text: 'Looked at src/api.js.\n```json\n{"route": "plan", "models": {"planner": "opus", "implementer": "sonnet", "reviewer": "opus"}, "specialist": "none", "reason": "sends email through a third-party service and needs credentials"}\n```',
				cost: 0.01,
			},
			{
				name: "plan",
				write: {
					"{task}/plan.md":
						"# Plan\n\n## Steps\n1. Add a mailer\n\n## Questions for the user\nNone\n",
				},
				cost: 0.1,
			},
			{
				name: "build",
				write: {
					"src/api.js": "export const mail = true;\n",
					"{task}/progress.md": "Status: implemented\n",
				},
				cost: 0.05,
			},
			{ name: "review", text: "VERDICT: PASS", cost: 0.03 },
		]);
		const before = fake.calls().length;
		const created = await tasks.createTask({
			workspaceId: "ws-mail",
			description: "Add the ability to email my teacher in my app",
			aiRouting: true,
		});
		await controller.idle();
		const task = (
			await tasks.getProjectTasks({ workspaceId: "ws-mail" })
		).tasks.find((t) => t.slug === created.slug);
		expect(task?.state).toBe("done");
		expect(task?.route).toBe("plan");
		expect(task?.triage).toMatchObject({
			applied: true,
			route: "plan",
			models: { planner: "opus", implementer: "sonnet", reviewer: "opus" },
		});
		expect(task?.routeReasons[0]).toContain("chosen by AI: sends email");
		expect(task?.runs.map((r) => [r.kind, r.model])).toEqual([
			["triage", "claude-sonnet-5-5"],
			["plan", "claude-opus-5-5"],
			["build", "claude-sonnet-5-5"],
			["review", "claude-opus-5-5"],
		]);
		const calls = fake.calls().slice(before);
		// The triage run is short, cheap and read-only.
		expect(flag(calls[0].args, "--effort")).toBe("low");
		expect(flag(calls[0].args, "--max-turns")).toBe("8");
		expect(calls[0].args).toContain("--disallowedTools");
		expect(calls[0].stdin).toContain("You choose the most economical pathway");
	}, 60_000);

	it("Chosen by AI falls back to ADE's rules when the answer cannot be read, and keeps a model the user set", async () => {
		fake.setSteps([
			{ name: "triage", text: "I think this is easy.", cost: 0.01 },
			{ name: "quick", write: { "README.md": "# Fixed\n" }, cost: 0.01 },
			{ name: "review", text: "VERDICT: PASS", cost: 0.01 },
		]);
		const before = fake.calls().length;
		const created = await tasks.createTask({
			workspaceId: "ws-mail",
			description: "Fix typo in README",
			aiRouting: true,
			roleOverrides: { quick: { model: "sonnet" } },
		});
		await controller.idle();
		const task = (
			await tasks.getProjectTasks({ workspaceId: "ws-mail" })
		).tasks.find((t) => t.slug === created.slug);
		expect(task?.state).toBe("done");
		expect(task?.triage?.applied).toBe(false);
		expect(task?.triage?.reason).toContain("ADE's rules chose the route");
		expect(task?.runs.map((r) => r.kind)).toEqual([
			"triage",
			"quick",
			"review",
		]);
		expect(flag(fake.calls()[before + 1].args, "--model")).toBe(
			"claude-sonnet-5-5",
		);

		// The AI's model choice never replaces one the user set for the task.
		const { applyTriage, parseTriage } = await import(
			"main/lib/agent-workflow/triage"
		);
		const decision = parseTriage(
			'```json\n{"route":"implement","models":{"implementer":"opus","reviewer":"haiku"},"reason":"x"}\n```',
		);
		expect(decision?.models).toEqual({
			implementer: "opus",
			reviewer: "haiku",
		});
		const applied = applyTriage(
			{
				route: "quick",
				routeReasons: [],
				roleOverrides: { implementer: { model: "sonnet" } },
			} as never,
			decision as NonNullable<typeof decision>,
			undefined,
		);
		expect(applied.roleOverrides?.implementer?.model).toBe("sonnet");
		expect(applied.roleOverrides?.reviewer?.model).toBe("haiku");
		expect(parseTriage('{"route":"teleport"}')).toBeUndefined();
	}, 60_000);

	it("a team request: the Coordinator splits it and each specialist's subtask runs in order", async () => {
		const repo = makeRepo("team");
		workspaces.set("ws-team", { root: repo, worktree: repo });
		await tasks.setChecks({ workspaceId: "ws-team", commands: [] });
		await specialists.save({
			workspaceId: "ws-team",
			specialist: { name: "Backend", specialty: "APIs and email" },
		});
		await specialists.save({
			workspaceId: "ws-team",
			specialist: { name: "Frontend", specialty: "Screens and buttons" },
		});
		fake.setSteps([
			{
				name: "split",
				text: 'Looked at src/api.js.\n```json\n{"subtasks": [{"title": "Email API", "description": "Add sendTeacherEmail to src/mail.js.", "specialist": "Backend", "route": "implement", "models": {"implementer": "opus", "reviewer": "sonnet"}}, {"title": "Email button", "description": "Add a button that calls sendTeacherEmail.", "specialist": "Frontend", "route": "quick", "models": {"quick": "haiku"}}, {"title": "", "description": "ignored: no title"}], "reason": "the API comes first, then the screen that calls it"}\n```',
				cost: 0.02,
			},
			{
				name: "api",
				write: {
					"src/mail.js": "export const sendTeacherEmail = () => true;\n",
					"{task}/progress.md": "Status: implemented\n",
				},
				cost: 0.05,
			},
			{ name: "api-review", text: "VERDICT: PASS", cost: 0.01 },
			{
				name: "button",
				write: { "src/button.js": "export const button = 1;\n" },
				cost: 0.01,
			},
			{ name: "button-review", text: "VERDICT: PASS", cost: 0.01 },
		]);
		const before = fake.calls().length;
		const created = await tasks.createTask({
			workspaceId: "ws-team",
			description: "Add the ability to email my teacher in my app",
			split: true,
		});
		await controller.idle();
		const all = (await tasks.getProjectTasks({ workspaceId: "ws-team" })).tasks;
		const request = all.find((t) => t.slug === created.slug);
		expect(request?.isRequest).toBe(true);
		expect(request?.runs.map((r) => [r.kind, r.role])).toEqual([
			["split", "Coordinator"],
		]);
		expect(request?.splitReason).toContain("the API comes first");
		expect(request?.subtaskSlugs).toHaveLength(2);
		const [api, button] = (request?.subtaskSlugs ?? []).map((slug) =>
			all.find((t) => t.slug === slug),
		);
		expect(api?.title).toBe("Email API");
		expect(api?.parentSlug).toBe(created.slug);
		expect(api?.specialist?.name).toBe("Backend");
		expect(api?.route).toBe("implement");
		expect(api?.runs.map((r) => [r.kind, r.model])).toEqual([
			["implement", "claude-opus-5-5"],
			["review", "claude-sonnet-5-5"],
		]);
		expect(api?.state).toBe("done");
		expect(button?.specialist?.name).toBe("Frontend");
		expect(button?.runs.map((r) => [r.kind, r.model])).toEqual([
			["quick", "claude-haiku-5-5"],
			["review", expect.any(String)],
		]);
		expect(button?.state).toBe("done");
		expect(request?.state).toBe("done");
		expect(request?.stateReason).toContain("all 2 subtask(s) are done");

		const calls = fake.calls().slice(before);
		// The Coordinator is short, read-only and on Sonnet at medium effort.
		expect(flag(calls[0].args, "--model")).toBe("claude-sonnet-5-5");
		expect(flag(calls[0].args, "--effort")).toBe("medium");
		expect(flag(calls[0].args, "--max-turns")).toBe("10");
		expect(calls[0].args).toContain("--disallowedTools");
		expect(calls[0].stdin).toContain("You are the Coordinator");
		expect(calls[0].stdin).toContain('"Backend" (APIs and email)');
		// The subtasks ran one after another, the API first.
		expect(calls.map((c) => c.step)).toEqual([
			"split",
			"api",
			"api-review",
			"button",
			"button-review",
		]);
		expect(calls[1].stdin).toContain("Add sendTeacherEmail");
		// Each subtask's changes are its own: the button's review sees only its file.
		expect(calls[4].stdin).toContain(
			"## This task's changes\n- src/button.js\n\n",
		);
		expect(calls[4].stdin).toContain(
			"ignore their pre-existing edits:\n- src/mail.js",
		);
	}, 90_000);

	it("a team request waits when a subtask stops, cancels its subtasks, and a bad split blocks", async () => {
		fake.setSteps([
			{ name: "split", text: "I would do it all at once.", cost: 0.01 },
		]);
		const bad = await tasks.createTask({
			workspaceId: "ws-team",
			description: "Rebuild the settings screen",
			split: true,
		});
		await controller.idle();
		let all = (await tasks.getProjectTasks({ workspaceId: "ws-team" })).tasks;
		const blocked = all.find((t) => t.slug === bad.slug);
		expect(blocked?.state).toBe("blocked");
		expect(blocked?.stateReason).toContain("could not be read");
		expect(blocked?.subtaskSlugs).toEqual([]);

		fake.setSteps([
			{
				name: "split",
				text: '```json\n{"subtasks": [{"title": "Settings API", "description": "Add a settings endpoint.", "specialist": "Backend", "route": "implement"}, {"title": "Settings screen", "description": "Show the settings.", "specialist": "Nobody"}], "reason": "API first"}\n```',
				cost: 0.01,
			},
			// The first subtask fails its run: the request waits.
			{ name: "api", exit: 1, isError: true, text: "crashed", cost: 0.01 },
		]);
		const created = await tasks.createTask({
			workspaceId: "ws-team",
			description: "Add a settings page",
			split: true,
		});
		await controller.idle();
		all = (await tasks.getProjectTasks({ workspaceId: "ws-team" })).tasks;
		const request = all.find((t) => t.slug === created.slug);
		const [first, second] = (request?.subtaskSlugs ?? []).map((slug) =>
			all.find((t) => t.slug === slug),
		);
		expect(second?.specialist).toBeNull();
		expect(second?.specialistReason).toContain('"Nobody"');
		expect(first?.state).not.toBe("done");
		expect(second?.state).toBe("idle");
		expect(request?.state).toBe("paused");
		expect(request?.stateReason).toContain('Subtask "Settings API"');

		await tasks.cancel({ workspaceId: "ws-team", slug: created.slug });
		all = (await tasks.getProjectTasks({ workspaceId: "ws-team" })).tasks;
		for (const slug of [created.slug, ...(request?.subtaskSlugs ?? [])]) {
			expect(all.find((t) => t.slug === slug)?.state).toBe("cancelled");
		}
	}, 90_000);

	it("agents with their own specialties: independent subtasks run in parallel, and dependent work is merged into the next agent's branch", async () => {
		const repo = makeRepo("agents");
		const backPath = join(root, "agents-backend");
		const frontPath = join(root, "agents-frontend");
		sh(repo, "worktree", "add", "-q", "-b", "agent/backend", backPath);
		sh(repo, "worktree", "add", "-q", "-b", "agent/frontend", frontPath);
		const mainHead = sh(repo, "rev-parse", "HEAD");
		const agents = [
			{ workspaceId: "ws-lead", name: "Lead", worktreePath: repo },
			{ workspaceId: "ws-ana", name: "Ana", worktreePath: backPath },
			{ workspaceId: "ws-bo", name: "Bo", worktreePath: frontPath },
		];
		for (const agent of agents) {
			workspaces.set(agent.workspaceId, {
				root: repo,
				worktree: agent.worktreePath,
			});
			agentsByWorkspace.set(agent.workspaceId, agents);
		}
		await tasks.setChecks({ workspaceId: "ws-lead", commands: [] });
		const backend = await specialists.save({
			workspaceId: "ws-ana",
			specialist: {
				name: "Backend",
				specialty: "APIs and email",
				agentWorkspaceId: "ws-ana",
			},
		});
		await specialists.save({
			workspaceId: "ws-bo",
			specialist: {
				name: "Frontend",
				specialty: "Screens",
				agentWorkspaceId: "ws-bo",
			},
		});
		// Saving without the field keeps the agent.
		await specialists.save({
			workspaceId: "ws-ana",
			specialist: {
				id: backend.id,
				name: "Backend",
				specialty: "APIs and email",
			},
		});
		const overview = await specialists.agents({ workspaceId: "ws-ana" });
		expect(
			overview.map((a) => [
				a.name,
				a.current,
				a.specialties.map((s) => s.name),
			]),
		).toEqual([
			["Lead", false, []],
			["Ana", true, ["Backend"]],
			["Bo", false, ["Frontend"]],
		]);

		fake.setSteps([
			{
				name: "split",
				text: '```json\n{"subtasks": [{"title": "Email API", "description": "Add the mail API.", "specialist": "Backend", "route": "quick", "dependsOn": []}, {"title": "Settings screen", "description": "Add a settings screen.", "specialist": "Frontend", "route": "quick", "dependsOn": []}, {"title": "Email button", "description": "Add a button that calls the mail API.", "specialist": "Frontend", "route": "quick", "dependsOn": [1]}], "reason": "the API and the settings screen are independent; the button needs the API"}\n```',
				cost: 0.01,
			},
			// The two independent subtasks run at the same time, so either may
			// take either step: they write different files.
			{
				name: "work-1",
				write: { "src/one.js": "export const one = 1;\n" },
				cost: 0.01,
			},
			{
				name: "work-2",
				write: { "src/two.js": "export const two = 2;\n" },
				cost: 0.01,
			},
			{ name: "review-1", text: "VERDICT: PASS", cost: 0.01 },
			{ name: "review-2", text: "VERDICT: PASS", cost: 0.01 },
			{
				name: "button",
				write: { "src/button.js": "export const button = 1;\n" },
				cost: 0.01,
			},
			{ name: "button-review", text: "VERDICT: PASS", cost: 0.01 },
		]);
		const before = fake.calls().length;
		const created = await tasks.createTask({
			workspaceId: "ws-lead",
			description: "Add the ability to email my teacher, and a settings screen",
			split: true,
		});
		await controller.idle();
		const all = (await tasks.getProjectTasks({ workspaceId: "ws-lead" })).tasks;
		const request = all.find((t) => t.slug === created.slug);
		const [api, settings, button] = (request?.subtaskSlugs ?? []).map((slug) =>
			all.find((t) => t.slug === slug),
		);
		expect(
			[api, settings, button].map((t) => [t?.title, t?.agentName, t?.state]),
		).toEqual([
			["Email API", "Ana", "done"],
			["Settings screen", "Bo", "done"],
			["Email button", "Bo", "done"],
		]);
		expect(api?.dependsOn).toEqual([]);
		expect(button?.dependsOn).toEqual([api?.slug as string]);
		expect(request?.state).toBe("done");
		expect(request?.stateReason).toContain(
			"The work is in Bo (agent/frontend)",
		);

		const calls = fake.calls().slice(before);
		// The Coordinator knew which agent does each specialty.
		expect(calls[0].stdin).toContain(
			'"Backend" (APIs and email), done by the agent "Ana"',
		);
		// Independent subtasks ran at the same time, each in its agent's folder.
		const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
		expect(
			calls
				.slice(1, 3)
				.map((c) => c.step)
				.sort(),
		).toEqual(["work-1", "work-2"]);
		expect(
			calls
				.slice(1, 3)
				.map((c) => norm(c.cwd))
				.sort(),
		).toEqual([norm(backPath), norm(frontPath)].sort());
		expect(
			calls
				.slice(3, 5)
				.map((c) => c.step)
				.sort(),
		).toEqual(["review-1", "review-2"]);
		// The button started after the API: the API was committed on Ana's
		// branch and merged into Bo's; the button's own change is only its file.
		expect(norm(calls[5].cwd)).toBe(norm(frontPath));
		expect(api?.resultCommit).toBeTruthy();
		expect(sh(backPath, "log", "-1", "--format=%s")).toBe("Email API");
		expect(sh(frontPath, "log", "--format=%s").split(/\r?\n/)).toContain(
			"Email API",
		);
		const apiFile = sh(backPath, "show", "--name-only", "--format=", "HEAD");
		expect(sh(frontPath, "ls-files")).toContain(apiFile);
		expect(calls[6].stdin).toContain(
			"## This task's changes\n- src/button.js\n\n",
		);
		// The team's main branch was not touched.
		expect(sh(repo, "rev-parse", "HEAD")).toBe(mainHead);
		expect(sh(repo, "status", "--porcelain")).toBe("");

		// An agent's own tasks use its specialty by default.
		const own = await tasks.createTask({
			workspaceId: "ws-ana",
			description: "Tidy up the readme",
			mode: "manual",
		});
		const ownTask = (
			await tasks.getProjectTasks({ workspaceId: "ws-ana" })
		).tasks.find((t) => t.slug === own.slug);
		expect(ownTask?.specialist?.name).toBe("Backend");
		expect(ownTask?.specialistReason).toContain("this agent's specialty");
	}, 120_000);

	it("a merge conflict between agents pauses the request with the reason", async () => {
		const repo = join(root, "agents");
		const frontPath = join(root, "agents-frontend");
		fake.setSteps([
			{
				name: "split",
				text: '```json\n{"subtasks": [{"title": "Change the API", "description": "Change it.", "specialist": "Backend", "route": "quick", "dependsOn": []}, {"title": "Use the API", "description": "Use it.", "specialist": "Frontend", "route": "quick", "dependsOn": [1]}], "reason": "button needs the API"}\n```',
				cost: 0.01,
			},
			{
				name: "api",
				write: { "src/api.js": "export const route = 'backend';\n" },
				cost: 0.01,
			},
			{ name: "api-review", text: "VERDICT: PASS", cost: 0.01 },
		]);
		// Bo's branch already changed the same line, committed.
		writeFileSync(
			join(frontPath, "src", "api.js"),
			"export const route = 'frontend';\n",
		);
		sh(frontPath, "commit", "-qam", "Bo's own change");
		const created = await tasks.createTask({
			workspaceId: "ws-lead",
			description: "Change the API and use it",
			split: true,
		});
		await controller.idle();
		const all = (await tasks.getProjectTasks({ workspaceId: "ws-lead" })).tasks;
		const request = all.find((t) => t.slug === created.slug);
		const use = all.find((t) => t.slug === request?.subtaskSlugs[1]);
		expect(use?.state).toBe("paused");
		expect(use?.stateReason).toContain("merge conflict in src/api.js");
		expect(request?.state).toBe("paused");
		expect(request?.stateReason).toContain('Subtask "Use the API"');
		// The failed merge was undone: Bo's folder is clean and unchanged.
		expect(sh(frontPath, "status", "--porcelain")).not.toContain("UU");
		expect(sh(repo, "status", "--porcelain")).toBe("");
		await tasks.cancel({ workspaceId: "ws-lead", slug: created.slug });
	}, 120_000);

	it("team chat: the Coordinator asks, proposes a plan, and nothing is built until Go", async () => {
		fake.setSteps([
			{
				name: "ask",
				text: "Which email service does the app use, and where should the button go?",
				cost: 0.01,
			},
			{
				name: "plan",
				text: 'An API first, then the button on the class screen.\n```json\n{"subtasks": [{"title": "Email API", "description": "Add sendTeacherEmail using Resend.", "specialist": "Backend", "route": "implement", "models": {"implementer": "sonnet", "reviewer": "sonnet"}, "dependsOn": []}, {"title": "Email button", "description": "A button on the class screen.", "specialist": "Frontend", "route": "quick", "dependsOn": [1]}], "reason": "the button needs the API"}\n```',
				cost: 0.01,
			},
			{
				name: "api",
				write: {
					"src/chat-mail.js": "export const send = 1;\n",
					"{task}/progress.md": "Status: implemented\n",
				},
				cost: 0.02,
			},
			{ name: "api-review", text: "VERDICT: PASS", cost: 0.01 },
			{
				name: "button",
				write: { "src/chat-button.js": "export const b = 1;\n" },
				cost: 0.01,
			},
			{ name: "button-review", text: "VERDICT: PASS", cost: 0.01 },
		]);
		const before = fake.calls().length;
		const started = await tasks.startChat({
			workspaceId: "ws-team",
			message: "Let students email their teacher from the app",
		});
		await controller.idle();
		const view = async () =>
			(await tasks.getProjectTasks({ workspaceId: "ws-team" })).tasks.find(
				(t) => t.slug === started.slug,
			);
		let chat = await view();
		// A question, no plan: the chat waits for the user, nothing is built.
		expect(chat?.chat?.map((m) => [m.role, m.text, !!m.plan])).toEqual([
			["user", "Let students email their teacher from the app", false],
			[
				"coordinator",
				"Which email service does the app use, and where should the button go?",
				false,
			],
		]);
		expect(chat?.state).toBe("needs-input");
		expect(chat?.stateReason).toContain("reply to the Coordinator");
		await expect(
			tasks.chatGo({ workspaceId: "ws-team", slug: started.slug }),
		).rejects.toThrow("no plan yet");

		await tasks.chatSay({
			workspaceId: "ws-team",
			slug: started.slug,
			message: "Resend. Put it on the class screen.",
		});
		await controller.idle();
		chat = await view();
		const reply = chat?.chat?.[3];
		expect(reply?.text).toBe(
			"An API first, then the button on the class screen.",
		);
		expect(
			reply?.plan?.subtasks.map((t) => [t.title, t.specialist, t.dependsOn]),
		).toEqual([
			["Email API", "Backend", []],
			["Email button", "Frontend", [0]],
		]);
		expect(chat?.subtaskSlugs).toEqual([]);
		expect(chat?.stateReason).toContain("press Go");

		const calls = fake.calls().slice(before);
		// Each reply is a short read-only Coordinator run that sees the conversation.
		expect(calls.map((c) => c.step)).toEqual(["ask", "plan"]);
		expect(flag(calls[1].args, "--effort")).toBe("medium");
		expect(calls[1].args).toContain("--disallowedTools");
		expect(calls[1].stdin).toContain("talking with the user in the team chat");
		expect(calls[1].stdin).toContain(
			"**User:** Let students email their teacher from the app",
		);
		expect(calls[1].stdin).toContain(
			"**You (Coordinator):** Which email service",
		);
		expect(calls[1].stdin).toContain(
			"**User:** Resend. Put it on the class screen.",
		);

		// "go" starts the agreed plan; then the conversation is closed.
		await tasks.chatSay({
			workspaceId: "ws-team",
			slug: started.slug,
			message: "go",
		});
		await controller.idle();
		chat = await view();
		expect(chat?.chat?.at(-1)).toMatchObject({ role: "user", text: "Go" });
		expect(chat?.state).toBe("done");
		const all = (await tasks.getProjectTasks({ workspaceId: "ws-team" })).tasks;
		expect(
			(chat?.subtaskSlugs ?? []).map((slug) => {
				const t = all.find((x) => x.slug === slug);
				return [t?.title, t?.specialist?.name, t?.state];
			}),
		).toEqual([
			["Email API", "Backend", "done"],
			["Email button", "Frontend", "done"],
		]);
		expect(
			fake
				.calls()
				.slice(before)
				.map((c) => c.step),
		).toEqual(["ask", "plan", "api", "api-review", "button", "button-review"]);
		await expect(
			tasks.chatSay({
				workspaceId: "ws-team",
				slug: started.slug,
				message: "one more thing",
			}),
		).rejects.toThrow("This plan has started");
	}, 120_000);

	it("an older specialist keeps a template role it switched off when it moves to one list", async () => {
		const project = (
			await import("main/lib/agent-workflow/project-workflow")
		).ensureProjectWorkflow(TEST_HOME, workspaces.get("ws-web")?.root ?? "");
		const { writeFileSync: write } = await import("node:fs");
		const { join: j } = await import("node:path");
		write(
			j(project.dir, "specialists.json"),
			JSON.stringify({
				version: 1,
				specialists: [
					{
						id: "spec-legacy",
						name: "Old DB",
						specialty: "Database",
						templateId: "database",
						templateUses: { instructions: true, models: true },
						roles: {},
						customRoles: [],
						disabledTemplateRoles: ["database-migration-reviewer"],
						createdAt: "2026-11-01T00:00:00Z",
						updatedAt: "2026-11-01T00:00:00Z",
					},
				],
			}),
		);
		let spec = (await specialists.list({ workspaceId: "ws-web" }))
			.specialists[0];
		expect(spec.effective.customRoles).toEqual([]);
		await specialists.save({ workspaceId: "ws-web", specialist: spec });
		spec = (await specialists.list({ workspaceId: "ws-web" })).specialists[0];
		expect(spec.customRoles).toEqual([]);
		expect(spec.appliedTemplates).toEqual(["database"]);
	});
});
