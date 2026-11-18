/**
 * Rebuild native modules for Electron's ABI.
 *
 * macOS and Linux keep the original `electron-builder install-app-deps`.
 *
 * Windows rebuilds better-sqlite3 only. Of the native modules here it is the
 * one built against V8 directly, so it needs a binary made for this Electron
 * (prebuild-install downloads one, no compiler needed). The rest ship N-API
 * prebuilds that load in any Electron: node-pty (prebuilds/win32-x64),
 * bufferutil and utf-8-validate (node-gyp-build), libsql and @ast-grep/napi
 * (per-platform packages). Rebuilding node-pty from source on Windows needs
 * Visual Studio's Spectre-mitigated libraries and the newest Windows SDK
 * (MSB8040 / MSB8036), which most machines do not have, and gains nothing.
 */
import { spawnSync } from "node:child_process";
import { rebuild } from "@electron/rebuild";
import pkg from "../package.json";

if (process.platform !== "win32") {
	const result = spawnSync("electron-builder", ["install-app-deps"], {
		stdio: "inherit",
	});
	process.exit(result.status ?? 1);
}

const electronVersion = pkg.devDependencies.electron.replace(/^\^/, "");
const arch = process.env.npm_config_arch || process.arch;
console.log(
	`Rebuilding better-sqlite3 for Electron ${electronVersion} (${arch})…`,
);
await rebuild({
	buildPath: process.cwd(),
	projectRootPath: new URL("../../..", import.meta.url).pathname.replace(
		/^\/([A-Za-z]:)/,
		"$1",
	),
	electronVersion,
	arch,
	onlyModules: ["better-sqlite3"],
	force: true,
	mode: "sequential",
	disablePreGypCopy: true,
});
console.log("Done.");
