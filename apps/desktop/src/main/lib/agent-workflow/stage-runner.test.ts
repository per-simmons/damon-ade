import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treeKillWithEscalation } from "../tree-kill";
import {
	buildStageArgs,
	classifyFailure,
	type StageProgress,
	type StageRunSpec,
	startStageRun,
} from "./stage-runner";
import {
	blockNetwork,
	createFakeClaude,
	type FakeClaude,
	guardedSpawn,
	isAlive,
	waitFor,
} from "./testing/fake-claude";

let root: string;
let fake: FakeClaude;
let restoreNetwork: () => void;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "ade-runner-"));
	fake = createFakeClaude(root);
	restoreNetwork = blockNetwork();
});
afterAll(() => {
	restoreNetwork();
	rmSync(root, { recursive: true, force: true });
});

const killTree = async (pid: number) => {
	await treeKillWithEscalation({ pid, escalationTimeoutMs: 1000 });
};

function spec(overrides: Partial<StageRunSpec> = {}): StageRunSpec {
	return {
		command: fake.command,
		cwd: root,
		prompt: 'ADE task "t" (t).\nTask folder: /tasks/t\nDo it.',
		model: "claude-sonnet-5-5",
		effort: "medium",
		maxTurns: 40,
		maxBudgetUsd: 2.5,
		permissionMode: "acceptEdits",
		allowedTools: ["Bash(bun run test:*)"],
		disallowedTools: ["Write"],
		addDirs: ["/tasks"],
		agentsJson: '{"ade-reviewer":{}}',
		sessionId: "11111111-2222-3333-4444-555555555555",
		env: { ...process.env, ...fake.env },
		...overrides,
	};
}

function run(overrides: Partial<StageRunSpec> = {}) {
	const progress: StageProgress[] = [];
	const handle = startStageRun(spec(overrides), {
		spawnFn: guardedSpawn(fake),
		killTree,
		onProgress: (p) => progress.push(p),
	});
	return { handle, progress };
}

describe("buildStageArgs", () => {
	it("sets model, effort, turns, budget and permissions on the process that runs", () => {
		const args = buildStageArgs(spec());
		const at = (flag: string) => args[args.indexOf(flag) + 1];
		expect(at("--model")).toBe("claude-sonnet-5-5");
		expect(at("--effort")).toBe("medium");
		expect(at("--max-turns")).toBe("40");
		expect(at("--max-budget-usd")).toBe("2.50");
		expect(at("--permission-mode")).toBe("acceptEdits");
		expect(args).not.toContain("--dangerously-skip-permissions");
		// The prompt is never an argument; the session id ends every list.
		expect(args.join(" ")).not.toContain("Do it.");
		expect(args.slice(-2)).toEqual([
			"--session-id",
			"11111111-2222-3333-4444-555555555555",
		]);
	});
});

