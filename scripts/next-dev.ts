import { spawnSync } from "node:child_process";

const [envName, defaultPort] = process.argv.slice(2);

if (!envName || !defaultPort) {
	console.error(
		"Usage: bun run scripts/next-dev.ts <ENV_PORT_NAME> <defaultPort>",
	);
	process.exit(1);
}

const port = process.env[envName] || defaultPort;
const result = spawnSync("next", ["dev", "--port", port], {
	stdio: "inherit",
	shell: process.platform === "win32",
});

if (result.error) {
	console.error(result.error);
	process.exit(1);
}

process.exit(result.status ?? 0);
