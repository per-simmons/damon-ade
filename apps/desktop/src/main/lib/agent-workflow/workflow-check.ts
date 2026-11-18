import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	renderCommand,
	renderSubagent,
	WORKFLOW_BRIDGE_MARKER,
	WORKFLOW_COMMANDS,
	WORKFLOW_EXCLUDES,
	WORKFLOW_MAIN_MODEL,
	WORKFLOW_SUBAGENTS,
} from "./agent-workflow";

/**
 * Non-billable checks of an agent's workflow configuration: what each role
 * will run on, whether a file was customized, and whether a file would be
 * rejected or silently misread by Claude Code. Nothing here calls a model.
 */

export type FileState = "default" | "customized" | "missing" | "invalid";

export interface RoleCheck {
	name: string;
	state: FileState;
	expected: { model: string; effort: string; maxTurns: number };
	/** As written in the file (customized files may differ from expected). */
	actual?: {
		model?: string;
		effort?: string;
		maxTurns?: string;
		tools?: string;
	};
	problems: string[];
}

export interface WorkflowCheck {
	worktreePath: string;
	roles: RoleCheck[];
	commands: Array<{ name: string; state: FileState; problems: string[] }>;
	mainModel: { expected: string; actual?: string; problems: string[] };
	bridgePointer: boolean;
	/** null when the worktree has no .git directory to exclude from. */
	adeExcluded: boolean | null;
	ok: boolean;
}

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
const KNOWN_TOOLS = new Set([
	"Read",
	"Write",
	"Edit",
	"MultiEdit",
	"Grep",
	"Glob",
	"Bash",
	"WebFetch",
	"WebSearch",
	"NotebookEdit",
	"Agent",
	"Task",
	"TodoWrite",
]);

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

/** A model value Claude Code accepts: an alias or a full claude-* model ID. */
export function isPlausibleModel(value: string): boolean {
	const base = value.replace(/\[1m\]$/, "");
	return MODEL_ALIASES.has(base) || /^claude-[a-z0-9.-]+$/.test(base);
}

/**
 * Parse `key: value` frontmatter. Values may be plain or JSON/YAML
 * double-quoted strings. Returns undefined when there is no frontmatter.
 */
export function parseFrontmatter(
	content: string,
): Record<string, string> | undefined {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
	if (!match) return undefined;
	const fields: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx <= 0 || /^\s/.test(line)) continue;
		const key = line.slice(0, idx).trim();
		let value = line.slice(idx + 1).trim();
		if (value.startsWith('"')) {
			try {
				value = JSON.parse(value) as string;
			} catch {
				// Leave as written; reported by the caller if it matters.
			}
		}
		fields[key] = value;
	}
	return fields;
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function checkRole(
	worktreePath: string,
	role: (typeof WORKFLOW_SUBAGENTS)[number],
): RoleCheck {
	const expected = {
		model: role.model,
		effort: role.effort,
		maxTurns: role.maxTurns,
	};
	const content = readText(
		join(worktreePath, ".claude", "agents", `${role.name}.md`),
	);
	if (content === undefined || !content.trim()) {
		return { name: role.name, state: "missing", expected, problems: [] };
	}

	const fields = parseFrontmatter(content);
	const problems: string[] = [];
	if (!fields) {
		problems.push("no frontmatter; Claude Code will not load this agent");
		return { name: role.name, state: "invalid", expected, problems };
	}
	if (!fields.name) problems.push("missing name");
	if (!fields.description) problems.push("missing description");
	if (fields.model && !isPlausibleModel(fields.model)) {
		problems.push(`unrecognized model "${fields.model}"`);
	}
	if (fields.effort && !EFFORTS.has(fields.effort)) {
		problems.push(`invalid effort "${fields.effort}"`);
	}
	if (fields.maxTurns && !/^[1-9]\d*$/.test(fields.maxTurns)) {
		problems.push(
			`maxTurns must be a positive integer, not "${fields.maxTurns}"`,
		);
	}
	for (const tool of (fields.tools ?? "").split(",").map((t) => t.trim())) {
		if (tool && !KNOWN_TOOLS.has(tool) && !tool.startsWith("mcp__")) {
			problems.push(`unknown tool "${tool}"`);
		}
	}

	const state: FileState =
		problems.length > 0
			? "invalid"
			: content === renderSubagent(role)
				? "default"
				: "customized";
	return {
		name: role.name,
		state,
		expected,
		actual: {
			model: fields.model,
			effort: fields.effort,
			maxTurns: fields.maxTurns,
			tools: fields.tools,
		},
		problems,
	};
}

