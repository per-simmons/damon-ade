/**
 * Team presets: a group of agents, each with a specialty already assigned.
 * Applying one adds an agent per template, named "<Template name> Agent",
 * and a specialist made from that template (its instructions, role models
 * and added roles) that the agent owns. Applying a preset again, or one
 * that shares templates with an earlier one, adds only what is missing.
 */

export interface TeamPreset {
	id: string;
	name: string;
	description: string;
	/** Built-in template ids, in the order the agents are added. */
	templates: string[];
}

export const TEAM_PRESETS: TeamPreset[] = [
	{
		id: "web-app",
		name: "Web app",
		description:
			"Every web template: interface, product, server, data, quality, security, release and docs.",
		templates: [
			"ui",
			"ux",
			"frontend",
			"backend",
			"api",
			"database",
			"qa",
			"security",
			"devops",
			"performance",
			"documentation",
		],
	},
	{
		id: "game-dev",
		name: "Game development",
		description:
			"Gameplay systems with interface, player experience, performance and testing.",
		templates: ["gamedev", "ui", "ux", "performance", "qa", "documentation"],
	},
	{
		id: "mobile-app",
		name: "Mobile app",
		description:
			"The app on the device, its interface, the API behind it, and security.",
		templates: [
			"mobile",
			"ui",
			"ux",
			"api",
			"backend",
			"security",
			"qa",
			"performance",
		],
	},
	{
		id: "desktop-app",
		name: "Desktop app",
		description:
			"Native shell and IPC, interface, testing, security and releases.",
		templates: [
			"desktop",
			"ui",
			"ux",
			"frontend",
			"qa",
			"security",
			"performance",
			"devops",
		],
	},
	{
		id: "backend-service",
		name: "Backend / API service",
		description: "Server, API contracts, data, security, operations and docs.",
		templates: [
			"backend",
			"api",
			"database",
			"security",
			"devops",
			"performance",
			"qa",
			"documentation",
		],
	},
	{
		id: "minimal",
		name: "Small team",
		description: "Three agents: frontend, backend and testing.",
		templates: ["frontend", "backend", "qa"],
	},
];

export function findTeamPreset(id: string): TeamPreset | undefined {
	return TEAM_PRESETS.find((p) => p.id === id);
}

/** The agent's name for a template: "<Template name> Agent". */
export function presetAgentName(templateName: string): string {
	return `${templateName} Agent`;
}

export interface PresetStep {
	templateId: string;
	templateName: string;
	agentName: string;
	/** An agent of that name already in the team, if any. */
	agentWorkspaceId?: string;
	/** "create": a new specialist; "assign": give an existing one this agent; "keep": nothing to do. */
	specialist: "create" | "assign" | "keep";
	specialistId?: string;
}

/**
 * What applying a preset adds to a team, without changing anything: an
 * agent per template (unless one of that name exists), and the template's
 * specialist for it (unless the team already has a specialist of that
 * name; one without an agent is given this agent).
 */
export function planPreset(
	preset: TeamPreset,
	templates: Array<{ id: string; name: string }>,
	agents: Array<{ workspaceId: string; name: string }>,
	specialists: Array<{ id: string; name: string; agentWorkspaceId?: string }>,
): PresetStep[] {
	const steps: PresetStep[] = [];
	for (const templateId of preset.templates) {
		const template = templates.find((t) => t.id === templateId);
		if (!template) continue;
		const agentName = presetAgentName(template.name);
		const agent = agents.find(
			(a) => a.name.toLowerCase() === agentName.toLowerCase(),
		);
		const existing = specialists.find(
			(s) => s.name.toLowerCase() === template.name.toLowerCase(),
		);
		steps.push({
			templateId,
			templateName: template.name,
			agentName,
			agentWorkspaceId: agent?.workspaceId,
			specialist: !existing
				? "create"
				: existing.agentWorkspaceId
					? "keep"
					: "assign",
			specialistId: existing?.id,
		});
	}
	return steps;
}
