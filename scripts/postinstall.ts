/**
 * Root postinstall, in TypeScript so it runs the same on macOS, Linux and
 * Windows (the old postinstall.sh needed bash, which `bun install` cannot run
 * on Windows: "command not found: ./scripts/postinstall.sh").
 */
import { spawnSync } from "node:child_process";

// Prevent infinite recursion during postinstall:
// electron-builder install-app-deps can trigger nested bun installs,
// which would re-run postinstall and spawn hundreds of processes.
if (process.env.SUPERSET_POSTINSTALL_RUNNING) process.exit(0);

const env = { ...process.env, SUPERSET_POSTINSTALL_RUNNING: "1" };

function run(cmd: string, args: string[]) {
	const result = spawnSync(cmd, args, {
		stdio: "inherit",
		env,
		// Windows resolves bunx/bun shims (.cmd/.exe) only through a shell.
		shell: process.platform === "win32",
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

// Workspace validation
run("bunx", ["sherif"]);

// Native dependencies for the desktop app
run("bun", ["run", "--filter=@ade/desktop", "install:deps"]);
