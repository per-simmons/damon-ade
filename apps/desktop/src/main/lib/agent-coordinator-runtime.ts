import { randomUUID } from "node:crypto";

export type AgentRunStatus =
	| "queued"
	| "running"
	| "cancelling"
	| "synthesizing"
	| "completed"
	| "failed"
	| "cancelled";

export type AgentWorkerStatus =
	| "queued"
	| "running"
	| "retrying"
	| "completed"
	| "failed"
	| "cancelled";

export interface AgentUsage {
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	costUsd: number;
}

export type AgentUsageDelta = Partial<Omit<AgentUsage, "totalTokens">> & {
	totalTokens?: number;
};

export interface AgentWorkerBrief {
	id: string;
	objective: string;
	role?: string;
	context?: unknown;
	metadata?: Record<string, unknown>;
}

export interface StartAgentRunInput {
	id?: string;
	objective: string;
	briefs: readonly AgentWorkerBrief[];
	metadata?: Record<string, unknown>;
}

export interface SerializedAgentError {
	name: string;
	message: string;
	code?: string;
	stack?: string;
}

export interface AgentWorkerSnapshot<TOutput = unknown> {
	brief: AgentWorkerBrief;
	status: AgentWorkerStatus;
	attempts: number;
	usage: AgentUsage;
	output?: TOutput;
	error?: SerializedAgentError;
	startedAt?: number;
	finishedAt?: number;
}

export interface AgentRunSnapshot<
	TWorkerOutput = unknown,
	TFinalOutput = unknown,
> {
	id: string;
	objective: string;
	metadata?: Record<string, unknown>;
	status: AgentRunStatus;
	workers: AgentWorkerSnapshot<TWorkerOutput>[];
	usage: {
		workers: AgentUsage;
		synthesis: AgentUsage;
		total: AgentUsage;
	};
	output?: TFinalOutput;
	error?: SerializedAgentError;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	lastEventSequence: number;
}

export type AgentCoordinatorEventType =
	| "run.created"
	| "run.started"
	| "run.cancelling"
	| "run.synthesizing"
	| "run.completed"
	| "run.failed"
	| "run.cancelled"
	| "worker.started"
	| "worker.usage"
	| "worker.retrying"
	| "worker.completed"
	| "worker.failed"
	| "worker.cancelled"
	| "synthesis.started"
	| "synthesis.retrying"
	| "synthesis.completed";

export interface AgentCoordinatorEvent {
	sequence: number;
	at: number;
	runId: string;
	type: AgentCoordinatorEventType;
	workerId?: string;
	status?: AgentRunStatus | AgentWorkerStatus;
	attempt?: number;
	delayMs?: number;
	usage?: AgentUsage;
	error?: SerializedAgentError;
}

export interface AgentWorkerExecutionContext {
	runId: string;
	brief: AgentWorkerBrief;
	attempt: number;
	signal: AbortSignal;
	reportUsage(delta: AgentUsageDelta): void;
}

export interface AgentWorkerExecutionResult<TOutput = unknown> {
	output: TOutput;
	usage?: AgentUsageDelta;
}

export interface AgentSynthesisContext<TWorkerOutput = unknown> {
	runId: string;
	objective: string;
	metadata?: Record<string, unknown>;
	workers: ReadonlyArray<AgentWorkerSnapshot<TWorkerOutput>>;
	attempt: number;
	signal: AbortSignal;
	reportUsage(delta: AgentUsageDelta): void;
}

export interface AgentSynthesisResult<TOutput = unknown> {
	output: TOutput;
	usage?: AgentUsageDelta;
}

export interface AgentRetryPolicy {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
	backoffFactor: number;
}

export interface AgentCoordinatorRuntimeOptions<
	TWorkerOutput = unknown,
	TFinalOutput = unknown,
