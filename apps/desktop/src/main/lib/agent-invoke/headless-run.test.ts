import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InvokeAgentEntry, parseAgentInvokeRequest } from "./agent-invoke";
import { type HeadlessFinished, startHeadlessInvoke } from "./headless-invoke";
import {
	buildHeadlessArgs,
	MAX_HEADLESS_PROMPT_LENGTH,
	parseHeadlessOutput,
	resolveClaudeExecutable,
	runHeadlessClaude,
} from "./headless-run";

const SESSION = "3f2b8c1e-9a4d-4e7f-8b21-6c5d0e9f1a2b";

let root: string;
let fakeClaude: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "ade-headless-"));
	// A stand-in for `claude -p`: records its arguments, then behaves as
	// FAKE_MODE says.
	fakeClaude = join(root, "fake-claude.js");
	writeFileSync(
		fakeClaude,
		`const { writeFileSync } = require("node:fs");
writeFileSync(process.env.FAKE_ARGS, JSON.stringify(process.argv.slice(2)));
const mode = process.env.FAKE_MODE ?? "ok";
if (mode === "hang") { setInterval(() => {}, 1000); }
else if (mode === "garbage") { process.stdout.write("not json"); }
else if (mode === "fail") { process.stderr.write("boom"); process.exit(3); }
else {
  process.stdout.write("warming up\\n" + JSON.stringify({
    type: "result", subtype: "success", is_error: false, num_turns: 4,
    duration_ms: 1200, total_cost_usd: 0.4321, session_id: "sess-h",
  }) + "\\n");
}
`,
		"utf8",
	);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function run(
	prompt: string,
	mode = "ok",
	extra: Partial<Parameters<typeof runHeadlessClaude>[0]> = {},
) {
	const argsFile = join(
		root,
		`args-${Math.random().toString(36).slice(2)}.json`,
	);
	return runHeadlessClaude({
		command: [process.execPath, fakeClaude],
		cwd: root,
		prompt,
		maxBudgetUsd: 2.5,
		maxTurns: 30,
		fresh: true,
		env: { ...process.env, FAKE_ARGS: argsFile, FAKE_MODE: mode },
		...extra,
	}).then((result) => ({
		result,
		args: (() => {
			try {
				return JSON.parse(readFileSync(argsFile, "utf8")) as string[];
			} catch {
				return undefined;
			}
		})(),
	}));
}

describe("buildHeadlessArgs", () => {
	it("caps spending and turns and passes model and session", () => {
		expect(
			buildHeadlessArgs({
				prompt: "go",
				maxBudgetUsd: 2.5,
				maxTurns: 30,
				model: "sonnet",
				claudeSessionId: SESSION,
				fresh: false,
			}),
		).toEqual([
			"-p",
			"--output-format",
			"json",
			"--max-budget-usd",
			"2.5",
			"--max-turns",
			"30",
			"--dangerously-skip-permissions",
			"--model",
			"sonnet",
			"--resume",
			SESSION,
			"go",
		]);
	});

	it("keeps a prompt that starts with a dash from being read as an option", () => {
		const args = buildHeadlessArgs({
			prompt: "--help me",
			maxBudgetUsd: 1,
			maxTurns: 1,
			fresh: true,
		});
		expect(args[args.length - 1]).toBe(" --help me");
	});
});

describe("parseHeadlessOutput", () => {
	it("reads the result object from the last line", () => {
		expect(
			parseHeadlessOutput(
				'noise\n{"session_id":"s","total_cost_usd":1.5,"num_turns":3,"is_error":true,"subtype":"error_max_budget_usd"}',
			),
		).toEqual({
			sessionId: "s",
			totalCostUsd: 1.5,
			numTurns: 3,
			isError: true,
			subtype: "error_max_budget_usd",
			durationMs: undefined,
		});
		expect(parseHeadlessOutput("  ")).toBeUndefined();
		expect(() => parseHeadlessOutput("not json")).toThrow();
	});
});

