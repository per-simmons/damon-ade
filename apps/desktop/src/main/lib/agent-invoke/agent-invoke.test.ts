import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
	buildAgentInvokeCommand,
	readPromptFileInstruction,
} from "shared/utils/agent-invoke-command";
import {
	type InvokeAgentEntry,
	MAX_INVOKE_PROMPT_LENGTH,
	PROMPT_FILE_MAX_AGE_MS,
	parseAgentInvokeRequest,
	shellKindFor,
	writeInvokePromptFile,
} from "./agent-invoke";

const SESSION = "3f2b8c1e-9a4d-4e7f-8b21-6c5d0e9f1a2b";

const AGENTS: Record<string, InvokeAgentEntry> = {
	cicero: {
		cwd: "/agents/cicero",
		workspaceId: "ws-1",
		sessionId: "s-1",
		model: "fable",
	},
	plain: { cwd: "/agents/plain", workspaceId: "ws-2", sessionId: "s-2" },
	broken: {
		cwd: "/agents/broken",
		workspaceId: "ws-3",
		sessionId: "s-3",
		model: "sonnet; rm -rf ~",
	},
	trusted: {
		cwd: "/agents/trusted",
		workspaceId: "ws-4",
		sessionId: "s-4",
		permissionMode: "bypassPermissions",
	},
	odd: {
		cwd: "/agents/odd",
		workspaceId: "ws-5",
		sessionId: "s-5",
		permissionMode: "yolo; rm -rf ~",
	},
};
const lookup = (name: string) => AGENTS[name];

describe("parseAgentInvokeRequest", () => {
	it("uses acceptEdits unless the registry entry chooses another permission mode", () => {
		const mode = (body: Record<string, unknown>) => {
			const result = parseAgentInvokeRequest(body, lookup);
			if (!result.ok) throw new Error(result.error);
			return result.request.permissionMode;
		};
		expect(mode({ agent: "plain", prompt: "x" })).toBe("acceptEdits");
		// Only an explicit registry choice gives the bypass.
		expect(mode({ agent: "trusted", prompt: "x" })).toBe("bypassPermissions");
		// An unknown value falls back to the safe default.
		expect(mode({ agent: "odd", prompt: "x" })).toBe("acceptEdits");
		// A request cannot raise its own permissions.
		expect(
			mode({
				agent: "plain",
				prompt: "x",
				permissionMode: "bypassPermissions",
			}),
		).toBe("acceptEdits");
	});

	it("accepts a minimal request and uses the registry model", () => {
		const result = parseAgentInvokeRequest(
			{ agent: "cicero", prompt: "Summarize today" },
			lookup,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.request.model).toBe("fable");
		expect(result.request.fresh).toBe(true);
		expect(result.request.entry.workspaceId).toBe("ws-1");
	});

	it("lets the request model override the registry model", () => {
		const result = parseAgentInvokeRequest(
			{ agent: "cicero", prompt: "x", model: "claude-haiku-5-5" },
			lookup,
		);
		expect(result.ok && result.request.model).toBe("claude-haiku-5-5");
	});

	it("leaves the model unset when neither request nor registry has one", () => {
		const result = parseAgentInvokeRequest(
			{ agent: "plain", prompt: "x" },
			lookup,
		);
		expect(result.ok && result.request.model).toBeUndefined();
	});

	it("ignores an unsafe registry model and reports it", () => {
		const result = parseAgentInvokeRequest(
			{ agent: "broken", prompt: "x" },
			lookup,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.request.model).toBeUndefined();
		expect(result.request.ignoredRegistryModel).toBe("sonnet; rm -rf ~");
	});

	it("accepts a UUID session id and fresh=false", () => {
		const result = parseAgentInvokeRequest(
			{ agent: "plain", prompt: "x", claudeSessionId: SESSION, fresh: false },
			lookup,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.request.claudeSessionId).toBe(SESSION);
		expect(result.request.fresh).toBe(false);
	});

	const rejected: Array<[string, unknown, 400 | 404 | 413]> = [
		["a non-object body", "hello", 400],
		["an array body", [1, 2], 400],
		["a missing agent", { prompt: "x" }, 400],
		["a missing prompt", { agent: "plain" }, 400],
		["a blank prompt", { agent: "plain", prompt: "   " }, 400],
		["a non-string prompt", { agent: "plain", prompt: 42 }, 400],
		["a prompt with NUL", { agent: "plain", prompt: "a\0b" }, 400],
		[
			"an oversized prompt",
			{ agent: "plain", prompt: "x".repeat(MAX_INVOKE_PROMPT_LENGTH + 1) },
			413,
		],
		["a non-boolean fresh", { agent: "plain", prompt: "x", fresh: "no" }, 400],
		["a non-string model", { agent: "plain", prompt: "x", model: 5 }, 400],
		[
			"a model with shell syntax",
			{ agent: "plain", prompt: "x", model: "opus $(id)" },
			400,
		],
		[
			"a session id with shell syntax",
			{ agent: "plain", prompt: "x", claudeSessionId: "abc;reboot" },
			400,
		],
		["a non-string tab", { agent: "plain", prompt: "x", tab: {} }, 400],
		["an unknown agent", { agent: "nobody", prompt: "x" }, 404],
	];
	for (const [label, body, status] of rejected) {
		it(`rejects ${label} with ${status}`, () => {
			const result = parseAgentInvokeRequest(body, lookup);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.status).toBe(status);
			expect(result.error.length).toBeGreaterThan(0);
		});
	}
});

