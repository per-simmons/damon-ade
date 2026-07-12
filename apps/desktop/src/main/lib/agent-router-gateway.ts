import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { AGENT_COMBOS } from "@superset/shared/agent-router";
import {
	buildGeminiModelList,
	buildOpenAIModelList,
	buildRouterModelInfo,
	previewRouterTokenSaver,
	ROUTER_MODEL_KIND_SLUGS,
	ROUTER_PROVIDER_CATALOG,
	ROUTER_PROVIDER_KEY_IDS,
	type RouterGatewayStatus,
	type RouterModelKind,
	type RouterModelResolutionOptions,
	type RouterModelTarget,
	type RouterModelTestResult,
	type RouterPricingTable,
	type RouterProviderAccount,
	type RouterProviderAccountAuthType,
	type RouterProviderKeyId,
	type RouterProviderNode,
	type RouterProviderNodeType,
	type RouterProxyPool,
	type RouterProxyPoolTestResult,
	type RouterProxyPoolType,
	type RouterTokenSaverMode,
	resolveRouterModelTarget,
	routerModelKindsForSlug,
	TOKEN_SAVER_MODES,
} from "@superset/shared/router-control-plane";
import { app as electronApp } from "electron";
import express, {
	type ErrorRequestHandler,
	type Response as ExpressResponse,
	type Request,
} from "express";
import {
	AgentCoordinatorRuntime,
	AgentInfrastructureError,
	AgentRunCancelledError,
	type AgentWorkerBrief,
	type StartAgentRunInput,
} from "./agent-coordinator-runtime";
import {
	type AgentProviderProtocolHint,
	type NormalizedProviderEvent,
	ProviderStreamNormalizer,
	takeAccumulatedArgumentsDelta,
} from "./agent-provider-executors";
import {
	createRouterProviderAccount,
	deleteRouterProviderAccount,
	getProviderAccountCredentialById,
	getProviderAccountCredentials,
	listRouterProviderAccountViews,
	markProviderAccountFailure,
	markProviderAccountSuccess,
	type RouterProviderAccountView,
	type RouterProviderCredential,
	updateRouterProviderAccount,
} from "./agent-router-accounts";
import {
	createDefaultAgentRouterServiceRegistry,
	PRIVILEGED_OPERATION_CONTRACT,
} from "./agent-router-services";
import {
	clearRouterUsage,
	createRouterApiKey,
	createRouterProviderNode,
	createRouterProxyPool,
	deleteRouterAlias,
	deleteRouterApiKey,
	deleteRouterCustomCombo,
	deleteRouterCustomModel,
	deleteRouterProviderNode,
	deleteRouterProxyPool,
	disableRouterModels,
	enableRouterModels,
	estimateTokens,
	getRouterAliases,
	getRouterApiKeyById,
	getRouterApiKeys,
	getRouterCustomCombos,
	getRouterCustomModels,
	getRouterDefaultPricing,
	getRouterDisabledModelMap,
	getRouterDisabledModels,
	getRouterMitmAliases,
	getRouterModelAvailability,
	getRouterPricing,
	getRouterProviderNodes,
	getRouterProxyPoolById,
	getRouterProxyPools,
	getRouterSettings,
	getRouterStoreSnapshot,
	getRouterUsageChart,
	getRouterUsageCompatStats,
	getRouterUsageForConnection,
	getRouterUsageLogs,
	getRouterUsageProviders,
	getRouterUsageRequestDetails,
	getRouterUsageStats,
	isRouterModelDisabled,
	type RouterGatewayApiKey,
	type RouterGatewaySettings,
	type RouterUsagePeriod,
	recordRouterModelAvailability,
	recordRouterUsage,
	resetRouterPricing,
	setRouterMitmAliases,
	updateRouterApiKey,
	updateRouterPricing,
	updateRouterProviderNode,
	updateRouterProxyPool,
	updateRouterSettings,
	upsertRouterAlias,
	upsertRouterCustomCombo,
	upsertRouterCustomModel,
} from "./agent-router-store";
import { applyRouterTokenSaversToRequest } from "./agent-router-token-saver";

export const DEFAULT_AGENT_ROUTER_GATEWAY_PORT = 20128;
const GATEWAY_HOST = "127.0.0.1";
const JSON_BODY_LIMIT_BYTES = 50 * 1024 * 1024;
const OPENROUTER_CHAT_COMPLETIONS_URL =
	"https://openrouter.ai/api/v1/chat/completions";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const PERPLEXITY_CHAT_COMPLETIONS_URL =
	"https://api.perplexity.ai/chat/completions";
const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const CLI_TOOL_IDS = [
	"claude",
	"codex",
	"opencode",
	"droid",
	"openclaw",
	"hermes",
	"cowork",
	"copilot",
	"cline",
	"kilo",
	"deepseek-tui",
	"jcode",
] as const;
const CODEX_MANAGED_START = "# ADE 9router managed start";
const CODEX_MANAGED_END = "# ADE 9router managed end";
const TRANSLATOR_LOG_FILES = new Set([
	"1_req_client.json",
	"2_req_source.json",
	"3_req_openai.json",
	"4_req_target.json",
	"5_res_provider.txt",
	"6_res_openai.txt",
	"7_res_client.txt",
	"7_res_client.json",
]);
const MAX_TRANSLATOR_CONSOLE_LOGS = 1000;

type CliToolId = (typeof CLI_TOOL_IDS)[number];
type ConfigurableCliToolId = "claude" | "cline" | "codex";

let server: Server | null = null;
let activePort = DEFAULT_AGENT_ROUTER_GATEWAY_PORT;
let startedAt: string | null = null;
let lastError: string | null = null;
let requestCount = 0;
let translatorConsolePatched = false;
const translatorConsoleEmitter = new EventEmitter();
const translatorConsoleLogs: string[] = [];
const translatorConsoleOriginals: Partial<
	Record<
		"debug" | "error" | "info" | "log" | "warn",
		(...args: unknown[]) => void
	>
> = {};
translatorConsoleEmitter.setMaxListeners(50);

type JsonObject = Record<string, unknown>;

interface OpenRouterSuccess {
	ok: true;
	account: RouterProviderCredential;
	upstream: globalThis.Response;
	target: RouterModelTarget;
	model: string;
}

interface ProviderNodeTarget {
	node: RouterProviderNode;
	model: string;
	requestedModel: string;
}

interface ProviderNodeSuccess {
	ok: true;
	account?: RouterProviderCredential;
	upstream: globalThis.Response;
	node: RouterProviderNode;
	model: string;
}

type OAuthRefreshProviderId = "codex" | "claude" | "gemini";

interface OAuthRefreshConfig {
	id: OAuthRefreshProviderId;
	aliases: string[];
	authorizeUrl: string;
	callbackPath?: string;
	clientId?: string;
	clientIdEnv?: string;
	clientSecret?: string;
	clientSecretEnv?: string;
	codeChallengeMethod?: "S256";
	defaultRedirectUri: string;
	encoding: "form" | "json";
	exchangeEncoding: "form" | "json";
	extraAuthParams?: Record<string, string>;
	keyProvider: RouterProviderKeyId;
	leadMs: number;
	maxRefreshAgeMs?: number;
	scope?: string;
	scopes?: string[];
	tokenUrl: string;
}

type OAuthRefreshResult =
	| {
			ok: true;
			accessToken: string;
			expiresAt: string | null;
			expiresIn: number | null;
			idToken: string | null;
			providerSpecificData: JsonObject;
			refreshToken: string | null;
	  }
	| {
			ok: false;
			error: string;
			permanent: boolean;
			status: number | null;
	  };

type OAuthRefreshCredentialResult =
	| {
			ok: true;
			credential: RouterProviderCredential;
			provider: OAuthRefreshConfig | null;
			refreshed: boolean;
	  }
	| {
			ok: false;
			error: string;
			permanent: boolean;
			provider: OAuthRefreshConfig | null;
			status: number | null;
	  };

interface RouterTtsVoice {
	id: string;
	name: string;
	locale: string;
	lang: string;
	country: string;
	countryName: string;
	langName: string;
	gender?: string;
	category?: string;
}

const OAUTH_REFRESH_CONFIGS: Record<
	OAuthRefreshProviderId,
	OAuthRefreshConfig
> = {
	claude: {
		id: "claude",
		aliases: ["anthropic"],
		authorizeUrl: "https://claude.ai/oauth/authorize",
		clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
		codeChallengeMethod: "S256",
		defaultRedirectUri: "https://console.anthropic.com/oauth/code/callback",
		encoding: "json",
		exchangeEncoding: "json",
		keyProvider: "anthropic",
		leadMs: 4 * 60 * 60 * 1000,
		scopes: ["org:create_api_key", "user:profile", "user:inference"],
		tokenUrl: "https://console.anthropic.com/v1/oauth/token",
	},
	codex: {
		id: "codex",
		aliases: ["openai", "chatgpt"],
		authorizeUrl: "https://auth.openai.com/oauth/authorize",
		callbackPath: "/auth/callback",
		clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
		codeChallengeMethod: "S256",
		defaultRedirectUri: "http://localhost:1455/auth/callback",
		encoding: "json",
		exchangeEncoding: "form",
		extraAuthParams: {
			codex_cli_simplified_flow: "true",
			id_token_add_organizations: "true",
			originator: "codex_cli_rs",
		},
		keyProvider: "openai",
		leadMs: 5 * 24 * 60 * 60 * 1000,
		maxRefreshAgeMs: 8 * 24 * 60 * 60 * 1000,
		scope: "openid profile email offline_access",
		tokenUrl: "https://auth.openai.com/oauth/token",
	},
	gemini: {
		id: "gemini",
		aliases: ["google", "gemini-cli", "antigravity"],
		authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		clientIdEnv: "ADE_GEMINI_OAUTH_CLIENT_ID",
		clientSecretEnv: "ADE_GEMINI_OAUTH_CLIENT_SECRET",
		defaultRedirectUri: "http://localhost:8080/callback",
		encoding: "form",
		exchangeEncoding: "form",
		extraAuthParams: {
			access_type: "offline",
			prompt: "consent",
		},
		keyProvider: "gemini",
		leadMs: 5 * 60 * 1000,
		scopes: [
			"https://www.googleapis.com/auth/cloud-platform",
			"https://www.googleapis.com/auth/userinfo.email",
			"https://www.googleapis.com/auth/userinfo.profile",
		],
		tokenUrl: "https://oauth2.googleapis.com/token",
	},
};

const oauthRefreshLocks = new Map<
	string,
	Promise<OAuthRefreshCredentialResult>
>();
let edgeTtsVoicesCache: { time: number; voices: JsonObject[] } | null = null;
let localDeviceVoicesCache: RouterTtsVoice[] | null = null;
const elevenLabsVoicesCache = new Map<
	string,
	{ time: number; voices: JsonObject[] }
>();

export interface RouterCoordinatorWorkerOutput {
	briefId: string;
	model: string;
	text: string;
}

export interface RouterCoordinatorFinalOutput {
	model: string;
	text: string;
}

let coordinatorRuntime: AgentCoordinatorRuntime<
	RouterCoordinatorWorkerOutput,
	RouterCoordinatorFinalOutput
> | null = null;
const routerServiceRegistry = createDefaultAgentRouterServiceRegistry();

export interface RouterDiscoveredProviderNodeModel {
	id: string;
	name: string;
}

export interface RouterProviderNodeValidationInput {
	apiKey?: string;
	apiKeyAccountId?: string | null;
	apiKeyProvider?: RouterProviderKeyId;
	apiType?: "chat" | "responses";
	baseUrl?: string;
	id?: string;
	modelId?: string;
	type?: RouterProviderNodeType;
}

export interface RouterProviderNodeValidationResult {
	valid: boolean;
	error?: string;
	method?: "models" | "chat" | "responses" | "messages" | "embeddings";
	status?: number;
	dimensions?: number | null;
	models?: RouterDiscoveredProviderNodeModel[];
}

export interface RouterProviderNodeDiscoveryResult {
	ok: boolean;
	error?: string;
	status?: number;
	models: RouterDiscoveredProviderNodeModel[];
	applied?: boolean;
}

export interface RouterOAuthAuthorizationSession {
	providerId: "claude" | "codex" | "gemini";
	providerLabel: string;
	authUrl: string;
	codeVerifier: string | null;
	redirectUri: string;
	state: string;
	instructions: string;
}

export interface RouterOAuthCompletionResult {
	success: true;
	providerId: "claude" | "codex" | "gemini";
}

export interface RouterSubscriptionStatus {
	installed: boolean;
	authenticated: boolean;
	plan: string | null;
}

export type RouterSubscriptionStatuses = Record<
	"claude" | "codex" | "gemini",
	RouterSubscriptionStatus
>;

export function getRouterSubscriptionStatuses(): RouterSubscriptionStatuses {
	return {
		claude: claudeSubscriptionStatus(),
		codex: {
			installed: commandExists("codex") || existsSync(codexConfigPath()),
			authenticated: existsSync(codexAuthPath()),
			plan: null,
		},
		gemini: {
			installed: commandExists("gemini"),
			authenticated: existsSync(join(homedir(), ".gemini", "oauth_creds.json")),
			plan: null,
		},
	};
}

function claudeSubscriptionStatus(): RouterSubscriptionStatus {
	const installed = commandExists("claude") || existsSync(claudeSettingsPath());
	if (!installed) return { installed: false, authenticated: false, plan: null };
	try {
		const raw = execFileSync("claude", ["auth", "status"], {
			encoding: "utf8",
			timeout: 8_000,
			windowsHide: true,
		});
		const status = toJsonObject(JSON.parse(raw));
		return {
			installed: true,
			authenticated: status.loggedIn === true,
			plan: stringValue(status.subscriptionType) ?? null,
		};
	} catch {
		return { installed: true, authenticated: false, plan: null };
	}
}

export function beginRouterOAuthAuthorization(
	providerId: string,
): RouterOAuthAuthorizationSession {
	const result = buildOAuthAuthorizeResponse(providerId, {});
	if (result.status >= 400) {
		throw new Error(stringValue(result.body.error) ?? "Could not start OAuth");
	}
	const provider = jsonObjectValue(result.body.provider);
	const resolvedProviderId = stringValue(provider.id);
	if (
		resolvedProviderId !== "claude" &&
		resolvedProviderId !== "codex" &&
		resolvedProviderId !== "gemini"
	) {
		throw new Error("OAuth provider is not supported");
	}
	return {
		providerId: resolvedProviderId,
		providerLabel: stringValue(provider.label) ?? resolvedProviderId,
		authUrl: stringValue(result.body.authUrl) ?? "",
		codeVerifier: stringValue(result.body.codeVerifier) ?? null,
		redirectUri: stringValue(result.body.redirectUri) ?? "",
		state: stringValue(result.body.state) ?? "",
		instructions:
			resolvedProviderId === "claude"
				? "Sign in with your Claude subscription, then paste the code or complete callback URL shown by Anthropic."
				: resolvedProviderId === "codex"
					? "Sign in with ChatGPT, then paste the code or the localhost callback URL from the browser."
					: "Sign in with Google, then paste the code or callback URL.",
	};
}

export async function completeRouterOAuthAuthorization(input: {
	providerId: string;
	rawCode: string;
	codeVerifier?: string | null;
	redirectUri: string;
	expectedState: string;
}): Promise<RouterOAuthCompletionResult> {
	const parsed = parseRouterOAuthCode(input.rawCode, input.expectedState);
	if (parsed.state && parsed.state !== input.expectedState) {
		throw new Error("OAuth state mismatch. Start the login again.");
	}
	const result = await exchangeOAuthCodeConnection(input.providerId, {
		code: parsed.code,
		codeVerifier: input.codeVerifier ?? undefined,
		redirectUri: input.redirectUri,
		state: parsed.state ?? input.expectedState,
	});
	if (result.status >= 400 || result.body.success === false) {
		throw new Error(
			stringValue(result.body.error) ?? "OAuth login could not be completed",
		);
	}
	const provider = resolveOAuthProvider(input.providerId);
	if (!provider) throw new Error("OAuth provider is not supported");
	if (
		provider.id !== "claude" &&
		provider.id !== "codex" &&
		provider.id !== "gemini"
	) {
		throw new Error("OAuth provider is not supported");
	}
	return { success: true, providerId: provider.id };
}

function parseRouterOAuthCode(
	rawCode: string,
	fallbackState: string,
): { code: string; state: string | null } {
	const trimmed = rawCode.trim();
	if (!trimmed) throw new Error("Authorization code is required");
	try {
		const callback = new URL(trimmed);
		const code = callback.searchParams.get("code")?.trim();
		if (!code) throw new Error("Callback URL does not contain a code");
		return {
			code,
			state: callback.searchParams.get("state")?.trim() || fallbackState,
		};
	} catch (error) {
		if (error instanceof Error && error.message.includes("does not contain")) {
			throw error;
		}
	}
	const [code, state] = trimmed.split("#", 2);
	return { code: code.trim(), state: state?.trim() || fallbackState };
}

interface GatewayFailure {
	ok: false;
	status: number;
	body: JsonObject;
}

export async function startAgentRouterGateway(
	port = DEFAULT_AGENT_ROUTER_GATEWAY_PORT,
): Promise<RouterGatewayStatus> {
	if (server?.listening) return getAgentRouterGatewayStatus();

	const app = createAgentRouterGatewayApp();
	const candidatePorts = [port, port + 1, port + 2];

	for (const candidatePort of candidatePorts) {
		try {
			server = await listen(app, candidatePort);
			activePort = candidatePort;
			startedAt = new Date().toISOString();
			lastError = null;
			console.log(
				`[agent-router-gateway] Listening on http://${GATEWAY_HOST}:${candidatePort}`,
			);
			return getAgentRouterGatewayStatus();
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			server = null;
		}
	}

	console.error("[agent-router-gateway] Failed to start:", lastError);
	return getAgentRouterGatewayStatus();
}

export async function stopAgentRouterGateway(): Promise<void> {
	const currentServer = server;
	server = null;
	startedAt = null;
	await routerServiceRegistry.stopAll();

	if (!currentServer?.listening) return;

	await new Promise<void>((resolve) => {
		currentServer.close(() => resolve());
	});
}

export function getAgentRouterGatewayStatus(): RouterGatewayStatus {
	const running = Boolean(server?.listening);
	const url = `http://${GATEWAY_HOST}:${activePort}`;

	return {
		running,
		host: GATEWAY_HOST,
		port: activePort,
		url,
		startedAt: running ? startedAt : null,
		error: running ? null : lastError,
	};
}

export function startAgentCoordinatorRun(input: StartAgentRunInput) {
	return getAgentCoordinatorRuntime().startRun(input);
}

export function listAgentCoordinatorRuns() {
	return getAgentCoordinatorRuntime().listRuns();
}

export function getAgentCoordinatorRun(runId: string) {
	return getAgentCoordinatorRuntime().getRun(runId);
}

export function getAgentCoordinatorEvents(runId: string, afterSequence = 0) {
	return getAgentCoordinatorRuntime().getEvents(runId, afterSequence);
}

export function cancelAgentCoordinatorRun(runId: string) {
	return getAgentCoordinatorRuntime().cancelRun(runId);
}

export function removeAgentCoordinatorRun(runId: string) {
	return getAgentCoordinatorRuntime().removeRun(runId);
}

