import fs from "node:fs";
import path from "node:path";
import { env } from "shared/env.shared";
import { HOOKS_DIR } from "./paths";

export const NOTIFY_SCRIPT_NAME = "notify.sh";
export const NOTIFY_NODE_SCRIPT_NAME = "notify.cjs";
export const NOTIFY_CMD_SCRIPT_NAME = "notify.cmd";
export const NOTIFY_SCRIPT_MARKER = "# Superset agent notification hook";

const NOTIFY_SCRIPT_TEMPLATE_PATH = path.join(
	__dirname,
	"templates",
	"notify-hook.template.sh",
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
	if (process.platform === "win32") {
		return path.join(HOOKS_DIR, NOTIFY_CMD_SCRIPT_NAME);
	}
	return path.join(HOOKS_DIR, NOTIFY_SCRIPT_NAME);
}

export function getNotifyShellScriptPath(): string {
	return path.join(HOOKS_DIR, NOTIFY_SCRIPT_NAME);
}

export function getNotifyNodeScriptPath(): string {
	return path.join(HOOKS_DIR, NOTIFY_NODE_SCRIPT_NAME);
}

export function getNotifyScriptContent(): string {
	const template = fs.readFileSync(NOTIFY_SCRIPT_TEMPLATE_PATH, "utf-8");
	return template
		.replaceAll("{{MARKER}}", NOTIFY_SCRIPT_MARKER)
		.replaceAll("{{DEFAULT_PORT}}", String(env.DESKTOP_NOTIFICATIONS_PORT));
}

export function getNotifyNodeScriptContent(): string {
	return `#!/usr/bin/env node
// ${NOTIFY_SCRIPT_MARKER}
const http = require("node:http");
const fs = require("node:fs");

const DEFAULT_PORT = "${env.DESKTOP_NOTIFICATIONS_PORT}";

function readStdin() {
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parseJson(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function shouldDebug() {
  if (process.env.SUPERSET_DEBUG_HOOKS) {
    return truthy(process.env.SUPERSET_DEBUG_HOOKS);
  }
  return process.env.SUPERSET_ENV === "development" || process.env.NODE_ENV === "development";
}

function dispatch(eventType, sessionId = "") {
  if (!eventType) return;
  if (!process.env.SUPERSET_TAB_ID && !sessionId) return;

  const params = new URLSearchParams({
    paneId: process.env.SUPERSET_PANE_ID || "",
    tabId: process.env.SUPERSET_TAB_ID || "",
    workspaceId: process.env.SUPERSET_WORKSPACE_ID || "",
    sessionId,
    eventType,
    env: process.env.SUPERSET_ENV || "",
    version: process.env.SUPERSET_HOOK_VERSION || "",
  });
  const url = \`http://127.0.0.1:\${process.env.SUPERSET_PORT || DEFAULT_PORT}/hook/complete?\${params}\`;
  const debug = shouldDebug();

  if (debug) {
    console.error(\`[notify-hook] event=\${eventType} sessionId=\${sessionId} paneId=\${process.env.SUPERSET_PANE_ID || ""} tabId=\${process.env.SUPERSET_TAB_ID || ""} workspaceId=\${process.env.SUPERSET_WORKSPACE_ID || ""}\`);
  }

  const request = http.get(url, (response) => {
    response.resume();
    response.on("end", () => {
      if (debug) console.error(\`[notify-hook] dispatched status=\${response.statusCode || 0}\`);
    });
  });
  request.setTimeout(2000, () => request.destroy());
  request.on("error", () => {});
}

function normalizeNotifyEvent(payload) {
  let eventType = payload.hook_event_name || "";
  if (!eventType && payload.type === "agent-turn-complete") {
    eventType = "Stop";
  }
  if (eventType === "UserPromptSubmit") {
    eventType = "Start";
  }
  return eventType;
}

function runNotify(args) {
  const input = args[0] || readStdin();
  const payload = parseJson(input);
  dispatch(normalizeNotifyEvent(payload), payload.session_id || "");
}

function runCursor(args) {
  readStdin();
  const eventType = args[0] || "";
  if (eventType === "PermissionRequest") {
    process.stdout.write('{"continue":true}\\n');
  }
  if (["Start", "Stop", "PermissionRequest"].includes(eventType)) {
    dispatch(eventType);
  }
}

function runGemini() {
  const payload = parseJson(readStdin());
  const map = {
    BeforeAgent: "Start",
    AfterAgent: "Stop",
    AfterTool: "Start",
  };
  const eventType = map[payload.hook_event_name] || "";
  process.stdout.write("{}\\n");
  dispatch(eventType);
}

function runCopilot(args) {
  readStdin();
  const map = {
    sessionStart: "Start",
    sessionEnd: "Stop",
    userPromptSubmitted: "Start",
    postToolUse: "Start",
    preToolUse: "PermissionRequest",
  };
  process.stdout.write("{}\\n");
  dispatch(map[args[0]] || "");
}

const rawArgs = process.argv.slice(2);
const mode = rawArgs[0]?.startsWith("--") ? rawArgs.shift().slice(2) : "notify";

switch (mode) {
  case "cursor":
    runCursor(rawArgs);
    break;
  case "gemini":
    runGemini();
    break;
  case "copilot":
    runCopilot(rawArgs);
    break;
  default:
    runNotify(rawArgs);
    break;
}
`;
}

function getNotifyCmdScriptContent(): string {
	return `@echo off\r\nnode "%~dp0${NOTIFY_NODE_SCRIPT_NAME}" %*\r\n`;
}

export function createNotifyScript(): void {
	const script = getNotifyScriptContent();
	const changed = writeFileIfChanged(getNotifyShellScriptPath(), script, 0o755);
	const nodeChanged = writeFileIfChanged(
		getNotifyNodeScriptPath(),
		getNotifyNodeScriptContent(),
		0o755,
	);
	if (process.platform === "win32") {
		writeFileIfChanged(
			getNotifyScriptPath(),
			getNotifyCmdScriptContent(),
			0o755,
		);
	}
	console.log(`[agent-setup] ${changed ? "Updated" : "Verified"} notify hook`);
	if (nodeChanged) {
		console.log("[agent-setup] Updated notify node hook");
	}
}
