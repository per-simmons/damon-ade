import type { TaskInput } from "./agent-command";
import type { AgentTaskIntent, SpecialistAgentType } from "./agent-routing";

export type AgentRoutingTier = "subscription" | "cheap" | "free";
export type AgentComboStrategy = "fallback" | "round-robin" | "fusion";
export type AgentComboName =
	| "fable-orchestrated"
	| "premium-coding"
	| "quality-first"
	| "precision-debug"
	| "frontend-studio"
	| "deep-research"
	| "fast-tasks"
	| "budget-coding"
	| "free-coding"
	| "large-context"
	| "fusion-review";
export type QuotaWindow = "rolling-5h" | "daily" | "monthly" | "included";

export interface AgentPricing {
	inputPerMillion: number;
	outputPerMillion: number;
}

export interface AgentRouterProfile {
	agent: SpecialistAgentType;
	tier: AgentRoutingTier;
	modelId: string;
	provider: string;
	quotaWindow: QuotaWindow;
	quotaHint: string;
	pricing: AgentPricing | null;
	contextWindow: number;
}

export interface AgentCombo {
	name: string;
	description: string;
	strategy: AgentComboStrategy;
	agents: SpecialistAgentType[];
	judge?: SpecialistAgentType;
	stickyLimit?: number;
}

export interface TokenUsageEstimate {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	estimated: true;
}

export interface AgentCostEstimate {
	agent: SpecialistAgentType;
	costUsd: number;
	included: boolean;
}

export interface AgentFallbackRule {
	status?: number;
	text?: string;
	reason: string;
	cooldownMs: number;
	backoff?: boolean;
}

export interface FallbackDecision {
	shouldFallback: boolean;
	cooldownMs: number;
	reason: string;
	backoffLevel: number;
}

export interface AgentSmartRoutingPlan {
	combo: AgentCombo;
	fallbackChain: SpecialistAgentType[];
	tieredFallback: Record<AgentRoutingTier, SpecialistAgentType[]>;
	usage: TokenUsageEstimate;
	costs: AgentCostEstimate[];
	maxPaidCostUsd: number;
	quotaHints: string[];
	fallbackRules: AgentFallbackRule[];
}

const OUTPUT_TOKEN_BUFFER = 4000;
const INPUT_TOKEN_BUFFER = 2000;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

export const AGENT_ROUTER_PROFILES: Record<
	SpecialistAgentType,
	AgentRouterProfile
> = {
	claude: {
		agent: "claude",
		tier: "subscription",
		modelId: "claude-fable-5",
		provider: "Claude Code / Fable 5",
		quotaWindow: "rolling-5h",
		quotaHint:
			"Use paid subscription quota first; watch for rolling window exhaustion.",
		pricing: null,
		contextWindow: 1_000_000,
	},
	codex: {
		agent: "codex",
		tier: "subscription",
		modelId: "gpt-5.5",
		provider: "Codex CLI",
		quotaWindow: "rolling-5h",
		quotaHint: "Use OpenAI subscription quota for implementation-heavy work.",
		pricing: null,
		contextWindow: 400_000,
	},
	gemini: {
		agent: "gemini",
		tier: "subscription",
		modelId: "gemini-3.5-flash",
		provider: "Gemini CLI",
		quotaWindow: "monthly",
		quotaHint: "Good for broad context reads; track daily/monthly free quota.",
		pricing: null,
		contextWindow: 1_000_000,
	},
	copilot: {
		agent: "copilot",
		tier: "subscription",
		modelId: "github-copilot",
		provider: "GitHub Copilot",
		quotaWindow: "monthly",
		quotaHint: "Useful GitHub-linked coding fallback when installed.",
		pricing: null,
		contextWindow: 128_000,
	},
	"cursor-agent": {
		agent: "cursor-agent",
		tier: "subscription",
		modelId: "cursor-agent",
		provider: "Cursor",
		quotaWindow: "monthly",
		quotaHint: "Use for Cursor-native UI/code iteration when available.",
		pricing: null,
		contextWindow: 200_000,
	},
	kimi: {
		agent: "kimi",
		tier: "cheap",
		modelId: "moonshotai/kimi-k2.7-code",
		provider: "OpenRouter/Kimi",
		quotaWindow: "monthly",
		quotaHint: "Cheap long-context backup; requires OPENROUTER_API_KEY.",
		pricing: { inputPerMillion: 1.2, outputPerMillion: 4.8 },
		contextWindow: 262_144,
	},
	minimax: {
		agent: "minimax",
		tier: "cheap",
		modelId: "minimax/minimax-m3",
		provider: "OpenRouter/MiniMax",
		quotaWindow: "rolling-5h",
		quotaHint: "Cheap fallback for long context; requires OPENROUTER_API_KEY.",
		pricing: { inputPerMillion: 0.3, outputPerMillion: 1.2 },
		contextWindow: 512_000,
	},
	glm: {
		agent: "glm",
		tier: "cheap",
		modelId: "z-ai/glm-5.2",
		provider: "OpenRouter/GLM",
		quotaWindow: "daily",
		quotaHint: "Low-cost implementation fallback; requires OPENROUTER_API_KEY.",
		pricing: { inputPerMillion: 1.0, outputPerMillion: 4.0 },
		contextWindow: 200_000,
	},
	opencode: {
		agent: "opencode",
		tier: "free",
		modelId: "opencode-local",
		provider: "OpenCode",
		quotaWindow: "included",
		quotaHint: "Free/local emergency fallback when configured.",
		pricing: null,
		contextWindow: 128_000,
	},
};

