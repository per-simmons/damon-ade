import { formatSmartRoutingPlan } from "./agent-router";
import {
	AGENT_CAPABILITY_REGISTRY,
	compactTaskDescription,
	selectAgentRoute,
} from "./agent-routing";

export const AGENT_TYPES = [
	"orchestrator",
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
	orchestrator: "Orchestrator",
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

export const AGENT_PRESET_COMMANDS: Record<AgentType, string[]> = {
	orchestrator: [
		"claude --model claude-fable-5 --dangerously-skip-permissions",
	],
	claude: ["claude --dangerously-skip-permissions"],
	codex: [
		'codex --model gpt-5.5 -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true',
	],
	gemini: ["gemini --yolo"],
	opencode: ["opencode"],
	copilot: ["copilot --allow-all"],
	"cursor-agent": ["cursor-agent"],
	kimi: [
		'ANTHROPIC_BASE_URL="https://openrouter.ai/api" ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY" ANTHROPIC_API_KEY="" claude --model moonshotai/kimi-k2.7-code --dangerously-skip-permissions',
	],
	minimax: [
		'ANTHROPIC_BASE_URL="https://openrouter.ai/api" ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY" ANTHROPIC_API_KEY="" claude --model minimax/minimax-m3 --dangerously-skip-permissions',
	],
	glm: [
		'ANTHROPIC_BASE_URL="https://openrouter.ai/api" ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY" ANTHROPIC_API_KEY="" claude --model z-ai/glm-5.2 --dangerously-skip-permissions',
	],
};

export const AGENT_PRESET_DESCRIPTIONS: Record<AgentType, string> = {
	orchestrator:
		"Claude Fable 5 coordinator: specialist routing, skills, fallback, usage estimates, and token-cut",
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
	const { description, notice } = compactTaskDescription(task.description);

	return `You are working on task "${task.title}" (${task.slug}).

${metadata}
${notice ? `\n${notice}` : ""}

## Task Description

${description}

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

function buildOrchestratorPrompt(task: TaskInput): string {
	const route = selectAgentRoute(task);
	const basePrompt = buildPrompt(task);
	const primary = AGENT_CAPABILITY_REGISTRY[route.primary];
	const delegates = route.delegates
		.map((agent) => {
			const profile = AGENT_CAPABILITY_REGISTRY[agent];
			return `- ${profile.label}: ${profile.bestFor.join(", ")}. ${profile.notes}`;
		})
		.join("\n");
	const registry = Object.entries(AGENT_CAPABILITY_REGISTRY)
		.map(
			([agent, profile]) =>
				`- ${profile.label} (${agent}): ${profile.capabilities.join(", ")}. ${profile.notes}`,
		)
		.join("\n");

	return `You are ADE Orchestrator, a coordinator agent that can command specialist coding agents instead of doing every step manually.

## Routing Decision

- Intent: ${route.intent}
- Primary specialist: ${primary.label}
- Supporting specialists: ${route.delegates.map((agent) => AGENT_CAPABILITY_REGISTRY[agent].label).join(", ")}
${route.reasons.map((reason) => `- ${reason}`).join("\n")}
${route.tokenCutNotice ? `- ${route.tokenCutNotice}` : ""}

${formatSmartRoutingPlan(route.smartRoutingPlan)}

## Available Specialists

${registry}

## Orchestration Rules

1. Start by inspecting the repo yourself so delegation is grounded in facts.
2. Plan big, execute small: own the global plan and final judgment, but split token-heavy reading and mechanical execution into focused worker briefs with an observable result.
3. Give each worker only the context, files, tools, constraints, and validation it needs. Keep raw pages, large logs, and broad file dumps in the worker's context; request a distilled report with evidence, file references, commands, uncertainties, and the next recommended action.
4. Run independent briefs in parallel. After spawning workers, wait for every expected report before drawing a conclusion. If a worker returns only a rate-limit, timeout, or infrastructure failure, retry that brief with a fresh fallback worker.
5. Use the primary specialist for the main implementation path, then fall through the tiered chain if quota, credentials, provider health, or cost limits block progress.
6. Use combo mode exactly like 9router: fallback tries agents in order; fusion fans out to the panel and uses the judge to synthesize the final decision.
7. Track rough input/output token usage while delegating. Prefer subscription/included agents first, cheap agents second, and free/local emergency agents last.
8. Delegate when it improves quality, speed, coverage, or context isolation. Launch another CLI in a terminal when useful, then verify its report against the repository before accepting it.
9. You are Claude Fable 5, the coordinator and final judge. Prefer Codex for concrete edits and verification, Sonnet 5/Claude for fast agentic work and review, Gemini for broad context, and Kimi/MiniMax/GLM for long or cost-sensitive context if credentials are available.
10. Before copying large diffs, logs, search results, or file dumps into another agent, compact them with token-cut style summaries: keep changed/error lines, cap repetitive output, and preserve filenames, line numbers, and commands.
11. Finish with one coherent implementation, reconcile conflicts using evidence rather than votes, and run the relevant validation.

## Worker Brief Contract

For each delegated unit, provide: one narrow objective, the minimum relevant context, allowed scope, expected artifact, exact validation, and a stop condition. Require the worker to return a compact report instead of its raw context. This is the ADE adaptation of Anthropic's coordinator pattern: use the strongest model for planning and synthesis, and smaller or cheaper models for bounded execution.

${delegates ? `## Suggested Delegates\n\n${delegates}\n\n` : ""}${basePrompt}`;
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
	orchestrator: (prompt, delimiter) =>
		buildHeredoc(
			prompt,
			delimiter,
			"claude --model claude-fable-5 --dangerously-skip-permissions",
		),
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
		buildHeredoc(
			prompt,
			delimiter,
			'ANTHROPIC_BASE_URL="https://openrouter.ai/api" ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY" ANTHROPIC_API_KEY="" claude --model moonshotai/kimi-k2.7-code --dangerously-skip-permissions',
		),
	minimax: (prompt, delimiter) =>
		buildHeredoc(
			prompt,
			delimiter,
			'ANTHROPIC_BASE_URL="https://openrouter.ai/api" ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY" ANTHROPIC_API_KEY="" claude --model minimax/minimax-m3 --dangerously-skip-permissions',
		),
	glm: (prompt, delimiter) =>
		buildHeredoc(
			prompt,
			delimiter,
			'ANTHROPIC_BASE_URL="https://openrouter.ai/api" ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY" ANTHROPIC_API_KEY="" claude --model z-ai/glm-5.2 --dangerously-skip-permissions',
		),
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
	const prompt =
		agent === "orchestrator"
			? buildOrchestratorPrompt(task)
			: buildPrompt(task);
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