function createAgentRouterGatewayApp() {
	const app = express();

	app.disable("x-powered-by");
	app.use((req, res, next) => {
		const origin = req.get("origin");
		if (origin && !isAllowedGatewayOrigin(origin)) {
			res.status(403).json({ error: "Gateway origin is not allowed" });
			return;
		}
		if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
		res.setHeader("Vary", "Origin");
		res.setHeader(
			"Access-Control-Allow-Methods",
			"GET,POST,PUT,PATCH,DELETE,OPTIONS",
		);
		res.setHeader(
			"Access-Control-Allow-Headers",
			"Authorization, Content-Type, X-API-Key, anthropic-version",
		);
		if (req.method === "OPTIONS") {
			res.status(204).end();
			return;
		}
		next();
	});
	app.use(attachUsageLogger);

	app.post(
		["/v1/audio/transcriptions", "/v1/audio/translations"],
		express.raw({ type: () => true, limit: "100mb" }),
		(req, res) =>
			handleOpenAIProxy(req, res, req.path.replace("/v1", ""), {
				rawBody: true,
			}),
	);

	app.use(jsonRequestBodyParser);
	app.use((req, _res, next) => {
		requestCount++;
		console.log(`[agent-router-gateway] ${req.method} ${req.path}`);
		next();
	});

	app.get(["/", "/health", "/v1"], (_req, res) => {
		res.json({
			ok: true,
			name: "ADE Agent Router Gateway",
			compatibility: "9router / OpenAI v1",
			requestCount,
			usage: getRouterUsageStats(5),
			...getAgentRouterGatewayStatus(),
		});
	});

	app.get("/api/health", (_req, res) => {
		res.json({
			ok: true,
			name: "ADE Agent Router Gateway",
			compatibility: "9router",
			...getAgentRouterGatewayStatus(),
		});
	});

	app.get("/api/version", (_req, res) => {
		res.json({
			currentVersion: electronApp.getVersion(),
			latestVersion: null,
			hasUpdate: false,
			compatibility: "9router",
		});
	});

	app.get("/api/coordinator/runs", (_req, res) => {
		res.json({ runs: listAgentCoordinatorRuns() });
	});
	app.post("/api/coordinator/runs", (req, res) => {
		try {
			const activeRuns = listAgentCoordinatorRuns().filter(
				(run) => !["completed", "failed", "cancelled"].includes(run.status),
			);
			if (activeRuns.length >= 8) {
				res.status(429).json({ error: "Coordinator run limit reached" });
				return;
			}
			const run = startAgentCoordinatorRun(parseCoordinatorRunInput(req.body));
			res.status(202).json({ run });
		} catch (error) {
			res.status(400).json({ error: errorMessage(error) });
		}
	});
	app.get("/api/coordinator/runs/:id/events", (req, res) => {
		const runtime = getAgentCoordinatorRuntime();
		const run = runtime.getRun(req.params.id);
		if (!run) {
			res.status(404).json({ error: "Coordinator run not found" });
			return;
		}
		const after = Math.max(0, Number(req.query.after ?? 0) || 0);
		res.status(200);
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache, no-transform");
		res.setHeader("Connection", "keep-alive");
		res.flushHeaders();
		for (const event of runtime.getEvents(req.params.id, after)) {
			res.write(`data: ${JSON.stringify(event)}\n\n`);
		}
		const unsubscribe = runtime.subscribe((event) => {
			if (event.runId === req.params.id) {
				res.write(`data: ${JSON.stringify(event)}\n\n`);
			}
		});
		const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
		req.on("close", () => {
			clearInterval(heartbeat);
			unsubscribe();
		});
	});
	app.get("/api/coordinator/runs/:id", (req, res) => {
		const run = getAgentCoordinatorRun(req.params.id);
		if (!run) {
			res.status(404).json({ error: "Coordinator run not found" });
			return;
		}
		res.json({ run });
	});
	app.post("/api/coordinator/runs/:id/cancel", (req, res) => {
		const cancelled = cancelAgentCoordinatorRun(req.params.id);
		res.status(cancelled ? 202 : 409).json({ cancelled });
	});
	app.delete("/api/coordinator/runs/:id", (req, res) => {
		const removed = removeAgentCoordinatorRun(req.params.id);
		res.status(removed ? 200 : 409).json({ removed });
	});

	app.post(["/api/shutdown", "/api/version/shutdown"], (_req, res) => {
		res.status(202).json({
			success: true,
			message: "ADE is desktop-managed; shutdown endpoint acknowledged.",
		});
	});

	app.get("/api/keys", (_req, res) => {
		res.json({ keys: getRouterApiKeys().map(routerApiKeyView) });
	});

	app.post("/api/keys", (req, res) => {
		const name = stringValue(req.body?.name);
		if (!name) {
			res.status(400).json({ error: "Name is required" });
			return;
		}
		const apiKey = createRouterApiKey(name);
		res.status(201).json({
			id: apiKey.id,
			key: apiKey.key,
			keyPreview: apiKey.keyPreview,
			machineId: apiKey.machineId,
			name: apiKey.name,
			isActive: apiKey.isActive,
			createdAt: apiKey.createdAt,
		});
	});

	app.get("/api/keys/:id", (req, res) => {
		const apiKey = getRouterApiKeyById(req.params.id);
		if (!apiKey) {
			res.status(404).json({ error: "Key not found" });
			return;
		}
		res.json({ key: routerApiKeyView(apiKey) });
	});

	app.put("/api/keys/:id", (req, res) => {
		const updated = updateRouterApiKey(req.params.id, {
			isActive:
				typeof req.body?.isActive === "boolean" ? req.body.isActive : undefined,
			name: stringValue(req.body?.name),
		});
		if (!updated) {
			res.status(404).json({ error: "Key not found" });
			return;
		}
		res.json({ key: routerApiKeyView(updated) });
	});

	app.delete("/api/keys/:id", (req, res) => {
		if (!deleteRouterApiKey(req.params.id)) {
			res.status(404).json({ error: "Key not found" });
			return;
		}
		res.json({ message: "Key deleted successfully" });
	});

	app.get("/api/settings", (_req, res) => {
		res.setHeader("Cache-Control", "no-store");
		res.json(routerSettingsResponse(getRouterSettings()));
	});

	app.patch("/api/settings", (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		res.json(
			routerSettingsResponse(updateRouterSettings(toJsonObject(req.body))),
		);
	});

	app.get("/api/settings/require-login", (_req, res) => {
		const settings = getRouterSettings();
		res.json({
			requireLogin: settings.requireLogin !== false,
			tunnelDashboardAccess: settings.tunnelDashboardAccess !== false,
			tailscaleUrl: stringValue(settings.tailscaleUrl) ?? "",
			tunnelUrl: stringValue(settings.tunnelUrl) ?? "",
		});
	});

	app.get("/api/settings/database", (_req, res) => {
		res.json({
			compatibility: "ade-router-state",
			...getRouterStoreSnapshot(),
		});
	});

	app.post("/api/settings/database", (_req, res) => {
		res.status(501).json({
			error: "Importing a full 9router database into ADE is not automated yet.",
			code: "DATABASE_IMPORT_NOT_MANAGED",
		});
	});

	app.post("/api/settings/proxy-test", async (req, res) => {
		const proxyUrl = stringValue(req.body?.proxyUrl);
		if (!proxyUrl) {
			res.status(400).json({ ok: false, error: "proxyUrl is required" });
			return;
		}
		const result = await testRouterProxyPool(
			{
				id: "settings-proxy-test",
				name: "Settings proxy test",
				proxyUrl,
				noProxy: stringValue(req.body?.noProxy) ?? "",
				type: "http",
				isActive: true,
				strictProxy: false,
				testStatus: "unknown",
				lastTestedAt: null,
				lastError: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
			{
				testUrl: stringValue(req.body?.testUrl),
				timeoutMs:
					typeof req.body?.timeoutMs === "number"
						? req.body.timeoutMs
						: undefined,
			},
		);
		res.status(result.ok ? 200 : result.status || 500).json(result);
	});

	app.get("/api/providers/client", (req, res) => {
		res.json(routerClientProvidersResponse(req));
	});

	app.get("/api/providers/suggested-models", async (req, res) => {
		const url = typeof req.query.url === "string" ? req.query.url : "";
		const type = typeof req.query.type === "string" ? req.query.type : "";
		if (!url || !type) {
			res.status(400).json({ error: "Missing url or type" });
			return;
		}
		try {
			const response = await fetchWithTimeout(url, { method: "GET" }, 5000);
			if (!response.ok) {
				res.json({ data: [] });
				return;
			}
			const raw = await response.json();
			const models = Array.isArray(raw)
				? raw
				: Array.isArray(raw?.data)
					? raw.data
					: Array.isArray(raw?.models)
						? raw.models
						: [];
			res.json({ data: filterSuggestedModels(models, type) });
		} catch {
			res.json({ data: [] });
		}
	});

	app.get("/api/tags", (_req, res) => {
		res.json({ tags: [] });
	});

	app.get("/api/locale", (_req, res) => {
		res.json({ locale: "en", source: "ade-default" });
	});

	app.get("/api/tunnel/status", (_req, res) => {
		res.json(routerTunnelStatus());
	});

	app.post("/api/tunnel/disable", async (_req, res) => {
		await routerServiceRegistry.stop("cloudflared");
		const settings = updateRouterSettings({
			tailscaleEnabled: false,
			tunnelEnabled: false,
		});
		res.json({ success: true, tunnel: routerTunnelStatus(settings).tunnel });
	});

	app.post("/api/tunnel/enable", async (req, res) => {
		const targetUrl =
			stringValue(req.body?.targetUrl) ?? getAgentRouterGatewayStatus().url;
		const status = await routerServiceRegistry.start("cloudflared", {
			targetUrl,
			tunnelToken: stringValue(req.body?.tunnelToken) ?? undefined,
			executable: stringValue(req.body?.executable) ?? undefined,
		});
		const success = status.state === "running";
		if (success) updateRouterSettings({ tunnelEnabled: true });
		res.status(success ? 200 : 503).json({
			success,
			service: status,
			status: routerTunnelStatus(),
		});
	});

	app.get("/api/tunnel/tailscale-check", (_req, res) => {
		res.json(routerTailscaleCheck());
	});

	app.post("/api/tunnel/tailscale-disable", async (_req, res) => {
		await routerServiceRegistry.stop("tailscale");
		const settings = updateRouterSettings({ tailscaleEnabled: false });
		res.json({
			success: true,
			tailscale: routerTunnelStatus(settings).tailscale,
		});
	});

	app.post("/api/tunnel/tailscale-enable", async (req, res) => {
		const targetUrl =
			stringValue(req.body?.targetUrl) ?? getAgentRouterGatewayStatus().url;
		const status = await routerServiceRegistry.start("tailscale", {
			targetUrl,
			executable: stringValue(req.body?.executable) ?? undefined,
		});
		const success = status.state === "running";
		if (success) updateRouterSettings({ tailscaleEnabled: true });
		res.status(success ? 200 : 503).json({
			success,
			service: status,
			status: routerTunnelStatus(),
		});
	});

	app.get("/api/tunnel/tailscale-install", (_req, res) => {
		res.json({
			...routerTailscaleCheck(),
			installUrl: "https://tailscale.com/download/windows",
			managedInstall: false,
		});
	});

	app.get("/api/headroom/status", async (_req, res) => {
		res.json(await routerHeadroomStatus());
	});

	app.post("/api/headroom/start", async (_req, res) => {
		const status = await routerHeadroomStatus();
		if (status.ok) {
			updateRouterSettings({ headroomEnabled: true, headroomUrl: status.url });
			res.json({ success: true, ...status });
			return;
		}
		const settings = getRouterSettings();
		const port = headroomPort(settings.headroomUrl);
		const service = await routerServiceRegistry.start("headroom", { port });
		const success = service.state === "running";
		if (success) updateRouterSettings({ headroomEnabled: true });
		res.status(success ? 200 : 503).json({ ...status, success, service });
	});

	app.post("/api/headroom/stop", async (_req, res) => {
		const service = await routerServiceRegistry.stop("headroom");
		updateRouterSettings({ headroomEnabled: false });
		res.json({ stopped: service.state === "stopped", service });
	});

	app.get("/v1/models", (_req, res) => {
		res.json(buildOpenAIModelList(getResolutionOptions()));
	});
	app.get("/v1/models/info", (req, res) => {
		const id = typeof req.query.id === "string" ? req.query.id : "";
		const kind =
			typeof req.query.kind === "string"
				? parseModelKind(req.query.kind)
				: undefined;
		if (!id) {
			res.status(400).json({
				error: {
					message: "Missing required query param: id.",
					type: "invalid_request_error",
				},
			});
			return;
		}
		const info = buildRouterModelInfo(id, getResolutionOptions(), kind);
		if (!info) {
			res.status(404).json({
				error: {
					message: `Model not found: ${id}`,
					type: "not_found",
				},
			});
			return;
		}
		res.json(info);
	});
	app.get("/v1/models/:kind", (req, res) => {
		const kindFilter = routerModelKindsForSlug(req.params.kind);
		if (!kindFilter) {
			res.status(404).json({
				error: {
					message: `Unknown model kind: ${req.params.kind}. Supported: ${Object.keys(ROUTER_MODEL_KIND_SLUGS).join(", ")}`,
					type: "invalid_request_error",
				},
			});
			return;
		}
		res.json(
			buildOpenAIModelList({
				...getResolutionOptions(),
				kindFilter,
			}),
		);
	});
	app.get("/v1beta/models", (_req, res) => {
		res.json(buildGeminiModelList(getResolutionOptions()));
	});

	app.post("/v1/compress", (req, res) => {
		const mode = parseTokenSaverMode(req.body?.mode);
		const text = extractCompressInput(req.body);

		if (!text) {
			res.status(400).json({
				error: {
					message: "Expected a string in `text` or `input`.",
					type: "invalid_request_error",
				},
			});
			return;
		}

		const preview = previewRouterTokenSaver({ text, mode });
		res.json({
			object: "router.compression",
			mode,
			changed: preview.result.changed,
			filter: preview.result.filter,
			input_bytes: preview.result.bytesBefore,
			output_bytes: preview.result.bytesAfter,
			saved_bytes: preview.result.savedBytes,
			notice: preview.notice,
			output: preview.result.text,
		});
	});

	app.post("/v1/chat/completions", handleChatCompletions);
	app.post("/v1/responses", handleResponses);
	app.post("/v1/messages", handleAnthropicMessages);
	app.post("/v1/messages/count_tokens", handleCountTokens);
	app.post("/v1/embeddings", handleEmbeddings);
	app.post("/v1/images/generations", (req, res) =>
		handleOpenAIProxy(req, res, "/images/generations"),
	);
	app.post("/v1/audio/speech", (req, res) =>
		handleOpenAIProxy(req, res, "/audio/speech"),
	);
	app.get("/v1/audio/voices", async (req, res) => {
		const result = await listRouterTtsVoices({
			apiKey: stringQuery(req.query.apiKey),
			lang: stringQuery(req.query.lang),
			provider: stringQuery(req.query.provider) ?? "openai",
		});
		res.status(result.status).json(result.body);
	});
	app.post("/v1/search", handleSearch);
	app.post("/v1/web/fetch", handleWebFetch);

	app.get("/api/usage/stats", (req, res) => {
		const period = parseUsagePeriod(req.query.period, true);
		if (!period) {
			res.status(400).json({ error: "Invalid period" });
			return;
		}
		res.json(getRouterUsageCompatStats(period));
	});
	app.get("/api/usage/history", (_req, res) => {
		res.json(getRouterUsageCompatStats("all"));
	});
	app.get("/api/usage/providers", (_req, res) => {
		res.json({ providers: getRouterUsageProviders() });
	});
	app.get(["/api/usage/logs", "/api/usage/request-logs"], (_req, res) => {
		res.json(getRouterUsageLogs(200));
	});
	app.get("/api/usage/request-details", (req, res) => {
		const page = parsePositiveIntegerQuery(req.query.page, 1);
		const pageSize = parsePositiveIntegerQuery(req.query.pageSize, 20);
		if (page < 1) {
			res.status(400).json({ error: "Page must be >= 1" });
			return;
		}
		if (pageSize < 1 || pageSize > 100) {
			res.status(400).json({ error: "PageSize must be between 1 and 100" });
			return;
		}
		res.json(
			getRouterUsageRequestDetails({
				connectionId: stringQuery(req.query.connectionId),
				endDate: stringQuery(req.query.endDate),
				model: stringQuery(req.query.model),
				page,
				pageSize,
				provider: stringQuery(req.query.provider),
				startDate: stringQuery(req.query.startDate),
				status: stringQuery(req.query.status),
			}),
		);
	});
	app.get("/api/usage/stream", streamRouterUsageStats);
	app.get("/api/usage/chart", (req, res) => {
		const period = parseUsagePeriod(req.query.period, false);
		if (!period || period === "all") {
			res.status(400).json({ error: "Invalid period" });
			return;
		}
		res.json(getRouterUsageChart(period));
	});
	app.delete("/api/usage", (_req, res) => {
		res.json(clearRouterUsage());
	});
	app.get("/api/usage/:connectionId/codex-reset-credits", (req, res) => {
		const result = getRouterCodexResetCredits(req.params.connectionId, false);
		res.status(result.status).json(result.body);
	});
	app.post("/api/usage/:connectionId/codex-reset-credits", (req, res) => {
		const result = getRouterCodexResetCredits(req.params.connectionId, true);
		res.status(result.status).json(result.body);
	});
	app.get("/api/usage/:connectionId", (req, res) => {
		const result = getRouterConnectionUsage(req.params.connectionId);
		res.status(result.status).json(result.body);
	});
	app.get("/api/translator/console-logs", (_req, res) => {
		initTranslatorConsoleCapture();
		res.json({ success: true, logs: translatorConsoleLogs });
	});
	app.delete("/api/translator/console-logs", (_req, res) => {
		translatorConsoleLogs.splice(0, translatorConsoleLogs.length);
		translatorConsoleEmitter.emit("clear");
		res.json({ success: true });
	});
	app.get("/api/translator/console-logs/stream", streamTranslatorConsoleLogs);
	app.get("/api/translator/load", (req, res) => {
		const result = loadTranslatorLogFile(stringQuery(req.query.file));
		res.status(result.status).json(result.body);
	});
	app.post("/api/translator/save", (req, res) => {
		const result = saveTranslatorLogFile(
			stringValue(req.body?.file),
			req.body?.content,
		);
		res.status(result.status).json(result.body);
	});
	app.post("/api/translator/translate", (req, res) => {
		const result = translateRouterDebugRequest(req.body);
		res.status(result.status).json(result.body);
	});
	app.post("/api/translator/send", sendTranslatorDebugRequest);
	app.get("/api/pricing/defaults", (_req, res) => {
		res.json(getRouterDefaultPricing());
	});
	app.get("/api/pricing", (_req, res) => {
		res.json(getRouterPricing());
	});
	app.patch("/api/pricing", (req, res) => {
		try {
			res.json(updateRouterPricing(parsePricingBody(req.body)));
		} catch (error) {
			res.status(400).json({ error: errorMessage(error) });
		}
	});
	app.delete("/api/pricing", (req, res) => {
		res.json(
			resetRouterPricing({
				provider: stringQuery(req.query.provider),
				model: stringQuery(req.query.model),
			}),
		);
	});
	app.get("/api/models/alias", (_req, res) => {
		res.json({ aliases: getRouterAliases() });
	});
	app.put("/api/models/alias", (req, res) => {
		const alias = String(req.body?.alias ?? "");
		const targetModel = String(req.body?.targetModel ?? req.body?.model ?? "");
		res.json({
			success: true,
			model: targetModel,
			alias,
			aliases: upsertRouterAlias({ alias, targetModel }),
		});
	});
	app.post("/api/models/alias", (req, res) => {
		res.json({
			aliases: upsertRouterAlias({
				alias: String(req.body?.alias ?? ""),
				targetModel: String(req.body?.targetModel ?? req.body?.model ?? ""),
			}),
		});
	});
	app.delete("/api/models/alias", (req, res) => {
		const alias = stringQuery(req.query.alias);
		if (!alias) {
			res.status(400).json({ error: "Alias required" });
			return;
		}
		res.json({ success: true, aliases: deleteRouterAlias(alias) });
	});
	app.delete("/api/models/alias/:alias", (req, res) => {
		res.json({ aliases: deleteRouterAlias(req.params.alias) });
	});
	app.get("/api/models/custom", (_req, res) => {
		res.json({ models: getRouterCustomModels() });
	});
	app.post("/api/models/custom", (req, res) => {
		const result = upsertRouterCustomModel(parseCustomModelBody(req.body));
		res.status(result.added ? 201 : 200).json({
			success: true,
			added: result.added,
			models: result.models,
		});
	});
	app.delete("/api/models/custom", (req, res) => {
		const providerAlias = String(req.query.providerAlias ?? "");
		const id = String(req.query.id ?? "");
		const type = parseModelKind(req.query.type);
		res.json({
			success: true,
			models: deleteRouterCustomModel({ providerAlias, id, type }),
		});
	});
	app.get("/api/models/disabled", (req, res) => {
		const providerAlias =
			typeof req.query.providerAlias === "string"
				? req.query.providerAlias
				: undefined;
		const models = getRouterDisabledModels(providerAlias);
		if (providerAlias) {
			res.json({ ids: models.map((model) => model.id), models });
			return;
		}
		res.json({ disabled: getRouterDisabledModelMap(), models });
	});
	app.post("/api/models/disabled", (req, res) => {
		res.json({
			success: true,
			models: disableRouterModels({
				ids: parseModelList(req.body?.ids) ?? [],
				providerAlias: String(req.body?.providerAlias ?? ""),
				reason:
					typeof req.body?.reason === "string" ? req.body.reason : undefined,
			}),
		});
	});
	app.delete("/api/models/disabled", (req, res) => {
		const providerAlias = String(req.query.providerAlias ?? "");
		const id = typeof req.query.id === "string" ? req.query.id : undefined;
		res.json({
			success: true,
			models: enableRouterModels({
				ids: id ? [id] : undefined,
				providerAlias,
			}),
		});
	});
	app.get("/api/models/availability", (_req, res) => {
		const models = getRouterModelAvailability();
		res.json({
			models,
			recent: models,
			unavailableCount: models.filter((model) => model.status !== "available")
				.length,
		});
	});
	app.post("/api/models/availability", (req, res) => {
		if (req.body?.action !== "clearCooldown") {
			res.status(400).json({ error: "Invalid request" });
			return;
		}
		res.json({ ok: true });
	});
	app.post("/api/models/test", async (req, res) => {
		const result = await testRouterModel({
			kind: parseModelKind(req.body?.kind),
			model: String(req.body?.model ?? ""),
		});
		res.status(result.ok ? 200 : (result.status ?? 502)).json(result);
	});
	app.get("/api/combos", (_req, res) => {
		res.json({
			defaultCombos: Object.values(AGENT_COMBOS),
			customCombos: getRouterCustomCombos(),
		});
	});
	app.post("/api/combos", (req, res) => {
		res.json({
			customCombos: upsertRouterCustomCombo({
				name: String(req.body?.name ?? ""),
				models: Array.isArray(req.body?.models) ? req.body.models : [],
			}),
		});
	});
	app.delete("/api/combos/:name", (req, res) => {
		res.json({ customCombos: deleteRouterCustomCombo(req.params.name) });
	});
	app.get("/api/providers", (_req, res) => {
		res.json({ connections: listRouterProviderConnections() });
	});
	app.post("/api/providers/validate", async (req, res) => {
		const provider = parseProviderKeyId(req.body?.provider);
		const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey : "";
		if (!provider || !apiKey.trim()) {
			res.status(400).json({ error: "Provider and API key required" });
			return;
		}
		res.json(await validateRouterProviderKey(provider, apiKey));
	});
	app.post("/api/providers/test-batch", async (req, res) => {
		const result = await testRouterProviderAccounts({
			mode: typeof req.body?.mode === "string" ? req.body.mode : "",
			providerId:
				typeof req.body?.providerId === "string" ? req.body.providerId : null,
		});
		res.status(result.ok ? 200 : 400).json(result.body);
	});
	app.post("/api/providers", async (req, res) => {
		const provider = parseProviderKeyId(req.body?.provider);
		const body = toJsonObject(req.body);
		const key =
			stringValue(body.apiKey) ??
			stringValue(body.key) ??
			stringValue(body.accessToken) ??
			stringValue(body.access_token) ??
			"";
		if (!provider) {
			res.status(400).json({ error: "Invalid provider" });
			return;
		}
		if (!key.trim()) {
			res.status(400).json({ error: "API Key is required" });
			return;
		}
		const account = createRouterProviderAccount({
			provider,
			key,
			name: typeof req.body?.name === "string" ? req.body.name : undefined,
			authType: parseProviderAccountInputAuthType(body.authType, key),
			email: stringValue(body.email) ?? null,
			expiresAt:
				stringValue(body.expiresAt) ?? stringValue(body.expires_at) ?? null,
			idToken: stringValue(body.idToken) ?? stringValue(body.id_token) ?? null,
			providerSpecificData: {
				...jsonObjectValue(body.providerSpecificData),
				...jsonObjectValue(body.provider_specific_data),
				...(stringValue(body.oauthProvider)
					? { oauthProvider: stringValue(body.oauthProvider) }
					: {}),
			},
			refreshToken:
				stringValue(body.refreshToken) ??
				stringValue(body.refresh_token) ??
				null,
		})
			.filter((candidate) => candidate.provider === provider)
			.sort(
				(a, b) =>
					new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
			)[0];
		if (!account) {
			res.status(500).json({ error: "Failed to create provider" });
			return;
		}
		if (
			typeof req.body?.priority === "number" ||
			typeof req.body?.isActive === "boolean"
		) {
			updateRouterProviderAccount({
				id: account.id,
				priority:
					typeof req.body.priority === "number" ? req.body.priority : undefined,
				isActive:
					typeof req.body.isActive === "boolean"
						? req.body.isActive
						: undefined,
			});
		}
		res.status(201).json({
			connection: providerConnectionView(account.id),
		});
	});
	app.get("/api/providers/:id", (req, res) => {
		const connection = providerConnectionView(req.params.id);
		if (!connection) {
			res.status(404).json({ error: "Connection not found" });
			return;
		}
		res.json({ connection });
	});
	app.get("/api/providers/:id/models", async (req, res) => {
		const result = await listProviderAccountModels(req.params.id);
		res.status(result.status).json(result.body);
	});
	app.post("/api/providers/:id/test", async (req, res) => {
		const result = await testProviderAccount(req.params.id);
		res.status(result.status).json(result.body);
	});
	app.post("/api/providers/:id/test-models", async (req, res) => {
		const result = await testProviderAccountModels({
			connectionId: req.params.id,
			limit:
				typeof req.body?.limit === "number"
					? req.body.limit
					: typeof req.query.limit === "string"
						? Number(req.query.limit)
						: undefined,
		});
		res.status(result.status).json(result.body);
	});
	app.put("/api/providers/:id", (req, res) => {
		const existing = listRouterProviderAccountViews().find(
			(account) => account.id === req.params.id,
		);
		if (!existing) {
			res.status(404).json({ error: "Connection not found" });
			return;
		}
		updateRouterProviderAccount({
			id: req.params.id,
			authType: parseOptionalProviderAccountAuthType(req.body?.authType),
			email: optionalStringValue(req.body, "email"),
			expiresAt: optionalStringAliasValue(req.body, [
				"expiresAt",
				"expires_at",
			]),
			idToken: optionalStringAliasValue(req.body, ["idToken", "id_token"]),
			key:
				optionalStringAliasValue(req.body, [
					"apiKey",
					"key",
					"accessToken",
					"access_token",
				]) ?? undefined,
			name: typeof req.body?.name === "string" ? req.body.name : undefined,
			priority:
				typeof req.body?.priority === "number" ? req.body.priority : undefined,
			providerSpecificData:
				req.body?.providerSpecificData &&
				typeof req.body.providerSpecificData === "object"
					? jsonObjectValue(req.body.providerSpecificData)
					: req.body?.provider_specific_data &&
							typeof req.body.provider_specific_data === "object"
						? jsonObjectValue(req.body.provider_specific_data)
						: undefined,
			refreshToken: optionalStringAliasValue(req.body, [
				"refreshToken",
				"refresh_token",
			]),
			isActive:
				typeof req.body?.isActive === "boolean" ? req.body.isActive : undefined,
		});
		res.json({ connection: providerConnectionView(req.params.id) });
	});
	app.delete("/api/providers/:id", (req, res) => {
		const existing = listRouterProviderAccountViews().find(
			(account) => account.id === req.params.id,
		);
		if (!existing) {
			res.status(404).json({ error: "Connection not found" });
			return;
		}
		deleteRouterProviderAccount(req.params.id);
		res.json({ message: "Connection deleted successfully" });
	});
	app.get("/api/oauth/providers", (_req, res) => {
		res.json({
			providers: OAUTH_PROVIDER_COMPATIBILITY.map((provider) => ({
				...provider,
				connectionCount: listRouterProviderAccountViews(
					provider.keyProvider,
				).filter((account) => account.authType !== "api-key").length,
			})),
		});
	});
	app.get("/api/media-providers/tts/voices", async (req, res) => {
		const result = await listRouterTtsVoices({
			apiKey: stringQuery(req.query.apiKey),
			lang: stringQuery(req.query.lang),
			provider: stringQuery(req.query.provider) ?? "edge-tts",
		});
		res.status(result.status).json(result.body);
	});
	app.get("/api/oauth/:provider/authorize", (req, res) => {
		const result = buildOAuthAuthorizeResponse(req.params.provider, req.query);
		res.status(result.status).json(result.body);
	});
	app.get("/api/oauth/:provider/device-code", (req, res) => {
		const provider = resolveOAuthProvider(req.params.provider);
		if (!provider) {
			res.status(404).json({ error: "OAuth provider not supported by ADE" });
			return;
		}
		res.status(400).json({
			error: "Device-code OAuth is not supported for this ADE provider.",
			provider,
			authorizeUrl: `/api/oauth/${req.params.provider}/authorize`,
			importTokenUrl: `/api/oauth/${req.params.provider}/import-token`,
		});
	});
	app.post("/api/oauth/:provider/import-token", (req, res) => {
		const result = importOAuthTokenConnection(req.params.provider, req.body);
		res.status(result.ok ? 201 : result.status).json(result.body);
	});
	app.post("/api/oauth/:provider/exchange", async (req, res) => {
		const body = toJsonObject(req.body);
		const code = typeof body.code === "string" ? body.code.trim() : "";
		if (looksLikeJwt(code)) {
			const result = importOAuthTokenConnection(req.params.provider, {
				...body,
				accessToken: code,
				authType: "access-token",
			});
			res.status(result.ok ? 201 : result.status).json(result.body);
			return;
		}
		const result = await exchangeOAuthCodeConnection(req.params.provider, body);
		res.status(result.status).json(result.body);
	});
	app.post("/api/oauth/:provider/poll", (req, res) => {
		const provider = resolveOAuthProvider(req.params.provider);
		res.status(provider ? 501 : 404).json(
			provider
				? {
						success: false,
						pending: false,
						error:
							"Device-code polling is not automated in ADE yet. Import an access token instead.",
						provider,
						importTokenUrl: `/api/oauth/${req.params.provider}/import-token`,
					}
				: { error: "OAuth provider not supported by ADE" },
		);
	});
	app.post("/api/oauth/:provider/:accountId/refresh", async (req, res) => {
		const provider = resolveOAuthProvider(req.params.provider);
		if (!provider) {
			res.status(404).json({ error: "OAuth provider not supported by ADE" });
			return;
		}
		const result = await refreshOAuthAccount({
			accountId: req.params.accountId,
			force: req.body?.force !== false,
			providerId: req.params.provider,
		});
		res.status(result.status).json(result.body);
	});
	app.post("/api/providers/:id/refresh", async (req, res) => {
		const result = await refreshOAuthAccount({
			accountId: req.params.id,
			force: req.body?.force !== false,
		});
		res.status(result.status).json(result.body);
	});
	app.get("/api/cli-tools/all-statuses", (_req, res) => {
		res.json(buildCliToolStatuses());
	});
	app.get("/api/cli-tools/antigravity-mitm/alias", (req, res) => {
		res.json({ aliases: getRouterMitmAliases(stringQuery(req.query.tool)) });
	});
	app.put("/api/cli-tools/antigravity-mitm/alias", (req, res) => {
		const tool = typeof req.body?.tool === "string" ? req.body.tool : "";
		const mappings =
			req.body?.mappings && typeof req.body.mappings === "object"
				? (req.body.mappings as Record<string, string>)
				: null;
		if (!tool || !mappings) {
			res.status(400).json({ error: "tool and mappings required" });
			return;
		}
		res.json({
			success: true,
			aliases: setRouterMitmAliases(tool, mappings),
		});
	});
	app.get("/api/cli-tools/antigravity-mitm", (_req, res) => {
		res.json(buildMitmStatus());
	});
	app.post("/api/cli-tools/antigravity-mitm", (_req, res) => {
		res.status(409).json({
			error:
				"MITM requires an administrator executor and explicit operation-specific consent.",
			code: "privileged_consent_required",
			contract: PRIVILEGED_OPERATION_CONTRACT,
			...buildMitmStatus(),
		});
	});
	app.patch("/api/cli-tools/antigravity-mitm", (_req, res) => {
		res.status(409).json({
			error:
				"DNS and certificate mutation requires an administrator executor and explicit operation-specific consent.",
			code: "privileged_consent_required",
			contract: PRIVILEGED_OPERATION_CONTRACT,
			...buildMitmStatus(),
		});
	});
	app.delete("/api/cli-tools/antigravity-mitm", (_req, res) => {
		res.json({ success: true, running: false });
	});
	app.get("/api/cli-tools/:settingsRoute", (req, res) => {
		const tool = parseCliSettingsRoute(req.params.settingsRoute);
		if (!tool) {
			res.status(404).json({ error: "CLI tool settings route not found" });
			return;
		}
		res.json(buildCliToolStatus(tool));
	});
	app.post("/api/cli-tools/:settingsRoute", (req, res) => {
		const tool = parseCliSettingsRoute(req.params.settingsRoute);
		if (!tool) {
			res.status(404).json({ error: "CLI tool settings route not found" });
			return;
		}
		try {
			res.json(applyCliToolSettings(tool, req.body));
		} catch (error) {
			res.status(400).json({ error: errorMessage(error) });
		}
	});
	app.delete("/api/cli-tools/:settingsRoute", (req, res) => {
		const tool = parseCliSettingsRoute(req.params.settingsRoute);
		if (!tool) {
			res.status(404).json({ error: "CLI tool settings route not found" });
			return;
		}
		try {
			res.json(resetCliToolSettings(tool));
		} catch (error) {
			res.status(400).json({ error: errorMessage(error) });
		}
	});
	app.get("/api/proxy-pools", (req, res) => {
		const isActive = booleanQuery(req.query.isActive);
		const includeUsage = req.query.includeUsage === "true";
		const proxyPools = getRouterProxyPools(
			isActive === undefined ? {} : { isActive },
		).map((pool) => ({
			...pool,
			...(includeUsage ? { boundConnectionCount: 0 } : {}),
		}));
		res.json({ proxyPools });
	});
	app.post("/api/proxy-pools", (req, res) => {
		try {
			const proxyPool = createRouterProxyPool(parseProxyPoolBody(req.body));
			res.status(201).json({ proxyPool });
		} catch (error) {
			res.status(400).json({ error: errorMessage(error) });
		}
	});
	app.post("/api/proxy-pools/vercel-deploy", (req, res) => {
		try {
			const proxyPool = createRelayProxyPoolFromBody(req.body, "vercel");
			res.status(201).json({ proxyPool, deployUrl: proxyPool.proxyUrl });
		} catch (error) {
			res.status(400).json({ error: errorMessage(error) });
		}
	});
	app.post("/api/proxy-pools/cloudflare-deploy", (req, res) => {
		try {
			const proxyPool = createRelayProxyPoolFromBody(req.body, "cloudflare");
			res.status(201).json({ proxyPool, deployUrl: proxyPool.proxyUrl });
		} catch (error) {
			res.status(400).json({ error: errorMessage(error) });
		}
	});
	app.post("/api/proxy-pools/deno-deploy", (req, res) => {
		try {
			const proxyPool = createRelayProxyPoolFromBody(req.body, "deno");
			res.status(201).json({ proxyPool, deployUrl: proxyPool.proxyUrl });
		} catch (error) {
			res.status(400).json({ error: errorMessage(error) });
		}
	});
	app.get("/api/proxy-pools/:id", (req, res) => {
		const proxyPool = getRouterProxyPoolById(req.params.id);
		if (!proxyPool) {
			res.status(404).json({ error: "Proxy pool not found" });
			return;
		}
		res.json({ proxyPool });
	});
	app.put("/api/proxy-pools/:id", (req, res) => {
		const existing = getRouterProxyPoolById(req.params.id);
		if (!existing) {
			res.status(404).json({ error: "Proxy pool not found" });
			return;
		}
		try {
			const proxyPool = updateRouterProxyPool(
				req.params.id,
				parseProxyPoolUpdateBody(req.body),
			);
			res.json({ proxyPool });
		} catch (error) {
			res.status(400).json({ error: errorMessage(error) });
		}
	});
	app.delete("/api/proxy-pools/:id", (req, res) => {
		const deleted = deleteRouterProxyPool(req.params.id);
		if (!deleted) {
			res.status(404).json({ error: "Proxy pool not found" });
			return;
		}
		res.json({ success: true });
	});
	app.post("/api/proxy-pools/:id/test", async (req, res) => {
		const proxyPool = getRouterProxyPoolById(req.params.id);
		if (!proxyPool) {
			res.status(404).json({ error: "Proxy pool not found" });
			return;
		}
		const result = await testRouterProxyPool(proxyPool, {
			testUrl:
				typeof req.body?.testUrl === "string" ? req.body.testUrl : undefined,
			timeoutMs:
				typeof req.body?.timeoutMs === "number"
					? req.body.timeoutMs
					: undefined,
		});
		updateRouterProxyPool(proxyPool.id, {
			isActive: result.ok,
			lastError: result.error,
			lastTestedAt: result.testedAt,
			testStatus: result.ok ? "active" : "error",
		});
		res.status(result.ok ? 200 : 502).json(result);
	});
	app.get("/api/provider-nodes", (_req, res) => {
		res.json({ nodes: getRouterProviderNodes() });
	});
	app.post("/api/provider-nodes/validate", async (req, res) => {
		res.json(
			await validateRouterProviderNode(
				parseProviderNodeValidationBody(req.body),
			),
		);
	});
	app.post("/api/provider-nodes", (req, res) => {
		const node = createRouterProviderNode(parseProviderNodeBody(req.body));
		res.status(201).json({ node });
	});
	app.get("/api/provider-nodes/:id/models", async (req, res) => {
		const result = await discoverRouterProviderNodeModels({
			id: req.params.id,
		});
		res.status(result.ok ? 200 : (result.status ?? 502)).json(result);
	});
	app.post("/api/provider-nodes/:id/import-models", async (req, res) => {
		const result = await discoverRouterProviderNodeModels({
			apply: true,
			id: req.params.id,
		});
		res.status(result.ok ? 200 : (result.status ?? 502)).json(result);
	});
	app.post("/api/provider-nodes/:id/validate", async (req, res) => {
		res.json(
			await validateRouterProviderNode({
				...parseProviderNodeValidationBody(req.body),
				id: req.params.id,
			}),
		);
	});
	app.put("/api/provider-nodes/:id", (req, res) => {
		res.json({
			nodes: updateRouterProviderNode(
				req.params.id,
				parseProviderNodeBody(req.body),
			),
		});
	});
	app.delete("/api/provider-nodes/:id", (req, res) => {
		res.json({ nodes: deleteRouterProviderNode(req.params.id) });
	});

	const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error("[agent-router-gateway] Request failed:", error);
		res.status(500).json({
			error: {
				message,
				type: "server_error",
			},
		});
	};
	app.use(errorHandler);

	return app;
}

function isAllowedGatewayOrigin(origin: string): boolean {
	try {
		const url = new URL(origin);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			["localhost", "127.0.0.1", "::1"].includes(url.hostname)
		);
	} catch {
		return false;
	}
}

function jsonRequestBodyParser(
	req: Request,
	res: ExpressResponse,
	next: (error?: unknown) => void,
) {
	if (req.body !== undefined || !requestMayHaveBody(req.method)) {
		next();
		return;
	}

	if (!isJsonContentType(req.headers["content-type"])) {
		next();
		return;
	}

	let totalBytes = 0;
	let responded = false;
	const chunks: Buffer[] = [];
	req.on("data", (chunk: Buffer | string) => {
		if (responded) return;
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += buffer.byteLength;
		if (totalBytes > JSON_BODY_LIMIT_BYTES) {
			responded = true;
			res.status(413).json({
				error: {
					message: "JSON body exceeds 50mb limit",
					type: "request_too_large",
				},
			});
			return;
		}
		chunks.push(buffer);
	});
	req.on("end", () => {
		if (responded) return;
		const raw = Buffer.concat(chunks).toString("utf8").trim();
		if (!raw) {
			req.body = {};
			next();
			return;
		}
		try {
			req.body = JSON.parse(raw);
			next();
		} catch {
			res.status(400).json({
				error: {
					message: "Invalid JSON request body",
					type: "invalid_request_error",
				},
			});
		}
	});
	req.on("error", next);
}

function requestMayHaveBody(method: string): boolean {
	return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function isJsonContentType(value: string | string[] | undefined): boolean {
	const contentType = Array.isArray(value) ? value[0] : value;
	if (!contentType) return false;
	const mime = contentType.split(";")[0]?.trim().toLowerCase();
	return mime === "application/json" || Boolean(mime?.endsWith("+json"));
}

async function handleChatCompletions(req: Request, res: ExpressResponse) {
	const body = await prepareRouterRequestBody(req.body, res, "openai-chat");
	const nodeTarget = resolveProviderNodeTarget(body.model, [
		"openai-compatible",
		"anthropic-compatible",
	]);
	if (nodeTarget) {
		if (writeDisabledModelError(res, nodeTarget)) return;
		await handleProviderNodeChat(nodeTarget, body, req, res);
		return;
	}

	const result = await fetchOpenRouterWithFallback(body);
	if (!result.ok) {
		res.status(result.status).json(result.body);
		return;
	}

	setUsageLocals(res, {
		account: result.account,
		model: result.model,
		provider: "openrouter",
	});
	await pipeUpstreamResponse(result.upstream, res);
}

async function handleResponses(req: Request, res: ExpressResponse) {
	const body = await prepareRouterRequestBody(
		req.body,
		res,
		"openai-responses",
	);
	const nodeTarget = resolveProviderNodeTarget(body.model, [
		"openai-compatible",
		"anthropic-compatible",
	]);
	if (nodeTarget) {
		if (writeDisabledModelError(res, nodeTarget)) return;
		await handleProviderNodeResponses(nodeTarget, body, req, res);
		return;
	}

	const { input, instructions, max_output_tokens, ...rest } = body;
	const messages = responsesInputToMessages(body);
	const chatBody = {
		...rest,
		model: typeof body.model === "string" ? body.model : "budget-coding",
		messages,
		max_tokens: max_output_tokens ?? body.max_tokens,
		stream: false,
	};
	void input;
	void instructions;

	const result = await fetchOpenRouterWithFallback(chatBody);
	if (!result.ok) {
		res.status(result.status).json(result.body);
		return;
	}

	setUsageLocals(res, {
		account: result.account,
		model: result.model,
		provider: "openrouter",
	});
	const upstream = await readJson(result.upstream);
	const text = extractAssistantText(upstream);
	const usage = extractOpenAIUsage(upstream);
	res.json({
		id: `resp_${cryptoId()}`,
		object: "response",
		created_at: Math.floor(Date.now() / 1000),
		status: "completed",
		model: result.model,
		output_text: text,
		output: [
			{
				id: `msg_${cryptoId()}`,
				type: "message",
				status: "completed",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text,
						annotations: [],
					},
				],
			},
		],
		usage: {
			input_tokens: usage.prompt_tokens,
			output_tokens: usage.completion_tokens,
			total_tokens: usage.total_tokens,
		},
	});
}

async function handleAnthropicMessages(req: Request, res: ExpressResponse) {
	const body = await prepareRouterRequestBody(
		req.body,
		res,
		"anthropic-messages",
	);
	const nodeTarget = resolveProviderNodeTarget(body.model, [
		"openai-compatible",
		"anthropic-compatible",
	]);
	if (nodeTarget) {
		if (writeDisabledModelError(res, nodeTarget)) return;
		await handleProviderNodeAnthropicMessages(nodeTarget, body, req, res);
		return;
	}

	const messages = anthropicMessagesToOpenAiMessages(body);
	const chatBody = {
		model: typeof body.model === "string" ? body.model : "budget-coding",
		messages,
		max_tokens: body.max_tokens,
		temperature: body.temperature,
		stream: false,
	};

	const result = await fetchOpenRouterWithFallback(chatBody);
	if (!result.ok) {
		res.status(result.status).json(result.body);
		return;
	}

	setUsageLocals(res, {
		account: result.account,
		model: result.model,
		provider: "openrouter",
	});
	const upstream = await readJson(result.upstream);
	const text = extractAssistantText(upstream);
	const usage = extractOpenAIUsage(upstream);
	res.json({
		id: `msg_${cryptoId()}`,
		type: "message",
		role: "assistant",
		model: result.model,
		content: [{ type: "text", text }],
		stop_reason: extractStopReason(upstream),
		stop_sequence: null,
		usage: {
			input_tokens: usage.prompt_tokens,
			output_tokens: usage.completion_tokens,
		},
	});
}