describe("shellKindFor", () => {
	it("maps shells to their syntax", () => {
		expect(shellKindFor("/bin/zsh")).toBe("posix");
		expect(shellKindFor("/usr/local/bin/bash")).toBe("posix");
		expect(shellKindFor("C:\\Windows\\System32\\cmd.exe")).toBe("cmd");
		expect(shellKindFor("powershell.exe")).toBe("powershell");
		expect(shellKindFor("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(
			"powershell",
		);
	});
});

describe("writeInvokePromptFile", () => {
	let dir: string;
	beforeAll(() => {
		dir = join(mkdtempSync(join(tmpdir(), "ade-invoke-")), "invoke-prompts");
	});
	afterAll(() => {
		rmSync(join(dir, ".."), { recursive: true, force: true });
	});

	it("writes the prompt exactly and returns a new path each time", () => {
		const prompt = 'line 1\nit\'s "quoted" $HOME `id`\n';
		const a = writeInvokePromptFile(dir, prompt);
		const b = writeInvokePromptFile(dir, prompt);
		expect(a).not.toBe(b);
		expect(readFileSync(a, "utf8")).toBe(prompt);
		if (process.platform !== "win32") {
			expect(statSync(a).mode & 0o777).toBe(0o600);
		}
	});

	it("deletes prompt files older than a day and keeps recent ones", () => {
		const old = join(dir, "old.txt");
		const recent = join(dir, "recent.txt");
		const other = join(dir, "notes.md");
		for (const path of [old, recent, other]) writeFileSync(path, "x", "utf8");
		const now = Date.now();
		const past = new Date(now - PROMPT_FILE_MAX_AGE_MS - 60_000);
		utimesSync(old, past, past);
		utimesSync(other, past, past);

		writeInvokePromptFile(dir, "new", now);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(recent)).toBe(true);
		// Only .txt prompt files are pruned.
		expect(existsSync(other)).toBe(true);
	});
});

/**
 * End to end: request body -> validation -> prompt file -> command -> a real
 * shell -> a fake `claude` that records the arguments it received.
 */
function findShell(name: string): string | null {
	const path = Bun.which(name);
	// Skip the WSL launcher on Windows; it runs a different filesystem view.
	if (!path || /\\System32\\bash\.exe$/i.test(path)) return null;
	return path;
}

const bash = findShell("bash");
const powershell =
	process.platform === "win32" ? findShell("powershell") : null;

