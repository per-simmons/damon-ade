import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { costOf, summarizeArms, summarizeRuns } from "./aggregate";
import { estimateCost } from "./pricing";
import {
	decodeHookString,
	isRecordableTranscript,
	onSessionRecorded,
	scheduleSessionRecording,
} from "./recorder";
import {
	appendRunResult,
	loadRunResults,
	loadSessions,
	readTaskProgress,
	recordSessionUsage,
	type SessionMetrics,
} from "./store";
import { parseTranscript } from "./transcript";

/** Builders for transcript lines in Claude Code's JSONL format. */
const at = (seconds: number) =>
	new Date(Date.UTC(2026, 10, 17, 12, 0, seconds)).toISOString();

function prompt(text: string, seconds: number, cwd: string) {
	return {
		type: "user",
		sessionId: "sess-1",
		cwd,
		version: "2.1.300",
		timestamp: at(seconds),
		message: { role: "user", content: text },
	};
}

function toolResult(seconds: number) {
	return {
		type: "user",
		timestamp: at(seconds),
		toolUseResult: { ok: true },
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }],
		},
	};
}

function assistant(
	id: string,
	model: string,
	seconds: number,
	usage: Record<string, unknown>,
	content: unknown[] = [{ type: "text", text: "ok" }],
	extra: Record<string, unknown> = {},
) {
	return {
		type: "assistant",
		timestamp: at(seconds),
		...extra,
		message: { id, model, role: "assistant", content, usage },
	};
}

const usage = (
	input: number,
	output: number,
	cacheRead = 0,
	write5m = 0,
	write1h = 0,
) => ({
	input_tokens: input,
	output_tokens: output,
	cache_read_input_tokens: cacheRead,
	cache_creation_input_tokens: write5m + write1h,
	cache_creation: {
		ephemeral_5m_input_tokens: write5m,
		ephemeral_1h_input_tokens: write1h,
	},
	service_tier: "standard",
	speed: "standard",
	inference_geo: "global",
});

function writeJsonl(path: string, lines: unknown[], trailer = ""): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(
		path,
		`${lines.map((line) => JSON.stringify(line)).join("\n")}\n${trailer}`,
		"utf8",
	);
}

