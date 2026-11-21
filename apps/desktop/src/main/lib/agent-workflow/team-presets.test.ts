import { describe, expect, it } from "bun:test";
import { BUILT_IN_TEMPLATES } from "./specialist-templates";
import { findTeamPreset, planPreset, TEAM_PRESETS } from "./team-presets";

const templates = BUILT_IN_TEMPLATES.map((t) => ({ id: t.id, name: t.name }));

describe("team presets", () => {
	it("every preset names only built-in templates, without repeats", () => {
		const ids = new Set(templates.map((t) => t.id));
		for (const preset of TEAM_PRESETS) {
			expect(preset.templates.every((id) => ids.has(id))).toBe(true);
			expect(new Set(preset.templates).size).toBe(preset.templates.length);
		}
		expect(findTeamPreset("web-app")?.templates).toHaveLength(11);
		expect(findTeamPreset("game-dev")?.templates[0]).toBe("gamedev");
	});

	it("a new team gets an agent and a specialist per template", () => {
		const steps = planPreset(
			findTeamPreset("minimal") as NonNullable<
				ReturnType<typeof findTeamPreset>
			>,
			templates,
			[{ workspaceId: "main", name: "default" }],
			[],
		);
		expect(
			steps.map((s) => [s.agentName, s.agentWorkspaceId, s.specialist]),
		).toEqual([
			["Frontend Agent", undefined, "create"],
			["Backend Agent", undefined, "create"],
			["QA and testing Agent", undefined, "create"],
		]);
	});

	it("applying again, or over a team's own setup, adds only what is missing", () => {
		const steps = planPreset(
			findTeamPreset("minimal") as NonNullable<
				ReturnType<typeof findTeamPreset>
			>,
			templates,
			[
				{ workspaceId: "fe", name: "frontend agent" },
				{ workspaceId: "be", name: "Backend Agent" },
			],
			[
				{ id: "s1", name: "Frontend", agentWorkspaceId: "fe" },
				{ id: "s2", name: "backend" },
			],
		);
		expect(
			steps.map((s) => [
				s.agentName,
				s.agentWorkspaceId,
				s.specialist,
				s.specialistId,
			]),
		).toEqual([
			["Frontend Agent", "fe", "keep", "s1"],
			["Backend Agent", "be", "assign", "s2"],
			["QA and testing Agent", undefined, "create", undefined],
		]);
	});
});
