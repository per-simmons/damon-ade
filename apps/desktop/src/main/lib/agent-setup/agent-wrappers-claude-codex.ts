import fs from "node:fs";
import path from "node:path";
import {
	buildWrapperScript,
	createWrapper,
	writeFileIfChanged,
} from "./agent-wrappers-common";
import { getNotifyScriptPath } from "./notify-hook";
import { HOOKS_DIR } from "./paths";
import { forwardSlashPath } from "./shell-path";

export const CLAUDE_SETTINGS_FILE = "claude-settings.json";

const CODEX_WRAPPER_EXEC_TEMPLATE_PATH = path.join(
	__dirname,
	"templates",
	"codex-wrapper-exec.template.sh",
);

export function getClaudeSettingsPath(): string {
	return forwardSlashPath(path.join(HOOKS_DIR, CLAUDE_SETTINGS_FILE));
}

export function getClaudeSettingsContent(notifyPath: string): string {
	const settings = {
		hooks: {
			UserPromptSubmit: [{ hooks: [{ type: "command", command: notifyPath }] }],
			Stop: [{ hooks: [{ type: "command", command: notifyPath }] }],
			PostToolUse: [
				{ matcher: "*", hooks: [{ type: "command", command: notifyPath }] },
			],
			PostToolUseFailure: [
				{ matcher: "*", hooks: [{ type: "command", command: notifyPath }] },
			],
			PermissionRequest: [
				{ matcher: "*", hooks: [{ type: "command", command: notifyPath }] },
			],
		},
	};

	return JSON.stringify(settings);
}

function createClaudeSettings(): string {
	const settingsPath = getClaudeSettingsPath();
	const notifyPath = getNotifyScriptPath();
	const settings = getClaudeSettingsContent(notifyPath);

	writeFileIfChanged(settingsPath, settings, 0o644);
	return settingsPath;
}

/**
 * Claude Code subcommands. The workflow flags are only added to sessions;
 * `claude update`, `claude mcp list` and the like would reject them.
 */
export const CLAUDE_SUBCOMMANDS = [
	"agents",
	"auth",
	"completion",
	"config",
	"doctor",
	"help",
	"install",
	"mcp",
	"migrate-installer",
	"plugin",
	"plugins",
	"remote-control",
	"setup-token",
	"update",
	"upgrade",
];

/**
 * The wrapper's exec line. In a session it adds the terminal's project
 * workflow (see agent-workflow/workflow-env.ts): `--add-dir <task folder>` so
 * the agents can write plans there, then `--agents <roles JSON>`.
 * `--add-dir` takes several values, so `--agents` must follow it to end the
 * list before the user's own arguments.
 */
export function buildClaudeExecLine(settingsPath: string): string {
	return `ADE_WORKFLOW_ARGS=()
case "\${1:-}" in
  ${CLAUDE_SUBCOMMANDS.join("|")}) ;;
  *)
    if [ -n "\${SUPERSET_WORKFLOW_AGENTS:-}" ] && [ -f "$SUPERSET_WORKFLOW_AGENTS" ]; then
      if [ -n "\${SUPERSET_WORKFLOW_TASKS_DIR:-}" ]; then
        ADE_WORKFLOW_ARGS+=(--add-dir "$SUPERSET_WORKFLOW_TASKS_DIR")
      fi
      ADE_WORKFLOW_ARGS+=(--agents "$(cat "$SUPERSET_WORKFLOW_AGENTS")")
    fi
    ;;
esac
exec "$REAL_BIN" --settings "${settingsPath}" "\${ADE_WORKFLOW_ARGS[@]}" "$@"`;
}

export function createClaudeWrapper(): void {
	const settingsPath = createClaudeSettings();
	const script = buildWrapperScript(
		"claude",
		buildClaudeExecLine(settingsPath),
	);
	createWrapper("claude", script);
}

export function createCodexWrapper(): void {
	const notifyPath = getNotifyScriptPath();
	const script = buildWrapperScript(
		"codex",
		buildCodexWrapperExecLine(notifyPath),
	);
	createWrapper("codex", script);
}

export function buildCodexWrapperExecLine(notifyPath: string): string {
	const template = fs.readFileSync(CODEX_WRAPPER_EXEC_TEMPLATE_PATH, "utf-8");
	return template.replaceAll("{{NOTIFY_PATH}}", notifyPath);
}
