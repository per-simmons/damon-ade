import {
	AGENT_COMBOS,
	AGENT_ROUTER_PROFILES,
	AGENT_TIER_ORDER,
	type AgentCombo,
	type AgentComboName,
	type AgentRoutingTier,
	FALLBACK_RULES,
} from "./agent-router";
import {
	AGENT_CAPABILITY_REGISTRY,
	type AgentCapability,
	type SpecialistAgentType,
} from "./agent-routing";
import {
	formatTokenCutNotice,
	type TokenCutOptions,
	type TokenCutResult,
	tokenCut,
} from "./token-cut";

export type RouterProviderConnection =
	| "agent-runtime"
	| "openai-compatible"
	| "oauth"
	| "local"
	| "media"
	| "search";

export type RouterProviderStatus =
	| "native"
	| "key-ready"
	| "oauth-ready"
	| "catalog";

export const ROUTER_PROVIDER_KEY_IDS = [
	"openrouter",
	"openai",
	"anthropic",
	"gemini",
	"github",
	"cursor",
	"kiro",
	"xai",
	"reve",
	"perplexity",
	"brave-search",
	"elevenlabs",
	"stability-ai",
] as const;

export type RouterProviderKeyId = (typeof ROUTER_PROVIDER_KEY_IDS)[number];
export type RouterProviderAccountAuthType =
	| "api-key"
	| "oauth"
	| "access-token";

export interface RouterProviderAccount {
	id: string;
	provider: RouterProviderKeyId;
	name: string;
	authType: RouterProviderAccountAuthType;
	email?: string | null;
	expiresAt?: string | null;
	providerSpecificData?: Record<string, unknown>;
	priority: number;
	isActive: boolean;
	createdAt: string;
	updatedAt: string;
	lastUsedAt: string | null;
	consecutiveUseCount: number;
	requestCount: number;
	failureCount: number;
	backoffLevel: number;
	rateLimitedUntil: string | null;
	lastError: {
		status?: number;
		message: string;
		timestamp: string;
	} | null;
}

export interface RouterProviderCatalogItem {
	id: string;
	label: string;
	tier: AgentRoutingTier | "media" | "search" | "local";
	connection: RouterProviderConnection;
	status: RouterProviderStatus;
	auth: "built-in" | "api-key" | "oauth" | "local";
	keyProvider?: RouterProviderKeyId;
	capabilities: string[];
	defaultModels: string[];
	notes: string;
}

export interface RouterEndpoint {
	path: string;
	method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
	compatibility: "OpenAI" | "Anthropic" | "Router";
	capability: string;
	status: "native-dashboard" | "gateway-live" | "gateway-catalogued";
}

export interface RouterGatewayStatus {
	running: boolean;
	host: string;
	port: number;
	url: string;
	startedAt: string | null;
	error: string | null;
}

export interface OpenAIModelEntry {
	id: string;
	object: "model";
	owned_by: string;
	kind?: RouterModelKind;
	name?: string;
}

export interface OpenAIModelList {
	object: "list";
	data: OpenAIModelEntry[];
}

export interface RouterModelInfo {
	id: string;
	name: string;
	kind: RouterModelKind;
	owned_by: string;
	endpoint: string | null;
}

export interface GeminiModelEntry {
	name: string;
	displayName: string;
	description: string;
	supportedGenerationMethods: string[];
	inputTokenLimit: number;
	outputTokenLimit: number;
}

export interface GeminiModelList {
	models: GeminiModelEntry[];
}

export interface RouterModelTarget {
	provider: "openrouter";
	model: string;
	source:
		| "combo"
		| "custom-combo"
		| "agent"
		| "alias"
		| "provider-model"
		| "direct";
	fallbackModels: string[];
}

export interface RouterModelAlias {
	alias: string;
	targetModel: string;
}

export interface RouterCustomCombo {
	name: string;
	models: string[];
}

export const ROUTER_MODEL_KINDS = [
	"llm",
	"embedding",
	"image",
	"tts",
	"stt",
	"imageToText",
	"webSearch",
	"webFetch",
	"video",
	"search",
	"other",
] as const;

export type RouterModelKind = (typeof ROUTER_MODEL_KINDS)[number];

export const ROUTER_MODEL_KIND_SLUGS = {
	image: ["image"],
	tts: ["tts"],
	stt: ["stt"],
	embedding: ["embedding"],
	"image-to-text": ["imageToText"],
	web: ["webSearch", "webFetch"],
} as const satisfies Record<string, readonly RouterModelKind[]>;

const ROUTER_MODEL_KIND_ENDPOINTS: Record<RouterModelKind, string | null> = {
	llm: "/v1/chat/completions",
	image: "/v1/images/generations",
	tts: "/v1/audio/speech",
	stt: "/v1/audio/transcriptions",
	embedding: "/v1/embeddings",
	imageToText: "/v1/chat/completions",
	webSearch: "/v1/search",
	webFetch: "/v1/web/fetch",
	video: null,
	search: "/v1/search",
	other: null,
};

