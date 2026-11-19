import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observedModelsByRole } from "../../../../scripts/ade-workflow";
import { ensureProjectWorkflow, portablePath } from "./project-workflow";
import {
	checkAgentsFile,
	checkClaudeCliSupport,
	isPlausibleModel,
	modelMatches,
} from "./workflow-check";
import { defaultWorkflowSettings } from "./workflow-settings";

let home: string;
let root: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ade-check-home-"));
	root = mkdtempSync(join(tmpdir(), "ade-check-project-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
});

const expected = () => defaultWorkflowSettings().roles;

describe("checkAgentsFile", () => {
	it("passes for a freshly generated project", () => {
		const project = ensureProjectWorkflow(home, root);
		const check = checkAgentsFile(
			project.agentsFile,
			expected(),
			portablePath(project.tasksDir),
		);
		expect(check.ok).toBe(true);
		expect(
			Object.fromEntries(check.roles.map((r) => [r.name, r.model])),
		).toEqual({
			planner: "opus",
			architect: "fable",
			implementer: "sonnet",
			quick: "haiku",
			reviewer: "sonnet",
		});
	});

	it("reports routing that differs from the settings", () => {
		const project = ensureProjectWorkflow(home, root);
		const json = JSON.parse(readFileSync(project.agentsFile, "utf8"));
		json["ade-quick"].model = "opus";
		json["ade-reviewer"].maxTurns = 0;
		delete json["ade-architect"];
		writeFileSync(project.agentsFile, JSON.stringify(json), "utf8");
		const check = checkAgentsFile(
			project.agentsFile,
			expected(),
			portablePath(project.tasksDir),
		);
		expect(check.ok).toBe(false);
		const problems = Object.fromEntries(
			check.roles.map((r) => [r.name, r.problems]),
		);
		expect(problems.quick).toEqual(["model is opus, settings say haiku"]);
		expect(problems.reviewer).toEqual(["maxTurns must be a positive integer"]);
		expect(problems.architect).toEqual(["missing"]);
	});

	it("reports prompts that point at another project's task folder", () => {
		const project = ensureProjectWorkflow(home, root);
		const check = checkAgentsFile(project.agentsFile, expected(), "/elsewhere");
		expect(check.roles[0].problems).toContain(
			"prompt does not point at this project's task folder",
		);
	});

	it("reports a missing or broken file", () => {
		expect(
			checkAgentsFile(join(home, "nope.json"), expected(), "/x").problems,
		).toEqual(["agents.json is missing"]);
		const broken = join(home, "broken.json");
		writeFileSync(broken, "{", "utf8");
		expect(checkAgentsFile(broken, expected(), "/x").problems).toEqual([
			"agents.json is not valid JSON",
		]);
	});
});

describe("models", () => {
	it("accepts aliases and model IDs, rejects others", () => {
		for (const model of [
			"fable",
			"sonnet",
			"inherit",
			"opus[1m]",
			"claude-sonnet-5-5",
		]) {
			expect(isPlausibleModel(model)).toBe(true);
		}
		for (const model of ["gpt-5.5", "Sonnet", "claude sonnet", ""]) {
			expect(isPlausibleModel(model)).toBe(false);
		}
	});

	it("matches an alias to any model of its tier and a full ID only to itself", () => {
		expect(modelMatches("sonnet", "claude-sonnet-5-5")).toBe(true);
		expect(modelMatches("fable", "claude-fable-5-2")).toBe(true);
		expect(modelMatches("best", "claude-opus-5-5")).toBe(true);
		expect(modelMatches("inherit", "claude-haiku-5-5")).toBe(true);
		expect(modelMatches("sonnet", "claude-opus-5-5")).toBe(false);
		expect(modelMatches("claude-sonnet-5-5", "claude-sonnet-5")).toBe(false);
	});
});

describe("checkClaudeCliSupport", () => {
	it("finds the markers in a CLI binary", () => {
		const fake = join(home, "claude.bin");
		writeFileSync(
			fake,
			"--agents <json> ... has invalid effort '...ANTHROPIC_DEFAULT_FABLE_MODEL...",
			"utf8",
		);
		expect(checkClaudeCliSupport(fake)).toEqual({
			binaryPath: fake,
			supportsAgentsFlag: true,
			supportsEffortField: true,
			supportsMaxTurnsField: false,
			knowsFableAlias: true,
		});
		expect(checkClaudeCliSupport(join(home, "nope"))).toBeUndefined();
	});
});

describe("observedModelsByRole", () => {
	const record = (model: string, agentType: string) => ({
		id: `${model}-${agentType}-${Math.random()}`,
		model,
		agentType,
		timestamp: "",
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite5m: 0,
		cacheWrite1h: 0,
	});
	const session = (
		extra: { projectKey?: string; cwd?: string },
		records: ReturnType<typeof record>[],
	) => ({
		schemaVersion: 1,
		sessionId: Math.random().toString(),
		transcriptPath: "/t.jsonl",
		recordedAt: "",
		activeMs: 0,
		humanPrompts: 1,
		subagentCalls: {},
		apiErrors: 0,
		taskSlugs: [],
		tasks: {},
		records,
		...extra,
	});

	it("uses the project key, or the root folder for older sessions", () => {
		const observed = observedModelsByRole(
			[
				session({ projectKey: "app-1", cwd: "/somewhere/else" }, [
					record("claude-opus-5-5", "planner"),
				]),
				session({ cwd: join(root, "/") }, [
					record("claude-sonnet-5-5", "main"),
				]),
				session({ projectKey: "other-2", cwd: root }, [
					record("claude-haiku-5-5", "quick"),
				]),
			],
			"app-1",
			root,
		);
		expect(
			Object.fromEntries([...observed].map(([k, v]) => [k, [...v]])),
		).toEqual({
			planner: ["claude-opus-5-5"],
			main: ["claude-sonnet-5-5"],
		});
	});
});