async function prepareRouterRequestBody(
	input: unknown,
	res: ExpressResponse,
	protocol: "openai-chat" | "openai-responses" | "anthropic-messages",
): Promise<JsonObject> {
	const result = await applyRouterTokenSaversToRequest(
		toJsonObject(input),
		getRouterSettings(),
		{ protocol },
	);
	if (result.changed) {
		res.setHeader("X-ADE-Token-Saver", result.modes.join(","));
		res.setHeader("X-ADE-Token-Saved-Bytes", String(result.savedBytes));
	}
	if (result.headroomFailed) {
		res.setHeader("X-ADE-Headroom", "fail-open");
	}
	return result.body as JsonObject;
}

function getAgentCoordinatorRuntime(): AgentCoordinatorRuntime<
	RouterCoordinatorWorkerOutput,
	RouterCoordinatorFinalOutput
> {
	coordinatorRuntime ??= new AgentCoordinatorRuntime({
		maxParallel: 4,
		retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5000 },
		isInfrastructureError: (error) =>
			error instanceof AgentInfrastructureError ||
			(error instanceof Error &&
				/(rate limit|timeout|network|capacity|overload|ECONN|5\d\d)/i.test(
					error.message,
				)),
		executeWorker: async ({ brief, signal }) => {
			const model = coordinatorModelFromMetadata(
				brief.metadata,
				"claude-sonnet-5",
			);
			const prompt = [
				"You are a focused ADE worker. Complete only the assigned brief.",
				"Return a compact report with outcome, evidence, uncertainty, and recommended next action.",
				"Do not include raw logs or unrelated context.",
				JSON.stringify({
					objective: brief.objective,
					role: brief.role,
					context: brief.context,
				}),
			].join("\n\n");
			const subscription = await executeClaudeSubscriptionPrompt({
				model: claudeCliModel(model, "claude-sonnet-5"),
				prompt,
				signal,
			});
			if (subscription) {
				return {
					output: {
						briefId: brief.id,
						model: subscription.model,
						text: subscription.text,
					},
					usage: subscription.usage,
				};
			}
			const result = await fetchOpenRouterWithFallback(
				{
					model,
					stream: false,
					messages: [
						{
							role: "system",
							content:
								"You are a focused ADE worker. Complete only the assigned brief. Return a compact report with outcome, evidence, uncertainty, and recommended next action. Do not include raw logs or unrelated context.",
						},
						{
							role: "user",
							content: prompt,
						},
					],
				},
				signal,
			);
			if (!result.ok) throw coordinatorGatewayError(result);
			const upstream = await readJson(result.upstream);
			const usage = extractOpenAIUsage(upstream);
			return {
				output: {
					briefId: brief.id,
					model: result.model,
					text: extractAssistantText(upstream),
				},
				usage: {
					inputTokens: usage.prompt_tokens,
					outputTokens: usage.completion_tokens,
				},
			};
		},
		synthesize: async ({ objective, metadata, workers, signal }) => {
			const model = coordinatorModelFromMetadata(
				metadata,
				"claude-fable-5",
				"synthesisModel",
			);
			const prompt = [
				"You are ADE Fable Coordinator and final judge.",
				"Reconcile worker reports by evidence, identify unresolved uncertainty, and produce one coherent verified answer to the original objective. Never decide by vote alone.",
				JSON.stringify({
					objective,
					reports: workers.map((worker) => worker.output),
				}),
			].join("\n\n");
			const subscription = await executeClaudeSubscriptionPrompt({
				model: claudeCliModel(model, "claude-fable-5"),
				prompt,
				signal,
			});
			if (subscription) {
				return {
					output: { model: subscription.model, text: subscription.text },
					usage: subscription.usage,
				};
			}
			const result = await fetchOpenRouterWithFallback(
				{
					model,
					stream: false,
					messages: [
						{
							role: "system",
							content:
								"You are ADE Fable Coordinator and final judge. Reconcile worker reports by evidence, identify unresolved uncertainty, and produce one coherent verified answer to the original objective. Never decide by vote alone.",
						},
						{
							role: "user",
							content: prompt,
						},
					],
				},
				signal,
			);
			if (!result.ok) throw coordinatorGatewayError(result);
			const upstream = await readJson(result.upstream);
			const usage = extractOpenAIUsage(upstream);
			return {
				output: { model: result.model, text: extractAssistantText(upstream) },
				usage: {
					inputTokens: usage.prompt_tokens,
					outputTokens: usage.completion_tokens,
				},
			};
		},
	});
	return coordinatorRuntime;
}

function parseCoordinatorRunInput(input: unknown): StartAgentRunInput {
	const body = toJsonObject(input);
	const objective = stringValue(body.objective)?.trim() ?? "";
	const rawBriefs = Array.isArray(body.briefs) ? body.briefs.slice(0, 16) : [];
	const briefs: AgentWorkerBrief[] = rawBriefs.map((entry, index) => {
		const brief = toJsonObject(entry);
		const metadata = jsonObjectValue(brief.metadata);
		return {
			id: stringValue(brief.id)?.trim() || `worker-${index + 1}`,
			objective: stringValue(brief.objective)?.trim() || objective,
			role: stringValue(brief.role) ?? undefined,
			context: brief.context,
			metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
		};
	});
	if (briefs.length === 0 && objective) {
		briefs.push(
			{
				id: "solution",
				role: "implementation specialist",
				objective: `Propose the strongest concrete solution for: ${objective}`,
			},
			{
				id: "review",
				role: "critical reviewer",
				objective: `Find correctness, security, and regression risks for: ${objective}`,
			},
			{
				id: "verification",
				role: "verification specialist",
				objective: `Define evidence and end-to-end validation for: ${objective}`,
			},
		);
	}
	const metadata = jsonObjectValue(body.metadata);
	return {
		id: stringValue(body.id) ?? undefined,
		objective,
		briefs,
		metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
	};
}

function coordinatorModelFromMetadata(
	metadata: Record<string, unknown> | undefined,
	fallback: string,
	key = "model",
): string {
	const value = metadata?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function coordinatorGatewayError(result: GatewayFailure): Error {
	const message =
		stringValue(toJsonObject(result.body.error).message) ??
		stringValue(result.body.error) ??
		`Coordinator provider request failed with HTTP ${result.status}`;
	if (result.status === 429 || result.status >= 500) {
		return new AgentInfrastructureError(message, {
			code: `HTTP_${result.status}`,
		});
	}
	return Object.assign(new Error(message), { code: `HTTP_${result.status}` });
}

async function executeClaudeSubscriptionPrompt({
	model,
	prompt,
	signal,
}: {
	model: string;
	prompt: string;
	signal: AbortSignal;
}): Promise<{
	model: string;
	text: string;
	usage: { inputTokens: number; outputTokens: number };
} | null> {
	if (!commandAvailable("claude")) return null;
	return new Promise((resolve, reject) => {
		const child = spawn(
			"claude",
			[
				prompt,
				"--print",
				"--model",
				model,
				"--output-format",
				"json",
				"--tools=",
			],
			{
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
				signal,
			},
		);
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
		child.stdout?.on("data", (chunk) => {
			if (stdout.length < 8 * 1024 * 1024) stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			if (stderr.length < 256 * 1024) stderr += String(chunk);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			if (signal.aborted) reject(new AgentRunCancelledError());
			else if ((error as NodeJS.ErrnoException).code === "ENOENT")
				resolve(null);
			else resolve(null);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (signal.aborted) {
				reject(new AgentRunCancelledError());
				return;
			}
			if (code !== 0 || !stdout.trim()) {
				void stderr;
				resolve(null);
				return;
			}
			try {
				const value = JSON.parse(stdout) as JsonObject;
				const usage = jsonObjectValue(value.usage);
				const text =
					stringValue(value.result) ??
					stringValue(value.output) ??
					stringValue(value.text) ??
					stdout.trim();
				resolve({
					model,
					text,
					usage: {
						inputTokens: numericValue(usage.input_tokens ?? usage.inputTokens),
						outputTokens: numericValue(
							usage.output_tokens ?? usage.outputTokens,
						),
					},
				});
			} catch {
				resolve({
					model,
					text: stdout.trim(),
					usage: { inputTokens: 0, outputTokens: 0 },
				});
			}
		});
	});
}

function claudeCliModel(model: string, fallback: string): string {
	if (!model.trim() || model === "budget-coding") return fallback;
	return model.replace(/^anthropic\//, "");
}

function numericValue(value: unknown): number {
	const parsed = Number(value ?? 0);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function handleCountTokens(req: Request, res: ExpressResponse) {
	const body = toJsonObject(req.body);
	const inputTokens = estimateTokens({
		system: body.system,
		messages: body.messages,
		tools: body.tools,
	});
	res.json({ input_tokens: inputTokens });
}

async function handleEmbeddings(req: Request, res: ExpressResponse) {
	const body = toJsonObject(req.body);
	const nodeTarget = resolveProviderNodeTarget(body.model, [
		"custom-embedding",
		"openai-compatible",
	]);
	if (!nodeTarget) {
		await handleOpenAIProxy(req, res, "/embeddings");
		return;
	}
	if (writeDisabledModelError(res, nodeTarget)) return;

	const result = await fetchProviderNodeWithFallback({
		body: withModel(body, nodeTarget.model),
		nodeTarget,
		path: "/embeddings",
		req,
	});
	if (!result.ok) {
		res.status(result.status).json(result.body);
		return;
	}

	setProviderNodeUsageLocals(res, result);
	await pipeUpstreamResponse(result.upstream, res);
}

async function handleProviderNodeChat(
	nodeTarget: ProviderNodeTarget,
	body: JsonObject,
	req: Request,
	res: ExpressResponse,
) {
	const { node } = nodeTarget;

	if (node.type === "openai-compatible" && node.apiType === "responses") {
		const result = await fetchProviderNodeWithFallback({
			body: chatBodyToResponsesBody(body, nodeTarget.model),
			nodeTarget,
			path: "/responses",
			req,
		});
		if (!result.ok) {
			res.status(result.status).json(result.body);
			return;
		}
		setProviderNodeUsageLocals(res, result);
		if (body.stream === true) {
			await pipeNormalizedProviderStream(result.upstream, res, {
				model: nodeTarget.model,
				source: "openai-responses",
				target: "openai-chat",
			});
			return;
		}
		const upstream = await readJson(result.upstream);
		res.json(responsesToOpenAiChatResponse(upstream, nodeTarget));
		return;
	}

	if (node.type === "openai-compatible") {
		const result = await fetchProviderNodeWithFallback({
			body: withModel(body, nodeTarget.model),
			nodeTarget,
			path: "/chat/completions",
			req,
		});
		if (!result.ok) {
			res.status(result.status).json(result.body);
			return;
		}
		setProviderNodeUsageLocals(res, result);
		await pipeUpstreamResponse(result.upstream, res);
		return;
	}

	const result = await fetchProviderNodeWithFallback({
		body: openAiChatToAnthropicBody(body, nodeTarget.model, {
			stream: body.stream === true,
		}),
		nodeTarget,
		path: "/messages",
		req,
	});
	if (!result.ok) {
		res.status(result.status).json(result.body);
		return;
	}
	setProviderNodeUsageLocals(res, result);
	if (body.stream === true) {
		await pipeAnthropicStreamAsOpenAiChat(result.upstream, res, nodeTarget);
		return;
	}
	const upstream = await readJson(result.upstream);
	res.json(anthropicToOpenAiChatResponse(upstream, nodeTarget));
}

async function handleProviderNodeResponses(
	nodeTarget: ProviderNodeTarget,
	body: JsonObject,
	req: Request,
	res: ExpressResponse,
) {
	const { node } = nodeTarget;

	if (node.type === "openai-compatible" && node.apiType === "responses") {
		const result = await fetchProviderNodeWithFallback({
			body: withModel(body, nodeTarget.model),
			nodeTarget,
			path: "/responses",
			req,
		});
		if (!result.ok) {
			res.status(result.status).json(result.body);
			return;
		}
		setProviderNodeUsageLocals(res, result);
		await pipeUpstreamResponse(result.upstream, res);
		return;
	}

	if (node.type === "openai-compatible") {
		const result = await fetchProviderNodeWithFallback({
			body: responsesBodyToChatBody(body, nodeTarget.model),
			nodeTarget,
			path: "/chat/completions",
			req,
		});
		if (!result.ok) {
			res.status(result.status).json(result.body);
			return;
		}
		setProviderNodeUsageLocals(res, result);
		if (body.stream === true) {
			await pipeNormalizedProviderStream(result.upstream, res, {
				model: nodeTarget.model,
				source: "openai-chat",
				target: "openai-responses",
			});
			return;
		}
		const upstream = await readJson(result.upstream);
		res.json(openAiChatToResponsesResponse(upstream, nodeTarget));
		return;
	}

	const result = await fetchProviderNodeWithFallback({
		body: openAiChatToAnthropicBody(
			responsesBodyToChatBody(body, nodeTarget.model),
			nodeTarget.model,
		),
		nodeTarget,
		path: "/messages",
		req,
	});
	if (!result.ok) {
		res.status(result.status).json(result.body);
		return;
	}
	setProviderNodeUsageLocals(res, result);
	if (body.stream === true) {
		await pipeNormalizedProviderStream(result.upstream, res, {
			model: nodeTarget.model,
			source: "anthropic-messages",
			target: "openai-responses",
		});
		return;
	}
	const upstream = await readJson(result.upstream);
	res.json(anthropicToResponsesResponse(upstream, nodeTarget));
}

async function handleProviderNodeAnthropicMessages(
	nodeTarget: ProviderNodeTarget,
	body: JsonObject,
	req: Request,
	res: ExpressResponse,
) {
	const { node } = nodeTarget;

	if (node.type === "anthropic-compatible") {
		const result = await fetchProviderNodeWithFallback({
			body: withModel(body, nodeTarget.model),
			nodeTarget,
			path: "/messages",
			req,
		});
		if (!result.ok) {
			res.status(result.status).json(result.body);
			return;
		}
		setProviderNodeUsageLocals(res, result);
		await pipeUpstreamResponse(result.upstream, res);
		return;
	}

	if (node.apiType === "responses") {
		const result = await fetchProviderNodeWithFallback({
			body: anthropicBodyToResponsesBody(body, nodeTarget.model),
			nodeTarget,
			path: "/responses",
			req,
		});
		if (!result.ok) {
			res.status(result.status).json(result.body);
			return;
		}
		setProviderNodeUsageLocals(res, result);
		if (body.stream === true) {
			await pipeNormalizedProviderStream(result.upstream, res, {
				model: nodeTarget.model,
				source: "openai-responses",
				target: "anthropic-messages",
			});
			return;
		}
		const upstream = await readJson(result.upstream);
		res.json(responsesToAnthropicMessage(upstream, nodeTarget));
		return;
	}

	const result = await fetchProviderNodeWithFallback({
		body: {
			model: nodeTarget.model,
			messages: anthropicMessagesToOpenAiMessages(body),
			max_tokens: body.max_tokens,
			temperature: body.temperature,
			stream: body.stream === true,
		},
		nodeTarget,
		path: "/chat/completions",
		req,
	});
	if (!result.ok) {
		res.status(result.status).json(result.body);
		return;
	}
	setProviderNodeUsageLocals(res, result);
	if (body.stream === true) {
		await pipeOpenAiChatStreamAsAnthropic(result.upstream, res, nodeTarget);
		return;
	}
	const upstream = await readJson(result.upstream);
	res.json(openAiChatToAnthropicMessage(upstream, nodeTarget));
}

async function handleOpenAIProxy(
	req: Request,
	res: ExpressResponse,
	upstreamPath: string,
	{ rawBody = false }: { rawBody?: boolean } = {},
) {
	const accounts = getProviderAccountCredentials("openai");
	if (accounts.length === 0) {
		res.status(401).json({
			error: {
				message:
					"OpenAI API key is not configured in ADE. Add it in the router dashboard provider key section to use this endpoint.",
				type: "authentication_error",
			},
		});
		return;
	}

	const contentType = req.header("content-type");
	const body = rawBody
		? (req.body as BodyInit)
		: (JSON.stringify(req.body ?? {}) as BodyInit);
	let lastFailure: { status: number; text: string } | null = null;

	for (const account of accounts) {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${account.key}`,
		};
		if (contentType) headers["Content-Type"] = contentType;
		if (!rawBody) headers["Content-Type"] = "application/json";

		const upstream = await fetch(`${OPENAI_BASE_URL}${upstreamPath}`, {
			method: "POST",
			headers,
			body,
		});

		if (upstream.ok) {
			markProviderAccountSuccess(account);
			setUsageLocals(res, {
				account,
				model: inferModelForRequest(req.path, req.body),
				provider: "openai",
			});
			await pipeUpstreamResponse(upstream, res);
			return;
		}

		const text = await upstream.text().catch(() => upstream.statusText);
		lastFailure = { status: upstream.status, text };
		markProviderAccountFailure({
			credential: account,
			status: upstream.status,
			text,
		});
	}

	res.status(lastFailure?.status ?? 502).json({
		error: {
			message: "All OpenAI accounts failed.",
			type: "upstream_error",
			details: lastFailure,
		},
	});
}

async function handleSearch(req: Request, res: ExpressResponse) {
	const body = toJsonObject(req.body);
	const query = extractSearchQuery(body);
	if (!query) {
		res.status(400).json({
			error: {
				message: "Expected `query`, `q`, or a message containing search text.",
				type: "invalid_request_error",
			},
		});
		return;
	}

	const braveAccounts = getProviderAccountCredentials("brave-search");
	for (const account of braveAccounts) {
		const url = new URL(BRAVE_SEARCH_URL);
		url.searchParams.set("q", query);
		url.searchParams.set("count", String(Number(body.count ?? 10)));
		const upstream = await fetch(url, {
			headers: {
				Accept: "application/json",
				"X-Subscription-Token": account.key,
			},
		});
		if (upstream.ok) {
			markProviderAccountSuccess(account);
			setUsageLocals(res, {
				account,
				model: "brave-search",
				provider: "brave-search",
			});
			await pipeUpstreamResponse(upstream, res);
			return;
		}
		const text = await upstream.text().catch(() => upstream.statusText);
		markProviderAccountFailure({
			credential: account,
			status: upstream.status,
			text,
		});
	}

	const perplexityAccounts = getProviderAccountCredentials("perplexity");
	for (const account of perplexityAccounts) {
		const upstream = await fetch(PERPLEXITY_CHAT_COMPLETIONS_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${account.key}`,
			},
			body: JSON.stringify({
				model: typeof body.model === "string" ? body.model : "sonar",
				messages: [
					{
						role: "user",
						content: query,
					},
				],
			}),
		});
		if (upstream.ok) {
			markProviderAccountSuccess(account);
			setUsageLocals(res, {
				account,
				model: typeof body.model === "string" ? body.model : "sonar",
				provider: "perplexity",
			});
			await pipeUpstreamResponse(upstream, res);
			return;
		}
		const text = await upstream.text().catch(() => upstream.statusText);
		markProviderAccountFailure({
			credential: account,
			status: upstream.status,
			text,
		});
	}

	res.status(401).json({
		error: {
			message: "Configure Brave Search or Perplexity in ADE to use /v1/search.",
			type: "authentication_error",
		},
	});
}

async function handleWebFetch(req: Request, res: ExpressResponse) {
	const body = toJsonObject(req.body);
	const url = typeof body.url === "string" ? body.url : "";
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		res.status(400).json({
			error: {
				message: "Expected a valid `url`.",
				type: "invalid_request_error",
			},
		});
		return;
	}

	if (!["http:", "https:"].includes(parsedUrl.protocol)) {
		res.status(400).json({
			error: {
				message: "Only http and https URLs can be fetched.",
				type: "invalid_request_error",
			},
		});
		return;
	}

	const upstream = await fetch(parsedUrl, {
		headers: { Accept: "text/html,application/json,text/plain,*/*" },
	});
	const text = await upstream.text();
	const maxBytes = Number(body.maxBytes ?? 1_000_000);
	res.status(upstream.status).json({
		url: parsedUrl.toString(),
		status: upstream.status,
		content_type: upstream.headers.get("content-type"),
		text: text.slice(0, Number.isFinite(maxBytes) ? maxBytes : 1_000_000),
		truncated: text.length > maxBytes,
	});
}

export async function testRouterModel({
	kind = "llm",
	model,
}: {
	kind?: RouterModelKind;
	model: string;
}): Promise<RouterModelTestResult> {
	const requestedModel = model.trim();
	const modelKind = parseModelKind(kind);
	const startedAtMs = Date.now();
	const provider = inferProviderFromModel(requestedModel);
	let method = "chat";

	const finish = (result: Omit<RouterModelTestResult, "latencyMs">) => {
		const latencyMs = Date.now() - startedAtMs;
		recordRouterModelAvailability({
			error: result.error,
			httpStatus: result.status,
			kind: result.kind,
			latencyMs,
			method: result.method,
			model: result.model,
			provider: result.provider,
			status: result.ok ? "available" : "unavailable",
		});
		return { ...result, latencyMs };
	};

	if (!requestedModel) {
		return finish({
			ok: false,
			model: requestedModel,
			kind: modelKind,
			provider,
			status: 400,
			error: "Model required",
			method,
		});
	}

	if (isModelPathDisabled(requestedModel)) {
		return finish({
			ok: false,
			model: requestedModel,
			kind: modelKind,
			provider,
			status: 403,
			error: "Model is disabled in the router registry",
			method,
		});
	}

	try {
		const baseUrl = `http://${GATEWAY_HOST}:${activePort}`;
		let response: globalThis.Response;

		if (modelKind === "embedding") {
			method = "embeddings";
			response = await fetchWithTimeout(
				`${baseUrl}/v1/embeddings`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ model: requestedModel, input: "test" }),
				},
				15_000,
			);
			return finish(
				await modelTestResultFromResponse({
					response,
					model: requestedModel,
					kind: modelKind,
					provider,
					method,
					validate: (data) => {
						const embedding = (
							(data.data as unknown[])?.[0] as JsonObject | undefined
						)?.embedding;
						return Array.isArray(embedding)
							? null
							: "Provider returned no embedding data";
					},
				}),
			);
		}

		if (modelKind === "image") {
			method = "images";
			response = await fetchWithTimeout(
				`${baseUrl}/v1/images/generations`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ model: requestedModel, prompt: "test" }),
				},
				15_000,
			);
			return finish(
				await modelTestResultFromResponse({
					response,
					model: requestedModel,
					kind: modelKind,
					provider,
					method,
					validate: (data) =>
						Array.isArray(data.data) && data.data.length > 0
							? null
							: "Provider returned no image data",
				}),
			);
		}

		if (modelKind === "stt") {
			method = "transcriptions";
			const form = new FormData();
			form.append("file", createSilentWavFile(), "test.wav");
			form.append("model", requestedModel);
			response = await fetchWithTimeout(
				`${baseUrl}/v1/audio/transcriptions`,
				{
					method: "POST",
					body: form,
				},
				15_000,
			);
			return finish(
				await modelTestResultFromResponse({
					response,
					model: requestedModel,
					kind: modelKind,
					provider,
					method,
					validate: (data) =>
						typeof data.text === "string" && data.text.trim()
							? null
							: "Provider returned no transcription text",
				}),
			);
		}

		method = "chat";
		response = await fetchWithTimeout(
			`${baseUrl}/v1/chat/completions`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: requestedModel,
					max_tokens: 16,
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			},
			15_000,
		);
		return finish(
			await modelTestResultFromResponse({
				response,
				model: requestedModel,
				kind: modelKind,
				provider,
				method,
				validate: (data) =>
					Array.isArray(data.choices) && data.choices.length > 0
						? null
						: "Provider returned no completion choices",
			}),
		);
	} catch (error) {
		return finish({
			ok: false,
			model: requestedModel,
			kind: modelKind,
			provider,
			status: null,
			error: getProviderNodeNetworkErrorMessage(error),
			method,
		});
	}
}

export async function validateRouterProviderNode(
	input: RouterProviderNodeValidationInput,
): Promise<RouterProviderNodeValidationResult> {
	try {
		const candidate = resolveProviderNodeValidationCandidate(input);
		if (!candidate.ok) return { valid: false, ...candidate.error };

		const { node } = candidate;
		if (!isValidHttpUrl(node.baseUrl)) {
			return { valid: false, error: "Invalid URL format", status: 400 };
		}

		if (node.apiKeyAccountId && candidate.credentials.length === 0) {
			return {
				valid: false,
				error: "Selected provider account is not available.",
				status: 401,
			};
		}

		if (node.type === "custom-embedding") {
			return validateProviderNodeEmbedding(candidate, input.modelId);
		}

		const modelsAttempt = await fetchProviderNodeModels(candidate);
		if (modelsAttempt.ok) {
			return {
				valid: true,
				method: "models",
				models: modelsAttempt.models,
			};
		}

		if (modelsAttempt.status === 401 || modelsAttempt.status === 403) {
			return {
				valid: false,
				error: "API key unauthorized",
				status: modelsAttempt.status,
			};
		}

		const modelId = input.modelId?.trim();
		if (!modelId) {
			return {
				valid: false,
				error: getModelsErrorMessage(modelsAttempt.status),
				status: modelsAttempt.status,
			};
		}

		return validateProviderNodeInference(candidate, modelId);
	} catch (error) {
		return {
			valid: false,
			error: getProviderNodeNetworkErrorMessage(error),
			status: 500,
		};
	}
}

export async function discoverRouterProviderNodeModels(
	input: RouterProviderNodeValidationInput & { apply?: boolean },
): Promise<RouterProviderNodeDiscoveryResult> {
	try {
		const candidate = resolveProviderNodeValidationCandidate(input);
		if (!candidate.ok) {
			return {
				ok: false,
				error: candidate.error.error,
				status: candidate.error.status,
				models: [],
			};
		}

		if (!isValidHttpUrl(candidate.node.baseUrl)) {
			return {
				ok: false,
				error: "Invalid URL format",
				status: 400,
				models: [],
			};
		}

		if (candidate.node.apiKeyAccountId && candidate.credentials.length === 0) {
			return {
				ok: false,
				error: "Selected provider account is not available.",
				status: 401,
				models: [],
			};
		}

		const result = await fetchProviderNodeModels(candidate);
		if (!result.ok) {
			return {
				ok: false,
				error: getModelsErrorMessage(result.status),
				status: result.status,
				models: [],
			};
		}

		const models = result.models;
		if (input.apply && input.id) {
			updateRouterProviderNode(input.id, {
				models: models.map((model) => model.id),
			});
		}

		return {
			ok: true,
			models,
			applied: Boolean(input.apply && input.id),
		};
	} catch (error) {
		return {
			ok: false,
			error: getProviderNodeNetworkErrorMessage(error),
			status: 500,
			models: [],
		};
	}
}