describe("runHeadlessClaude with a real child process", () => {
	const prompts: Array<[string, string]> = [
		["quotes", `it's "quoted" and 'single'`],
		[
			"shell syntax",
			"$(touch pwned) `id` ; rm -rf ~ | cat && echo $HOME %PATH%",
		],
		["newlines", "line 1\nline 2\r\n\ttabbed"],
		["unicode", "naïve café 日本語 🚀"],
		["backslashes", 'C:\\Users\\Pat\\ "\\"'],
	];
	for (const [label, prompt] of prompts) {
		it(`passes a prompt with ${label} as one exact argument`, async () => {
			const { result, args } = await run(prompt);
			expect(result.exitCode).toBe(0);
			expect(args?.[args.length - 1]).toBe(prompt);
			expect(args).toContain("--max-budget-usd");
		});
	}

	it("reads Claude Code's reported cost and session", async () => {
		const { result } = await run("x");
		expect(result.report).toEqual({
			sessionId: "sess-h",
			totalCostUsd: 0.4321,
			numTurns: 4,
			isError: false,
			subtype: "success",
			durationMs: 1200,
		});
		expect(result.timedOut).toBe(false);
	});

	it("reports a failing run with its stderr", async () => {
		const { result } = await run("x", "fail");
		expect(result.exitCode).toBe(3);
		expect(result.stderrTail).toContain("boom");
		expect(result.report).toBeUndefined();
	});

	it("reports output that is not JSON", async () => {
		const { result } = await run("x", "garbage");
		expect(result.parseError).toContain("not JSON");
	});

	it("kills a run that exceeds its timeout", async () => {
		const { result } = await run("x", "hang", { timeoutMs: 500 });
		expect(result.timedOut).toBe(true);
	});

	it("reports a missing executable instead of throwing", async () => {
		const result = await runHeadlessClaude({
			command: [join(root, "no-such-claude")],
			cwd: root,
			prompt: "x",
			maxBudgetUsd: 1,
			maxTurns: 1,
			fresh: true,
		});
		expect(result.exitCode).toBeNull();
		expect(result.stderrTail.length).toBeGreaterThan(0);
	});
});

