import fs from "node:fs";
import path from "node:path";
import { env } from "shared/env.shared";
import { HOOKS_DIR } from "./paths";
import { findRealBinary } from "./utils";

const IS_WINDOWS = process.platform === "win32";

// notify.sh stays the canonical script on every platform — the codex wrapper,
// opencode plugin, and mastra hooks all invoke it through bash (which exists
// on Windows only as Git Bash, but those templates are bash-based anyway).
// Windows additionally gets notify.mjs, a Node port used where bash can't be
// assumed: the Claude Code --settings hooks, which run through cmd.exe.
export const NOTIFY_SCRIPT_NAME = "notify.sh";
export const WINDOWS_NOTIFY_SCRIPT_NAME = "notify.mjs";
export const NOTIFY_SCRIPT_MARKER = "# Superset agent notification hook";

const NOTIFY_SCRIPT_TEMPLATE_PATH = path.join(
	__dirname,
	"templates",
	"notify-hook.template.sh",
);
const WINDOWS_NOTIFY_SCRIPT_TEMPLATE_PATH = path.join(
	__dirname,
	"templates",
	"notify-hook.template.mjs",
);

function writeFileIfChanged(
	filePath: string,
	content: string,
	mode: number,
): boolean {
	const existing = fs.existsSync(filePath)
		? fs.readFileSync(filePath, "utf-8")
		: null;
	if (existing === content) {
		try {
			fs.chmodSync(filePath, mode);
		} catch {
			// Best effort.
		}
		return false;
	}

	fs.writeFileSync(filePath, content, { mode });
	return true;
}

export function getNotifyScriptPath(): string {
	return path.join(HOOKS_DIR, NOTIFY_SCRIPT_NAME);
}

export function getWindowsNotifyScriptPath(): string {
	return path.join(HOOKS_DIR, WINDOWS_NOTIFY_SCRIPT_NAME);
}

let cachedNodeBinary: string | null | undefined;

function getNodeBinary(): string | null {
	if (cachedNodeBinary === undefined) {
		cachedNodeBinary = findRealBinary("node");
	}
	return cachedNodeBinary;
}

/**
 * The full hook command string Claude Code should run to fire the notify hook.
 *
 * On Unix the script is directly executable (shebang + 0o755). On Windows,
 * Claude Code executes hook commands via cmd.exe, which can't run a shebang
 * script — so the command runs the Node port through an absolute node path.
 * Returns null on Windows when no Node binary can be found (hooks are then
 * omitted rather than broken).
 */
export function getNotifyHookCommand(): string | null {
	if (!IS_WINDOWS) return getNotifyScriptPath();

	const node = getNodeBinary();
	if (!node) {
		console.warn(
			"[agent-setup] Node not found on PATH — agent lifecycle hooks are disabled. " +
				"Install Node.js to enable agent status notifications.",
		);
		return null;
	}
	return `"${node}" "${getWindowsNotifyScriptPath()}"`;
}

function renderTemplate(templatePath: string): string {
	const template = fs.readFileSync(templatePath, "utf-8");
	return template
		.replaceAll("{{MARKER}}", NOTIFY_SCRIPT_MARKER)
		.replaceAll("{{DEFAULT_PORT}}", String(env.DESKTOP_NOTIFICATIONS_PORT));
}

export function getNotifyScriptContent(): string {
	return renderTemplate(NOTIFY_SCRIPT_TEMPLATE_PATH);
}

export function createNotifyScript(): void {
	const changed = writeFileIfChanged(
		getNotifyScriptPath(),
		getNotifyScriptContent(),
		0o755,
	);
	console.log(`[agent-setup] ${changed ? "Updated" : "Verified"} notify hook`);

	if (IS_WINDOWS) {
		const changedMjs = writeFileIfChanged(
			getWindowsNotifyScriptPath(),
			renderTemplate(WINDOWS_NOTIFY_SCRIPT_TEMPLATE_PATH),
			0o755,
		);
		console.log(
			`[agent-setup] ${changedMjs ? "Updated" : "Verified"} Windows notify hook`,
		);
	}
}
