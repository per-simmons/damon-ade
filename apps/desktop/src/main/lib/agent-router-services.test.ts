import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type {
	ManagedChildProcess,
	PrivilegedOperationExecutor,
	SpawnProcess,
} from "./agent-router-services";
import {
	AgentRouterServiceRegistry,
	createCloudflaredAdapter,
	createDefaultAgentRouterServiceRegistry,
	executePrivilegedRouterOperation,
	PRIVILEGED_OPERATION_CONTRACT,
	RelayDeployRegistry,
	redactSensitiveValue,
} from "./agent-router-services";

class FakeChild extends EventEmitter implements ManagedChildProcess {
	pid: number | undefined = 4242;
	stdout = new PassThrough();
	stderr = new PassThrough();
	killCalls: Array<NodeJS.Signals | number | undefined> = [];

	kill(signal?: NodeJS.Signals | number): boolean {
		this.killCalls.push(signal);
		return true;
	}
}

function fakeSpawner(child: FakeChild, calls: unknown[][] = []): SpawnProcess {
	return (command, args, options) => {
		calls.push([command, args, options]);
		queueMicrotask(() => child.emit("spawn"));
		return child;
	};
}

describe("AgentRouterServiceRegistry", () => {
	it("registers the built-in services and starts a process without a shell", async () => {
		const child = new FakeChild();
		const calls: unknown[][] = [];
		const registry = createDefaultAgentRouterServiceRegistry({
			spawnProcess: fakeSpawner(child, calls),
		});

		expect(registry.list().map((item) => item.name)).toEqual([
			"cloudflared",
			"tailscale",
			"headroom",
		]);
		const status = await registry.start("cloudflared", {
			targetUrl: "http://127.0.0.1:3189",
		});

		expect(status.state).toBe("running");
		expect(status.pid).toBe(4242);
		expect(calls[0]?.[0]).toBe("cloudflared");
		expect(calls[0]?.[1]).toEqual([
			"tunnel",
			"--no-autoupdate",
			"--url",
			"http://127.0.0.1:3189",
		]);
		expect((calls[0]?.[2] as { shell: boolean }).shell).toBe(false);
		expect((calls[0]?.[2] as { windowsHide: boolean }).windowsHide).toBe(true);
	});

	it("coalesces concurrent starts and safely returns cloned status", async () => {
		const child = new FakeChild();
		let spawnCount = 0;
		const registry = new AgentRouterServiceRegistry({
			spawnProcess: (...args) => {
				spawnCount += 1;
				return fakeSpawner(child)(...args);
			},
		}).register(createCloudflaredAdapter());

		const [first, second] = await Promise.all([
			registry.start("cloudflared", { targetUrl: "http://localhost:1" }),
			registry.start("cloudflared", { targetUrl: "http://localhost:1" }),
		]);
		first.args.push("mutated");

		expect(spawnCount).toBe(1);
		expect(second.state).toBe("running");
		expect(registry.status("cloudflared").args).not.toContain("mutated");
	});

	it("redacts secrets in arguments, output, and errors", async () => {
		const child = new FakeChild();
		const registry = new AgentRouterServiceRegistry({
			spawnProcess: fakeSpawner(child),
		}).register(createCloudflaredAdapter());

		await registry.start("cloudflared", {
			targetUrl: "http://localhost:1",
			tunnelToken: "super-secret-token",
		});
		child.stderr.write("Authorization: Bearer abc123 token=visible-nope\n");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const status = registry.status("cloudflared");

		expect(status.args).toContain("[REDACTED]");
		expect(JSON.stringify(status)).not.toContain("super-secret-token");
		expect(JSON.stringify(status)).not.toContain("abc123");
		expect(JSON.stringify(status)).not.toContain("visible-nope");
	});

	it("bounds startup and cleans up a process that never emits spawn", async () => {
		const child = new FakeChild();
		let stoppedPid: number | null = null;
		const registry = new AgentRouterServiceRegistry({
			spawnProcess: () => child,
			stopProcessTree: async ({ pid }) => {
				stoppedPid = pid;
			},
		}).register({
			name: "slow",
			start: () => ({ command: "slow", startTimeoutMs: 10 }),
		});

		const status = await registry.start("slow", {});
		expect(status.state).toBe("failed");
		expect(status.error).toContain("timed out");
		expect(stoppedPid as unknown).toBe(4242);
	});

	it("uses the injected process-tree stop contract on Windows", async () => {
		const child = new FakeChild();
		const stops: Array<{ pid: number; platform: NodeJS.Platform }> = [];
		const registry = new AgentRouterServiceRegistry({
			platform: "win32",
			spawnProcess: fakeSpawner(child),
			stopProcessTree: async ({ pid, platform }) => {
				stops.push({ pid, platform });
			},
		}).register(createCloudflaredAdapter());

		await registry.start("cloudflared", { targetUrl: "http://localhost:1" });
		const status = await registry.stop("cloudflared");

		expect(stops).toEqual([{ pid: 4242, platform: "win32" }]);
		expect(status.state).toBe("stopped");
		expect(status.pid).toBeNull();
	});

	it("tracks unexpected exits", async () => {
		const child = new FakeChild();
		const registry = new AgentRouterServiceRegistry({
			spawnProcess: fakeSpawner(child),
		}).register(createCloudflaredAdapter());
		await registry.start("cloudflared", { targetUrl: "http://localhost:1" });

		child.emit("exit", 7, null);
		const status = registry.status("cloudflared");
		expect(status.state).toBe("failed");
		expect(status.exitCode).toBe(7);
	});
});

