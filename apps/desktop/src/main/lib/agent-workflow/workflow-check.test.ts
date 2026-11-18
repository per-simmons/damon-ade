import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	upgradeAgentWorkflow,
	writeAgentWorkflowFiles,
} from "./agent-workflow";
import {
	checkAgentWorkflow,
	checkClaudeCliSupport,
	isPlausibleModel,
	parseFrontmatter,
} from "./workflow-check";

let worktree: string;

beforeEach(() => {
	worktree = mkdtempSync(join(tmpdir(), "ade-workflow-check-"));
	mkdirSync(join(worktree, ".git", "info"), { recursive: true });
	mkdirSync(join(worktree, ".claude"), { recursive: true });
	writeFileSync(join(worktree, "CLAUDE.md"), "@memory/AGENT.md\n", "utf8");
	writeFileSync(join(worktree, ".claude", "settings.json"), "{}\n", "utf8");
});

afterEach(() => {
	rmSync(worktree, { recursive: true, force: true });
});

const role = (check: ReturnType<typeof checkAgentWorkflow>, name: string) =>
	check.roles.find((r) => r.name === name);

describe("checkAgentWorkflow", () => {
	it("reports every role on its configured model after an upgrade", () => {
		upgradeAgentWorkflow(worktree);
		const check = checkAgentWorkflow(worktree);
		expect(check.ok).toBe(true);
		const models = Object.fromEntries(
			check.roles.map((r) => [r.name, `${r.state}:${r.actual?.model}`]),
		);
		expect(models).toEqual({
			planner: "default:fable",
			architect: "default:fable",
			implementer: "default:sonnet",
			quick: "default:haiku",
			reviewer: "default:sonnet",
		});
		expect(check.mainModel.actual).toBe("sonnet");
		expect(check.bridgePointer).toBe(true);
		expect(check.adeExcluded).toBe(true);
		expect(check.commands.every((c) => c.state === "default")).toBe(true);
	});

	it("keeps a valid customization and reports the model actually used", () => {
		writeAgentWorkflowFiles(worktree);
		writeFileSync(
			join(worktree, ".claude", "agents", "implementer.md"),
			"---\nname: implementer\ndescription: mine\nmodel: opus\neffort: high\nmaxTurns: 60\n---\nMy instructions.\n",
			"utf8",
		);
		const check = checkAgentWorkflow(worktree);
		const implementer = role(check, "implementer");
		expect(implementer?.state).toBe("customized");
		expect(implementer?.actual).toMatchObject({
			model: "opus",
			effort: "high",
			maxTurns: "60",
		});
		expect(implementer?.expected.model).toBe("sonnet");
		expect(check.ok).toBe(true);
	});

	it("flags values Claude Code would reject or misread", () => {
		writeAgentWorkflowFiles(worktree);
		writeFileSync(
			join(worktree, ".claude", "agents", "quick.md"),
			"---\nname: quick\ndescription: x\nmodel: gpt-9\neffort: extreme\nmaxTurns: 0\ntools: Read, Teleport\n---\nx\n",
			"utf8",
		);
		writeFileSync(
			join(worktree, ".claude", "agents", "reviewer.md"),
			"No frontmatter at all.\n",
			"utf8",
		);
		const check = checkAgentWorkflow(worktree);
		expect(check.ok).toBe(false);
		expect(role(check, "quick")?.state).toBe("invalid");
		expect(role(check, "quick")?.problems).toEqual([
			'unrecognized model "gpt-9"',
			'invalid effort "extreme"',
			'maxTurns must be a positive integer, not "0"',
			'unknown tool "Teleport"',
		]);
		expect(role(check, "reviewer")?.state).toBe("invalid");
	});

	it("reports missing files and a missing workflow pointer", () => {
		const check = checkAgentWorkflow(worktree);
		expect(check.ok).toBe(false);
		expect(check.roles.every((r) => r.state === "missing")).toBe(true);
		expect(check.bridgePointer).toBe(false);
		expect(check.adeExcluded).toBe(false);
		expect(check.mainModel.actual).toBeUndefined();
	});

	it("flags a command that dropped $ARGUMENTS", () => {
		writeAgentWorkflowFiles(worktree);
		writeFileSync(
			join(worktree, ".claude", "commands", "build.md"),
			"---\ndescription: x\n---\nBuild it.\n",
			"utf8",
		);
		const build = checkAgentWorkflow(worktree).commands.find(
			(c) => c.name === "build",
		);
		expect(build?.state).toBe("invalid");
	});

	it("reports invalid settings JSON", () => {
		writeFileSync(join(worktree, ".claude", "settings.json"), "{", "utf8");
		expect(checkAgentWorkflow(worktree).mainModel.problems).toEqual([
			".claude/settings.json is not valid JSON",
		]);
	});
});

describe("helpers", () => {
	it("accepts aliases and model IDs, rejects others", () => {
		for (const model of [
			"fable",
			"sonnet",
			"haiku",
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

	it("parses quoted and plain frontmatter values", () => {
		expect(
			parseFrontmatter('---\ndescription: "a: b"\nmodel: haiku\n---\nbody'),
		).toEqual({ description: "a: b", model: "haiku" });
		expect(parseFrontmatter("no frontmatter")).toBeUndefined();
	});

	it("finds the markers in a CLI binary", () => {
		const fake = join(worktree, "claude.bin");
		writeFileSync(
			fake,
			"...has invalid effort '...ANTHROPIC_DEFAULT_FABLE_MODEL...",
			"utf8",
		);
		expect(checkClaudeCliSupport(fake)).toEqual({
			binaryPath: fake,
			supportsEffortField: true,
			supportsMaxTurnsField: false,
			knowsFableAlias: true,
		});
		expect(checkClaudeCliSupport(join(worktree, "nope"))).toBeUndefined();
	});
});
