import type { AgentType, TaskInput } from "./agent-command";
import {
	type AgentSmartRoutingPlan,
	buildSmartRoutingPlan,
} from "./agent-router";
import { formatTokenCutNotice, tokenCut } from "./token-cut";

export type AgentCapability =
	| "implementation"
	| "debugging"
	| "review"
	| "architecture"
	| "frontend"
	| "windows"
	| "research"
	| "large-context"
	| "cheap-fallback";

export type AgentTaskIntent =
	| "architecture"
	| "frontend"
	| "debugging"
	| "windows"
	| "research"
	| "large-context"
	| "implementation";

export interface AgentCapabilityProfile {
	label: string;
	capabilities: AgentCapability[];
	bestFor: string[];
	notes: string;
}

export interface AgentRoute {
	coordinator: AgentType;
	primary: SpecialistAgentType;
	delegates: SpecialistAgentType[];
	intent: AgentTaskIntent;
	reasons: string[];
	tokenCutNotice: string | null;
	smartRoutingPlan: AgentSmartRoutingPlan;
}

export type SpecialistAgentType = Exclude<AgentType, "orchestrator">;

export const AGENT_CAPABILITY_REGISTRY: Record<
	SpecialistAgentType,
	AgentCapabilityProfile
> = {
	claude: {
		label: "Claude",
		capabilities: ["architecture", "review", "implementation"],
		bestFor: ["architecture", "refactors", "code review", "careful reasoning"],
		notes: "Use when the task needs design judgment or deep review.",
	},
	codex: {
		label: "Codex",
		capabilities: ["implementation", "debugging", "windows", "frontend"],
		bestFor: ["repo edits", "tests", "terminal-heavy work", "Windows fixes"],
		notes: "Use as the hands-on executor for code changes and verification.",
	},
	gemini: {
		label: "Gemini",
		capabilities: ["research", "large-context", "review"],
		bestFor: ["large context reads", "docs", "cross-checking approaches"],
		notes: "Use to scan broad context or compare options.",
	},
	opencode: {
		label: "OpenCode",
		capabilities: ["implementation", "debugging"],
		bestFor: ["lightweight local coding sessions", "open-source workflows"],
		notes: "Use when a simple local agent is enough.",
	},
	copilot: {
		label: "Copilot",
		capabilities: ["implementation", "frontend"],
		bestFor: ["small implementation assists", "GitHub-linked coding"],
		notes: "Use when the installed Copilot agent is available.",
	},
	"cursor-agent": {
		label: "Cursor Agent",
		capabilities: ["implementation", "frontend"],
		bestFor: ["Cursor-native repo workflows", "UI iteration"],
		notes: "Use when the user already works inside Cursor.",
	},
	kimi: {
		label: "Kimi K2.7",
		capabilities: ["large-context", "cheap-fallback", "implementation"],
		bestFor: ["long-context coding", "OpenRouter fallback"],
		notes: "Requires OpenRouter credentials.",
	},
	minimax: {
		label: "MiniMax M3",
		capabilities: ["large-context", "cheap-fallback"],
		bestFor: ["long-context fallback", "cost-sensitive backup"],
		notes: "Requires OpenRouter credentials.",
	},
	glm: {
		label: "GLM 5.2",
		capabilities: ["cheap-fallback", "implementation"],
		bestFor: ["budget fallback", "quick implementation checks"],
		notes: "Requires OpenRouter credentials.",
	},
};

const INTENT_KEYWORDS: Record<AgentTaskIntent, string[]> = {
	architecture: [
		"architecture",
		"arquitetura",
		"orchestrator",
		"orquestrador",
		"router",
		"refactor",
		"design",
		"system",
	],
	frontend: [
		"ui",
		"ux",
		"frontend",
		"react",
		"css",
		"tailwind",
		"renderer",
		"component",
		"button",
	],
	debugging: [
		"bug",
		"fix",
		"error",
		"crash",
		"failing",
		"test",
		"debug",
		"broken",
	],
	windows: ["windows", "win32", "powershell", "cmd", "nsis", ".exe"],
	research: ["research", "docs", "documenta", "compare", "investiga", "readme"],
	"large-context": [
		"large",
		"logs",
		"diff",
		"context",
		"token",
		"tokens",
		"muitos",
	],
	implementation: ["build", "implement", "add", "create", "integrate", "fazer"],
};

