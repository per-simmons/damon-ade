import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { TokenUsage } from "./pricing";

/**
 * Reads usage from Claude Code session transcripts
 * (~/.claude/projects/<encoded cwd>/<session id>.jsonl).
 *
 * Interactive sessions have no JSON output mode, but every API response is
 * written to the transcript with its real model and token usage. Subagents
 * write their own transcripts to <session id>/subagents/agent-<id>.jsonl, with
 * the subagent type in agent-<id>.meta.json.
 *
 * A response's content blocks are written as separate lines that share one
 * message id, so usage is keyed by message id and the last line wins.
 */

export interface UsageRecord extends TokenUsage {
	/** API message id; unique per response, shared across resumed copies. */
	id: string;
	model: string;
	/** "main" for the session itself, else the subagent type. */
	agentType: string;
	timestamp: string;
}

export interface ParsedTranscript {
	sessionId: string;
	cwd?: string;
	claudeVersion?: string;
	firstAt?: string;
	lastAt?: string;
	/** Sum over turns of (last response - human prompt). */
	activeMs: number;
	humanPrompts: number;
	/** Agent tool calls by subagent type (escalations = architect calls). */
	subagentCalls: Record<string, number>;
	apiErrors: number;
	/** Task slugs referenced as .ade/tasks/<slug> anywhere in tool calls. */
	taskSlugs: string[];
	records: UsageRecord[];
}

interface TranscriptLine {
	type?: string;
	subtype?: string;
	isSidechain?: boolean;
	isMeta?: boolean;
	isApiErrorMessage?: boolean;
	toolUseResult?: unknown;
	cwd?: string;
	version?: string;
	sessionId?: string;
	timestamp?: string;
	message?: {
		id?: string;
		model?: string;
		content?: unknown;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
			cache_creation?: {
				ephemeral_5m_input_tokens?: number;
				ephemeral_1h_input_tokens?: number;
			};
			speed?: string;
			inference_geo?: string;
		};
	};
}

const TASK_SLUG = /\.ade[\\/]+tasks[\\/]+([a-z0-9][a-z0-9-]*)/g;

/** Parse JSONL, skipping blank and malformed lines (the last one may be mid-write). */
export function readJsonl(path: string): TranscriptLine[] {
	const lines: TranscriptLine[] = [];
	for (const raw of readFileSync(path, "utf8").split("\n")) {
		if (!raw.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === "object") {
				lines.push(parsed as TranscriptLine);
			}
		} catch {
			// Partial or corrupt line.
		}
	}
	return lines;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toRecord(line: TranscriptLine, agentType: string): UsageRecord | null {
	const message = line.message;
	const usage = message?.usage;
	if (!message?.id || !message.model || !usage) return null;
	// Claude Code writes locally generated messages (e.g. errors) with this model.
	if (message.model === "<synthetic>") return null;

	const totalWrite = num(usage.cache_creation_input_tokens);
	const write1h = num(usage.cache_creation?.ephemeral_1h_input_tokens);
	// Without the breakdown, all cache writes are treated as 5-minute writes.
	const write5m = usage.cache_creation
		? num(usage.cache_creation.ephemeral_5m_input_tokens)
		: totalWrite;

	return {
		id: message.id,
		model: message.model,
		agentType,
		timestamp: line.timestamp ?? "",
		input: num(usage.input_tokens),
		output: num(usage.output_tokens),
		cacheRead: num(usage.cache_read_input_tokens),
		cacheWrite5m: write5m,
		cacheWrite1h: write1h,
		speed: usage.speed,
		geo: usage.inference_geo,
	};
}

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
	return Array.isArray(content)
		? content.filter(
				(block): block is Record<string, unknown> =>
					!!block && typeof block === "object",
			)
		: [];
}

function isHumanPrompt(line: TranscriptLine): boolean {
	if (line.type !== "user" || line.isMeta || line.isSidechain) return false;
	if (line.toolUseResult !== undefined) return false;
	const content = line.message?.content;
	if (typeof content === "string") return content.trim().length > 0;
	const blocks = contentBlocks(content);
	return (
		blocks.some((block) => block.type === "text") &&
		!blocks.some((block) => block.type === "tool_result")
	);
}

