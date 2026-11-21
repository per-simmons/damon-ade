import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProjectWorkflow } from "./project-workflow";
import { saveSpecialist } from "./specialists";
import { WORKFLOW_ENV, workflowEnvFor } from "./workflow-env";

const home = mkdtempSync(join(tmpdir(), "ade-workflow-env-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("an agent's own Claude Code sessions", () => {
	const root = join(home, "repo");
	const project = ensureProjectWorkflow(home, root);
	saveSpecialist(
		project,
		{
			name: "Security",
			specialty: "Security",
			templateId: "security",
			templateUses: { instructions: true, models: true },
			agentWorkspaceId: "ws-security",
		},
		new Date(),
		home,
	);
	saveSpecialist(
		project,
		{
			name: "Writer",
			specialty: "Docs",
			roles: { implementer: { model: "opus", effort: "low" } },
			agentWorkspaceId: "ws-writer",
		},
		new Date(),
		home,
	);

	it("run on the Implementer model and effort of the specialist the agent owns", () => {
		const env = workflowEnvFor(home, {
			rootPath: root,
			workspaceId: "ws-security",
		});
		expect(env?.[WORKFLOW_ENV.sessionModel]).toBe("sonnet");
		expect(env?.[WORKFLOW_ENV.sessionEffort]).toBe("high");
		// A user's own setting on the specialist wins over the template.
		const writer = workflowEnvFor(home, {
			rootPath: root,
			workspaceId: "ws-writer",
		});
		expect(writer?.[WORKFLOW_ENV.sessionModel]).toBe("opus");
		expect(writer?.[WORKFLOW_ENV.sessionEffort]).toBe("low");
	});

	it("keep Claude Code's default in the team's own folder and for agents without a specialty", () => {
		for (const workspaceId of [undefined, "ws-main"]) {
			const env = workflowEnvFor(home, { rootPath: root, workspaceId });
			expect(env?.[WORKFLOW_ENV.projectKey]).toBeTruthy();
			expect(env?.[WORKFLOW_ENV.sessionModel]).toBeUndefined();
		}
	});
});
