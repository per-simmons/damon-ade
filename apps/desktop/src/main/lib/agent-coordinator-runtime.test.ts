import { describe, expect, it } from "bun:test";
import {
	AgentCoordinatorRuntime,
	type AgentCoordinatorRuntimeOptions,
	AgentInfrastructureError,
} from "./agent-coordinator-runtime";

const briefs = (count: number) =>
	Array.from({ length: count }, (_, index) => ({
		id: `worker-${index + 1}`,
		objective: `Do part ${index + 1}`,
	}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function runtime(
	overrides: Partial<AgentCoordinatorRuntimeOptions<string, string>> = {},
) {
	return new AgentCoordinatorRuntime<string, string>({
		executeWorker: async ({ brief }) => ({ output: brief.id }),
		synthesize: async ({ workers }) => ({
			output: workers.map((worker) => worker.output).join(","),
		}),
		...overrides,
	});
}

describe("AgentCoordinatorRuntime", () => {
	it("runs workers, synthesizes their reports, and exposes serializable snapshots", async () => {
		const coordinator = runtime();
		const started = coordinator.startRun({
			id: "run-1",
			objective: "Ship it",
			briefs: briefs(3),
			metadata: { source: "trpc" },
		});

		expect(started.status).toBe("queued");
		const result = await coordinator.waitForRun("run-1");
		expect(result.status).toBe("completed");
		expect(result.output).toBe("worker-1,worker-2,worker-3");
		expect(result.workers.map((worker) => worker.status)).toEqual([
			"completed",
			"completed",
			"completed",
		]);
		expect(result.startedAt).toBeNumber();
		expect(result.finishedAt).toBeNumber();
		expect(() => structuredClone(result)).not.toThrow();
	});

	it("enforces the global parallelism limit across runs", async () => {
		let active = 0;
		let peak = 0;
		const gates: Array<ReturnType<typeof deferred<void>>> = [];
		const coordinator = runtime({
			maxParallel: 2,
			executeWorker: async ({ brief }) => {
				active++;
				peak = Math.max(peak, active);
				const gate = deferred<void>();
				gates.push(gate);
				await gate.promise;
				active--;
				return { output: brief.id };
			},
		});

		coordinator.startRun({ id: "a", objective: "A", briefs: briefs(3) });
		coordinator.startRun({ id: "b", objective: "B", briefs: briefs(3) });
		await waitUntil(() => gates.length === 2);
		expect(peak).toBe(2);
		let released = 0;
		while (gates.length < 6) {
			gates[released++]?.resolve();
			await Bun.sleep(0);
		}
		for (; released < gates.length; released++) gates[released]?.resolve();
		await Promise.all([
			coordinator.waitForRun("a"),
			coordinator.waitForRun("b"),
		]);
		expect(peak).toBe(2);
	});

	it("retries infrastructure failures with exponential capped backoff", async () => {
		const delays: number[] = [];
		let attempts = 0;
		const coordinator = runtime({
			retry: { baseDelayMs: 10, maxDelayMs: 15, backoffFactor: 2 },
			sleep: async (delay) => {
				delays.push(delay);
			},
			executeWorker: async () => {
				attempts++;
				if (attempts < 3) throw new AgentInfrastructureError("offline");
				return { output: "recovered" };
			},
		});
		coordinator.startRun({
			id: "retry",
			objective: "Retry",
			briefs: briefs(1),
		});

		const result = await coordinator.waitForRun("retry");
		expect(result.status).toBe("completed");
		expect(result.workers[0]?.attempts).toBe(3);
		expect(delays).toEqual([10, 15]);
		expect(
			coordinator
				.getEvents("retry")
				.filter((event) => event.type === "worker.retrying"),
		).toHaveLength(2);
	});

	it("supports custom infrastructure classification", async () => {
		let attempts = 0;
		const coordinator = runtime({
			retry: { baseDelayMs: 0 },
			isInfrastructureError: (error) =>
				error instanceof Error && error.message === "transient",
			executeWorker: async () => {
				if (++attempts === 1) throw new Error("transient");
				return { output: "ok" };
			},
		});
		coordinator.startRun({
			id: "classified",
			objective: "Work",
			briefs: briefs(1),
		});
		expect((await coordinator.waitForRun("classified")).status).toBe(
			"completed",
		);
		expect(attempts).toBe(2);
	});

	it("does not retry domain failures and skips synthesis", async () => {
		let synthesized = false;
		const coordinator = runtime({
			executeWorker: async () => {
				throw Object.assign(new Error("bad request"), { code: "BAD_INPUT" });
			},
			synthesize: async () => {
				synthesized = true;
				return { output: "no" };
			},
		});
		coordinator.startRun({
			id: "failed",
			objective: "Work",
			briefs: briefs(1),
		});

		const result = await coordinator.waitForRun("failed");
		expect(result.status).toBe("failed");
		expect(result.workers[0]?.attempts).toBe(1);
		expect(result.workers[0]?.error?.code).toBe("BAD_INPUT");
		expect(synthesized).toBe(false);
	});

	it("exhausts infrastructure retries and fails the run", async () => {
		const coordinator = runtime({
			retry: { maxAttempts: 2, baseDelayMs: 0 },
			executeWorker: async () => {
				throw new AgentInfrastructureError("still down", {
					code: "ECONNRESET",
				});
			},
		});
		coordinator.startRun({
			id: "exhausted",
			objective: "Work",
			briefs: briefs(1),
		});
		const result = await coordinator.waitForRun("exhausted");
		expect(result.status).toBe("failed");
		expect(result.workers[0]?.attempts).toBe(2);
		expect(result.workers[0]?.error?.code).toBe("ECONNRESET");
	});

	it("tracks incremental and returned usage per worker and synthesis", async () => {
		const coordinator = runtime({
			executeWorker: async ({ brief, reportUsage }) => {
				reportUsage({ inputTokens: 2, cachedInputTokens: 1, costUsd: 0.01 });
				return {
					output: brief.id,
					usage: { outputTokens: 3, reasoningTokens: 1 },
				};
			},
			synthesize: async ({ reportUsage }) => {
				reportUsage({ inputTokens: 4 });
				return { output: "final", usage: { outputTokens: 2, costUsd: 0.02 } };
			},
		});
		coordinator.startRun({
			id: "usage",
			objective: "Count",
			briefs: briefs(2),
		});
		const result = await coordinator.waitForRun("usage");

		expect(result.workers[0]?.usage).toMatchObject({
			inputTokens: 2,
			outputTokens: 3,
			totalTokens: 5,
		});
		expect(result.usage.workers).toMatchObject({
			inputTokens: 4,
			outputTokens: 6,
			totalTokens: 10,
			costUsd: 0.02,
		});
		expect(result.usage.synthesis).toMatchObject({
			inputTokens: 4,
			outputTokens: 2,
			totalTokens: 6,
			costUsd: 0.02,
		});
		expect(result.usage.total).toMatchObject({
			inputTokens: 8,
			outputTokens: 8,
			totalTokens: 16,
			costUsd: 0.04,
		});
	});

	it("cancels running and queued workers and never synthesizes", async () => {
		let synthesized = false;
		const entered = deferred<void>();
		const coordinator = runtime({
			maxParallel: 1,
			executeWorker: ({ signal }) =>
				new Promise((_, reject) => {
					entered.resolve();
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}),
			synthesize: async () => {
				synthesized = true;
				return { output: "no" };
			},
		});
		coordinator.startRun({
			id: "cancel",
			objective: "Stop",
			briefs: briefs(3),
		});
		await entered.promise;

		expect(coordinator.cancelRun("cancel")).toBe(true);
		const result = await coordinator.waitForRun("cancel");
		expect(result.status).toBe("cancelled");
		expect(result.workers.map((worker) => worker.status)).toEqual([
			"cancelled",
			"cancelled",
			"cancelled",
		]);
		expect(synthesized).toBe(false);
		expect(coordinator.cancelRun("cancel")).toBe(false);
	});

	it("cancels before a queued run starts", async () => {
		let executions = 0;
		const coordinator = runtime({
			executeWorker: async () => {
				executions++;
				return { output: "unexpected" };
			},
		});
		coordinator.startRun({ id: "early", objective: "Stop", briefs: briefs(2) });
		coordinator.cancelRun("early");
		const result = await coordinator.waitForRun("early");
		expect(result.status).toBe("cancelled");
		expect(executions).toBe(0);
	});

	it("retries infrastructure failures during synthesis", async () => {
		let attempts = 0;
		const coordinator = runtime({
			retry: { baseDelayMs: 0 },
			synthesize: async () => {
				if (++attempts === 1)
					throw new AgentInfrastructureError("model unavailable");
				return { output: "summary" };
			},
		});
		coordinator.startRun({
			id: "synth-retry",
			objective: "Work",
			briefs: briefs(1),
		});
		const result = await coordinator.waitForRun("synth-retry");
		expect(result.status).toBe("completed");
		expect(attempts).toBe(2);
		expect(
			coordinator
				.getEvents("synth-retry")
				.some((event) => event.type === "synthesis.retrying"),
		).toBe(true);
	});

	it("serializes synthesis failure into a failed terminal run", async () => {
		const coordinator = runtime({
			synthesize: async () => {
				throw new Error("cannot combine");
			},
		});
		coordinator.startRun({
			id: "synth-fail",
			objective: "Work",
			briefs: briefs(0),
		});
		const result = await coordinator.waitForRun("synth-fail");
		expect(result.status).toBe("failed");
		expect(result.error?.message).toBe("cannot combine");
	});

	it("provides ordered events, cursor reads, and unsubscribe", async () => {
		const observed: number[] = [];
		const coordinator = runtime();
		const unsubscribe = coordinator.subscribe((event) =>
			observed.push(event.sequence),
		);
		coordinator.startRun({
			id: "events",
			objective: "Observe",
			briefs: briefs(1),
		});
		await coordinator.waitForRun("events");
		unsubscribe();
		coordinator.startRun({
			id: "later",
			objective: "Later",
			briefs: briefs(0),
		});
		await coordinator.waitForRun("later");

		const events = coordinator.getEvents("events");
		expect(events.map((event) => event.sequence)).toEqual(
			[...events.map((event) => event.sequence)].sort((a, b) => a - b),
		);
		const cursor = events[2]?.sequence ?? 0;
		expect(
			coordinator
				.getEvents("events", cursor)
				.every((event) => event.sequence > cursor),
		).toBe(true);
		expect(observed).toHaveLength(events.length);
	});

	it("isolates internal state from input, snapshots, events, and listeners", async () => {
		const input = {
			id: "isolated",
			objective: "Stable",
			briefs: briefs(1),
			metadata: { nested: { value: 1 } },
		};
		const coordinator = runtime();
		coordinator.subscribe((event) => {
			event.type = "run.failed";
		});
		const started = coordinator.startRun(input);
		input.metadata.nested.value = 9;
		const startedWorker = started.workers[0];
		if (!startedWorker) throw new Error("Expected a worker snapshot");
		startedWorker.brief.objective = "mutated";
		const event = coordinator.getEvents("isolated")[0];
		if (!event) throw new Error("Expected a run event");
		event.type = "run.failed";
		const result = await coordinator.waitForRun("isolated");

		expect(result.metadata).toEqual({ nested: { value: 1 } });
		expect(result.workers[0]?.brief.objective).toBe("Do part 1");
		expect(coordinator.getEvents("isolated")[0]?.type).toBe("run.created");
	});

	it("validates configuration, run identity, briefs, usage, and cursors", async () => {
		expect(() => runtime({ maxParallel: 0 })).toThrow("maxParallel");
		expect(() => runtime({ retry: { maxAttempts: 0 } })).toThrow("maxAttempts");
		const coordinator = runtime({
			executeWorker: async () => ({ output: "x", usage: { inputTokens: -1 } }),
		});
		expect(() => coordinator.startRun({ objective: " ", briefs: [] })).toThrow(
			"objective",
		);
		expect(() =>
			coordinator.startRun({ id: " ", objective: "x", briefs: [] }),
		).toThrow("id");
		expect(() =>
			coordinator.startRun({
				id: "dup",
				objective: "x",
				briefs: [
					{ id: "same", objective: "first" },
					{ id: "same", objective: "second" },
				],
			}),
		).toThrow("Duplicate");
		coordinator.startRun({
			id: "usage-error",
			objective: "x",
			briefs: briefs(1),
		});
		expect((await coordinator.waitForRun("usage-error")).status).toBe("failed");
		expect(() => coordinator.getEvents("usage-error", -1)).toThrow(
			"afterSequence",
		);
		expect(() => coordinator.waitForRun("missing")).toThrow(
			"Unknown agent run",
		);
	});

	it("lists runs and only removes terminal runs", async () => {
		const gate = deferred<void>();
		const coordinator = runtime({
			executeWorker: async () => {
				await gate.promise;
				return { output: "done" };
			},
		});
		coordinator.startRun({
			id: "removable",
			objective: "x",
			briefs: briefs(1),
		});
		expect(coordinator.removeRun("removable")).toBe(false);
		expect(coordinator.listRuns()).toHaveLength(1);
		gate.resolve();
		await coordinator.waitForRun("removable");
		expect(coordinator.removeRun("removable")).toBe(true);
		expect(coordinator.getRun("removable")).toBeUndefined();
	});
});

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() > deadline)
			throw new Error("Timed out waiting for condition");
		await Bun.sleep(0);
	}
}