function collectSlugs(value: unknown, into: Set<string>): void {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (!text) return;
	for (const match of text.matchAll(TASK_SLUG)) into.add(match[1]);
}

function readAgentType(subagentPath: string): string {
	const metaPath = subagentPath.replace(/\.jsonl$/, ".meta.json");
	try {
		const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
			agentType?: unknown;
		};
		if (typeof meta.agentType === "string" && meta.agentType) {
			return meta.agentType;
		}
	} catch {
		// Missing or unreadable meta file.
	}
	return "subagent";
}

/** Subagent transcripts that belong to the session at `transcriptPath`. */
export function listSubagentTranscripts(transcriptPath: string): string[] {
	const sessionId = basename(transcriptPath, ".jsonl");
	const dir = join(dirname(transcriptPath), sessionId, "subagents");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => /^agent-.+\.jsonl$/.test(name))
		.sort()
		.map((name) => join(dir, name));
}

export function parseTranscript(transcriptPath: string): ParsedTranscript {
	const lines = readJsonl(transcriptPath);
	const records = new Map<string, UsageRecord>();
	const slugs = new Set<string>();
	const subagentCalls: Record<string, number> = {};
	const timestamps: string[] = [];

	let cwd: string | undefined;
	let claudeVersion: string | undefined;
	let sessionId: string | undefined;
	let apiErrors = 0;
	let humanPrompts = 0;
	let activeMs = 0;
	let turnStart: number | null = null;
	let turnEnd: number | null = null;

	const closeTurn = () => {
		if (turnStart !== null && turnEnd !== null && turnEnd > turnStart) {
			activeMs += turnEnd - turnStart;
		}
		turnStart = null;
		turnEnd = null;
	};

	for (const line of lines) {
		cwd ??= line.cwd;
		claudeVersion ??= line.version;
		sessionId ??= line.sessionId;
		const at = line.timestamp ? Date.parse(line.timestamp) : Number.NaN;
		if (line.timestamp && !Number.isNaN(at)) timestamps.push(line.timestamp);

		if (line.isApiErrorMessage) apiErrors++;
		if (line.type === "system" && line.subtype?.includes("error")) apiErrors++;

		if (isHumanPrompt(line)) {
			closeTurn();
			humanPrompts++;
			if (!Number.isNaN(at)) turnStart = at;
			continue;
		}

		if (line.type === "assistant") {
			const record = toRecord(line, line.isSidechain ? "sidechain" : "main");
			if (record) records.set(record.id, record);
			if (!Number.isNaN(at)) turnEnd = at;

			for (const block of contentBlocks(line.message?.content)) {
				if (block.type !== "tool_use") continue;
				collectSlugs(block.input, slugs);
				if (block.name === "Agent" || block.name === "Task") {
					const input = (block.input ?? {}) as { subagent_type?: unknown };
					const type =
						typeof input.subagent_type === "string" && input.subagent_type
							? input.subagent_type
							: "general-purpose";
					subagentCalls[type] = (subagentCalls[type] ?? 0) + 1;
				}
			}
		}
	}
	closeTurn();

	for (const subagentPath of listSubagentTranscripts(transcriptPath)) {
		const agentType = readAgentType(subagentPath);
		for (const line of readJsonl(subagentPath)) {
			if (line.type !== "assistant") continue;
			const record = toRecord(line, agentType);
			if (record) records.set(record.id, record);
			for (const block of contentBlocks(line.message?.content)) {
				if (block.type === "tool_use") collectSlugs(block.input, slugs);
			}
		}
	}

	timestamps.sort();
	return {
		sessionId: sessionId ?? basename(transcriptPath, ".jsonl"),
		cwd,
		claudeVersion,
		firstAt: timestamps[0],
		lastAt: timestamps[timestamps.length - 1],
		activeMs,
		humanPrompts,
		subagentCalls,
		apiErrors,
		taskSlugs: [...slugs].sort(),
		records: [...records.values()],
	};
}
