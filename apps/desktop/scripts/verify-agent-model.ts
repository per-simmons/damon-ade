#!/usr/bin/env bun
/**
 * Verification harness for the ADE agent-fleet data model (Phase B).
 *
 * Writes a Category + Agent (with its own git repo) directly into the live
 * ~/.ade-default DB (via bun:sqlite raw SQL) using the REAL setupAgentRepo
 * helper for the repo mechanics, then asserts the on-disk repo + stored
 * runtime + cwd source. Run with the app NOT running. Temporary; not shipped.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Point app-environment at the real ADE data dir before importing helpers.
process.env.ADE_HOME_DIR = join(homedir(), ".ade-default");

import { Database } from "bun:sqlite";
import { setupAgentRepo } from "../src/main/lib/agent-repo";

const DB_PATH = join(process.env.ADE_HOME_DIR, "local.db");
const db = new Database(DB_PATH);
const now = Date.now();

function assert(cond: unknown, msg: string): void {
	if (!cond) {
		console.error(`FAIL: ${msg}`);
		process.exit(1);
	}
	console.log(`  ok: ${msg}`);
}

const categoryId = crypto.randomUUID();
const agentId = crypto.randomUUID();

async function main() {
	console.log(`DB: ${DB_PATH}`);

	// 1. Category (repo-less project) — main_repo_path "" sentinel, tab_order set.
	db.query(
		`INSERT INTO projects (id, main_repo_path, name, color, tab_order, last_opened_at, created_at)
		 VALUES (?, '', ?, '#8b5cf6', 999, ?, ?)`,
	).run(categoryId, "ADE Verify Category", now, now);
	console.log(`Category created: ${categoryId}`);

	// 2. Agent repo on disk via the REAL helper (git init + memory/ sibling).
	const { worktreePath, memoryDir, branch } = await setupAgentRepo({
		agentId,
		source: { type: "init" },
	});
	console.log(`Agent worktree: ${worktreePath} (branch ${branch})`);

	const worktreeId = crypto.randomUUID();
	db.query(
		`INSERT INTO worktrees (id, project_id, path, branch, base_branch, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	).run(worktreeId, categoryId, worktreePath, branch, branch, now);

	// 3. Agent (workspace) row with runtime.
	db.query(
		`INSERT INTO workspaces
		   (id, project_id, worktree_id, type, branch, name, runtime, tab_order,
		    created_at, updated_at, last_opened_at, is_unread, is_unnamed)
		 VALUES (?, ?, ?, 'worktree', ?, 'Verify Agent', 'claude', 0, ?, ?, ?, 0, 0)`,
	).run(agentId, categoryId, worktreeId, branch, now, now, now);

	// 4. Assertions.
	console.log("Assertions:");
	assert(existsSync(worktreePath), `worktree exists on disk: ${worktreePath}`);
	assert(
		existsSync(join(worktreePath, ".git")),
		"worktree is a git repo (.git present)",
	);
	assert(
		existsSync(memoryDir),
		`memory/ dir exists as sibling of worktree: ${memoryDir}`,
	);

	const gitBranch = execSync("git rev-parse --abbrev-ref HEAD", {
		cwd: worktreePath,
		encoding: "utf8",
	}).trim();
	assert(gitBranch === branch, `repo HEAD on '${branch}' (got '${gitBranch}')`);

	const row = db
		.query(
			`SELECT w.runtime, w.worktree_id, wt.path AS worktree_path
			 FROM workspaces w JOIN worktrees wt ON wt.id = w.worktree_id
			 WHERE w.id = ?`,
		)
		.get(agentId) as {
		runtime: string;
		worktree_id: string;
		worktree_path: string;
	};

	assert(
		row.runtime === "claude",
		`agent row runtime === 'claude' (got '${row.runtime}')`,
	);
	assert(row.worktree_id === worktreeId, "agent linked to its worktree row");
	// Terminal derives cwd from workspaceId -> worktrees.path (getWorkspacePath).
	assert(
		row.worktree_path === worktreePath,
		`terminal cwd source (worktrees.path) === worktree: ${row.worktree_path}`,
	);

	console.log(
		"\nPASS: category + agent created; standalone repo on disk; runtime stored; cwd resolves to worktree.",
	);
	console.log(
		'\nUI check: boot the app; category "ADE Verify Category" with agent "Verify Agent" should appear in the rail.',
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
