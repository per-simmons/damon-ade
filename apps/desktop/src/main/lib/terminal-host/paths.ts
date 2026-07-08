import { homedir } from "node:os";
import { join } from "node:path";
import { SUPERSET_DIR_NAME } from "shared/constants";

export const SUPERSET_HOME_DIR = join(homedir(), SUPERSET_DIR_NAME);
export const TERMINAL_HOST_USES_NAMED_PIPE = process.platform === "win32";

function getNamedPipePath(): string {
	const pipeName = SUPERSET_DIR_NAME.replace(/[^a-zA-Z0-9_.-]/g, "-");
	return `\\\\.\\pipe\\${pipeName}-terminal-host`;
}

export const SOCKET_PATH = TERMINAL_HOST_USES_NAMED_PIPE
	? getNamedPipePath()
	: join(SUPERSET_HOME_DIR, "terminal-host.sock");
export const TOKEN_PATH = join(SUPERSET_HOME_DIR, "terminal-host.token");
export const PID_PATH = join(SUPERSET_HOME_DIR, "terminal-host.pid");
export const SPAWN_LOCK_PATH = join(
	SUPERSET_HOME_DIR,
	"terminal-host.spawn.lock",
);
export const SCRIPT_MTIME_PATH = join(SUPERSET_HOME_DIR, "terminal-host.mtime");