export interface RouterCustomModel {
	providerAlias: string;
	id: string;
	type: RouterModelKind;
	name: string;
	createdAt: string;
	updatedAt: string;
}

export interface RouterDisabledModel {
	providerAlias: string;
	id: string;
	reason: string | null;
	disabledAt: string;
}

export type RouterModelAvailabilityStatus =
	| "available"
	| "unavailable"
	| "cooldown";

export interface RouterModelAvailabilityEntry {
	id: string;
	provider: string;
	model: string;
	kind: RouterModelKind;
	status: RouterModelAvailabilityStatus;
	checkedAt: string;
	latencyMs: number | null;
	httpStatus: number | null;
	error: string | null;
	method: string | null;
}

export interface RouterModelTestResult {
	ok: boolean;
	model: string;
	kind: RouterModelKind;
	provider: string;
	status: number | null;
	latencyMs: number;
	error: string | null;
	method: string;
}

export interface RouterPricingRate {
	input?: number;
	output?: number;
	cached?: number;
	reasoning?: number;
	cache_creation?: number;
}

export type RouterPricingTable = Record<
	string,
	Record<string, RouterPricingRate>
>;

export const ROUTER_PROXY_POOL_TYPES = [
	"http",
	"vercel",
	"cloudflare",
	"deno",
] as const;

export type RouterProxyPoolType = (typeof ROUTER_PROXY_POOL_TYPES)[number];

export type RouterProxyPoolTestStatus = "unknown" | "active" | "error";

export interface RouterProxyPool {
	id: string;
	name: string;
	proxyUrl: string;
	noProxy: string;
	type: RouterProxyPoolType;
	isActive: boolean;
	strictProxy: boolean;
	testStatus: RouterProxyPoolTestStatus;
	lastTestedAt: string | null;
	lastError: string | null;
	createdAt: string;
	updatedAt: string;
	boundConnectionCount?: number;
}

export interface RouterProxyPoolTestResult {
	ok: boolean;
	status: number;
	statusText: string | null;
	error: string | null;
	elapsedMs: number;
	testedAt: string;
}

export type RouterProviderNodeType =
	| "openai-compatible"
	| "anthropic-compatible"
	| "custom-embedding";

export type RouterProviderNodeApiType = "chat" | "responses";

