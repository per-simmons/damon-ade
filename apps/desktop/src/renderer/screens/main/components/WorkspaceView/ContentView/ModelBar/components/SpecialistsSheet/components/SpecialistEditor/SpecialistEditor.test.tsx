import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	ModelCatalog,
	SpecialistDraft,
	SpecialistList,
	TemplateView,
} from "../../types";
import { SpecialistEditor } from "./SpecialistEditor";

/**
 * The editor shows one list called "Roles": the workflow's roles, roles a
 * template added and the user's own roles, each with the same controls.
 */

const role = (model: string) => ({ model, effort: "medium", maxTurns: 20 });
const list = {
	team: { name: "web", root: "/web" },
	global: {
		planner: role("opus"),
		architect: role("fable"),
		implementer: role("sonnet"),
		reviewer: role("sonnet"),
		quick: role("haiku"),
	},
	baseRoles: [
		{ role: "planner", label: "Planner" },
		{ role: "architect", label: "Architect" },
		{ role: "implementer", label: "Implementer" },
		{ role: "reviewer", label: "Reviewer" },
		{ role: "quick", label: "Quick Worker" },
	],
	specialists: [],
} as unknown as SpecialistList;

const templates = [
	{
		id: "ui",
		builtIn: true,
		name: "UI",
		specialty: "UI",
		instructions: "Build UI.",
		keywords: ["ui"],
		roles: {},
		customRoles: [],
		customRoleCount: 1,
	},
] as unknown as TemplateView[];

const models = {
	runtime: "Claude Code",
	note: "",
	models: [
		{
			value: "haiku",
			label: "Haiku 5.5",
			exactId: "claude-haiku-5-5",
			priced: true,
		},
		{
			value: "sonnet",
			label: "Sonnet 5.5",
			exactId: "claude-sonnet-5-5",
			priced: true,
		},
	],
} as ModelCatalog;

const draft: SpecialistDraft = {
	name: "UI",
	specialty: "UI",
	templateId: "ui",
	templateUses: { instructions: true, models: true },
	roles: {},
	customRoles: [
		{
			id: "ui-accessibility-reviewer",
			name: "Accessibility Reviewer",
			description: "Checks changed UI for accessibility problems.",
			instructions: "Review accessibility.",
			access: "read-only",
			trigger: "after-implementation",
			keywords: ["dialog"],
			expectedOutput: "VERDICT",
			model: "haiku",
			fromTemplate: "ui",
		},
	],
	disabledTemplateRoles: [],
	appliedTemplates: ["ui"],
};

const noop = () => {};

describe("SpecialistEditor", () => {
	it("shows every role in one Roles list with the same controls", () => {
		const html = renderToStaticMarkup(
			<SpecialistEditor
				initial={draft}
				list={list}
				templates={templates}
				models={models}
				busy={false}
				onSave={noop}
				onSaveTemplate={noop}
				onCancel={noop}
			/>,
		);
		const roles = html.slice(html.indexOf("data-roles"));
		for (const name of ["Planner", "Implementer", "Reviewer", "Quick Worker"]) {
			expect(roles).toContain(name);
		}
		expect(roles).toContain('value="Accessibility Reviewer"');
		expect(roles).toContain("Added by the UI template");
		// The same controls for the workflow's roles and the template's role.
		expect(roles).toContain('aria-label="Planner model"');
		expect(roles).toContain('aria-label="Accessibility Reviewer model"');
		expect(roles).toContain(
			'aria-label="Accessibility Reviewer maximum turns"',
		);
		expect(roles).toContain('aria-label="Accessibility Reviewer effort"');
		expect(roles).toContain('aria-label="Accessibility Reviewer instructions"');
		// No separate groupings.
		for (const label of [
			"Base roles",
			"Basic roles",
			"Custom roles",
			"Roles from the template",
		]) {
			expect(html).not.toContain(label);
		}
		expect(html).toContain(">Roles<");
	});
});
