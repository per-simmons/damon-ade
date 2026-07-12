import { describe, expect, it } from "bun:test";
import { buildAgentCommand, buildAgentPromptCommand } from "./agent-command";

describe("buildAgentPromptCommand", () => {
	it("adds `--` before codex prompt payload", () => {
		const command = buildAgentPromptCommand({
			prompt: "- Only modified file: runtime.ts",
			randomId: "1234-5678",
			agent: "codex",
		});

		expect(command).toContain(
			"--sandbox danger-full-access -- \"$(cat <<'SUPERSET_PROMPT_12345678'",
		);
		expect(command).toContain("- Only modified file: runtime.ts");
	});

	it("does not change non-codex commands", () => {
		const command = buildAgentPromptCommand({
			prompt: "hello",
			randomId: "abcd-efgh",
			agent: "claude",
		});

		expect(command).toStartWith(
			"claude --dangerously-skip-permissions \"$(cat <<'SUPERSET_PROMPT_abcdefgh'",
		);
	});

	it("builds orchestrator prompts around the routing decision", () => {
		const command = buildAgentCommand({
			task: {
				id: "task-1",
				slug: "win-router",
				title: "Integrate router and token cut on Windows",
				description: "Add orchestrator routing for agents and token cutting.",
				priority: "high",
				statusName: "Todo",
				labels: ["windows", "architecture"],
			},
			randomId: "orch-1",
			agent: "orchestrator",
		});

		expect(command).toStartWith("claude --model claude-fable-5");
		expect(command).toContain("You are ADE Orchestrator");
		expect(command).toContain("Primary specialist");
		expect(command).toContain("Smart Routing Plan");
		expect(command).toContain("Tiered Fallback");
		expect(command).toContain("token-cut");
		expect(command).toContain("Plan big, execute small");
		expect(command).toContain("Worker Brief Contract");
		expect(command).toContain("wait for every expected report");
	});
});