let root: string;
let projectDir: string;
let cwd: string;
let transcript: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "ade-usage-"));
	projectDir = join(root, "projects", "proj");
	cwd = join(root, "repo");
	mkdirSync(join(cwd, ".ade", "tasks", "add-login", "escalations"), {
		recursive: true,
	});
	writeFileSync(
		join(cwd, ".ade", "tasks", "add-login", "progress.md"),
		"# Progress: add-login\nStatus: done\nCurrent step: 3\n\n## Steps\n- [x] 1. a (attempts: 1, escalations: 0)\n- [x] 2. b (attempts: 0, escalations: 1)\n- [x] 3. c (attempts: 2, escalations: 0)\n",
		"utf8",
	);
	writeFileSync(
		join(cwd, ".ade", "tasks", "add-login", "escalations", "001.md"),
		"report",
		"utf8",
	);

	transcript = join(projectDir, "sess-1.jsonl");
	writeJsonl(
		transcript,
		[
			prompt("/build add-login", 0, cwd),
			// One response written as two lines; the first has partial output.
			assistant("m1", "claude-sonnet-5-5", 2, usage(10, 5, 1000, 500), [
				{ type: "thinking", thinking: "" },
			]),
			assistant("m1", "claude-sonnet-5-5", 3, usage(10, 120, 1000, 500), [
				{
					type: "tool_use",
					name: "Agent",
					input: {
						subagent_type: "implementer",
						prompt: "Do step 1 of .ade/tasks/add-login/plan.md",
					},
				},
			]),
			toolResult(20),
			assistant("m2", "claude-sonnet-5-5", 25, usage(5, 40, 2000), [
				{
					type: "tool_use",
					name: "Agent",
					input: { subagent_type: "architect", prompt: "escalations/001.md" },
				},
			]),
			toolResult(40),
			// Locally generated error message: no usage counted, but an API error.
			assistant(
				"syn",
				"<synthetic>",
				41,
				usage(0, 0),
				[{ type: "text", text: "API Error" }],
				{ isApiErrorMessage: true },
			),
			prompt("/review add-login", 100, cwd),
			assistant("m3", "claude-sonnet-5-5", 110, usage(5, 60, 3000)),
		],
		'{"type":"assistant","message":{"id":"partial', // mid-write line
	);

	const subagents = join(projectDir, "sess-1", "subagents");
	writeJsonl(join(subagents, "agent-impl.jsonl"), [
		assistant("s1", "claude-sonnet-5-5", 5, usage(100, 300, 5000)),
		assistant("s2", "claude-sonnet-5-5", 15, usage(50, 200, 6000)),
	]);
	writeFileSync(
		join(subagents, "agent-impl.meta.json"),
		JSON.stringify({ agentType: "implementer" }),
		"utf8",
	);
	writeJsonl(join(subagents, "agent-arch.jsonl"), [
		assistant("s3", "claude-fable-5-2", 30, usage(200, 400, 0, 0, 8000)),
	]);
	writeFileSync(
		join(subagents, "agent-arch.meta.json"),
		JSON.stringify({ agentType: "architect" }),
		"utf8",
	);
	// No meta file: still counted, under "subagent".
	writeJsonl(join(subagents, "agent-x.jsonl"), [
		assistant("s4", "claude-haiku-5-5", 33, usage(10, 10)),
	]);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("parseTranscript", () => {
	it("reads the real model and usage of every response, once", () => {
		const parsed = parseTranscript(transcript);
		const byId = Object.fromEntries(parsed.records.map((r) => [r.id, r]));
		expect(Object.keys(byId).sort()).toEqual([
			"m1",
			"m2",
			"m3",
			"s1",
			"s2",
			"s3",
			"s4",
		]);
		// The last line of a split response wins (final output count).
		expect(byId.m1.output).toBe(120);
		expect(byId.m1.cacheWrite5m).toBe(500);
		expect(byId.s3.cacheWrite1h).toBe(8000);
	});

	it("attributes subagent responses to their type and real model", () => {
		const parsed = parseTranscript(transcript);
		const agents = Object.fromEntries(
			parsed.records.map((r) => [r.id, `${r.agentType}:${r.model}`]),
		);
		expect(agents.m1).toBe("main:claude-sonnet-5-5");
		expect(agents.s1).toBe("implementer:claude-sonnet-5-5");
		expect(agents.s3).toBe("architect:claude-fable-5-2");
		expect(agents.s4).toBe("subagent:claude-haiku-5-5");
	});

	it("measures turns, prompts, subagent calls, errors and task slugs", () => {
		const parsed = parseTranscript(transcript);
		expect(parsed.sessionId).toBe("sess-1");
		expect(parsed.cwd).toBe(cwd);
		expect(parsed.claudeVersion).toBe("2.1.300");
		expect(parsed.humanPrompts).toBe(2);
		// Turn 1: 0s -> 41s (last assistant line), turn 2: 100s -> 110s.
		expect(parsed.activeMs).toBe(51_000);
		expect(parsed.subagentCalls).toEqual({ implementer: 1, architect: 1 });
		expect(parsed.apiErrors).toBe(1);
		expect(parsed.taskSlugs).toEqual(["add-login"]);
		expect(parsed.firstAt).toBe(at(0));
		expect(parsed.lastAt).toBe(at(110));
	});
});

describe("estimateCost", () => {
	it("prices every token category", () => {
		const cost = estimateCost("claude-sonnet-5-5", {
			input: 1_000,
			output: 1_000,
			cacheRead: 1_000_000,
			cacheWrite5m: 1_000_000,
			cacheWrite1h: 1_000_000,
		});
		// 0.002 + 0.01 + 0.1 + 2.5 + 4
		expect(cost.usd).toBeCloseTo(6.612, 10);
	});

	it("uses Haiku 5.5's higher prices above a 100,000-token prompt", () => {
		const small = estimateCost("claude-haiku-5-5", {
			input: 100_000,
			output: 0,
			cacheRead: 0,
			cacheWrite5m: 0,
			cacheWrite1h: 0,
		});
		const large = estimateCost("claude-haiku-5-5", {
			input: 100_001,
			output: 0,
			cacheRead: 0,
			cacheWrite5m: 0,
			cacheWrite1h: 0,
		});
		expect(small.usd).toBeCloseTo(0.01, 10);
		expect(large.usd).toBeCloseTo(0.0500005, 10);
	});

	it("applies the US inference multiplier", () => {
		const cost = estimateCost("claude-fable-5-2", {
			input: 1_000_000,
			output: 0,
			cacheRead: 0,
			cacheWrite5m: 0,
			cacheWrite1h: 0,
			geo: "us",
		});
		expect(cost.usd).toBeCloseTo(8.8, 10);
	});

	it("reports unknown models and fast mode as unpriced instead of guessing", () => {
		const base = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite5m: 0,
			cacheWrite1h: 0,
		};
		expect(estimateCost("claude-new-9", base).usd).toBeNull();
		expect(
			estimateCost("claude-opus-5-5", { ...base, speed: "fast" }).usd,
		).toBeNull();
	});
});