async function validateProviderNodeEmbedding(
	candidate: ProviderNodeValidationCandidate,
	modelId: string | undefined,
): Promise<RouterProviderNodeValidationResult> {
	const model = modelId?.trim();
	if (!model) {
		return {
			valid: false,
			error: "Model ID required for embedding validation",
			status: 400,
		};
	}

	const attempts = providerNodeValidationAttempts(candidate);
	for (const accountAttempt of attempts) {
		const account = accountAttempt
			? await refreshProviderCredentialIfNeeded(accountAttempt)
			: undefined;
		let upstream = await fetchWithTimeout(
			providerNodeUrl(candidate.node, "/embeddings"),
			{
				method: "POST",
				headers: providerNodeHeadersForVersion(candidate.node, account),
				body: JSON.stringify({ model, input: "ping" }),
			},
		);
		if (isAuthFailureStatus(upstream.status) && account?.refreshToken) {
			const refreshedAccount =
				await refreshProviderCredentialAfterAuthFailure(account);
			if (refreshedAccount) {
				upstream = await fetchWithTimeout(
					providerNodeUrl(candidate.node, "/embeddings"),
					{
						method: "POST",
						headers: providerNodeHeadersForVersion(
							candidate.node,
							refreshedAccount,
						),
						body: JSON.stringify({ model, input: "ping" }),
					},
				);
			}
		}
		if (upstream.ok) {
			const data = await readJson(upstream);
			const embedding = (
				(data.data as unknown[])?.[0] as JsonObject | undefined
			)?.embedding;
			return {
				valid: true,
				method: "embeddings",
				dimensions: Array.isArray(embedding) ? embedding.length : null,
			};
		}
		if (isAuthFailureStatus(upstream.status)) {
			return {
				valid: false,
				error: "API key unauthorized",
				status: upstream.status,
			};
		}
		const text = await upstream.text().catch(() => upstream.statusText);
		return {
			valid: false,
			error: `Embeddings request failed (${upstream.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
			method: "embeddings",
			status: upstream.status,
		};
	}

	return {
		valid: false,
		error: "No validation attempt was available.",
		status: 401,
	};
}

async function validateProviderNodeInference(
	candidate: ProviderNodeValidationCandidate,
	modelId: string,
): Promise<RouterProviderNodeValidationResult> {
	const { node } = candidate;
	const isResponses =
		node.type === "openai-compatible" && node.apiType === "responses";
	const path =
		node.type === "anthropic-compatible"
			? "/messages"
			: isResponses
				? "/responses"
				: "/chat/completions";
	const body =
		node.type === "anthropic-compatible"
			? {
					model: modelId,
					messages: [{ role: "user", content: "ping" }],
					max_tokens: 1,
				}
			: isResponses
				? {
						model: modelId,
						input: "ping",
						max_output_tokens: 1,
						stream: false,
					}
				: {
						model: modelId,
						messages: [{ role: "user", content: "ping" }],
						max_tokens: 1,
					};
	const method =
		node.type === "anthropic-compatible"
			? "messages"
			: isResponses
				? "responses"
				: "chat";

	for (const accountAttempt of providerNodeValidationAttempts(candidate)) {
		const account = accountAttempt
			? await refreshProviderCredentialIfNeeded(accountAttempt)
			: undefined;
		let upstream = await fetchWithTimeout(providerNodeUrl(node, path), {
			method: "POST",
			headers: providerNodeHeadersForVersion(node, account),
			body: JSON.stringify(body),
		});
		if (isAuthFailureStatus(upstream.status) && account?.refreshToken) {
			const refreshedAccount =
				await refreshProviderCredentialAfterAuthFailure(account);
			if (refreshedAccount) {
				upstream = await fetchWithTimeout(providerNodeUrl(node, path), {
					method: "POST",
					headers: providerNodeHeadersForVersion(node, refreshedAccount),
					body: JSON.stringify(body),
				});
			}
		}
		if (upstream.ok) return { valid: true, method };
		return {
			valid: false,
			error: getChatErrorMessage(upstream.status),
			method,
			status: upstream.status,
		};
	}

	return {
		valid: false,
		error: "No validation attempt was available.",
		status: 401,
	};
}

async function fetchProviderNodeWithFallback({
	body,
	nodeTarget,
	path,
	req,
}: {
	body: JsonObject;
	nodeTarget: ProviderNodeTarget;
	path: string;
	req: Request;
}): Promise<ProviderNodeSuccess | GatewayFailure> {
	const { node } = nodeTarget;
	const credentials = getProviderNodeCredentials(node);
	if (node.apiKeyAccountId && credentials.length === 0) {
		return {
			ok: false,
			status: 401,
			body: {
				error: {
					message:
						"Provider node account is selected but no active credential is available.",
					type: "authentication_error",
				},
			},
		};
	}

	const attempts: Array<RouterProviderCredential | undefined> =
		credentials.length > 0 ? credentials : [undefined];
	let lastFailure: { account: string; status: number; text: string } | null =
		null;

	for (const account of attempts) {
		const activeAccount = account
			? await refreshProviderCredentialIfNeeded(account)
			: undefined;
		const headers = providerNodeHeaders(node, activeAccount, req);
		if (body.stream === true) headers.Accept = "text/event-stream";
		let upstream = await fetch(providerNodeUrl(node, path), {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (upstream.ok) {
			if (activeAccount) markProviderAccountSuccess(activeAccount);
			return {
				ok: true,
				account: activeAccount,
				upstream,
				node,
				model: nodeTarget.model,
			};
		}

		if (isAuthFailureStatus(upstream.status) && activeAccount?.refreshToken) {
			const refreshedAccount =
				await refreshProviderCredentialAfterAuthFailure(activeAccount);
			if (refreshedAccount) {
				const retryHeaders = providerNodeHeaders(node, refreshedAccount, req);
				if (body.stream === true) retryHeaders.Accept = "text/event-stream";
				upstream = await fetch(providerNodeUrl(node, path), {
					method: "POST",
					headers: retryHeaders,
					body: JSON.stringify(body),
				});
				if (upstream.ok) {
					markProviderAccountSuccess(refreshedAccount);
					return {
						ok: true,
						account: refreshedAccount,
						upstream,
						node,
						model: nodeTarget.model,
					};
				}
			}
		}

		const text = await upstream.text().catch(() => upstream.statusText);
		lastFailure = {
			account: activeAccount?.name ?? "no-auth",
			status: upstream.status,
			text,
		};
		if (activeAccount) {
			markProviderAccountFailure({
				credential: activeAccount,
				status: upstream.status,
				text,
			});
		}
	}

	return {
		ok: false,
		status: lastFailure?.status ?? 502,
		body: {
			error: {
				message: "Provider node request failed.",
				type: "upstream_error",
				details: lastFailure,
				node: node.id,
			},
		},
	};
}

interface ProviderNodeValidationCandidate {
	node: RouterProviderNode;
	credentials: RouterProviderCredential[];
}

type ProviderNodeCandidateResolution =
	| {
			ok: true;
			node: RouterProviderNode;
			credentials: RouterProviderCredential[];
	  }
	| {
			ok: false;
			error: {
				error: string;
				status: number;
			};
	  };

async function fetchProviderNodeModels(
	candidate: ProviderNodeValidationCandidate,
): Promise<
	| { ok: true; models: RouterDiscoveredProviderNodeModel[] }
	| { ok: false; status: number }
> {
	for (const accountAttempt of providerNodeValidationAttempts(candidate)) {
		const account = accountAttempt
			? await refreshProviderCredentialIfNeeded(accountAttempt)
			: undefined;
		let upstream = await fetchWithTimeout(
			providerNodeUrl(candidate.node, "/models"),
			{
				method: "GET",
				headers: providerNodeHeadersForVersion(candidate.node, account),
			},
		);
		if (isAuthFailureStatus(upstream.status) && account?.refreshToken) {
			const refreshedAccount =
				await refreshProviderCredentialAfterAuthFailure(account);
			if (refreshedAccount) {
				upstream = await fetchWithTimeout(
					providerNodeUrl(candidate.node, "/models"),
					{
						method: "GET",
						headers: providerNodeHeadersForVersion(
							candidate.node,
							refreshedAccount,
						),
					},
				);
			}
		}
		if (upstream.ok) {
			return {
				ok: true,
				models: parseDiscoveredProviderNodeModels(await readJson(upstream)),
			};
		}
		return { ok: false, status: upstream.status };
	}

	return { ok: false, status: 401 };
}

function resolveProviderNodeValidationCandidate(
	input: RouterProviderNodeValidationInput,
): ProviderNodeCandidateResolution {
	const existing = input.id
		? getRouterProviderNodes().find((node) => node.id === input.id)
		: undefined;
	if (input.id && !existing) {
		return {
			ok: false,
			error: { error: "Provider node not found", status: 404 },
		};
	}

	const type = input.type ?? existing?.type ?? "openai-compatible";
	const baseUrl = sanitizeProviderNodeBaseUrlForRequest(
		input.baseUrl ?? existing?.baseUrl ?? defaultProviderNodeBaseUrl(type),
		type,
	);
	const node: RouterProviderNode = {
		id: existing?.id ?? "draft-provider-node",
		type,
		name: existing?.name ?? "Draft provider node",
		prefix: existing?.prefix ?? "draft",
		baseUrl,
		apiType:
			type === "openai-compatible"
				? (input.apiType ?? existing?.apiType ?? "chat")
				: undefined,
		apiKeyProvider:
			input.apiKeyProvider ??
			existing?.apiKeyProvider ??
			defaultProviderNodeKeyProvider(type),
		apiKeyAccountId:
			input.apiKeyAccountId === undefined
				? (existing?.apiKeyAccountId ?? null)
				: input.apiKeyAccountId,
		models: existing?.models ?? [],
		isActive: existing?.isActive ?? true,
		createdAt: existing?.createdAt ?? new Date().toISOString(),
		updatedAt: existing?.updatedAt ?? new Date().toISOString(),
	};

	return {
		ok: true,
		node,
		credentials: getProviderNodeValidationCredentials(node, input),
	};
}

function getProviderNodeValidationCredentials(
	node: RouterProviderNode,
	input: RouterProviderNodeValidationInput,
): RouterProviderCredential[] {
	const directKey = input.apiKey?.trim();
	if (directKey) {
		const provider =
			input.apiKeyProvider ??
			node.apiKeyProvider ??
			defaultProviderNodeKeyProvider(node.type) ??
			"openai";
		return [
			{
				id: "direct-validation-key",
				name: "Direct validation key",
				provider,
				authType: "api-key",
				expiresAt: null,
				idToken: null,
				key: directKey,
				providerSpecificData: {},
				refreshToken: null,
				legacy: true,
			},
		];
	}

	if (!node.apiKeyProvider) return [];
	const credentials = getProviderAccountCredentials(node.apiKeyProvider);
	if (!node.apiKeyAccountId) return credentials;
	return credentials.filter(
		(credential) => credential.id === node.apiKeyAccountId,
	);
}

function providerNodeValidationAttempts({
	credentials,
}: ProviderNodeValidationCandidate): Array<
	RouterProviderCredential | undefined
> {
	return credentials.length > 0 ? credentials : [undefined];
}

function resolveProviderNodeTarget(
	model: unknown,
	allowedTypes: RouterProviderNodeType[],
): ProviderNodeTarget | null {
	const requestedModel = resolveRequestedModel(model);
	if (!requestedModel) return null;

	const slashIndex = requestedModel.indexOf("/");
	if (slashIndex <= 0 || slashIndex === requestedModel.length - 1) return null;

	const prefix = requestedModel.slice(0, slashIndex);
	const modelId = requestedModel.slice(slashIndex + 1);
	const node = getRouterProviderNodes().find(
		(candidate) =>
			candidate.isActive &&
			allowedTypes.includes(candidate.type) &&
			candidate.prefix === prefix,
	);
	if (!node) return null;

	return {
		node,
		model: modelId,
		requestedModel,
	};
}

function resolveRequestedModel(model: unknown): string | null {
	if (typeof model !== "string") return null;
	let requestedModel = model.trim();
	if (!requestedModel) return null;

	for (let depth = 0; depth < 8; depth++) {
		const alias = getRouterAliases().find(
			(candidate) => candidate.alias === requestedModel,
		);
		if (!alias) return requestedModel;
		const next = alias.targetModel.trim();
		if (!next || next === requestedModel) return requestedModel;
		requestedModel = next;
	}

	return requestedModel;
}

function getProviderNodeCredentials(
	node: RouterProviderNode,
): RouterProviderCredential[] {
	if (!node.apiKeyProvider) return [];
	const credentials = getProviderAccountCredentials(node.apiKeyProvider);
	if (!node.apiKeyAccountId) return credentials;
	return credentials.filter(
		(credential) => credential.id === node.apiKeyAccountId,
	);
}

function providerNodeHeaders(
	node: RouterProviderNode,
	account: RouterProviderCredential | undefined,
	req: Request,
): Record<string, string> {
	return providerNodeHeadersForVersion(
		node,
		account,
		req.header("anthropic-version") ?? "2023-06-01",
	);
}

function providerNodeHeadersForVersion(
	node: RouterProviderNode,
	account: RouterProviderCredential | undefined,
	anthropicVersion = "2023-06-01",
): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (!account?.key) return headers;

	if (node.type === "anthropic-compatible") {
		headers["x-api-key"] = account.key;
		headers.Authorization = `Bearer ${account.key}`;
		headers["anthropic-version"] = anthropicVersion;
		return headers;
	}

	headers.Authorization = `Bearer ${account.key}`;
	return headers;
}

function providerNodeUrl(node: RouterProviderNode, path: string): string {
	const baseUrl = node.baseUrl.replace(/\/+$/g, "");
	return baseUrl.endsWith(path) ? baseUrl : `${baseUrl}${path}`;
}

function sanitizeProviderNodeBaseUrlForRequest(
	baseUrl: string,
	type: RouterProviderNodeType,
): string {
	let sanitized = baseUrl.trim().replace(/\/+$/g, "");
	if (type === "anthropic-compatible" && sanitized.endsWith("/messages")) {
		sanitized = sanitized.slice(0, -"/messages".length);
	}
	if (type === "custom-embedding" && sanitized.endsWith("/embeddings")) {
		sanitized = sanitized.slice(0, -"/embeddings".length);
	}
	return sanitized;
}

function defaultProviderNodeBaseUrl(type: RouterProviderNodeType): string {
	if (type === "anthropic-compatible") return "https://api.anthropic.com/v1";
	return "https://api.openai.com/v1";
}

function defaultProviderNodeKeyProvider(
	type: RouterProviderNodeType,
): RouterProviderKeyId | undefined {
	if (type === "anthropic-compatible") return "anthropic";
	if (type === "openai-compatible" || type === "custom-embedding")
		return "openai";
	return undefined;
}

function setProviderNodeUsageLocals(
	res: ExpressResponse,
	result: ProviderNodeSuccess,
) {
	res.locals.routerProvider = result.node.id;
	res.locals.routerModel = `${result.node.prefix}/${result.model}`;
	if (result.account) {
		res.locals.routerAccountId = result.account.id;
		res.locals.routerAccountName = result.account.name;
	}
}

async function modelTestResultFromResponse({
	kind,
	method,
	model,
	provider,
	response,
	validate,
}: {
	kind: RouterModelKind;
	method: string;
	model: string;
	provider: string;
	response: globalThis.Response;
	validate: (data: JsonObject) => string | null;
}): Promise<Omit<RouterModelTestResult, "latencyMs">> {
	const rawText = await response.text().catch(() => "");
	let parsed: JsonObject = {};
	try {
		parsed = rawText ? (JSON.parse(rawText) as JsonObject) : {};
	} catch {
		parsed = {};
	}

	if (!response.ok) {
		const detail = errorTextFromBody(parsed) || rawText;
		return {
			ok: false,
			model,
			kind,
			provider,
			status: response.status,
			error: `HTTP ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ""}`,
			method,
		};
	}

	const providerStatus = parsed.status;
	const providerMessage =
		stringValue(parsed.msg) ??
		stringValue(parsed.message) ??
		errorTextFromBody(parsed);
	if (
		providerStatus !== undefined &&
		providerStatus !== null &&
		String(providerStatus) !== "200" &&
		String(providerStatus) !== "0" &&
		providerMessage
	) {
		return {
			ok: false,
			model,
			kind,
			provider,
			status: response.status,
			error: `Provider status ${providerStatus}: ${providerMessage.slice(0, 240)}`,
			method,
		};
	}

	if (parsed.error) {
		return {
			ok: false,
			model,
			kind,
			provider,
			status: response.status,
			error: (errorTextFromBody(parsed) ?? "Provider returned an error").slice(
				0,
				240,
			),
			method,
		};
	}

	const validationError = validate(parsed);
	return {
		ok: !validationError,
		model,
		kind,
		provider,
		status: response.status,
		error: validationError,
		method,
	};
}

function createSilentWavFile(): Blob {
	const sampleRate = 16_000;
	const channels = 1;
	const bitsPerSample = 16;
	const durationMs = 250;
	const sampleCount = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
	const dataSize = sampleCount * channels * (bitsPerSample / 8);
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);
	const writeAscii = (offset: number, value: string) => {
		for (let index = 0; index < value.length; index++) {
			view.setUint8(offset + index, value.charCodeAt(index));
		}
	};

	writeAscii(0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	writeAscii(8, "WAVE");
	writeAscii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
	view.setUint16(32, channels * (bitsPerSample / 8), true);
	view.setUint16(34, bitsPerSample, true);
	writeAscii(36, "data");
	view.setUint32(40, dataSize, true);

	return new Blob([buffer], { type: "audio/wav" });
}

function writeDisabledModelError(
	res: ExpressResponse,
	nodeTarget: ProviderNodeTarget,
): boolean {
	if (!isProviderNodeTargetDisabled(nodeTarget)) return false;
	res.status(403).json({
		error: {
			message: `Model ${nodeTarget.requestedModel} is disabled in the router registry.`,
			type: "model_disabled",
		},
	});
	return true;
}

function isProviderNodeTargetDisabled(nodeTarget: ProviderNodeTarget): boolean {
	return (
		isRouterModelDisabled(nodeTarget.node.prefix, nodeTarget.model) ||
		isRouterModelDisabled(nodeTarget.node.id, nodeTarget.model)
	);
}

function isModelPathDisabled(model: string): boolean {
	const requestedModel = resolveRequestedModel(model) ?? model;
	const nodeTarget = resolveProviderNodeTarget(requestedModel, [
		"openai-compatible",
		"anthropic-compatible",
		"custom-embedding",
	]);
	if (nodeTarget && isProviderNodeTargetDisabled(nodeTarget)) return true;
	return isRouterModelDisabledForModelPath(requestedModel);
}

function isRouterModelDisabledForModelPath(model: string): boolean {
	const slashIndex = model.indexOf("/");
	if (slashIndex <= 0 || slashIndex === model.length - 1) return false;
	return isRouterModelDisabled(
		model.slice(0, slashIndex),
		model.slice(slashIndex + 1),
	);
}

function inferProviderFromModel(model: string): string {
	const requestedModel = resolveRequestedModel(model) ?? model;
	const nodeTarget = resolveProviderNodeTarget(requestedModel, [
		"openai-compatible",
		"anthropic-compatible",
		"custom-embedding",
	]);
	if (nodeTarget) return nodeTarget.node.prefix;
	const slashIndex = requestedModel.indexOf("/");
	if (slashIndex > 0) return requestedModel.slice(0, slashIndex);
	const target = resolveRouterModelTarget(
		requestedModel,
		getResolutionOptions(),
	);
	return target?.provider ?? "router";
}

function errorTextFromBody(body: JsonObject): string | null {
	const error = body.error;
	if (typeof error === "string") return error;
	if (error && typeof error === "object") {
		const value = error as JsonObject;
		return stringValue(value.message) ?? stringValue(value.error) ?? null;
	}
	return stringValue(body.message) ?? stringValue(body.msg) ?? null;
}

async function listProviderAccountModels(
	connectionId: string,
): Promise<{ body: JsonObject; status: number }> {
	const account = listRouterProviderAccountViews().find(
		(candidate) => candidate.id === connectionId,
	);
	if (!account) return { status: 404, body: { error: "Connection not found" } };
	const credential = getProviderAccountCredentialById(
		account.provider,
		account.id,
	);
	if (!credential) {
		return {
			status: 401,
			body: { error: "No valid token found", provider: account.provider },
		};
	}

	const activeCredential = await refreshProviderCredentialIfNeeded(credential);
	const live = await fetchProviderAccountModels(activeCredential);
	const fallback = staticProviderAccountModels(account.provider);
	if (live.ok && live.models.length > 0) {
		return {
			status: 200,
			body: {
				provider: account.provider,
				connectionId,
				models: live.models,
			},
		};
	}
	if (fallback.length > 0) {
		return {
			status: 200,
			body: {
				provider: account.provider,
				connectionId,
				models: fallback,
				warning:
					live.warning ??
					`Provider ${account.provider} does not support live model listing in ADE yet; returned static catalogue.`,
			},
		};
	}
	return {
		status: live.status ?? 400,
		body: {
			error:
				live.warning ??
				`Provider ${account.provider} does not support models listing`,
			provider: account.provider,
			connectionId,
		},
	};
}

async function testProviderAccount(
	connectionId: string,
): Promise<{ body: JsonObject; status: number }> {
	const account = listRouterProviderAccountViews().find(
		(candidate) => candidate.id === connectionId,
	);
	if (!account) return { status: 404, body: { error: "Connection not found" } };
	const credential = getProviderAccountCredentialById(
		account.provider,
		account.id,
	);
	if (!credential) {
		return {
			status: 401,
			body: {
				valid: false,
				error: "No API key or access token stored for this account.",
				refreshed: false,
			},
		};
	}

	const refreshResult = await refreshProviderCredential({
		credential,
		force: false,
	});
	const credentialForTest = refreshResult.ok
		? refreshResult.credential
		: credential;
	const test = await validateRouterProviderKey(
		credentialForTest.provider,
		credentialForTest.key,
	);
	if (test.valid) {
		markProviderAccountSuccess(credentialForTest);
	} else {
		markProviderAccountFailure({
			credential: credentialForTest,
			status: test.statusCode ?? undefined,
			text: test.error ?? undefined,
		});
	}
	return {
		status: 200,
		body: {
			valid: test.valid,
			error: test.error,
			refreshed: refreshResult.ok ? refreshResult.refreshed : false,
			statusCode: test.statusCode,
			latencyMs: test.latencyMs,
			testedAt: test.testedAt,
		},
	};
}

async function testProviderAccountModels({
	connectionId,
	limit,
}: {
	connectionId: string;
	limit?: number;
}): Promise<{ body: JsonObject; status: number }> {
	const account = listRouterProviderAccountViews().find(
		(candidate) => candidate.id === connectionId,
	);
	if (!account) return { status: 404, body: { error: "Connection not found" } };
	const credential = getProviderAccountCredentialById(
		account.provider,
		account.id,
	);
	if (!credential) {
		return {
			status: 401,
			body: { error: "No API key or access token stored for this account." },
		};
	}
	const modelsResult = await listProviderAccountModels(connectionId);
	if (modelsResult.status >= 400) return modelsResult;
	const rawModels = Array.isArray(modelsResult.body.models)
		? modelsResult.body.models
		: [];
	const requestedLimit =
		typeof limit === "number" && Number.isFinite(limit) && limit > 0
			? Math.min(Math.round(limit), 100)
			: 100;
	const models = rawModels.slice(0, requestedLimit).map((item) => {
		const value = toJsonObject(item);
		const id =
			stringValue(value.id) ??
			stringValue(value.model) ??
			stringValue(value.name) ??
			"";
		return {
			id,
			name: stringValue(value.name) ?? id,
			kind: parseModelKind(value.kind ?? value.type),
		};
	});

	const activeCredential = await refreshProviderCredentialIfNeeded(credential);
	const results = [];
	for (const model of models) {
		if (!model.id) continue;
		const test = await pingProviderAccountModel(activeCredential, model.id);
		results.push({
			modelId: model.id,
			name: model.name,
			...test,
		});
	}
	return {
		status: 200,
		body: {
			provider: account.provider,
			connectionId,
			results,
			truncated: rawModels.length > models.length,
		},
	};
}

async function fetchProviderAccountModels(
	credential: RouterProviderCredential,
): Promise<{
	ok: boolean;
	models: RouterDiscoveredProviderNodeModel[];
	status?: number;
	warning?: string;
}> {
	const request = providerAccountModelsRequest(credential);
	if (!request) {
		return {
			ok: false,
			models: [],
			warning: `Provider ${credential.provider} has no live model list endpoint configured.`,
		};
	}
	let response = await fetchWithTimeout(request.url, request.init, 12_000);
	if (isAuthFailureStatus(response.status) && credential.refreshToken) {
		const refreshed =
			await refreshProviderCredentialAfterAuthFailure(credential);
		const retryRequest = refreshed
			? providerAccountModelsRequest(refreshed)
			: null;
		if (retryRequest) {
			response = await fetchWithTimeout(
				retryRequest.url,
				retryRequest.init,
				12_000,
			);
		}
	}
	if (!response.ok) {
		const text = await response.text().catch(() => response.statusText);
		return {
			ok: false,
			models: [],
			status: response.status,
			warning: `Failed to fetch models: ${response.status}${text ? ` ${text.slice(0, 160)}` : ""}`,
		};
	}
	return {
		ok: true,
		models: parseDiscoveredProviderNodeModels(await readJson(response)),
	};
}

function providerAccountModelsRequest(
	credential: RouterProviderCredential,
): { init: RequestInit; url: string } | null {
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/json",
	};
	if (credential.provider === "openrouter") {
		headers.Authorization = `Bearer ${credential.key}`;
		return {
			url: "https://openrouter.ai/api/v1/models",
			init: { headers, method: "GET" },
		};
	}
	if (credential.provider === "openai") {
		headers.Authorization = `Bearer ${credential.key}`;
		return {
			url: `${OPENAI_BASE_URL}/models`,
			init: { headers, method: "GET" },
		};
	}
	if (credential.provider === "anthropic") {
		headers["anthropic-version"] = "2023-06-01";
		headers["x-api-key"] = credential.key;
		return {
			url: "https://api.anthropic.com/v1/models",
			init: { headers, method: "GET" },
		};
	}
	if (credential.provider === "gemini") {
		return {
			url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(credential.key)}`,
			init: { headers, method: "GET" },
		};
	}
	return null;
}

function staticProviderAccountModels(
	provider: RouterProviderKeyId,
): RouterDiscoveredProviderNodeModel[] {
	const catalog = ROUTER_PROVIDER_CATALOG.find(
		(candidate) =>
			candidate.keyProvider === provider || candidate.id === provider,
	);
	const custom = getRouterCustomModels()
		.filter(
			(model) =>
				model.providerAlias === provider ||
				model.providerAlias === catalog?.id ||
				model.providerAlias === catalog?.keyProvider,
		)
		.map((model) => ({ id: model.id, name: model.name }));
	const defaults =
		catalog?.defaultModels.map((id) => ({
			id,
			name: id,
		})) ?? [];
	return [...custom, ...defaults].sort((a, b) => a.id.localeCompare(b.id));
}

async function pingProviderAccountModel(
	credential: RouterProviderCredential,
	modelId: string,
): Promise<JsonObject> {
	const startedAt = Date.now();
	try {
		const response = await fetchProviderAccountModelProbe(credential, modelId);
		const text = await response.text().catch(() => "");
		return {
			valid: response.ok,
			error: response.ok
				? null
				: `Model probe failed (${response.status})${text ? `: ${text.slice(0, 160)}` : ""}`,
			statusCode: response.status,
			latencyMs: Date.now() - startedAt,
			testedAt: new Date().toISOString(),
		};
	} catch (error) {
		return {
			valid: false,
			error: errorMessage(error),
			statusCode: null,
			latencyMs: Date.now() - startedAt,
			testedAt: new Date().toISOString(),
		};
	}
}

