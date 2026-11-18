/**
 * Where the terminal-host daemon listens, shared by the daemon and its client.
 *
 * macOS / Linux: a Unix domain socket file in the app's home dir
 * (~/.ade/terminal-host.sock), exactly as before.
 *
 * Windows: Unix socket files are not available to node:net there (listening on
 * one fails with EACCES), so the daemon listens on a named pipe instead. Pipe
 * names are machine-wide, so the name carries a hash of the home dir: dev,
 * worktree and production builds (each with their own home dir) and other
 * Windows users never share a pipe. The daemon's auth token still guards every
 * connection, as it does for the socket file.
 *
 * A named pipe is not a file: it cannot be chmod'ed or unlinked, it disappears
 * when the server closes, and probing it with fs calls is unreliable (opening
 * one can take a server instance). So on Windows `socketMayExist` answers true
 * and callers find out by connecting, which every caller already handles.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

export function terminalHostSocketPath(homeDir: string): string {
	if (!IS_WINDOWS) return join(homeDir, "terminal-host.sock");
	const id = createHash("sha256")
		.update(homeDir.toLowerCase())
		.digest("hex")
		.slice(0, 16);
	return `\\\\.\\pipe\\ade-terminal-host-${id}`;
}

/** False only when the socket file is known to be missing (never on Windows). */
export function socketMayExist(socketPath: string): boolean {
	return IS_WINDOWS || existsSync(socketPath);
}
