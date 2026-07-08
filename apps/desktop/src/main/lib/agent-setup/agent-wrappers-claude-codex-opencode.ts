import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	buildWrapperScript,
	createWindowsCmdWrapper,
	createWrapper,
	writeFileIfChanged,
} from "./agent-wrappers-common";
import { getNotifyHookCommand, getNotifyScriptPath } from "./notify-hook";
import { HOOKS_DIR, OPENCODE_CONFIG_DIR, OPENCODE_PLUGIN_DIR } from "./paths";

export const CLAUDE_SETTINGS_FILE = "claude-settings.json";
export const OPENCODE_PLUGIN_FILE = "superset-notify.js";

const OPENCODE_PLUGIN_SIGNATURE = "// Superset opencode plugin";
const OPENCODE_PLUGIN_VERSION = "v8";
export const OPENCODE_PLUGIN_MARKER = `${OPENCODE_PLUGIN_SIGNATURE} ${OPENCODE_PLUGIN_VERSION}`;

const OPENCODE_PLUGIN_TEMPLATE_PATH = path.join(
	__dirname,
	"templates",
	"opencode-plugin.template.js",
);
const CODEX_WRAPPER_EXEC_TEMPLATE_PATH = path.join(
	__dirname,
	"templates",
	"codex-wrapper-exec.template.sh",
);

export function getClaudeSettingsPath(): string {
	return path.join(HOOKS_DIR, CLAUDE_SETTINGS_FILE);
}

export function getOpenCodePluginPath(): string {
	return path.join(OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN_FILE);
}

/** @see https://opencode.ai/docs/plugins */
export function getOpenCodeGlobalPluginPath(): string {
	const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
	const configHome = xdgConfigHome?.length
		? xdgConfigHome
		: path.join(os.homedir(), ".config");
	return path.join(configHome, "opencode", "plugin", OPENCODE_PLUGIN_FILE);
}

export function getClaudeSettingsContent(notifyCommand: string | null): string {
	// No runnable hook command (Windows without Node): write empty hooks so the
	// --settings injection stays harmless instead of pointing at a broken command.
	if (!notifyCommand) {
		return JSON.stringify({ hooks: {} });
	}

	const settings = {
		hooks: {
			UserPromptSubmit: [
				{ hooks: [{ type: "command", command: notifyCommand }] },
			],
			Stop: [{ hooks: [{ type: "command", command: notifyCommand }] }],
			PostToolUse: [
				{ matcher: "*", hooks: [{ type: "command", command: notifyCommand }] },
			],
			PostToolUseFailure: [
				{ matcher: "*", hooks: [{ type: "command", command: notifyCommand }] },
			],
			PermissionRequest: [
				{ matcher: "*", hooks: [{ type: "command", command: notifyCommand }] },
			],
		},
	};

	return JSON.stringify(settings);
}

export function getOpenCodePluginContent(notifyPath: string): string {
	const template = fs.readFileSync(OPENCODE_PLUGIN_TEMPLATE_PATH, "utf-8");
	// The path lands inside a JS double-quoted string literal in the template;
	// Windows backslashes must be escaped or they're consumed as JS escapes
	// (C:\Users\... would become C:Users...).
	const escapedPath = notifyPath.replaceAll("\\", "\\\\");
	return template
		.replace("{{MARKER}}", OPENCODE_PLUGIN_MARKER)
		.replace("{{NOTIFY_PATH}}", escapedPath);
}

function createClaudeSettings(): string {
	const settingsPath = getClaudeSettingsPath();
	const settings = getClaudeSettingsContent(getNotifyHookCommand());

	writeFileIfChanged(settingsPath, settings, 0o644);
	return settingsPath;
}

export function createClaudeWrapper(): void {
	const settingsPath = createClaudeSettings();
	const script = buildWrapperScript(
		"claude",
		`exec "$REAL_BIN" --settings "${settingsPath}" "$@"`,
	);
	createWrapper("claude", script);

	// cmd/PowerShell can't execute the extensionless bash wrapper; give them a
	// .cmd shim so `claude` typed in a Windows terminal still gets --settings
	// (and with it, the lifecycle hooks that drive agent status + memory flows).
	if (process.platform === "win32") {
		createWindowsCmdWrapper("claude", {
			extraArgsLine: `--settings "${settingsPath}"`,
		});
	}
}

/**
 * Windows codex notify config. codex spawns the notify argv directly (no
 * shell), so we can point it straight at node + the .mjs port. Forward
 * slashes keep the paths clean through both TOML string parsing and MSVC
 * argv quoting (\" for the embedded quotes). The bash wrapper's session-log
 * Start-event watcher has no cmd equivalent and is intentionally omitted —
 * completion (Stop) notifications are the load-bearing part.
 */
function buildCodexWindowsArgsLine(): string | undefined {
	const notifyCommand = getNotifyHookCommand();
	if (!notifyCommand) return undefined;

	// getNotifyHookCommand returns `"<node>" "<script>"` on Windows; re-split it.
	const parts = notifyCommand.match(/"([^"]+)" "([^"]+)"/);
	if (!parts) return undefined;
	const [, node, script] = parts;
	const toSlash = (p: string) => p.replaceAll("\\", "/");
	return `-c "notify=[\\"${toSlash(node)}\\",\\"${toSlash(script)}\\"]"`;
}

export function createCodexWrapper(): void {
	const notifyPath = getNotifyScriptPath();
	const script = buildWrapperScript(
		"codex",
		buildCodexWrapperExecLine(notifyPath),
	);
	createWrapper("codex", script);

	if (process.platform === "win32") {
		createWindowsCmdWrapper("codex", {
			extraArgsLine: buildCodexWindowsArgsLine(),
		});
	}
}

export function buildCodexWrapperExecLine(notifyPath: string): string {
	const template = fs.readFileSync(CODEX_WRAPPER_EXEC_TEMPLATE_PATH, "utf-8");
	return template.replaceAll("{{NOTIFY_PATH}}", notifyPath);
}

/**
 * Writes to environment-specific path only, NOT the global path.
 * Global path causes dev/prod conflicts when both are running.
 */
export function createOpenCodePlugin(): void {
	const pluginPath = getOpenCodePluginPath();
	const notifyPath = getNotifyScriptPath();
	const content = getOpenCodePluginContent(notifyPath);
	const changed = writeFileIfChanged(pluginPath, content, 0o644);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} OpenCode plugin`,
	);
}

/**
 * Removes stale global plugin written by older versions.
 * Only removes if the file contains our signature to avoid deleting user plugins.
 */
export function cleanupGlobalOpenCodePlugin(): void {
	try {
		const globalPluginPath = getOpenCodeGlobalPluginPath();
		if (!fs.existsSync(globalPluginPath)) return;

		const content = fs.readFileSync(globalPluginPath, "utf-8");
		if (content.includes(OPENCODE_PLUGIN_SIGNATURE)) {
			fs.unlinkSync(globalPluginPath);
			console.log(
				"[agent-setup] Removed stale global OpenCode plugin to prevent dev/prod conflicts",
			);
		}
	} catch (error) {
		console.warn(
			"[agent-setup] Failed to cleanup global OpenCode plugin:",
			error,
		);
	}
}

export function createOpenCodeWrapper(): void {
	const script = buildWrapperScript(
		"opencode",
		`export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR}"\nexec "$REAL_BIN" "$@"`,
	);
	createWrapper("opencode", script);

	if (process.platform === "win32") {
		createWindowsCmdWrapper("opencode", {
			preludeLines: [`set "OPENCODE_CONFIG_DIR=${OPENCODE_CONFIG_DIR}"`],
		});
	}
}