export const AGENT_TIER_ORDER: AgentRoutingTier[] = [
	"subscription",
	"cheap",
	"free",
];

export const AGENT_COMBOS: Record<AgentComboName, AgentCombo> = {
	"fable-orchestrated": {
		name: "fable-orchestrated",
		description:
			"Fable 5 plans globally, delegates small worker briefs, and judges the verified result.",
		strategy: "fusion",
		agents: ["claude", "codex", "gemini"],
		judge: "claude",
	},
	"premium-coding": {
		name: "premium-coding",
		description: "Subscription first, cheap backup, free emergency.",
		strategy: "fallback",
		agents: ["claude", "codex", "gemini", "glm", "minimax", "opencode"],
	},
	"quality-first": {
		name: "quality-first",
		description: "Best quality agents first; no cheap model until needed.",
		strategy: "fallback",
		agents: ["claude", "codex", "gemini"],
	},
	"precision-debug": {
		name: "precision-debug",
		description:
			"Codex reproduces and fixes, Claude reviews root cause, then Gemini checks broad regressions.",
		strategy: "fusion",
		agents: ["codex", "claude", "gemini"],
		judge: "claude",
	},
	"frontend-studio": {
		name: "frontend-studio",
		description:
			"Codex implements the interface while Claude and Cursor review design and interaction quality.",
		strategy: "fusion",
		agents: ["codex", "claude", "cursor-agent"],
		judge: "claude",
	},
	"deep-research": {
		name: "deep-research",
		description:
			"Gemini scans broad sources, Claude synthesizes, and Codex turns findings into working changes.",
		strategy: "fusion",
		agents: ["gemini", "claude", "codex"],
		judge: "claude",
	},
	"fast-tasks": {
		name: "fast-tasks",
		description:
			"Fast subscription agents first, then low-cost implementation fallbacks.",
		strategy: "fallback",
		agents: ["codex", "gemini", "glm", "minimax"],
	},
	"budget-coding": {
		name: "budget-coding",
		description: "Cheap OpenRouter agents first, then free/local fallback.",
		strategy: "fallback",
		agents: ["glm", "minimax", "kimi", "opencode"],
	},
	"free-coding": {
		name: "free-coding",
		description: "No paid token spend unless the user explicitly switches.",
		strategy: "fallback",
		agents: ["gemini", "opencode"],
	},
	"large-context": {
		name: "large-context",
		description: "Prefer broad-context agents, then implementation agents.",
		strategy: "fallback",
		agents: ["gemini", "kimi", "minimax", "claude", "codex"],
	},
	"fusion-review": {
		name: "fusion-review",
		description:
			"Fan out to several reviewers, then synthesize one final decision.",
		strategy: "fusion",
		agents: ["claude", "gemini", "codex"],
		judge: "claude",
	},
};

