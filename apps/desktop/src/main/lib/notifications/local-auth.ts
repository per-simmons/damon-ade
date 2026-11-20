import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Authentication for ADE's local HTTP server (127.0.0.1 only).
 *
 * Two random per-machine tokens, each in a file only the user can read:
 * - invoke-token: required to start an agent (POST /agent/invoke). ADE's own
 *   watcher reads it; an external trigger must read the file too.
 * - hook-token: given to ADE terminals as SUPERSET_HOOK_TOKEN. It lets the
 *   notify hook record usage and lets agents post to the feed
 *   (POST /agent/message); it cannot start agents.
 * - team-token: only in the Team chat session's MCP config file
 *   (<ADE home>/team-chat/*.mcp.json, 0600). It lets that Coordinator
 *   session start an agreed plan (POST /team-mcp/:workspaceId); every
 *   start is a tool call Claude Code asks the user to approve.
 *
 * Browsers are kept out by three checks: no CORS headers (so a page cannot
 * send a JSON POST), a Host check (so DNS rebinding cannot reach the server
 * under another name), and refusing any request with a browser Origin.
 */

export type LocalTokenKind = "invoke" | "hook" | "team";

const TOKEN_FILES: Record<LocalTokenKind, string> = {
	invoke: "invoke-token",
	hook: "hook-token",
	team: "team-token",
};

const cache = new Map<string, string>();

export function localTokenPath(homeDir: string, kind: LocalTokenKind): string {
	return join(homeDir, TOKEN_FILES[kind]);
}

/** Read the token, creating it (0600) on first use. */
export function getLocalToken(homeDir: string, kind: LocalTokenKind): string {
	const path = localTokenPath(homeDir, kind);
	const cached = cache.get(path);
	if (cached) return cached;
	let token = "";
	try {
		token = readFileSync(path, "utf8").trim();
	} catch {
		// Not created yet.
	}
	if (!/^[a-f0-9]{64}$/.test(token)) {
		token = randomBytes(32).toString("hex");
		mkdirSync(homeDir, { recursive: true });
		writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
		try {
			chmodSync(path, 0o600);
		} catch {
			// Best effort (no-op on Windows, where the profile folder is private).
		}
	}
	cache.set(path, token);
	return token;
}

/** For tests. */
export function clearLocalTokenCache(): void {
	cache.clear();
}

export function tokensMatch(
	presented: string | undefined,
	expected: string,
): boolean {
	if (!presented || !expected) return false;
	const a = Buffer.from(presented);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** The bearer token of an Authorization header, if any. */
export function bearerToken(
	header: string | string[] | undefined,
): string | undefined {
	const value = Array.isArray(header) ? header[0] : header;
	return value?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** True when the Host header names this machine (defeats DNS rebinding). */
export function isLocalHostHeader(host: string | undefined): boolean {
	if (!host) return false;
	const name = host.replace(/:\d+$/, "").toLowerCase();
	return LOCAL_HOSTS.has(name);
}

export interface LocalRequestLike {
	headers: Record<string, string | string[] | undefined>;
}

export type LocalAuthResult =
	| { ok: true }
	| { ok: false; status: 401 | 403; error: string };

/**
 * Check a request: local Host, no browser Origin, and (when `accept` is
 * given) a bearer token of one of those kinds.
 */
export function checkLocalRequest(
	req: LocalRequestLike,
	homeDir: string,
	accept: LocalTokenKind[],
): LocalAuthResult {
	const host = req.headers.host;
	if (!isLocalHostHeader(Array.isArray(host) ? host[0] : host)) {
		return { ok: false, status: 403, error: "Requests must address 127.0.0.1" };
	}
	if (req.headers.origin !== undefined) {
		return {
			ok: false,
			status: 403,
			error: "Browser requests are not accepted",
		};
	}
	if (accept.length === 0) return { ok: true };
	const presented = bearerToken(req.headers.authorization);
	for (const kind of accept) {
		if (tokensMatch(presented, getLocalToken(homeDir, kind)))
			return { ok: true };
	}
	return {
		ok: false,
		status: 401,
		error: `Missing or wrong token (send "Authorization: Bearer <token>" from ${accept
			.map((kind) => localTokenPath(homeDir, kind))
			.join(" or ")})`,
	};
}