describe("RelayDeployRegistry", () => {
	it("deploys, reports status, redacts metadata, and removes relay adapters", async () => {
		let removed: string | null = null;
		const registry = new RelayDeployRegistry().register({
			provider: "cloudflare",
			deploy: async () => ({
				url: "https://relay.example.test/path?token=top-secret",
				deploymentId: "deploy-1",
				metadata: { apiKey: "hidden", region: "lhr" },
			}),
			remove: async (deploymentId) => {
				removed = deploymentId;
			},
		});

		const deployed = await registry.deploy("cloudflare", {});
		expect(deployed.state).toBe("deployed");
		expect(deployed.url).toContain("%5BREDACTED%5D");
		expect(deployed.metadata).toEqual({ apiKey: "[REDACTED]", region: "lhr" });

		const stopped = await registry.stop("cloudflare");
		expect(removed as unknown).toBe("deploy-1");
		expect(stopped.state).toBe("idle");
	});

	it("aborts and reports a bounded deploy timeout", async () => {
		let aborted = false;
		const registry = new RelayDeployRegistry().register({
			provider: "vercel",
			deploy: (_options, signal) =>
				new Promise((resolve) => {
					signal.addEventListener("abort", () => {
						aborted = true;
					});
					void resolve;
				}),
		});

		const status = await registry.deploy("vercel", {}, 10);
		expect(status.state).toBe("failed");
		expect(status.error).toContain("timed out");
		expect(aborted).toBe(true);
	});
});

describe("privileged MITM and certificate contract", () => {
	const request = {
		operation: "certificate-install" as const,
		reason: "Trust the local router certificate",
		payload: { certificatePath: "C:\\temp\\router-ca.pem" },
		consent: {
			granted: true as const,
			consentId: "dialog-approval-1",
			grantedAt: "2026-07-10T10:00:00.000Z",
			operation: "certificate-install" as const,
		},
	};

	it("documents that privileged changes require admin and explicit consent", () => {
		expect(PRIVILEGED_OPERATION_CONTRACT.requiresAdministrator).toBe(true);
		expect(PRIVILEGED_OPERATION_CONTRACT.requiresExplicitConsent).toBe(true);
		expect(PRIVILEGED_OPERATION_CONTRACT.defaultExecutor).toBe("none");
	});

	it("never executes when consent is missing or for a different operation", async () => {
		let calls = 0;
		const executor: PrivilegedOperationExecutor = {
			execute: async () => {
				calls += 1;
				return { ok: true, changed: true, message: "done" };
			},
		};
		const mismatched = {
			...request,
			consent: { ...request.consent, operation: "dns-configure" as const },
		};

		await expect(
			executePrivilegedRouterOperation(mismatched, executor),
		).rejects.toThrow("consent");
		expect(calls).toBe(0);
	});

	it("requires an explicit executor and delegates only after validation", async () => {
		await expect(executePrivilegedRouterOperation(request)).rejects.toThrow(
			"explicitly configured executor",
		);

		let seenOperation = "";
		const result = await executePrivilegedRouterOperation(request, {
			execute: async (validated) => {
				seenOperation = validated.operation;
				return { ok: true, changed: true, message: "installed" };
			},
		});
		expect(seenOperation).toBe("certificate-install");
		expect(result.changed).toBe(true);
	});

	it("recursively redacts sensitive diagnostic values", () => {
		expect(
			redactSensitiveValue({
				token: "abc",
				nested: { password: "xyz", ok: 1 },
			}),
		).toEqual({
			token: "[REDACTED]",
			nested: { password: "[REDACTED]", ok: 1 },
		});
	});
});