describe("recordSessionUsage", () => {
	let metricsDir: string;
	beforeAll(() => {
		metricsDir = join(root, "metrics-store");
	});

	it("stores a summary with the run label and task progress", () => {
		writeFileSync(join(cwd, ".ade", "run-label"), "T1/B\n", "utf8");
		const metrics = recordSessionUsage({
			transcriptPath: transcript,
			metricsDir,
			workspaceId: "ws-1",
		});
		expect(metrics?.label).toBe("T1/B");
		expect(metrics?.workspaceId).toBe("ws-1");
		expect(metrics?.tasks["add-login"]).toEqual({
			status: "done",
			attempts: 3,
			escalations: 1,
			escalationReports: 1,
		});
		expect(loadSessions(metricsDir)).toHaveLength(1);
	});

	it("keeps the first label and rebuilds the same totals when re-recorded", () => {
		writeFileSync(join(cwd, ".ade", "run-label"), "T2/A\n", "utf8");
		const first = loadSessions(metricsDir)[0];
		const again = recordSessionUsage({
			transcriptPath: transcript,
			metricsDir,
		});
		expect(again?.label).toBe("T1/B");
		expect(again?.workspaceId).toBe("ws-1");
		expect(again?.records).toEqual(first.records);
		expect(loadSessions(metricsDir)).toHaveLength(1);
	});

	it("ignores an invalid run label", () => {
		const other = join(root, "repo-bad-label");
		mkdirSync(join(other, ".ade"), { recursive: true });
		writeFileSync(join(other, ".ade", "run-label"), "../../etc", "utf8");
		const path = join(projectDir, "sess-bad.jsonl");
		writeJsonl(path, [
			prompt("hi", 0, other),
			assistant("bad-1", "claude-sonnet-5-5", 1, usage(1, 1)),
		]);
		const metrics = recordSessionUsage({
			transcriptPath: path,
			metricsDir: join(root, "metrics-bad"),
		});
		expect(metrics?.label).toBeUndefined();
	});

	it("reads the label and task progress from the project's ADE folder", () => {
		const projects = join(root, "ade-home", "workflow", "projects");
		const taskDir = join(projects, "shop-0123456789", "tasks", "add-cart");
		mkdirSync(join(taskDir, "escalations"), { recursive: true });
		writeFileSync(
			join(projects, "shop-0123456789", "run-label"),
			"T3/B\n",
			"utf8",
		);
		writeFileSync(
			join(taskDir, "progress.md"),
			"Status: in progress\n- [ ] 1. a (attempts: 2, escalations: 1)\n",
			"utf8",
		);
		const repo = join(root, "shop-repo");
		mkdirSync(repo, { recursive: true });
		const path = join(projectDir, "sess-ade.jsonl");
		writeJsonl(path, [
			prompt("Build the cart", 0, repo),
			assistant("ade-1", "claude-sonnet-5-5", 2, usage(1, 1), [
				{
					type: "tool_use",
					name: "Read",
					input: { file_path: `${taskDir.replace(/\\/g, "/")}/plan.md` },
				},
			]),
		]);
		const metrics = recordSessionUsage({
			transcriptPath: path,
			metricsDir: join(root, "metrics-ade"),
			projectKey: "shop-0123456789",
			workflowProjectsDir: projects,
		});
		expect(metrics?.projectKey).toBe("shop-0123456789");
		expect(metrics?.label).toBe("T3/B");
		expect(metrics?.taskSlugs).toEqual(["add-cart"]);
		expect(metrics?.tasks["add-cart"]).toEqual({
			status: "in progress",
			attempts: 2,
			escalations: 1,
			escalationReports: 0,
		});
		// The project folder itself holds no workflow files.
		expect(existsSync(join(repo, ".ade"))).toBe(false);
	});

	it("records nothing for a transcript with no responses yet", () => {
		const path = join(projectDir, "sess-empty.jsonl");
		writeJsonl(path, [prompt("hi", 0, cwd)]);
		expect(
			recordSessionUsage({
				transcriptPath: path,
				metricsDir: join(root, "m2"),
			}),
		).toBeUndefined();
	});

	it("reads task progress counters", () => {
		expect(readTaskProgress(cwd, "missing")).toBeUndefined();
	});
});

