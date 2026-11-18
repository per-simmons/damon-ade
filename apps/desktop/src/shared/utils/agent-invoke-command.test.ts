import { describe, expect, it } from "bun:test";
import {
	buildAgentInvokeCommand,
	isSafeCliToken,
} from "./agent-invoke-command";

const SESSION = "3f2b8c1e-9a4d-4e7f-8b21-6c5d0e9f1a2b";

describe("buildAgentInvokeCommand", () => {
	it("is unchanged when no model is given", () => {
		expect(buildAgentInvokeCommand({ prompt: "hi", fresh: true })).toBe(
			"claude --dangerously-skip-permissions 'hi'",
		);
		expect(
			buildAgentInvokeCommand({
				prompt: "hi",
				fresh: false,
				claudeSessionId: SESSION,
			}),
		).toBe(`claude --resume ${SESSION} --dangerously-skip-permissions 'hi'`);
	});

	it("adds --model for an alias or a full model ID", () => {
		expect(
			buildAgentInvokeCommand({ prompt: "hi", fresh: true, model: "fable" }),
		).toBe("claude --model fable --dangerously-skip-permissions 'hi'");
		expect(
			buildAgentInvokeCommand({
				prompt: "hi",
				fresh: true,
				claudeSessionId: SESSION,
				model: " claude-sonnet-5-5 ",
			}),
		).toBe(
			`claude --session-id ${SESSION} --model claude-sonnet-5-5 --dangerously-skip-permissions 'hi'`,
		);
	});

	it("uses --continue when resuming without a session id", () => {
		expect(
			buildAgentInvokeCommand({ prompt: "hi", fresh: false, model: "opus" }),
		).toBe(
			"claude --continue --model opus --dangerously-skip-permissions 'hi'",
		);
	});

	it("drops a model or session id that is not a plain token", () => {
		const command = buildAgentInvokeCommand({
			prompt: "hi",
			fresh: false,
			model: "sonnet; rm -rf ~",
			claudeSessionId: "$(whoami)",
		});
		expect(command).toBe(
			"claude --continue --dangerously-skip-permissions 'hi'",
		);
	});

	it("drops an empty model", () => {
		expect(
			buildAgentInvokeCommand({ prompt: "hi", fresh: true, model: "  " }),
		).toBe("claude --dangerously-skip-permissions 'hi'");
	});

	it("single-quotes the prompt, escaping embedded quotes", () => {
		expect(buildAgentInvokeCommand({ prompt: "it's $HOME", fresh: true })).toBe(
			"claude --dangerously-skip-permissions 'it'\\''s $HOME'",
		);
	});
});

describe("isSafeCliToken", () => {
	it("accepts model aliases, model IDs and UUIDs", () => {
		for (const value of ["fable", "claude-haiku-5-5", "opus[1m]", SESSION]) {
			expect(isSafeCliToken(value)).toBe(true);
		}
	});

	it("rejects spaces and shell syntax", () => {
		for (const value of ["", "a b", "a;b", "$(x)", "`x`", "a|b", "a'b"]) {
			expect(isSafeCliToken(value)).toBe(false);
		}
	});
});
