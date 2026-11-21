/**
 * Project history: earlier conversations a user links to an ADE project, kept
 * as read-only copies so tasks can draw on them.
 *
 * Three different things, never treated as one:
 * - a repository (local folder, optionally with a GitHub remote): the ADE project;
 * - a Claude Code session (desktop Code tab or CLI): a local transcript with
 *   the working directory it ran in, so it can be matched to a repository;
 * - a Claude app chat (claude.ai or the desktop/mobile chat, optionally in a
 *   Claude Project): readable only from the user's official data export, and
 *   carrying no repository information, so the user confirms the association.
 */

export type MessageRole = "user" | "assistant";

export interface HistoryMessage {
	role: MessageRole;
	text: string;
	at?: string;
}

export type ConversationOrigin =
	| {
			kind: "claude-code";
			sessionId: string;
			/** The original transcript (never written by ADE). */
			transcriptPath: string;
			cwd?: string;
			branch?: string;
			/** How the session was started: "claude-desktop", "cli", "sdk-cli"... */
			entrypoint?: string;
	  }
	| {
			kind: "claude-export";
			conversationUuid: string;
			/** The export file or folder the user selected. */
			exportPath: string;
			projectUuid?: string;
			projectName?: string;
	  }
	| {
			kind: "transcript-file";
			/** A transcript file the user selected. */
			path: string;
	  };

export type OriginKind = ConversationOrigin["kind"];

/** A conversation read from its original source (not yet stored). */
export interface ParsedConversation {
	origin: ConversationOrigin;
	title: string;
	createdAt?: string;
	updatedAt?: string;
	messages: HistoryMessage[];
}

export type HistoryScope =
	| { kind: "project" }
	| { kind: "worktree"; path: string };

/** Why a conversation belongs to this project. */
export type Association =
	/** The session ran in this repository (same git common dir). */
	| "same-repository"
	/** The session ran in another clone of the same remote. */
	| "same-remote"
	/** The session's folder is gone; its path was inside this project. */
	| "path"
	/** No repository information, or a different one: the user confirmed it. */
	| "user-confirmed";

export interface StoredConversation extends ParsedConversation {
	version: 1;
	/** ADE's id for the copy: stable per original conversation. */
	id: string;
	/** Hash of the copied messages, to tell an updated original apart. */
	contentHash: string;
	importedAt: string;
	refreshedAt?: string;
	/** Size and mtime of the original file when last read. */
	originStamp?: { size: number; mtimeMs: number };
	/** Tasks use it only while included. */
	included: boolean;
	scope: HistoryScope;
	association: Association;
	/** The repository it was associated with, at import. */
	repository: { root: string; remote?: string };
}

/** What the user sees about an imported copy's original. */
export type OriginStatus =
	/** The original is unchanged since the copy was made. */
	| "current"
	/** The original has changed; refresh to update the copy. */
	| "changed"
	/** The original is gone; the copy is kept. */
	| "missing";

export type ExcerptCategory =
	| "requirement"
	| "decision"
	| "attempt"
	| "problem"
	| "validation"
	| "files"
	| "context";

export interface Excerpt {
	conversationId: string;
	title: string;
	originKind: OriginKind;
	/** Index of the message in the stored copy. */
	messageIndex: number;
	role: MessageRole;
	at?: string;
	category: ExcerptCategory;
	files: string[];
	text: string;
	score: number;
}

/** What a task recorded about the history it was given. */
export interface TaskHistory {
	builtAt: string;
	/** Conversations the user removed from this task. */
	excluded: string[];
	sources: Array<{
		conversationId: string;
		title: string;
		originKind: OriginKind;
		excerpts: number;
	}>;
	excerpts: number;
}
