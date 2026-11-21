/**
 * Paths written into the hook scripts, wrapper scripts and agent configs.
 *
 * On macOS and Linux both functions return the path unchanged.
 *
 * On Windows the hooks and wrappers run under Git Bash and the paths also land
 * in JSON, TOML and JS strings, where a backslash is an escape (`\U` breaks
 * Codex's TOML, bash drops unquoted backslashes from a hook command). So:
 * - `forwardSlashPath`: C:/Users/me/.ade/hooks/notify.sh. Read correctly by
 *   bash, by native Windows programs and by Node, and needs no escaping.
 * - `bashPath`: /c/Users/me/.ade/bin. For PATH entries (a drive letter's colon
 *   would split PATH) and for comparing against entries of bash's own PATH.
 */
const IS_WINDOWS = process.platform === "win32";

export function forwardSlashPath(p: string): string {
	return IS_WINDOWS ? p.replaceAll("\\", "/") : p;
}

export function bashPath(p: string): string {
	if (!IS_WINDOWS) return p;
	return forwardSlashPath(p).replace(
		/^([A-Za-z]):(?=\/|$)/,
		(_, drive: string) => `/${drive.toLowerCase()}`,
	);
}
