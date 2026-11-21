import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { claudeProjectsRoot } from "main/lib/usage-metrics/transcript";
import type { HistoryMessage, ParsedConversation } from "./types";

/**
 * Claude Code sessions, read from their local transcripts:
 * <Claude config dir>/projects/<encoded folder>/<session id>.jsonl
 * (documented in Claude Code's "claude directory" docs; sessions from the
 * Claude desktop app's Code tab are stored there too, marked with
 * entrypoint "claude-desktop"). The line format is not a documented stable
 * schema, so parsing is defensive: unknown lines are skipped, a malformed
 * or half-written line never fails the read, and nothing is ever written.
 *
 * Only the conversation is kept: the user's messages and Claude's replies,
 * plus a one-line note for each file Claude edited. Tool output, thinking,
 * system reminders and subagent side-chains are left out.
 */

export interface SessionSummary {
	sessionId: string;
	transcriptPath: string;
	cwd?: string;
	branch?: string;
	title: string;
	/** Set when the title is the user's own (renamed session). */
	titleIsCustom: boolean;
	firstAt?: string;
	lastAt?: string;
	messageCount: number;
	entrypoint?: string;
	size: number;
	mtimeMs: number;
}

interface Block {
	type?: string;
	text?: string;
	name?: string;
	input?: { file_path?: unknown; notebook_path?: unknown };
}

interface Line {
	type?: string;
	isSidechain?: boolean;
	isMeta?: boolean;
	isCompactSummary?: boolean;
	cwd?: string;
	gitBranch?: string;
	entrypoint?: string;
	sessionId?: string;
	timestamp?: string;
	customTitle?: string;
	message?: { id?: string; role?: string; content?: unknown };
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Wrapper text Claude Code adds around user turns, never the user's words. */
const NOISE = [
	/<system-reminder>[\s\S]*?<\/system-reminder>/g,
	/<local-command-(stdout|stderr|caveat)>[\s\S]*?<\/local-command-\1>/g,
	/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g,
];

function clean(text: string): string {
	let out = text;
	for (const pattern of NOISE) out = out.replace(pattern, "");
	return out.trim();
}

function userText(content: unknown): string {
	if (typeof content === "string") return clean(content);
	if (!Array.isArray(content)) return "";
	return clean(
		(content as Block[])
			.filter(
				(block) => block?.type === "text" && typeof block.text === "string",
			)
			.map((block) => block.text)
			.join("\n"),
	);
}

function assistantText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as Block[]) {
		if (block?.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else if (
			block?.type === "tool_use" &&
			block.name &&
			EDIT_TOOLS.has(block.name)
		) {
			const path = block.input?.file_path ?? block.input?.notebook_path;
			if (typeof path === "string") parts.push(`[${block.name}: ${path}]`);
		}
	}
	return parts.join("\n").trim();
}

function parseLines(raw: string): Line[] {
	const lines: Line[] = [];
	for (const row of raw.split("\n")) {
		if (!row.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(row);
			if (parsed && typeof parsed === "object") lines.push(parsed as Line);
		} catch {
			// A partial (still being written) or corrupt line.
		}
	}
	return lines;
}

interface Parsed {
	summary: SessionSummary;
	messages: HistoryMessage[];
}

const cache = new Map<string, { key: string; parsed: Parsed }>();

