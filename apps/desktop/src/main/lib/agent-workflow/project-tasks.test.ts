import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
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
import {
	ensureProjectWorkflow,
	listWorkflowProjects,
	portablePath,
	projectKeyFor,
	refreshAllProjectWorkflows,
} from "./project-workflow";
import { prepareStageLaunch, stageModel } from "./stage-launch";
import { createTask, getTask, listTasks, summarizeTask } from "./tasks";
import {
	defaultWorkflowSettings,
	saveWorkflowSettings,
	type WorkflowSettings,
} from "./workflow-settings";

let home: string;
let repoA: string;
let repoB: string;

/** Every file under `dir` with its content, to prove a project is untouched. */
function snapshot(dir: string): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (current: string) => {
		for (const name of readdirSync(current)) {
			const path = join(current, name);
			if (statSync(path).isDirectory()) walk(path);
			else files[relative(dir, path)] = readFileSync(path, "utf8");
		}
	};
	walk(dir);
	return files;
}

function summaryOf(
	project: ReturnType<typeof ensureProjectWorkflow>,
	slug: string,
) {
	const task = getTask(project, slug);
	if (!task) throw new Error(`missing task ${slug}`);
	return summarizeTask(project, task);
}

function makeRepo(name: string): string {
	const dir = join(mkdtempSync(join(tmpdir(), "ade-proj-")), name);
	mkdirSync(join(dir, "src"), { recursive: true });
	mkdirSync(join(dir, ".claude"), { recursive: true });
	writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n", "utf8");
	writeFileSync(join(dir, "CLAUDE.md"), "# My own instructions\n", "utf8");
	writeFileSync(
		join(dir, ".claude", "settings.json"),
		JSON.stringify({ model: "haiku" }),
		"utf8",
	);
	return dir;
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ade-home-"));
	repoA = makeRepo("shop");
	repoB = makeRepo("blog");
});
afterEach(() => {
	for (const dir of [home, join(repoA, ".."), join(repoB, "..")]) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("project workflow folders", () => {
	it("gives each project a stable, readable key of its own", () => {
		const key = projectKeyFor(repoA);
		expect(key).toMatch(/^shop-[0-9a-f]{10}$/);
		expect(projectKeyFor(`${repoA}/`)).toBe(key);
		expect(projectKeyFor(join(repoA, "src", ".."))).toBe(key);
		expect(projectKeyFor(repoB)).not.toBe(key);
	});

	it("keeps all workflow state under the ADE home and leaves the project untouched", () => {
		const before = snapshot(repoA);
		const project = ensureProjectWorkflow(home, repoA);
		expect(project.dir.startsWith(home)).toBe(true);
		expect(project.tasksDir.startsWith(home)).toBe(true);
		createTask(project, { description: "Fix the crash on empty lists" });
		expect(snapshot(repoA)).toEqual(before);
	});

	it("re-renders every project's roles when the settings change", () => {
		const a = ensureProjectWorkflow(home, repoA);
		const b = ensureProjectWorkflow(home, repoB);
		expect(
			listWorkflowProjects(home)
				.map((p) => p.key)
				.sort(),
		).toEqual([a.key, b.key].sort());

		const settings = defaultWorkflowSettings();
		settings.roles.implementer.model = "opus";
		saveWorkflowSettings(home, settings);
		expect(refreshAllProjectWorkflows(home)).toBe(2);
		for (const project of [a, b]) {
			const agents = JSON.parse(readFileSync(project.agentsFile, "utf8"));
			expect(agents.implementer.model).toBe("opus");
			expect(agents.planner.prompt).toContain(portablePath(project.tasksDir));
		}
	});
});

describe("tasks", () => {
	it("routes new tasks automatically, or as the user chose", () => {
		const project = ensureProjectWorkflow(home, repoA);
		const auto = createTask(project, { description: "Fix typo in README" });
		expect(auto.route).toBe("quick");
		expect(auto.routeReasons.length).toBeGreaterThan(0);

		const chosen = createTask(project, {
			description: "Fix typo in README",
			route: "exceptional",
		});
		expect(chosen.route).toBe("exceptional");
		expect(chosen.routeReasons).toEqual(["chosen by you"]);
		expect(chosen.slug).toBe(`${auto.slug}-2`);
		expect(
			readFileSync(join(project.tasksDir, auto.slug, "task.md"), "utf8"),
		).toContain("Fix typo in README");
	});

	it("keeps each project's tasks separate", () => {
		const a = ensureProjectWorkflow(home, repoA);
		const b = ensureProjectWorkflow(home, repoB);
		createTask(a, { description: "Add checkout button" });
		expect(listTasks(a)).toHaveLength(1);
		expect(listTasks(b)).toHaveLength(0);
		// Reopening the project finds the same tasks.
		expect(listTasks(ensureProjectWorkflow(home, repoA))[0].title).toBe(
			"Add checkout button",
		);
	});

	it("rejects empty descriptions and unsafe slugs", () => {
		const project = ensureProjectWorkflow(home, repoA);
		expect(() => createTask(project, { description: "   " })).toThrow();
		expect(getTask(project, "../../etc")).toBeUndefined();
		expect(getTask(project, "missing")).toBeUndefined();
	});

	it("offers the next stage from the route and the task's files", () => {
		const project = ensureProjectWorkflow(home, repoA);
		const task = createTask(project, {
			description: "Refactor the session store and migrate the database schema",
		});
		expect(task.route).toBe("plan");
		const dir = join(project.tasksDir, task.slug);
		const next = () => summaryOf(project, task.slug).nextStage;

		expect(next()).toBe("plan");
		writeFileSync(join(dir, "plan.md"), "# plan", "utf8");
		expect(next()).toBe("build");

		const settings = defaultWorkflowSettings();
		prepareStageLaunch({
			homeDir: home,
			project,
			slug: task.slug,
			stage: "build",
			settings,
			shell: "posix",
			runtime: "claude",
		});
		expect(next()).toBe("review");

		writeFileSync(join(dir, "escalations", "001.md"), "report", "utf8");
		expect(next()).toBe("escalate");
		expect(summaryOf(project, task.slug).openEscalations).toBe(1);
		writeFileSync(
			join(dir, "escalations", "001.md"),
			"report\n## Resolution\nx",
			"utf8",
		);
		writeFileSync(join(dir, "progress.md"), "# p\nStatus: blocked\n", "utf8");
		expect(next()).toBe("escalate");
		writeFileSync(join(dir, "progress.md"), "# p\nStatus: done\n", "utf8");
		expect(next()).toBeNull();
		expect(summaryOf(project, task.slug).status).toBe("done");
	});

	it("offers review after a quick or direct implementation", () => {
		const project = ensureProjectWorkflow(home, repoA);
		const quick = createTask(project, { description: "Fix typo in README" });
		const settings = defaultWorkflowSettings();
		expect(summarizeTask(project, quick).nextStage).toBe("quick");
		prepareStageLaunch({
			homeDir: home,
			project,
			slug: quick.slug,
			stage: "quick",
			settings,
			shell: "posix",
			runtime: "claude",
		});
		expect(summaryOf(project, quick.slug).nextStage).toBe("review");
	});
});

describe("stage launches", () => {
	const settings: WorkflowSettings = defaultWorkflowSettings();

	it("runs each stage on its role's model", () => {
		const task = { route: "plan" as const };
		expect(stageModel("quick", task, settings)).toBe("haiku");
		expect(stageModel("implement", task, settings)).toBe("sonnet");
		expect(stageModel("plan", task, settings)).toBe("opus");
		expect(stageModel("build", task, settings)).toBe("sonnet");
		expect(stageModel("review", task, settings)).toBe("sonnet");
		expect(stageModel("escalate", task, settings)).toBe("fable");
		// Exceptional tasks are planned by Fable.
		expect(stageModel("plan", { route: "exceptional" }, settings)).toBe(
			"fable",
		);
	});

	it("pins the session, passes the model, and records the launch", () => {
		const project = ensureProjectWorkflow(home, repoA);
		const task = createTask(project, {
			description: "Redesign the notification architecture across runtimes",
		});
		const plan = prepareStageLaunch({
			homeDir: home,
			project,
			slug: task.slug,
			stage: "plan",
			settings,
			shell: "posix",
			runtime: "claude",
		});
		expect(plan.model).toBe("opus");
		expect(plan.command).toContain(`--session-id ${plan.sessionId} `);
		expect(plan.command).toContain("--model opus ");
		expect(plan.command.startsWith("claude ")).toBe(true);
		const recorded = getTask(project, task.slug)?.stages ?? [];
		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toMatchObject({
			stage: "plan",
			model: "opus",
			runtime: "claude",
			sessionId: plan.sessionId,
		});

		// The prompt file holds the task, its folder and the planner's job.
		const promptFile = plan.command.match(/cat -- '([^']+)'/)?.[1] ?? "";
		const prompt = readFileSync(promptFile, "utf8");
		expect(prompt).toContain(portablePath(join(project.tasksDir, task.slug)));
		expect(prompt).toContain("You are the planner");
		expect(prompt).toContain("Redesign the notification architecture");
	});

	it("lets the user override the model, and rejects unsafe values", () => {
		const project = ensureProjectWorkflow(home, repoA);
		const task = createTask(project, {
			description: "Fix the empty list crash",
		});
		const plan = prepareStageLaunch({
			homeDir: home,
			project,
			slug: task.slug,
			stage: "implement",
			settings,
			shell: "posix",
			runtime: "claude",
			modelOverride: "fable",
		});
		expect(plan.model).toBe("fable");
		expect(plan.command).toContain("--model fable ");
		expect(() =>
			prepareStageLaunch({
				homeDir: home,
				project,
				slug: task.slug,
				stage: "implement",
				settings,
				shell: "posix",
				runtime: "claude",
				modelOverride: "opus; rm -rf ~",
			}),
		).toThrow();
	});

	it("hands off to the architect and reviewer inside Claude sessions only", () => {
		const project = ensureProjectWorkflow(home, repoA);
		const task = createTask(project, {
			description: "Fix the empty list crash",
		});
		const read = (command: string) =>
			readFileSync(command.match(/cat -- '([^']+)'/)?.[1] ?? "", "utf8");

		const claude = prepareStageLaunch({
			homeDir: home,
			project,
			slug: task.slug,
			stage: "implement",
			settings,
			shell: "posix",
			runtime: "claude",
		});
		expect(read(claude.command)).toContain("`architect` subagent");
		expect(read(claude.command)).toContain("`reviewer` subagent");

		const codex = prepareStageLaunch({
			homeDir: home,
			project,
			slug: task.slug,
			stage: "implement",
			settings,
			shell: "posix",
			runtime: "codex",
		});
		expect(codex.command.startsWith("codex ")).toBe(true);
		expect(codex.command).not.toContain("--model sonnet");
		expect(codex.model).toBe("codex");
		expect(read(codex.command)).not.toContain("subagent");
		expect(read(codex.command)).toContain("The user escalates from ADE");
	});

	it("uses the new routing for launches after the settings change", () => {
		const project = ensureProjectWorkflow(home, repoA);
		const task = createTask(project, { description: "Fix typo in README" });
		const cheaper = defaultWorkflowSettings();
		cheaper.roles.quick.model = "claude-haiku-5-5";
		const plan = prepareStageLaunch({
			homeDir: home,
			project,
			slug: task.slug,
			stage: "quick",
			settings: cheaper,
			shell: "posix",
			runtime: "claude",
		});
		expect(plan.command).toContain("--model claude-haiku-5-5 ");
	});
});
