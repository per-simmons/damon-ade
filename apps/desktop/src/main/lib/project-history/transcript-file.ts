import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { sessionConversation } from "./claude-code-sessions";
import type { HistoryMessage, MessageRole, ParsedConversation } from "./types";

/**
 * A single transcript the user selects: a Claude Code session file (.jsonl,
 * e.g. copied from another machine), or a text/Markdown transcript saved
 * from a chat. Speaker lines such as "User:", "Human:", "Assistant:",
 * "Claude:" (optionally bold or as headings) split the text into turns; a
 * file without them is kept as one block of notes.
 */

const MAX_BYTES = 20 * 1024 * 1024;

/** "User: text", "**Claude:** text", or a heading line "## Assistant". */
const LABELLED =
	/^\s*(?:\*\*)?(user|human|you|me|assistant|claude|ai)(?:\*\*)?\s*:(?:\*\*)?\s*(.*)$/i;
const HEADING =
	/^\s*(?:#{1,6}\s*|\*\*)(user|human|you|me|assistant|claude|ai)(?:\*\*)?\s*:?\s*$/i;

function roleOf(word: string): MessageRole {
	return /^(user|human|you|me)$/i.test(word) ? "user" : "assistant";
}

export function parseTextTranscript(text: string): HistoryMessage[] {
	const messages: HistoryMessage[] = [];
	let current: HistoryMessage | undefined;
	for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
		const match = LABELLED.exec(line) ?? HEADING.exec(line);
		if (match) {
			if (current?.text.trim()) messages.push(current);
			current = { role: roleOf(match[1]), text: match[2] ?? "" };
			continue;
		}
		if (current) current.text += `${current.text ? "\n" : ""}${line}`;
		else current = { role: "user", text: line };
	}
	if (current?.text.trim()) messages.push(current);
	return messages.map((m) => ({ ...m, text: m.text.trim() }));
}

export function loadTranscriptFile(path: string): ParsedConversation {
	const stat = statSync(path);
	if (!stat.isFile()) throw new Error("Select a transcript file");
	if (stat.size > MAX_BYTES) {
		throw new Error("This transcript is larger than 20 MB");
	}
	if (extname(path).toLowerCase() === ".jsonl") {
		const conversation = sessionConversation(path);
		if (conversation.messages.length === 0) {
			throw new Error(
				"No conversation found in this file; it does not look like a Claude Code transcript.",
			);
		}
		return conversation;
	}
	const text = readFileSync(path, "utf8");
	if (text.includes("\0")) throw new Error("This is not a text transcript");
	const messages = parseTextTranscript(text);
	if (messages.length === 0) throw new Error("The transcript is empty");
	return {
		origin: { kind: "transcript-file", path },
		title: basename(path, extname(path)),
		updatedAt: stat.mtime.toISOString(),
		messages,
	};
}