/** Parse one transcript (cached by size and mtime). */
export function readSession(transcriptPath: string): Parsed {
	const stat = statSync(transcriptPath);
	const key = `${stat.size}:${stat.mtimeMs}`;
	const hit = cache.get(transcriptPath);
	if (hit && hit.key === key) return hit.parsed;

	const lines = parseLines(readFileSync(transcriptPath, "utf8"));
	const messages: HistoryMessage[] = [];
	let lastAssistantId: string | undefined;
	let cwd: string | undefined;
	let branch: string | undefined;
	let entrypoint: string | undefined;
	let sessionId: string | undefined;
	let customTitle: string | undefined;
	let firstAt: string | undefined;
	let lastAt: string | undefined;

	for (const line of lines) {
		if (line.type === "custom-title" && typeof line.customTitle === "string") {
			customTitle = line.customTitle.trim() || customTitle;
			continue;
		}
		if (line.type !== "user" && line.type !== "assistant") continue;
		if (line.isSidechain) continue;
		cwd ??= line.cwd;
		branch = line.gitBranch || branch;
		entrypoint ??= line.entrypoint;
		sessionId ??= line.sessionId;
		if (line.timestamp) {
			firstAt ??= line.timestamp;
			lastAt = line.timestamp;
		}
		if (line.isMeta) continue;
		if (line.type === "user") {
			const text = userText(line.message?.content);
			lastAssistantId = undefined;
			if (!text) continue;
			messages.push({
				role: "user",
				text: line.isCompactSummary
					? `[Summary of the earlier conversation]\n${text}`
					: text,
				at: line.timestamp,
			});
			continue;
		}
		const text = assistantText(line.message?.content);
		if (!text) continue;
		const id = line.message?.id;
		const last = messages[messages.length - 1];
		// One response is written as several lines sharing its message id.
		if (id && id === lastAssistantId && last?.role === "assistant") {
			last.text = `${last.text}\n${text}`;
		} else {
			messages.push({ role: "assistant", text, at: line.timestamp });
		}
		lastAssistantId = id;
	}

	const fileId = transcriptPath.replace(/\\/g, "/").split("/").pop() ?? "";
	const firstUser = messages.find((m) => m.role === "user")?.text ?? "";
	const parsed: Parsed = {
		summary: {
			sessionId: sessionId ?? fileId.replace(/\.jsonl$/, ""),
			transcriptPath,
			cwd,
			branch,
			title:
				customTitle ??
				(firstUser.split("\n")[0].slice(0, 100) || "Untitled session"),
			titleIsCustom: customTitle !== undefined,
			firstAt,
			lastAt,
			messageCount: messages.length,
			entrypoint,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
		},
		messages,
	};
	cache.set(transcriptPath, { key, parsed });
	return parsed;
}

export function sessionConversation(
	transcriptPath: string,
): ParsedConversation {
	const { summary, messages } = readSession(transcriptPath);
	return {
		origin: {
			kind: "claude-code",
			sessionId: summary.sessionId,
			transcriptPath,
			cwd: summary.cwd,
			branch: summary.branch,
			entrypoint: summary.entrypoint,
		},
		title: summary.title,
		createdAt: summary.firstAt,
		updatedAt: summary.lastAt,
		messages,
	};
}

/** The working folder of a transcript, from its first lines only. */
function headCwd(path: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(256 * 1024);
		const read = readSync(fd, buffer, 0, buffer.length, 0);
		const head = buffer.subarray(0, read).toString("utf8");
		const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
		return match ? (JSON.parse(`"${match[1]}"`) as string) : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export interface TranscriptRef {
	path: string;
	/** The working folder the session ran in, from the transcript itself. */
	cwd?: string;
}

/**
 * Every Claude Code session transcript on this machine, with the folder it
 * ran in. Folder names under projects/ are a lossy encoding of the path
 * ("D:\shop-api" and "D:\shop\api" encode alike), so each transcript's own
 * recorded cwd is used, read from its first lines only; matching decides
 * which transcripts are parsed in full.
 */
export function listTranscripts(
	root: string = claudeProjectsRoot(),
): TranscriptRef[] {
	if (!existsSync(root)) return [];
	const refs: TranscriptRef[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(root, entry.name);
		let names: string[];
		try {
			names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const name of names) {
			const path = join(dir, name);
			refs.push({ path, cwd: headCwd(path) });
		}
	}
	return refs;
}

/** A human label for how a session was run. */
export function entrypointLabel(entrypoint: string | undefined): string {
	switch (entrypoint) {
		case "claude-desktop":
			return "Claude desktop app (Code)";
		case "cli":
			return "Claude Code CLI";
		case "sdk-cli":
			return "Headless run (claude -p, e.g. an ADE task stage)";
		case undefined:
			return "Claude Code";
		default:
			return `Claude Code (${entrypoint})`;
	}
}