function fetchProviderAccountModelProbe(
	credential: RouterProviderCredential,
	modelId: string,
): Promise<globalThis.Response> {
	if (credential.provider === "anthropic") {
		return fetchWithTimeout(
			"https://api.anthropic.com/v1/messages",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"anthropic-version": "2023-06-01",
					"x-api-key": credential.key,
				},
				body: JSON.stringify({
					model: modelId,
					max_tokens: 1,
					messages: [{ role: "user", content: "ping" }],
				}),
			},
			12_000,
		);
	}
	if (
		credential.provider === "openai" ||
		credential.provider === "openrouter" ||
		credential.provider === "perplexity"
	) {
		const url =
			credential.provider === "openrouter"
				? OPENROUTER_CHAT_COMPLETIONS_URL
				: credential.provider === "perplexity"
					? PERPLEXITY_CHAT_COMPLETIONS_URL
					: `${OPENAI_BASE_URL}/chat/completions`;
		return fetchWithTimeout(
			url,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${credential.key}`,
				},
				body: JSON.stringify({
					model: modelId,
					messages: [{ role: "user", content: "ping" }],
					max_tokens: 1,
				}),
			},
			12_000,
		);
	}
	return Promise.resolve(
		new Response(
			JSON.stringify({
				error: `Model probe is not implemented for ${credential.provider}`,
			}),
			{ status: 501, headers: { "Content-Type": "application/json" } },
		),
	);
}

async function listRouterTtsVoices({
	apiKey,
	lang,
	provider,
}: {
	apiKey?: string | null;
	lang?: string | null;
	provider: string;
}): Promise<{ body: JsonObject; status: number }> {
	try {
		const normalizedProvider = provider.trim().toLowerCase() || "edge-tts";
		let voices: RouterTtsVoice[];
		if (normalizedProvider === "edge-tts") {
			voices = normalizeEdgeTtsVoices(await fetchEdgeTtsVoices());
		} else if (normalizedProvider === "local-device") {
			voices = await fetchLocalDeviceTtsVoices();
		} else if (normalizedProvider === "elevenlabs") {
			const key =
				apiKey?.trim() || getProviderAccountCredentials("elevenlabs")[0]?.key;
			if (!key) {
				return {
					status: 401,
					body: { error: "ElevenLabs API key required" },
				};
			}
			voices = normalizeElevenLabsVoices(await fetchElevenLabsVoices(key));
		} else if (normalizedProvider === "openai") {
			voices = openAiTtsVoices();
		} else {
			return {
				status: 400,
				body: {
					error: `Provider '${provider}' does not support voice listing`,
				},
			};
		}

		const filtered = lang
			? voices.filter((voice) => voice.lang === lang)
			: voices;
		return {
			status: 200,
			body: {
				voices: filtered,
				languages: groupTtsVoicesByLanguage(filtered),
				byLang: Object.fromEntries(
					groupTtsVoicesByLanguage(filtered).map((group) => [
						group.code,
						group,
					]),
				),
			},
		};
	} catch (error) {
		return {
			status: 502,
			body: { error: errorMessage(error) || "Failed to fetch voices" },
		};
	}
}

async function fetchEdgeTtsVoices(): Promise<JsonObject[]> {
	const now = Date.now();
	if (
		edgeTtsVoicesCache &&
		now - edgeTtsVoicesCache.time < 24 * 60 * 60 * 1000
	) {
		return edgeTtsVoicesCache.voices;
	}
	const response = await fetchWithTimeout(
		"https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4",
		{ headers: { "User-Agent": "ADE-router" } },
		12_000,
	);
	if (!response.ok)
		throw new Error(`Edge TTS voices fetch failed: ${response.status}`);
	const voices = (await readJson(response)) as unknown;
	const list = Array.isArray(voices) ? (voices as JsonObject[]) : [];
	edgeTtsVoicesCache = { time: now, voices: list };
	return list;
}

async function fetchElevenLabsVoices(apiKey: string): Promise<JsonObject[]> {
	const now = Date.now();
	const cached = elevenLabsVoicesCache.get(apiKey);
	if (cached && now - cached.time < 24 * 60 * 60 * 1000) return cached.voices;
	const response = await fetchWithTimeout(
		"https://api.elevenlabs.io/v1/voices",
		{
			headers: {
				"Content-Type": "application/json",
				"xi-api-key": apiKey,
			},
		},
		12_000,
	);
	if (!response.ok)
		throw new Error(`ElevenLabs voices fetch failed: ${response.status}`);
	const data = await readJson(response);
	const voices = Array.isArray(data.voices)
		? (data.voices as JsonObject[])
		: [];
	elevenLabsVoicesCache.set(apiKey, { time: now, voices });
	return voices;
}

async function fetchLocalDeviceTtsVoices(): Promise<RouterTtsVoice[]> {
	if (localDeviceVoicesCache) return localDeviceVoicesCache;
	if (process.platform !== "win32") {
		localDeviceVoicesCache = [];
		return localDeviceVoicesCache;
	}
	const script = [
		"Add-Type -AssemblyName System.Speech;",
		"$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
		"$s.GetInstalledVoices() | ForEach-Object { $v = $_.VoiceInfo;",
		"[PSCustomObject]@{ Name=$v.Name; Culture=$v.Culture.Name; Gender=$v.Gender.ToString() } }",
		"| ConvertTo-Json -Compress",
	].join(" ");
	const stdout = execFileSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-WindowStyle",
			"Hidden",
			"-Command",
			script,
		],
		{ encoding: "utf8", timeout: 8_000, windowsHide: true },
	);
	const raw = JSON.parse(stdout.trim() || "[]") as unknown;
	const list = Array.isArray(raw) ? raw : [raw];
	localDeviceVoicesCache = list
		.map((item) => {
			const value = toJsonObject(item);
			const name = stringValue(value.Name) ?? "";
			const culture = stringValue(value.Culture) ?? "en-US";
			const [voiceLang, country = ""] = culture.split("-");
			return {
				id: name,
				name,
				locale: culture,
				lang: voiceLang,
				country,
				countryName: ttsCountryName(country || voiceLang),
				langName: ttsLangName(voiceLang),
				gender: stringValue(value.Gender) ?? "",
			};
		})
		.filter((voice) => voice.id);
	return localDeviceVoicesCache;
}

function normalizeEdgeTtsVoices(voices: JsonObject[]): RouterTtsVoice[] {
	return voices
		.map((voice) => {
			const locale = stringValue(voice.Locale) ?? "en-US";
			const [voiceLang, country = ""] = locale.split("-");
			const id = stringValue(voice.ShortName) ?? stringValue(voice.Name) ?? "";
			return {
				id,
				name:
					(stringValue(voice.FriendlyName) ?? id)
						.replace(/^Microsoft\s+/i, "")
						.replace(/ Online \(Natural\) - /g, " (") || id,
				locale,
				lang: voiceLang,
				country,
				countryName: ttsCountryName(country || voiceLang),
				langName: ttsLangName(voiceLang),
				gender: stringValue(voice.Gender) ?? "",
			};
		})
		.filter((voice) => voice.id);
}

function normalizeElevenLabsVoices(voices: JsonObject[]): RouterTtsVoice[] {
	return voices
		.map((voice) => {
			const labels = jsonObjectValue(voice.labels);
			const locale = stringValue(labels.language) ?? "en";
			const [voiceLang, country = ""] = locale.split("-");
			const id = stringValue(voice.voice_id) ?? stringValue(voice.id) ?? "";
			return {
				id,
				name: stringValue(voice.name) ?? id,
				locale,
				lang: voiceLang,
				country,
				countryName: country ? ttsCountryName(country) : "",
				langName: ttsLangName(voiceLang),
				gender: stringValue(labels.gender) ?? "",
				category: stringValue(voice.category) ?? "",
			};
		})
		.filter((voice) => voice.id);
}

function openAiTtsVoices(): RouterTtsVoice[] {
	return [
		"alloy",
		"ash",
		"ballad",
		"coral",
		"echo",
		"fable",
		"nova",
		"onyx",
		"sage",
		"shimmer",
	].map((id) => ({
		id,
		name: id,
		locale: "en",
		lang: "en",
		country: "",
		countryName: "",
		langName: "English",
	}));
}

function groupTtsVoicesByLanguage(voices: RouterTtsVoice[]): Array<{
	code: string;
	name: string;
	voices: RouterTtsVoice[];
}> {
	const byLang = new Map<
		string,
		{ code: string; name: string; voices: RouterTtsVoice[] }
	>();
	for (const voice of voices) {
		const existing = byLang.get(voice.lang) ?? {
			code: voice.lang,
			name: voice.langName,
			voices: [],
		};
		existing.voices.push(voice);
		byLang.set(voice.lang, existing);
	}
	return Array.from(byLang.values()).sort((a, b) =>
		a.name.localeCompare(b.name),
	);
}

function ttsCountryName(code: string): string {
	if (!code) return "";
	try {
		return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
	} catch {
		return code;
	}
}

function ttsLangName(code: string): string {
	if (!code) return "";
	try {
		return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
	} catch {
		return code;
	}
}

interface OAuthProviderCompatibility {
	id: string;
	aliases: string[];
	keyProvider: RouterProviderKeyId;
	label: string;
	importToken: boolean;
	authorize: boolean;
	deviceCode: boolean;
	notes: string;
}

const OAUTH_PROVIDER_COMPATIBILITY: OAuthProviderCompatibility[] = [
	{
		id: "codex",
		aliases: ["openai", "chatgpt"],
		keyProvider: "openai",
		label: "Codex / OpenAI",
		importToken: true,
		authorize: true,
		deviceCode: false,
		notes:
			"Authorize with PKCE or import a Codex/OpenAI token; ADE can rotate refresh tokens automatically.",
	},
	{
		id: "claude",
		aliases: ["anthropic"],
		keyProvider: "anthropic",
		label: "Claude / Anthropic",
		importToken: true,
		authorize: true,
		deviceCode: false,
		notes:
			"Authorize with PKCE or import a Claude/Anthropic token; ADE can rotate refresh tokens automatically.",
	},
	{
		id: "gemini",
		aliases: ["google", "gemini-cli", "antigravity"],
		keyProvider: "gemini",
		label: "Gemini / Google",
		importToken: true,
		authorize: true,
		deviceCode: false,
		notes:
			"Authorize with configured Google OAuth credentials or import a Gemini token; ADE can rotate refresh tokens automatically.",
	},
	{
		id: "github",
		aliases: ["github-copilot", "copilot"],
		keyProvider: "github",
		label: "GitHub / Copilot",
		importToken: true,
		authorize: false,
		deviceCode: false,
		notes:
			"Import a GitHub or Copilot credential explicitly; ADE does not embed a private OAuth client.",
	},
	{
		id: "cursor",
		aliases: ["cursor-agent"],
		keyProvider: "cursor",
		label: "Cursor",
		importToken: true,
		authorize: false,
		deviceCode: false,
		notes:
			"Import a Cursor credential explicitly; browser login stays owned by Cursor.",
	},
	{
		id: "kiro",
		aliases: ["kiro-ai"],
		keyProvider: "kiro",
		label: "Kiro",
		importToken: true,
		authorize: false,
		deviceCode: false,
		notes:
			"Import a Kiro credential explicitly; ADE stores it in secure main-process storage.",
	},
];

function resolveOAuthProvider(
	providerId: string,
): OAuthProviderCompatibility | null {
	const normalized = providerId.trim().toLowerCase();
	return (
		OAUTH_PROVIDER_COMPATIBILITY.find(
			(provider) =>
				provider.id === normalized ||
				provider.keyProvider === normalized ||
				provider.aliases.includes(normalized),
		) ?? null
	);
}

function resolveOAuthRefreshConfig(
	providerId: string | null | undefined,
): OAuthRefreshConfig | null {
	const normalized = providerId?.trim().toLowerCase();
	if (!normalized) return null;
	return (
		Object.values(OAUTH_REFRESH_CONFIGS).find(
			(config) =>
				config.id === normalized ||
				config.keyProvider === normalized ||
				config.aliases.includes(normalized),
		) ?? null
	);
}

function resolveOAuthRefreshConfigForCredential(
	credential: RouterProviderCredential,
	providerId?: string,
): OAuthRefreshConfig | null {
	const requested = resolveOAuthRefreshConfig(providerId);
	if (requested) {
		return requested.keyProvider === credential.provider ? requested : null;
	}
	const metadataProvider = stringValue(
		credential.providerSpecificData.oauthProvider,
	);
	return (
		resolveOAuthRefreshConfig(metadataProvider) ??
		resolveOAuthRefreshConfig(credential.provider)
	);
}

function buildOAuthAuthorizeResponse(providerId: string, rawQuery: unknown) {
	const provider = resolveOAuthProvider(providerId);
	if (!provider) {
		return {
			status: 404,
			body: { error: "OAuth provider not supported by ADE" },
		};
	}
	const config = resolveOAuthRefreshConfig(provider.id);
	if (!config) {
		return {
			status: 404,
			body: { error: "OAuth provider authorize is not supported by ADE" },
		};
	}
	const client = resolveOAuthClientCredentials(
		config,
		oauthMetadataFromSource(rawQuery),
		{ requireSecret: false },
	);
	if (!client.ok) {
		return { status: client.status, body: { error: client.error, provider } };
	}

	const redirectUri =
		sourceStringValue(rawQuery, "redirect_uri") ??
		sourceStringValue(rawQuery, "redirectUri") ??
		config.defaultRedirectUri;
	const state = sourceStringValue(rawQuery, "state") ?? randomBase64Url(32);
	const pkce = config.codeChallengeMethod ? generateOAuthPkce() : null;
	const params: Record<string, string> = {
		client_id: client.clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		state,
		...buildOAuthScopeParam(config),
		...(config.extraAuthParams ?? {}),
	};
	if (config.id === "claude") params.code = "true";
	if (pkce) {
		params.code_challenge = pkce.codeChallenge;
		params.code_challenge_method = config.codeChallengeMethod ?? "S256";
	}

	const authUrl = `${config.authorizeUrl}?${buildQueryString(params)}`;
	return {
		status: 200,
		body: {
			success: true,
			authUrl,
			authorizationUrl: authUrl,
			codeVerifier: pkce?.codeVerifier ?? null,
			expiresIn: 300,
			importTokenUrl: `/api/oauth/${provider.id}/import-token`,
			provider,
			redirectUri,
			state,
		},
	};
}

async function exchangeOAuthCodeConnection(
	providerId: string,
	rawBody: JsonObject,
): Promise<{ body: JsonObject; status: number }> {
	const provider = resolveOAuthProvider(providerId);
	if (!provider) {
		return {
			status: 404,
			body: { error: "OAuth provider not supported by ADE" },
		};
	}
	const config = resolveOAuthRefreshConfig(provider.id);
	if (!config) {
		return {
			status: 404,
			body: { error: "OAuth provider exchange is not supported by ADE" },
		};
	}
	const code = sourceStringValue(rawBody, "code");
	if (!code) return { status: 400, body: { error: "code is required" } };
	const redirectUri =
		sourceStringValue(rawBody, "redirectUri") ??
		sourceStringValue(rawBody, "redirect_uri") ??
		config.defaultRedirectUri;
	const codeVerifier =
		sourceStringValue(rawBody, "codeVerifier") ??
		sourceStringValue(rawBody, "code_verifier");
	if (config.codeChallengeMethod && !codeVerifier) {
		return {
			status: 400,
			body: { error: "codeVerifier is required for this OAuth provider" },
		};
	}
	const client = resolveOAuthClientCredentials(
		config,
		oauthMetadataFromSource(rawBody),
		{ requireSecret: Boolean(config.clientSecretEnv) },
	);
	if (!client.ok) {
		return { status: client.status, body: { error: client.error, provider } };
	}

	const tokens = await exchangeOAuthCodeForTokens(config, client, {
		code,
		codeVerifier,
		redirectUri,
		state: sourceStringValue(rawBody, "state"),
	});
	if (!tokens.ok) {
		return {
			status: tokens.status ?? 400,
			body: { success: false, error: tokens.error, provider },
		};
	}

	return importOAuthTokenConnection(provider.id, {
		accessToken: tokens.accessToken,
		authType: "oauth",
		email: sourceStringValue(rawBody, "email"),
		expiresAt: tokens.expiresAt,
		idToken: tokens.idToken,
		name: sourceStringValue(rawBody, "name"),
		providerSpecificData: {
			...jsonObjectValue(rawBody.providerSpecificData),
			...jsonObjectValue(rawBody.provider_specific_data),
			...tokens.providerSpecificData,
			...(client.fromMetadata ? { oauthClientId: client.clientId } : {}),
		},
		refreshToken: tokens.refreshToken,
	});
}

async function exchangeOAuthCodeForTokens(
	provider: OAuthRefreshConfig,
	client: { clientId: string; clientSecret?: string },
	input: {
		code: string;
		codeVerifier?: string;
		redirectUri: string;
		state?: string;
	},
): Promise<OAuthRefreshResult> {
	let code = input.code;
	let state = input.state;
	if (provider.id === "claude" && code.includes("#")) {
		const [authCode, codeState] = code.split("#");
		code = authCode;
		state = codeState || state;
	}
	const payload: Record<string, string> = {
		client_id: client.clientId,
		code,
		grant_type: "authorization_code",
		redirect_uri: input.redirectUri,
		...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
	};
	if (input.codeVerifier) payload.code_verifier = input.codeVerifier;
	if (provider.id === "claude" && state) payload.state = state;

	const response = await fetchWithTimeout(
		provider.tokenUrl,
		{
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type":
					provider.exchangeEncoding === "form"
						? "application/x-www-form-urlencoded"
						: "application/json",
			},
			body:
				provider.exchangeEncoding === "form"
					? new URLSearchParams(payload)
					: JSON.stringify(payload),
		},
		15_000,
	);
	return oauthTokenResultFromResponse(provider, response, "");
}

function resolveOAuthClientCredentials(
	provider: OAuthRefreshConfig,
	source: JsonObject = {},
	options: { requireSecret: boolean },
):
	| { ok: true; clientId: string; clientSecret?: string; fromMetadata: boolean }
	| { ok: false; error: string; status: number } {
	const metadataClientId =
		stringValue(source.oauthClientId) ?? stringValue(source.clientId);
	const metadataClientSecret =
		stringValue(source.oauthClientSecret) ?? stringValue(source.clientSecret);
	const envClientId = provider.clientIdEnv
		? stringValue(process.env[provider.clientIdEnv])
		: undefined;
	const envClientSecret = provider.clientSecretEnv
		? stringValue(process.env[provider.clientSecretEnv])
		: undefined;
	const clientId = provider.clientId ?? metadataClientId ?? envClientId;
	const clientSecret =
		provider.clientSecret ?? metadataClientSecret ?? envClientSecret;
	if (!clientId) {
		return {
			ok: false,
			error: `${provider.id} OAuth client id is not configured.`,
			status: 400,
		};
	}
	if (options.requireSecret && !clientSecret) {
		return {
			ok: false,
			error: `${provider.id} OAuth client secret is not configured.`,
			status: 400,
		};
	}
	return {
		ok: true,
		clientId,
		clientSecret,
		fromMetadata: Boolean(metadataClientId),
	};
}

function oauthMetadataFromSource(source: unknown): JsonObject {
	const body = toJsonObject(source);
	return {
		...jsonObjectValue(body.meta),
		...jsonObjectValue(body.providerSpecificData),
		...jsonObjectValue(body.provider_specific_data),
		...(sourceStringValue(source, "clientId")
			? { clientId: sourceStringValue(source, "clientId") }
			: {}),
		...(sourceStringValue(source, "client_id")
			? { clientId: sourceStringValue(source, "client_id") }
			: {}),
		...(sourceStringValue(source, "oauthClientId")
			? { oauthClientId: sourceStringValue(source, "oauthClientId") }
			: {}),
		...(sourceStringValue(source, "clientSecret")
			? { clientSecret: sourceStringValue(source, "clientSecret") }
			: {}),
		...(sourceStringValue(source, "client_secret")
			? { clientSecret: sourceStringValue(source, "client_secret") }
			: {}),
		...(sourceStringValue(source, "oauthClientSecret")
			? { oauthClientSecret: sourceStringValue(source, "oauthClientSecret") }
			: {}),
	};
}

function sourceStringValue(source: unknown, key: string): string | undefined {
	const body = toJsonObject(source);
	const value = body[key];
	if (Array.isArray(value)) return stringValue(value[0]);
	return stringValue(value);
}

function buildOAuthScopeParam(
	provider: OAuthRefreshConfig,
): Record<string, string> {
	if (provider.scope) return { scope: provider.scope };
	if (provider.scopes?.length) return { scope: provider.scopes.join(" ") };
	return {};
}

function generateOAuthPkce(): {
	codeChallenge: string;
	codeVerifier: string;
} {
	const codeVerifier = randomBase64Url(64);
	return {
		codeChallenge: createHash("sha256")
			.update(codeVerifier)
			.digest("base64url"),
		codeVerifier,
	};
}

function randomBase64Url(bytes: number): string {
	return randomBytes(bytes).toString("base64url");
}

function buildQueryString(params: Record<string, string>): string {
	return Object.entries(params)
		.map(
			([key, value]) =>
				`${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
		)
		.join("&");
}

async function oauthTokenResultFromResponse(
	provider: OAuthRefreshConfig,
	response: globalThis.Response,
	fallbackRefreshToken: string | null,
): Promise<OAuthRefreshResult> {
	const text = await response.text().catch(() => "");
	let data: JsonObject = {};
	try {
		data = text ? (JSON.parse(text) as JsonObject) : {};
	} catch {
		data = {};
	}
	if (!response.ok) {
		return {
			ok: false,
			error:
				oauthRefreshErrorMessage(data, response.status) ||
				`OAuth ${provider.id} token request failed (${response.status})`,
			permanent: isPermanentOAuthRefreshError(data, response.status),
			status: response.status,
		};
	}
	const accessToken =
		stringValue(data.access_token) ??
		stringValue(data.accessToken) ??
		stringValue(data.token);
	if (!accessToken) {
		return {
			ok: false,
			error: "OAuth token response did not include an access token.",
			permanent: false,
			status: response.status,
		};
	}
	const expiresIn =
		numberValue(data.expires_in) ?? numberValue(data.expiresIn) ?? null;
	return {
		ok: true,
		accessToken,
		expiresAt: expiresIn
			? new Date(Date.now() + expiresIn * 1000).toISOString()
			: (stringValue(data.expires_at) ?? stringValue(data.expiresAt) ?? null),
		expiresIn,
		idToken: stringValue(data.id_token) ?? stringValue(data.idToken) ?? null,
		providerSpecificData: {
			...jsonObjectValue(data.providerSpecificData),
			...(stringValue(data.scope) ? { scope: stringValue(data.scope) } : {}),
		},
		refreshToken:
			stringValue(data.refresh_token) ??
			stringValue(data.refreshToken) ??
			fallbackRefreshToken,
	};
}

async function refreshOAuthAccount({
	accountId,
	force,
	providerId,
}: {
	accountId: string;
	force: boolean;
	providerId?: string;
}): Promise<{ body: JsonObject; status: number }> {
	const account = listRouterProviderAccountViews().find(
		(candidate) => candidate.id === accountId,
	);
	if (!account) return { status: 404, body: { error: "Connection not found" } };
	const credential = getProviderAccountCredentials(account.provider).find(
		(candidate) => candidate.id === account.id,
	);
	if (!credential) {
		return {
			status: 400,
			body: { error: "No access token is stored for this account." },
		};
	}
	const result = await refreshProviderCredential({
		credential,
		force,
		providerId,
	});
	if (!result.ok) {
		return {
			status: result.status ?? 400,
			body: {
				success: false,
				error: result.error,
				permanent: result.permanent,
				provider: result.provider?.id ?? null,
			},
		};
	}
	return {
		status: 200,
		body: {
			success: true,
			refreshed: result.refreshed,
			provider: result.provider?.id ?? null,
			connection: providerConnectionView(result.credential.id),
		},
	};
}

export async function refreshRouterProviderAccount({
	force = true,
	id,
}: {
	force?: boolean;
	id: string;
}): Promise<JsonObject> {
	const result = await refreshOAuthAccount({ accountId: id, force });
	if (result.status >= 400) {
		throw new Error(String(result.body.error ?? "Provider refresh failed"));
	}
	return result.body;
}

async function refreshProviderCredential({
	credential,
	force,
	providerId,
}: {
	credential: RouterProviderCredential;
	force: boolean;
	providerId?: string;
}): Promise<OAuthRefreshCredentialResult> {
	const provider = resolveOAuthRefreshConfigForCredential(
		credential,
		providerId,
	);
	if (!provider) {
		return {
			ok: true,
			credential,
			provider: null,
			refreshed: false,
		};
	}
	if (!credential.refreshToken) {
		return {
			ok: false,
			error: "This provider account has no refresh token.",
			permanent: true,
			provider,
			status: 400,
		};
	}
	if (!force && !shouldRefreshProviderCredential(credential, provider)) {
		return {
			ok: true,
			credential,
			provider,
			refreshed: false,
		};
	}

	const lockKey = oauthRefreshLockKey(provider, credential);
	const existing = oauthRefreshLocks.get(lockKey);
	if (existing) return existing;

	const pending: Promise<OAuthRefreshCredentialResult> =
		(async (): Promise<OAuthRefreshCredentialResult> => {
			const refreshed = await refreshOAuthTokenForProvider(
				provider,
				credential.refreshToken as string,
				credential.providerSpecificData,
			);
			if (!refreshed.ok) {
				return {
					ok: false,
					error: refreshed.error,
					permanent: refreshed.permanent,
					provider,
					status: refreshed.status,
				};
			}

			const providerSpecificData = {
				...credential.providerSpecificData,
				...refreshed.providerSpecificData,
				hasIdToken: Boolean(refreshed.idToken ?? credential.idToken),
				hasRefreshToken: true,
				lastRefreshAt: new Date().toISOString(),
				oauthProvider: provider.id,
			};
			updateRouterProviderAccount({
				id: credential.id,
				authType:
					credential.authType === "api-key" ? "oauth" : credential.authType,
				expiresAt: refreshed.expiresAt ?? credential.expiresAt,
				idToken:
					refreshed.idToken ??
					(credential.idToken ? credential.idToken : undefined),
				key: refreshed.accessToken,
				providerSpecificData,
				refreshToken: refreshed.refreshToken,
			});

			const updated =
				getProviderAccountCredentials(credential.provider).find(
					(candidate) => candidate.id === credential.id,
				) ?? credential;
			return {
				ok: true,
				credential: updated,
				provider,
				refreshed: true,
			};
		})().finally(() => {
			oauthRefreshLocks.delete(lockKey);
		});

	oauthRefreshLocks.set(lockKey, pending);
	return pending;
}

async function refreshProviderCredentialIfNeeded(
	credential: RouterProviderCredential,
): Promise<RouterProviderCredential> {
	const result = await refreshProviderCredential({
		credential,
		force: false,
	});
	return result.ok ? result.credential : credential;
}

async function refreshProviderCredentialAfterAuthFailure(
	credential: RouterProviderCredential,
): Promise<RouterProviderCredential | null> {
	const result = await refreshProviderCredential({
		credential,
		force: true,
	});
	return result.ok && result.refreshed ? result.credential : null;
}

function shouldRefreshProviderCredential(
	credential: RouterProviderCredential,
	provider: OAuthRefreshConfig,
	nowMs = Date.now(),
): boolean {
	const expiresAtMs = parseTimeMs(credential.expiresAt);
	if (expiresAtMs !== null && expiresAtMs - nowMs < provider.leadMs)
		return true;
	if (provider.maxRefreshAgeMs && credential.refreshToken) {
		const lastRefreshMs = parseTimeMs(
			credential.providerSpecificData.lastRefreshAt,
		);
		return !lastRefreshMs || nowMs - lastRefreshMs >= provider.maxRefreshAgeMs;
	}
	return false;
}

async function refreshOAuthTokenForProvider(
	provider: OAuthRefreshConfig,
	refreshToken: string,
	providerSpecificData: JsonObject = {},
): Promise<OAuthRefreshResult> {
	const client = resolveOAuthClientCredentials(provider, providerSpecificData, {
		requireSecret: Boolean(provider.clientSecretEnv),
	});
	if (!client.ok) {
		return {
			ok: false,
			error: client.error,
			permanent: true,
			status: client.status,
		};
	}
	const body =
		provider.encoding === "form"
			? new URLSearchParams({
					client_id: client.clientId,
					...(client.clientSecret
						? { client_secret: client.clientSecret }
						: {}),
					grant_type: "refresh_token",
					refresh_token: refreshToken,
				})
			: JSON.stringify({
					client_id: client.clientId,
					grant_type: "refresh_token",
					refresh_token: refreshToken,
				});
	const response = await fetchWithTimeout(
		provider.tokenUrl,
		{
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type":
					provider.encoding === "form"
						? "application/x-www-form-urlencoded"
						: "application/json",
			},
			body,
		},
		15_000,
	);
	return oauthTokenResultFromResponse(provider, response, refreshToken);
}

function oauthRefreshLockKey(
	provider: OAuthRefreshConfig,
	credential: RouterProviderCredential,
): string {
	const stableId =
		credential.id ||
		credential.name ||
		credential.refreshToken?.slice(-16) ||
		"default";
	return `${provider.id}:${stableId}`;
}

function oauthRefreshErrorMessage(data: JsonObject, status: number): string {
	return (
		stringValue(data.error_description) ??
		errorTextFromBody(data) ??
		`OAuth refresh failed (${status})`
	);
}

function isPermanentOAuthRefreshError(
	data: JsonObject,
	status: number,
): boolean {
	const error = stringValue(data.error)?.toLowerCase();
	return (
		error === "invalid_grant" ||
		error === "invalid_request" ||
		error === "refresh_token_reused" ||
		status === 400 ||
		status === 401 ||
		status === 403
	);
}

function importOAuthTokenConnection(providerId: string, rawBody: unknown) {
	const provider = resolveOAuthProvider(providerId);
	if (!provider) {
		return {
			ok: false as const,
			status: 404,
			body: { error: "OAuth provider not supported by ADE" },
		};
	}
	const body = toJsonObject(rawBody);
	const token =
		stringValue(body.accessToken) ??
		stringValue(body.access_token) ??
		stringValue(body.token) ??
		stringValue(body.apiKey) ??
		stringValue(body.key);
	const refreshToken =
		stringValue(body.refreshToken) ?? stringValue(body.refresh_token) ?? null;
	const idToken =
		stringValue(body.idToken) ?? stringValue(body.id_token) ?? null;
	if (!token) {
		return {
			ok: false as const,
			status: 400,
			body: { error: "accessToken, token, apiKey, or key is required" },
		};
	}
	const jwtInfo = looksLikeJwt(token) ? decodeJwtPayload(token) : {};
	const providerSpecificData = {
		...jsonObjectValue(body.providerSpecificData),
		...jsonObjectValue(body.provider_specific_data),
		importedFrom: "ade-oauth-compat",
		oauthProvider: provider.id,
		...(refreshToken ? { hasRefreshToken: true } : {}),
		...(idToken ? { hasIdToken: true } : {}),
		...(typeof body.lastRefreshAt === "string"
			? { lastRefreshAt: body.lastRefreshAt }
			: {}),
		...(typeof jwtInfo.account_id === "string"
			? { accountId: jwtInfo.account_id, chatgptAccountId: jwtInfo.account_id }
			: {}),
		...(typeof jwtInfo.plan_type === "string"
			? { planType: jwtInfo.plan_type, chatgptPlanType: jwtInfo.plan_type }
			: {}),
	};
	const name =
		stringValue(body.name) ??
		stringValue(body.email) ??
		stringValue(jwtInfo.email) ??
		`${provider.label} imported token`;
	const account = createRouterProviderAccount({
		authType: parseImportedAuthType(body.authType, token),
		email: stringValue(body.email) ?? stringValue(jwtInfo.email) ?? null,
		expiresAt: parseImportedExpiresAt(body),
		idToken,
		key: token,
		name,
		provider: provider.keyProvider,
		providerSpecificData,
		refreshToken,
	})
		.filter((candidate) => candidate.provider === provider.keyProvider)
		.sort(
			(a, b) =>
				new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
		)[0];
	if (!account) {
		return {
			ok: false as const,
			status: 500,
			body: { error: "Failed to create imported OAuth provider account" },
		};
	}
	if (
		typeof body.priority === "number" ||
		typeof body.isActive === "boolean" ||
		typeof body.is_active === "boolean"
	) {
		updateRouterProviderAccount({
			id: account.id,
			priority: typeof body.priority === "number" ? body.priority : undefined,
			isActive:
				typeof body.isActive === "boolean"
					? body.isActive
					: typeof body.is_active === "boolean"
						? body.is_active
						: undefined,
		});
	}
	return {
		ok: true as const,
		status: 201,
		body: {
			success: true,
			connection: providerConnectionView(account.id),
			provider,
		},
	};
}

function parseImportedAuthType(
	value: unknown,
	token: string,
): RouterProviderAccountAuthType {
	const explicit = parseOptionalProviderAccountAuthType(value);
	if (explicit) return explicit;
	if (value === "access-token" || value === "access_token")
		return "access-token";
	if (value === "oauth") return "oauth";
	return looksLikeJwt(token) ? "access-token" : "oauth";
}

function parseProviderAccountInputAuthType(
	value: unknown,
	token: string,
): RouterProviderAccountAuthType {
	const explicit = parseOptionalProviderAccountAuthType(value);
	return explicit ?? (looksLikeJwt(token) ? "access-token" : "api-key");
}

function parseOptionalProviderAccountAuthType(
	value: unknown,
): RouterProviderAccountAuthType | undefined {
	if (value === "api-key" || value === "apikey" || value === "api_key")
		return "api-key";
	if (value === "access-token" || value === "access_token")
		return "access-token";
	if (value === "oauth") return "oauth";
	return undefined;
}

function optionalStringAliasValue(
	source: unknown,
	keys: string[],
): string | null | undefined {
	for (const key of keys) {
		const value = optionalStringValue(source, key);
		if (value !== undefined) return value;
	}
	return undefined;
}

function optionalStringValue(
	source: unknown,
	key: string,
): string | null | undefined {
	const body = toJsonObject(source);
	if (!Object.hasOwn(body, key)) return undefined;
	const value = body[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseImportedExpiresAt(body: JsonObject): string | null {
	if (typeof body.expiresAt === "string") return body.expiresAt;
	if (typeof body.expires_at === "string") return body.expires_at;
	const expiresIn =
		typeof body.expiresIn === "number"
			? body.expiresIn
			: typeof body.expires_in === "number"
				? body.expires_in
				: null;
	return expiresIn
		? new Date(Date.now() + expiresIn * 1000).toISOString()
		: null;
}

function looksLikeJwt(value: string): boolean {
	const parts = value.split(".");
	return (
		parts.length === 3 &&
		parts[0].length > 0 &&
		parts[1].length > 0 &&
		parts.every((part) => /^[A-Za-z0-9_-]*$/.test(part))
	);
}

function decodeJwtPayload(token: string): JsonObject {
	try {
		const payload = token.split(".")[1];
		const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
		return JSON.parse(
			Buffer.from(
				padded.replace(/-/g, "+").replace(/_/g, "/"),
				"base64",
			).toString("utf8"),
		) as JsonObject;
	} catch {
		return {};
	}
}

function jsonObjectValue(value: unknown): JsonObject {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: {};
}

function listRouterProviderConnections() {
	return listRouterProviderAccountViews().map(providerConnectionFromAccount);
}

function providerConnectionView(id: string) {
	const account = listRouterProviderAccountViews().find(
		(candidate) => candidate.id === id,
	);
	return account ? providerConnectionFromAccount(account) : null;
}

function providerConnectionFromAccount(account: RouterProviderAccountView) {
	return {
		id: account.id,
		provider: account.provider,
		name: account.name,
		displayName: providerDisplayName(account.provider),
		authType: providerConnectionAuthType(account.authType),
		email: account.email ?? null,
		expiresAt: account.expiresAt ?? null,
		priority: account.priority,
		globalPriority: null,
		defaultModel: null,
		providerSpecificData: account.providerSpecificData ?? {},
		isActive: account.isActive,
		testStatus: providerAccountTestStatus(account),
		lastError: account.lastError?.message ?? null,
		lastErrorAt: account.lastError?.timestamp ?? null,
		lastUsedAt: account.lastUsedAt,
		createdAt: account.createdAt,
		updatedAt: account.updatedAt,
		hasKey: account.hasKey,
		hasRefreshToken: account.hasRefreshToken,
		hasIdToken: account.hasIdToken,
		apiKey: undefined,
		accessToken: undefined,
		refreshToken: undefined,
		idToken: undefined,
	};
}

function providerConnectionAuthType(authType: RouterProviderAccountAuthType) {
	if (authType === "access-token") return "access_token";
	if (authType === "oauth") return "oauth";
	return "apikey";
}

function routerApiKeyView(apiKey: RouterGatewayApiKey) {
	return {
		id: apiKey.id,
		key: apiKey.keyPreview,
		keyPreview: apiKey.keyPreview,
		name: apiKey.name,
		machineId: apiKey.machineId,
		isActive: apiKey.isActive,
		createdAt: apiKey.createdAt,
		updatedAt: apiKey.updatedAt,
		lastUsedAt: apiKey.lastUsedAt,
	};
}

function routerSettingsResponse(settings: RouterGatewaySettings) {
	return {
		...settings,
		enableRequestLogs: process.env.ENABLE_REQUEST_LOGS === "true",
		enableTranslator: false,
		hasPassword: false,
		oidcConfigured: false,
	};
}

function routerClientProvidersResponse(req: Request) {
	const provider =
		typeof req.query.provider === "string" ? req.query.provider : "all";
	const accountStatus =
		typeof req.query.accountStatus === "string"
			? req.query.accountStatus
			: "all";
	const sort = typeof req.query.sort === "string" ? req.query.sort : "priority";
	const page = parsePositiveIntQuery(req.query.page, 1);
	const pageSize = Math.min(parsePositiveIntQuery(req.query.pageSize, 20), 500);
	const allConnections = listRouterProviderConnections();
	const providerFilteredConnections = allConnections.filter(
		(connection) => provider === "all" || connection.provider === provider,
	);
	const accountFilteredConnections = providerFilteredConnections.filter(
		(connection) => {
			if (accountStatus === "active") return connection.isActive;
			if (accountStatus === "inactive") return !connection.isActive;
			return true;
		},
	);
	const sortedConnections = [...accountFilteredConnections].sort((a, b) => {
		if (sort === "provider") {
			return (
				String(a.provider).localeCompare(String(b.provider)) ||
				a.priority - b.priority
			);
		}
		return (
			a.priority - b.priority || String(a.provider).localeCompare(b.provider)
		);
	});
	const total = sortedConnections.length;
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	const currentPage = Math.min(page, totalPages);
	const offset = (currentPage - 1) * pageSize;
	const connections = sortedConnections.slice(offset, offset + pageSize);
	return {
		connections,
		providerOptions: Array.from(
			new Set(allConnections.map((connection) => connection.provider)),
		).sort(),
		pagination: {
			page: currentPage,
			pageSize,
			total,
			totalPages,
		},
		totals: {
			eligibleConnections: allConnections.length,
			providerFilteredConnections: providerFilteredConnections.length,
		},
	};
}

function filterSuggestedModels(models: unknown[], type: string) {
	const normalizedType = type.toLowerCase();
	return models.filter((model) => {
		if (!model || typeof model !== "object") return false;
		const entry = model as Record<string, unknown>;
		const id = String(entry.id ?? entry.name ?? "");
		const kind = String(entry.kind ?? entry.type ?? "").toLowerCase();
		const capabilities = Array.isArray(entry.capabilities)
			? entry.capabilities.map((capability) => String(capability).toLowerCase())
			: [];
		if (!normalizedType || normalizedType === "all") return true;
		if (kind === normalizedType || capabilities.includes(normalizedType))
			return true;
		if (normalizedType === "embedding") return /embed/i.test(id);
		if (normalizedType === "image") return /image|vision|dall-e/i.test(id);
		if (normalizedType === "tts") return /tts|speech|audio/i.test(id);
		if (normalizedType === "stt") return /transcri|whisper|stt/i.test(id);
		return normalizedType === "chat";
	});
}

function routerTunnelStatus(settings = getRouterSettings()) {
	const tunnelUrl = stringValue(settings.tunnelUrl) ?? "";
	const tailscaleUrl = stringValue(settings.tailscaleUrl) ?? "";
	const cloudflared = routerServiceRegistry.status("cloudflared");
	const tailscale = routerServiceRegistry.status("tailscale");
	return {
		tunnel: {
			enabled: settings.tunnelEnabled === true,
			provider: stringValue(settings.tunnelProvider) ?? "cloudflare",
			running: cloudflared.state === "running",
			status: cloudflared.state,
			url: tunnelUrl,
			service: cloudflared,
		},
		tailscale: {
			enabled: settings.tailscaleEnabled === true,
			installed: commandAvailable("tailscale"),
			loggedIn: tailscale.state === "running",
			running: tailscale.state === "running",
			status: tailscale.state,
			url: tailscaleUrl,
			service: tailscale,
		},
		download: {
			status: "idle",
		},
	};
}

function routerTailscaleCheck() {
	const installed = commandAvailable("tailscale");
	const service = routerServiceRegistry.status("tailscale");
	return {
		installed,
		loggedIn: service.state === "running",
		platform: process.platform,
		brewAvailable: process.platform === "darwin" && commandAvailable("brew"),
		daemonRunning: service.state === "running",
		customDaemonRunning: service.state === "running",
		systemDaemonRunning: installed,
		hasCachedPassword: false,
		service,
	};
}

async function routerHeadroomStatus() {
	const settings = getRouterSettings();
	const url = stringValue(settings.headroomUrl) ?? "http://localhost:8787";
	const service = routerServiceRegistry.status("headroom");
	try {
		const response = await fetchWithTimeout(url, { method: "GET" }, 1500);
		return {
			ok: response.ok,
			reachable: response.ok,
			status: response.status,
			statusText: response.statusText,
			url,
			enabled: settings.headroomEnabled === true,
			managedPid: service.pid,
			service,
		};
	} catch (error) {
		return {
			ok: false,
			reachable: false,
			error: errorMessage(error),
			url,
			enabled: settings.headroomEnabled === true,
			managedPid: service.pid,
			service,
		};
	}
}

function headroomPort(url: string): number {
	try {
		const port = Number(new URL(url).port || 8787);
		return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 8787;
	} catch {
		return 8787;
	}
}

function commandAvailable(command: string): boolean {
	try {
		execFileSync(
			process.platform === "win32" ? "where.exe" : "which",
			[command],
			{
				stdio: "ignore",
				timeout: 2000,
			},
		);
		return true;
	} catch {
		return false;
	}
}

function parsePositiveIntQuery(value: unknown, fallback: number): number {
	const raw = Array.isArray(value) ? value[0] : value;
	const parsed = Number.parseInt(String(raw ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function providerDisplayName(provider: RouterProviderKeyId): string {
	return (
		ROUTER_PROVIDER_CATALOG.find(
			(item) => item.keyProvider === provider || item.id === provider,
		)?.label ?? provider
	);
}

function providerAccountTestStatus(account: RouterProviderAccount): string {
	if (!account.isActive) return "disabled";
	if (account.lastError) return "failed";
	if (account.lastUsedAt || account.requestCount > 0) return "success";
	return "unknown";
}

function parseProviderKeyId(value: unknown): RouterProviderKeyId | null {
	return typeof value === "string" &&
		ROUTER_PROVIDER_KEY_IDS.includes(value as RouterProviderKeyId)
		? (value as RouterProviderKeyId)
		: null;
}

function parsePricingBody(value: unknown): RouterPricingTable {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid pricing data format");
	}
	const table: RouterPricingTable = {};
	for (const [provider, rawModels] of Object.entries(value)) {
		if (
			!rawModels ||
			typeof rawModels !== "object" ||
			Array.isArray(rawModels)
		) {
			throw new Error(`Invalid pricing for provider: ${provider}`);
		}
		const models: RouterPricingTable[string] = {};
		for (const [model, rawPricing] of Object.entries(rawModels)) {
			if (
				!rawPricing ||
				typeof rawPricing !== "object" ||
				Array.isArray(rawPricing)
			) {
				throw new Error(`Invalid pricing for model: ${provider}/${model}`);
			}
			const pricing: RouterPricingTable[string][string] = {};
			for (const key of [
				"input",
				"output",
				"cached",
				"reasoning",
				"cache_creation",
			] as const) {
				const candidate = (rawPricing as Record<string, unknown>)[key];
				if (candidate === undefined) continue;
				const numeric = Number(candidate);
				if (!Number.isFinite(numeric) || numeric < 0) {
					throw new Error(
						`Invalid pricing value for ${key} in ${provider}/${model}`,
					);
				}
				pricing[key] = numeric;
			}
			models[model] = pricing;
		}
		table[provider] = models;
	}
	return table;
}

async function validateRouterProviderKey(
	provider: RouterProviderKeyId,
	apiKey: string,
) {
	const startedAt = Date.now();
	try {
		const response = await fetchProviderValidationProbe(provider, apiKey);
		const valid = isProviderValidationSuccess(provider, response);
		return {
			valid,
			error: valid ? null : providerValidationError(provider, response.status),
			statusCode: response.status,
			latencyMs: Date.now() - startedAt,
			testedAt: new Date().toISOString(),
		};
	} catch (error) {
		return {
			valid: false,
			error: errorMessage(error),
			statusCode: null,
			latencyMs: Date.now() - startedAt,
			testedAt: new Date().toISOString(),
		};
	}
}

async function fetchProviderValidationProbe(
	provider: RouterProviderKeyId,
	apiKey: string,
): Promise<globalThis.Response> {
	if (provider === "openrouter") {
		return fetchWithTimeout(
			"https://openrouter.ai/api/v1/models",
			{ headers: { Authorization: `Bearer ${apiKey}` } },
			8_000,
		);
	}
	if (provider === "openai") {
		return fetchWithTimeout(
			`${OPENAI_BASE_URL}/models`,
			{ headers: { Authorization: `Bearer ${apiKey}` } },
			8_000,
		);
	}
	if (provider === "anthropic") {
		return fetchWithTimeout(
			"https://api.anthropic.com/v1/messages",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"anthropic-version": "2023-06-01",
					"x-api-key": apiKey,
				},
				body: JSON.stringify({
					model: "claude-3-haiku-20240307",
					max_tokens: 1,
					messages: [{ role: "user", content: "ping" }],
				}),
			},
			10_000,
		);
	}
	if (provider === "gemini") {
		return fetchWithTimeout(
			`https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(apiKey)}`,
			{},
			8_000,
		);
	}
	if (provider === "xai") {
		return fetchWithTimeout(
			"https://api.x.ai/v1/models",
			{ headers: { Authorization: `Bearer ${apiKey}` } },
			8_000,
		);
	}
	if (provider === "reve") {
		return fetchWithTimeout(
			"https://api.reve.com/v1/",
			{ headers: { Authorization: `Bearer ${apiKey}` } },
			8_000,
		);
	}
	if (provider === "perplexity") {
		return fetchWithTimeout(
			PERPLEXITY_CHAT_COMPLETIONS_URL,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model: "sonar",
					messages: [{ role: "user", content: "ping" }],
					max_tokens: 1,
				}),
			},
			10_000,
		);
	}
	if (provider === "brave-search") {
		return fetchWithTimeout(
			`${BRAVE_SEARCH_URL}?q=ping&count=1`,
			{ headers: { "X-Subscription-Token": apiKey } },
			8_000,
		);
	}
	if (provider === "elevenlabs") {
		return fetchWithTimeout(
			"https://api.elevenlabs.io/v1/voices",
			{ headers: { "xi-api-key": apiKey } },
			8_000,
		);
	}
	if (provider === "stability-ai") {
		return fetchWithTimeout(
			"https://api.stability.ai/v1/user/account",
			{ headers: { Authorization: `Bearer ${apiKey}` } },
			8_000,
		);
	}
	throw new Error(`Provider validation not supported: ${provider}`);
}