export function checkAgentWorkflow(worktreePath: string): WorkflowCheck {
	const roles = WORKFLOW_SUBAGENTS.map((role) => checkRole(worktreePath, role));

	const commands = WORKFLOW_COMMANDS.map((command) => {
		const content = readText(
			join(worktreePath, ".claude", "commands", `${command.name}.md`),
		);
		if (content === undefined || !content.trim()) {
			return {
				name: command.name,
				state: "missing" as FileState,
				problems: [],
			};
		}
		const problems = content.includes("$ARGUMENTS")
			? []
			: ["does not use $ARGUMENTS; the task slug will not reach it"];
		const state: FileState =
			content === renderCommand(command)
				? "default"
				: problems.length
					? "invalid"
					: "customized";
		return { name: command.name, state, problems };
	});

	const mainModel: WorkflowCheck["mainModel"] = {
		expected: WORKFLOW_MAIN_MODEL,
		problems: [],
	};
	const settingsText = readText(join(worktreePath, ".claude", "settings.json"));
	if (settingsText !== undefined) {
		try {
			const settings = JSON.parse(settingsText) as { model?: unknown };
			if (typeof settings.model === "string") {
				mainModel.actual = settings.model;
				if (!isPlausibleModel(settings.model)) {
					mainModel.problems.push(`unrecognized model "${settings.model}"`);
				}
			}
		} catch {
			mainModel.problems.push(".claude/settings.json is not valid JSON");
		}
	}

	const claudeMd = readText(join(worktreePath, "CLAUDE.md")) ?? "";
	let adeExcluded: boolean | null = null;
	try {
		if (statSync(join(worktreePath, ".git")).isDirectory()) {
			const exclude =
				readText(join(worktreePath, ".git", "info", "exclude")) ?? "";
			const lines = new Set(exclude.split(/\r?\n/).map((line) => line.trim()));
			adeExcluded = WORKFLOW_EXCLUDES.every((pattern) => lines.has(pattern));
		}
	} catch {
		// No .git.
	}

	const ok =
		roles.every(
			(role) => role.state === "default" || role.state === "customized",
		) &&
		commands.every((c) => c.state === "default" || c.state === "customized") &&
		mainModel.problems.length === 0;

	return {
		worktreePath,
		roles,
		commands,
		mainModel,
		bridgePointer: claudeMd.includes(WORKFLOW_BRIDGE_MARKER),
		adeExcluded,
		ok,
	};
}

export interface ClaudeCliSupport {
	binaryPath: string;
	/** Markers found in the installed CLI (no model is called). */
	supportsEffortField: boolean;
	supportsMaxTurnsField: boolean;
	knowsFableAlias: boolean;
}

/**
 * Look for the subagent fields and model alias this workflow relies on in the
 * installed Claude Code binary or bundle. A heuristic: a missing marker means
 * "could not confirm", not "unsupported".
 */
export function checkClaudeCliSupport(
	binaryPath: string,
): ClaudeCliSupport | undefined {
	if (!existsSync(binaryPath)) return undefined;
	const data = readFileSync(binaryPath);
	const has = (text: string) => data.indexOf(text) !== -1;
	return {
		binaryPath,
		supportsEffortField: has("has invalid effort"),
		supportsMaxTurnsField: has("has invalid maxTurns"),
		knowsFableAlias: has("ANTHROPIC_DEFAULT_FABLE_MODEL"),
	};
}