export function selectAgentRoute(task: TaskInput): AgentRoute {
	const text = [
		task.title,
		task.description,
		task.priority,
		task.statusName,
		task.labels?.join(" "),
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();

	const intent = detectIntent(text);
	const descriptionCut = tokenCut(task.description ?? "");
	const tokenCutNotice = descriptionCut.changed
		? formatTokenCutNotice(descriptionCut)
		: null;

	switch (intent) {
		case "architecture":
			return route(
				"claude",
				["codex", "gemini"],
				intent,
				[
					"Architecture-heavy task: start with Claude for design judgment.",
					"Use Codex as executor and Gemini as a broad-context reviewer when useful.",
				],
				tokenCutNotice,
				task,
			);
		case "frontend":
			return route(
				"codex",
				["claude", "cursor-agent"],
				intent,
				[
					"Frontend task: Codex is the primary executor for renderer changes.",
					"Use Claude for design review and Cursor Agent if UI iteration benefits from it.",
				],
				tokenCutNotice,
				task,
			);
		case "debugging":
			return route(
				"codex",
				["claude", "opencode"],
				intent,
				[
					"Debugging task: Codex should reproduce, edit, and run tests first.",
					"Use Claude for second-pass reasoning if the failure is subtle.",
				],
				tokenCutNotice,
				task,
			);
		case "windows":
			return route(
				"codex",
				["claude"],
				intent,
				[
					"Windows task: Codex is primary because it can drive shell/test fixes.",
					"Use Claude to review cross-platform assumptions.",
				],
				tokenCutNotice,
				task,
			);
		case "research":
			return route(
				"gemini",
				["claude", "codex"],
				intent,
				[
					"Research task: Gemini is primary for broad context scanning.",
					"Use Claude for synthesis and Codex if implementation follows.",
				],
				tokenCutNotice,
				task,
			);
		case "large-context":
			return route(
				"kimi",
				["gemini", "minimax", "codex"],
				intent,
				[
					"Large-context task: prefer long-context models and cheap fallbacks.",
					"Use Codex only when concrete repo edits are needed.",
				],
				tokenCutNotice,
				task,
			);
		case "implementation":
			return route(
				"codex",
				["claude", "gemini"],
				intent,
				[
					"Implementation task: Codex should make scoped edits and verify them.",
					"Use Claude/Gemini as reviewers for larger or ambiguous changes.",
				],
				tokenCutNotice,
				task,
			);
	}
}

export function compactTaskDescription(description: string | null): {
	description: string;
	notice: string | null;
} {
	if (!description) {
		return { description: "No description provided.", notice: null };
	}
	const result = tokenCut(description);
	return {
		description: result.text,
		notice: result.changed ? formatTokenCutNotice(result) : null,
	};
}

function detectIntent(text: string): AgentTaskIntent {
	let best: AgentTaskIntent = "implementation";
	let bestScore = 0;

	for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS) as [
		AgentTaskIntent,
		string[],
	][]) {
		const score = keywords.reduce(
			(total, keyword) => total + (text.includes(keyword) ? 1 : 0),
			0,
		);
		if (score > bestScore) {
			best = intent;
			bestScore = score;
		}
	}

	return best;
}

function route(
	primary: SpecialistAgentType,
	delegates: SpecialistAgentType[],
	intent: AgentTaskIntent,
	reasons: string[],
	tokenCutNotice: string | null,
	currentTask: TaskInput,
): AgentRoute {
	const smartRoutingPlan = buildSmartRoutingPlan({
		task: currentTask,
		intent,
		primary,
		delegates,
	});
	return {
		coordinator: "orchestrator",
		primary,
		delegates,
		intent,
		reasons,
		tokenCutNotice,
		smartRoutingPlan,
	};
}
