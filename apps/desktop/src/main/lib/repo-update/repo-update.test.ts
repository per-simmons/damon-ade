import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastForward, remoteStatus } from "./repo-update";

const git = Bun.which("git");
const root = mkdtempSync(join(tmpdir(), "ade-repo-update-"));

function sh(cwd: string, ...args: string[]) {
	const result = spawnSync(git as string, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

let n = 0;
/** A remote, the user's clone, and a teammate's clone that pushes to it. */
function setup() {
	n++;
	const remote = join(root, `remote-${n}.git`);
	sh(root, "init", "-q", "--bare", "-b", "main", remote);
	const seed = join(root, `seed-${n}`);
	sh(root, "clone", "-q", remote, seed);
	for (const dir of [seed]) {
		sh(dir, "config", "user.email", "t@example.com");
		sh(dir, "config", "user.name", "T");
	}
	sh(seed, "checkout", "-q", "-b", "main");
	writeFileSync(join(seed, "app.js"), "v1\n");
	sh(seed, "add", "-A");
	sh(seed, "commit", "-qm", "v1");
	sh(seed, "push", "-q", "-u", "origin", "main");
	const mine = join(root, `mine-${n}`);
	sh(root, "clone", "-q", remote, mine);
	sh(mine, "config", "user.email", "me@example.com");
	sh(mine, "config", "user.name", "Me");
	const pushUpstream = (file: string, text: string) => {
		writeFileSync(join(seed, file), text);
		sh(seed, "add", "-A");
		sh(seed, "commit", "-qm", `change ${file}`);
		sh(seed, "push", "-q");
	};
	return { remote, mine, pushUpstream };
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** File text with line endings normalized (git may check out CRLF on Windows). */
const text = (path: string) =>
	readFileSync(path, "utf8").replaceAll("\r\n", "\n");

describe.if(git !== null)("update from the remote", () => {
	it("reports behind after a fetch and fast-forwards", () => {
		const { mine, pushUpstream } = setup();
		expect(remoteStatus(mine, { fetch: true })).toMatchObject({
			branch: "main",
			upstream: "origin/main",
			ahead: 0,
			behind: 0,
			blocked: null,
		});
		pushUpstream("app.js", "v2\n");
		pushUpstream("README.md", "hi\n");
		// Without a fetch the checkout does not know yet.
		expect(remoteStatus(mine, { fetch: false }).behind).toBe(0);
		const status = remoteStatus(mine, { fetch: true });
		expect(status).toMatchObject({ behind: 2, fetched: true, blocked: null });

		const result = fastForward(mine);
		expect(result).toMatchObject({ outcome: "updated", commits: 2 });
		expect(text(join(mine, "app.js"))).toBe("v2\n");
		expect(fastForward(mine)).toEqual({ outcome: "up-to-date" });
	});

	it("never touches uncommitted work", () => {
		const { mine, pushUpstream } = setup();
		pushUpstream("app.js", "v2\n");
		writeFileSync(join(mine, "app.js"), "my edit\n");
		const result = fastForward(mine);
		expect(result.outcome).toBe("blocked");
		expect(result.outcome === "blocked" && result.reason).toContain(
			"uncommitted changes",
		);
		expect(readFileSync(join(mine, "app.js"), "utf8")).toBe("my edit\n");
	});

	it("leaves diverged branches to the user", () => {
		const { mine, pushUpstream } = setup();
		pushUpstream("app.js", "v2\n");
		writeFileSync(join(mine, "local.txt"), "mine\n");
		sh(mine, "add", "-A");
		sh(mine, "commit", "-qm", "local work");
		const head = sh(mine, "rev-parse", "HEAD");
		const result = fastForward(mine);
		expect(result.outcome === "blocked" && result.reason).toContain(
			"1 local commit(s)",
		);
		expect(sh(mine, "rev-parse", "HEAD")).toBe(head);
		// Local commits alone are not "behind": nothing to update.
		const ahead = setup();
		writeFileSync(join(ahead.mine, "x.txt"), "x\n");
		sh(ahead.mine, "add", "-A");
		sh(ahead.mine, "commit", "-qm", "x");
		expect(remoteStatus(ahead.mine, { fetch: true })).toMatchObject({
			ahead: 1,
			behind: 0,
			blocked: null,
		});
	});

	it("explains a branch without upstream, a detached HEAD and an unreachable remote", () => {
		const { mine } = setup();
		sh(mine, "checkout", "-q", "-b", "feature");
		expect(fastForward(mine)).toEqual({
			outcome: "blocked",
			reason: "Branch feature does not track a remote branch",
		});
		sh(mine, "checkout", "-q", "--detach");
		expect(remoteStatus(mine, { fetch: false }).blocked).toContain(
			"detached HEAD",
		);
		sh(mine, "checkout", "-q", "main");
		sh(mine, "remote", "set-url", "origin", join(root, "no-such-remote.git"));
		const status = remoteStatus(mine, { fetch: true });
		expect(status.fetched).toBe(false);
		expect(status.fetchError).toBeTruthy();
		const result = fastForward(mine);
		expect(result.outcome === "blocked" && result.reason).toContain(
			"Could not reach the remote",
		);
	});

	it("refuses when git itself would overwrite an untracked file", () => {
		const { mine, pushUpstream } = setup();
		pushUpstream("new.txt", "theirs\n");
		writeFileSync(join(mine, "new.txt"), "mine, untracked\n");
		const result = fastForward(mine);
		expect(result.outcome).toBe("blocked");
		expect(readFileSync(join(mine, "new.txt"), "utf8")).toBe(
			"mine, untracked\n",
		);
	});
});
