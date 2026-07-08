export const AGENT_TYPES = [
	"claude",
	"codex",
	"gemini",
	"opencode",
	"copilot",
	"cursor-agent",
	"kimi",
	"minimax",
	"glm",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

export const AGENT_LABELS: Record<AgentType, string> = {
	claude: "Claude",
	codex: "Codex",
	gemini: "Gemini",
	opencode: "OpenCode",
	copilot: "Copilot",
	"cursor-agent": "Cursor Agent",
	kimi: "Kimi K2.7",
	minimax: "MiniMax M3",
	glm: "GLM 5.2",
};

/** OpenRouter model slugs for the Claude-Code-proxied runtimes. */
const OPENROUTER_MODELS = {
	kimi: "moonshotai/kimi-k2.7-code",
	minimax: "minimax/minimax-m3",
	glm: "z-ai/glm-5.2",
} as const;

/**
 * Launch command for an OpenRouter-proxied runtime (Claude Code pointed at
 * OpenRouter). The env-var prefix is shell-syntax-specific: POSIX inline
 * assignments don't parse in cmd/PowerShell, so the Windows variant routes
 * through `cmd /c` (which PowerShell can also run) and uses cmd's `set`.
 * The no-space `&&` chaining is deliberate — `set VAR=value && next` would
 * store a trailing space in the value.
 */
function buildOpenRouterCommand(model: string, windows: boolean): string {
	const claudeArgs = `claude --model ${model} --dangerously-skip-permissions`;
	if (windows) {
		return `cmd /c "set ANTHROPIC_BASE_URL=https://openrouter.ai/api&&set ANTHROPIC_AUTH_TOKEN=%OPENROUTER_API_KEY%&&set ANTHROPIC_API_KEY=&&${claudeArgs}"`;
	}
	return `ANTHROPIC_BASE_URL="https://openrouter.ai/api" ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY" ANTHROPIC_API_KEY="" ${claudeArgs}`;
}

export const AGENT_PRESET_COMMANDS: Record<AgentType, string[]> = {
	claude: ["claude --dangerously-skip-permissions"],
	codex: [
		'codex --model gpt-5.5 -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true',
	],
	gemini: ["gemini --yolo"],
	opencode: ["opencode"],
	copilot: ["copilot --allow-all"],
	"cursor-agent": ["cursor-agent"],
	kimi: [buildOpenRouterCommand(OPENROUTER_MODELS.kimi, false)],
	minimax: [buildOpenRouterCommand(OPENROUTER_MODELS.minimax, false)],
	glm: [buildOpenRouterCommand(OPENROUTER_MODELS.glm, false)],
};

/**
 * Platform-aware variant of AGENT_PRESET_COMMANDS. Identical except the
 * OpenRouter-proxied runtimes, whose env-var prefix must match the shell.
 * Renderer callers should pass the platform from `window.getPlatform`.
 */
export function getAgentPresetCommands({
	windows,
}: {
	windows: boolean;
}): Record<AgentType, string[]> {
	if (!windows) return AGENT_PRESET_COMMANDS;
	return {
		...AGENT_PRESET_COMMANDS,
		kimi: [buildOpenRouterCommand(OPENROUTER_MODELS.kimi, true)],
		minimax: [buildOpenRouterCommand(OPENROUTER_MODELS.minimax, true)],
		glm: [buildOpenRouterCommand(OPENROUTER_MODELS.glm, true)],
	};
}

export const AGENT_PRESET_DESCRIPTIONS: Record<AgentType, string> = {
	claude: "Danger mode: All permissions auto-approved",
	codex: "Danger mode: All permissions auto-approved",
	gemini: "Danger mode: All permissions auto-approved",
	opencode: "OpenCode: Open-source AI coding agent",
	copilot: "Danger mode: All permissions auto-approved",
	"cursor-agent": "Cursor AI agent for terminal-based coding assistance",
	kimi: "Kimi K2.7 via Claude Code + OpenRouter",
	minimax: "MiniMax M3 via Claude Code + OpenRouter",
	glm: "GLM 5.2 via Claude Code + OpenRouter",
};

export interface TaskInput {
	id: string;
	slug: string;
	title: string;
	description: string | null;
	priority: string;
	statusName: string | null;
	labels: string[] | null;
}

function buildPrompt(task: TaskInput): string {
	const metadata = [
		`Priority: ${task.priority}`,
		task.statusName && `Status: ${task.statusName}`,
		task.labels?.length && `Labels: ${task.labels.join(", ")}`,
	]
		.filter(Boolean)
		.join("\n");

	return `You are working on task "${task.title}" (${task.slug}).

${metadata}

## Task Description

${task.description || "No description provided."}

## Instructions

You are running fully autonomously. Do not ask questions or wait for user feedback — make all decisions independently based on the codebase and task description.

1. Explore the codebase to understand the relevant code and architecture
2. Create a detailed execution plan for this task including:
   - Purpose and scope of the changes
   - Key assumptions
   - Concrete implementation steps with specific files to modify
   - How to validate the changes work correctly
3. Implement the plan
4. Verify your changes work correctly (run relevant tests, typecheck, lint)
5. When done, use the Superset MCP \`update_task\` tool to update task "${task.id}" with a summary of what was done`;
}

function buildHeredoc(
	prompt: string,
	delimiter: string,
	command: string,
	suffix?: string,
): string {
	const closing = suffix ? `)" ${suffix}` : ')"';
	return [
		`${command} "$(cat <<'${delimiter}'`,
		prompt,
		delimiter,
		closing,
	].join("\n");
}

const AGENT_COMMANDS: Record<
	AgentType,
	(prompt: string, delimiter: string) => string
> = {
	claude: (prompt, delimiter) =>
		buildHeredoc(prompt, delimiter, "claude --dangerously-skip-permissions"),
	codex: (prompt, delimiter) =>
		buildHeredoc(
			prompt,
			delimiter,
			'codex --model gpt-5.5 -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access --',
		),
	gemini: (prompt, delimiter) =>
		buildHeredoc(prompt, delimiter, "gemini --yolo"),
	opencode: (prompt, delimiter) =>
		buildHeredoc(prompt, delimiter, "opencode --prompt"),
	copilot: (prompt, delimiter) =>
		buildHeredoc(prompt, delimiter, "copilot -i", "--yolo"),
	"cursor-agent": (prompt, delimiter) =>
		buildHeredoc(prompt, delimiter, "cursor-agent --yolo"),
	kimi: (prompt, delimiter) =>
		buildHeredoc(prompt, delimiter, 'ANTHROPIC_BASE_URL="https://openrouter.ai/api" ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY" ANTHROPIC_API_KEY="" claude --model moonshotai/kimi-k2.7-code --dangerously-skip-permissions'),
	minimax: (prompt, delimiter) =>
		buildHeredoc(prompt, delimiter, 'ANTHROPIC_BASE_URL="https://openrouter.ai/api" ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY" ANTHROPIC_API_KEY="" claude --model minimax/minimax-m3 --dangerously-skip-permissions'),
	glm: (prompt, delimiter) =>
		buildHeredoc(prompt, delimiter, 'ANTHROPIC_BASE_URL="https://openrouter.ai/api" ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY" ANTHROPIC_API_KEY="" claude --model z-ai/glm-5.2 --dangerously-skip-permissions'),
};

export function buildAgentPromptCommand({
	prompt,
	randomId,
	agent = "claude",
}: {
	prompt: string;
	randomId: string;
	agent?: AgentType;
}): string {
	let delimiter = `SUPERSET_PROMPT_${randomId.replaceAll("-", "")}`;
	while (prompt.includes(delimiter)) {
		delimiter = `${delimiter}_X`;
	}
	const builder = AGENT_COMMANDS[agent];
	return builder(prompt, delimiter);
}

export function buildAgentCommand({
	task,
	randomId,
	agent = "claude",
}: {
	task: TaskInput;
	randomId: string;
	agent?: AgentType;
}): string {
	const prompt = buildPrompt(task);
	return buildAgentPromptCommand({ prompt, randomId, agent });
}

/** @deprecated Use `buildAgentCommand` instead */
export function buildClaudeCommand({
	task,
	randomId,
}: {
	task: TaskInput;
	randomId: string;
}): string {
	return buildAgentCommand({ task, randomId, agent: "claude" });
}
