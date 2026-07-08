#!/usr/bin/env node
// {{MARKER}}
// Cross-platform (Node) port of notify-hook.template.sh, used on Windows where
// the bash hook script cannot be executed. Called by CLI agents (Claude Code,
// Codex, etc.) when they complete or need input. Must always exit 0 — a hook
// failure must never block the agent.

async function readStdin() {
	if (process.stdin.isTTY) return "";
	let data = "";
	process.stdin.setEncoding("utf-8");
	for await (const chunk of process.stdin) {
		data += chunk;
	}
	return data;
}

function extractString(input, key) {
	const match = input.match(
		new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`),
	);
	return match ? match[1] : "";
}

async function main() {
	// Codex passes JSON as an argument, Claude pipes to stdin
	const input = process.argv[2] || (await readStdin());

	const sessionId = extractString(input, "session_id");

	// Skip if this isn't a Superset terminal hook and no Mastra session context exists
	if (!process.env.SUPERSET_TAB_ID && !sessionId) return;

	// Claude uses "hook_event_name", Codex uses "type"
	let eventType = extractString(input, "hook_event_name");
	if (!eventType && extractString(input, "type") === "agent-turn-complete") {
		eventType = "Stop";
	}
	if (eventType === "UserPromptSubmit") eventType = "Start";

	// Parse failures must not trigger false completion notifications
	if (!eventType) return;

	// Mirrors the debug gating in notify-hook.template.sh
	const debugFlag = process.env.SUPERSET_DEBUG_HOOKS;
	const debug = debugFlag
		? ["1", "true", "yes", "on"].includes(debugFlag.toLowerCase())
		: process.env.SUPERSET_ENV === "development" ||
			process.env.NODE_ENV === "development";

	if (debug) {
		console.error(
			`[notify-hook] event=${eventType} sessionId=${sessionId} paneId=${process.env.SUPERSET_PANE_ID || ""} tabId=${process.env.SUPERSET_TAB_ID || ""} workspaceId=${process.env.SUPERSET_WORKSPACE_ID || ""}`,
		);
	}

	const port = process.env.SUPERSET_PORT || "{{DEFAULT_PORT}}";
	const params = new URLSearchParams({
		paneId: process.env.SUPERSET_PANE_ID || "",
		tabId: process.env.SUPERSET_TAB_ID || "",
		workspaceId: process.env.SUPERSET_WORKSPACE_ID || "",
		sessionId,
		eventType,
		env: process.env.SUPERSET_ENV || "",
		version: process.env.SUPERSET_HOOK_VERSION || "",
	});

	// Timeout prevents blocking agent completion if the server is unresponsive
	const response = await fetch(`http://127.0.0.1:${port}/hook/complete?${params}`, {
		signal: AbortSignal.timeout(2000),
	});
	if (debug) {
		console.error(`[notify-hook] dispatched status=${response.status}`);
	}
}

main()
	.catch(() => {})
	.finally(() => process.exit(0));