function isProviderValidationSuccess(
	provider: RouterProviderKeyId,
	response: globalThis.Response,
): boolean {
	if (
		provider === "anthropic" ||
		provider === "perplexity" ||
		provider === "reve"
	) {
		return response.status !== 401 && response.status !== 403;
	}
	return response.ok;
}

function providerValidationError(
	provider: RouterProviderKeyId,
	status: number,
): string {
	if (status === 401 || status === 403) return "Invalid API key";
	if (status === 404 && provider === "anthropic") return "Invalid model probe";
	return `Validation request failed (${status})`;
}

async function testRouterProviderAccounts({
	mode,
	providerId,
}: {
	mode: string;
	providerId: string | null;
}): Promise<{ ok: boolean; body: JsonObject }> {
	if (!mode) return { ok: false, body: { error: "mode is required" } };
	const allowedModes = new Set([
		"provider",
		"oauth",
		"free",
		"apikey",
		"compatible",
		"all",
	]);
	if (!allowedModes.has(mode)) {
		return {
			ok: false,
			body: {
				error:
					"Invalid mode. Use: provider, oauth, free, apikey, compatible, all",
			},
		};
	}

	const accounts = listRouterProviderAccountViews().filter((account) => {
		if (!account.isActive) return false;
		if (mode === "provider") return account.provider === providerId;
		if (mode === "oauth") return account.authType !== "api-key";
		if (mode === "apikey") return account.authType === "api-key";
		if (mode === "compatible" || mode === "free" || mode === "all") return true;
		return false;
	});

	const results = [];
	for (const account of accounts) {
		const credential = getProviderAccountCredentials(account.provider).find(
			(candidate) => candidate.id === account.id,
		);
		if (!credential) {
			results.push({
				provider: account.provider,
				connectionId: account.id,
				connectionName: account.name,
				authType: providerConnectionAuthType(account.authType),
				valid: false,
				latencyMs: 0,
				error: "No API key stored for this account.",
				statusCode: null,
				testedAt: new Date().toISOString(),
			});
			continue;
		}
		const credentialForTest =
			await refreshProviderCredentialIfNeeded(credential);
		const test = await validateRouterProviderKey(
			credentialForTest.provider,
			credentialForTest.key,
		);
		if (test.valid) {
			markProviderAccountSuccess(credentialForTest);
		} else {
			markProviderAccountFailure({
				credential: credentialForTest,
				status: test.statusCode ?? undefined,
				text: test.error ?? undefined,
			});
		}
		results.push({
			provider: account.provider,
			connectionId: account.id,
			connectionName: account.name,
			authType: providerConnectionAuthType(account.authType),
			valid: test.valid,
			latencyMs: test.latencyMs,
			error: test.error,
			statusCode: test.statusCode,
			testedAt: test.testedAt,
		});
	}

	return {
		ok: true,
		body: {
			mode,
			providerId: providerId ?? null,
			results,
			testedAt: new Date().toISOString(),
			summary: {
				total: results.length,
				passed: results.filter((result) => result.valid).length,
				failed: results.filter((result) => !result.valid).length,
			},
		},
	};
}

function stringQuery(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && typeof value[0] === "string") return value[0];
	return null;
}

function booleanQuery(value: unknown): boolean | undefined {
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseProxyPoolBody(value: unknown): Partial<RouterProxyPool> {
	const body = toJsonObject(value);
	return {
		name: typeof body.name === "string" ? body.name : "",
		proxyUrl: typeof body.proxyUrl === "string" ? body.proxyUrl : "",
		noProxy: typeof body.noProxy === "string" ? body.noProxy : "",
		isActive: typeof body.isActive === "boolean" ? body.isActive : true,
		strictProxy:
			typeof body.strictProxy === "boolean" ? body.strictProxy : false,
		type: parseProxyPoolType(body.type),
	};
}

function parseProxyPoolUpdateBody(value: unknown): Partial<RouterProxyPool> {
	const body = toJsonObject(value);
	const updates: Partial<RouterProxyPool> = {};
	if (Object.hasOwn(body, "name")) {
		updates.name = typeof body.name === "string" ? body.name : "";
	}
	if (Object.hasOwn(body, "proxyUrl")) {
		updates.proxyUrl = typeof body.proxyUrl === "string" ? body.proxyUrl : "";
	}
	if (Object.hasOwn(body, "noProxy")) {
		updates.noProxy = typeof body.noProxy === "string" ? body.noProxy : "";
	}
	if (Object.hasOwn(body, "isActive")) {
		updates.isActive = body.isActive === true;
	}
	if (Object.hasOwn(body, "strictProxy")) {
		updates.strictProxy = body.strictProxy === true;
	}
	if (Object.hasOwn(body, "type")) {
		updates.type = parseProxyPoolType(body.type);
	}
	return updates;
}

function parseProxyPoolType(value: unknown): RouterProxyPoolType {
	if (
		value === "vercel" ||
		value === "cloudflare" ||
		value === "deno" ||
		value === "http"
	) {
		return value;
	}
	return "http";
}

function createRelayProxyPoolFromBody(
	value: unknown,
	type: Exclude<RouterProxyPoolType, "http">,
): RouterProxyPool {
	const body = toJsonObject(value);
	const proxyUrl =
		typeof body.deployUrl === "string" && body.deployUrl.trim()
			? body.deployUrl
			: typeof body.proxyUrl === "string"
				? body.proxyUrl
				: "";
	if (!proxyUrl.trim()) {
		throw new Error(
			`Automatic ${type} deployment is not bundled yet. Provide deployUrl/proxyUrl for an existing relay.`,
		);
	}
	return createRouterProxyPool({
		name:
			typeof body.projectName === "string" && body.projectName.trim()
				? body.projectName
				: typeof body.name === "string"
					? body.name
					: `${type}-relay`,
		proxyUrl,
		type,
		noProxy: "",
		isActive: true,
		strictProxy: false,
	});
}

export async function testRouterProxyPool(
	proxyPool: RouterProxyPool,
	options: { testUrl?: string; timeoutMs?: number } = {},
): Promise<RouterProxyPoolTestResult> {
	const testedAt = new Date().toISOString();
	const startedAt = Date.now();
	const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
	try {
		const result =
			proxyPool.type === "http"
				? await testHttpProxyUrl({
						proxyUrl: proxyPool.proxyUrl,
						testUrl: options.testUrl,
						timeoutMs,
					})
				: await testRelayProxyUrl({
						relayUrl: proxyPool.proxyUrl,
						timeoutMs,
					});
		return {
			ok: result.ok,
			status: result.status,
			statusText: result.statusText ?? null,
			error: result.error ?? null,
			elapsedMs: result.elapsedMs ?? Date.now() - startedAt,
			testedAt,
		};
	} catch (error) {
		return {
			ok: false,
			status: 500,
			statusText: null,
			error: errorMessage(error),
			elapsedMs: Date.now() - startedAt,
			testedAt,
		};
	}
}

async function testRelayProxyUrl({
	relayUrl,
	timeoutMs,
}: {
	relayUrl: string;
	timeoutMs: number;
}) {
	const startedAt = Date.now();
	const response = await fetchWithTimeout(
		relayUrl,
		{
			method: "GET",
			headers: {
				"x-relay-target": "https://httpbin.org",
				"x-relay-path": "/get",
			},
		},
		timeoutMs,
	);
	return {
		ok: response.ok,
		status: response.status,
		statusText: response.statusText,
		elapsedMs: Date.now() - startedAt,
		error: response.ok
			? null
			: `Relay test failed with status ${response.status}`,
	};
}

function testHttpProxyUrl({
	proxyUrl,
	testUrl,
	timeoutMs,
}: {
	proxyUrl: string;
	testUrl?: string;
	timeoutMs: number;
}): Promise<{
	ok: boolean;
	status: number;
	statusText?: string;
	elapsedMs: number;
	error?: string | null;
}> {
	const startedAt = Date.now();
	let proxy: URL;
	try {
		proxy = new URL(proxyUrl);
	} catch (error) {
		return Promise.resolve({
			ok: false,
			status: 400,
			error: `Invalid proxy URL: ${errorMessage(error)}`,
			elapsedMs: Date.now() - startedAt,
		});
	}
	if (proxy.protocol !== "http:") {
		return Promise.resolve({
			ok: false,
			status: 400,
			error: "Only http:// proxy URLs are supported by the embedded tester.",
			elapsedMs: Date.now() - startedAt,
		});
	}

	const target = new URL(testUrl?.trim() || "http://example.com/");
	const port = Number(proxy.port || 80);

	return new Promise((resolve) => {
		let settled = false;
		let buffer = "";
		const settle = (
			result: Omit<Awaited<ReturnType<typeof testHttpProxyUrl>>, "elapsedMs">,
		) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve({ ...result, elapsedMs: Date.now() - startedAt });
		};
		const socket = netConnect({ host: proxy.hostname, port });
		const timeout = setTimeout(() => {
			settle({ ok: false, status: 500, error: "Proxy test timed out" });
		}, timeoutMs);
		socket.on("connect", () => {
			const headers = [
				`HEAD ${target.href} HTTP/1.1`,
				`Host: ${target.host}`,
				"Connection: close",
				"User-Agent: ADE-router",
			];
			if (proxy.username || proxy.password) {
				headers.push(
					`Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`,
				);
			}
			socket.write(`${headers.join("\r\n")}\r\n\r\n`);
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const line = buffer.split(/\r?\n/, 1)[0];
			const match = /^HTTP\/\d(?:\.\d)?\s+(\d+)\s*(.*)$/i.exec(line);
			if (!match) return;
			clearTimeout(timeout);
			const status = Number(match[1]);
			settle({
				ok: status >= 200 && status < 400,
				status,
				statusText: match[2] || undefined,
				error:
					status >= 200 && status < 400
						? null
						: `Proxy test failed with status ${status}`,
			});
		});
		socket.on("error", (error) => {
			clearTimeout(timeout);
			settle({ ok: false, status: 500, error: errorMessage(error) });
		});
		socket.on("close", () => clearTimeout(timeout));
	});
}

function normalizeTimeoutMs(value: unknown): number {
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return 8_000;
	return Math.min(Math.round(numeric), 30_000);
}

function buildCliToolStatuses(): Record<CliToolId, JsonObject> {
	return Object.fromEntries(
		CLI_TOOL_IDS.map((tool) => [tool, buildCliToolStatus(tool)]),
	) as Record<CliToolId, JsonObject>;
}

function buildCliToolStatus(tool: CliToolId): JsonObject {
	if (tool === "codex") return buildCodexToolStatus();
	if (tool === "claude") return buildClaudeToolStatus();
	if (tool === "cline") return buildClineToolStatus();
	return {
		installed: commandExists(tool),
		config: null,
		settings: null,
		has9Router: false,
		message: `${tool} status is catalogued; automatic ADE config is not implemented yet.`,
	};
}

function buildCodexToolStatus(): JsonObject {
	const configPath = codexConfigPath();
	const config = readTextOrNull(configPath);
	return {
		installed: commandExists("codex") || Boolean(config),
		config: redactSensitiveText(config),
		has9Router:
			Boolean(config?.includes('model_provider = "9router"')) ||
			Boolean(config?.includes("[model_providers.9router]")),
		configPath,
		authPath: codexAuthPath(),
	};
}

function buildClaudeToolStatus(): JsonObject {
	const settingsPath = claudeSettingsPath();
	const settings = readJsonOrNull(settingsPath);
	const baseUrl =
		stringValue(toJsonObject(settings?.env).ANTHROPIC_BASE_URL) ?? "";
	return {
		installed: commandExists("claude") || Boolean(settings),
		settings: redactSensitiveJson(settings),
		has9Router:
			baseUrl.includes("localhost") ||
			baseUrl.includes("127.0.0.1") ||
			baseUrl.includes("9router") ||
			baseUrl.includes(getAgentRouterGatewayStatus().url),
		settingsPath,
	};
}

function redactSensitiveText(value: string | null): string | null {
	if (!value) return value;
	return value
		.split(/\r?\n/)
		.map((line) =>
			/(?:api[_-]?key|token|secret|password|authorization|cookie)\s*=/i.test(
				line,
			)
				? `${line.split("=", 1)[0]?.trim()} = "[REDACTED]"`
				: line,
		)
		.join("\n");
}

function redactSensitiveJson(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (Array.isArray(value))
		return value.map((entry) => redactSensitiveJson(entry));
	if (typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			/(?:api.?key|token|secret|password|authorization|cookie)/i.test(key)
				? "[REDACTED]"
				: redactSensitiveJson(entry),
		]),
	) as JsonObject;
}

function buildClineToolStatus(): JsonObject {
	const globalStatePath = clineGlobalStatePath();
	const settings = readJsonOrNull(globalStatePath);
	const baseUrl = stringValue(toJsonObject(settings).openAiBaseUrl) ?? "";
	return {
		installed: commandExists("cline") || Boolean(settings),
		settings: {
			actModeApiProvider: toJsonObject(settings).actModeApiProvider,
			planModeApiProvider: toJsonObject(settings).planModeApiProvider,
			openAiBaseUrl: baseUrl || undefined,
			openAiModelId: toJsonObject(settings).openAiModelId,
		},
		has9Router:
			baseUrl.includes("localhost") ||
			baseUrl.includes("127.0.0.1") ||
			baseUrl.includes("9router"),
		globalStatePath,
		secretsPath: clineSecretsPath(),
	};
}

function applyCliToolSettings(tool: ConfigurableCliToolId, input: unknown) {
	if (tool === "codex") return applyCodexSettings(input);
	if (tool === "claude") return applyClaudeSettings(input);
	return applyClineSettings(input);
}

function resetCliToolSettings(tool: ConfigurableCliToolId) {
	if (tool === "codex") return resetCodexSettings();
	if (tool === "claude") return resetClaudeSettings();
	return resetClineSettings();
}

function parseCliSettingsRoute(value: string): ConfigurableCliToolId | null {
	if (value === "codex-settings") return "codex";
	if (value === "claude-settings") return "claude";
	if (value === "cline-settings") return "cline";
	return null;
}

function applyCodexSettings(input: unknown): JsonObject {
	const body = toJsonObject(input);
	const baseUrl = normalizeCliBaseUrl(body.baseUrl, true);
	const apiKey = requiredString(body.apiKey, "apiKey");
	const model = requiredString(body.model, "model");
	const subagentModel =
		typeof body.subagentModel === "string" && body.subagentModel.trim()
			? body.subagentModel.trim()
			: model;
	const configPath = codexConfigPath();
	mkdirSync(dirname(configPath), { recursive: true });
	const current = readTextOrNull(configPath) ?? "";
	writeFileSync(
		configPath,
		replaceManagedBlock(
			current,
			codexManagedBlock(baseUrl, model, subagentModel),
		),
		"utf8",
	);
	const auth = toJsonObject(readJsonOrNull(codexAuthPath()));
	writeJsonFile(codexAuthPath(), {
		...auth,
		OPENAI_API_KEY: apiKey,
		auth_mode: "apikey",
	});
	return {
		success: true,
		message: "Codex settings applied successfully.",
		configPath,
	};
}

function resetCodexSettings(): JsonObject {
	const configPath = codexConfigPath();
	const current = readTextOrNull(configPath);
	if (current !== null) {
		writeFileSync(configPath, removeManagedBlock(current), "utf8");
	}
	const authPath = codexAuthPath();
	const auth = toJsonObject(readJsonOrNull(authPath));
	delete auth.OPENAI_API_KEY;
	delete auth.auth_mode;
	if (Object.keys(auth).length === 0) {
		if (existsSync(authPath)) unlinkSync(authPath);
	} else {
		writeJsonFile(authPath, auth);
	}
	return { success: true, message: "Codex ADE settings removed." };
}

function applyClaudeSettings(input: unknown): JsonObject {
	const body = toJsonObject(input);
	const envInput = toJsonObject(body.env);
	const env =
		Object.keys(envInput).length > 0
			? envInput
			: {
					ANTHROPIC_BASE_URL: normalizeCliBaseUrl(body.baseUrl, true),
					ANTHROPIC_AUTH_TOKEN: requiredString(body.apiKey, "apiKey"),
					ANTHROPIC_DEFAULT_OPUS_MODEL: requiredString(body.model, "model"),
					ANTHROPIC_DEFAULT_SONNET_MODEL: requiredString(body.model, "model"),
					ANTHROPIC_DEFAULT_HAIKU_MODEL: requiredString(body.model, "model"),
					API_TIMEOUT_MS: "600000",
				};
	if (typeof env.ANTHROPIC_BASE_URL === "string") {
		env.ANTHROPIC_BASE_URL = normalizeCliBaseUrl(env.ANTHROPIC_BASE_URL, true);
	}
	const settingsPath = claudeSettingsPath();
	const current = toJsonObject(readJsonOrNull(settingsPath));
	writeJsonFile(settingsPath, {
		...current,
		hasCompletedOnboarding: true,
		env: {
			...toJsonObject(current.env),
			...env,
		},
	});
	return {
		success: true,
		message: "Claude settings applied successfully.",
		settingsPath,
	};
}

function resetClaudeSettings(): JsonObject {
	const settingsPath = claudeSettingsPath();
	if (!existsSync(settingsPath)) {
		return { success: true, message: "No Claude settings file to reset." };
	}
	const current = toJsonObject(readJsonOrNull(settingsPath));
	const env = toJsonObject(current.env);
	for (const key of [
		"ANTHROPIC_BASE_URL",
		"ANTHROPIC_AUTH_TOKEN",
		"ANTHROPIC_DEFAULT_OPUS_MODEL",
		"ANTHROPIC_DEFAULT_SONNET_MODEL",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL",
		"API_TIMEOUT_MS",
	]) {
		delete env[key];
	}
	const next = { ...current };
	if (Object.keys(env).length > 0) next.env = env;
	else delete next.env;
	writeJsonFile(settingsPath, next);
	return { success: true, message: "Claude ADE settings removed." };
}

function applyClineSettings(input: unknown): JsonObject {
	const body = toJsonObject(input);
	const baseUrl = normalizeCliBaseUrl(body.baseUrl, false);
	const apiKey = requiredString(body.apiKey, "apiKey");
	const model = requiredString(body.model, "model");
	const globalStatePath = clineGlobalStatePath();
	const current = toJsonObject(readJsonOrNull(globalStatePath));
	writeJsonFile(globalStatePath, {
		...current,
		actModeApiProvider: "openai",
		planModeApiProvider: "openai",
		openAiBaseUrl: baseUrl,
		openAiModelId: model,
		planModeOpenAiModelId: model,
	});
	writeJsonFile(clineSecretsPath(), {
		...toJsonObject(readJsonOrNull(clineSecretsPath())),
		openAiApiKey: apiKey,
	});
	return {
		success: true,
		message: "Cline settings applied successfully.",
		globalStatePath,
	};
}

function resetClineSettings(): JsonObject {
	const globalStatePath = clineGlobalStatePath();
	if (!existsSync(globalStatePath) && !existsSync(clineSecretsPath())) {
		return { success: true, message: "No Cline settings file to reset." };
	}
	const globalState = toJsonObject(readJsonOrNull(globalStatePath));
	if (globalState.actModeApiProvider === "openai") {
		globalState.actModeApiProvider = "cline";
		globalState.planModeApiProvider = "cline";
		delete globalState.openAiBaseUrl;
		delete globalState.openAiModelId;
		delete globalState.planModeOpenAiModelId;
		writeJsonFile(globalStatePath, globalState);
	}
	const secretsPath = clineSecretsPath();
	const secrets = toJsonObject(readJsonOrNull(secretsPath));
	delete secrets.openAiApiKey;
	writeJsonFile(secretsPath, secrets);
	return { success: true, message: "Cline ADE settings removed." };
}

function buildMitmStatus(): JsonObject {
	return {
		running: false,
		pid: null,
		certExists: false,
		certTrusted: false,
		dnsStatus: {},
		hasCachedPassword: false,
		isWin: process.platform === "win32",
		needsSudoPassword: false,
		isAdmin: false,
		mitmRouterBaseUrl: getAgentRouterGatewayStatus().url,
		aliases: getRouterMitmAliases(),
		runtime: "catalogued",
	};
}

function commandExists(command: string): boolean {
	try {
		const executable = process.platform === "win32" ? "where.exe" : "which";
		execFileSync(executable, [command], {
			stdio: "ignore",
			windowsHide: true,
			env:
				process.platform === "win32"
					? {
							...process.env,
							PATH: `${process.env.APPDATA}\\npm;${process.env.PATH ?? ""}`,
						}
					: process.env,
		});
		return true;
	} catch {
		return false;
	}
}

function normalizeCliBaseUrl(value: unknown, withV1: boolean): string {
	const fallback = getAgentRouterGatewayStatus().url;
	const raw = (typeof value === "string" && value.trim() ? value : fallback)
		.trim()
		.replace(/\/+$/g, "");
	if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
		throw new Error("baseUrl must be an http(s) URL");
	}
	if (withV1) return raw.endsWith("/v1") ? raw : `${raw}/v1`;
	return raw.endsWith("/v1") ? raw.slice(0, -3) : raw;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value === "string" && value.trim()) return value.trim();
	throw new Error(`${name} is required`);
}

function codexManagedBlock(
	baseUrl: string,
	model: string,
	subagentModel: string,
): string {
	return [
		CODEX_MANAGED_START,
		`model = ${tomlString(model)}`,
		'model_provider = "9router"',
		"",
		"[model_providers.9router]",
		'name = "9Router"',
		`base_url = ${tomlString(baseUrl)}`,
		'wire_api = "responses"',
		"",
		"[agents.subagent]",
		`model = ${tomlString(subagentModel)}`,
		CODEX_MANAGED_END,
	].join("\n");
}

function replaceManagedBlock(content: string, block: string): string {
	const without = removeManagedBlock(content).trimEnd();
	return `${without ? `${without}\n\n` : ""}${block}\n`;
}

function removeManagedBlock(content: string): string {
	const pattern = new RegExp(
		`${escapeRegExp(CODEX_MANAGED_START)}[\\s\\S]*?${escapeRegExp(CODEX_MANAGED_END)}\\n?`,
		"g",
	);
	return content.replace(pattern, "").trimEnd() + (content.trim() ? "\n" : "");
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

function readTextOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function readJsonOrNull(path: string): JsonObject | null {
	try {
		return JSON.parse(readFileSync(path, "utf8").replace(/,(\s*[}\]])/g, "$1"));
	} catch {
		return null;
	}
}

function writeJsonFile(path: string, value: JsonObject): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function codexConfigPath(): string {
	return join(homedir(), ".codex", "config.toml");
}

function codexAuthPath(): string {
	return join(homedir(), ".codex", "auth.json");
}

function claudeSettingsPath(): string {
	return join(homedir(), ".claude", "settings.json");
}

function clineDataDir(): string {
	return join(homedir(), ".cline", "data");
}

function clineGlobalStatePath(): string {
	return join(clineDataDir(), "globalState.json");
}