describe("startStageRun with a fake claude", () => {
	it("passes the prompt on stdin and reports cost, models and progress", async () => {
		fake.setSteps([
			{
				name: "ok",
				usage: [
					{ input: 10_000, output: 2_000 },
					{ model: "claude-haiku-5-5", input: 5_000, output: 500 },
				],
				text: "All done",
				cost: 0.05,
			},
		]);
		const { handle, progress } = run();
		const result = await handle.done;
		const call = fake.calls().at(-1);
		expect(call?.stdin).toContain("Do it.");
		expect(call?.args).not.toContain("Do it.");
		expect(result.failure).toBeUndefined();
		expect(result.reportedCostUsd).toBe(0.05);
		expect(result.costState).toBe("reported");
		expect(result.observedModels.sort()).toEqual([
			"claude-haiku-5-5",
			"claude-sonnet-5-5",
		]);
		expect(result.text).toBe("All done");
		// Progress while it ran: priced response by response.
		expect(progress.length).toBe(2);
		expect(progress[1].liveCostUsd).toBeGreaterThan(progress[0].liveCostUsd);
		expect(progress[0].costState).toBe("estimated");
	});

	it("marks usage on a model without a price as partial, never as complete", async () => {
		fake.setSteps([
			{
				name: "unpriced",
				usage: [
					{ input: 1_000, output: 100 },
					{ model: "claude-mystery-9", input: 1_000, output: 100 },
				],
			},
		]);
		const result = await run().handle.done;
		expect(result.reportedCostUsd).toBeUndefined();
		expect(result.costState).toBe("partial");
		expect(result.unpricedModels).toEqual(["claude-mystery-9"]);
	});

	it("reports a run without usage or result as unknown cost", async () => {
		fake.setSteps([{ name: "silent", usage: [], noResult: true, exit: 1 }]);
		const result = await run().handle.done;
		expect(result.costState).toBe("unknown");
		expect(result.failure).toBe("error");
	});

	it("classifies an unavailable model, a rate limit and an auth failure", async () => {
		fake.setSteps([
			{
				name: "no-model",
				isError: true,
				exit: 1,
				text: "API Error: 404 model: claude-fable-5-2 not_found_error",
			},
			{ name: "limited", isError: true, exit: 1, text: "429 rate_limit_error" },
			{
				name: "auth",
				isError: true,
				exit: 1,
				text: "Invalid API key · Please run /login",
			},
		]);
		expect((await run().handle.done).failure).toBe("model-unavailable");
		expect((await run().handle.done).failure).toBe("rate-limited");
		expect((await run().handle.done).failure).toBe("auth");
	});

	it("cancels by killing the whole process tree", async () => {
		fake.setSteps([{ name: "hang", hang: true }]);
		const { handle } = run();
		expect(
			await waitFor(() => {
				try {
					return readFileSync(fake.childPidFile, "utf8").length > 0;
				} catch {
					return false;
				}
			}),
		).toBe(true);
		const childPid = Number(readFileSync(fake.childPidFile, "utf8"));
		expect(isAlive(childPid)).toBe(true);
		await handle.cancel();
		const result = await handle.done;
		expect(result.cancelled).toBe(true);
		expect(result.failure).toBe("cancelled");
		expect(await waitFor(() => !isAlive(childPid), 5000)).toBe(true);
	}, 20_000);

	it("reports a launch failure for a missing executable", async () => {
		const handle = startStageRun(
			spec({ command: [join(root, "no-such-claude")] }),
			{ killTree },
		);
		const result = await handle.done;
		expect(result.failure).toBe("launch");
		expect(result.exitCode).toBeNull();
	});

	it("never runs a real claude in tests: the guard turns it into a launch failure", async () => {
		const handle = startStageRun(spec({ command: ["claude"] }), {
			spawnFn: guardedSpawn(fake),
			killTree,
		});
		const result = await handle.done;
		expect(result.failure).toBe("launch");
		expect(result.error).toContain("real model CLI");
	});
});

describe("classifyFailure", () => {
	const base = {
		exitCode: 1,
		timedOut: false,
		cancelled: false,
		stderr: "",
		hasResult: true,
		isError: true,
	};
	it("maps Claude Code results to reasons ADE acts on", () => {
		expect(classifyFailure({ ...base, subtype: "error_max_turns" })).toBe(
			"max-turns",
		);
		expect(classifyFailure({ ...base, subtype: "error_max_budget_usd" })).toBe(
			"budget",
		);
		expect(classifyFailure({ ...base, text: "Overloaded (529)" })).toBe(
			"rate-limited",
		);
		expect(
			classifyFailure({ ...base, text: "Claude usage limit reached" }),
		).toBe("rate-limited");
		expect(classifyFailure({ ...base, timedOut: true })).toBe("timeout");
		expect(
			classifyFailure({ ...base, exitCode: 0, isError: false }),
		).toBeUndefined();
		// Exit 0 without a result line is not a success.
		expect(
			classifyFailure({
				...base,
				exitCode: 0,
				isError: false,
				hasResult: false,
			}),
		).toBe("error");
	});
});