function session(
	id: string,
	label: string | undefined,
	firstAt: string,
	records: SessionMetrics["records"],
	extra: Partial<SessionMetrics> = {},
): SessionMetrics {
	return {
		schemaVersion: 1,
		sessionId: id,
		transcriptPath: `/t/${id}.jsonl`,
		label,
		recordedAt: firstAt,
		firstAt,
		lastAt: firstAt,
		activeMs: 1000,
		humanPrompts: 1,
		subagentCalls: {},
		apiErrors: 0,
		taskSlugs: [],
		tasks: {},
		records,
		...extra,
	};
}

const rec = (id: string, model: string, input: number, agentType = "main") => ({
	id,
	model,
	agentType,
	timestamp: "",
	input,
	output: 0,
	cacheRead: 0,
	cacheWrite5m: 0,
	cacheWrite1h: 0,
});

describe("aggregation", () => {
	it("counts a resumed session's repeated messages once", () => {
		const original = session("a", "T1/B", at(0), [
			rec("x1", "claude-sonnet-5-5", 1_000_000),
			rec("x2", "claude-sonnet-5-5", 1_000_000),
		]);
		// --resume or --fork-session copies x1 and x2 into a new session.
		const resumed = session("b", "T1/B", at(50), [
			rec("x1", "claude-sonnet-5-5", 1_000_000),
			rec("x2", "claude-sonnet-5-5", 1_000_000),
			rec("x3", "claude-sonnet-5-5", 1_000_000),
		]);
		const [run] = summarizeRuns([resumed, original], new Map());
		expect(run.cost.messages).toBe(3);
		expect(run.cost.usd).toBeCloseTo(6, 10);
		expect(run.sessionIds).toEqual(["a", "b"]);
	});

	it("breaks cost down by model and by role", () => {
		const cost = costOf([
			rec("1", "claude-fable-5-2", 1_000_000, "planner"),
			rec("2", "claude-sonnet-5-5", 1_000_000, "implementer"),
			rec("3", "claude-haiku-5-5", 10_000, "quick"),
		]);
		expect(cost.byAgent.planner.usd).toBeCloseTo(8, 10);
		expect(cost.byAgent.implementer.models).toEqual(["claude-sonnet-5-5"]);
		expect(cost.byModel["claude-haiku-5-5"].usd).toBeCloseTo(0.001, 10);
	});

	it("computes cost per success over all runs, failed ones included", () => {
		const sessions = [
			session("p", "T1/A", at(0), [rec("p1", "claude-opus-5-5", 1_000_000)]),
			session("q", "T2/A", at(10), [rec("q1", "claude-opus-5-5", 1_000_000)]),
			session(
				"r",
				"T1/B",
				at(20),
				[rec("r1", "claude-sonnet-5-5", 1_000_000)],
				{ subagentCalls: { architect: 1, reviewer: 2 } },
			),
		];
		const dir = join(root, "metrics-results");
		appendRunResult(dir, {
			label: "T1/A",
			outcome: "pass",
			at: at(0),
			source: "manual",
		});
		appendRunResult(dir, {
			label: "T2/A",
			outcome: "fail",
			at: at(1),
			source: "check",
		});
		appendRunResult(dir, {
			label: "T1/B",
			outcome: "fail",
			at: at(2),
			source: "manual",
		});
		// A later result for the same label replaces the earlier one.
		appendRunResult(dir, {
			label: "T1/B",
			outcome: "pass",
			at: at(3),
			source: "check",
		});

		const runs = summarizeRuns(sessions, loadRunResults(dir));
		const arms = Object.fromEntries(summarizeArms(runs).map((a) => [a.arm, a]));
		// Arm A: $4 + $4 spent, one success.
		expect(arms.A.costPerSuccess).toBeCloseTo(8, 10);
		expect(arms.A.successRate).toBe(0.5);
		expect(arms.B.costPerSuccess).toBeCloseTo(2, 10);
		expect(arms.B.escalations).toBe(1);
		// Second review round is a retry.
		expect(arms.B.retries).toBe(1);
	});

	it("has no cost per success when nothing passed", () => {
		const runs = summarizeRuns(
			[session("z", "T9/A2", at(0), [rec("z1", "claude-opus-5-5", 1)])],
			new Map(),
		);
		const [arm] = summarizeArms(runs);
		expect(arm.costPerSuccess).toBeNull();
		expect(arm.successRate).toBeNull();
	});

	it("rejects an invalid label for a result", () => {
		expect(() =>
			appendRunResult(join(root, "m-x"), {
				label: "no-slash",
				outcome: "pass",
				at: at(0),
				source: "manual",
			}),
		).toThrow();
	});
});

