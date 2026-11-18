import { describe, expect, it } from "bun:test";
import {
	buildAgentsDefinition,
	fillTasksDir,
	TASKS_DIR_PLACEHOLDER,
	WORKFLOW_SUBAGENTS,
} from "./agent-workflow";

const TASKS_DIR = "C:/Users/pat/.ade/workflow/projects/app-1234567890/tasks";

describe("workflow roles", () => {
	it("routes routine work to cheap models and exceptional work to Fable", () => {
		const models = Object.fromEntries(
			WORKFLOW_SUBAGENTS.map((agent) => [agent.name, agent.model]),
		);
		expect(models).toEqual({
			planner: "opus",
			architect: "fable",
			implementer: "sonnet",
			quick: "haiku",
			reviewer: "sonnet",
		});
	});

	it("keeps the reviewer read-only and limits every role's turns", () => {
		const reviewer = WORKFLOW_SUBAGENTS.find((a) => a.name === "reviewer");
		expect(reviewer?.tools).not.toContain("Write");
		expect(reviewer?.tools).not.toContain("Edit");
		for (const agent of WORKFLOW_SUBAGENTS) {
			expect(agent.maxTurns).toBeGreaterThan(0);
		}
	});

	it("refers to task files only through the task-folder placeholder", () => {
		for (const agent of WORKFLOW_SUBAGENTS) {
			expect(agent.prompt).toContain(TASKS_DIR_PLACEHOLDER);
			// Nothing is written into the repository any more.
			expect(agent.prompt).not.toContain(".ade/tasks");
			expect(agent.description).not.toContain(".ade/tasks");
		}
	});
});

describe("buildAgentsDefinition", () => {
	const definition = buildAgentsDefinition(WORKFLOW_SUBAGENTS, TASKS_DIR);

	it("produces Claude Code --agents JSON for every role", () => {
		expect(Object.keys(definition).sort()).toEqual([
			"architect",
			"implementer",
			"planner",
			"quick",
			"reviewer",
		]);
		// The fields Claude Code 2.1.193 validates for --agents.
		for (const role of Object.values(definition)) {
			expect(role.description.length).toBeGreaterThan(0);
			expect(role.prompt.length).toBeGreaterThan(0);
			expect(["low", "medium", "high", "xhigh", "max"]).toContain(role.effort);
			expect(Number.isInteger(role.maxTurns) && role.maxTurns > 0).toBe(true);
			if (role.tools) expect(Array.isArray(role.tools)).toBe(true);
		}
		// Round-trips through JSON (what the wrapper passes on the command line).
		expect(JSON.parse(JSON.stringify(definition))).toEqual(definition);
	});

	it("points every prompt at the project's task folder", () => {
		for (const role of Object.values(definition)) {
			expect(role.prompt).toContain(TASKS_DIR);
			expect(role.prompt).not.toContain(TASKS_DIR_PLACEHOLDER);
		}
	});

	it("omits tools for roles that get every tool", () => {
		expect(definition.implementer.tools).toBeUndefined();
		expect(definition.reviewer.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
	});
});

describe("fillTasksDir", () => {
	it("replaces every placeholder", () => {
		expect(
			fillTasksDir(
				`${TASKS_DIR_PLACEHOLDER}/a ${TASKS_DIR_PLACEHOLDER}/b`,
				"/x",
			),
		).toBe("/x/a /x/b");
	});
});
