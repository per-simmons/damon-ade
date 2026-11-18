import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgradeAgentWorkflow, WORKFLOW_SUBAGENTS } from "./agent-workflow";
import { checkAgentWorkflow } from "./workflow-check";
import {
	applyRouting,
	defaultWorkflowSettings,
	isUneditedGeneratedFile,
	loadWorkflowSettings,
	resolveSubagents,
	saveWorkflowSettings,
	validateWorkflowSettings,
	type WorkflowSettings,
	workflowSettingsPath,
} from "./workflow-settings";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ade-workflow-settings-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function withRole(
	settings: WorkflowSettings,
	role: keyof WorkflowSettings["roles"],
	patch: Partial<WorkflowSettings["roles"]["planner"]>,
): WorkflowSettings {
	return {
		...settings,
		roles: { ...settings.roles, [role]: { ...settings.roles[role], ...patch } },
	};
}

describe("settings", () => {
	it("defaults to the built-in roles and a sonnet main session", () => {
		const defaults = defaultWorkflowSettings();
		expect(defaults.mainModel).toBe("sonnet");
		for (const agent of WORKFLOW_SUBAGENTS) {
			expect(defaults.roles[agent.name as "planner"]).toEqual({
				model: agent.model,
				effort: agent.effort,
				maxTurns: agent.maxTurns,
			});
		}
		expect(resolveSubagents(defaults)).toEqual(WORKFLOW_SUBAGENTS);
	});

	it("rejects bad models, efforts, turn limits and budgets", () => {
		const bad = {
			...withRole(defaultWorkflowSettings(), "quick", {
				model: "gpt-9",
				effort: "extreme" as "low",
				maxTurns: 0,
			}),
			mainModel: "rm -rf",
			budgets: {
				sessionWarnUsd: -1,
				dailyWarnUsd: Number.NaN,
				headlessMaxBudgetUsd: 0,
				headlessMaxTurns: 2.5,
			},
		};
		const result = validateWorkflowSettings(bad);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors).toEqual([
			"main model must be a model alias or a claude-* model ID",
			"quick: model must be a model alias or a claude-* model ID",
			"quick: effort must be one of low, medium, high, xhigh, max",
			"quick: max turns must be a whole number from 1 to 500",
			"session warning must be a positive number or off",
			"daily warning must be a positive number or off",
			"headless budget must be a positive number",
			"headless turn limit must be a whole number from 1 to 500",
		]);
	});

	it("accepts full model IDs and turning warnings off", () => {
		const result = validateWorkflowSettings({
			...withRole(defaultWorkflowSettings(), "planner", {
				model: "claude-fable-5-2",
			}),
			budgets: {
				...defaultWorkflowSettings().budgets,
				sessionWarnUsd: null,
				dailyWarnUsd: 25,
			},
		});
		expect(result.ok).toBe(true);
	});

	it("round-trips and fills missing values from defaults", () => {
		expect(loadWorkflowSettings(dir)).toEqual(defaultWorkflowSettings());
		writeFileSync(
			workflowSettingsPath(dir),
			JSON.stringify({ roles: { implementer: { model: "opus" } } }),
			"utf8",
		);
		const loaded = loadWorkflowSettings(dir);
		expect(loaded.roles.implementer).toEqual({
			model: "opus",
			effort: "medium",
			maxTurns: 40,
		});
		expect(loaded.roles.planner.model).toBe("fable");

		const changed = withRole(loaded, "quick", { maxTurns: 5 });
		saveWorkflowSettings(dir, changed);
		expect(loadWorkflowSettings(dir)).toEqual(changed);
	});

	it("falls back to defaults when the file is invalid", () => {
		writeFileSync(workflowSettingsPath(dir), "{not json", "utf8");
		expect(loadWorkflowSettings(dir)).toEqual(defaultWorkflowSettings());
		writeFileSync(
			workflowSettingsPath(dir),
			JSON.stringify({ mainModel: "$(id)" }),
			"utf8",
		);
		expect(loadWorkflowSettings(dir)).toEqual(defaultWorkflowSettings());
	});
});

describe("applyRouting", () => {
	let worktree: string;
	beforeEach(() => {
		worktree = join(dir, "worktree");
		mkdirSync(join(worktree, ".claude"), { recursive: true });
		writeFileSync(
			join(worktree, ".claude", "settings.json"),
			JSON.stringify({ autoMemoryEnabled: true }),
			"utf8",
		);
		upgradeAgentWorkflow(worktree);
	});

	const read = (...parts: string[]) =>
		readFileSync(join(worktree, ...parts), "utf8");

	it("recognizes ADE's own files with any routing values", () => {
		const implementer = WORKFLOW_SUBAGENTS.find(
			(a) => a.name === "implementer",
		);
		if (!implementer) throw new Error("missing role");
		const content = read(".claude", "agents", "implementer.md");
		expect(isUneditedGeneratedFile(content, implementer)).toBe(true);
		expect(
			isUneditedGeneratedFile(
				content.replace("Implement", "Build"),
				implementer,
			),
		).toBe(false);
	});

	it("moves unedited roles to the new routing and leaves edited ones alone", () => {
		const editedQuick = read(".claude", "agents", "quick.md").replace(
			"You make one small",
			"I make one small",
		);
		writeFileSync(
			join(worktree, ".claude", "agents", "quick.md"),
			editedQuick,
			"utf8",
		);

		let settings = defaultWorkflowSettings();
		settings = withRole(settings, "implementer", {
			model: "opus",
			maxTurns: 60,
		});
		settings = withRole(settings, "quick", { model: "sonnet" });

		const changes = applyRouting(worktree, settings, "sonnet");
		expect(changes).toEqual([join(".claude", "agents", "implementer.md")]);

		const check = checkAgentWorkflow(worktree);
		const implementer = check.roles.find((r) => r.name === "implementer");
		expect(implementer?.actual?.model).toBe("opus");
		expect(implementer?.actual?.maxTurns).toBe("60");
		expect(read(".claude", "agents", "quick.md")).toBe(editedQuick);

		// Applying the same routing again changes nothing.
		expect(applyRouting(worktree, settings, "sonnet")).toEqual([]);
	});

	it("changes the main model only where it still holds ADE's value", () => {
		const settings = { ...defaultWorkflowSettings(), mainModel: "opus" };
		expect(applyRouting(worktree, settings, "sonnet")).toContain(
			join(".claude", "settings.json"),
		);
		expect(JSON.parse(read(".claude", "settings.json"))).toEqual({
			model: "opus",
			autoMemoryEnabled: true,
		});

		// The user picks haiku by hand; ADE's next change must not undo it.
		writeFileSync(
			join(worktree, ".claude", "settings.json"),
			JSON.stringify({ model: "haiku" }),
			"utf8",
		);
		applyRouting(worktree, { ...settings, mainModel: "fable" }, "opus");
		expect(JSON.parse(read(".claude", "settings.json")).model).toBe("haiku");
	});
});
