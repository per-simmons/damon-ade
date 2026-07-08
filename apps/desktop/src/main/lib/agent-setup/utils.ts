import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultShell } from "../terminal/env";

/**
 * Finds all paths for a binary on Unix systems using the login shell.
 */
function findBinaryPathsUnix(name: string): string[] {
	const shell = getDefaultShell();
	const result = execFileSync(
		shell,
		["-l", "-c", 'which -a -- "$1"', "superset-find-binary", name],
		{
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
		},
	);
	return result.trim().split("\n").filter(Boolean);
}

/** Extensions cmd.exe/CreateProcess can execute directly, in PATHEXT order. */
const WINDOWS_EXECUTABLE_EXTENSIONS = [".com", ".exe", ".bat", ".cmd"];

/**
 * Finds all paths for a binary on Windows using where.exe.
 *
 * where.exe lists every matching file, including ones Windows can't execute —
 * for an npm-installed CLI it returns the extensionless POSIX sh shim before
 * the .cmd shim. Keep only directly-executable candidates, ordered
 * exe-ish-first, so callers embedding paths get something cmd.exe can run.
 */
function findBinaryPathsWindows(name: string): string[] {
	const result = execFileSync("where.exe", [name], {
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "ignore"],
	});
	const all = result.trim().split("\r\n").filter(Boolean);

	const rank = (p: string) =>
		WINDOWS_EXECUTABLE_EXTENSIONS.indexOf(path.extname(p).toLowerCase());
	const executables = all.filter((p) => rank(p) !== -1);

	// PATH directory order must dominate (like real PATHEXT resolution):
	// extension rank only breaks ties between files in the same directory.
	const dirOf = (p: string) => path.dirname(p).toLowerCase();
	const dirOrder: string[] = [];
	for (const p of executables) {
		const dir = dirOf(p);
		if (!dirOrder.includes(dir)) dirOrder.push(dir);
	}
	return executables.sort((a, b) => {
		const dirDelta = dirOrder.indexOf(dirOf(a)) - dirOrder.indexOf(dirOf(b));
		return dirDelta !== 0 ? dirDelta : rank(a) - rank(b);
	});
}

/** Marker substring present in every agent-wrapper header (see agent-wrappers-common). */
const WRAPPER_HEADER_NEEDLE = "agent-wrapper";

/** Whether the file looks like an agent-wrapper shim (ADE's or the user's Damon install). */
function isWrapperScript(filePath: string): boolean {
	try {
		const fd = fs.openSync(filePath, "r");
		try {
			const buffer = Buffer.alloc(512);
			const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);
			return buffer
				.toString("utf-8", 0, bytesRead)
				.includes(WRAPPER_HEADER_NEEDLE);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return false;
	}
}

/**
 * Finds the real path of a binary, skipping our wrapper scripts.
 * Filters out all superset bin directories (prod, dev, and workspace-specific)
 * to avoid wrapper scripts calling each other, plus any candidate whose header
 * marks it as an agent-wrapper (matching the bash resolver's content check).
 */
export function findRealBinary(name: string): string | null {
	try {
		const isWindows = process.platform === "win32";
		const allPaths = isWindows
			? findBinaryPathsWindows(name)
			: findBinaryPathsUnix(name);

		const homedir = os.homedir();
		// Filter out wrapper scripts from all ADE directories:
		// - ~/.ade/bin
		// - ~/.ade-*/bin (workspace-specific instances)
		// Normalize to forward slashes so the /bin/ check works with the
		// backslash-separated paths where.exe returns, and lowercase on Windows
		// where the filesystem (and thus PATH entries) are case-insensitive.
		const normalize = (p: string) => {
			const slashed = p.replaceAll("\\", "/");
			return isWindows ? slashed.toLowerCase() : slashed;
		};
		const supersetBinDir = normalize(path.join(homedir, ".ade", "bin"));
		const supersetPrefix = normalize(path.join(homedir, ".ade-"));
		const paths = allPaths.filter((p) => {
			if (!p) return false;
			const n = normalize(p);
			if (n.startsWith(supersetBinDir)) return false;
			if (n.startsWith(supersetPrefix) && n.includes("/bin/")) return false;
			// Binary formats (.exe/.com) can't be our text shims — skip the read.
			const ext = path.extname(p).toLowerCase();
			if (ext !== ".exe" && ext !== ".com" && isWrapperScript(p)) return false;
			return true;
		});
		return paths[0] || null;
	} catch {
		return null;
	}
}