describe("recording from the hook", () => {
	it("decodes a JSON-escaped Windows path", () => {
		expect(decodeHookString("C:\\\\Users\\\\Pat\\\\.claude\\\\x.jsonl")).toBe(
			"C:\\Users\\Pat\\.claude\\x.jsonl",
		);
		expect(decodeHookString("/home/pat/x.jsonl")).toBe("/home/pat/x.jsonl");
		// Not valid JSON escapes: used as is.
		expect(decodeHookString("C:\\x")).toBe("C:\\x");
	});

	it("only records absolute paths to existing .jsonl files", () => {
		expect(isRecordableTranscript(transcript)).toBe(true);
		expect(isRecordableTranscript("relative/x.jsonl")).toBe(false);
		expect(isRecordableTranscript(join(cwd, ".ade", "run-label"))).toBe(false);
		expect(isRecordableTranscript(join(root, "missing.jsonl"))).toBe(false);
	});

	it("records once after Stop settles and notifies listeners", async () => {
		const metricsDir = join(root, "metrics-hook");
		const seen: string[] = [];
		const off = onSessionRecorded((metrics) => seen.push(metrics.sessionId));
		const raw = JSON.stringify(transcript).slice(1, -1);
		const path = decodeHookString(raw);
		scheduleSessionRecording({ transcriptPath: path, metricsDir });
		scheduleSessionRecording({ transcriptPath: path, metricsDir });
		await Bun.sleep(1_000);
		off();
		expect(seen).toEqual(["sess-1"]);
		expect(existsSync(join(metricsDir, "sessions", "sess-1.json"))).toBe(true);
	});
});

const bash = Bun.which("bash");
describe.if(bash !== null && !/System32/i.test(bash ?? ""))(
	"notify hook script",
	() => {
		it("forwards Claude's transcript_path to ADE", () => {
			const dir = mkdtempSync(join(tmpdir(), "ade-notify-"));
			try {
				const template = readFileSync(
					join(
						__dirname,
						"..",
						"agent-setup",
						"templates",
						"notify-hook.template.sh",
					),
					"utf8",
				);
				const script = join(dir, "notify.sh");
				writeFileSync(
					script,
					template
						.replaceAll("{{MARKER}}", "# test")
						.replaceAll("{{DEFAULT_PORT}}", "1"),
					"utf8",
				);
				// A fake curl that records its arguments, one per line.
				const bin = join(dir, "bin");
				mkdirSync(bin);
				const out = join(dir, "curl-args.txt");
				writeFileSync(
					join(bin, "curl"),
					`#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$CURL_OUT"\n`,
					{ encoding: "utf8", mode: 0o755 },
				);

				const windowsPath = 'C:\\Users\\Pat "Q"\\.claude\\projects\\p\\s.jsonl';
				const hookJson = JSON.stringify({
					session_id: "s",
					transcript_path: windowsPath,
					hook_event_name: "Stop",
				});
				const result = spawnSync(bash as string, [script], {
					input: hookJson,
					env: {
						...process.env,
						PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
						CURL_OUT: out,
						SUPERSET_TAB_ID: "tab-1",
						SUPERSET_PROJECT_KEY: "shop-0123456789",
						SUPERSET_DEBUG_HOOKS: "0",
					},
					encoding: "utf8",
				});
				expect(result.status).toBe(0);
				const args = readFileSync(out, "utf8").split("\n");
				const forwarded = args
					.find((arg) => arg.startsWith("transcriptPath="))
					?.slice("transcriptPath=".length);
				expect(forwarded).toBeDefined();
				expect(decodeHookString(forwarded as string)).toBe(windowsPath);
				expect(args).toContain("eventType=Stop");
				expect(args).toContain("projectKey=shop-0123456789");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	},
);
