import { spawnSync } from "node:child_process";

const result = spawnSync(
	process.execPath,
	["x", "biome", "check", ...process.argv.slice(2)],
	{
		encoding: "utf8",
	},
);

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(output);

if (/Found \d+ (error|info|warning)/.test(output)) {
	process.exit(1);
}

if (result.error) {
	console.error(result.error);
	process.exit(1);
}

process.exit(result.status ?? 0);
