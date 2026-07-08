#!/usr/bin/env bun
// Cross-platform equivalent of postinstall.sh (bash isn't reliably invocable
// as an executable on Windows — the bare `bash` on PATH there is often the
// WSL shim, not Git Bash, and runs in the wrong filesystem context).
//
// Prevent infinite recursion during postinstall: electron-builder
// install-app-deps can trigger nested bun installs, which would re-run
// postinstall, spawning hundreds of processes.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

if (process.env.SUPERSET_POSTINSTALL_RUNNING) {
	process.exit(0);
}

// bun patch converts a patched dependency (node-pty, for our Windows winpty
// fix) from a store symlink into a real copy, which drops its own nested
// node_modules/node-addon-api link. That breaks node-pty's binding.gyp
// (`require('node-addon-api').include_dir`) during the native rebuild below.
// Re-link it from bun's central store if missing.
function ensureNodeAddonApiLink(): void {
	const nodePtyModules = join("node_modules", "node-pty", "node_modules");
	const target = join(nodePtyModules, "node-addon-api");
	if (existsSync(target)) return;

	const storeDir = join(process.cwd(), "node_modules", ".bun");
	if (!existsSync(storeDir)) return;
	const storeEntry = readdirSync(storeDir).find((name) =>
		name.startsWith("node-addon-api@"),
	);
	if (!storeEntry) return;

	const source = join(storeDir, storeEntry, "node_modules", "node-addon-api");
	if (!existsSync(source)) return;

	mkdirSync(nodePtyModules, { recursive: true });
	symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
}

function run(cmd: string, args: string[]): void {
	const result = spawnSync(cmd, args, {
		stdio: "inherit",
		shell: process.platform === "win32",
		env: { ...process.env, SUPERSET_POSTINSTALL_RUNNING: "1" },
	});
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

// Run sherif for workspace validation (bun puts node_modules/.bin on PATH for lifecycle scripts)
run("sherif", []);

// Install native dependencies for desktop app
ensureNodeAddonApiLink();
run("bun", ["run", "--filter=@ade/desktop", "install:deps"]);