function clineSecretsPath(): string {
	return join(clineDataDir(), "secrets.json");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseCustomModelBody(value: unknown) {
	const body = toJsonObject(value);
	return {
		id: typeof body.id === "string" ? body.id : "",
		name: typeof body.name === "string" ? body.name : undefined,
		providerAlias:
			typeof body.providerAlias === "string" ? body.providerAlias : "",
		type: parseModelKind(body.type),
	};
}

function parseModelKind(value: unknown): RouterModelKind {
	if (
		value === "embedding" ||
		value === "image" ||
		value === "tts" ||
		value === "stt" ||
		value === "imageToText" ||
		value === "webSearch" ||
		value === "webFetch" ||
		value === "video" ||
		value === "search" ||
		value === "other"
	) {
		return value;
	}
	return "llm";
}

function parseUsagePeriod(
	value: unknown,
	allowAll: boolean,
): RouterUsagePeriod | null {
	const period = typeof value === "string" ? value : "7d";
	if (
		period === "today" ||
		period === "24h" ||
		period === "7d" ||
		period === "30d" ||
		period === "60d" ||
		(allowAll && period === "all")
	) {
		return period;
	}
	return null;
}

function parsePositiveIntegerQuery(value: unknown, fallback: number): number {
	const raw = Array.isArray(value) ? value[0] : value;
	if (raw === undefined || raw === null || raw === "") return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function streamRouterUsageStats(req: Request, res: ExpressResponse): void {
	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");
	res.flushHeaders?.();

	const writeStats = () => {
		res.write(`data: ${JSON.stringify(getRouterUsageCompatStats("all"))}\n\n`);
	};
	const writePing = () => {
		res.write(": ping\n\n");
	};

	writeStats();
	const statsTimer = setInterval(writeStats, 5000);
	const pingTimer = setInterval(writePing, 25_000);
	req.on("close", () => {
		clearInterval(statsTimer);
		clearInterval(pingTimer);
		res.end();
	});
}

function getRouterConnectionUsage(connectionId: string): {
	body: JsonObject;
	status: number;
} {
	const connection = listRouterProviderAccountViews().find(
		(account) => account.id === connectionId,
	);
	if (!connection) {
		return { status: 404, body: { error: "Connection not found" } };
	}
	const localUsage = getRouterUsageForConnection(connectionId);
	return {
		status: 200,
		body: {
			connectionId,
			provider: connection.provider,
			name: connection.name,
			authType: providerConnectionAuthType(connection.authType),
			plan: null,
			quotas: [],
			available: false,
			message:
				"Live upstream quota usage is not available in ADE for this provider yet; returning local router usage.",
			localUsage,
		},
	};
}

function getRouterCodexResetCredits(
	connectionId: string,
	consume: boolean,
): { body: JsonObject; status: number } {
	const connection = listRouterProviderAccountViews().find(
		(account) => account.id === connectionId,
	);
	if (!connection) {
		return { status: 404, body: { error: "Connection not found" } };
	}
	const oauthProvider = stringValue(
		connection.providerSpecificData?.oauthProvider,
	);
	if (connection.provider !== "openai" || oauthProvider !== "codex") {
		return {
			status: 400,
			body: {
				error: "Codex reset credits are only available for Codex connections.",
			},
		};
	}
	if (
		connection.authType !== "oauth" &&
		connection.authType !== "access-token"
	) {
		return {
			status: 400,
			body: {
				error:
					"Codex reset credits require an OAuth or access-token connection.",
			},
		};
	}
	if (!consume) {
		return {
			status: 200,
			body: {
				code: "unsupported",
				available: false,
				credits: [],
				windows_reset: false,
				message:
					"ADE does not bundle the 9router Codex reset-credit executor yet.",
			},
		};
	}
	return {
		status: 501,
		body: {
			code: "unsupported",
			reset: false,
			windows_reset: false,
			redeemRequestId: `ade-${randomBytes(8).toString("hex")}`,
			message:
				"ADE cannot consume Codex reset credits until the 9router Codex executor is vendored.",
		},
	};
}

function initTranslatorConsoleCapture(): void {
	if (translatorConsolePatched) return;
	for (const level of ["log", "info", "warn", "error", "debug"] as const) {
		translatorConsoleOriginals[level] = console[level].bind(console) as (
			...args: unknown[]
		) => void;
		console[level] = (...args: unknown[]) => {
			appendTranslatorConsoleLine(formatTranslatorConsoleLine(args));
			translatorConsoleOriginals[level]?.(...args);
		};
	}
	translatorConsolePatched = true;
}

function appendTranslatorConsoleLine(line: string): void {
	translatorConsoleLogs.push(line);
	if (translatorConsoleLogs.length > MAX_TRANSLATOR_CONSOLE_LOGS) {
		translatorConsoleLogs.splice(
			0,
			translatorConsoleLogs.length - MAX_TRANSLATOR_CONSOLE_LOGS,
		);
	}
	translatorConsoleEmitter.emit("line", line);
}

function formatTranslatorConsoleLine(args: unknown[]): string {
	return args.map(formatTranslatorConsoleArg).join(" ");
}

function formatTranslatorConsoleArg(value: unknown): string {
	if (typeof value === "string") return stripAnsi(value);
	if (value instanceof Error) {
		return stripAnsi(value.stack || value.message || String(value));
	}
	try {
		return stripAnsi(JSON.stringify(value));
	} catch {
		return stripAnsi(String(value));
	}
}

function stripAnsi(value: string): string {
	return value.replace(
		new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"),
		"",
	);
}

function streamTranslatorConsoleLogs(req: Request, res: ExpressResponse): void {
	initTranslatorConsoleCapture();
	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");
	res.flushHeaders?.();

	if (translatorConsoleLogs.length > 0) {
		res.write(
			`data: ${JSON.stringify({ type: "init", logs: translatorConsoleLogs })}\n\n`,
		);
	}
	const sendLine = (line: string) => {
		res.write(`data: ${JSON.stringify({ type: "line", line })}\n\n`);
	};
	const sendClear = () => {
		res.write(`data: ${JSON.stringify({ type: "clear" })}\n\n`);
	};
	translatorConsoleEmitter.on("line", sendLine);
	translatorConsoleEmitter.on("clear", sendClear);
	const pingTimer = setInterval(() => {
		res.write(": ping\n\n");
	}, 25_000);
	req.on("close", () => {
		clearInterval(pingTimer);
		translatorConsoleEmitter.off("line", sendLine);
		translatorConsoleEmitter.off("clear", sendClear);
		res.end();
	});
}

function loadTranslatorLogFile(file: string | null | undefined): {
	body: JsonObject;
	status: number;
} {
	const valid = validateTranslatorLogFile(file);
	if (!valid.ok) return valid;
	const path = translatorLogFilePath(valid.file);
	if (!existsSync(path)) {
		return { status: 404, body: { success: false, error: "File not found" } };
	}
	return {
		status: 200,
		body: { success: true, content: readFileSync(path, "utf8") },
	};
}

function saveTranslatorLogFile(
	file: string | null | undefined,
	content: unknown,
): { body: JsonObject; status: number } {
	const valid = validateTranslatorLogFile(file);
	if (!valid.ok) return valid;
	if (content === undefined) {
		return {
			status: 400,
			body: { success: false, error: "File and content required" },
		};
	}
	const dir = translatorLogDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(
		translatorLogFilePath(valid.file),
		typeof content === "string" ? content : JSON.stringify(content, null, 2),
		"utf8",
	);
	return { status: 200, body: { success: true } };
}

function validateTranslatorLogFile(
	file: string | null | undefined,
):
	| { file: string; ok: true }
	| { body: JsonObject; ok: false; status: number } {
	if (!file) {
		return {
			ok: false,
			status: 400,
			body: { success: false, error: "File parameter required" },
		};
	}
	if (!TRANSLATOR_LOG_FILES.has(file)) {
		return {
			ok: false,
			status: 400,
			body: { success: false, error: "Invalid file name" },
		};
	}
	return { file, ok: true };
}

function translatorLogDir(): string {
	return join(electronApp.getPath("userData"), "router", "logs", "translator");
}

function translatorLogFilePath(file: string): string {
	return join(translatorLogDir(), file);
}

function translateRouterDebugRequest(input: unknown): {
	body: JsonObject;
	status: number;
} {
	const request = toJsonObject(input);
	const step = Number(request.step);
	if (!Number.isFinite(step) || !request.body) {
		return {
			status: 400,
			body: { success: false, error: "Step and body required" },
		};
	}
	const body = toJsonObject(request.body);
	const clientBody = toJsonObject(body.body ?? body);
	if (step === 1) {
		const requestedModel = stringValue(clientBody.model) ?? "";
		const target = resolveRouterModelTarget(
			requestedModel,
			getResolutionOptions(),
		);
		const provider = target?.provider ?? inferProviderFromModel(requestedModel);
		return {
			status: 200,
			body: {
				success: true,
				result: {
					provider,
					model: target?.model ?? requestedModel,
					sourceFormat: detectTranslatorRequestFormat(clientBody),
					targetFormat: translatorTargetFormat(provider),
				},
			},
		};
	}
	if (step === 2) {
		const sourceFormat = detectTranslatorRequestFormat(clientBody);
		if (sourceFormat !== "openai") {
			return {
				status: 501,
				body: {
					success: false,
					error:
						"ADE translator debug currently supports OpenAI-source request inspection only.",
				},
			};
		}
		return {
			status: 200,
			body: { success: true, result: { body: clientBody } },
		};
	}
	if (step === 3) {
		const provider = stringValue(body.provider);
		const model = stringValue(body.model);
		if (!provider || !model) {
			return {
				status: 400,
				body: { success: false, error: "provider and model required" },
			};
		}
		const targetFormat = translatorTargetFormat(provider);
		const stream = clientBody.stream !== false;
		const translatedBody =
			targetFormat === "anthropic"
				? openAiChatToAnthropicBody(clientBody, model, { stream })
				: withModel(clientBody, model);
		return {
			status: 200,
			body: {
				success: true,
				result: {
					url: null,
					headers: {},
					body: translatedBody,
					targetFormat,
					warning:
						"ADE returned the translated request body; full executor URL/header debug requires vendoring 9router open-sse executors.",
				},
			},
		};
	}
	return {
		status: 400,
		body: { success: false, error: "Invalid step (1-3)" },
	};
}

async function sendTranslatorDebugRequest(
	req: Request,
	res: ExpressResponse,
): Promise<void> {
	const body = toJsonObject(req.body);
	const provider = stringValue(body.provider);
	const model = stringValue(body.model);
	const requestBody = toJsonObject(body.body);
	if (!provider || !model || !body.body) {
		res.status(400).json({
			success: false,
			error: "provider, model, and body required",
		});
		return;
	}

	appendTranslatorConsoleLine(
		`[Translator] Sending ${provider}/${model} through ADE router gateway`,
	);
	const dispatchBody = withModel(requestBody, model);
	const originalBody = req.body;
	try {
		req.body = dispatchBody;
		const targetFormat = translatorTargetFormat(provider);
		if (targetFormat === "anthropic") {
			await handleAnthropicMessages(req, res);
			return;
		}
		if (
			Array.isArray(dispatchBody.input) &&
			!Array.isArray(dispatchBody.messages)
		) {
			await handleResponses(req, res);
			return;
		}
		await handleChatCompletions(req, res);
	} catch (error) {
		if (!res.headersSent) {
			res.status(500).json({
				success: false,
				error: errorMessage(error),
			});
		}
	} finally {
		req.body = originalBody;
	}
}

function detectTranslatorRequestFormat(body: JsonObject): string {
	if (Array.isArray(body.messages)) return "openai";
	if (Array.isArray(body.contents)) return "gemini";
	if (Array.isArray(body.input)) return "openai-responses";
	return "openai";
}

function translatorTargetFormat(provider: string): string {
	const normalized = provider.toLowerCase();
	if (normalized === "anthropic" || normalized === "claude") return "anthropic";
	if (normalized === "gemini") return "gemini";
	return "openai";
}

function parseProviderNodeBody(value: unknown): Partial<RouterProviderNode> {
	const body = toJsonObject(value);
	return {
		apiKeyAccountId:
			typeof body.apiKeyAccountId === "string"
				? body.apiKeyAccountId
				: body.apiKeyAccountId === null
					? null
					: undefined,
		apiKeyProvider:
			typeof body.apiKeyProvider === "string"
				? (body.apiKeyProvider as RouterProviderKeyId)
				: undefined,
		apiType:
			body.apiType === "responses" || body.apiType === "chat"
				? body.apiType
				: undefined,
		baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
		isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
		models: parseModelList(body.models),
		name: typeof body.name === "string" ? body.name : undefined,
		prefix: typeof body.prefix === "string" ? body.prefix : undefined,
		type: parseProviderNodeType(body.type),
	};
}

function parseProviderNodeValidationBody(
	value: unknown,
): RouterProviderNodeValidationInput {
	const body = toJsonObject(value);
	return {
		...parseProviderNodeBody(value),
		apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
		id: typeof body.id === "string" ? body.id : undefined,
		modelId: typeof body.modelId === "string" ? body.modelId : undefined,
	};
}

function parseModelList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) return value.map(String);
	if (typeof value === "string") {
		return value
			.split(/[\n,]+/)
			.map((model) => model.trim())
			.filter(Boolean);
	}
	return undefined;
}

function parseProviderNodeType(
	value: unknown,
): RouterProviderNodeType | undefined {
	if (
		value === "openai-compatible" ||
		value === "anthropic-compatible" ||
		value === "custom-embedding"
	) {
		return value;
	}
	return undefined;
}

function parseDiscoveredProviderNodeModels(
	data: JsonObject,
): RouterDiscoveredProviderNodeModel[] {
	const rawModels = extractRawModelList(data);
	const models = new Map<string, RouterDiscoveredProviderNodeModel>();
	for (const item of rawModels) {
		const value = toJsonObject(item);
		const id =
			stringValue(value.id) ??
			stringValue(value.model) ??
			stringValue(value.slug) ??
			stringValue(value.name);
		if (!id) continue;
		models.set(id, {
			id,
			name:
				stringValue(value.display_name) ??
				stringValue(value.displayName) ??
				stringValue(value.name) ??
				id,
		});
	}
	return Array.from(models.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function extractRawModelList(data: JsonObject): unknown[] {
	if (Array.isArray(data)) return data;
	if (Array.isArray(data.data)) return data.data;
	if (Array.isArray(data.models)) return data.models;
	if (Array.isArray(data.results)) return data.results;
	if (data.models && typeof data.models === "object") {
		return Object.entries(data.models as Record<string, unknown>).map(
			([id, value]) => ({
				...toJsonObject(value),
				id,
			}),
		);
	}
	return [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number(value)
				: Number.NaN;
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseTimeMs(value: unknown): number | null {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value === "number") {
		return Number.isFinite(value)
			? value < 1e12
				? value * 1000
				: value
			: null;
	}
	if (typeof value !== "string") return null;
	const parsed = new Date(value).getTime();
	return Number.isFinite(parsed) ? parsed : null;
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs = 10_000,
): Promise<globalThis.Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

function isValidHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function getModelsErrorMessage(status: number): string {
	if (status === 401 || status === 403) return "API key unauthorized";
	if (status === 404)
		return "/models endpoint not found - enter a model ID to validate via inference.";
	if (status >= 500) return "Server error - try again later";
	return `Unexpected response (${status})`;
}

function getChatErrorMessage(status: number): string {
	if (status === 401 || status === 403) return "API key unauthorized";
	if (status === 400) return "Invalid model or bad request";
	if (status === 404) return "Inference endpoint not found";
	if (status >= 500) return "Server error - try again later";
	return `Inference request failed (${status})`;
}

function isAuthFailureStatus(status: number): boolean {
	return status === 401 || status === 403;
}

function getProviderNodeNetworkErrorMessage(error: unknown): string {
	const value = error as { cause?: { code?: string }; message?: string };
	if (value.cause?.code === "ECONNREFUSED")
		return "Connection refused - provider node offline or unreachable";
	if (value.cause?.code === "ENOTFOUND")
		return "DNS lookup failed - invalid domain or network issue";
	if (value.cause?.code === "ETIMEDOUT")
		return "Connection timeout - provider node too slow";
	if (value.message?.includes("abort") || value.message?.includes("timeout"))
		return "Request timeout (>10s) - provider node not responding";
	if (value.cause?.code === "CERT_HAS_EXPIRED")
		return "SSL certificate expired";
	if (value.cause?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE")
		return "SSL certificate verification failed";
	if (value.cause?.code) return `Network error: ${value.cause.code}`;
	return "Network connection failed - check URL and network connectivity";
}

function withModel(body: JsonObject, model: string): JsonObject {
	return { ...body, model };
}

function openAiChatToAnthropicBody(
	body: JsonObject,
	model: string,
	{ stream = false }: { stream?: boolean } = {},
): JsonObject {
	const messages: JsonObject[] = [];
	const systemParts: string[] = [];
	const sourceMessages = Array.isArray(body.messages) ? body.messages : [];

	for (const item of sourceMessages) {
		if (!item || typeof item !== "object") continue;
		const value = item as JsonObject;
		const role = typeof value.role === "string" ? value.role : "user";
		if (role === "system") {
			const text = extractContentText(value.content);
			if (!text) continue;
			systemParts.push(text);
			continue;
		}

		const content = openAiMessageToAnthropicContent(value);
		if (content.length === 0) continue;
		appendAnthropicMessage(
			messages,
			role === "assistant" ? "assistant" : "user",
			content,
		);
	}

	const result: JsonObject = {
		model,
		messages: messages.length > 0 ? messages : [{ role: "user", content: "" }],
		max_tokens: Number(body.max_tokens ?? body.max_output_tokens ?? 1024),
		system:
			typeof body.system === "string"
				? body.system
				: systemParts.length > 0
					? systemParts.join("\n\n")
					: undefined,
		temperature: body.temperature,
		top_p: body.top_p,
		stop_sequences: parseStopSequences(body.stop),
		stream,
	};
	const tools = openAiToolsToAnthropicTools(body.tools);
	if (tools.length > 0) result.tools = tools;
	const toolChoice = openAiToolChoiceToAnthropic(body.tool_choice);
	if (toolChoice) result.tool_choice = toolChoice;
	return result;
}

function appendAnthropicMessage(
	messages: JsonObject[],
	role: "assistant" | "user",
	content: JsonObject[],
): void {
	const previous = messages[messages.length - 1];
	if (previous?.role === role && Array.isArray(previous.content)) {
		previous.content.push(...content);
		return;
	}
	messages.push({ role, content });
}

function openAiMessageToAnthropicContent(message: JsonObject): JsonObject[] {
	const role = typeof message.role === "string" ? message.role : "user";
	if (role === "tool") {
		return [
			{
				type: "tool_result",
				tool_use_id:
					typeof message.tool_call_id === "string"
						? message.tool_call_id
						: `toolu_${cryptoId()}`,
				content: extractContentText(message.content),
			},
		];
	}

	const blocks: JsonObject[] = [];
	const content = message.content;
	if (typeof content === "string") {
		if (content) blocks.push({ type: "text", text: content });
	} else if (Array.isArray(content)) {
		for (const part of content) {
			const block = openAiContentPartToAnthropicBlock(part);
			if (block) blocks.push(block);
		}
	}

	if (Array.isArray(message.tool_calls)) {
		for (const call of message.tool_calls) {
			if (!call || typeof call !== "object") continue;
			const toolCall = call as JsonObject;
			const fn = toolCall.function as JsonObject | undefined;
			const name =
				typeof fn?.name === "string"
					? fn.name
					: typeof toolCall.name === "string"
						? toolCall.name
						: "tool";
			blocks.push({
				type: "tool_use",
				id:
					typeof toolCall.id === "string" ? toolCall.id : `call_${cryptoId()}`,
				name,
				input: parseJsonObject(fn?.arguments),
			});
		}
	}

	return blocks;
}

function openAiContentPartToAnthropicBlock(part: unknown): JsonObject | null {
	if (typeof part === "string")
		return part ? { type: "text", text: part } : null;
	if (!part || typeof part !== "object") return null;
	const value = part as JsonObject;
	if (value.type === "text" && typeof value.text === "string") {
		return { type: "text", text: value.text };
	}
	if (value.type === "image_url") {
		const imageUrl = value.image_url as JsonObject | undefined;
		const url = typeof imageUrl?.url === "string" ? imageUrl.url : "";
		if (!url) return null;
		const parsed = parseDataUri(url);
		return {
			type: "image",
			source: parsed
				? {
						type: "base64",
						media_type: parsed.mimeType,
						data: parsed.base64,
					}
				: { type: "url", url },
		};
	}
	if (value.type === "tool_result") {
		return {
			type: "tool_result",
			tool_use_id: value.tool_use_id,
			content: value.content ?? "",
			...(value.is_error === true ? { is_error: true } : {}),
		};
	}
	if (value.type === "image" && value.source) {
		return { type: "image", source: value.source };
	}
	if (value.type === "file") {
		const file = value.file as JsonObject | undefined;
		const parsed = parseDataUri(file?.file_data);
		if (parsed?.mimeType === "application/pdf") {
			return {
				type: "document",
				source: {
					type: "base64",
					media_type: parsed.mimeType,
					data: parsed.base64,
				},
			};
		}
	}
	return null;
}

function openAiToolsToAnthropicTools(tools: unknown): JsonObject[] {
	if (!Array.isArray(tools)) return [];
	const converted: JsonObject[] = [];
	for (const tool of tools) {
		if (!tool || typeof tool !== "object") continue;
		const value = tool as JsonObject;
		const fn =
			value.type === "function" &&
			value.function &&
			typeof value.function === "object"
				? (value.function as JsonObject)
				: value;
		if (typeof fn.name !== "string") {
			if (typeof value.type === "string" && value.type !== "function") {
				converted.push(value);
			}
			continue;
		}
		converted.push({
			name: fn.name,
			description: typeof fn.description === "string" ? fn.description : "",
			input_schema:
				fn.parameters && typeof fn.parameters === "object"
					? fn.parameters
					: { type: "object", properties: {}, required: [] },
		});
	}
	return converted;
}

function openAiToolChoiceToAnthropic(choice: unknown): JsonObject | undefined {
	if (!choice) return undefined;
	if (choice === "required") return { type: "any" };
	if (choice === "auto" || choice === "none") return { type: choice };
	if (typeof choice === "object") {
		const value = choice as JsonObject;
		const fn = value.function as JsonObject | undefined;
		if (typeof fn?.name === "string") return { type: "tool", name: fn.name };
		if (
			value.type === "auto" ||
			value.type === "any" ||
			value.type === "tool" ||
			value.type === "none"
		) {
			return value;
		}
	}
	return { type: "auto" };
}

function chatBodyToResponsesBody(body: JsonObject, model: string): JsonObject {
	const { max_tokens, messages, stream, ...rest } = body;
	const sourceMessages = Array.isArray(messages) ? messages : [];
	const systemParts: string[] = [];
	const inputParts: string[] = [];
	for (const item of sourceMessages) {
		if (!item || typeof item !== "object") continue;
		const value = item as JsonObject;
		const role = typeof value.role === "string" ? value.role : "user";
		const text = extractContentText(value.content);
		if (!text) continue;
		if (role === "system") systemParts.push(text);
		else inputParts.push(`${role}: ${text}`);
	}
	void stream;
	return {
		...rest,
		model,
		instructions: systemParts.join("\n\n") || rest.instructions,
		input: inputParts.join("\n\n") || rest.input || "Continue.",
		max_output_tokens: rest.max_output_tokens ?? max_tokens,
		stream: false,
	};
}

function anthropicBodyToResponsesBody(
	body: JsonObject,
	model: string,
): JsonObject {
	const messages = anthropicMessagesToOpenAiMessages(body);
	return chatBodyToResponsesBody(
		{
			...body,
			messages,
			max_tokens: body.max_tokens,
		},
		model,
	);
}

function responsesBodyToChatBody(body: JsonObject, model: string): JsonObject {
	const { input, instructions, max_output_tokens, ...rest } = body;
	void input;
	void instructions;
	return {
		...rest,
		model,
		messages: responsesInputToMessages(body),
		max_tokens: max_output_tokens ?? body.max_tokens,
		stream: false,
	};
}

function openAiChatToResponsesResponse(
	upstream: JsonObject,
	nodeTarget: ProviderNodeTarget,
): JsonObject {
	const text = extractAssistantText(upstream);
	const usage = extractOpenAIUsage(upstream);
	return buildResponsesResponse({
		inputTokens: usage.prompt_tokens,
		model: nodeTarget.requestedModel,
		outputTokens: usage.completion_tokens,
		text,
	});
}

function anthropicToResponsesResponse(
	upstream: JsonObject,
	nodeTarget: ProviderNodeTarget,
): JsonObject {
	const usage = extractAnthropicUsage(upstream);
	return buildResponsesResponse({
		inputTokens: usage.input_tokens,
		model: nodeTarget.requestedModel,
		outputTokens: usage.output_tokens,
		text: extractAnthropicText(upstream),
	});
}

function responsesToOpenAiChatResponse(
	upstream: JsonObject,
	nodeTarget: ProviderNodeTarget,
): JsonObject {
	const usage = extractResponsesUsage(upstream);
	return buildOpenAiChatResponse({
		completionTokens: usage.output_tokens,
		finishReason: "stop",
		model: nodeTarget.requestedModel,
		promptTokens: usage.input_tokens,
		text: extractResponsesText(upstream),
	});
}

function anthropicToOpenAiChatResponse(
	upstream: JsonObject,
	nodeTarget: ProviderNodeTarget,
): JsonObject {
	const usage = extractAnthropicUsage(upstream);
	return buildOpenAiChatResponse({
		completionTokens: usage.output_tokens,
		finishReason:
			typeof upstream.stop_reason === "string" ? upstream.stop_reason : "stop",
		model: nodeTarget.requestedModel,
		promptTokens: usage.input_tokens,
		text: extractAnthropicText(upstream),
	});
}

function openAiChatToAnthropicMessage(
	upstream: JsonObject,
	nodeTarget: ProviderNodeTarget,
): JsonObject {
	const usage = extractOpenAIUsage(upstream);
	return buildAnthropicMessage({
		inputTokens: usage.prompt_tokens,
		model: nodeTarget.requestedModel,
		outputTokens: usage.completion_tokens,
		stopReason: extractStopReason(upstream),
		text: extractAssistantText(upstream),
	});
}

function responsesToAnthropicMessage(
	upstream: JsonObject,
	nodeTarget: ProviderNodeTarget,
): JsonObject {
	const usage = extractResponsesUsage(upstream);
	return buildAnthropicMessage({
		inputTokens: usage.input_tokens,
		model: nodeTarget.requestedModel,
		outputTokens: usage.output_tokens,
		stopReason: "end_turn",
		text: extractResponsesText(upstream),
	});
}

function buildOpenAiChatResponse({
	completionTokens,
	finishReason,
	model,
	promptTokens,
	text,
}: {
	completionTokens: number;
	finishReason: string | null;
	model: string;
	promptTokens: number;
	text: string;
}): JsonObject {
	return {
		id: `chatcmpl_${cryptoId()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: text },
				finish_reason: finishReason ?? "stop",
			},
		],
		usage: {
			prompt_tokens: promptTokens,
			completion_tokens: completionTokens,
			total_tokens: promptTokens + completionTokens,
		},
	};
}

function buildResponsesResponse({
	inputTokens,
	model,
	outputTokens,
	text,
}: {
	inputTokens: number;
	model: string;
	outputTokens: number;
	text: string;
}): JsonObject {
	return {
		id: `resp_${cryptoId()}`,
		object: "response",
		created_at: Math.floor(Date.now() / 1000),
		status: "completed",
		model,
		output_text: text,
		output: [
			{
				id: `msg_${cryptoId()}`,
				type: "message",
				status: "completed",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text,
						annotations: [],
					},
				],
			},
		],
		usage: {
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			total_tokens: inputTokens + outputTokens,
		},
	};
}

function buildAnthropicMessage({
	inputTokens,
	model,
	outputTokens,
	stopReason,
	text,
}: {
	inputTokens: number;
	model: string;
	outputTokens: number;
	stopReason: string | null;
	text: string;
}): JsonObject {
	return {
		id: `msg_${cryptoId()}`,
		type: "message",
		role: "assistant",
		model,
		content: [{ type: "text", text }],
		stop_reason: stopReason ?? "end_turn",
		stop_sequence: null,
		usage: {
			input_tokens: inputTokens,
			output_tokens: outputTokens,
		},
	};
}

function extractAnthropicText(upstream: JsonObject): string {
	const content = upstream.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const value = part as JsonObject;
			return typeof value.text === "string" ? value.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function extractResponsesText(upstream: JsonObject): string {
	if (typeof upstream.output_text === "string") return upstream.output_text;
	const output = upstream.output;
	if (!Array.isArray(output)) return "";
	return output
		.flatMap((item) => {
			if (!item || typeof item !== "object") return [];
			const content = (item as JsonObject).content;
			return Array.isArray(content) ? content : [];
		})
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const value = part as JsonObject;
			return typeof value.text === "string" ? value.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function extractAnthropicUsage(upstream: JsonObject) {
	const usage = upstream.usage as JsonObject | undefined;
	const inputTokens = Number(usage?.input_tokens ?? 0);
	const outputTokens = Number(usage?.output_tokens ?? 0);
	return {
		input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
		output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
	};
}

function extractResponsesUsage(upstream: JsonObject) {
	const usage = upstream.usage as JsonObject | undefined;
	const inputTokens = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
	const outputTokens = Number(
		usage?.output_tokens ?? usage?.completion_tokens ?? 0,
	);
	return {
		input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
		output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
	};
}

function parseStopSequences(value: unknown): string[] | undefined {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) {
		const stop = value.filter(
			(entry): entry is string => typeof entry === "string",
		);
		return stop.length > 0 ? stop : undefined;
	}
	return undefined;
}

async function fetchOpenRouterWithFallback(
	body: JsonObject,
	signal?: AbortSignal,
): Promise<OpenRouterSuccess | GatewayFailure> {
	const target = resolveRouterModelTarget(
		typeof body.model === "string" ? body.model : undefined,
		getResolutionOptions(),
	);

	if (!target) {
		return {
			ok: false,
			status: 400,
			body: {
				error: {
					message:
						"Unsupported model for the embedded gateway. Use an OpenRouter model, an OpenRouter-backed agent, a model alias, or a combo with OpenRouter fallback.",
					type: "invalid_request_error",
				},
			},
		};
	}

	const fallbackModels = target.fallbackModels.filter(
		(model) =>
			!isRouterModelDisabled("openrouter", model) &&
			!isRouterModelDisabledForModelPath(model),
	);
	if (fallbackModels.length === 0) {
		return {
			ok: false,
			status: 403,
			body: {
				error: {
					message:
						"All fallback models for this route are disabled in the router registry.",
					type: "model_disabled",
					models: target.fallbackModels,
				},
			},
		};
	}

	const accounts = getProviderAccountCredentials("openrouter");
	if (accounts.length === 0) {
		return {
			ok: false,
			status: 401,
			body: {
				error: {
					message:
						"OpenRouter API key is not configured in ADE. Add it in the router dashboard provider key section to use OpenRouter-backed endpoints.",
					type: "authentication_error",
				},
			},
		};
	}

	let lastFailure: {
		account: string;
		model: string;
		status: number;
		text: string;
	} | null = null;
	for (const model of fallbackModels) {
		for (const account of accounts) {
			const upstreamBody = { ...body, model };
			const upstream = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${account.key}`,
					"HTTP-Referer": "https://github.com/per-simmons/damon-ade",
					"X-Title": "ADE Orchestrator Router",
				},
				body: JSON.stringify(upstreamBody),
				signal,
			});

			if (upstream.ok) {
				markProviderAccountSuccess(account);
				return {
					ok: true,
					account,
					upstream,
					target,
					model,
				};
			}

			const text = await upstream.text().catch(() => upstream.statusText);
			lastFailure = {
				account: account.name,
				model,
				status: upstream.status,
				text,
			};
			markProviderAccountFailure({
				credential: account,
				status: upstream.status,
				text,
			});
		}
	}

	return {
		ok: false,
		status: lastFailure?.status ?? 502,
		body: {
			error: {
				message: "All OpenRouter fallback models failed.",
				type: "upstream_error",
				details: lastFailure,
				models: fallbackModels,
			},
		},
	};
}

async function pipeUpstreamResponse(
	upstream: globalThis.Response,
	res: ExpressResponse,
) {
	res.status(upstream.status);
	const contentType = upstream.headers.get("content-type");
	if (contentType) res.setHeader("Content-Type", contentType);

	for (const [key, value] of upstream.headers.entries()) {
		const lowerKey = key.toLowerCase();
		if (
			lowerKey === "content-length" ||
			lowerKey === "content-encoding" ||
			lowerKey === "transfer-encoding"
		) {
			continue;
		}
		res.setHeader(key, value);
	}

	if (!upstream.body) {
		res.end(await upstream.text());
		return;
	}

	await new Promise<void>((resolve, reject) => {
		const nodeStream = Readable.fromWeb(upstream.body as never);
		nodeStream.on("error", reject);
		res.on("finish", resolve);
		res.on("close", resolve);
		nodeStream.pipe(res);
	});
}

interface SseBlock {
	event?: string;
	data: string;
}

interface AnthropicToOpenAiSseState {
	id: string;
	model: string;
	created: number;
	finishSent: boolean;
	doneSent: boolean;
	toolBlockIndexes: Map<number, number>;
	nextToolIndex: number;
	usage?: JsonObject;
}

interface OpenAiToAnthropicSseState {
	id: string;
	model: string;
	messageStartSent: boolean;
	messageStopSent: boolean;
	nextBlockIndex: number;
	textBlockIndex: number | null;
	thinkingBlockIndex: number | null;
	toolBlocks: Map<number, number>;
	usage?: JsonObject;
}

type NormalizedStreamTarget =
	| "openai-chat"
	| "openai-responses"
	| "anthropic-messages";

interface NormalizedStreamState {
	id: string;
	model: string;
	created: number;
	target: NormalizedStreamTarget;
	text: string;
	textBlockIndex: number | null;
	thinkingBlockIndex: number | null;
	toolBlocks: Map<number, number>;
	toolArgumentLengths: Map<string, number>;
	nextBlockIndex: number;
	finishReason: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	};
}

async function pipeNormalizedProviderStream(
	upstream: globalThis.Response,
	res: ExpressResponse,
	options: {
		model: string;
		source: AgentProviderProtocolHint;
		target: NormalizedStreamTarget;
	},
) {
	const state: NormalizedStreamState = {
		id:
			options.target === "anthropic-messages"
				? `msg_${cryptoId()}`
				: options.target === "openai-responses"
					? `resp_${cryptoId()}`
					: `chatcmpl_${cryptoId()}`,
		model: options.model,
		created: Math.floor(Date.now() / 1000),
		target: options.target,
		text: "",
		textBlockIndex: null,
		thinkingBlockIndex: null,
		toolBlocks: new Map(),
		toolArgumentLengths: new Map(),
		nextBlockIndex: 0,
		finishReason: "stop",
		usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
	};
	const normalizer = new ProviderStreamNormalizer({
		protocol: options.source,
		contentType: upstream.headers.get("content-type") ?? undefined,
	});

	res.status(upstream.status);
	res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache, no-transform");
	res.setHeader("Connection", "keep-alive");
	res.setHeader("X-Accel-Buffering", "no");
	res.flushHeaders?.();
	writeNormalizedStreamStart(res, state);

	const writeEvents = (events: NormalizedProviderEvent[]) => {
		for (const event of events) writeNormalizedProviderEvent(res, state, event);
	};
	if (!upstream.body) {
		writeEvents(normalizer.end(await upstream.text()));
	} else {
		const nodeStream = Readable.fromWeb(upstream.body as never);
		for await (const chunk of nodeStream) {
			writeEvents(normalizer.push(chunk as Buffer));
		}
		writeEvents(normalizer.end());
	}
	writeNormalizedStreamFinish(res, state);
	if (!res.writableEnded) res.end();
}

