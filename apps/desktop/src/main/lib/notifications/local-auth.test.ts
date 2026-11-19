import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bearerToken,
	checkLocalRequest,
	clearLocalTokenCache,
	getLocalToken,
	isLocalHostHeader,
	localTokenPath,
	tokensMatch,
} from "./local-auth";

const home = mkdtempSync(join(tmpdir(), "ade-auth-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearLocalTokenCache());

const req = (headers: Record<string, string | undefined>) => ({ headers });

describe("local tokens", () => {
	it("creates a random private token once and reuses it", () => {
		const token = getLocalToken(home, "invoke");
		expect(token).toMatch(/^[a-f0-9]{64}$/);
		clearLocalTokenCache();
		expect(getLocalToken(home, "invoke")).toBe(token);
		expect(getLocalToken(home, "hook")).not.toBe(token);
		expect(readFileSync(localTokenPath(home, "invoke"), "utf8").trim()).toBe(
			token,
		);
		if (process.platform !== "win32") {
			expect(statSync(localTokenPath(home, "invoke")).mode & 0o077).toBe(0);
		}
	});

	it("compares tokens exactly", () => {
		expect(tokensMatch("abc", "abc")).toBe(true);
		expect(tokensMatch("abd", "abc")).toBe(false);
		expect(tokensMatch("ab", "abc")).toBe(false);
		expect(tokensMatch(undefined, "abc")).toBe(false);
		expect(bearerToken("Bearer xyz")).toBe("xyz");
		expect(bearerToken("Basic xyz")).toBeUndefined();
	});
});

describe("checkLocalRequest", () => {
	const host = "127.0.0.1:51741";

	it("requires the invoke token to start an agent", () => {
		const invoke = getLocalToken(home, "invoke");
		const hook = getLocalToken(home, "hook");
		expect(checkLocalRequest(req({ host }), home, ["invoke"])).toMatchObject({
			ok: false,
			status: 401,
		});
		// The hook token given to terminals cannot start agents.
		expect(
			checkLocalRequest(req({ host, authorization: `Bearer ${hook}` }), home, [
				"invoke",
			]).ok,
		).toBe(false);
		expect(
			checkLocalRequest(
				req({ host, authorization: `Bearer ${invoke}` }),
				home,
				["invoke"],
			).ok,
		).toBe(true);
	});

	it("refuses browsers and DNS-rebound hosts even with a token", () => {
		const invoke = getLocalToken(home, "invoke");
		const auth = `Bearer ${invoke}`;
		expect(
			checkLocalRequest(
				req({ host, authorization: auth, origin: "https://evil.example" }),
				home,
				["invoke"],
			),
		).toMatchObject({ ok: false, status: 403 });
		expect(
			checkLocalRequest(
				req({ host: "evil.example:51741", authorization: auth }),
				home,
				["invoke"],
			),
		).toMatchObject({ ok: false, status: 403 });
		expect(isLocalHostHeader("localhost:1")).toBe(true);
		expect(isLocalHostHeader("[::1]:1")).toBe(true);
		expect(isLocalHostHeader("127.0.0.1.evil.example")).toBe(false);
	});
});
