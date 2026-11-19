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
	type ProjectWorkflow,
	portablePath,
	projectKeyFor,
	refreshAllProjectWorkflows,
} from "./project-workflow";
import { buildResumeCommand, stageModel } from "./stage-launch";
import {
	createTask,
	getTask,
	listTaskRecords,
	readTaskFiles,
	type TaskIdentity,
	withTaskLock,
} from "./tasks";
import {
	defaultWorkflowSettings,
	saveWorkflowSettings,
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

const LIMITS = {
	budgetUsd: 10,
	maxCorrections: 2,
	maxReviewRounds: 3,
	maxEscalations: 2,
};

function identity(worktreePath: string): TaskIdentity {
	return { workspaceId: "ws", worktreePath, baselineDirty: {} };
}

function newTask(
	project: ProjectWorkflow,
	description: string,
	extra: { route?: "quick" | "implement" | "plan" | "exceptional" } = {},
) {
	return createTask(project, {
		description,
		identity: identity(project.root),
		limits: LIMITS,
		...extra,
	});
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
		newTask(project, "Fix the crash on empty lists");
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
			expect(agents["ade-implementer"].model).toBe("opus");
			expect(agents["ade-planner"].prompt).toContain(
				portablePath(project.tasksDir),
			);
		}
	});
});

describe("tasks", () => {
	it("routes new tasks automatically, or as the user chose", () => {
		const project = ensureProjectWorkflow(home, repoA);
		const auto = newTask(project, "Fix typo in README");
		expect(auto.route).toBe("quick");
		expect(auto.routeReasons.length).toBeGreaterThan(0);
		expect(auto.mode).toBe("auto");
		expect(auto.state).toBe("idle");
		expect(auto.limits).toEqual(LIMITS);

		const chosen = newTask(project, "Fix typo in README", {
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
		newTask(a, "Add checkout button");
		expect(listTaskRecords(a)).toHaveLength(1);
		expect(listTaskRecords(b)).toHaveLength(0);
		// Reopening the project finds the same tasks.
		expect(listTaskRecords(ensureProjectWorkflow(home, repoA))[0].title).toBe(
			"Add checkout button",
		);
	});

	it("rejects empty descriptions and unsafe slugs", () => {
		const project = ensureProjectWorkflow(home, repoA);
		expect(() => newTask(project, "   ")).toThrow();
		expect(getTask(project, "../../etc")).toBeUndefined();
		expect(getTask(project, "missing")).toBeUndefined();
	});

	it("reads the plan's questions and open escalations from the task folder", () => {
		const project = ensureProjectWorkflow(home, repoA);
		const task = newTask(project, "Migrate the session store schema", {
			route: "plan",
		});
		const dir = join(project.tasksDir, task.slug);
		expect(readTaskFiles(project, task.slug)).toEqual({
			hasPlan: false,
			planQuestions: [],
			progressStatus: undefined,
			openEscalations: [],
		});

		writeFileSync(
			join(dir, "plan.md"),
			"# Plan\n\n## Steps\n1. a\n\n## Questions for the user\nNone\n",
			"utf8",
		);
		expect(readTaskFiles(project, task.slug).planQuestions).toEqual([]);
		writeFileSync(
			join(dir, "plan.md"),
			"# Plan\n\n## Questions for the user\n- Keep the old table?\n- Which region?\n\n## Risks\n- none\n",
			"utf8",
		);
		writeFileSync(join(dir, "progress.md"), "Status: blocked\n", "utf8");
		writeFileSync(join(dir, "escalations", "001.md"), "stuck\n", "utf8");
		writeFileSync(
			join(dir, "escalations", "000.md"),
			"old\n\n## Resolution\ndone\n",
			"utf8",
		);
		expect(readTaskFiles(project, task.slug)).toEqual({
			hasPlan: true,
			planQuestions: ["Keep the old table?", "Which region?"],
			progressStatus: "blocked",
			openEscalations: ["001.md"],
		});
	});

	it("upgrades a first-version task to a paused Manual task without replaying it", () => {
		const project = ensureProjectWorkflow(home, repoA);
		const dir = join(project.tasksDir, "old-task");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "task.json"),
			JSON.stringify({
				slug: "old-task",
				title: "Old task",
				description: "Old task",
				route: "plan",
				routeReasons: [],
				createdAt: "2026-01-01T00:00:00.000Z",
				stages: [
					{
						stage: "plan",
						at: "2026-01-01T00:01:00.000Z",
						model: "opus",
						runtime: "claude",
						sessionId: "s-1",
					},
				],
			}),
			"utf8",
		);
		const task = getTask(project, "old-task");
		expect(task?.version).toBe(2);
		expect(task?.mode).toBe("manual");
		expect(task?.state).toBe("paused");
		expect(task?.runs).toHaveLength(1);
		expect(task?.runs[0].status).toBe("interrupted");
		expect(task?.runs[0].model).toBe("opus");
	});

	it("serializes work on one task", async () => {
		const project = ensureProjectWorkflow(home, repoA);
		const order: string[] = [];
		const slow = withTaskLock(project, "t", async () => {
			order.push("a-start");
			await new Promise((resolve) => setTimeout(resolve, 30));
			order.push("a-end");
		});
		const failing = withTaskLock(project, "t", () => {
			order.push("b");
			throw new Error("b failed");
		});
		const after = withTaskLock(project, "t", () => {
			order.push("c");
		});
		await Promise.allSettled([slow, failing, after]);
		// A failure does not break the queue, and nothing interleaves.
		expect(order).toEqual(["a-start", "a-end", "b", "c"]);
		await expect(failing).rejects.toThrow("b failed");
	});
});

describe("stage models", () => {
	it("runs each stage on its role's model, and Fable plans exceptional tasks", () => {
		const settings = defaultWorkflowSettings();
		const plain = { route: "plan" as const };
		expect(stageModel("plan", plain, settings)).toBe("opus");
		expect(stageModel("build", plain, settings)).toBe("sonnet");
		expect(stageModel("fix", plain, settings)).toBe("sonnet");
		expect(stageModel("review", plain, settings)).toBe("sonnet");
		expect(stageModel("quick", plain, settings)).toBe("haiku");
		expect(stageModel("escalate", plain, settings)).toBe("fable");
		expect(stageModel("plan", { route: "exceptional" }, settings)).toBe(
			"fable",
		);
	});

	it("opens a run's session without a permission bypass", () => {
		expect(buildResumeCommand("3f2b8c1e-9a4d")).toBe(
			"claude --resume 3f2b8c1e-9a4d",
		);
		expect(() => buildResumeCommand("x; rm -rf ~")).toThrow();
	});
});