describe("headless /agent/invoke requests", () => {
	const entry: InvokeAgentEntry = {
		cwd: "/agents/cicero",
		workspaceId: "ws",
		sessionId: "s",
		model: "sonnet",
	};
	const parse = (body: Record<string, unknown>) => {
		const parsed = parseAgentInvokeRequest(body, () => entry);
		if (!parsed.ok) throw new Error(parsed.error);
		return parsed.request;
	};
	const limits = () => ({ headlessMaxBudgetUsd: 5, headlessMaxTurns: 40 });

	it("validates mode, budget and prompt length", () => {
		const status = (body: Record<string, unknown>) => {
			const parsed = parseAgentInvokeRequest(body, () => entry);
			return parsed.ok ? 200 : parsed.status;
		};
		expect(status({ agent: "a", prompt: "x", mode: "batch" })).toBe(400);
		expect(status({ agent: "a", prompt: "x", maxBudgetUsd: -1 })).toBe(400);
		expect(status({ agent: "a", prompt: "x", maxBudgetUsd: "5" })).toBe(400);
		expect(
			status({
				agent: "a",
				prompt: "x".repeat(MAX_HEADLESS_PROMPT_LENGTH + 1),
				mode: "headless",
			}),
		).toBe(413);
		// The same prompt is fine for a terminal run.
		expect(
			status({
				agent: "a",
				prompt: "x".repeat(MAX_HEADLESS_PROMPT_LENGTH + 1),
			}),
		).toBe(200);
		expect(parse({ agent: "a", prompt: "x" }).mode).toBe("terminal");
	});

	it("never lets a request raise the settings' spending cap", async () => {
		const seen: number[] = [];
		const deps = {
			limits,
			findExecutable: () => "/bin/claude",
			run: async (params: { maxBudgetUsd: number }) => {
				seen.push(params.maxBudgetUsd);
				return { exitCode: 0, timedOut: false, durationMs: 1, stderrTail: "" };
			},
			onFinished: () => {},
		};
		for (const maxBudgetUsd of [20, 2]) {
			const started = startHeadlessInvoke(
				parse({ agent: "a", prompt: "x", mode: "headless", maxBudgetUsd }),
				deps,
			);
			expect(started.status).toBe(202);
			if (started.status === 202) await started.done;
		}
		expect(seen).toEqual([5, 2]);
	});

	it("allows one run per agent at a time and reports when it finishes", async () => {
		let release: () => void = () => {};
		const finished: HeadlessFinished[] = [];
		const deps = {
			limits,
			findExecutable: () => "/bin/claude",
			run: () =>
				new Promise<{
					exitCode: number;
					timedOut: boolean;
					durationMs: number;
					stderrTail: string;
				}>((resolve) => {
					release = () =>
						resolve({
							exitCode: 0,
							timedOut: false,
							durationMs: 5,
							stderrTail: "",
						});
				}),
			onFinished: (f: HeadlessFinished) => finished.push(f),
		};
		const request = parse({ agent: "busy", prompt: "x", mode: "headless" });
		const first = startHeadlessInvoke(request, deps);
		const second = startHeadlessInvoke(request, deps);
		expect(first.status).toBe(202);
		expect(second.status).toBe(409);

		release();
		if (first.status === 202) await first.done;
		expect(finished).toHaveLength(1);
		expect(finished[0]).toMatchObject({
			agent: "busy",
			cwd: "/agents/cicero",
			model: "sonnet",
			maxBudgetUsd: 5,
			maxTurns: 40,
		});
		// Free again once the first run is done.
		const third = startHeadlessInvoke(request, {
			...deps,
			run: async () => ({
				exitCode: 0,
				timedOut: false,
				durationMs: 1,
				stderrTail: "",
			}),
		});
		expect(third.status).toBe(202);
		if (third.status === 202) await third.done;
	});

	it("answers 503 when Claude Code is not installed", () => {
		const started = startHeadlessInvoke(
			parse({ agent: "a", prompt: "x", mode: "headless" }),
			{
				limits,
				findExecutable: () => null,
				run: async () => {
					throw new Error("should not run");
				},
				onFinished: () => {},
			},
		);
		expect(started.status).toBe(503);
	});

	it("still reports and frees the agent when the runner throws", async () => {
		const finished: HeadlessFinished[] = [];
		const deps = {
			limits,
			findExecutable: () => "/bin/claude",
			run: async (): Promise<never> => {
				throw new Error("spawn exploded");
			},
			onFinished: (f: HeadlessFinished) => finished.push(f),
		};
		const request = parse({ agent: "boom", prompt: "x", mode: "headless" });
		const started = startHeadlessInvoke(request, deps);
		if (started.status === 202) await started.done;
		expect(finished[0].result.stderrTail).toContain("spawn exploded");
		expect(startHeadlessInvoke(request, deps).status).toBe(202);
	});
});

describe("resolveClaudeExecutable", () => {
	afterEach(() => {
		delete process.env.ADE_CLAUDE_BINARY;
	});

	it("uses ADE_CLAUDE_BINARY when it exists", () => {
		process.env.ADE_CLAUDE_BINARY = fakeClaude;
		expect(resolveClaudeExecutable(null)).toBe(fakeClaude);
		process.env.ADE_CLAUDE_BINARY = join(root, "missing");
		expect(resolveClaudeExecutable("/usr/bin/claude")).toBeNull();
	});

	it.if(process.platform === "win32")(
		"maps the npm shim on Windows to the packaged claude.exe",
		() => {
			const npmDir = join(root, "npm");
			const exe = join(
				npmDir,
				"node_modules",
				"@anthropic-ai",
				"claude-code",
				"bin",
			);
			mkdirSync(exe, { recursive: true });
			writeFileSync(join(exe, "claude.exe"), "", "utf8");
			writeFileSync(join(npmDir, "claude.cmd"), "", "utf8");
			expect(resolveClaudeExecutable(join(npmDir, "claude.cmd"))).toBe(
				join(exe, "claude.exe"),
			);
			expect(
				resolveClaudeExecutable(join(root, "elsewhere", "claude.cmd")),
			).toBeNull();
		},
	);

	it.if(process.platform !== "win32")(
		"uses the found path on macOS and Linux",
		() => {
			expect(resolveClaudeExecutable("/usr/local/bin/claude")).toBe(
				"/usr/local/bin/claude",
			);
		},
	);
});
