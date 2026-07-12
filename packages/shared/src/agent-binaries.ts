import type { AgentType } from "./agent-command";

/**
 * The external CLIs ADE shells out to. Several agent runtimes share one binary:
 * the OpenRouter-proxied runtimes (kimi / minimax / glm) all drive the `claude`
 * CLI (see AGENT_PRESET_COMMANDS), so availability of those runtimes gates on
 * `claude` being installed.
 */
export type AgentBinary = "claude" | "codex" | "opencode" | "gemini" | "git";

/**
 * Maps an agent runtime to the external binary its launch command invokes. Used
 * to answer "is this model runnable on this machine?" without duplicating the
 * command-parsing logic in AGENT_PRESET_COMMANDS.
 */
export const RUNTIME_BINARY: Record<AgentType, AgentBinary> = {
	orchestrator: "claude",
	claude: "claude",
	codex: "codex",
	gemini: "gemini",
	opencode: "opencode",
	// copilot / cursor-agent aren't offered in the pickers yet; map them to their
	// own binary name so a future availability check is a one-line change.
	copilot: "codex",
	"cursor-agent": "codex",
	kimi: "claude",
	minimax: "claude",
	glm: "claude",
};

export interface BinaryInstallInfo {
	/** Human name shown in UI ("Claude Code", "Git"). */
	label: string;
	/** Primary one-line install command to copy/paste. */
	command: string;
	/** Docs / download URL. */
	url: string;
	/** Optional secondary hint (alternate installer, prerequisite note). */
	note?: string;
}

/**
 * Single source of truth for how to install each external binary. Consumed by
 * the renderer (not-detected dialogs), the create-agent git preflight, and the
 * terminal wrapper's missing-binary message so all three stay in sync.
 */
export const BINARY_INSTALL: Record<AgentBinary, BinaryInstallInfo> = {
	claude: {
		label: "Claude Code",
		command: "npm i -g @anthropic-ai/claude-code",
		url: "https://claude.com/claude-code",
	},
	codex: {
		label: "Codex CLI",
		command: "npm i -g @openai/codex",
		url: "https://developers.openai.com/codex/cli",
	},
	opencode: {
		label: "OpenCode",
		command: "npm i -g opencode-ai",
		url: "https://opencode.ai/docs",
		note: "Or: curl -fsSL https://opencode.ai/install | bash",
	},
	gemini: {
		label: "Gemini CLI",
		command: "npm i -g @google/gemini-cli",
		url: "https://github.com/google-gemini/gemini-cli",
	},
	git: {
		label: "Git",
		command: "xcode-select --install",
		url: "https://git-scm.com/downloads",
		note: "On macOS, Git ships with Apple's Command Line Tools.",
	},
};

/** The binaries surfaced by the runtime-availability query. */
export const CHECKED_BINARIES = [
	"claude",
	"codex",
	"opencode",
	"git",
] as const satisfies readonly AgentBinary[];

export type CheckedBinary = (typeof CHECKED_BINARIES)[number];

export type RuntimeAvailability = Record<CheckedBinary, boolean>;