describe.if(bash !== null)("invoke command through a real bash", () => {
	let root: string;
	let binDir: string;
	let promptDir: string;
	let argvOut: string;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "ade-invoke-bash-"));
		binDir = join(root, "bin");
		promptDir = join(root, "invoke-prompts");
		argvOut = join(root, "argv.bin");
		mkdirSync(binDir, { recursive: true });
		writeFileSync(
			join(binDir, "claude"),
			'#!/usr/bin/env bash\n: > "$FAKE_CLAUDE_OUT"\nfor a in "$@"; do printf \'%s\\0\' "$a" >> "$FAKE_CLAUDE_OUT"; done\n',
			{ encoding: "utf8", mode: 0o755 },
		);
	});
	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function invoke(body: Record<string, unknown>): string[] {
		const parsed = parseAgentInvokeRequest(body, lookup);
		if (!parsed.ok) throw new Error(parsed.error);
		const promptFile = writeInvokePromptFile(promptDir, parsed.request.prompt);
		const command = buildAgentInvokeCommand({
			promptFile,
			shell: "posix",
			model: parsed.request.model,
			claudeSessionId: parsed.request.claudeSessionId,
			fresh: parsed.request.fresh,
			permissionMode: parsed.request.permissionMode,
		});
		if (existsSync(argvOut)) rmSync(argvOut);
		const result = spawnSync(bash as string, ["-c", command], {
			env: {
				...process.env,
				PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
				FAKE_CLAUDE_OUT: argvOut,
			},
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		const raw = readFileSync(argvOut, "utf8");
		return raw.split("\0").slice(0, -1);
	}

	const hostilePrompts: Array<[string, string]> = [
		["apostrophes", "it's Pat's 'task'"],
		["double quotes", 'say "hello" and "bye"'],
		[
			"command substitution",
			"$(touch /tmp/ade-pwned) and `touch /tmp/ade-pwned`",
		],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${...} is the test input.
		["variables", "$HOME ${PATH} $1 $@"],
		["separators", "a; b && c || d | e > f < g & h"],
		["globs and history", "* ? [a-z] !! !$ ~"],
		["newlines and tabs", "first line\n\tindented\nlast line"],
		["control characters", "stop\u0003here\u001b[31mred\u0015"],
		["backslashes", "C:\\path\\to\\file \\n \\'"],
		["unicode", "naïve café — 日本語 🚀"],
	];
	for (const [label, prompt] of hostilePrompts) {
		it(`passes a prompt with ${label} through unchanged as one argument`, () => {
			const argv = invoke({ agent: "plain", prompt });
			expect(argv).toEqual(["--permission-mode", "acceptEdits", prompt]);
		});
	}

	it("runs nothing from the prompt", () => {
		const marker = join(root, "pwned");
		const posixMarker = marker.replace(/\\/g, "/");
		invoke({
			agent: "plain",
			prompt: `$(touch '${posixMarker}') \`touch '${posixMarker}'\`; touch '${posixMarker}'`,
		});
		expect(existsSync(marker)).toBe(false);
	});

	it("drops trailing newlines, as command substitution does", () => {
		expect(invoke({ agent: "plain", prompt: "done\n\n" })).toEqual([
			"--permission-mode",
			"acceptEdits",
			"done",
		]);
	});

	it("passes the registry model, then the request model, to claude", () => {
		expect(invoke({ agent: "cicero", prompt: "x" })).toEqual([
			"--model",
			"fable",
			"--permission-mode",
			"acceptEdits",
			"x",
		]);
		expect(
			invoke({ agent: "cicero", prompt: "x", model: "claude-sonnet-5-5" }),
		).toEqual([
			"--model",
			"claude-sonnet-5-5",
			"--permission-mode",
			"acceptEdits",
			"x",
		]);
	});

	it("pins a fresh session and resumes an existing one", () => {
		expect(
			invoke({ agent: "plain", prompt: "x", claudeSessionId: SESSION }),
		).toEqual([
			"--session-id",
			SESSION,
			"--permission-mode",
			"acceptEdits",
			"x",
		]);
		expect(
			invoke({
				agent: "plain",
				prompt: "x",
				claudeSessionId: SESSION,
				fresh: false,
			}),
		).toEqual(["--resume", SESSION, "--permission-mode", "acceptEdits", "x"]);
	});

	it("passes the bypass only for an agent whose registry entry chooses it", () => {
		expect(invoke({ agent: "trusted", prompt: "x" })).toEqual([
			"--permission-mode",
			"bypassPermissions",
			"x",
		]);
	});

	it("never reaches the shell for a malformed request", () => {
		expect(() =>
			invoke({ agent: "plain", prompt: "x", model: "opus; touch /tmp/x" }),
		).toThrow("model may contain only");
	});

	it("leaves only prompt files in the prompt directory", () => {
		expect(readdirSync(promptDir).every((name) => name.endsWith(".txt"))).toBe(
			true,
		);
	});
});

describe.if(powershell !== null)(
	"invoke command through Windows PowerShell",
	() => {
		it("passes the flags and the read-the-file instruction as separate arguments", () => {
			const root = mkdtempSync(join(tmpdir(), "ade-invoke-ps-"));
			try {
				// An apostrophe in the directory exercises PowerShell quote escaping.
				const promptDir = join(root, "o'neil", "invoke-prompts");
				const promptFile = writeInvokePromptFile(promptDir, 'it\'s a "test"');
				const command = buildAgentInvokeCommand({
					promptFile,
					shell: "powershell",
					model: "fable",
					claudeSessionId: SESSION,
					fresh: false,
				});
				const script = `function claude { [Console]::Out.Write(($args -join [char]0)) }\n${command}`;
				const result = spawnSync(
					powershell as string,
					["-NoProfile", "-NonInteractive", "-Command", script],
					{ encoding: "utf8" },
				);
				expect(result.status).toBe(0);
				expect(result.stdout.split("\0")).toEqual([
					"--resume",
					SESSION,
					"--model",
					"fable",
					"--permission-mode",
					"acceptEdits",
					readPromptFileInstruction(promptFile),
				]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	},
);