export const FALLBACK_RULES: AgentFallbackRule[] = [
	{
		text: "no credentials",
		reason: "credentials unavailable",
		cooldownMs: 2 * 60 * 1000,
	},
	{
		text: "request not allowed",
		reason: "provider rejected request",
		cooldownMs: 5000,
	},
	{
		text: "rate limit",
		reason: "rate limited",
		cooldownMs: BACKOFF_BASE_MS,
		backoff: true,
	},
	{
		text: "too many requests",
		reason: "too many requests",
		cooldownMs: BACKOFF_BASE_MS,
		backoff: true,
	},
	{
		text: "quota exceeded",
		reason: "quota exhausted",
		cooldownMs: BACKOFF_BASE_MS,
		backoff: true,
	},
	{
		text: "capacity",
		reason: "provider capacity",
		cooldownMs: BACKOFF_BASE_MS,
		backoff: true,
	},
	{
		text: "overloaded",
		reason: "provider overloaded",
		cooldownMs: BACKOFF_BASE_MS,
		backoff: true,
	},
	{ status: 401, reason: "unauthorized", cooldownMs: 2 * 60 * 1000 },
	{ status: 402, reason: "payment required", cooldownMs: 2 * 60 * 1000 },
	{ status: 403, reason: "permission or quota", cooldownMs: 2 * 60 * 1000 },
	{ status: 404, reason: "model unavailable", cooldownMs: 2 * 60 * 1000 },
	{
		status: 429,
		reason: "rate limited",
		cooldownMs: BACKOFF_BASE_MS,
		backoff: true,
	},
	{ status: 502, reason: "bad gateway", cooldownMs: 30 * 1000 },
	{ status: 503, reason: "service unavailable", cooldownMs: 30 * 1000 },
	{ status: 504, reason: "gateway timeout", cooldownMs: 30 * 1000 },
];

export function buildSmartRoutingPlan({
	task,
	intent,
	primary,
	delegates,
}: {
	task: TaskInput;
	intent: AgentTaskIntent;
	primary: SpecialistAgentType;
	delegates: SpecialistAgentType[];
}): AgentSmartRoutingPlan {
	const combo = chooseComboForIntent(intent);
	const fallbackChain = uniqueAgents([primary, ...delegates, ...combo.agents]);
	const usage = estimateTaskUsage(task);
	const costs = fallbackChain.map((agent) => estimateAgentCost(agent, usage));
	const tieredFallback = groupByTier(fallbackChain);
	const maxPaidCostUsd = costs.reduce(
		(total, cost) => total + (cost.included ? 0 : cost.costUsd),
		0,
	);
	const quotaHints = fallbackChain.map(
		(agent) =>
			`${AGENT_ROUTER_PROFILES[agent].provider}: ${AGENT_ROUTER_PROFILES[agent].quotaHint}`,
	);

	return {
		combo,
		fallbackChain,
		tieredFallback,
		usage,
		costs,
		maxPaidCostUsd,
		quotaHints,
		fallbackRules: FALLBACK_RULES,
	};
}

export function chooseComboForIntent(intent: AgentTaskIntent): AgentCombo {
	switch (intent) {
		case "architecture":
			return getCombo("fable-orchestrated");
		case "research":
			return getCombo("deep-research");
		case "large-context":
			return getCombo("large-context");
		case "debugging":
			return getCombo("precision-debug");
		case "windows":
			return getCombo("premium-coding");
		case "frontend":
			return getCombo("frontend-studio");
		case "implementation":
			return getCombo("premium-coding");
	}
}

