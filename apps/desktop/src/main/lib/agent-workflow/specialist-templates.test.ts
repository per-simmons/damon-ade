import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTask } from "shared/utils/task-routing";
import { customRoleContext, stageRouting } from "./controller";
import { PINNED_MODEL_IDS } from "./models";
import { BUILT_IN_TEMPLATES } from "./specialist-templates";
import {
	applicableCustomRoles,
	listPersonalTemplates,
	resolveSpecialist,
	type Specialist,
	savePersonalTemplate,
	validateConfig,
} from "./specialists";
import type { TaskRecord } from "./tasks";
import { defaultWorkflowSettings, ROLE_NAMES } from "./workflow-settings";

/**
 * The built-in templates as recommended presets: every role has an explicit
 * model and effort, roles are specialized per template, added roles are
 * conditional, and the settings resolve and route as documented.
 */

const home = mkdtempSync(join(tmpdir(), "ade-templates-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const settings = defaultWorkflowSettings();
const PRESET_EFFORTS = ["low", "medium", "high"];

function specialist(
	templateId: string,
	extra: Partial<Specialist> = {},
): Specialist {
	return {
		id: `spec-${templateId}`,
		name: templateId,
		specialty: templateId,
		templateId,
		templateUses: { instructions: true, models: true },
		roles: {},
		customRoles: [],
		disabledTemplateRoles: [],
		createdAt: "",
		updatedAt: "",
		...extra,
	};
}

function task(
	description: string,
	route: TaskRecord["route"] = "implement",
): TaskRecord {
	return {
		version: 2,
		slug: "t",
		title: description,
		description,
		route,
		routeReasons: [],
		createdAt: "",
		mode: "auto",
		state: "idle",
		identity: { workspaceId: "w", worktreePath: home, baselineDirty: {} },
		limits: {
			budgetUsd: 5,
			maxCorrections: 2,
			maxReviewRounds: 3,
			maxEscalations: 2,
		},
		runs: [],
	};
}

const EXPECTED: Record<string, string> = {
	// planner, architect, implementer, reviewer, quick
	ui: "sonnet/medium sonnet/high sonnet/medium sonnet/high haiku/medium",
	ux: "sonnet/high opus/medium sonnet/medium sonnet/high haiku/medium",
	frontend: "sonnet/medium sonnet/high sonnet/medium sonnet/high haiku/medium",
	backend: "sonnet/high opus/medium sonnet/medium sonnet/high haiku/medium",
	api: "sonnet/high opus/medium sonnet/medium sonnet/high haiku/medium",
	database: "opus/medium opus/high sonnet/high opus/high haiku/medium",
	qa: "sonnet/high sonnet/high sonnet/medium sonnet/high haiku/medium",
	security: "opus/high opus/high sonnet/high opus/high haiku/medium",
	devops: "sonnet/high opus/medium sonnet/high sonnet/high haiku/medium",
	performance: "sonnet/high opus/high sonnet/high sonnet/high haiku/medium",
	documentation:
		"sonnet/medium sonnet/medium sonnet/medium sonnet/medium haiku/medium",
	mobile: "sonnet/medium opus/medium sonnet/medium sonnet/high haiku/medium",
	desktop: "sonnet/high opus/medium sonnet/medium sonnet/high haiku/medium",
	gamedev: "sonnet/high opus/medium sonnet/medium sonnet/high haiku/medium",
};

describe("built-in templates", () => {
	it("1. every template sets model and effort for all five roles, from the template", () => {
		expect(BUILT_IN_TEMPLATES.map((t) => t.id).sort()).toEqual(
			Object.keys(EXPECTED).sort(),
		);
		for (const template of BUILT_IN_TEMPLATES) {
			const resolved = resolveSpecialist(
				specialist(template.id),
				settings,
				home,
			);
			const order = [
				"planner",
				"architect",
				"implementer",
				"reviewer",
				"quick",
			] as const;
			const got = order
				.map(
					(role) =>
						`${resolved.roles[role].model}/${resolved.roles[role].effort}`,
				)
				.join(" ");
			expect(`${template.id}: ${got}`).toBe(
				`${template.id}: ${EXPECTED[template.id]}`,
			);
			for (const role of ROLE_NAMES) {
				expect(resolved.roles[role].source).toMatchObject({
					model: "template",
					effort: "template",
				});
				expect(PRESET_EFFORTS).toContain(resolved.roles[role].effort);
				// 5. All five roles are specialized, not only planner and reviewer.
				expect(resolved.roles[role].instructions.length).toBe(1);
				expect(PINNED_MODEL_IDS[resolved.roles[role].model]).toBeDefined();
			}
			// Turn limits inherit the global defaults.
			expect(resolved.roles.implementer.source.maxTurns).toBe("global");
			expect(validateConfig(template)).toEqual([]);
		}
	});

	it("2. every added role has an explicit model, effort, turn limit and trigger", () => {
		for (const template of BUILT_IN_TEMPLATES) {
			expect(template.customRoles.length).toBeGreaterThan(0);
			for (const role of template.customRoles) {
				expect(role.id).toMatch(/^[a-z0-9-]+$/);
				expect(role.model && PINNED_MODEL_IDS[role.model]).toBeTruthy();
				expect(PRESET_EFFORTS).toContain(role.effort ?? "");
				expect(role.maxTurns).toBeGreaterThan(0);
				expect(role.access).toBe("read-only");
				expect(role.keywords.length).toBeGreaterThan(0);
				expect(role.expectedOutput).toContain("VERDICT");
				expect(role.instructions.length).toBeGreaterThan(100);
				// No preset uses Fable or xhigh/max.
				expect(role.model).not.toBe("fable");
			}
		}
		const ids = BUILT_IN_TEMPLATES.flatMap((t) =>
			t.customRoles.map((r) => r.id),
		);
		expect(new Set(ids).size).toBe(ids.length);
		// Stable ids of roles that existed before keep their ids.
		expect(ids).toEqual(
			expect.arrayContaining([
				"ui-accessibility-reviewer",
				"backend-api-contract-reviewer",
				"database-migration-reviewer",
				"security-threat-modeler",
				"gamedev-gameplay-reviewer",
			]),
		);
	});

	it("3. UI and UX differ in every role's instructions and in their added roles", () => {
		const ui = BUILT_IN_TEMPLATES.find((t) => t.id === "ui");
		const ux = BUILT_IN_TEMPLATES.find((t) => t.id === "ux");
		expect(ui?.instructions).not.toBe(ux?.instructions);
		for (const role of ROLE_NAMES) {
			expect(ui?.roles[role]?.instructions).not.toBe(
				ux?.roles[role]?.instructions,
			);
		}
		expect(ui?.customRoles.map((r) => r.name)).toEqual([
			"Accessibility Reviewer",
			"Visual Consistency Reviewer",
		]);
		expect(ux?.customRoles.map((r) => r.name)).toEqual([
			"Usability and Journey Reviewer",
		]);
	});

	it("6 and 7. specialist and task overrides win; clearing one restores the template", () => {
		const custom = specialist("security", {
			roles: { reviewer: { model: "sonnet" } },
		});
		let resolved = resolveSpecialist(custom, settings, home, {
			implementer: { effort: "medium" },
		});
		expect(resolved.roles.reviewer).toMatchObject({
			model: "sonnet",
			source: { model: "specialist" },
		});
		expect(resolved.roles.implementer).toMatchObject({
			effort: "medium",
			source: { effort: "task" },
		});
		resolved = resolveSpecialist(specialist("security"), settings, home);
		expect(resolved.roles.reviewer).toMatchObject({
			model: "opus",
			effort: "high",
			source: { model: "template" },
		});
		// "Instructions only" keeps the global models.
		resolved = resolveSpecialist(
			specialist("security", {
				templateUses: { instructions: true, models: false },
			}),
			settings,
			home,
		);
		expect(resolved.roles.reviewer.source.model).toBe("global");
	});

	it("9. personal templates keep customized model and effort", () => {
		const saved = savePersonalTemplate(home, {
			name: "Strict backend",
			specialty: "Backend",
			instructions: "x",
			keywords: [],
			roles: {
				reviewer: { model: "opus", effort: "high" },
				quick: { model: "sonnet", effort: "low" },
			},
			customRoles: [],
		});
		const back = listPersonalTemplates(home).find((t) => t.id === saved.id);
		expect(back?.roles.reviewer).toEqual({ model: "opus", effort: "high" });
		expect(back?.roles.quick).toEqual({ model: "sonnet", effort: "low" });
	});

	it("11. unsupported settings are refused with a reason", () => {
		expect(
			validateConfig({
				roles: { planner: { model: "gpt-5" } },
				customRoles: [],
			}).join(),
		).toContain("not a Claude Code model");
		expect(
			validateConfig({
				roles: { planner: { effort: "extreme" as never } },
				customRoles: [],
			}).join(),
		).toContain("unknown effort");
	});

	it("12 and 13. a trivial task runs no added roles; a relevant one, and a sensitive changed file, trigger them", () => {
		const resolved = resolveSpecialist(specialist("database"), settings, home);
		const specialists = { primary: resolved, supporting: [] };
		// Quick tasks never get extra roles.
		expect(
			customRoleContext(
				specialists,
				task("Fix typo in the schema comment", "quick"),
			),
		).toEqual({
			before: [],
			after: [],
		});
		// Wording that names nothing sensitive: no reviewer...
		expect(
			customRoleContext(specialists, task("Speed up the report page")).after,
		).toEqual([]);
		// ...unless the change touched a migration file.
		expect(
			customRoleContext(specialists, task("Speed up the report page"), [
				"packages/db/drizzle/0007_add_index.sql",
			]).after.map((r) => r.name),
		).toEqual(["Migration Safety Reviewer"]);
		expect(
			applicableCustomRoles(
				resolved,
				"Add a column for the user's timezone",
				"after-implementation",
			).map((r) => r.name),
		).toEqual(["Migration Safety Reviewer"]);
		// Security: the threat modeler runs before implementation, from the task's wording.
		const security = resolveSpecialist(specialist("security"), settings, home);
		expect(
			customRoleContext(
				{ primary: security, supporting: [] },
				task("Let admins reset another user's password"),
			).before.map((r) => r.name),
		).toEqual(["Threat Modeler"]);
	});

	it("14. a short but risky edit is never a Quick Worker task", () => {
		expect(classifyTask("Fix typo in README").route).toBe("quick");
		for (const risky of [
			"Small fix to the login permission check",
			"Tiny change: rename the session token cookie",
			"Minor tweak to the SQL in the export job",
			"One-line fix to the upload size check",
		]) {
			const decision = classifyTask(risky);
			expect(`${risky}: ${decision.route}`).not.toBe(`${risky}: quick`);
			expect(decision.reasons[0]).toContain("not a quick change");
		}
	});

	it("16. the Exceptional route escalates to the global Architect, not the template's Opus preset", () => {
		const resolved = resolveSpecialist(specialist("backend"), settings, home);
		const specialists = { primary: resolved, supporting: [] };
		expect(
			stageRouting(specialists, task("x", "exceptional"), settings, "plan")
				.routing,
		).toMatchObject({
			role: "Architect",
			model: "fable",
			effort: "high",
		});
		// The ordinary escalation stage uses the template's Architect.
		expect(
			stageRouting(specialists, task("x", "plan"), settings, "escalate")
				.routing,
		).toMatchObject({
			model: "opus",
			effort: "medium",
		});
		// A user's explicit Architect choice is honoured on the Exceptional route.
		const chosen = resolveSpecialist(
			specialist("backend", { roles: { architect: { model: "opus" } } }),
			settings,
			home,
		);
		expect(
			stageRouting(
				{ primary: chosen, supporting: [] },
				task("x", "exceptional"),
				settings,
				"plan",
			).routing.model,
		).toBe("opus");
	});
});
