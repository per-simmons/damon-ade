import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * syncAgentWorkflowFiles over a stubbed agent list: which agents it touches,
 * which it skips, and that a second launch is a no-op.
 */

const ROOT = mkdtempSync(join(tmpdir(), "ade-workflow-sync-"));
const worktreeOf = (id: string) => join(ROOT, id, "worktree");

// A pre-workflow agent with a git repo and the old bridge files.
const OLD = "sync-old";
// No git repo yet (still initializing): skipped.
const NO_REPO = "sync-norepo";
// Being deleted: skipped.
const DELETING = "sync-deleting";
// Not an ADE agent (no runtime): skipped.
const PLAIN = "sync-plain";
// Its CLAUDE.md upgrade throws (a directory where a file is expected); the
// next agent must still be processed.
const BROKEN = "sync-broken";
// Processed after BROKEN.
const AFTER = "sync-after";

const rows = [
	{ id: OLD, runtime: "claude", deletingAt: null, worktreeId: null },
	{ id: NO_REPO, runtime: "claude", deletingAt: null, worktreeId: null },
	{ id: DELETING, runtime: "codex", deletingAt: Date.now(), worktreeId: null },
	{ id: PLAIN, runtime: null, deletingAt: null, worktreeId: null },
	{ id: BROKEN, runtime: "claude", deletingAt: null, worktreeId: null },
	{ id: AFTER, runtime: "codex", deletingAt: null, worktreeId: null },
];

function makeRepo(id: string): void {
	mkdirSync(join(worktreeOf(id), ".git", "info"), { recursive: true });
	mkdirSync(join(worktreeOf(id), ".claude"), { recursive: true });
	writeFileSync(
		join(worktreeOf(id), "CLAUDE.md"),
		"@memory/AGENT.md\n",
		"utf8",
	);
	writeFileSync(
		join(worktreeOf(id), ".claude", "settings.json"),
		`${JSON.stringify({ autoMemoryEnabled: true }, null, 2)}\n`,
		"utf8",
	);
}

let sync: (homeDir?: string) => unknown;

beforeAll(async () => {
	makeRepo(OLD);
	makeRepo(DELETING);
	makeRepo(PLAIN);
	makeRepo(BROKEN);
	makeRepo(AFTER);
	mkdirSync(worktreeOf(NO_REPO), { recursive: true });
	// Make BROKEN's agents dir a file so writing its subagents throws.
	writeFileSync(join(worktreeOf(BROKEN), ".claude", "agents"), "x", "utf8");

	mock.module("../local-db", () => ({
		localDb: {
			select: () => ({
				from: () => ({
					where: () => ({
						// The real query filters runtime IS NOT NULL; mirror that.
						all: () => rows.filter((row) => row.runtime !== null),
					}),
				}),
			}),
		},
	}));
	mock.module("../agent-worktree", () => ({
		resolveAgentWorktreePath: (id: string) => worktreeOf(id),
	}));
	delete process.env.ADE_MEMORY_SCAFFOLD;
	sync = (await import("./agent-workflow-sync")).syncAgentWorkflowFiles;
	sync(join(ROOT, "ade-home"));
});

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

const hasWorkflow = (id: string) =>
	existsSync(join(worktreeOf(id), ".claude", "agents", "planner.md"));

describe("syncAgentWorkflowFiles", () => {
	it("upgrades an agent created before the workflow", () => {
		expect(hasWorkflow(OLD)).toBe(true);
		const settings = JSON.parse(
			readFileSync(join(worktreeOf(OLD), ".claude", "settings.json"), "utf8"),
		);
		expect(settings.model).toBe("sonnet");
		expect(readFileSync(join(worktreeOf(OLD), "CLAUDE.md"), "utf8")).toContain(
			"/plan, then /build, then /review",
		);
	});

	it("skips agents without a repo, being deleted, or without a runtime", () => {
		expect(hasWorkflow(NO_REPO)).toBe(false);
		expect(hasWorkflow(DELETING)).toBe(false);
		expect(hasWorkflow(PLAIN)).toBe(false);
	});

	it("keeps going after one agent fails", () => {
		expect(hasWorkflow(AFTER)).toBe(true);
	});

	it("changes nothing on a second launch", () => {
		const files = [
			join(worktreeOf(OLD), "CLAUDE.md"),
			join(worktreeOf(OLD), ".claude", "settings.json"),
			join(worktreeOf(OLD), ".git", "info", "exclude"),
		];
		const before = files.map((file) => readFileSync(file, "utf8"));
		sync(join(ROOT, "ade-home"));
		expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
	});

	it("applies routing saved in workflow-settings.json on the next launch", () => {
		const home = join(ROOT, "ade-home");
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(home, "workflow-settings.json"),
			JSON.stringify({
				mainModel: "opus",
				roles: { implementer: { model: "claude-sonnet-5-5", maxTurns: 25 } },
			}),
			"utf8",
		);
		sync(home);

		const implementer = readFileSync(
			join(worktreeOf(OLD), ".claude", "agents", "implementer.md"),
			"utf8",
		);
		expect(implementer).toContain("model: claude-sonnet-5-5\n");
		expect(implementer).toContain("maxTurns: 25\n");
		expect(
			JSON.parse(
				readFileSync(join(worktreeOf(OLD), ".claude", "settings.json"), "utf8"),
			).model,
		).toBe("opus");
		// ADE records the main model it wrote.
		expect(
			JSON.parse(readFileSync(join(home, "workflow-settings.json"), "utf8"))
				.appliedMainModel,
		).toBe("opus");
	});
});