export interface RouterProviderNode {
	id: string;
	type: RouterProviderNodeType;
	name: string;
	prefix: string;
	baseUrl: string;
	apiType?: RouterProviderNodeApiType;
	apiKeyProvider?: RouterProviderKeyId;
	apiKeyAccountId?: string | null;
	models: string[];
	isActive: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface RouterModelResolutionOptions {
	aliases?: RouterModelAlias[];
	customCombos?: RouterCustomCombo[];
	customModels?: RouterCustomModel[];
	disabledModels?: RouterDisabledModel[];
	kindFilter?: RouterModelKind[];
	providerNodes?: RouterProviderNode[];
}

export type RouterTokenSaverMode = "rtk" | "headroom" | "caveman" | "ponytail";

export interface RouterTokenSaver {
	mode: RouterTokenSaverMode;
	label: string;
	description: string;
	status: "native";
}

export interface RouterTokenSaverPreview {
	mode: RouterTokenSaverMode;
	result: TokenCutResult;
	notice: string | null;
}

export interface RouterFeature {
	id: string;
	label: string;
	status: "active" | "native-ui" | "router-core" | "catalogued";
	description: string;
}

export interface RouterProviderSnapshot extends RouterProviderCatalogItem {
	keyConfigured: boolean | null;
	agent?: SpecialistAgentType;
	modelId?: string;
	contextWindow?: number;
	quotaHint?: string;
}

export interface RouterDashboardSnapshot {
	generatedAt: string;
	gateway?: RouterGatewayStatus;
	stats: {
		providers: number;
		nativeAgents: number;
		combos: number;
		endpoints: number;
		tokenSavers: number;
		fallbackRules: number;
	};
	providers: RouterProviderSnapshot[];
	combos: AgentCombo[];
	profiles: typeof AGENT_ROUTER_PROFILES;
	capabilities: Record<SpecialistAgentType, AgentCapability[]>;
	endpoints: RouterEndpoint[];
	tokenSavers: RouterTokenSaver[];
	fallbackRules: typeof FALLBACK_RULES;
	features: RouterFeature[];
	tierOrder: typeof AGENT_TIER_ORDER;
}

export const ROUTER_PROVIDER_CATALOG: RouterProviderCatalogItem[] = [
	{
		id: "claude-code",
		label: "Claude Code",
		tier: "subscription",
		connection: "agent-runtime",
		status: "native",
		auth: "built-in",
		capabilities: ["coding", "architecture", "review"],
		defaultModels: ["claude-fable-5", "claude-sonnet-5"],
		notes:
			"Fable 5 coordinates ambitious work; Sonnet 5 handles faster agentic execution.",
	},
	{
		id: "codex-cli",
		label: "Codex CLI",
		tier: "subscription",
		connection: "agent-runtime",
		status: "native",
		auth: "built-in",
		capabilities: ["coding", "debugging", "windows", "frontend"],
		defaultModels: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
		notes: "Hands-on executor for repo edits, shell work, and verification.",
	},
	{
		id: "gemini-cli",
		label: "Gemini CLI",
		tier: "subscription",
		connection: "agent-runtime",
		status: "native",
		auth: "built-in",
		capabilities: ["large-context", "research", "review"],
		defaultModels: [
			"gemini-3.5-flash",
			"gemini-3.1-flash-lite",
			"gemini-3.1-flash-image",
			"gemini-3-pro-image",
		],
		notes: "Broad context scanner for large repositories and docs.",
	},
	{
		id: "github-copilot",
		label: "GitHub Copilot",
		tier: "subscription",
		connection: "oauth",
		status: "oauth-ready",
		auth: "oauth",
		keyProvider: "github",
		capabilities: ["coding", "frontend"],
		defaultModels: ["github-copilot"],
		notes: "GitHub-linked coding fallback when installed.",
	},
	{
		id: "cursor",
		label: "Cursor",
		tier: "subscription",
		connection: "oauth",
		status: "oauth-ready",
		auth: "oauth",
		keyProvider: "cursor",
		capabilities: ["coding", "frontend", "ui-iteration"],
		defaultModels: ["cursor-agent"],
		notes: "Useful when a task benefits from Cursor-native iteration.",
	},
	{
		id: "kiro",
		label: "Kiro",
		tier: "free",
		connection: "oauth",
		status: "oauth-ready",
		auth: "oauth",
		keyProvider: "kiro",
		capabilities: ["chat", "coding", "fallback"],
		defaultModels: ["kiro/claude", "kiro/glm", "kiro/minimax"],
		notes:
			"Free-provider compatibility via an explicitly imported Kiro credential.",
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		tier: "cheap",
		connection: "openai-compatible",
		status: "key-ready",
		auth: "api-key",
		keyProvider: "openrouter",
		capabilities: ["chat", "coding", "fallback", "model-market"],
		defaultModels: [
			"z-ai/glm-5.2",
			"minimax/minimax-m3",
			"moonshotai/kimi-k2.7-code",
		],
		notes: "Cheap fallback layer used by GLM, MiniMax, and Kimi runtimes.",
	},
	{
		id: "opencode",
		label: "OpenCode",
		tier: "free",
		connection: "local",
		status: "native",
		auth: "local",
		capabilities: ["coding", "local", "free-fallback"],
		defaultModels: ["opencode-local"],
		notes: "Local/free emergency fallback for simple implementation tasks.",
	},
	{
		id: "anthropic",
		label: "Anthropic API",
		tier: "subscription",
		connection: "openai-compatible",
		status: "catalog",
		auth: "api-key",
		keyProvider: "anthropic",
		capabilities: ["chat", "messages", "tool-use", "vision"],
		defaultModels: ["claude-fable-5", "claude-sonnet-5", "claude-opus-4.8"],
		notes: "Catalogued for the OpenAI/Anthropic translator layer.",
	},
	{
		id: "openai",
		label: "OpenAI API",
		tier: "subscription",
		connection: "openai-compatible",
		status: "catalog",
		auth: "api-key",
		keyProvider: "openai",
		capabilities: ["responses", "chat", "images", "audio", "embeddings"],
		defaultModels: [
			"gpt-5.5",
			"gpt-5.4",
			"gpt-5.4-pro",
			"gpt-5.4-mini",
			"gpt-5.4-nano",
			"gpt-image-2",
		],
		notes: "Catalogued for Responses and Chat Completions compatibility.",
	},
	{
		id: "xai",
		label: "SpaceXAI / Grok",
		tier: "subscription",
		connection: "openai-compatible",
		status: "key-ready",
		auth: "api-key",
		keyProvider: "xai",
		capabilities: ["chat", "coding", "agents", "image-generation", "video"],
		defaultModels: [
			"grok-4.5",
			"grok-build-0.1",
			"grok-imagine-image",
			"grok-imagine-image-quality",
			"grok-imagine-video",
		],
		notes:
			"Grok 4.5 for coding and agentic work; Imagine models for image and video.",
	},
	{
		id: "reve",
		label: "Reve",
		tier: "media",
		connection: "media",
		status: "key-ready",
		auth: "api-key",
		keyProvider: "reve",
		capabilities: ["image-generation", "image-editing", "remix", "upscale"],
		defaultModels: ["reve-create", "reve-edit", "reve-remix", "reve-2.0"],
		notes:
			"Official Reve API surface. Reve 2.1 is not listed publicly, so ADE discovers newer IDs from the provider instead of inventing one.",
	},
	{
		id: "ollama",
		label: "Ollama",
		tier: "local",
		connection: "local",
		status: "catalog",
		auth: "local",
		capabilities: ["local-chat", "embeddings"],
		defaultModels: ["llama", "qwen", "deepseek-coder"],
		notes: "Local model provider for offline or private routing.",
	},
	{
		id: "perplexity",
		label: "Perplexity",
		tier: "search",
		connection: "search",
		status: "catalog",
		auth: "api-key",
		keyProvider: "perplexity",
		capabilities: ["search", "research", "citations"],
		defaultModels: ["sonar"],
		notes: "Search-backed research provider.",
	},
	{
		id: "brave-search",
		label: "Brave Search",
		tier: "search",
		connection: "search",
		status: "catalog",
		auth: "api-key",
		keyProvider: "brave-search",
		capabilities: ["web-search"],
		defaultModels: ["brave-search"],
		notes: "Search provider for router-side web lookup tools.",
	},
	{
		id: "elevenlabs",
		label: "ElevenLabs",
		tier: "media",
		connection: "media",
		status: "catalog",
		auth: "api-key",
		keyProvider: "elevenlabs",
		capabilities: ["tts", "speech"],
		defaultModels: ["elevenlabs-tts"],
		notes: "Media provider catalogued for audio generation.",
	},
	{
		id: "stability-ai",
		label: "Stability AI",
		tier: "media",
		connection: "media",
		status: "catalog",
		auth: "api-key",
		keyProvider: "stability-ai",
		capabilities: ["image-generation"],
		defaultModels: ["stable-image"],
		notes: "Media provider catalogued for image generation routes.",
	},
];

export const ROUTER_ENDPOINTS: RouterEndpoint[] = [
	{
		path: "/v1/models",
		method: "GET",
		compatibility: "OpenAI",
		capability: "Model catalogue",
		status: "gateway-live",
	},
	{
		path: "/v1/models/{kind}",
		method: "GET",
		compatibility: "OpenAI",
		capability: "Model catalogue filtered by capability",
		status: "gateway-live",
	},
	{
		path: "/v1/models/info",
		method: "GET",
		compatibility: "OpenAI",
		capability: "Single-model metadata",
		status: "gateway-live",
	},
	{
		path: "/v1beta/models",
		method: "GET",
		compatibility: "Router",
		capability: "Gemini-compatible model catalogue",
		status: "gateway-live",
	},
	{
		path: "/v1/chat/completions",
		method: "POST",
		compatibility: "OpenAI",
		capability: "Chat and coding proxy",
		status: "gateway-live",
	},
	{
		path: "/v1/responses",
		method: "POST",
		compatibility: "OpenAI",
		capability: "Responses API proxy",
		status: "gateway-live",
	},
	{
		path: "/v1/messages",
		method: "POST",
		compatibility: "Anthropic",
		capability: "Claude Messages proxy",
		status: "gateway-live",
	},
	{
		path: "/v1/messages/count_tokens",
		method: "POST",
		compatibility: "Anthropic",
		capability: "Token counting",
		status: "gateway-live",
	},
	{
		path: "/v1/images/generations",
		method: "POST",
		compatibility: "OpenAI",
		capability: "Image generation",
		status: "gateway-live",
	},
	{
		path: "/v1/audio/speech",
		method: "POST",
		compatibility: "OpenAI",
		capability: "Text to speech",
		status: "gateway-live",
	},
	{
		path: "/v1/audio/transcriptions",
		method: "POST",
		compatibility: "OpenAI",
		capability: "Speech to text",
		status: "gateway-live",
	},
	{
		path: "/v1/embeddings",
		method: "POST",
		compatibility: "OpenAI",
		capability: "OpenAI/custom embedding proxy",
		status: "gateway-live",
	},
	{
		path: "/api/provider-nodes",
		method: "GET",
		compatibility: "Router",
		capability: "Custom OpenAI/Anthropic-compatible provider nodes",
		status: "gateway-live",
	},
	{
		path: "/api/providers",
		method: "GET",
		compatibility: "Router",
		capability: "9router-compatible provider account registry",
		status: "gateway-live",
	},
	{
		path: "/api/providers/validate",
		method: "POST",
		compatibility: "Router",
		capability: "Provider API key validation",
		status: "gateway-live",
	},
	{
		path: "/api/proxy-pools",
		method: "GET",
		compatibility: "Router",
		capability: "Proxy pool registry",
		status: "gateway-live",
	},
	{
		path: "/api/proxy-pools/{id}/test",
		method: "POST",
		compatibility: "Router",
		capability: "Proxy and relay connectivity test",
		status: "gateway-live",
	},
	{
		path: "/api/provider-nodes/validate",
		method: "POST",
		compatibility: "Router",
		capability: "Provider node validation and model discovery",
		status: "gateway-live",
	},
	{
		path: "/api/models/test",
		method: "POST",
		compatibility: "Router",
		capability: "Per-model ping checks",
		status: "gateway-live",
	},
	{
		path: "/api/models/availability",
		method: "GET",
		compatibility: "Router",
		capability: "Recent model availability history",
		status: "gateway-live",
	},
	{
		path: "/api/models/custom",
		method: "GET",
		compatibility: "Router",
		capability: "Custom model registry",
		status: "gateway-live",
	},
	{
		path: "/api/models/disabled",
		method: "GET",
		compatibility: "Router",
		capability: "Disabled model registry",
		status: "gateway-live",
	},
	{
		path: "/api/models/alias",
		method: "GET",
		compatibility: "Router",
		capability: "Model alias registry",
		status: "gateway-live",
	},
	{
		path: "/api/pricing",
		method: "GET",
		compatibility: "Router",
		capability: "Editable model pricing table",
		status: "gateway-live",
	},
	{
		path: "/api/cli-tools/all-statuses",
		method: "GET",
		compatibility: "Router",
		capability: "CLI tool integration status batch",
		status: "gateway-live",
	},
	{
		path: "/api/cli-tools/{tool}-settings",
		method: "GET",
		compatibility: "Router",
		capability: "Codex, Claude, and Cline router config presets",
		status: "gateway-live",
	},
	{
		path: "/api/cli-tools/antigravity-mitm/alias",
		method: "GET",
		compatibility: "Router",
		capability: "MITM model alias registry",
		status: "gateway-live",
	},
	{
		path: "/api/coordinator/runs",
		method: "POST",
		compatibility: "Router",
		capability: "Start a parallel specialist run",
		status: "gateway-live",
	},
	{
		path: "/api/coordinator/runs/{id}",
		method: "GET",
		compatibility: "Router",
		capability: "Coordinator run state and per-worker usage",
		status: "gateway-live",
	},
	{
		path: "/api/coordinator/runs/{id}/events",
		method: "GET",
		compatibility: "Router",
		capability: "Live coordinator and worker event stream",
		status: "gateway-live",
	},
	{
		path: "/api/coordinator/runs/{id}/cancel",
		method: "POST",
		compatibility: "Router",
		capability: "Cancel workers and synthesis",
		status: "gateway-live",
	},
	{
		path: "/v1/compress",
		method: "POST",
		compatibility: "Router",
		capability: "Token saver compression",
		status: "gateway-live",
	},
	{
		path: "/v1/search",
		method: "POST",
		compatibility: "Router",
		capability: "Search provider proxy",
		status: "gateway-live",
	},
	{
		path: "/v1/web/fetch",
		method: "POST",
		compatibility: "Router",
		capability: "URL fetch helper",
		status: "gateway-live",
	},
];

export const TOKEN_SAVER_MODES = [
	"rtk",
	"headroom",
	"caveman",
	"ponytail",
] as const satisfies readonly RouterTokenSaverMode[];

export const ROUTER_TOKEN_SAVERS: RouterTokenSaver[] = [
	{
		mode: "rtk",
		label: "RTK token-cut",
		description:
			"Detects diffs, status output, grep/find lists, logs, and builds.",
		status: "native",
	},
	{
		mode: "headroom",
		label: "Headroom",
		description:
			"Keeps tighter context windows so fallbacks have room to answer.",
		status: "native",
	},
	{
		mode: "caveman",
		label: "Caveman Mode",
		description:
			"Removes polite filler and keeps terse, command-focused content.",
		status: "native",
	},
	{
		mode: "ponytail",
		label: "Ponytail",
		description:
			"Keeps the head and recent tail, tuned for long agent transcripts.",
		status: "native",
	},
];

export const ROUTER_FEATURES: RouterFeature[] = [
	{
		id: "orchestrator-runtime",
		label: "Orchestrator runtime",
		status: "active",
		description:
			"Observable parallel workers with retry, cancellation, per-worker usage, and Fable synthesis.",
	},
	{
		id: "combo-routing",
		label: "Combos and tiers",
		status: "router-core",
		description:
			"Subscription, cheap, and free fallback chains with fusion review.",
	},
	{
		id: "token-savers",
		label: "Token savers",
		status: "active",
		description:
			"RTK, Headroom, Caveman, and Ponytail run automatically before provider routing.",
	},
	{
		id: "provider-catalog",
		label: "Provider catalog",
		status: "native-ui",
		description:
			"9router-style provider catalogue exposed in the native dashboard.",
	},
	{
		id: "provider-nodes",
		label: "Provider nodes",
		status: "active",
		description:
			"Custom OpenAI-compatible, Anthropic-compatible, and embedding nodes route by prefix with validation and model import.",
	},
	{
		id: "model-registry",
		label: "Model registry",
		status: "active",
		description:
			"9router-style custom models, disabled models, per-model pings, and availability history.",
	},
	{
		id: "pricing-registry",
		label: "Pricing registry",
		status: "active",
		description:
			"9router-style editable per-provider/model pricing used by usage cost estimates.",
	},
	{
		id: "cli-tool-presets",
		label: "CLI tool presets",
		status: "active",
		description:
			"9router-style status/config endpoints for Codex, Claude, Cline, and MITM alias mappings.",
	},
	{
		id: "proxy-pools",
		label: "Proxy pools",
		status: "active",
		description:
			"9router-style HTTP and relay proxy pool registry with connectivity testing.",
	},
	{
		id: "fallback-classifier",
		label: "Fallback classifier",
		status: "router-core",
		description:
			"Rate limit, quota, auth, capacity, and HTTP failure backoff rules.",
	},
	{
		id: "native-dashboard",
		label: "Native dashboard",
		status: "active",
		description:
			"Control plane lives inside ADE instead of a localhost web UI.",
	},
];

const PROVIDER_TO_AGENT: Record<string, SpecialistAgentType | undefined> = {
	"claude-code": "claude",
	"codex-cli": "codex",
	"gemini-cli": "gemini",
	"github-copilot": "copilot",
	cursor: "cursor-agent",
	openrouter: "glm",
	opencode: "opencode",
};

export function buildRouterDashboardSnapshot({
	providerKeyStatus = {},
	gateway,
	now = new Date(),
}: {
	providerKeyStatus?: Record<string, boolean | undefined>;
	gateway?: RouterGatewayStatus;
	now?: Date;
} = {}): RouterDashboardSnapshot {
	const providers = ROUTER_PROVIDER_CATALOG.map((provider) => {
		const agent = PROVIDER_TO_AGENT[provider.id];
		const profile = agent ? AGENT_ROUTER_PROFILES[agent] : undefined;
		const keyConfigured = provider.keyProvider
			? providerKeyStatus[provider.keyProvider] === true
			: null;

		return {
			...provider,
			keyConfigured,
			agent,
			modelId: profile?.modelId,
			contextWindow: profile?.contextWindow,
			quotaHint: profile?.quotaHint,
		};
	});

	return {
		generatedAt: now.toISOString(),
		gateway,
		stats: {
			providers: providers.length,
			nativeAgents: Object.keys(AGENT_ROUTER_PROFILES).length,
			combos: Object.keys(AGENT_COMBOS).length,
			endpoints: ROUTER_ENDPOINTS.length,
			tokenSavers: ROUTER_TOKEN_SAVERS.length,
			fallbackRules: FALLBACK_RULES.length,
		},
		providers,
		combos: Object.values(AGENT_COMBOS),
		profiles: AGENT_ROUTER_PROFILES,
		capabilities: Object.fromEntries(
			Object.entries(AGENT_CAPABILITY_REGISTRY).map(([agent, profile]) => [
				agent,
				profile.capabilities,
			]),
		) as Record<SpecialistAgentType, AgentCapability[]>,
		endpoints: ROUTER_ENDPOINTS,
		tokenSavers: ROUTER_TOKEN_SAVERS,
		fallbackRules: FALLBACK_RULES,
		features: ROUTER_FEATURES,
		tierOrder: AGENT_TIER_ORDER,
	};
}

export function buildOpenAIModelList({
	aliases = [],
	customCombos = [],
	customModels = [],
	disabledModels = [],
	kindFilter,
	providerNodes = [],
}: RouterModelResolutionOptions = {}): OpenAIModelList {
	const entries: OpenAIModelEntry[] = [];
	const add = (
		id: string,
		ownedBy: string,
		metadata: Partial<Pick<OpenAIModelEntry, "kind" | "name">> = {},
	) => {
		const kind = metadata.kind ?? "llm";
		if (!routerModelKindMatches(kind, kindFilter)) return;
		if (entries.some((entry) => entry.id === id)) return;
		entries.push({
			id,
			object: "model",
			owned_by: ownedBy,
			kind,
			...metadata,
		});
	};

	for (const combo of Object.values(AGENT_COMBOS)) {
		add(combo.name, "combo", { kind: "llm" });
	}

	for (const [agent, profile] of Object.entries(AGENT_ROUTER_PROFILES) as [
		SpecialistAgentType,
		(typeof AGENT_ROUTER_PROFILES)[SpecialistAgentType],
	][]) {
		add(agent, profile.provider, { kind: "llm", name: profile.agent });
		add(profile.modelId, profile.provider, { kind: "llm" });
		if (profile.provider.startsWith("OpenRouter/")) {
			add(`openrouter/${profile.modelId}`, "openrouter", { kind: "llm" });
		}
	}

	for (const provider of ROUTER_PROVIDER_CATALOG) {
		for (const model of provider.defaultModels) {
			if (isRouterModelDisabled(disabledModels, provider.id, model)) continue;
			add(`${provider.id}/${model}`, provider.id, {
				kind: inferCatalogModelKind(provider, model),
			});
		}
	}

	for (const alias of aliases) {
		add(alias.alias, "alias", { kind: "llm" });
	}

	for (const combo of customCombos) {
		add(combo.name, "custom-combo", { kind: "llm" });
	}

	for (const model of customModels) {
		if (isRouterModelDisabled(disabledModels, model.providerAlias, model.id)) {
			continue;
		}
		add(`${model.providerAlias}/${model.id}`, model.providerAlias, {
			kind: model.type,
			name: model.name,
		});
	}

	for (const node of providerNodes) {
		if (!node.isActive) continue;
		const kind = node.type === "custom-embedding" ? "embedding" : "llm";
		for (const model of node.models) {
			if (
				isRouterModelDisabled(disabledModels, node.prefix, model) ||
				isRouterModelDisabled(disabledModels, node.id, model)
			) {
				continue;
			}
			add(`${node.prefix}/${model}`, node.id || node.prefix, { kind });
		}
	}

	return {
		object: "list",
		data: entries.sort((a, b) => a.id.localeCompare(b.id)),
	};
}

export function buildRouterModelInfo(
	id: string,
	options: RouterModelResolutionOptions = {},
	requestedKind?: RouterModelKind,
): RouterModelInfo | null {
	const list = buildOpenAIModelList(
		requestedKind ? { ...options, kindFilter: [requestedKind] } : options,
	);
	const entry = list.data.find((model) => model.id === id);
	if (!entry) return null;
	const kind = entry.kind ?? "llm";
	return {
		id: entry.id,
		name: entry.name ?? entry.id.split("/").at(-1) ?? entry.id,
		kind,
		owned_by: entry.owned_by,
		endpoint: ROUTER_MODEL_KIND_ENDPOINTS[kind] ?? null,
	};
}

export function buildGeminiModelList(
	options: RouterModelResolutionOptions = {},
): GeminiModelList {
	const models = new Map<string, GeminiModelEntry>();
	const add = (entry: OpenAIModelEntry, name: string, nativeGemini = false) => {
		if (models.has(name)) return;
		const displayName = entry.name ?? entry.id.split("/").at(-1) ?? entry.id;
		models.set(name, {
			name,
			displayName,
			description: `${entry.owned_by} model: ${displayName}`,
			supportedGenerationMethods: nativeGemini
				? ["generateContent", "streamGenerateContent"]
				: ["generateContent"],
			inputTokenLimit: 128_000,
			outputTokenLimit: 8192,
		});
	};

	const list = buildOpenAIModelList(options);
	for (const entry of list.data) {
		const kind = entry.kind ?? "llm";
		if (kind !== "llm" && kind !== "imageToText") continue;
		add(entry, `models/${entry.id}`);
		if (entry.id.startsWith("gemini/")) {
			add(entry, `models/${entry.id.slice("gemini/".length)}`, true);
		}
	}

	return {
		models: Array.from(models.values()).sort((a, b) =>
			a.name.localeCompare(b.name),
		),
	};
}

export function routerModelKindsForSlug(
	slug: string,
): RouterModelKind[] | null {
	const kinds =
		ROUTER_MODEL_KIND_SLUGS[slug as keyof typeof ROUTER_MODEL_KIND_SLUGS];
	return kinds ? [...kinds] : null;
}

export function isRouterModelDisabled(
	disabledModels: RouterDisabledModel[] | undefined,
	providerAlias: string,
	modelId: string,
): boolean {
	return Boolean(
		disabledModels?.some(
			(entry) => entry.providerAlias === providerAlias && entry.id === modelId,
		),
	);
}

function routerModelKindMatches(
	kind: RouterModelKind,
	kindFilter: RouterModelKind[] | undefined,
): boolean {
	if (!kindFilter?.length) return true;
	return kindFilter.includes(kind);
}

function inferCatalogModelKind(
	provider: RouterProviderCatalogItem,
	model: string,
): RouterModelKind {
	const normalizedModel = model.toLowerCase();
	if (normalizedModel.includes("embedding")) return "embedding";
	if (normalizedModel.includes("image")) return "image";
	if (normalizedModel.includes("video")) return "video";
	if (normalizedModel.includes("tts")) return "tts";
	if (normalizedModel.includes("transcri") || normalizedModel.includes("stt")) {
		return "stt";
	}
	if (provider.id === "reve") return "image";
	if (provider.id === "brave-search") return "webSearch";
	if (provider.id === "perplexity") return "webSearch";
	if (
		provider.capabilities.includes("tts") ||
		(provider.capabilities.includes("speech") &&
			!provider.capabilities.includes("chat"))
	) {
		return "tts";
	}
	if (
		(provider.capabilities.includes("image-generation") ||
			provider.capabilities.includes("image")) &&
		!provider.capabilities.includes("chat")
	) {
		return "image";
	}
	return "llm";
}

export function resolveRouterModelTarget(
	model: string | undefined,
	options: RouterModelResolutionOptions = {},
): RouterModelTarget | null {
	const requestedModel = resolveAlias(model?.trim(), options.aliases);
	if (!requestedModel) return null;

	const customCombo = options.customCombos?.find(
		(combo) => combo.name === requestedModel,
	);
	if (customCombo) {
		const fallbackModels = openRouterModelsForModelIds(
			customCombo.models,
			options,
		);
		const [primary] = fallbackModels;
		if (!primary) return null;
		return {
			provider: "openrouter",
			model: primary,
			source: "custom-combo",
			fallbackModels,
		};
	}

	if (isComboName(requestedModel)) {
		const fallbackModels = openRouterModelsForAgents(
			AGENT_COMBOS[requestedModel].agents,
		);
		const [primary] = fallbackModels;
		if (!primary) return null;
		return {
			provider: "openrouter",
			model: primary,
			source: "combo",
			fallbackModels,
		};
	}

	if (isSpecialistAgent(requestedModel)) {
		const profile = AGENT_ROUTER_PROFILES[requestedModel];
		if (!profile.provider.startsWith("OpenRouter/")) return null;
		return {
			provider: "openrouter",
			model: profile.modelId,
			source: "agent",
			fallbackModels: [profile.modelId],
		};
	}

	if (requestedModel.startsWith("openrouter/")) {
		const openRouterModel = requestedModel.slice("openrouter/".length);
		return {
			provider: "openrouter",
			model: openRouterModel,
			source: model?.trim() === requestedModel ? "provider-model" : "alias",
			fallbackModels: [openRouterModel],
		};
	}

	if (requestedModel.includes("/")) {
		return {
			provider: "openrouter",
			model: requestedModel,
			source: model?.trim() === requestedModel ? "direct" : "alias",
			fallbackModels: [requestedModel],
		};
	}

	return null;
}

export function previewRouterTokenSaver({
	text,
	mode = "rtk",
	options,
}: {
	text: string;
	mode?: RouterTokenSaverMode;
	options?: TokenCutOptions;
}): RouterTokenSaverPreview {
	const result = applyRouterTokenSaver(text, mode, options);
	return {
		mode,
		result,
		notice: result.changed ? formatTokenCutNotice(result) : null,
	};
}

export function applyRouterTokenSaver(
	text: string,
	mode: RouterTokenSaverMode,
	options: TokenCutOptions = {},
): TokenCutResult {
	switch (mode) {
		case "rtk":
			return tokenCut(text, options);
		case "headroom":
			return tokenCut(text, {
				minSize: 200,
				headLines: 80,
				tailLines: 40,
				...options,
			});
		case "caveman":
			return compactCaveman(text, options);
		case "ponytail":
			return compactPonytail(text, options);
	}
}

function compactCaveman(
	text: string,
	options: TokenCutOptions,
): TokenCutResult {
	const terse = text
		.split("\n")
		.filter((line) => {
			const value = line.trim();
			if (!value) return true;
			return !/^(certainly|sure|thanks|thank you|please note|here is|here are|i will|i can|let me)\b/i.test(
				value,
			);
		})
		.join("\n");

	const cut = tokenCut(terse, {
		minSize: 200,
		headLines: 80,
		tailLines: 50,
		...options,
	});

	if (cut.changed || terse !== text) {
		return toResult(text, cut.text, "smart-truncate");
	}
	return cut;
}

function compactPonytail(
	text: string,
	options: TokenCutOptions,
): TokenCutResult {
	const lines = text.split("\n");
	const headLines = options.headLines ?? 60;
	const tailLines = options.tailLines ?? 140;

	if (lines.length <= headLines + tailLines + 1) {
		return tokenCut(text, options);
	}

	const next = [
		...lines.slice(0, headLines),
		`[token-cut ponytail omitted ${lines.length - headLines - tailLines} middle lines]`,
		...lines.slice(-tailLines),
	].join("\n");

	return toResult(text, next, "smart-truncate");
}

function toResult(
	original: string,
	next: string,
	filter: TokenCutResult["filter"],
): TokenCutResult {
	if (next.length >= original.length) {
		return {
			text: original,
			changed: false,
			filter: null,
			bytesBefore: original.length,
			bytesAfter: original.length,
			savedBytes: 0,
		};
	}

	return {
		text: next,
		changed: true,
		filter,
		bytesBefore: original.length,
		bytesAfter: next.length,
		savedBytes: original.length - next.length,
	};
}

function isComboName(model: string): model is AgentComboName {
	return model in AGENT_COMBOS;
}

function isSpecialistAgent(model: string): model is SpecialistAgentType {
	return model in AGENT_ROUTER_PROFILES;
}

function resolveAlias(
	model: string | undefined,
	aliases: RouterModelAlias[] | undefined,
): string | undefined {
	let current = model;
	if (!current || !aliases?.length) return current;

	const aliasMap = new Map(
		aliases.map((alias) => [alias.alias, alias.targetModel]),
	);
	for (let index = 0; index < 8; index++) {
		const next = aliasMap.get(current);
		if (!next || next === current) return current;
		current = next;
	}
	return current;
}

function openRouterModelsForAgents(agents: SpecialistAgentType[]): string[] {
	return Array.from(
		new Set(
			agents
				.map((agent) => AGENT_ROUTER_PROFILES[agent])
				.filter((profile) => profile.provider.startsWith("OpenRouter/"))
				.map((profile) => profile.modelId),
		),
	);
}

function openRouterModelsForModelIds(
	models: string[],
	options: RouterModelResolutionOptions,
): string[] {
	return Array.from(
		new Set(
			models.flatMap(
				(model) =>
					resolveRouterModelTarget(model, {
						aliases: options.aliases,
						customCombos: [],
					})?.fallbackModels ?? [],
			),
		),
	);
}