> {
	maxParallel?: number;
	retry?: Partial<AgentRetryPolicy>;
	executeWorker(
		context: AgentWorkerExecutionContext,
	): Promise<AgentWorkerExecutionResult<TWorkerOutput>>;
	synthesize(
		context: AgentSynthesisContext<TWorkerOutput>,
	): Promise<AgentSynthesisResult<TFinalOutput>>;
	isInfrastructureError?(error: unknown): boolean;
	now?: () => number;
	createId?: () => string;
	sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export class AgentInfrastructureError extends Error {
	readonly code?: string;

	constructor(message: string, options?: { code?: string; cause?: unknown }) {
		super(message, { cause: options?.cause });
		this.name = "AgentInfrastructureError";
		this.code = options?.code;
	}
}

export class AgentRunCancelledError extends Error {
	constructor(message = "Agent run cancelled") {
		super(message);
		this.name = "AgentRunCancelledError";
	}
}

interface InternalWorker<TOutput> extends AgentWorkerSnapshot<TOutput> {}

interface InternalRun<TWorkerOutput, TFinalOutput>
	extends AgentRunSnapshot<TWorkerOutput, TFinalOutput> {
	controller: AbortController;
	events: AgentCoordinatorEvent[];
	completion: Promise<AgentRunSnapshot<TWorkerOutput, TFinalOutput>>;
	resolveCompletion: (
		value: AgentRunSnapshot<TWorkerOutput, TFinalOutput>,
	) => void;
}

const EMPTY_USAGE: AgentUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cachedInputTokens: 0,
	reasoningTokens: 0,
	totalTokens: 0,
	costUsd: 0,
};

const DEFAULT_RETRY: AgentRetryPolicy = {
	maxAttempts: 3,
	baseDelayMs: 250,
	maxDelayMs: 5_000,
	backoffFactor: 2,
};

class ConcurrencyLimiter {
	private active = 0;
	private readonly queue: Array<{
		resolve: (release: () => void) => void;
		reject: (error: Error) => void;
		signal: AbortSignal;
		onAbort: () => void;
	}> = [];

	constructor(private readonly maximum: number) {}

	acquire(signal: AbortSignal): Promise<() => void> {
		if (signal.aborted) return Promise.reject(new AgentRunCancelledError());
		if (this.active < this.maximum) {
			this.active++;
			return Promise.resolve(this.makeRelease());
		}

		return new Promise((resolve, reject) => {
			const waiter = {
				resolve,
				reject,
				signal,
				onAbort: () => {
					const index = this.queue.indexOf(waiter);
					if (index >= 0) this.queue.splice(index, 1);
					reject(new AgentRunCancelledError());
				},
			};
			signal.addEventListener("abort", waiter.onAbort, { once: true });
			this.queue.push(waiter);
		});
	}

	private makeRelease(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			this.pump();
		};
	}

	private pump(): void {
		while (this.active < this.maximum && this.queue.length > 0) {
			const waiter = this.queue.shift();
			if (!waiter) return;
			waiter.signal.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal.aborted) {
				waiter.reject(new AgentRunCancelledError());
				continue;
			}
			this.active++;
			waiter.resolve(this.makeRelease());
		}
	}
}

export class AgentCoordinatorRuntime<
	TWorkerOutput = unknown,
	TFinalOutput = unknown,
