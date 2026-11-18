/**
 * Shared notification types used by both main and renderer processes.
 * Kept in shared/ to avoid cross-boundary imports.
 */

export interface NotificationIds {
	paneId?: string;
	tabId?: string;
	workspaceId?: string;
}

export interface AgentLifecycleEvent extends NotificationIds {
	eventType: "Start" | "Stop" | "PermissionRequest";
}

/**
 * Emitted when an agent is invoked autonomously (POST /agent/invoke). The
 * renderer opens a terminal tab in the agent's folder running `claude` with
 * `prompt` (the agent works live in a terminal on Pat's subscription).
 */
export interface AgentInvokeEvent extends NotificationIds {
	agentName: string;
	sessionId: string;
	/** The task prompt to run claude with in the agent's terminal. */
	prompt: string;
	/** The agent's folder (cwd) where the terminal/claude runs. */
	cwd: string;
	/**
	 * Optional tab title. If a tab with this title already exists in the agent's
	 * workspace it's REUSED (e.g. a fixed "Nightly maintenance" tab); otherwise a
	 * new tab is created with this title. If omitted, the tab is named with today's
	 * date (e.g. "6.17.26").
	 */
	tabTitle?: string;
	/**
	 * A specific claude session id to pin (fresh) or resume. Lets repeated invokes
	 * into the same dated tab share ONE conversation deterministically: the first
	 * invoke of the day runs `claude --session-id <id>` (fresh=true), every later
	 * one runs `claude --resume <id>` (fresh=false). Without it we fall back to
	 * plain `claude` / `claude --continue` (the latter is ambiguous).
	 */
	claudeSessionId?: string;
	/** true = start/pin a new session (--session-id); false = resume (--resume). */
	fresh?: boolean;
	/**
	 * Claude Code model for this run (`claude --model`): the request's `model`,
	 * else the agent's registry `model`. Omitted = the agent's own default.
	 */
	model?: string;
}

/**
 * Emitted when an agent streams a finding into the feed (POST /agent/message).
 * The message is persisted to the `agent_messages` table and broadcast to the
 * renderer so the feed pane updates live — ADE's local "Convex".
 */
export interface AgentMessageEvent extends NotificationIds {
	id: string;
	/** Feed channel (e.g. a Space slug). Defaults to "main". */
	conversationId: string;
	agentName: string;
	content: string;
	role: "assistant" | "user";
	metadata?: Record<string, unknown>;
	/** Epoch ms when the message was created. */
	createdAt: number;
}
