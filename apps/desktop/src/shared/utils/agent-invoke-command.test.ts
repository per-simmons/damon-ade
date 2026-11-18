import { describe, expect, it } from "bun:test";
import {
	buildAgentInvokeCommand,
	isSafeCliToken,
	posixQuote,
	readPromptFileInstruction,
} from "./agent-invoke-command";

const SESSION = "3f2b8c1e-9a4d-4e7f-8b21-6c5d0e9f1a2b";
const FILE = "/home/pat/.ade/invoke-prompts/1.txt";

describe("buildAgentInvokeCommand (posix)", () => {
	it("reads the prompt from the file and adds no flags by default", () => {
		expect(
			buildAgentInvokeCommand({
				promptFile: FILE,
				shell: "posix",
				fresh: true,
			}),
		).toBe(`claude --dangerously-skip-permissions "$(cat -- '${FILE}')"`);
	});

	it("adds session and model flags as bare tokens", () => {
		expect(
			buildAgentInvokeCommand({
				promptFile: FILE,
				shell: "posix",
				fresh: false,
				claudeSessionId: SESSION,
				model: "claude-sonnet-5-5",
			}),
		).toBe(
			`claude --resume ${SESSION} --model claude-sonnet-5-5 --dangerously-skip-permissions "$(cat -- '${FILE}')"`,
		);
		expect(
			buildAgentInvokeCommand({
				promptFile: FILE,
				shell: "posix",
				fresh: true,
				claudeSessionId: SESSION,
			}),
		).toContain(`--session-id ${SESSION} `);
		expect(
			buildAgentInvokeCommand({
				promptFile: FILE,
				shell: "posix",
				fresh: false,
			}),
		).toContain("claude --continue ");
	});

	it("drops a model or session id that is not a plain token", () => {
		const command = buildAgentInvokeCommand({
			promptFile: FILE,
			shell: "posix",
			fresh: true,
			model: "sonnet; rm -rf ~",
			claudeSessionId: "$(whoami)",
		});
		expect(command).toBe(
			`claude --dangerously-skip-permissions "$(cat -- '${FILE}')"`,
		);
	});

	it("quotes a prompt file path containing an apostrophe", () => {
		const path = "/home/o'neil/.ade/invoke-prompts/1.txt";
		expect(
			buildAgentInvokeCommand({
				promptFile: path,
				shell: "posix",
				fresh: true,
			}),
		).toContain(`cat -- ${posixQuote(path)}`);
		expect(posixQuote(path)).toBe(
			`'/home/o'\\''neil/.ade/invoke-prompts/1.txt'`,
		);
	});

	it("rejects a prompt file path with a line break", () => {
		expect(() =>
			buildAgentInvokeCommand({
				promptFile: "/tmp/a\nb.txt",
				shell: "posix",
				fresh: true,
			}),
		).toThrow();
	});
});

describe("buildAgentInvokeCommand (Windows shells)", () => {
	const winFile = "C:\\Users\\Pat\\.ade\\invoke-prompts\\1.txt";

	it("passes a fixed instruction to read the file in PowerShell", () => {
		expect(
			buildAgentInvokeCommand({
				promptFile: winFile,
				shell: "powershell",
				fresh: true,
				model: "fable",
			}),
		).toBe(
			`claude --model fable --dangerously-skip-permissions '${readPromptFileInstruction(winFile)}'`,
		);
	});

	it("doubles an apostrophe in the path for PowerShell", () => {
		const path = "C:\\Users\\O'Neil\\p.txt";
		expect(
			buildAgentInvokeCommand({
				promptFile: path,
				shell: "powershell",
				fresh: true,
			}),
		).toContain("O''Neil");
	});

	it("uses double quotes for cmd and rejects paths cmd would expand", () => {
		expect(
			buildAgentInvokeCommand({
				promptFile: winFile,
				shell: "cmd",
				fresh: true,
			}),
		).toBe(
			`claude --dangerously-skip-permissions "${readPromptFileInstruction(winFile)}"`,
		);
		for (const bad of ['C:\\a"b.txt', "C:\\%TEMP%\\p.txt", "C:\\a!b.txt"]) {
			expect(() =>
				buildAgentInvokeCommand({ promptFile: bad, shell: "cmd", fresh: true }),
			).toThrow();
		}
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