export function classifyFallbackError({
	status,
	text,
	backoffLevel = 0,
}: {
	status?: number;
	text?: string;
	backoffLevel?: number;
}): FallbackDecision {
	const normalizedText = text?.toLowerCase() ?? "";
	const rule = FALLBACK_RULES.find((candidate) => {
		if (candidate.text && normalizedText.includes(candidate.text)) return true;
		return candidate.status !== undefined && candidate.status === status;
	});

	if (!rule) {
		return {
			shouldFallback: true,
			cooldownMs: 30 * 1000,
			reason: "transient or unknown error",
			backoffLevel,
		};
	}

	const nextBackoffLevel = rule.backoff ? Math.min(backoffLevel + 1, 15) : 0;
	const cooldownMs = rule.backoff
		? Math.min(
				BACKOFF_BASE_MS * 2 ** Math.max(nextBackoffLevel - 1, 0),
				BACKOFF_MAX_MS,
			)
		: rule.cooldownMs;

	return {
		shouldFallback: true,
		cooldownMs,
		reason: rule.reason,
		backoffLevel: nextBackoffLevel,
	};
}

export function estimateTaskUsage(task: TaskInput): TokenUsageEstimate {
	const payload = JSON.stringify(task);
	const inputTokens = Math.ceil(payload.length / 4) + INPUT_TOKEN_BUFFER;
	const outputTokens = OUTPUT_TOKEN_BUFFER;
	return {
		inputTokens,
		outputTokens,
		totalTokens: inputTokens + outputTokens,
		estimated: true,
	};
}

export function estimateAgentCost(
	agent: SpecialistAgentType,
	usage: TokenUsageEstimate,
): AgentCostEstimate {
	const profile = AGENT_ROUTER_PROFILES[agent];
	if (!profile.pricing) {
		return { agent, costUsd: 0, included: true };
	}

	const inputCost =
		(usage.inputTokens / 1_000_000) * profile.pricing.inputPerMillion;
	const outputCost =
		(usage.outputTokens / 1_000_000) * profile.pricing.outputPerMillion;

	return {
		agent,
		costUsd: roundCurrency(inputCost + outputCost),
		included: false,
	};
}

export function formatSmartRoutingPlan(plan: AgentSmartRoutingPlan): string {
	const tiers = AGENT_TIER_ORDER.map((tier) => {
		const agents = plan.tieredFallback[tier];
		if (agents.length === 0) return null;
		return `- ${tier}: ${agents.map(formatAgentSummary).join(" -> ")}`;
	})
		.filter(Boolean)
		.join("\n");
	const costs = plan.costs
		.map((cost) =>
			cost.included
				? `- ${cost.agent}: included/subscription/free`
				: `- ${cost.agent}: ~$${cost.costUsd.toFixed(4)} for this task estimate`,
		)
		.join("\n");
	const triggers = plan.fallbackRules
		.slice(0, 8)
		.map((rule) => rule.text ?? `HTTP ${rule.status}`)
		.join(", ");

	return `## Smart Routing Plan

- Combo: ${plan.combo.name} (${plan.combo.strategy}) - ${plan.combo.description}
- Estimated usage: ${plan.usage.inputTokens} input tokens + ${plan.usage.outputTokens} output tokens (${plan.usage.totalTokens} total, estimated)
- Max paid fallback exposure if every paid backup is tried: ~$${plan.maxPaidCostUsd.toFixed(4)}
- Fallback triggers: ${triggers}

### Tiered Fallback

${tiers}

### Cost Estimate

${costs}`;
}

function formatAgentSummary(agent: SpecialistAgentType): string {
	const profile = AGENT_ROUTER_PROFILES[agent];
	return `${agent} (${profile.provider}, ${profile.modelId})`;
}

function groupByTier(
	chain: SpecialistAgentType[],
): Record<AgentRoutingTier, SpecialistAgentType[]> {
	return {
		subscription: chain.filter(
			(agent) => AGENT_ROUTER_PROFILES[agent].tier === "subscription",
		),
		cheap: chain.filter(
			(agent) => AGENT_ROUTER_PROFILES[agent].tier === "cheap",
		),
		free: chain.filter((agent) => AGENT_ROUTER_PROFILES[agent].tier === "free"),
	};
}

function uniqueAgents(agents: SpecialistAgentType[]): SpecialistAgentType[] {
	return Array.from(new Set(agents));
}

function roundCurrency(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

function getCombo(name: AgentComboName): AgentCombo {
	return AGENT_COMBOS[name];
}
