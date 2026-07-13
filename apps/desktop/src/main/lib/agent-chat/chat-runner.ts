import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { agentMessages } from "@superset/local-db";
import { getAgentHome } from "main/lib/agent-home";
import { findRealBinary } from "main/lib/agent-setup/utils";
import { localDb } from "main/lib/local-db";

/**
 * Headless chat with an agent: each turn runs the agent's CLI in print mode
 * (`claude -p --output-format stream-json`) inside its worktree, resuming the
 * same CLI session so the conversation has continuity. This drives the SAME
 * binary and login the terminal sessions use — subscription auth, memory
 * bridges, and worktree context all carry over. Transcript persistence lives
 * in agentMessages (conversationId "chat:<workspaceId>").
 */

export interface AgentChatEvent {
	workspaceId: string;
	type: "text" | "tool" | "done" | "error";
	/** Present for type "text" (a completed text block) and "error". */
	text?: string;
	/** Present for type "tool". */
	toolName?: string;
}

export const chatEvents = new EventEmitter();

const running = new Map<string, ChildProcess>();

const CHAT_SESSION_FILE = ".chat-session.json";

export function chatConversationId(workspaceId: string): string {
	return `chat:${workspaceId}`;
}

export function isChatRunning(workspaceId: string): boolean {
	return running.has(workspaceId);
}

function readChatSessionId(workspaceId: string): string | null {
	try {
		const raw = readFileSync(
			join(getAgentHome(workspaceId), CHAT_SESSION_FILE),
			"utf8",
		);
		const parsed = JSON.parse(raw);
		return typeof parsed?.sessionId === "string" ? parsed.sessionId : null;
	} catch {
		return null;
	}
}

function writeChatSessionId(workspaceId: string, sessionId: string): void {
	try {
		writeFileSync(
			join(getAgentHome(workspaceId), CHAT_SESSION_FILE),
			JSON.stringify({ sessionId }),
			"utf8",
		);
	} catch (error) {
		console.warn("[agent-chat] Could not persist chat session id:", error);
	}
}

function persistMessage({
	workspaceId,
	agentName,
	role,
	content,
}: {
	workspaceId: string;
	agentName: string;
	role: "user" | "assistant";
	content: string;
}): void {
	localDb
		.insert(agentMessages)
		.values({
			conversationId: chatConversationId(workspaceId),
			agentName,
			workspaceId,
			role,
			content,
		})
		.run();
}

export function stopChat(workspaceId: string): void {
	const child = running.get(workspaceId);
	if (child) {
		child.kill("SIGTERM");
		running.delete(workspaceId);
	}
}

/**
 * Run one chat turn. Persists the user message immediately, streams CLI
 * events through chatEvents, and persists the assistant reply on completion.
 * Throws if a turn is already in flight for this agent.
 */
export function sendChatMessage({
	workspaceId,
	agentName,
	worktreePath,
	prompt,
}: {
	workspaceId: string;
	agentName: string;
	worktreePath: string;
	prompt: string;
}): void {
	if (running.has(workspaceId)) {
		throw new Error("This agent is still replying — wait or stop the turn.");
	}

	const claudeBin = findRealBinary("claude");
	if (!claudeBin) {
		throw new Error("Claude Code CLI not found — install it to use chat.");
	}

	persistMessage({ workspaceId, agentName, role: "user", content: prompt });

	const sessionId = readChatSessionId(workspaceId);
	const args = [
		"-p",
		prompt,
		"--output-format",
		"stream-json",
		"--verbose",
		"--dangerously-skip-permissions",
	];
	if (sessionId) {
		args.push("--resume", sessionId);
	}

	const child = spawn(claudeBin, args, {
		cwd: worktreePath,
		env: { ...process.env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	running.set(workspaceId, child);

	const emit = (event: Omit<AgentChatEvent, "workspaceId">) =>
		chatEvents.emit("event", {
			workspaceId,
			...event,
		} satisfies AgentChatEvent);

	const assistantParts: string[] = [];
	let stderrTail = "";

	const rl = createInterface({ input: child.stdout! });
	rl.on("line", (line) => {
		if (!line.trim()) return;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		if (typeof event.session_id === "string") {
			writeChatSessionId(workspaceId, event.session_id);
		}

		if (event.type === "assistant") {
			const message = event.message as
				| { content?: Array<Record<string, unknown>> }
				| undefined;
			for (const block of message?.content ?? []) {
				if (block.type === "text" && typeof block.text === "string") {
					assistantParts.push(block.text);
					emit({ type: "text", text: block.text });
				} else if (
					block.type === "tool_use" &&
					typeof block.name === "string"
				) {
					emit({ type: "tool", toolName: block.name });
				}
			}
		}
	});

	child.stderr?.on("data", (chunk: Buffer) => {
		stderrTail = (stderrTail + chunk.toString()).slice(-2000);
	});

	child.on("close", (code) => {
		running.delete(workspaceId);
		const reply = assistantParts.join("").trim();
		if (reply) {
			persistMessage({
				workspaceId,
				agentName,
				role: "assistant",
				content: reply,
			});
		}
		if (code === 0 || reply) {
			emit({ type: "done" });
		} else {
			emit({
				type: "error",
				text: stderrTail.trim() || `Chat turn failed (exit ${code})`,
			});
		}
	});

	child.on("error", (error) => {
		running.delete(workspaceId);
		emit({ type: "error", text: error.message });
	});
}
