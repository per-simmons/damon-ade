import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_SUBAGENTS } from "./agent-workflow";
import {
	defaultWorkflowSettings,
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

describe("workflow settings", () => {
	it("defaults to the built-in roles", () => {
		const defaults = defaultWorkflowSettings();
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
		expect(loaded.roles.planner.model).toBe("opus");

		const changed = withRole(loaded, "quick", { maxTurns: 5 });
		saveWorkflowSettings(dir, changed);
		expect(loadWorkflowSettings(dir)).toEqual(changed);
	});

	it("ignores keys from older versions", () => {
		writeFileSync(
			workflowSettingsPath(dir),
			JSON.stringify({ mainModel: "opus", appliedMainModel: "sonnet" }),
			"utf8",
		);
		expect(loadWorkflowSettings(dir)).toEqual(defaultWorkflowSettings());
	});

	it("falls back to defaults when the file is invalid", () => {
		writeFileSync(workflowSettingsPath(dir), "{not json", "utf8");
		expect(loadWorkflowSettings(dir)).toEqual(defaultWorkflowSettings());
		writeFileSync(
			workflowSettingsPath(dir),
			JSON.stringify({ roles: { planner: { model: "$(id)" } } }),
			"utf8",
		);
		expect(loadWorkflowSettings(dir)).toEqual(defaultWorkflowSettings());
	});
});