> {
	private readonly runs = new Map<
		string,
		InternalRun<TWorkerOutput, TFinalOutput>
	>();
	private readonly listeners = new Set<
		(event: AgentCoordinatorEvent) => void
	>();
	private readonly limiter: ConcurrencyLimiter;
	private readonly retry: AgentRetryPolicy;
	private readonly now: () => number;
	private readonly createId: () => string;
	private readonly sleep: (
		delayMs: number,
		signal: AbortSignal,
	) => Promise<void>;
	private nextSequence = 1;

	constructor(
		private readonly options: AgentCoordinatorRuntimeOptions<
			TWorkerOutput,
			TFinalOutput
		>,
	) {
		const maxParallel = options.maxParallel ?? 4;
		if (!Number.isInteger(maxParallel) || maxParallel < 1) {
			throw new RangeError("maxParallel must be a positive integer");
		}
		this.retry = { ...DEFAULT_RETRY, ...options.retry };
		validateRetryPolicy(this.retry);
		this.limiter = new ConcurrencyLimiter(maxParallel);
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? randomUUID;
		this.sleep = options.sleep ?? abortableSleep;
	}

	startRun(
		input: StartAgentRunInput,
	): AgentRunSnapshot<TWorkerOutput, TFinalOutput> {
		validateRunInput(input);
		const id = input.id?.trim() || this.createId();
		if (this.runs.has(id)) throw new Error(`Agent run already exists: ${id}`);

		const createdAt = this.now();
		let resolveCompletion!: (
			value: AgentRunSnapshot<TWorkerOutput, TFinalOutput>,
		) => void;
		const completion = new Promise<
			AgentRunSnapshot<TWorkerOutput, TFinalOutput>
		>((resolve) => {
			resolveCompletion = resolve;
		});
		const run: InternalRun<TWorkerOutput, TFinalOutput> = {
			id,
			objective: input.objective,
			metadata: clone(input.metadata),
			status: "queued",
			workers: input.briefs.map((brief) => ({
				brief: clone(brief),
				status: "queued",
				attempts: 0,
				usage: emptyUsage(),
			})),
			usage: {
				workers: emptyUsage(),
				synthesis: emptyUsage(),
				total: emptyUsage(),
			},
			createdAt,
			lastEventSequence: 0,
			controller: new AbortController(),
			events: [],
			completion,
			resolveCompletion,
		};
		this.runs.set(id, run);
		this.emit(run, { type: "run.created", status: "queued" });
		queueMicrotask(() => void this.executeRun(run));
		return this.snapshot(run);
	}

	getRun(
		runId: string,
	): AgentRunSnapshot<TWorkerOutput, TFinalOutput> | undefined {
		const run = this.runs.get(runId);
		return run ? this.snapshot(run) : undefined;
	}

	listRuns(): AgentRunSnapshot<TWorkerOutput, TFinalOutput>[] {
		return [...this.runs.values()].map((run) => this.snapshot(run));
	}

	waitForRun(
		runId: string,
	): Promise<AgentRunSnapshot<TWorkerOutput, TFinalOutput>> {
		const run = this.requireRun(runId);
		return run.completion.then((snapshot) => clone(snapshot));
	}

	cancelRun(runId: string): boolean {
		const run = this.runs.get(runId);
		if (!run || isTerminalRunStatus(run.status)) return false;
		if (run.status !== "cancelling") {
			run.status = "cancelling";
			this.emit(run, { type: "run.cancelling", status: "cancelling" });
			run.controller.abort(new AgentRunCancelledError());
		}
		return true;
	}

	removeRun(runId: string): boolean {
		const run = this.runs.get(runId);
		if (!run || !isTerminalRunStatus(run.status)) return false;
		return this.runs.delete(runId);
	}

	getEvents(runId: string, afterSequence = 0): AgentCoordinatorEvent[] {
		if (!Number.isInteger(afterSequence) || afterSequence < 0) {
			throw new RangeError("afterSequence must be a non-negative integer");
		}
		return clone(
			this.requireRun(runId).events.filter(
				(event) => event.sequence > afterSequence,
			),
		);
	}

	subscribe(listener: (event: AgentCoordinatorEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async executeRun(
		run: InternalRun<TWorkerOutput, TFinalOutput>,
	): Promise<void> {
		if (run.controller.signal.aborted) {
			this.finishCancelled(run);
			return;
		}
		run.status = "running";
		run.startedAt = this.now();
		this.emit(run, { type: "run.started", status: "running" });

		await Promise.all(
			run.workers.map((worker) => this.executeWorker(run, worker)),
		);
		this.recalculateUsage(run);
		if (run.controller.signal.aborted) {
			this.finishCancelled(run);
			return;
		}

		const failedWorker = run.workers.find(
			(worker) => worker.status === "failed",
		);
		if (failedWorker) {
			this.finishFailed(
				run,
				new Error(
					`Worker ${failedWorker.brief.id} failed: ${failedWorker.error?.message}`,
				),
			);
			return;
		}

		await this.synthesize(run);
	}

	private async executeWorker(
		run: InternalRun<TWorkerOutput, TFinalOutput>,
		worker: InternalWorker<TWorkerOutput>,
	): Promise<void> {
		while (!run.controller.signal.aborted) {
			let release: (() => void) | undefined;
			try {
				release = await this.limiter.acquire(run.controller.signal);
				if (run.controller.signal.aborted) throw new AgentRunCancelledError();
				worker.status = "running";
				worker.attempts++;
				worker.startedAt ??= this.now();
				this.emit(run, {
					type: "worker.started",
					workerId: worker.brief.id,
					status: "running",
					attempt: worker.attempts,
				});

				const result = await this.options.executeWorker({
					runId: run.id,
					brief: clone(worker.brief),
					attempt: worker.attempts,
					signal: run.controller.signal,
					reportUsage: (delta) => this.reportWorkerUsage(run, worker, delta),
				});
				if (run.controller.signal.aborted) throw new AgentRunCancelledError();
				addUsage(worker.usage, result.usage);
				worker.output = clone(result.output);
				worker.status = "completed";
				worker.finishedAt = this.now();
				this.recalculateUsage(run);
				this.emit(run, {
					type: "worker.completed",
					workerId: worker.brief.id,
					status: "completed",
					attempt: worker.attempts,
					usage: clone(worker.usage),
				});
				return;
			} catch (error) {
				if (
					run.controller.signal.aborted ||
					error instanceof AgentRunCancelledError
				) {
					this.markWorkerCancelled(run, worker);
					return;
				}
				worker.error = serializeError(error);
				if (
					this.isInfrastructureError(error) &&
					worker.attempts < this.retry.maxAttempts
				) {
					worker.status = "retrying";
					const delayMs = this.retryDelay(worker.attempts);
					this.emit(run, {
						type: "worker.retrying",
						workerId: worker.brief.id,
						status: "retrying",
						attempt: worker.attempts,
						delayMs,
						error: worker.error,
					});
					release?.();
					release = undefined;
					try {
						await this.sleep(delayMs, run.controller.signal);
					} catch {
						this.markWorkerCancelled(run, worker);
						return;
					}
					continue;
				}
				worker.status = "failed";
				worker.finishedAt = this.now();
				this.emit(run, {
					type: "worker.failed",
					workerId: worker.brief.id,
					status: "failed",
					attempt: worker.attempts,
					error: worker.error,
				});
				return;
			} finally {
				release?.();
			}
		}
		this.markWorkerCancelled(run, worker);
	}

	private async synthesize(
		run: InternalRun<TWorkerOutput, TFinalOutput>,
	): Promise<void> {
		run.status = "synthesizing";
		this.emit(run, { type: "run.synthesizing", status: "synthesizing" });
		let attempt = 0;
		while (!run.controller.signal.aborted) {
			attempt++;
			this.emit(run, { type: "synthesis.started", attempt });
			try {
				const result = await this.options.synthesize({
					runId: run.id,
					objective: run.objective,
					metadata: clone(run.metadata),
					workers: clone(run.workers),
					attempt,
					signal: run.controller.signal,
					reportUsage: (delta) => {
						if (run.controller.signal.aborted) return;
						addUsage(run.usage.synthesis, delta);
						this.recalculateUsage(run);
					},
				});
				if (run.controller.signal.aborted) throw new AgentRunCancelledError();
				addUsage(run.usage.synthesis, result.usage);
				run.output = clone(result.output);
				this.recalculateUsage(run);
				this.emit(run, {
					type: "synthesis.completed",
					attempt,
					usage: clone(run.usage.synthesis),
				});
				this.finishCompleted(run);
				return;
			} catch (error) {
				if (
					run.controller.signal.aborted ||
					error instanceof AgentRunCancelledError
				) {
					this.finishCancelled(run);
					return;
				}
				if (
					this.isInfrastructureError(error) &&
					attempt < this.retry.maxAttempts
				) {
					const delayMs = this.retryDelay(attempt);
					this.emit(run, {
						type: "synthesis.retrying",
						attempt,
						delayMs,
						error: serializeError(error),
					});
					try {
						await this.sleep(delayMs, run.controller.signal);
					} catch {
						this.finishCancelled(run);
						return;
					}
					continue;
				}
				this.finishFailed(run, error);
				return;
			}
		}
		this.finishCancelled(run);
	}

	private reportWorkerUsage(
		run: InternalRun<TWorkerOutput, TFinalOutput>,
		worker: InternalWorker<TWorkerOutput>,
		delta: AgentUsageDelta,
	): void {
		if (run.controller.signal.aborted || worker.status !== "running") return;
		addUsage(worker.usage, delta);
		this.recalculateUsage(run);
		this.emit(run, {
			type: "worker.usage",
			workerId: worker.brief.id,
			status: "running",
			attempt: worker.attempts,
			usage: clone(worker.usage),
		});
	}

	private markWorkerCancelled(
		run: InternalRun<TWorkerOutput, TFinalOutput>,
		worker: InternalWorker<TWorkerOutput>,
	): void {
		if (worker.status === "cancelled" || worker.status === "completed") return;
		worker.status = "cancelled";
		worker.finishedAt = this.now();
		this.emit(run, {
			type: "worker.cancelled",
			workerId: worker.brief.id,
			status: "cancelled",
			attempt: worker.attempts,
		});
	}

	private finishCompleted(run: InternalRun<TWorkerOutput, TFinalOutput>): void {
		run.status = "completed";
		run.finishedAt = this.now();
		this.emit(run, { type: "run.completed", status: "completed" });
		run.resolveCompletion(this.snapshot(run));
	}

	private finishFailed(
		run: InternalRun<TWorkerOutput, TFinalOutput>,
		error: unknown,
	): void {
		run.status = "failed";
		run.error = serializeError(error);
		run.finishedAt = this.now();
		this.emit(run, {
			type: "run.failed",
			status: "failed",
			error: run.error,
		});
		run.resolveCompletion(this.snapshot(run));
	}

	private finishCancelled(run: InternalRun<TWorkerOutput, TFinalOutput>): void {
		if (isTerminalRunStatus(run.status)) return;
		for (const worker of run.workers) this.markWorkerCancelled(run, worker);
		run.status = "cancelled";
		run.finishedAt = this.now();
		this.recalculateUsage(run);
		this.emit(run, { type: "run.cancelled", status: "cancelled" });
		run.resolveCompletion(this.snapshot(run));
	}

	private recalculateUsage(
		run: InternalRun<TWorkerOutput, TFinalOutput>,
	): void {
		run.usage.workers = run.workers.reduce(
			(total, worker) => sumUsage(total, worker.usage),
			emptyUsage(),
		);
		run.usage.total = sumUsage(run.usage.workers, run.usage.synthesis);
	}

	private retryDelay(failedAttempt: number): number {
		return Math.min(
			this.retry.maxDelayMs,
			this.retry.baseDelayMs * this.retry.backoffFactor ** (failedAttempt - 1),
		);
	}

	private isInfrastructureError(error: unknown): boolean {
		return (
			error instanceof AgentInfrastructureError ||
			this.options.isInfrastructureError?.(error) === true
		);
	}

	private requireRun(runId: string): InternalRun<TWorkerOutput, TFinalOutput> {
		const run = this.runs.get(runId);
		if (!run) throw new Error(`Unknown agent run: ${runId}`);
		return run;
	}

	private emit(
		run: InternalRun<TWorkerOutput, TFinalOutput>,
		event: Omit<AgentCoordinatorEvent, "sequence" | "at" | "runId">,
	): void {
		const completeEvent: AgentCoordinatorEvent = {
			...event,
			sequence: this.nextSequence++,
			at: this.now(),
			runId: run.id,
		};
		run.lastEventSequence = completeEvent.sequence;
		run.events.push(completeEvent);
		for (const listener of this.listeners) {
			try {
				listener(clone(completeEvent));
			} catch {
				// Observers must never be able to stop orchestration.
			}
		}
	}

	private snapshot(
		run: InternalRun<TWorkerOutput, TFinalOutput>,
	): AgentRunSnapshot<TWorkerOutput, TFinalOutput> {
		const { controller, events, completion, resolveCompletion, ...snapshot } =
			run;
		void controller;
		void events;
		void completion;
		void resolveCompletion;
		return clone(snapshot);
	}
}

function validateRunInput(input: StartAgentRunInput): void {
	if (!input.objective.trim()) throw new Error("Run objective is required");
	if (input.id !== undefined && !input.id.trim()) {
		throw new Error("Run id cannot be blank");
	}
	const ids = new Set<string>();
	for (const brief of input.briefs) {
		if (!brief.id.trim()) throw new Error("Worker brief id is required");
		if (!brief.objective.trim()) {
			throw new Error(`Worker objective is required: ${brief.id}`);
		}
		if (ids.has(brief.id))
			throw new Error(`Duplicate worker brief id: ${brief.id}`);
		ids.add(brief.id);
	}
	clone(input);
}

function validateRetryPolicy(policy: AgentRetryPolicy): void {
	if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
		throw new RangeError("retry.maxAttempts must be a positive integer");
	}
	if (!Number.isFinite(policy.baseDelayMs) || policy.baseDelayMs < 0) {
		throw new RangeError("retry.baseDelayMs must be non-negative");
	}
	if (!Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < 0) {
		throw new RangeError("retry.maxDelayMs must be non-negative");
	}
	if (!Number.isFinite(policy.backoffFactor) || policy.backoffFactor < 1) {
		throw new RangeError("retry.backoffFactor must be at least 1");
	}
}

function emptyUsage(): AgentUsage {
	return { ...EMPTY_USAGE };
}

function addUsage(target: AgentUsage, delta?: AgentUsageDelta): void {
	if (!delta) return;
	for (const key of [
		"inputTokens",
		"outputTokens",
		"cachedInputTokens",
		"reasoningTokens",
		"costUsd",
	] as const) {
		const value = delta[key] ?? 0;
		if (!Number.isFinite(value) || value < 0) {
			throw new RangeError(`Usage ${key} must be a non-negative finite number`);
		}
		target[key] += value;
	}
	const explicitTotal = delta.totalTokens;
	if (explicitTotal !== undefined) {
		if (!Number.isFinite(explicitTotal) || explicitTotal < 0) {
			throw new RangeError(
				"Usage totalTokens must be a non-negative finite number",
			);
		}
		target.totalTokens += explicitTotal;
	} else {
		target.totalTokens += (delta.inputTokens ?? 0) + (delta.outputTokens ?? 0);
	}
}

function sumUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
	return {
		inputTokens: left.inputTokens + right.inputTokens,
		outputTokens: left.outputTokens + right.outputTokens,
		cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
		reasoningTokens: left.reasoningTokens + right.reasoningTokens,
		totalTokens: left.totalTokens + right.totalTokens,
		costUsd: left.costUsd + right.costUsd,
	};
}

function serializeError(error: unknown): SerializedAgentError {
	if (error instanceof Error) {
		const code =
			"code" in error && typeof error.code === "string"
				? error.code
				: undefined;
		return {
			name: error.name,
			message: error.message,
			code,
			stack: error.stack,
		};
	}
	return { name: "Error", message: String(error) };
}

function isTerminalRunStatus(status: AgentRunStatus): boolean {
	return (
		status === "completed" || status === "failed" || status === "cancelled"
	);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(new AgentRunCancelledError());
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new AgentRunCancelledError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
