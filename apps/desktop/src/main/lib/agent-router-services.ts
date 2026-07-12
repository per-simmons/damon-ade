import type { ChildProcess, SpawnOptions } from "node:child_process";
import { execFile, spawn } from "node:child_process";

export const ROUTER_SERVICE_NAMES = [
	"cloudflared",
	"tailscale",
	"headroom",
] as const;

export type RouterServiceName = (typeof ROUTER_SERVICE_NAMES)[number] | string;
export type RouterServiceState =
	| "stopped"
	| "starting"
	| "running"
	| "stopping"
	| "failed";

export interface RouterServiceStatus {
	name: RouterServiceName;
	state: RouterServiceState;
	pid: number | null;
	startedAt: string | null;
	stoppedAt: string | null;
	exitCode: number | null;
	error: string | null;
	command: string | null;
	args: string[];
	recentOutput: string[];
}

export interface ProcessStartSpec {
	command: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	startTimeoutMs?: number;
	stopTimeoutMs?: number;
}

export interface RouterProcessAdapter<TOptions = unknown> {
	readonly name: RouterServiceName;
	start(options: TOptions): ProcessStartSpec | Promise<ProcessStartSpec>;
}

export interface ManagedChildProcess
	extends Pick<ChildProcess, "pid" | "stdout" | "stderr"> {
	on(event: "spawn", listener: () => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	on(
		event: "exit",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): this;
	kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnProcess = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => ManagedChildProcess;

export type StopProcessTree = (input: {
	pid: number;
	platform: NodeJS.Platform;
	timeoutMs: number;
	child: ManagedChildProcess;
}) => Promise<void>;

export interface AgentRouterServiceRegistryOptions {
	spawnProcess?: SpawnProcess;
	stopProcessTree?: StopProcessTree;
	platform?: NodeJS.Platform;
	now?: () => Date;
	maxOutputLines?: number;
}

const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_LINES = 50;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 300_000;
const REDACTED = "[REDACTED]";

type RuntimeEntry = {
	adapter: RouterProcessAdapter<unknown>;
	status: RouterServiceStatus;
	child: ManagedChildProcess | null;
	operation: Promise<RouterServiceStatus> | null;
	stopTimeoutMs: number;
};

export class AgentRouterServiceRegistry {
	private readonly entries = new Map<RouterServiceName, RuntimeEntry>();
	private readonly spawnProcess: SpawnProcess;
	private readonly stopProcessTree: StopProcessTree;
	private readonly platform: NodeJS.Platform;
	private readonly now: () => Date;
	private readonly maxOutputLines: number;

	constructor(options: AgentRouterServiceRegistryOptions = {}) {
		this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
		this.stopProcessTree = options.stopProcessTree ?? defaultStopProcessTree;
		this.platform = options.platform ?? process.platform;
		this.now = options.now ?? (() => new Date());
		this.maxOutputLines = Math.max(
			1,
			Math.floor(options.maxOutputLines ?? DEFAULT_MAX_OUTPUT_LINES),
		);
	}

	register<TOptions>(adapter: RouterProcessAdapter<TOptions>): this {
		if (!adapter.name.trim())
			throw new Error("Router service name is required");
		if (this.entries.has(adapter.name)) {
			throw new Error(`Router service already registered: ${adapter.name}`);
		}
		this.entries.set(adapter.name, {
			adapter: adapter as RouterProcessAdapter<unknown>,
			child: null,
			operation: null,
			stopTimeoutMs: DEFAULT_STOP_TIMEOUT_MS,
			status: emptyServiceStatus(adapter.name),
		});
		return this;
	}

	has(name: RouterServiceName): boolean {
		return this.entries.has(name);
	}

	list(): RouterServiceStatus[] {
		return [...this.entries.values()].map((entry) => cloneStatus(entry.status));
	}

	status(name: RouterServiceName): RouterServiceStatus {
		return cloneStatus(this.requiredEntry(name).status);
	}

	async start<TOptions>(
		name: RouterServiceName,
		options: TOptions,
	): Promise<RouterServiceStatus> {
		const entry = this.requiredEntry(name);
		if (entry.status.state === "running") return cloneStatus(entry.status);
		if (entry.operation) return entry.operation.then(cloneStatus);

		const operation = this.startEntry(entry, options);
		entry.operation = operation;
		try {
			return cloneStatus(await operation);
		} finally {
			if (entry.operation === operation) entry.operation = null;
		}
	}

	async stop(name: RouterServiceName): Promise<RouterServiceStatus> {
		const entry = this.requiredEntry(name);
		if (entry.operation) await entry.operation.catch(() => undefined);
		if (!entry.child || entry.status.state === "stopped") {
			return cloneStatus(entry.status);
		}

		const operation = this.stopEntry(entry);
		entry.operation = operation;
		try {
			return cloneStatus(await operation);
		} finally {
			if (entry.operation === operation) entry.operation = null;
		}
	}

	async stopAll(): Promise<RouterServiceStatus[]> {
		return Promise.all([...this.entries.keys()].map((name) => this.stop(name)));
	}

	private async startEntry(
		entry: RuntimeEntry,
		options: unknown,
	): Promise<RouterServiceStatus> {
		entry.status = {
			...emptyServiceStatus(entry.adapter.name),
			state: "starting",
		};
		try {
			const spec = await entry.adapter.start(options);
			validateStartSpec(spec);
			const timeoutMs = normalizeTimeout(
				spec.startTimeoutMs,
				DEFAULT_START_TIMEOUT_MS,
			);
			entry.stopTimeoutMs = normalizeTimeout(
				spec.stopTimeoutMs,
				DEFAULT_STOP_TIMEOUT_MS,
			);
			const child = this.spawnProcess(spec.command, spec.args ?? [], {
				cwd: spec.cwd,
				env: spec.env ? { ...process.env, ...spec.env } : process.env,
				shell: false,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
			entry.child = child;
			entry.status.command = redactSensitiveText(spec.command);
			entry.status.args = redactArguments(spec.args ?? []);
			this.captureOutput(entry, child);
			this.trackExit(entry, child);

			await waitForSpawn(child, timeoutMs);
			if (!child.pid) throw new Error("Service started without a process id");
			entry.status = {
				...entry.status,
				state: "running",
				pid: child.pid,
				startedAt: this.now().toISOString(),
				error: null,
			};
			return entry.status;
		} catch (error) {
			const child = entry.child;
			entry.child = null;
			if (child?.pid) {
				await this.stopProcessTree({
					pid: child.pid,
					platform: this.platform,
					timeoutMs: entry.stopTimeoutMs,
					child,
				}).catch(() => undefined);
			}
			entry.status = {
				...entry.status,
				state: "failed",
				pid: null,
				error: redactError(error),
				stoppedAt: this.now().toISOString(),
			};
			return entry.status;
		}
	}

	private async stopEntry(entry: RuntimeEntry): Promise<RouterServiceStatus> {
		const child = entry.child;
		if (!child?.pid) return entry.status;
		entry.status.state = "stopping";
		try {
			await this.stopProcessTree({
				pid: child.pid,
				platform: this.platform,
				timeoutMs: entry.stopTimeoutMs,
				child,
			});
			entry.status = {
				...entry.status,
				state: "stopped",
				pid: null,
				stoppedAt: this.now().toISOString(),
				error: null,
			};
		} catch (error) {
			entry.status = {
				...entry.status,
				state: "failed",
				error: redactError(error),
			};
		}
		entry.child = null;
		return entry.status;
	}

	private captureOutput(entry: RuntimeEntry, child: ManagedChildProcess): void {
		const append = (chunk: Buffer | string) => {
			for (const line of String(chunk).split(/\r?\n/)) {
				if (!line) continue;
				entry.status.recentOutput.push(redactSensitiveText(line));
			}
			entry.status.recentOutput.splice(
				0,
				Math.max(0, entry.status.recentOutput.length - this.maxOutputLines),
			);
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
	}

	private trackExit(entry: RuntimeEntry, child: ManagedChildProcess): void {
		child.on("exit", (code, signal) => {
			if (entry.child !== child) return;
			entry.child = null;
			const expected = entry.status.state === "stopping";
			entry.status = {
				...entry.status,
				state: expected || code === 0 ? "stopped" : "failed",
				pid: null,
				exitCode: code,
				stoppedAt: this.now().toISOString(),
				error:
					expected || code === 0
						? null
						: `Process exited (${signal ?? `code ${code ?? "unknown"}`})`,
			};
		});
	}

	private requiredEntry(name: RouterServiceName): RuntimeEntry {
		const entry = this.entries.get(name);
		if (!entry) throw new Error(`Unknown router service: ${name}`);
		return entry;
	}
}

export interface CloudflaredStartOptions {
	targetUrl: string;
	tunnelToken?: string;
	executable?: string;
	extraArgs?: string[];
}

export interface TailscaleStartOptions {
	targetUrl: string;
	executable?: string;
	extraArgs?: string[];
}

export interface HeadroomStartOptions {
	port?: number;
	executable?: string;
	extraArgs?: string[];
	env?: NodeJS.ProcessEnv;
}

export function createCloudflaredAdapter(): RouterProcessAdapter<CloudflaredStartOptions> {
	return {
		name: "cloudflared",
		start(options) {
			if (!options?.targetUrl)
				throw new Error("cloudflared targetUrl is required");
			const args = options.tunnelToken
				? ["tunnel", "run", "--token", options.tunnelToken]
				: ["tunnel", "--no-autoupdate", "--url", options.targetUrl];
			return {
				command: options.executable ?? "cloudflared",
				args: [...args, ...(options.extraArgs ?? [])],
			};
		},
	};
}

export function createTailscaleAdapter(): RouterProcessAdapter<TailscaleStartOptions> {
	return {
		name: "tailscale",
		start(options) {
			if (!options?.targetUrl)
				throw new Error("tailscale targetUrl is required");
			return {
				command: options.executable ?? "tailscale",
				args: ["serve", options.targetUrl, ...(options.extraArgs ?? [])],
			};
		},
	};
}

export function createHeadroomAdapter(): RouterProcessAdapter<HeadroomStartOptions> {
	return {
		name: "headroom",
		start(options = {}) {
			const port = options.port ?? 8787;
			if (!Number.isInteger(port) || port < 1 || port > 65_535) {
				throw new Error("headroom port must be between 1 and 65535");
			}
			return {
				command: options.executable ?? "headroom",
				args: ["proxy", "--port", String(port), ...(options.extraArgs ?? [])],
				env: options.env,
			};
		},
	};
}

export function createDefaultAgentRouterServiceRegistry(
	options: AgentRouterServiceRegistryOptions = {},
): AgentRouterServiceRegistry {
	return new AgentRouterServiceRegistry(options)
		.register(createCloudflaredAdapter())
		.register(createTailscaleAdapter())
		.register(createHeadroomAdapter());
}

export type RelayDeployState = "idle" | "deploying" | "deployed" | "failed";

export interface RelayDeployResult {
	url: string;
	deploymentId?: string;
	metadata?: Record<string, unknown>;
}

export interface RelayDeployStatus {
	provider: string;
	state: RelayDeployState;
	url: string | null;
	deploymentId: string | null;
	error: string | null;
	updatedAt: string | null;
	metadata: Record<string, unknown>;
}

export interface RelayDeployAdapter<TOptions = unknown> {
	readonly provider: string;
	deploy(options: TOptions, signal: AbortSignal): Promise<RelayDeployResult>;
	remove?(deploymentId: string | null, signal: AbortSignal): Promise<void>;
	status?(
		deploymentId: string | null,
		signal: AbortSignal,
	): Promise<Partial<RelayDeployResult>>;
}

export class RelayDeployRegistry {
	private readonly adapters = new Map<string, RelayDeployAdapter<unknown>>();
	private readonly statuses = new Map<string, RelayDeployStatus>();
	private readonly now: () => Date;

	constructor(now: () => Date = () => new Date()) {
		this.now = now;
	}

	register<TOptions>(adapter: RelayDeployAdapter<TOptions>): this {
		if (!adapter.provider.trim()) throw new Error("Relay provider is required");
		if (this.adapters.has(adapter.provider)) {
			throw new Error(`Relay provider already registered: ${adapter.provider}`);
		}
		this.adapters.set(adapter.provider, adapter as RelayDeployAdapter<unknown>);
		this.statuses.set(adapter.provider, emptyRelayStatus(adapter.provider));
		return this;
	}

	async deploy<TOptions>(
		provider: string,
		options: TOptions,
		timeoutMs = 60_000,
	): Promise<RelayDeployStatus> {
		const adapter = this.requiredAdapter(provider);
		this.statuses.set(provider, {
			...this.status(provider),
			state: "deploying",
			error: null,
		});
		try {
			const result = await withAbortTimeout<Partial<RelayDeployResult>>(
				(signal) => adapter.deploy(options, signal),
				timeoutMs,
				`Relay deploy timed out after ${normalizeTimeout(timeoutMs, 60_000)}ms`,
			);
			const deployedUrl = result.url;
			if (!deployedUrl || !isHttpUrl(deployedUrl))
				throw new Error("Relay returned an invalid URL");
			const status: RelayDeployStatus = {
				provider,
				state: "deployed",
				url: redactUrl(deployedUrl),
				deploymentId: redactSensitiveText(result.deploymentId ?? "") || null,
				error: null,
				updatedAt: this.now().toISOString(),
				metadata: redactSensitiveValue(result.metadata ?? {}) as Record<
					string,
					unknown
				>,
			};
			this.statuses.set(provider, status);
			return cloneRelayStatus(status);
		} catch (error) {
			const status = {
				...this.status(provider),
				state: "failed" as const,
				error: redactError(error),
				updatedAt: this.now().toISOString(),
			};
			this.statuses.set(provider, status);
			return cloneRelayStatus(status);
		}
	}

	async stop(provider: string, timeoutMs = 30_000): Promise<RelayDeployStatus> {
		const adapter = this.requiredAdapter(provider);
		const current = this.status(provider);
		if (adapter.remove) {
			try {
				await withAbortTimeout(
					(signal) =>
						adapter.remove?.(current.deploymentId, signal) ?? Promise.resolve(),
					timeoutMs,
					`Relay removal timed out after ${normalizeTimeout(timeoutMs, 30_000)}ms`,
				);
			} catch (error) {
				const failed = {
					...current,
					state: "failed" as const,
					error: redactError(error),
				};
				this.statuses.set(provider, failed);
				return cloneRelayStatus(failed);
			}
		}
		const stopped = emptyRelayStatus(provider);
		stopped.updatedAt = this.now().toISOString();
		this.statuses.set(provider, stopped);
		return cloneRelayStatus(stopped);
	}

	async refresh(
		provider: string,
		timeoutMs = 10_000,
	): Promise<RelayDeployStatus> {
		const adapter = this.requiredAdapter(provider);
		if (!adapter.status) return this.status(provider);
		try {
			const result = await withAbortTimeout<Partial<RelayDeployResult>>(
				(signal) =>
					adapter.status?.(this.status(provider).deploymentId, signal) ??
					Promise.resolve({}),
				timeoutMs,
				`Relay status timed out after ${normalizeTimeout(timeoutMs, 10_000)}ms`,
			);
			const current = this.status(provider);
			const updated = {
				...current,
				url: result.url ? redactUrl(result.url) : current.url,
				deploymentId: result.deploymentId ?? current.deploymentId,
				metadata: redactSensitiveValue({
					...current.metadata,
					...result.metadata,
				}) as Record<string, unknown>,
				updatedAt: this.now().toISOString(),
			};
			this.statuses.set(provider, updated);
			return cloneRelayStatus(updated);
		} catch (error) {
			return { ...this.status(provider), error: redactError(error) };
		}
	}

	status(provider: string): RelayDeployStatus {
		this.requiredAdapter(provider);
		return cloneRelayStatus(
			this.statuses.get(provider) ?? emptyRelayStatus(provider),
		);
	}

	private requiredAdapter(provider: string): RelayDeployAdapter<unknown> {
		const adapter = this.adapters.get(provider);
		if (!adapter) throw new Error(`Unknown relay provider: ${provider}`);
		return adapter;
	}
}

export const PRIVILEGED_ROUTER_OPERATIONS = [
	"mitm-start",
	"mitm-stop",
	"certificate-install",
	"certificate-remove",
	"dns-configure",
	"dns-restore",
] as const;
export type PrivilegedRouterOperation =
	(typeof PRIVILEGED_ROUTER_OPERATIONS)[number];

export interface PrivilegedOperationConsent {
	granted: true;
	consentId: string;
	grantedAt: string;
	operation: PrivilegedRouterOperation;
}

export interface PrivilegedOperationRequest<TPayload = unknown> {
	operation: PrivilegedRouterOperation;
	reason: string;
	payload: TPayload;
	consent: PrivilegedOperationConsent;
}

export interface PrivilegedOperationResult {
	ok: boolean;
	changed: boolean;
	message: string;
}

export interface PrivilegedOperationExecutor {
	execute<TPayload>(
		request: PrivilegedOperationRequest<TPayload>,
		signal: AbortSignal,
	): Promise<PrivilegedOperationResult>;
}

export const PRIVILEGED_OPERATION_CONTRACT = Object.freeze({
	requiresExplicitConsent: true,
	requiresAdministrator: true,
	operations: PRIVILEGED_ROUTER_OPERATIONS,
	mutatesSystemTrust: ["certificate-install", "certificate-remove"],
	mutatesDns: ["dns-configure", "dns-restore"],
	defaultExecutor: "none",
});

export async function executePrivilegedRouterOperation<TPayload>(
	request: PrivilegedOperationRequest<TPayload>,
	executor?: PrivilegedOperationExecutor,
	timeoutMs = 30_000,
): Promise<PrivilegedOperationResult> {
	validatePrivilegedRequest(request);
	if (!executor) {
		throw new Error(
			"Privileged router operation requires an explicitly configured executor",
		);
	}
	return withAbortTimeout(
		(signal) => executor.execute(request, signal),
		timeoutMs,
		`Privileged operation timed out after ${normalizeTimeout(timeoutMs, 30_000)}ms`,
	);
}

export function redactSensitiveText(value: string): string {
	return value
		.replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, `$1 ${REDACTED}`)
		.replace(
			/((?:api[_-]?key|token|secret|password|authorization|cookie|credential)\s*[=:]\s*)([^\s,;]+)/gi,
			`$1${REDACTED}`,
		)
		.replace(/([?&](?:token|key|secret|password)=)[^&#\s]+/gi, `$1${REDACTED}`);
}

export function redactSensitiveValue(value: unknown): unknown {
	if (typeof value === "string") return redactSensitiveText(value);
	if (Array.isArray(value)) return value.map(redactSensitiveValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			isSensitiveKey(key) ? REDACTED : redactSensitiveValue(entry),
		]),
	);
}

function validatePrivilegedRequest(request: PrivilegedOperationRequest): void {
	if (!PRIVILEGED_ROUTER_OPERATIONS.includes(request.operation)) {
		throw new Error("Unsupported privileged router operation");
	}
	if (!request.reason?.trim())
		throw new Error("Privileged operation reason is required");
	const consent = request.consent;
	if (
		consent?.granted !== true ||
		!consent.consentId?.trim() ||
		consent.operation !== request.operation ||
		!Number.isFinite(Date.parse(consent.grantedAt))
	) {
		throw new Error("Explicit, operation-specific user consent is required");
	}
}

function waitForSpawn(
	child: ManagedChildProcess,
	timeoutMs: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			error ? reject(error) : resolve();
		};
		const timer = setTimeout(
			() => finish(new Error(`Service start timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
		child.on("spawn", () => finish());
		child.on("error", (error) => finish(error));
	});
}

async function withAbortTimeout<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	const controller = new AbortController();
	const normalized = normalizeTimeout(timeoutMs, 30_000);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error(message));
		}, normalized);
	});
	try {
		return await Promise.race([operation(controller.signal), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function defaultSpawnProcess(
	command: string,
	args: readonly string[],
	options: SpawnOptions,
): ManagedChildProcess {
	return spawn(command, [...args], options) as ManagedChildProcess;
}

async function defaultStopProcessTree({
	pid,
	platform,
	timeoutMs,
	child,
}: Parameters<StopProcessTree>[0]): Promise<void> {
	if (platform === "win32") {
		await execFileWithTimeout(
			"taskkill.exe",
			["/pid", String(pid), "/t", "/f"],
			timeoutMs,
		);
		return;
	}
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
	await new Promise<void>((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			if (settled) return;
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
			finish();
		}, timeoutMs);
		child.on("exit", finish);
	});
}

function execFileWithTimeout(
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{ windowsHide: true, timeout: timeoutMs },
			(error) => {
				if (error && (error as NodeJS.ErrnoException).code !== "ESRCH")
					reject(error);
				else resolve();
			},
		);
	});
}

function redactArguments(args: readonly string[]): string[] {
	let redactNext = false;
	return args.map((arg) => {
		if (redactNext) {
			redactNext = false;
			return REDACTED;
		}
		if (/^--?(?:token|api[-_]?key|secret|password|credential)$/i.test(arg)) {
			redactNext = true;
			return arg;
		}
		return redactSensitiveText(arg);
	});
}

function redactError(error: unknown): string {
	return redactSensitiveText(
		error instanceof Error ? error.message : String(error),
	);
}

function redactUrl(value: string): string {
	const url = new URL(value);
	url.username = url.username ? REDACTED : "";
	url.password = url.password ? REDACTED : "";
	for (const key of [...url.searchParams.keys()]) {
		if (isSensitiveKey(key)) url.searchParams.set(key, REDACTED);
	}
	return url.toString();
}

function isHttpUrl(value: string): boolean {
	try {
		return ["http:", "https:"].includes(new URL(value).protocol);
	} catch {
		return false;
	}
}

function isSensitiveKey(key: string): boolean {
	return /api.?key|token|secret|password|authorization|cookie|credential/i.test(
		key,
	);
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(
		MAX_TIMEOUT_MS,
		Math.max(MIN_TIMEOUT_MS, Math.floor(value ?? fallback)),
	);
}

function validateStartSpec(spec: ProcessStartSpec): void {
	if (!spec?.command?.trim()) throw new Error("Service command is required");
	if (spec.args?.some((arg) => typeof arg !== "string")) {
		throw new Error("Service arguments must be strings");
	}
}

function emptyServiceStatus(name: RouterServiceName): RouterServiceStatus {
	return {
		name,
		state: "stopped",
		pid: null,
		startedAt: null,
		stoppedAt: null,
		exitCode: null,
		error: null,
		command: null,
		args: [],
		recentOutput: [],
	};
}

function cloneStatus(status: RouterServiceStatus): RouterServiceStatus {
	return {
		...status,
		args: [...status.args],
		recentOutput: [...status.recentOutput],
	};
}

function emptyRelayStatus(provider: string): RelayDeployStatus {
	return {
		provider,
		state: "idle",
		url: null,
		deploymentId: null,
		error: null,
		updatedAt: null,
		metadata: {},
	};
}

function cloneRelayStatus(status: RelayDeployStatus): RelayDeployStatus {
	return { ...status, metadata: { ...status.metadata } };
}
