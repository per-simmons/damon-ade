import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { HistoryMessage, ParsedConversation } from "./types";

/**
 * Claude app chats (claude.ai, and the chat in the desktop and mobile apps)
 * have no API a personal account can read: the Compliance API is for
 * Enterprise organizations with an admin key. The supported way out is the
 * user's own data export (Settings > Privacy > Export data), a zip with the
 * account's conversations as JSON.
 *
 * Anthropic does not document the export's file layout or schema, so this
 * reads what exports contain in practice (conversations.json: a list of
 * { uuid, name, created_at, updated_at, chat_messages: [{ sender, text,
 * content, created_at }] }, and projects.json with Project names) and
 * tolerates missing fields. Whether a chat belongs to a Claude Project is
 * shown only when the export says so; nothing is guessed from titles.
 */

export class ExportError extends Error {}

export interface ExportConversation extends ParsedConversation {
	origin: Extract<ParsedConversation["origin"], { kind: "claude-export" }>;
}

export interface LoadedExport {
	/** The file or folder the user selected. */
	exportPath: string;
	conversations: ExportConversation[];
	projects: Array<{ uuid: string; name: string }>;
	/** Whether the export links chats to Projects at all. */
	hasProjectLinks: boolean;
	warnings: string[];
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
	!!value && typeof value === "object" && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value : undefined;

function readJson(path: string): unknown {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new ExportError(
			`Could not read ${basename(path)}: ${(error as Error).message}`,
		);
	}
	try {
		return JSON.parse(raw.replace(/^﻿/, ""));
	} catch {
		throw new ExportError(
			`${basename(path)} is not valid JSON. Select the conversations.json from an unmodified Claude export.`,
		);
	}
}

function findFile(dir: string, name: string, depth = 2): string | undefined {
	const direct = join(dir, name);
	if (existsSync(direct)) return direct;
	if (depth === 0) return undefined;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const found = findFile(join(dir, entry.name), name, depth - 1);
		if (found) return found;
	}
	return undefined;
}

function messageText(message: Json): string {
	const content = message.content;
	if (Array.isArray(content)) {
		const parts = content
			.filter(isObject)
			.filter(
				(block) => block.type === "text" && typeof block.text === "string",
			)
			.map((block) => block.text as string);
		if (parts.length) return parts.join("\n").trim();
	}
	return (str(message.text) ?? "").trim();
}

function toMessages(raw: unknown): HistoryMessage[] {
	if (!Array.isArray(raw)) return [];
	const messages: HistoryMessage[] = [];
	for (const item of raw) {
		if (!isObject(item)) continue;
		const sender = str(item.sender) ?? str(item.role);
		const role =
			sender === "human" || sender === "user"
				? "user"
				: sender === "assistant"
					? "assistant"
					: undefined;
		if (!role) continue;
		const text = messageText(item);
		if (!text) continue;
		messages.push({ role, text, at: str(item.created_at) });
	}
	return messages;
}

/** Unzip with the system tar (bsdtar on Windows 10+ and macOS reads zips). */
function extractZip(zipPath: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ade-claude-export-"));
	const result = spawnSync("tar", ["-xf", zipPath, "-C", dir], {
		windowsHide: true,
		timeout: 120_000,
	});
	if (result.status !== 0) {
		rmSync(dir, { recursive: true, force: true });
		throw new ExportError(
			"Could not open this zip here. Extract it, then select the extracted folder or its conversations.json.",
		);
	}
	return dir;
}

/** Read a Claude data export: its zip, its folder, or its conversations.json. */
export function loadClaudeExport(exportPath: string): LoadedExport {
	if (!existsSync(exportPath)) {
		throw new ExportError("The selected export no longer exists");
	}
	let scratch: string | undefined;
	try {
		let conversationsFile: string | undefined;
		let projectsFile: string | undefined;
		const stat = statSync(exportPath);
		if (stat.isDirectory()) {
			conversationsFile = findFile(exportPath, "conversations.json");
			if (conversationsFile)
				projectsFile = findFile(dirname(conversationsFile), "projects.json", 0);
		} else if (extname(exportPath).toLowerCase() === ".zip") {
			scratch = extractZip(exportPath);
			conversationsFile = findFile(scratch, "conversations.json");
			if (conversationsFile)
				projectsFile = findFile(dirname(conversationsFile), "projects.json", 0);
		} else {
			conversationsFile = exportPath;
			const sibling = join(dirname(exportPath), "projects.json");
			if (existsSync(sibling)) projectsFile = sibling;
		}
		if (!conversationsFile) {
			throw new ExportError(
				"No conversations.json found. Select the zip from Claude's Settings > Privacy > Export data, its extracted folder, or the conversations.json in it.",
			);
		}

		const data = readJson(conversationsFile);
		const list = Array.isArray(data)
			? data
			: isObject(data) && Array.isArray(data.conversations)
				? data.conversations
				: undefined;
		if (!list) {
			throw new ExportError(
				"This file is not a Claude conversation export (expected a list of conversations).",
			);
		}

		const warnings: string[] = [];
		const projects: LoadedExport["projects"] = [];
		if (projectsFile) {
			try {
				const raw = readJson(projectsFile);
				if (Array.isArray(raw)) {
					for (const item of raw) {
						if (isObject(item) && str(item.uuid)) {
							projects.push({
								uuid: item.uuid as string,
								name: str(item.name) ?? "Untitled project",
							});
						}
					}
				}
			} catch {
				warnings.push(
					"projects.json could not be read; Project names are unavailable.",
				);
			}
		}
		const projectName = new Map(projects.map((p) => [p.uuid, p.name]));

		const conversations: ExportConversation[] = [];
		let skipped = 0;
		let linked = 0;
		for (const item of list) {
			if (!isObject(item) || !str(item.uuid)) {
				skipped++;
				continue;
			}
			const messageList = item.chat_messages ?? item.messages;
			if (!Array.isArray(messageList)) {
				skipped++;
				continue;
			}
			const project = isObject(item.project) ? item.project : undefined;
			const projectUuid = str(item.project_uuid) ?? str(project?.uuid);
			if (projectUuid) linked++;
			const messages = toMessages(messageList);
			conversations.push({
				origin: {
					kind: "claude-export",
					conversationUuid: item.uuid as string,
					exportPath,
					projectUuid,
					projectName: projectUuid
						? (str(project?.name) ?? projectName.get(projectUuid))
						: undefined,
				},
				title:
					str(item.name) ??
					(messages[0]?.text.split("\n")[0].slice(0, 100) || "Untitled chat"),
				createdAt: str(item.created_at),
				updatedAt: str(item.updated_at),
				messages,
			});
		}
		if (conversations.length === 0 && list.length > 0) {
			throw new ExportError(
				"No conversations could be read from this file. It does not match the Claude export format.",
			);
		}
		if (skipped > 0) {
			warnings.push(
				`${skipped} entr${skipped === 1 ? "y" : "ies"} could not be read and were skipped.`,
			);
		}
		if (linked === 0) {
			warnings.push(
				"This export does not say which Claude Project each chat belongs to, so chats are listed without Projects.",
			);
		}
		conversations.sort((a, b) =>
			(b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
		);
		return {
			exportPath,
			conversations,
			projects,
			hasProjectLinks: linked > 0,
			warnings,
		};
	} finally {
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	}
}
