import { spawnSync } from "node:child_process";

function run(command: string, args: string[]): void {
	const result = spawnSync(command, args, {
		stdio: "inherit",
		shell: process.platform === "win32",
	});

	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}

	if (result.error) {
		console.error(result.error);
		process.exit(1);
	}
}

if (process.env.SUPERSET_POSTINSTALL_RUNNING) {
	process.exit(0);
}

process.env.SUPERSET_POSTINSTALL_RUNNING = "1";

run("sherif", []);
run(process.execPath, ["run", "--filter=@ade/desktop", "install:deps"]);