function writeNormalizedStreamStart(
	res: ExpressResponse,
	state: NormalizedStreamState,
) {
	if (state.target === "openai-responses") {
		writeNamedSse(res, "response.created", {
			type: "response.created",
			response: {
				id: state.id,
				object: "response",
				status: "in_progress",
				model: state.model,
				output: [],
			},
		});
	} else if (state.target === "anthropic-messages") {
		writeNamedSse(res, "message_start", {
			type: "message_start",
			message: {
				id: state.id,
				type: "message",
				role: "assistant",
				model: state.model,
				content: [],
				stop_reason: null,
				usage: { input_tokens: 0, output_tokens: 0 },
			},
		});
	}
}

function writeNormalizedProviderEvent(
	res: ExpressResponse,
	state: NormalizedStreamState,
	event: NormalizedProviderEvent,
) {
	if (event.type === "usage") {
		state.usage = {
			inputTokens: event.usage.inputTokens,
			outputTokens: event.usage.outputTokens,
			totalTokens: event.usage.totalTokens,
		};
		return;
	}
	if (event.type === "finish") {
		state.finishReason = event.finishReason;
		return;
	}
	if (event.type === "error") {
		writeNamedSse(res, "error", { type: "error", error: event.error });
		state.finishReason = "error";
		return;
	}
	if (event.type === "text-delta" || event.type === "reasoning-delta") {
		state.text += event.type === "text-delta" ? event.text : "";
		writeNormalizedTextDelta(
			res,
			state,
			event.text,
			event.type === "reasoning-delta",
		);
		return;
	}
	writeNormalizedToolDelta(res, state, event.toolCall);
}

function writeNormalizedTextDelta(
	res: ExpressResponse,
	state: NormalizedStreamState,
	text: string,
	reasoning: boolean,
) {
	if (state.target === "openai-chat") {
		res.write(
			`data: ${JSON.stringify({
				id: state.id,
				object: "chat.completion.chunk",
				created: state.created,
				model: state.model,
				choices: [
					{
						index: 0,
						delta: reasoning ? { reasoning_content: text } : { content: text },
						finish_reason: null,
					},
				],
			})}\n\n`,
		);
		return;
	}
	if (state.target === "openai-responses") {
		writeNamedSse(
			res,
			reasoning
				? "response.reasoning_text.delta"
				: "response.output_text.delta",
			{
				type: reasoning
					? "response.reasoning_text.delta"
					: "response.output_text.delta",
				item_id: `${state.id}_message`,
				output_index: 0,
				content_index: 0,
				delta: text,
			},
		);
		return;
	}
	const existingBlockIndex = reasoning
		? state.thinkingBlockIndex
		: state.textBlockIndex;
	let blockIndex = existingBlockIndex;
	if (blockIndex === null) {
		blockIndex = state.nextBlockIndex++;
		if (reasoning) state.thinkingBlockIndex = blockIndex;
		else state.textBlockIndex = blockIndex;
		writeNamedSse(res, "content_block_start", {
			type: "content_block_start",
			index: blockIndex,
			content_block: reasoning
				? { type: "thinking", thinking: "" }
				: { type: "text", text: "" },
		});
	}
	writeNamedSse(res, "content_block_delta", {
		type: "content_block_delta",
		index: blockIndex,
		delta: {
			type: reasoning ? "thinking_delta" : "text_delta",
			[reasoning ? "thinking" : "text"]: text,
		},
	});
}

function writeNormalizedToolDelta(
	res: ExpressResponse,
	state: NormalizedStreamState,
	toolCall: { id: string; index: number; name: string; arguments: string },
) {
	const previousLength = state.toolArgumentLengths.get(toolCall.id) ?? 0;
	const nextArguments = takeAccumulatedArgumentsDelta(
		toolCall.arguments,
		previousLength,
	);
	const argumentsDelta = nextArguments.delta;
	state.toolArgumentLengths.set(toolCall.id, nextArguments.emittedLength);
	if (state.target === "openai-chat") {
		if (argumentsDelta.length === 0 && previousLength > 0) return;
		res.write(
			`data: ${JSON.stringify({
				id: state.id,
				object: "chat.completion.chunk",
				created: state.created,
				model: state.model,
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: toolCall.index,
									id: toolCall.id,
									type: "function",
									function: {
										name: toolCall.name,
										arguments: argumentsDelta,
									},
								},
							],
						},
						finish_reason: null,
					},
				],
			})}\n\n`,
		);
		return;
	}
	if (state.target === "openai-responses") {
		if (argumentsDelta.length === 0 && previousLength > 0) return;
		writeNamedSse(res, "response.function_call_arguments.delta", {
			type: "response.function_call_arguments.delta",
			item_id: toolCall.id,
			output_index: toolCall.index,
			delta: argumentsDelta,
		});
		return;
	}
	let blockIndex = state.toolBlocks.get(toolCall.index);
	if (blockIndex === undefined) {
		blockIndex = state.nextBlockIndex++;
		state.toolBlocks.set(toolCall.index, blockIndex);
		writeNamedSse(res, "content_block_start", {
			type: "content_block_start",
			index: blockIndex,
			content_block: {
				type: "tool_use",
				id: toolCall.id,
				name: toolCall.name,
				input: {},
			},
		});
	}
	if (argumentsDelta.length === 0) return;
	writeNamedSse(res, "content_block_delta", {
		type: "content_block_delta",
		index: blockIndex,
		delta: { type: "input_json_delta", partial_json: argumentsDelta },
	});
}

function writeNormalizedStreamFinish(
	res: ExpressResponse,
	state: NormalizedStreamState,
) {
	if (state.target === "openai-chat") {
		res.write(
			`data: ${JSON.stringify({
				id: state.id,
				object: "chat.completion.chunk",
				created: state.created,
				model: state.model,
				choices: [
					{
						index: 0,
						delta: {},
						finish_reason: openAiFinishReason(state.finishReason),
					},
				],
				usage: {
					prompt_tokens: state.usage.inputTokens,
					completion_tokens: state.usage.outputTokens,
					total_tokens: state.usage.totalTokens,
				},
			})}\n\ndata: [DONE]\n\n`,
		);
		return;
	}
	if (state.target === "openai-responses") {
		writeNamedSse(res, "response.completed", {
			type: "response.completed",
			response: {
				id: state.id,
				object: "response",
				status: state.finishReason === "error" ? "failed" : "completed",
				model: state.model,
				output_text: state.text,
				output: [],
				usage: {
					input_tokens: state.usage.inputTokens,
					output_tokens: state.usage.outputTokens,
					total_tokens: state.usage.totalTokens,
				},
			},
		});
		return;
	}
	for (const blockIndex of [state.thinkingBlockIndex, state.textBlockIndex]) {
		if (blockIndex === null) continue;
		writeNamedSse(res, "content_block_stop", {
			type: "content_block_stop",
			index: blockIndex,
		});
	}
	for (const blockIndex of state.toolBlocks.values()) {
		writeNamedSse(res, "content_block_stop", {
			type: "content_block_stop",
			index: blockIndex,
		});
	}
	writeNamedSse(res, "message_delta", {
		type: "message_delta",
		delta: { stop_reason: anthropicFinishReason(state.finishReason) },
		usage: { output_tokens: state.usage.outputTokens },
	});
	writeNamedSse(res, "message_stop", { type: "message_stop" });
}

function writeNamedSse(res: ExpressResponse, event: string, payload: unknown) {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function openAiFinishReason(reason: string): string {
	if (reason === "tool-calls") return "tool_calls";
	if (reason === "length") return "length";
	if (reason === "content-filter") return "content_filter";
	return "stop";
}

function anthropicFinishReason(reason: string): string {
	if (reason === "tool-calls") return "tool_use";
	if (reason === "length") return "max_tokens";
	return "end_turn";
}

async function pipeAnthropicStreamAsOpenAiChat(
	upstream: globalThis.Response,
	res: ExpressResponse,
	nodeTarget: ProviderNodeTarget,
) {
	const state: AnthropicToOpenAiSseState = {
		id: `chatcmpl_${cryptoId()}`,
		model: nodeTarget.requestedModel,
		created: Math.floor(Date.now() / 1000),
		finishSent: false,
		doneSent: false,
		toolBlockIndexes: new Map(),
		nextToolIndex: 0,
	};
	await pipeTranslatedSseBlocks(upstream, res, (block) =>
		translateAnthropicSseBlockToOpenAi(block, state),
	);
	if (!state.doneSent && !res.writableEnded) {
		if (!state.finishSent) {
			res.write(openAiChatSseChunk(state, {}, "stop", state.usage));
		}
		res.write("data: [DONE]\n\n");
	}
	if (!res.writableEnded) res.end();
}

async function pipeOpenAiChatStreamAsAnthropic(
	upstream: globalThis.Response,
	res: ExpressResponse,
	nodeTarget: ProviderNodeTarget,
) {
	const state: OpenAiToAnthropicSseState = {
		id: `msg_${cryptoId()}`,
		model: nodeTarget.requestedModel,
		messageStartSent: false,
		messageStopSent: false,
		nextBlockIndex: 0,
		textBlockIndex: null,
		thinkingBlockIndex: null,
		toolBlocks: new Map(),
	};
	await pipeTranslatedSseBlocks(upstream, res, (block) =>
		translateOpenAiSseBlockToAnthropic(block, state),
	);
	if (!state.messageStopSent && !res.writableEnded) {
		for (const output of finishAnthropicStream(state, "end_turn")) {
			res.write(output);
		}
	}
	if (!res.writableEnded) res.end();
}

async function pipeTranslatedSseBlocks(
	upstream: globalThis.Response,
	res: ExpressResponse,
	translate: (block: SseBlock) => string[],
) {
	res.status(upstream.status);
	res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache, no-transform");
	res.setHeader("Connection", "keep-alive");
	res.setHeader("X-Accel-Buffering", "no");
	res.flushHeaders?.();

	let buffer = "";
	const processText = (text: string) => {
		buffer += text;
		const blocks = buffer.split(/\r?\n\r?\n/);
		buffer = blocks.pop() ?? "";
		for (const rawBlock of blocks) {
			for (const output of translate(parseSseBlock(rawBlock))) {
				res.write(output);
			}
		}
	};

	if (!upstream.body) {
		processText(await upstream.text());
	} else {
		const decoder = new TextDecoder("utf-8", { fatal: false });
		const nodeStream = Readable.fromWeb(upstream.body as never);
		for await (const chunk of nodeStream) {
			processText(decoder.decode(chunk as Buffer, { stream: true }));
		}
		processText(decoder.decode());
	}

	if (buffer.trim()) {
		for (const output of translate(parseSseBlock(buffer))) {
			res.write(output);
		}
	}
}

function parseSseBlock(rawBlock: string): SseBlock {
	let event: string | undefined;
	const data: string[] = [];
	for (const line of rawBlock.split(/\r?\n/)) {
		if (line.startsWith("event:")) event = line.slice("event:".length).trim();
		else if (line.startsWith("data:"))
			data.push(line.slice("data:".length).trimStart());
	}
	return { event, data: data.join("\n") };
}

function translateAnthropicSseBlockToOpenAi(
	block: SseBlock,
	state: AnthropicToOpenAiSseState,
): string[] {
	if (!block.data || block.data === "[DONE]") return [];
	const payload = parseSseJson(block.data);
	if (!payload) return [];
	const type = typeof payload.type === "string" ? payload.type : block.event;
	const outputs: string[] = [];

	if (type === "message_start") {
		const message = payload.message as JsonObject | undefined;
		if (typeof message?.id === "string") state.id = `chatcmpl_${message.id}`;
		if (typeof message?.model === "string") state.model = message.model;
		if (message?.usage && typeof message.usage === "object") {
			state.usage = mergeAnthropicUsageToOpenAiUsage(
				state.usage,
				message.usage as JsonObject,
			);
		}
		outputs.push(openAiChatSseChunk(state, { role: "assistant" }));
		return outputs;
	}

	if (type === "content_block_start") {
		const index = Number(payload.index ?? 0);
		const blockValue = payload.content_block as JsonObject | undefined;
		if (blockValue?.type === "tool_use") {
			const toolIndex = state.nextToolIndex++;
			state.toolBlockIndexes.set(index, toolIndex);
			outputs.push(
				openAiChatSseChunk(state, {
					tool_calls: [
						{
							index: toolIndex,
							id:
								typeof blockValue.id === "string"
									? blockValue.id
									: `call_${cryptoId()}`,
							type: "function",
							function: {
								name:
									typeof blockValue.name === "string"
										? blockValue.name
										: "tool",
								arguments: "",
							},
						},
					],
				}),
			);
		} else if (
			blockValue?.type === "text" &&
			typeof blockValue.text === "string"
		) {
			outputs.push(openAiChatSseChunk(state, { content: blockValue.text }));
		} else if (
			blockValue?.type === "thinking" &&
			typeof blockValue.thinking === "string"
		) {
			outputs.push(
				openAiChatSseChunk(state, { reasoning_content: blockValue.thinking }),
			);
		}
		return outputs;
	}

	if (type === "content_block_delta") {
		const delta = payload.delta as JsonObject | undefined;
		const index = Number(payload.index ?? 0);
		if (delta?.type === "text_delta" && typeof delta.text === "string") {
			outputs.push(openAiChatSseChunk(state, { content: delta.text }));
		} else if (
			delta?.type === "thinking_delta" &&
			typeof delta.thinking === "string"
		) {
			outputs.push(
				openAiChatSseChunk(state, { reasoning_content: delta.thinking }),
			);
		} else if (
			delta?.type === "input_json_delta" &&
			typeof delta.partial_json === "string"
		) {
			outputs.push(
				openAiChatSseChunk(state, {
					tool_calls: [
						{
							index: state.toolBlockIndexes.get(index) ?? 0,
							function: { arguments: delta.partial_json },
						},
					],
				}),
			);
		}
		return outputs;
	}

	if (type === "message_delta") {
		if (payload.usage && typeof payload.usage === "object") {
			state.usage = mergeAnthropicUsageToOpenAiUsage(
				state.usage,
				payload.usage as JsonObject,
			);
		}
		const delta = payload.delta as JsonObject | undefined;
		if (typeof delta?.stop_reason === "string") {
			state.finishSent = true;
			outputs.push(
				openAiChatSseChunk(
					state,
					{},
					openAiFinishReasonFromAnthropic(delta.stop_reason),
					state.usage,
				),
			);
		}
		return outputs;
	}

	if (type === "message_stop") {
		if (!state.finishSent) {
			state.finishSent = true;
			outputs.push(openAiChatSseChunk(state, {}, "stop", state.usage));
		}
		state.doneSent = true;
		outputs.push("data: [DONE]\n\n");
	}

	return outputs;
}

function translateOpenAiSseBlockToAnthropic(
	block: SseBlock,
	state: OpenAiToAnthropicSseState,
): string[] {
	if (!block.data) return [];
	if (block.data === "[DONE]") {
		return state.messageStopSent
			? []
			: finishAnthropicStream(state, "end_turn");
	}
	const payload = parseSseJson(block.data);
	if (!payload) return [];
	const choice = Array.isArray(payload.choices)
		? (payload.choices[0] as JsonObject | undefined)
		: undefined;
	if (!choice) return [];

	const outputs = ensureAnthropicMessageStart(state, payload);
	const delta = (choice.delta as JsonObject | undefined) ?? {};
	if (typeof delta.content === "string" && delta.content) {
		closeAnthropicThinkingBlock(state, outputs);
		if (state.textBlockIndex === null) {
			state.textBlockIndex = state.nextBlockIndex++;
			outputs.push(
				anthropicSseEvent("content_block_start", {
					type: "content_block_start",
					index: state.textBlockIndex,
					content_block: { type: "text", text: "" },
				}),
			);
		}
		outputs.push(
			anthropicSseEvent("content_block_delta", {
				type: "content_block_delta",
				index: state.textBlockIndex,
				delta: { type: "text_delta", text: delta.content },
			}),
		);
	}

	const reasoning =
		typeof delta.reasoning_content === "string"
			? delta.reasoning_content
			: typeof delta.thinking === "string"
				? delta.thinking
				: "";
	if (reasoning) {
		closeAnthropicTextBlock(state, outputs);
		if (state.thinkingBlockIndex === null) {
			state.thinkingBlockIndex = state.nextBlockIndex++;
			outputs.push(
				anthropicSseEvent("content_block_start", {
					type: "content_block_start",
					index: state.thinkingBlockIndex,
					content_block: { type: "thinking", thinking: "" },
				}),
			);
		}
		outputs.push(
			anthropicSseEvent("content_block_delta", {
				type: "content_block_delta",
				index: state.thinkingBlockIndex,
				delta: { type: "thinking_delta", thinking: reasoning },
			}),
		);
	}

	if (Array.isArray(delta.tool_calls)) {
		closeAnthropicTextBlock(state, outputs);
		closeAnthropicThinkingBlock(state, outputs);
		for (const rawToolCall of delta.tool_calls) {
			if (!rawToolCall || typeof rawToolCall !== "object") continue;
			const toolCall = rawToolCall as JsonObject;
			const index = Number(toolCall.index ?? 0);
			const fn = toolCall.function as JsonObject | undefined;
			if (!state.toolBlocks.has(index)) {
				const blockIndex = state.nextBlockIndex++;
				state.toolBlocks.set(index, blockIndex);
				outputs.push(
					anthropicSseEvent("content_block_start", {
						type: "content_block_start",
						index: blockIndex,
						content_block: {
							type: "tool_use",
							id:
								typeof toolCall.id === "string"
									? toolCall.id
									: `call_${cryptoId()}`,
							name: typeof fn?.name === "string" ? fn.name : "tool",
							input: {},
						},
					}),
				);
			}
			if (typeof fn?.arguments === "string" && fn.arguments) {
				outputs.push(
					anthropicSseEvent("content_block_delta", {
						type: "content_block_delta",
						index: state.toolBlocks.get(index),
						delta: { type: "input_json_delta", partial_json: fn.arguments },
					}),
				);
			}
		}
	}

	if (payload.usage && typeof payload.usage === "object") {
		state.usage = openAiUsageToAnthropicUsage(payload.usage as JsonObject);
	}
	if (typeof choice.finish_reason === "string" && choice.finish_reason) {
		outputs.push(
			...finishAnthropicStream(
				state,
				anthropicStopReasonFromOpenAi(choice.finish_reason),
			),
		);
	}
	return outputs;
}

function ensureAnthropicMessageStart(
	state: OpenAiToAnthropicSseState,
	payload: JsonObject,
): string[] {
	if (state.messageStartSent) return [];
	state.messageStartSent = true;
	if (typeof payload.id === "string")
		state.id = payload.id.replace(/^chatcmpl[-_]?/, "msg_");
	if (typeof payload.model === "string") state.model = payload.model;
	return [
		anthropicSseEvent("message_start", {
			type: "message_start",
			message: {
				id: state.id,
				type: "message",
				role: "assistant",
				model: state.model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 0, output_tokens: 0 },
			},
		}),
	];
}

function finishAnthropicStream(
	state: OpenAiToAnthropicSseState,
	stopReason: string,
): string[] {
	if (state.messageStopSent) return [];
	const outputs: string[] = [];
	outputs.push(...ensureAnthropicMessageStart(state, {}));
	closeAnthropicTextBlock(state, outputs);
	closeAnthropicThinkingBlock(state, outputs);
	for (const blockIndex of state.toolBlocks.values()) {
		outputs.push(
			anthropicSseEvent("content_block_stop", {
				type: "content_block_stop",
				index: blockIndex,
			}),
		);
	}
	state.toolBlocks.clear();
	outputs.push(
		anthropicSseEvent("message_delta", {
			type: "message_delta",
			delta: { stop_reason: stopReason, stop_sequence: null },
			usage: state.usage ?? { input_tokens: 0, output_tokens: 0 },
		}),
	);
	outputs.push(anthropicSseEvent("message_stop", { type: "message_stop" }));
	state.messageStopSent = true;
	return outputs;
}

function closeAnthropicTextBlock(
	state: OpenAiToAnthropicSseState,
	outputs: string[],
): void {
	if (state.textBlockIndex === null) return;
	outputs.push(
		anthropicSseEvent("content_block_stop", {
			type: "content_block_stop",
			index: state.textBlockIndex,
		}),
	);
	state.textBlockIndex = null;
}

function closeAnthropicThinkingBlock(
	state: OpenAiToAnthropicSseState,
	outputs: string[],
): void {
	if (state.thinkingBlockIndex === null) return;
	outputs.push(
		anthropicSseEvent("content_block_stop", {
			type: "content_block_stop",
			index: state.thinkingBlockIndex,
		}),
	);
	state.thinkingBlockIndex = null;
}

function openAiChatSseChunk(
	state: AnthropicToOpenAiSseState,
	delta: JsonObject,
	finishReason: string | null = null,
	usage?: JsonObject,
): string {
	return `data: ${JSON.stringify({
		id: state.id,
		object: "chat.completion.chunk",
		created: state.created,
		model: state.model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(usage ? { usage } : {}),
	})}\n\n`;
}

function anthropicSseEvent(event: string, data: JsonObject): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseSseJson(value: string): JsonObject | null {
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" ? (parsed as JsonObject) : null;
	} catch {
		return null;
	}
}

function mergeAnthropicUsageToOpenAiUsage(
	existing: JsonObject | undefined,
	usage: JsonObject,
): JsonObject {
	const existingPrompt = Number(existing?.prompt_tokens ?? 0);
	const existingCompletion = Number(existing?.completion_tokens ?? 0);
	const input = Number(usage.input_tokens ?? existingPrompt);
	const output = Number(usage.output_tokens ?? existingCompletion);
	const promptTokens = Number.isFinite(input) ? input : 0;
	const completionTokens = Number.isFinite(output) ? output : 0;
	return {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		total_tokens: promptTokens + completionTokens,
	};
}

function openAiUsageToAnthropicUsage(usage: JsonObject): JsonObject {
	const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
	const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
	return {
		input_tokens: Number.isFinite(input) ? input : 0,
		output_tokens: Number.isFinite(output) ? output : 0,
	};
}

function openAiFinishReasonFromAnthropic(reason: string): string {
	if (reason === "tool_use") return "tool_calls";
	if (reason === "max_tokens") return "length";
	return "stop";
}

function anthropicStopReasonFromOpenAi(reason: string): string {
	if (reason === "tool_calls") return "tool_use";
	if (reason === "length") return "max_tokens";
	return "end_turn";
}

async function readJson(response: globalThis.Response): Promise<JsonObject> {
	const text = await response.text();
	try {
		return JSON.parse(text) as JsonObject;
	} catch {
		return {};
	}
}

function parseTokenSaverMode(value: unknown): RouterTokenSaverMode {
	if (
		typeof value === "string" &&
		TOKEN_SAVER_MODES.includes(value as RouterTokenSaverMode)
	) {
		return value as RouterTokenSaverMode;
	}
	return "rtk";
}

function extractCompressInput(body: unknown): string | null {
	if (!body || typeof body !== "object") return null;
	const input = body as { text?: unknown; input?: unknown };
	if (typeof input.text === "string") return input.text;
	if (typeof input.input === "string") return input.input;
	return null;
}

function getResolutionOptions(): RouterModelResolutionOptions {
	return {
		aliases: getRouterAliases(),
		customCombos: getRouterCustomCombos(),
		customModels: getRouterCustomModels(),
		disabledModels: getRouterDisabledModels(),
		providerNodes: getRouterProviderNodes(),
	};
}

function responsesInputToMessages(body: JsonObject): JsonObject[] {
	const messages: JsonObject[] = [];
	if (typeof body.instructions === "string") {
		messages.push({ role: "system", content: body.instructions });
	}

	if (typeof body.input === "string") {
		messages.push({ role: "user", content: body.input });
		return messages;
	}

	if (Array.isArray(body.input)) {
		for (const item of body.input) {
			if (!item || typeof item !== "object") continue;
			const value = item as JsonObject;
			messages.push({
				role: typeof value.role === "string" ? value.role : "user",
				content: extractContentText(value.content),
			});
		}
	}

	return messages.length > 0
		? messages
		: [{ role: "user", content: "Continue." }];
}

function anthropicMessagesToOpenAiMessages(body: JsonObject): JsonObject[] {
	const messages: JsonObject[] = [];
	if (typeof body.system === "string") {
		messages.push({ role: "system", content: body.system });
	} else if (Array.isArray(body.system)) {
		const systemText = extractContentText(body.system);
		if (systemText) messages.push({ role: "system", content: systemText });
	}

	if (Array.isArray(body.messages)) {
		for (const item of body.messages) {
			if (!item || typeof item !== "object") continue;
			const value = item as JsonObject;
			const role = typeof value.role === "string" ? value.role : "user";
			if (Array.isArray(value.content)) {
				const toolResults = value.content.filter(
					(part): part is JsonObject =>
						!!part &&
						typeof part === "object" &&
						(part as JsonObject).type === "tool_result",
				);
				if (toolResults.length > 0) {
					for (const toolResult of toolResults) {
						messages.push({
							role: "tool",
							tool_call_id:
								typeof toolResult.tool_use_id === "string"
									? toolResult.tool_use_id
									: `call_${cryptoId()}`,
							content: extractContentText(toolResult.content),
						});
					}
					continue;
				}
			}

			const message = anthropicMessageToOpenAiMessage(role, value.content);
			if (message) messages.push(message);
		}
	}

	return messages.length > 0
		? messages
		: [{ role: "user", content: "Continue." }];
}

function anthropicMessageToOpenAiMessage(
	role: string,
	content: unknown,
): JsonObject | null {
	if (!Array.isArray(content)) {
		return {
			role: role === "assistant" ? "assistant" : "user",
			content: extractContentText(content),
		};
	}

	const openAiContent: JsonObject[] = [];
	const toolCalls: JsonObject[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const value = part as JsonObject;
		if (value.type === "tool_use") {
			toolCalls.push({
				id: typeof value.id === "string" ? value.id : `call_${cryptoId()}`,
				type: "function",
				function: {
					name: typeof value.name === "string" ? value.name : "tool",
					arguments: JSON.stringify(value.input ?? {}),
				},
			});
			continue;
		}
		const openAiPart = anthropicContentPartToOpenAi(value);
		if (openAiPart) openAiContent.push(openAiPart);
	}

	if (role === "assistant") {
		return {
			role: "assistant",
			content: extractContentText(openAiContent),
			...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
		};
	}

	return {
		role: "user",
		content:
			openAiContent.length === 1 && openAiContent[0]?.type === "text"
				? openAiContent[0].text
				: openAiContent,
	};
}

function anthropicContentPartToOpenAi(part: JsonObject): JsonObject | null {
	if (part.type === "text" && typeof part.text === "string") {
		return { type: "text", text: part.text };
	}
	if (part.type === "image") {
		const source = part.source as JsonObject | undefined;
		const url = anthropicSourceToOpenAiUrl(source);
		return url ? { type: "image_url", image_url: { url } } : null;
	}
	return null;
}

function anthropicSourceToOpenAiUrl(
	source: JsonObject | undefined,
): string | null {
	if (!source) return null;
	if (source.type === "url" && typeof source.url === "string")
		return source.url;
	if (
		source.type === "base64" &&
		typeof source.media_type === "string" &&
		typeof source.data === "string"
	) {
		return `data:${source.media_type};base64,${source.data}`;
	}
	return null;
}

function parseJsonObject(value: unknown): JsonObject {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as JsonObject;
	}
	if (typeof value !== "string" || !value.trim()) return {};
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as JsonObject)
			: {};
	} catch {
		return {};
	}
}

function parseDataUri(
	value: unknown,
): { mimeType: string; base64: string } | null {
	if (typeof value !== "string") return null;
	const match = /^data:([^;,]+);base64,(.+)$/i.exec(value);
	if (!match) return null;
	return { mimeType: match[1], base64: match[2] };
}

function extractContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object") {
				const value = part as JsonObject;
				if (typeof value.text === "string") return value.text;
				if (typeof value.content === "string") return value.content;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function extractAssistantText(upstream: JsonObject): string {
	const choices = upstream.choices;
	if (!Array.isArray(choices)) return "";
	const first = choices[0] as JsonObject | undefined;
	const message = first?.message as JsonObject | undefined;
	const content = message?.content;
	return typeof content === "string" ? content : extractContentText(content);
}

function extractStopReason(upstream: JsonObject): string | null {
	const choices = upstream.choices;
	if (!Array.isArray(choices)) return null;
	const first = choices[0] as JsonObject | undefined;
	return typeof first?.finish_reason === "string" ? first.finish_reason : null;
}

function extractOpenAIUsage(upstream: JsonObject) {
	const usage = upstream.usage as JsonObject | undefined;
	const promptTokens = Number(usage?.prompt_tokens ?? 0);
	const completionTokens = Number(usage?.completion_tokens ?? 0);
	const totalTokens = Number(
		usage?.total_tokens ?? promptTokens + completionTokens,
	);
	return {
		prompt_tokens: Number.isFinite(promptTokens) ? promptTokens : 0,
		completion_tokens: Number.isFinite(completionTokens) ? completionTokens : 0,
		total_tokens: Number.isFinite(totalTokens) ? totalTokens : 0,
	};
}

function extractSearchQuery(body: JsonObject): string | null {
	if (typeof body.query === "string") return body.query;
	if (typeof body.q === "string") return body.q;
	if (Array.isArray(body.messages)) {
		const last = body.messages.at(-1);
		if (last && typeof last === "object") {
			return extractContentText((last as JsonObject).content);
		}
	}
	return null;
}

function toJsonObject(value: unknown): JsonObject {
	return value && typeof value === "object" ? (value as JsonObject) : {};
}

function setUsageLocals(
	res: ExpressResponse,
	{
		account,
		model,
		provider,
	}: {
		account?: RouterProviderCredential;
		model: string;
		provider: RouterProviderKeyId | "router" | "search";
	},
) {
	res.locals.routerProvider = provider;
	res.locals.routerModel = model;
	if (account) {
		res.locals.routerAccountId = account.id;
		res.locals.routerAccountName = account.name;
	}
}

function attachUsageLogger(
	req: Request,
	res: ExpressResponse,
	next: () => void,
) {
	const startedAtMs = Date.now();
	res.on("finish", () => {
		if (!shouldRecordUsage(req)) return;
		try {
			recordRouterUsage({
				endpoint: req.path,
				method: req.method,
				provider:
					typeof res.locals.routerProvider === "string"
						? res.locals.routerProvider
						: inferProviderForRequest(req.path),
				model:
					typeof res.locals.routerModel === "string"
						? res.locals.routerModel
						: inferModelForRequest(req.path, req.body),
				accountId:
					typeof res.locals.routerAccountId === "string"
						? res.locals.routerAccountId
						: null,
				accountName:
					typeof res.locals.routerAccountName === "string"
						? res.locals.routerAccountName
						: null,
				status: res.statusCode,
				success: res.statusCode < 400,
				durationMs: Date.now() - startedAtMs,
				requestTokens: estimateRequestTokens(req.body),
				responseTokens: 0,
				error: res.statusCode >= 400 ? res.statusMessage : null,
			});
		} catch (error) {
			console.error("[agent-router-gateway] Failed to record usage:", error);
		}
	});
	next();
}

function shouldRecordUsage(req: Request): boolean {
	return req.method === "POST" && req.path.startsWith("/v1/");
}

function estimateRequestTokens(body: unknown): number {
	if (Buffer.isBuffer(body)) return Math.ceil(body.byteLength / 4);
	return estimateTokens(body);
}

function inferModelForRequest(path: string, body: unknown): string {
	if (body && typeof body === "object") {
		const model = (body as JsonObject).model;
		if (typeof model === "string") return model;
	}
	if (path === "/v1/compress") return "token-saver";
	if (path === "/v1/search") return "search";
	if (path === "/v1/web/fetch") return "web-fetch";
	return "unknown";
}

function inferProviderForRequest(path: string): string {
	if (
		path.startsWith("/v1/audio/") ||
		path === "/v1/embeddings" ||
		path === "/v1/images/generations"
	) {
		return "openai";
	}
	if (path === "/v1/search") return "search";
	if (path === "/v1/web/fetch" || path === "/v1/compress") return "router";
	return "openrouter";
}

function cryptoId(): string {
	return Math.random().toString(36).slice(2, 12);
}

function listen(
	app: ReturnType<typeof createAgentRouterGatewayApp>,
	port: number,
) {
	return new Promise<Server>((resolve, reject) => {
		const candidate = createServer(app);
		candidate.once("error", reject);
		candidate.listen(port, GATEWAY_HOST, () => {
			candidate.off("error", reject);
			resolve(candidate);
		});
	});
}
