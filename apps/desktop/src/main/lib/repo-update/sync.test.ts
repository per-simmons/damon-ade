import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connectRemote,
	pushToUpstream,
	remoteStatus,
	syncWithRemote,
} from "./repo-update";

const git = Bun.which("git");
const root = mkdtempSync(join(tmpdir(), "ade-sync-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(cwd: string, ...args: string[]) {
	const r = spawnSync(git as string, args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(r.stderr);
	return r.stdout.trim();
}

let n = 0;
function localRepo(): string {
	const dir = join(root, `local-${++n}`);
	mkdirSync(dir);
	sh(dir, "init", "-q", "-b", "main");
	sh(dir, "config", "user.email", "t@example.com");
	sh(dir, "config", "user.name", "T");
	writeFileSync(join(dir, "a.txt"), "1\n");
	sh(dir, "add", "-A");
	sh(dir, "commit", "-qm", "1");
	return dir;
}
function bare(): string {
	const dir = join(root, `remote-${++n}.git`);
	sh(root, "init", "-q", "--bare", "-b", "main", dir);
	return dir;
}
function commit(dir: string, file: string) {
	writeFileSync(join(dir, file), `${file}\n`);
	sh(dir, "add", "-A");
	sh(dir, "commit", "-qm", file);
}

describe.if(git !== null)("keep local and GitHub the same", () => {
	it("connects an empty remote, pushes, then pulls and pushes both ways", () => {
		const local = localRepo();
		const remote = bare();
		// Local paths stand in for GitHub URLs here.
		expect(() => connectRemote(local, remote)).toThrow("https:// or git@");
		sh(local, "remote", "add", "origin", remote);
		const first = pushToUpstream(local);
		expect(first).toMatchObject({ outcome: "pushed", upstream: "origin/main" });
		expect(remoteStatus(local, { fetch: true })).toMatchObject({
			upstream: "origin/main",
			ahead: 0,
			behind: 0,
		});

		// Someone pushes on GitHub; meanwhile nothing local: sync pulls.
		const other = join(root, "other");
		sh(root, "clone", "-q", remote, other);
		sh(other, "config", "user.email", "o@example.com");
		sh(other, "config", "user.name", "O");
		commit(other, "theirs.txt");
		sh(other, "push", "-q");
		let result = syncWithRemote(local);
		expect(result.pull).toMatchObject({ outcome: "updated", commits: 1 });
		expect(result.inSync).toBe(true);
		expect(existsSync(join(local, "theirs.txt"))).toBe(true);

		// A local commit: sync pushes it.
		commit(local, "mine.txt");
		result = syncWithRemote(local);
		expect(result.push).toMatchObject({ outcome: "pushed", commits: 1 });
		expect(result.inSync).toBe(true);
		sh(other, "pull", "-q");
		expect(existsSync(join(other, "mine.txt"))).toBe(true);

		// Both changed: nothing is forced or merged.
		commit(other, "theirs2.txt");
		sh(other, "push", "-q");
		commit(local, "mine2.txt");
		const head = sh(local, "rev-parse", "HEAD");
		result = syncWithRemote(local);
		expect(result.inSync).toBe(false);
		const reasons = [result.pull, result.push]
			.map((r) => ("reason" in r ? r.reason : ""))
			.join(" ");
		expect(reasons).toContain("Merge or rebase it yourself");
		expect(sh(local, "rev-parse", "HEAD")).toBe(head);
		expect(sh(other, "ls-remote", "origin", "main").split(/\s+/)[0]).not.toBe(
			head,
		);
	}, 60_000);

	it("refuses a remote with an unrelated history and leaves no remote behind", () => {
		const local = localRepo();
		const unrelated = localRepo();
		// A different root commit (same content would give the same hash).
		sh(unrelated, "commit", "--amend", "-qm", "another project");
		const remote = bare();
		sh(unrelated, "remote", "add", "origin", remote);
		sh(unrelated, "push", "-q", "-u", "origin", "main");
		// connectRemote only accepts real URL forms; use file:// via git@-less https stand-in.
		const url = `https://example.invalid/${n}.git`;
		expect(() => connectRemote(local, url)).toThrow("Could not reach");
		expect(
			spawnSync(git as string, ["remote"], {
				cwd: local,
				encoding: "utf8",
			}).stdout.trim(),
		).toBe("");
		// With a reachable remote: insteadOf maps the URL to the local bare repo.
		sh(local, "config", `url.${remote.replace(/\\/g, "/")}.insteadOf`, url);
		expect(() => connectRemote(local, url)).toThrow("different history");
		expect(
			spawnSync(git as string, ["remote"], {
				cwd: local,
				encoding: "utf8",
			}).stdout.trim(),
		).toBe("");
	}, 60_000);

	it("connects a remote that shares history and starts tracking it", () => {
		const local = localRepo();
		const remote = bare();
		sh(local, "push", "-q", remote, "main");
		const url = `https://example.invalid/shared-${n}.git`;
		sh(local, "config", `url.${remote.replace(/\\/g, "/")}.insteadOf`, url);
		const result = connectRemote(local, url);
		expect(result).toMatchObject({
			tracking: "origin/main",
			remoteEmpty: false,
		});
		expect(() => connectRemote(local, url)).toThrow("Already connected");
	}, 60_000);
});
