import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The real notifications server over HTTP on 127.0.0.1: no wildcard CORS,
 * browsers and foreign Host names refused, and starting an agent needs the
 * per-machine invoke token. No agent is started: the registry is empty, so an
 * authorized request ends at "Unknown agent".
 */

const home = mkdtempSync(join(tmpdir(), "ade-server-auth-"));
process.env.ADE_HOME_DIR = home;

mock.module("shared/env.shared", () => ({
	env: { DESKTOP_NOTIFICATIONS_PORT: 0, NODE_ENV: "test" },
	getWorkspaceName: () => undefined,
}));
mock.module("main/lib/agent-config/registry", () => ({
	getAgentEntry: () => undefined,
	loadAgentRegistry: () => ({}),
	getAgentByWorkspaceId: () => undefined,
	AGENT_REGISTRY_PATH: join(home, "registry.json"),
}));

let server: Server;
let base: string;
let invokeToken: string;
let hookToken: string;

beforeAll(async () => {
	const { notificationsApp } = await import("./server");
	const { getLocalToken } = await import("./local-auth");
	invokeToken = getLocalToken(home, "invoke");
	hookToken = getLocalToken(home, "hook");
	await new Promise<void>((resolve) => {
		server = notificationsApp.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
	server?.close();
	rmSync(home, { recursive: true, force: true });
});

const post = (path: string, headers: Record<string, string>, body: unknown) =>
	fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

describe("local server authentication", () => {
	it("sends no CORS headers, so a web page cannot read or preflight it", async () => {
		const preflight = await fetch(`${base}/agent/invoke`, {
			method: "OPTIONS",
			headers: { origin: "https://evil.example" },
		});
		expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
		expect(preflight.status).toBe(403);
	});

	it("refuses /agent/invoke without the invoke token", async () => {
		const none = await post("/agent/invoke", {}, { agent: "a", prompt: "x" });
		expect(none.status).toBe(401);
		const hook = await post(
			"/agent/invoke",
			{ authorization: `Bearer ${hookToken}` },
			{ agent: "a", prompt: "x" },
		);
		expect(hook.status).toBe(401);
	});

	it("refuses a browser request even with the token", async () => {
		const response = await post(
			"/agent/invoke",
			{
				authorization: `Bearer ${invokeToken}`,
				origin: "https://evil.example",
			},
			{ agent: "a", prompt: "x" },
		);
		expect(response.status).toBe(403);
	});

	it("accepts the invoke token (and then validates the request)", async () => {
		const response = await post(
			"/agent/invoke",
			{ authorization: `Bearer ${invokeToken}` },
			{ agent: "nobody", prompt: "x" },
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({
			error: "Unknown agent: nobody",
		});
	});

	it("needs a token for /agent/message too", async () => {
		const response = await post(
			"/agent/message",
			{},
			{ agent: "a", content: "x" },
		);
		expect(response.status).toBe(401);
	});

	it("still answers hooks and health checks from local tools", async () => {
		expect((await fetch(`${base}/health`)).status).toBe(200);
		const hook = await fetch(`${base}/hook/complete?eventType=Start`);
		expect(hook.status).toBe(200);
	});
});
