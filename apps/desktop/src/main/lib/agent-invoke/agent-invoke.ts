import { randomUUID } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
	type InvokePermissionMode,
	type InvokeShellKind,
	isInvokePermissionMode,
	isSafeCliToken,
} from "shared/utils/agent-invoke-command";

/**
 * Request handling for POST /agent/invoke, kept free of Electron and Express
 * so it can be tested end to end: validate the body, write the prompt to a
 * private file, and pick the shell syntax for the command.
 */

/** Largest prompt accepted, in characters. */
export const MAX_INVOKE_PROMPT_LENGTH = 100_000;

/** Prompt files older than this are deleted when a new one is written. */
export const PROMPT_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface InvokeAgentEntry {
	cwd: string;
	workspaceId: string;
	sessionId: string;
	model?: string;
	permissionMode?: string;
}

export interface ParsedInvokeRequest {
	agent: string;
	prompt: string;
	tabTitle?: string;
	claudeSessionId?: string;
	fresh: boolean;
	/** Request model, else the registry model; only plain tokens survive. */
	model?: string;
	/**
	 * "terminal" (default): run interactively in the agent's ADE terminal.
	 * "headless": run `claude -p` in the background with a hard budget cap.
	 */
	mode: "terminal" | "headless";
	/** Requested cap for a headless run; the settings cap still applies. */
	maxBudgetUsd?: number;
	entry: InvokeAgentEntry;
	/** Set when the registry model was ignored because it is not a plain token. */
	ignoredRegistryModel?: string;
	/**
	 * From the agent's registry entry only (a request cannot raise it);
	 * "acceptEdits" when unset or not a known mode.
	 */
	permissionMode: InvokePermissionMode;
}

export type ParseInvokeResult =
	| { ok: true; request: ParsedInvokeRequest }
	| { ok: false; status: 400 | 404 | 413; error: string };

function optionalString(
	body: Record<string, unknown>,
	key: string,
): { value?: string; error?: string } {
	const raw = body[key];
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "string") return { error: `${key} must be a string` };
	const trimmed = raw.trim();
	return trimmed ? { value: trimmed } : {};
}

export function parseAgentInvokeRequest(
	body: unknown,
	lookupAgent: (name: string) => InvokeAgentEntry | undefined,
): ParseInvokeResult {
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, status: 400, error: "Body must be a JSON object" };
	}
	const fields = body as Record<string, unknown>;

	const { agent, prompt } = fields;
	if (typeof agent !== "string" || !agent.trim()) {
		return { ok: false, status: 400, error: "agent and prompt are required" };
	}
	if (typeof prompt !== "string" || !prompt.trim()) {
		return { ok: false, status: 400, error: "agent and prompt are required" };
	}
	if (prompt.length > MAX_INVOKE_PROMPT_LENGTH) {
		return {
			ok: false,
			status: 413,
			error: `prompt is longer than ${MAX_INVOKE_PROMPT_LENGTH} characters`,
		};
	}
	if (prompt.includes("\0")) {
		return { ok: false, status: 400, error: "prompt must not contain NUL" };
	}

	if (fields.fresh !== undefined && typeof fields.fresh !== "boolean") {
		return { ok: false, status: 400, error: "fresh must be a boolean" };
	}

	const mode = fields.mode ?? "terminal";
	if (mode !== "terminal" && mode !== "headless") {
		return {
			ok: false,
			status: 400,
			error: 'mode must be "terminal" or "headless"',
		};
	}
	const maxBudgetUsd = fields.maxBudgetUsd;
	if (
		maxBudgetUsd !== undefined &&
		(typeof maxBudgetUsd !== "number" ||
			!Number.isFinite(maxBudgetUsd) ||
			maxBudgetUsd <= 0)
	) {
		return {
			ok: false,
			status: 400,
			error: "maxBudgetUsd must be a positive number",
		};
	}

	const tab = optionalString(fields, "tab");
	const session = optionalString(fields, "claudeSessionId");
	const model = optionalString(fields, "model");
	for (const field of [tab, session, model]) {
		if (field.error) return { ok: false, status: 400, error: field.error };
	}
	if (session.value && !isSafeCliToken(session.value)) {
		return {
			ok: false,
			status: 400,
			error: "claudeSessionId may contain only letters, digits and . _ - [ ]",
		};
	}
	if (model.value && !isSafeCliToken(model.value)) {
		return {
			ok: false,
			status: 400,
			error: "model may contain only letters, digits and . _ - [ ]",
		};
	}

	const entry = lookupAgent(agent.trim());
	if (!entry) {
		return { ok: false, status: 404, error: `Unknown agent: ${agent.trim()}` };
	}

	const registryModel = entry.model?.trim() || undefined;
	const registryModelSafe =
		registryModel && isSafeCliToken(registryModel) ? registryModel : undefined;

	return {
		ok: true,
		request: {
			agent: agent.trim(),
			prompt,
			tabTitle: tab.value,
			claudeSessionId: session.value,
			fresh: fields.fresh !== false,
			model: model.value ?? registryModelSafe,
			mode,
			maxBudgetUsd: maxBudgetUsd as number | undefined,
			entry,
			ignoredRegistryModel:
				registryModel && !registryModelSafe ? registryModel : undefined,
			permissionMode: isInvokePermissionMode(entry.permissionMode)
				? entry.permissionMode
				: "acceptEdits",
		},
	};
}

/** Shell syntax for a terminal running `shellPath`. */
export function shellKindFor(shellPath: string): InvokeShellKind {
	const name = basename(shellPath.replace(/\\/g, "/")).toLowerCase();
	if (name.startsWith("pwsh") || name.startsWith("powershell")) {
		return "powershell";
	}
	if (name === "cmd" || name === "cmd.exe") return "cmd";
	return "posix";
}

export function getInvokePromptDir(homeDir: string): string {
	return join(homeDir, "invoke-prompts");
}

/**
 * Write `prompt` to a new private file under `dir` (created 0700, file 0600)
 * and delete prompt files older than PROMPT_FILE_MAX_AGE_MS. Returns the path.
 */
export function writeInvokePromptFile(
	dir: string,
	prompt: string,
	now: number = Date.now(),
): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// Best effort (no-op on Windows).
	}

	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".txt")) continue;
		const path = join(dir, name);
		try {
			if (now - statSync(path).mtimeMs > PROMPT_FILE_MAX_AGE_MS) {
				unlinkSync(path);
			}
		} catch {
			// A file removed concurrently is fine.
		}
	}

	const path = join(dir, `${randomUUID()}.txt`);
	writeFileSync(path, prompt, { encoding: "utf8", mode: 0o600 });
	return path;
}
