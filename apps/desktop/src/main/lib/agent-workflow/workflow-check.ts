import { existsSync, readFileSync } from "node:fs";
import { adeRoleName } from "./agent-workflow";

/**
 * Non-billable checks for the workflow: that a project's generated roles are
 * what the settings say, and that the installed Claude Code supports what the
 * roles rely on. Nothing here calls a model.
 */

const MODEL_ALIASES = new Set([
	"fable",
	"opus",
	"sonnet",
	"haiku",
	"inherit",
	"best",
	"opusplan",
]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** A model value Claude Code accepts: an alias or a full claude-* model ID. */
export function isPlausibleModel(value: string): boolean {
	const base = value.replace(/\[1m\]$/, "");
	return MODEL_ALIASES.has(base) || /^claude-[a-z0-9.-]+$/.test(base);
}

/**
 * Whether a model recorded in a transcript (always a full ID) is what a
 * configured value asks for. An alias matches any model of its tier, since
 * aliases move to newer models over time.
 */
export function modelMatches(configured: string, observed: string): boolean {
	const base = configured.replace(/\[1m\]$/, "");
	if (base === "inherit") return true;
	if (base.startsWith("claude-")) return observed === base;
	const tier = base === "best" ? "opus" : base;
	return (
		observed === `claude-${tier}` || observed.startsWith(`claude-${tier}-`)
	);
}

export interface RoleCheck {
	name: string;
	model?: string;
	effort?: string;
	maxTurns?: number;
	problems: string[];
}

export interface AgentsFileCheck {
	path: string;
	ok: boolean;
	roles: RoleCheck[];
	problems: string[];
}

interface ExpectedRole {
	model: string;
	effort: string;
	maxTurns: number;
}

/**
 * Check a project's agents.json (the `--agents` JSON ADE passes to Claude
 * Code): it parses, every role (`expected` is keyed by role name, the file
 * by its "ade-" name) is present with the fields Claude Code
 * validates, the routing matches the settings, and prompts point at the
 * project's task folder.
 */
export function checkAgentsFile(
	path: string,
	expected: Record<string, ExpectedRole>,
	tasksDir: string,
): AgentsFileCheck {
	const problems: string[] = [];
	if (!existsSync(path)) {
		return { path, ok: false, roles: [], problems: ["agents.json is missing"] };
	}
	let parsed: Record<string, Record<string, unknown>>;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {
			path,
			ok: false,
			roles: [],
			problems: ["agents.json is not valid JSON"],
		};
	}

	const roles: RoleCheck[] = [];
	for (const [name, want] of Object.entries(expected)) {
		// Roles are keyed "ade-<role>" so a project's own agents keep their names.
		const role = parsed[adeRoleName(name)];
		const check: RoleCheck = { name, problems: [] };
		roles.push(check);
		if (!role) {
			check.problems.push("missing");
			continue;
		}
		check.model = typeof role.model === "string" ? role.model : undefined;
		check.effort = typeof role.effort === "string" ? role.effort : undefined;
		check.maxTurns =
			typeof role.maxTurns === "number" ? role.maxTurns : undefined;
		if (typeof role.description !== "string" || !role.description) {
			check.problems.push("no description");
		}
		if (typeof role.prompt !== "string" || !role.prompt) {
			check.problems.push("no prompt");
		} else if (!role.prompt.includes(tasksDir)) {
			check.problems.push(
				"prompt does not point at this project's task folder",
			);
		}
		if (!check.model || !isPlausibleModel(check.model)) {
			check.problems.push(`unrecognized model "${check.model ?? ""}"`);
		} else if (check.model !== want.model) {
			check.problems.push(
				`model is ${check.model}, settings say ${want.model}`,
			);
		}
		if (!check.effort || !EFFORTS.has(check.effort)) {
			check.problems.push(`invalid effort "${check.effort ?? ""}"`);
		} else if (check.effort !== want.effort) {
			check.problems.push(
				`effort is ${check.effort}, settings say ${want.effort}`,
			);
		}
		if (!Number.isInteger(check.maxTurns) || (check.maxTurns ?? 0) < 1) {
			check.problems.push("maxTurns must be a positive integer");
		} else if (check.maxTurns !== want.maxTurns) {
			check.problems.push(
				`turn limit is ${check.maxTurns}, settings say ${want.maxTurns}`,
			);
		}
	}
	const ok =
		problems.length === 0 && roles.every((role) => role.problems.length === 0);
	return { path, ok, roles, problems };
}

export interface ClaudeCliSupport {
	binaryPath: string;
	/** Markers found in the installed CLI (no model is called). */
	supportsAgentsFlag: boolean;
	supportsEffortField: boolean;
	supportsMaxTurnsField: boolean;
	knowsFableAlias: boolean;
}

/**
 * Look for what the workflow relies on in the installed Claude Code binary or
 * bundle: the --agents flag, the effort/maxTurns role fields and the fable
 * alias. A missing marker means "could not confirm", not "unsupported".
 */
export function checkClaudeCliSupport(
	binaryPath: string,
): ClaudeCliSupport | undefined {
	if (!existsSync(binaryPath)) return undefined;
	const data = readFileSync(binaryPath);
	const has = (text: string) => data.indexOf(text) !== -1;
	return {
		binaryPath,
		supportsAgentsFlag: has("--agents <json>"),
		supportsEffortField: has("has invalid effort"),
		supportsMaxTurnsField: has("has invalid maxTurns"),
		knowsFableAlias: has("ANTHROPIC_DEFAULT_FABLE_MODEL"),
	};
}
