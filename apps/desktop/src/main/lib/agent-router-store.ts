import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	AGENT_ROUTER_PROFILES,
	type AgentPricing,
} from "@superset/shared/agent-router";
import type {
	RouterCustomCombo,
	RouterCustomModel,
	RouterDisabledModel,
	RouterModelAlias,
	RouterModelAvailabilityEntry,
	RouterModelKind,
	RouterPricingRate,
	RouterPricingTable,
	RouterProviderAccount,
	RouterProviderAccountAuthType,
	RouterProviderKeyId,
	RouterProviderNode,
	RouterProviderNodeApiType,
	RouterProviderNodeType,
	RouterProxyPool,
	RouterProxyPoolTestStatus,
	RouterProxyPoolType,
} from "@superset/shared/router-control-plane";
import { ROUTER_PROVIDER_KEY_IDS } from "@superset/shared/router-control-plane";
import { app } from "electron";

const MAX_USAGE_ENTRIES = 2000;
const MAX_AVAILABILITY_ENTRIES = 500;
const PROTECTED_ROUTER_SETTING_KEYS = new Set([
	"password",
	"newPassword",
	"currentPassword",
	"oidcClientSecret",
	"mitmSudoEncrypted",
]);

const DEFAULT_ROUTER_GATEWAY_SETTINGS: RouterGatewaySettings = {
	authMode: "none",
	cavemanEnabled: false,
	cavemanLevel: "full",
	cloudEnabled: false,
	comboStickyRoundRobinLimit: 1,
	comboStrategies: {},
	comboStrategy: "fallback",
	dnsToolEnabled: {},
	enableObservability: true,
	headroomCompressUserMessages: false,
	headroomEnabled: false,
	headroomUrl: "http://localhost:8787",
	mitmRouterBaseUrl: "http://localhost:20128",
	observabilityBatchSize: 20,
	observabilityFlushIntervalMs: 5000,
	observabilityMaxJsonSize: 5,
	observabilityMaxRecords: 1000,
	outboundNoProxy: "",
	outboundProxyEnabled: false,
	outboundProxyUrl: "",
	ponytailEnabled: false,
	ponytailLevel: "full",
	providerStrategies: {},
	requireLogin: false,
	rtkEnabled: true,
	stickyRoundRobinLimit: 3,
	tailscaleEnabled: false,
	tailscaleUrl: "",
	tunnelDashboardAccess: true,
	tunnelEnabled: false,
	tunnelProvider: "cloudflare",
	tunnelUrl: "",
};

export interface RouterUsageRecordInput {
	endpoint: string;
	method: string;
	provider?: string | null;
	model?: string | null;
	accountId?: string | null;
	accountName?: string | null;
	status: number;
	success: boolean;
	durationMs: number;
	requestTokens?: number;
	responseTokens?: number;
	error?: string | null;
}

export interface RouterUsageEntry {
	id: string;
	timestamp: string;
	endpoint: string;
	method: string;
	provider: string;
	model: string;
	accountId: string | null;
	accountName: string | null;
	status: number;
	success: boolean;
	durationMs: number;
	requestTokens: number;
	responseTokens: number;
	error: string | null;
	totalTokens: number;
	estimatedCostUsd: number;
}

export interface RouterUsageStats {
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	totalTokens: number;
	estimatedCostUsd: number;
	byProvider: Array<{
		provider: string;
		requests: number;
		totalTokens: number;
		estimatedCostUsd: number;
	}>;
	recentRequests: RouterUsageEntry[];
}

export type RouterUsagePeriod = "today" | "24h" | "7d" | "30d" | "60d" | "all";

export interface RouterUsageCompatStats {
	totalRequests: number;
	totalPromptTokens: number;
	totalCompletionTokens: number;
	totalCachedTokens: number;
	totalCost: number;
	byProvider: Record<string, RouterUsageCompatBucket>;
	byModel: Record<string, RouterUsageCompatBucket>;
	byAccount: Record<string, RouterUsageCompatBucket>;
	byApiKey: Record<string, RouterUsageCompatBucket>;
	byEndpoint: Record<string, RouterUsageCompatBucket>;
	last10Minutes: RouterUsageMinuteBucket[];
	pending: {
		byAccount: Record<string, Record<string, number>>;
	};
	activeRequests: Array<{
		account: string;
		count: number;
		model: string;
		provider: string;
	}>;
	recentRequests: RouterUsageCompatRecentRequest[];
	errorProvider: string;
}

export interface RouterUsageCompatBucket {
	requests: number;
	promptTokens: number;
	completionTokens: number;
	cachedTokens: number;
	cost: number;
	rawModel?: string;
	provider?: string;
	connectionId?: string | null;
	accountName?: string | null;
	endpoint?: string;
	lastUsed?: string;
}

export interface RouterUsageCompatRecentRequest {
	timestamp: string;
	model: string;
	provider: string;
	promptTokens: number;
	completionTokens: number;
	cachedTokens: number;
	status: string;
}

export interface RouterUsageMinuteBucket {
	requests: number;
	promptTokens: number;
	completionTokens: number;
	cost: number;
}

export interface RouterUsageChartBucket {
	label: string;
	tokens: number;
	cost: number;
}

export interface RouterUsageRequestDetailsFilter {
	connectionId?: string | null;
	endDate?: string | null;
	model?: string | null;
	page?: number;
	pageSize?: number;
	provider?: string | null;
	startDate?: string | null;
	status?: string | null;
}

export interface RouterUsageRequestDetail {
	id: string;
	timestamp: string;
	provider: string;
	model: string;
	connectionId: string | null;
	accountName: string | null;
	apiKeyMasked: string | null;
	endpoint: string;
	method: string;
	status: string;
	statusCode: number;
	success: boolean;
	durationMs: number;
	cost: number;
	error: string | null;
	tokens: {
		prompt_tokens: number;
		completion_tokens: number;
		cached_tokens: number;
		total_tokens: number;
	};
}

export interface RouterUsageRequestDetailsResult {
	details: RouterUsageRequestDetail[];
	pagination: {
		page: number;
		pageSize: number;
		totalItems: number;
		totalPages: number;
		hasNext: boolean;
		hasPrev: boolean;
	};
}

export interface RouterConnectionUsageSummary {
	connectionId: string;
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	totalPromptTokens: number;
	totalCompletionTokens: number;
	totalCachedTokens: number;
	totalTokens: number;
	totalCost: number;
	lastUsed: string | null;
	recentRequests: RouterUsageRequestDetail[];
}

export interface RouterStoreSnapshot {
	aliases: RouterModelAlias[];
	apiKeys: RouterGatewayApiKey[];
	customCombos: RouterCustomCombo[];
	customModels: RouterCustomModel[];
	disabledModels: RouterDisabledModel[];
	mitmAliases: Record<string, Record<string, string>>;
	modelAvailability: RouterModelAvailabilityEntry[];
	pricing: RouterPricingTable;
	proxyPools: RouterProxyPool[];
	providerAccounts: RouterProviderAccount[];
	providerNodes: RouterProviderNode[];
	settings: RouterGatewaySettings;
	usage: RouterUsageEntry[];
}

interface RouterStoreFile {
	aliases: RouterModelAlias[];
	apiKeys: RouterGatewayApiKey[];
	customCombos: RouterCustomCombo[];
	customModels: RouterCustomModel[];
	disabledModels: RouterDisabledModel[];
	mitmAliases: Record<string, Record<string, string>>;
	modelAvailability: RouterModelAvailabilityEntry[];
	pricing: RouterPricingTable;
	proxyPools: RouterProxyPool[];
	providerAccounts: RouterProviderAccount[];
	providerNodes: RouterProviderNode[];
	settings: RouterGatewaySettings;
	accountCursor: Partial<Record<RouterProviderKeyId, number>>;
	usage: RouterUsageEntry[];
}

export interface RouterGatewayApiKey {
	id: string;
	keyHash: string;
	keyPreview: string;
	name: string;
	machineId: string;
	isActive: boolean;
	createdAt: string;
	updatedAt: string;
	lastUsedAt: string | null;
}

export interface RouterGatewayApiKeyCreated extends RouterGatewayApiKey {
	key: string;
}

export interface RouterGatewaySettings {
	[key: string]: unknown;
	authMode: string;
	cavemanEnabled: boolean;
	cavemanLevel: string;
	cloudEnabled: boolean;
	comboStickyRoundRobinLimit: number;
	comboStrategies: Record<string, unknown>;
	comboStrategy: string;
	dnsToolEnabled: Record<string, unknown>;
	enableObservability: boolean;
	headroomCompressUserMessages: boolean;
	headroomEnabled: boolean;
	headroomUrl: string;
	mitmRouterBaseUrl: string;
	observabilityBatchSize: number;
	observabilityFlushIntervalMs: number;
	observabilityMaxJsonSize: number;
	observabilityMaxRecords: number;
	outboundNoProxy: string;
	outboundProxyEnabled: boolean;
	outboundProxyUrl: string;
	ponytailEnabled: boolean;
	ponytailLevel: string;
	providerStrategies: Record<string, unknown>;
	requireLogin: boolean;
	rtkEnabled: boolean;
	stickyRoundRobinLimit: number;
	tailscaleEnabled: boolean;
	tailscaleUrl: string;
	tunnelDashboardAccess: boolean;
	tunnelEnabled: boolean;
	tunnelProvider: string;
	tunnelUrl: string;
}

export function getRouterStoreSnapshot(): RouterStoreSnapshot {
	const data = readStore();
	return {
		aliases: data.aliases,
		apiKeys: data.apiKeys,
		customCombos: data.customCombos,
		customModels: data.customModels,
		disabledModels: data.disabledModels,
		mitmAliases: data.mitmAliases,
		modelAvailability: data.modelAvailability,
		pricing: getRouterPricing(data.pricing),
		proxyPools: getRouterProxyPools(undefined, data.proxyPools),
		providerAccounts: data.providerAccounts,
		providerNodes: data.providerNodes,
		settings: data.settings,
		usage: data.usage,
	};
}

export function getRouterAliases(): RouterModelAlias[] {
	return readStore().aliases;
}

export function upsertRouterAlias(alias: RouterModelAlias): RouterModelAlias[] {
	const normalized = normalizeAlias(alias);
	const data = readStore();
	const next = [
		...data.aliases.filter((entry) => entry.alias !== normalized.alias),
		normalized,
	].sort((a, b) => a.alias.localeCompare(b.alias));
	writeStore({ ...data, aliases: next });
	return next;
}

export function deleteRouterAlias(alias: string): RouterModelAlias[] {
	const data = readStore();
	const next = data.aliases.filter((entry) => entry.alias !== alias);
	writeStore({ ...data, aliases: next });
	return next;
}

export function getRouterMitmAliases(
	tool?: string | null,
): Record<string, Record<string, string>> | Record<string, string> {
	const aliases = readStore().mitmAliases;
	const toolName = tool?.trim();
	return toolName ? (aliases[toolName] ?? {}) : aliases;
}

export function setRouterMitmAliases(
	tool: string,
	mappings: Record<string, string>,
): Record<string, string> {
	const toolName = tool.trim();
	if (!toolName) throw new Error("tool is required");
	const filtered = normalizeStringMap(mappings);
	const data = readStore();
	writeStore({
		...data,
		mitmAliases: {
			...data.mitmAliases,
			[toolName]: filtered,
		},
	});
	return filtered;
}

export function getRouterApiKeys(): RouterGatewayApiKey[] {
	return readStore().apiKeys;
}

export function getRouterApiKeyById(id: string): RouterGatewayApiKey | null {
	return readStore().apiKeys.find((key) => key.id === id) ?? null;
}

export function createRouterApiKey(name: string): RouterGatewayApiKeyCreated {
	const trimmedName = name.trim();
	if (!trimmedName) throw new Error("Name is required");
	const key = `ade_9r_${randomBytes(24).toString("hex")}`;
	const now = new Date().toISOString();
	const apiKey: RouterGatewayApiKey = {
		id: randomUUID(),
		keyHash: hashRouterApiKey(key),
		keyPreview: previewRouterApiKey(key),
		name: trimmedName,
		machineId: getRouterMachineId(),
		isActive: true,
		createdAt: now,
		updatedAt: now,
		lastUsedAt: null,
	};
	const data = readStore();
	writeStore({
		...data,
		apiKeys: sortRouterApiKeys([...data.apiKeys, apiKey]),
	});
	return { ...apiKey, key };
}

export function updateRouterApiKey(
	id: string,
	updates: Partial<Pick<RouterGatewayApiKey, "isActive" | "name">>,
): RouterGatewayApiKey | null {
	const data = readStore();
	let updated: RouterGatewayApiKey | null = null;
	const next = data.apiKeys.map((apiKey) => {
		if (apiKey.id !== id) return apiKey;
		updated = {
			...apiKey,
			isActive:
				typeof updates.isActive === "boolean"
					? updates.isActive
					: apiKey.isActive,
			name: updates.name?.trim() || apiKey.name,
			updatedAt: new Date().toISOString(),
		};
		return updated;
	});
	if (!updated) return null;
	writeStore({ ...data, apiKeys: sortRouterApiKeys(next) });
	return updated;
}

export function deleteRouterApiKey(id: string): boolean {
	const data = readStore();
	const next = data.apiKeys.filter((apiKey) => apiKey.id !== id);
	if (next.length === data.apiKeys.length) return false;
	writeStore({ ...data, apiKeys: next });
	return true;
}

export function validateRouterApiKey(key: string): boolean {
	const hash = hashRouterApiKey(key);
	const match = readStore().apiKeys.find((apiKey) => apiKey.keyHash === hash);
	if (!match?.isActive) return false;
	const data = readStore();
	writeStore({
		...data,
		apiKeys: data.apiKeys.map((apiKey) =>
			apiKey.id === match.id
				? { ...apiKey, lastUsedAt: new Date().toISOString() }
				: apiKey,
		),
	});
	return true;
}

export function getRouterSettings(): RouterGatewaySettings {
	return readStore().settings;
}

export function updateRouterSettings(
	updates: Record<string, unknown>,
): RouterGatewaySettings {
	const data = readStore();
	const safeUpdates = Object.fromEntries(
		Object.entries(updates).filter(
			([key, value]) =>
				!PROTECTED_ROUTER_SETTING_KEYS.has(key) && value !== undefined,
		),
	);
	const settings = normalizeRouterSettings({
		...data.settings,
		...safeUpdates,
	});
	writeStore({ ...data, settings });
	return settings;
}

export function getRouterDefaultPricing(): RouterPricingTable {
	const pricing: RouterPricingTable = {};
	for (const profile of Object.values(AGENT_ROUTER_PROFILES)) {
		if (!profile.pricing) continue;
		const provider = profile.provider.startsWith("OpenRouter/")
			? "openrouter"
			: profile.provider.toLowerCase();
		pricing[provider] = {
			...(pricing[provider] ?? {}),
			[profile.modelId]: {
				input: profile.pricing.inputPerMillion,
				output: profile.pricing.outputPerMillion,
			},
			[profile.agent]: {
				input: profile.pricing.inputPerMillion,
				output: profile.pricing.outputPerMillion,
			},
		};
	}
	return pricing;
}

export function getRouterPricing(
	overrides: RouterPricingTable = readStore().pricing,
): RouterPricingTable {
	return mergePricingTables(getRouterDefaultPricing(), overrides);
}

export function updateRouterPricing(
	updates: RouterPricingTable,
): RouterPricingTable {
	const data = readStore();
	writeStore({
		...data,
		pricing: mergePricingTables(data.pricing, normalizePricingTable(updates)),
	});
	return getRouterPricing();
}

export function resetRouterPricing({
	model,
	provider,
}: {
	model?: string | null;
	provider?: string | null;
} = {}): RouterPricingTable {
	const data = readStore();
	const next = clonePricingTable(data.pricing);
	const providerId = provider?.trim();
	const modelId = model?.trim();

	if (providerId && modelId) {
		delete next[providerId]?.[modelId];
		if (next[providerId] && Object.keys(next[providerId]).length === 0) {
			delete next[providerId];
		}
	} else if (providerId) {
		delete next[providerId];
	} else {
		for (const key of Object.keys(next)) delete next[key];
	}

	writeStore({ ...data, pricing: next });
	return getRouterPricing();
}

export function getRouterProxyPools(
	filter: { isActive?: boolean; testStatus?: RouterProxyPoolTestStatus } = {},
	source = readStore().proxyPools,
): RouterProxyPool[] {
	return sortProxyPools(
		source
			.filter((pool) =>
				filter.isActive === undefined
					? true
					: pool.isActive === filter.isActive,
			)
			.filter((pool) =>
				filter.testStatus ? pool.testStatus === filter.testStatus : true,
			),
	);
}

export function getRouterProxyPoolById(id: string): RouterProxyPool | null {
	return readStore().proxyPools.find((pool) => pool.id === id) ?? null;
}

export function createRouterProxyPool(
	input: Omit<Partial<RouterProxyPool>, "createdAt" | "updatedAt"> & {
		name?: string;
		proxyUrl?: string;
	},
): RouterProxyPool {
	const data = readStore();
	const now = new Date().toISOString();
	const pool = normalizeProxyPool({
		id: input.id ?? randomUUID(),
		name: input.name ?? "",
		proxyUrl: input.proxyUrl ?? "",
		noProxy: input.noProxy ?? "",
		type: normalizeProxyPoolType(input.type),
		isActive: input.isActive ?? true,
		strictProxy: input.strictProxy === true,
		testStatus: normalizeProxyPoolTestStatus(input.testStatus),
		lastTestedAt: input.lastTestedAt ?? null,
		lastError: input.lastError ?? null,
		createdAt: now,
		updatedAt: now,
	});
	writeStore({
		...data,
		proxyPools: sortProxyPools([...data.proxyPools, pool]),
	});
	return pool;
}

export function updateRouterProxyPool(
	id: string,
	updates: Partial<
		Pick<
			RouterProxyPool,
			| "isActive"
			| "lastError"
			| "lastTestedAt"
			| "name"
			| "noProxy"
			| "proxyUrl"
			| "strictProxy"
			| "testStatus"
			| "type"
		>
	>,
): RouterProxyPool | null {
	const data = readStore();
	let updated: RouterProxyPool | null = null;
	const next = data.proxyPools.map((pool) => {
		if (pool.id !== id) return pool;
		updated = normalizeProxyPool({
			...pool,
			...removeUndefinedValues(updates),
			updatedAt: new Date().toISOString(),
		});
		return updated;
	});
	if (!updated) return null;
	writeStore({ ...data, proxyPools: sortProxyPools(next) });
	return updated;
}

export function deleteRouterProxyPool(id: string): RouterProxyPool | null {
	const data = readStore();
	const deleted = data.proxyPools.find((pool) => pool.id === id) ?? null;
	if (!deleted) return null;
	writeStore({
		...data,
		proxyPools: data.proxyPools.filter((pool) => pool.id !== id),
	});
	return deleted;
}

export function getRouterCustomCombos(): RouterCustomCombo[] {
	return readStore().customCombos;
}

export function upsertRouterCustomCombo(
	combo: RouterCustomCombo,
): RouterCustomCombo[] {
	const normalized = normalizeCustomCombo(combo);
	const data = readStore();
	const next = [
		...data.customCombos.filter((entry) => entry.name !== normalized.name),
		normalized,
	].sort((a, b) => a.name.localeCompare(b.name));
	writeStore({ ...data, customCombos: next });
	return next;
}

export function deleteRouterCustomCombo(name: string): RouterCustomCombo[] {
	const data = readStore();
	const next = data.customCombos.filter((entry) => entry.name !== name);
	writeStore({ ...data, customCombos: next });
	return next;
}

export function getRouterCustomModels(): RouterCustomModel[] {
	return sortCustomModels(readStore().customModels);
}

export function upsertRouterCustomModel(
	model: Partial<RouterCustomModel> & {
		id?: string;
		providerAlias?: string;
		type?: RouterModelKind;
	},
): { added: boolean; models: RouterCustomModel[] } {
	const data = readStore();
	const providerAlias = model.providerAlias?.trim() ?? "";
	const id = normalizeModelIdForProvider(providerAlias, model.id ?? "");
	const type = normalizeModelKind(model.type);
	const existing = data.customModels.find(
		(entry) =>
			entry.providerAlias === providerAlias &&
			entry.id === id &&
			entry.type === type,
	);
	const normalized = normalizeCustomModel(
		{
			...model,
			id,
			providerAlias,
			type,
		},
		existing,
	);
	if (!normalized) throw new Error("providerAlias and id are required");
	const next = [
		...data.customModels.filter(
			(entry) =>
				!(
					entry.providerAlias === normalized.providerAlias &&
					entry.id === normalized.id &&
					entry.type === normalized.type
				),
		),
		normalized,
	];
	writeStore({ ...data, customModels: sortCustomModels(next) });
	return { added: !existing, models: getRouterCustomModels() };
}

export function deleteRouterCustomModel({
	id,
	providerAlias,
	type = "llm",
}: {
	id: string;
	providerAlias: string;
	type?: RouterModelKind;
}): RouterCustomModel[] {
	const provider = providerAlias.trim();
	const normalizedId = normalizeModelIdForProvider(provider, id);
	const data = readStore();
	const next = data.customModels.filter(
		(entry) =>
			!(
				entry.providerAlias === provider &&
				entry.id === normalizedId &&
				entry.type === type
			),
	);
	writeStore({ ...data, customModels: sortCustomModels(next) });
	return getRouterCustomModels();
}

export function getRouterDisabledModels(
	providerAlias?: string,
): RouterDisabledModel[] {
	const disabled = readStore().disabledModels;
	return sortDisabledModels(
		providerAlias
			? disabled.filter((entry) => entry.providerAlias === providerAlias)
			: disabled,
	);
}

export function getRouterDisabledModelMap(): Record<string, string[]> {
	const disabled: Record<string, string[]> = {};
	for (const entry of getRouterDisabledModels()) {
		disabled[entry.providerAlias] = [
			...(disabled[entry.providerAlias] ?? []),
			entry.id,
		];
	}
	return disabled;
}

export function disableRouterModels({
	ids,
	providerAlias,
	reason,
}: {
	ids: string[];
	providerAlias: string;
	reason?: string | null;
}): RouterDisabledModel[] {
	const provider = providerAlias.trim();
	const modelIds = Array.from(
		new Set(
			ids
				.map((id) => normalizeModelIdForProvider(provider, id))
				.filter(Boolean),
		),
	);
	if (!provider || modelIds.length === 0) {
		throw new Error("providerAlias and ids are required");
	}

	const data = readStore();
	const now = new Date().toISOString();
	const next = [...data.disabledModels];
	for (const id of modelIds) {
		const index = next.findIndex(
			(entry) => entry.providerAlias === provider && entry.id === id,
		);
		if (index >= 0) {
			next[index] = {
				...next[index],
				reason: reason?.trim() || next[index].reason,
			};
			continue;
		}
		next.push({
			providerAlias: provider,
			id,
			reason: reason?.trim() || null,
			disabledAt: now,
		});
	}

	writeStore({ ...data, disabledModels: sortDisabledModels(next) });
	return getRouterDisabledModels();
}

export function enableRouterModels({
	ids,
	providerAlias,
}: {
	ids?: string[];
	providerAlias: string;
}): RouterDisabledModel[] {
	const provider = providerAlias.trim();
	if (!provider) throw new Error("providerAlias is required");
	const data = readStore();
	const normalizedIds = new Set(
		(ids ?? [])
			.map((id) => normalizeModelIdForProvider(provider, id))
			.filter(Boolean),
	);
	const removeAll = normalizedIds.size === 0;
	const next = data.disabledModels.filter((entry) => {
		if (entry.providerAlias !== provider) return true;
		return !removeAll && !normalizedIds.has(entry.id);
	});
	writeStore({ ...data, disabledModels: sortDisabledModels(next) });
	return getRouterDisabledModels();
}

export function isRouterModelDisabled(
	providerAlias: string,
	modelId: string,
): boolean {
	const provider = providerAlias.trim();
	const id = normalizeModelIdForProvider(provider, modelId);
	return readStore().disabledModels.some(
		(entry) => entry.providerAlias === provider && entry.id === id,
	);
}

export function getRouterModelAvailability(
	limit = 100,
): RouterModelAvailabilityEntry[] {
	return readStore().modelAvailability.slice(0, Math.max(0, limit));
}

export function recordRouterModelAvailability(
	input: Omit<RouterModelAvailabilityEntry, "id" | "checkedAt"> &
		Partial<Pick<RouterModelAvailabilityEntry, "checkedAt" | "id">>,
): RouterModelAvailabilityEntry {
	const data = readStore();
	const entry = normalizeAvailabilityEntry(input);
	writeStore({
		...data,
		modelAvailability: [entry, ...data.modelAvailability].slice(
			0,
			MAX_AVAILABILITY_ENTRIES,
		),
	});
	return entry;
}

export function getRouterProviderNodes(
	type?: RouterProviderNodeType,
): RouterProviderNode[] {
	const nodes = readStore().providerNodes;
	return sortProviderNodes(
		type ? nodes.filter((node) => node.type === type) : nodes,
	);
}

export function createRouterProviderNode(
	node: Omit<Partial<RouterProviderNode>, "id" | "createdAt" | "updatedAt"> & {
		baseUrl?: string;
		name?: string;
		prefix?: string;
		type?: RouterProviderNodeType;
	},
): RouterProviderNode {
	const data = readStore();
	const now = new Date().toISOString();
	const type = node.type ?? "openai-compatible";
	const normalized = normalizeProviderNode({
		id: providerNodeId(type, node.apiType),
		type,
		name: node.name ?? "",
		prefix: node.prefix ?? "",
		baseUrl: node.baseUrl ?? defaultProviderNodeBaseUrl(type),
		apiType: node.apiType,
		apiKeyProvider: node.apiKeyProvider,
		apiKeyAccountId: node.apiKeyAccountId,
		models: node.models ?? [],
		isActive: node.isActive ?? true,
		createdAt: now,
		updatedAt: now,
	});
	writeStore({
		...data,
		providerNodes: sortProviderNodes([...data.providerNodes, normalized]),
	});
	return normalized;
}

export function updateRouterProviderNode(
	id: string,
	updates: Partial<
		Pick<
			RouterProviderNode,
			| "apiKeyAccountId"
			| "apiKeyProvider"
			| "apiType"
			| "baseUrl"
			| "isActive"
			| "models"
			| "name"
			| "prefix"
			| "type"
		>
	>,
): RouterProviderNode[] {
	const data = readStore();
	const sanitizedUpdates = removeUndefinedValues(updates);
	let found = false;
	const next = data.providerNodes.map((node) => {
		if (node.id !== id) return node;
		found = true;
		return normalizeProviderNode({
			...node,
			...sanitizedUpdates,
			updatedAt: new Date().toISOString(),
		});
	});
	if (!found) throw new Error("Provider node not found");
	writeStore({ ...data, providerNodes: sortProviderNodes(next) });
	return getRouterProviderNodes();
}

export function deleteRouterProviderNode(id: string): RouterProviderNode[] {
	const data = readStore();
	writeStore({
		...data,
		providerNodes: data.providerNodes.filter((node) => node.id !== id),
	});
	return getRouterProviderNodes();
}

export function getRouterProviderAccounts(
	provider?: RouterProviderKeyId,
): RouterProviderAccount[] {
	const accounts = readStore().providerAccounts;
	return sortAccounts(
		provider
			? accounts.filter((account) => account.provider === provider)
			: accounts,
	);
}

export function createRouterProviderAccountMetadata({
	authType = "api-key",
	email = null,
	expiresAt = null,
	name,
	provider,
	providerSpecificData = {},
}: {
	authType?: RouterProviderAccountAuthType;
	email?: string | null;
	expiresAt?: string | null;
	name?: string;
	provider: RouterProviderKeyId;
	providerSpecificData?: Record<string, unknown>;
}): RouterProviderAccount {
	const data = readStore();
	const providerAccounts = data.providerAccounts.filter(
		(account) => account.provider === provider,
	);
	const now = new Date().toISOString();
	const account: RouterProviderAccount = {
		id: randomUUID(),
		provider,
		name: name?.trim() || `${provider} account ${providerAccounts.length + 1}`,
		authType,
		email,
		expiresAt,
		providerSpecificData,
		priority:
			providerAccounts.reduce(
				(max, candidate) => Math.max(max, candidate.priority),
				0,
			) + 1,
		isActive: true,
		createdAt: now,
		updatedAt: now,
		lastUsedAt: null,
		consecutiveUseCount: 0,
		requestCount: 0,
		failureCount: 0,
		backoffLevel: 0,
		rateLimitedUntil: null,
		lastError: null,
	};
	writeStore({
		...data,
		providerAccounts: sortAccounts([...data.providerAccounts, account]),
	});
	return account;
}

export function updateRouterProviderAccountMetadata(
	id: string,
	updates: Partial<
		Pick<
			RouterProviderAccount,
			| "backoffLevel"
			| "consecutiveUseCount"
			| "authType"
			| "email"
			| "expiresAt"
			| "failureCount"
			| "isActive"
			| "lastError"
			| "lastUsedAt"
			| "name"
			| "priority"
			| "providerSpecificData"
			| "rateLimitedUntil"
			| "requestCount"
		>
	>,
): RouterProviderAccount[] {
	const data = readStore();
	const next = data.providerAccounts.map((account) =>
		account.id === id
			? {
					...account,
					...sanitizeProviderAccountUpdates(updates),
					updatedAt: new Date().toISOString(),
				}
			: account,
	);
	writeStore({ ...data, providerAccounts: sortAccounts(next) });
	return getRouterProviderAccounts();
}

export function deleteRouterProviderAccountMetadata(
	id: string,
): RouterProviderAccount[] {
	const data = readStore();
	writeStore({
		...data,
		providerAccounts: data.providerAccounts.filter(
			(account) => account.id !== id,
		),
	});
	return getRouterProviderAccounts();
}

export function recordRouterProviderAccountSuccess(id: string): void {
	const account = getRouterProviderAccounts().find(
		(candidate) => candidate.id === id,
	);
	if (!account) return;
	updateRouterProviderAccountMetadata(id, {
		backoffLevel: 0,
		consecutiveUseCount: account.consecutiveUseCount + 1,
		lastError: null,
		lastUsedAt: new Date().toISOString(),
		rateLimitedUntil: null,
		requestCount: account.requestCount + 1,
	});
}

export function recordRouterProviderAccountFailure({
	backoffLevel,
	cooldownMs,
	id,
	message,
	status,
}: {
	backoffLevel: number;
	cooldownMs: number;
	id: string;
	message: string;
	status?: number;
}): void {
	const account = getRouterProviderAccounts().find(
		(candidate) => candidate.id === id,
	);
	if (!account) return;
	updateRouterProviderAccountMetadata(id, {
		backoffLevel,
		consecutiveUseCount: 0,
		failureCount: account.failureCount + 1,
		lastError: {
			status,
			message,
			timestamp: new Date().toISOString(),
		},
		rateLimitedUntil:
			cooldownMs > 0 ? new Date(Date.now() + cooldownMs).toISOString() : null,
	});
}

export function selectRouterProviderAccounts(
	provider: RouterProviderKeyId,
): RouterProviderAccount[] {
	const data = readStore();
	const available = sortAccounts(
		data.providerAccounts.filter(
			(account) =>
				account.provider === provider &&
				account.isActive &&
				!isCooldownActive(account.rateLimitedUntil),
		),
	);
	if (available.length === 0) return [];

	const cursor = data.accountCursor[provider] ?? 0;
	const start = cursor % available.length;
	const ordered = [...available.slice(start), ...available.slice(0, start)];
	writeStore({
		...data,
		accountCursor: {
			...data.accountCursor,
			[provider]: (start + 1) % available.length,
		},
	});
	return ordered;
}

export function recordRouterUsage(input: RouterUsageRecordInput): void {
	const requestTokens = Math.max(0, Math.round(input.requestTokens ?? 0));
	const responseTokens = Math.max(0, Math.round(input.responseTokens ?? 0));
	const provider = input.provider || inferProvider(input.model) || "router";
	const model = input.model || "unknown";
	const totalTokens = requestTokens + responseTokens;
	const data = readStore();
	const entry: RouterUsageEntry = {
		id: randomUUID(),
		timestamp: new Date().toISOString(),
		endpoint: input.endpoint,
		method: input.method,
		provider,
		model,
		accountId: input.accountId ?? null,
		accountName: input.accountName ?? null,
		status: input.status,
		success: input.success,
		durationMs: Math.max(0, Math.round(input.durationMs)),
		requestTokens,
		responseTokens,
		totalTokens,
		error: input.error ?? null,
		estimatedCostUsd: estimateModelCostUsd(
			model,
			requestTokens,
			responseTokens,
		),
	};

	writeStore({
		...data,
		usage: [entry, ...data.usage].slice(0, MAX_USAGE_ENTRIES),
	});
}

export function getRouterUsageStats(limit = 50): RouterUsageStats {
	const usage = readStore().usage;
	const byProviderMap = new Map<
		string,
		{
			provider: string;
			requests: number;
			totalTokens: number;
			estimatedCostUsd: number;
		}
	>();

	for (const entry of usage) {
		const bucket = byProviderMap.get(entry.provider) ?? {
			provider: entry.provider,
			requests: 0,
			totalTokens: 0,
			estimatedCostUsd: 0,
		};
		bucket.requests++;
		bucket.totalTokens += entry.totalTokens;
		bucket.estimatedCostUsd += entry.estimatedCostUsd;
		byProviderMap.set(entry.provider, bucket);
	}

	return {
		totalRequests: usage.length,
		successfulRequests: usage.filter((entry) => entry.success).length,
		failedRequests: usage.filter((entry) => !entry.success).length,
		totalTokens: usage.reduce((sum, entry) => sum + entry.totalTokens, 0),
		estimatedCostUsd: roundCurrency(
			usage.reduce((sum, entry) => sum + entry.estimatedCostUsd, 0),
		),
		byProvider: Array.from(byProviderMap.values())
			.map((entry) => ({
				...entry,
				estimatedCostUsd: roundCurrency(entry.estimatedCostUsd),
			}))
			.sort((a, b) => b.requests - a.requests),
		recentRequests: usage.slice(0, limit),
	};
}

export function getRouterUsageCompatStats(
	period: RouterUsagePeriod = "all",
): RouterUsageCompatStats {
	const usage = filterUsageForPeriod(readStore().usage, period);
	const stats: RouterUsageCompatStats = {
		totalRequests: 0,
		totalPromptTokens: 0,
		totalCompletionTokens: 0,
		totalCachedTokens: 0,
		totalCost: 0,
		byProvider: {},
		byModel: {},
		byAccount: {},
		byApiKey: {},
		byEndpoint: {},
		last10Minutes: buildLast10Minutes(usage),
		pending: { byAccount: {} },
		activeRequests: [],
		recentRequests: usage.slice(0, 20).map(toCompatRecentRequest),
		errorProvider:
			usage.find(
				(entry) => !entry.success && Date.now() - timestampMs(entry) < 10_000,
			)?.provider ?? "",
	};

	for (const entry of usage) {
		const promptTokens = entry.requestTokens;
		const completionTokens = entry.responseTokens;
		const values = {
			cachedTokens: 0,
			completionTokens,
			cost: entry.estimatedCostUsd,
			promptTokens,
			requests: 1,
		};
		stats.totalRequests++;
		stats.totalPromptTokens += promptTokens;
		stats.totalCompletionTokens += completionTokens;
		stats.totalCost += entry.estimatedCostUsd;
		addCompatBucket(stats.byProvider, entry.provider, values, {
			lastUsed: entry.timestamp,
			provider: entry.provider,
		});
		addCompatBucket(stats.byModel, modelStatsKey(entry), values, {
			lastUsed: entry.timestamp,
			provider: entry.provider,
			rawModel: entry.model,
		});
		addCompatBucket(stats.byAccount, accountStatsKey(entry), values, {
			accountName: entry.accountName,
			connectionId: entry.accountId,
			lastUsed: entry.timestamp,
			provider: entry.provider,
			rawModel: entry.model,
		});
		addCompatBucket(
			stats.byApiKey,
			entry.accountName ?? entry.accountId ?? "local-no-key",
			values,
			{
				accountName: entry.accountName ?? "Local (No API Key)",
				connectionId: entry.accountId,
				lastUsed: entry.timestamp,
				provider: entry.provider,
				rawModel: entry.model,
			},
		);
		addCompatBucket(
			stats.byEndpoint,
			`${entry.endpoint}|${entry.model}|${entry.provider}`,
			values,
			{
				endpoint: entry.endpoint,
				lastUsed: entry.timestamp,
				provider: entry.provider,
				rawModel: entry.model,
			},
		);
	}

	stats.totalCost = roundCurrency(stats.totalCost);
	return stats;
}

export function getRouterUsageProviders(): Array<{ id: string; name: string }> {
	return Array.from(
		new Set(
			readStore()
				.usage.map((entry) => entry.provider)
				.filter(Boolean),
		),
	)
		.sort((a, b) => a.localeCompare(b))
		.map((provider) => ({ id: provider, name: provider }));
}

export function getRouterUsageLogs(limit = 200): string[] {
	return readStore()
		.usage.slice(0, limit)
		.map((entry) => {
			const timestamp = formatLogDate(new Date(entry.timestamp));
			const provider = entry.provider.toUpperCase();
			const account = entry.accountName ?? entry.accountId?.slice(0, 8) ?? "-";
			const status = entry.success ? "ok" : String(entry.status);
			return `${timestamp} | ${entry.model} | ${provider} | ${account} | ${entry.requestTokens} | ${entry.responseTokens} | ${status}`;
		});
}

export function getRouterUsageChart(
	period: Exclude<RouterUsagePeriod, "all"> = "7d",
): RouterUsageChartBucket[] {
	const usage = filterUsageForPeriod(readStore().usage, period);
	const now = new Date();
	const buckets = chartBuckets(period, now);
	for (const entry of usage) {
		const time = timestampMs(entry);
		const bucket = buckets.find(
			(candidate) => time >= candidate.startMs && time < candidate.endMs,
		);
		if (!bucket) continue;
		bucket.tokens += entry.totalTokens;
		bucket.cost = roundCurrency(bucket.cost + entry.estimatedCostUsd);
	}
	return buckets.map(({ cost, label, tokens }) => ({ cost, label, tokens }));
}

export function getRouterUsageRequestDetails(
	filter: RouterUsageRequestDetailsFilter = {},
): RouterUsageRequestDetailsResult {
	const page = Math.max(1, Math.round(filter.page ?? 1));
	const pageSize = Math.min(
		100,
		Math.max(1, Math.round(filter.pageSize ?? 20)),
	);
	const filtered = filterUsageEntries(readStore().usage, filter);
	const totalItems = filtered.length;
	const totalPages = Math.ceil(totalItems / pageSize);
	const offset = (page - 1) * pageSize;
	const details = filtered
		.slice(offset, offset + pageSize)
		.map(toRequestDetail);
	return {
		details,
		pagination: {
			page,
			pageSize,
			totalItems,
			totalPages,
			hasNext: page < totalPages,
			hasPrev: page > 1,
		},
	};
}

export function getRouterUsageForConnection(
	connectionId: string,
): RouterConnectionUsageSummary {
	const usage = readStore().usage.filter(
		(entry) => entry.accountId === connectionId,
	);
	const promptTokens = usage.reduce(
		(sum, entry) => sum + entry.requestTokens,
		0,
	);
	const completionTokens = usage.reduce(
		(sum, entry) => sum + entry.responseTokens,
		0,
	);
	const totalCost = roundCurrency(
		usage.reduce((sum, entry) => sum + entry.estimatedCostUsd, 0),
	);
	return {
		connectionId,
		totalRequests: usage.length,
		successfulRequests: usage.filter((entry) => entry.success).length,
		failedRequests: usage.filter((entry) => !entry.success).length,
		totalPromptTokens: promptTokens,
		totalCompletionTokens: completionTokens,
		totalCachedTokens: 0,
		totalTokens: promptTokens + completionTokens,
		totalCost,
		lastUsed: usage[0]?.timestamp ?? null,
		recentRequests: usage.slice(0, 20).map(toRequestDetail),
	};
}

export function clearRouterUsage(): RouterUsageStats {
	const data = readStore();
	writeStore({ ...data, usage: [] });
	return getRouterUsageStats();
}

export function estimateTokens(value: unknown): number {
	if (value === undefined || value === null) return 0;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return Math.ceil(text.length / 4);
}

function filterUsageForPeriod(
	usage: RouterUsageEntry[],
	period: RouterUsagePeriod,
): RouterUsageEntry[] {
	const startMs = usagePeriodStartMs(period);
	if (startMs === null) return usage;
	return usage.filter((entry) => timestampMs(entry) >= startMs);
}

function filterUsageEntries(
	usage: RouterUsageEntry[],
	filter: RouterUsageRequestDetailsFilter,
): RouterUsageEntry[] {
	const startMs = filter.startDate
		? new Date(filter.startDate).getTime()
		: null;
	const endMs = filter.endDate ? new Date(filter.endDate).getTime() : null;
	const status = filter.status?.trim().toLowerCase() ?? "";
	return usage.filter((entry) => {
		if (filter.provider && entry.provider !== filter.provider) return false;
		if (filter.model && entry.model !== filter.model) return false;
		if (filter.connectionId && entry.accountId !== filter.connectionId) {
			return false;
		}
		if (Number.isFinite(startMs) && timestampMs(entry) < Number(startMs)) {
			return false;
		}
		if (Number.isFinite(endMs) && timestampMs(entry) > Number(endMs)) {
			return false;
		}
		if (!status) return true;
		if ((status === "ok" || status === "success") && entry.success) {
			return true;
		}
		if ((status === "error" || status === "failed") && !entry.success) {
			return true;
		}
		return String(entry.status) === status;
	});
}

function toRequestDetail(entry: RouterUsageEntry): RouterUsageRequestDetail {
	return {
		id: entry.id,
		timestamp: entry.timestamp,
		provider: entry.provider,
		model: entry.model,
		connectionId: entry.accountId,
		accountName: entry.accountName,
		apiKeyMasked: entry.accountId ? `...${entry.accountId.slice(-6)}` : null,
		endpoint: entry.endpoint,
		method: entry.method,
		status: entry.success ? "ok" : "error",
		statusCode: entry.status,
		success: entry.success,
		durationMs: entry.durationMs,
		cost: roundCurrency(entry.estimatedCostUsd),
		error: entry.error,
		tokens: {
			prompt_tokens: entry.requestTokens,
			completion_tokens: entry.responseTokens,
			cached_tokens: 0,
			total_tokens: entry.totalTokens,
		},
	};
}

function usagePeriodStartMs(period: RouterUsagePeriod): number | null {
	const now = new Date();
	if (period === "all") return null;
	if (period === "24h") return now.getTime() - 24 * 60 * 60 * 1000;
	if (period === "today") {
		const start = new Date(now);
		start.setHours(0, 0, 0, 0);
		return start.getTime();
	}
	const days = period === "7d" ? 7 : period === "30d" ? 30 : 60;
	return now.getTime() - days * 24 * 60 * 60 * 1000;
}

function timestampMs(entry: RouterUsageEntry): number {
	const value = new Date(entry.timestamp).getTime();
	return Number.isFinite(value) ? value : 0;
}

function addCompatBucket(
	target: Record<string, RouterUsageCompatBucket>,
	key: string,
	values: Pick<
		RouterUsageCompatBucket,
		"cachedTokens" | "completionTokens" | "cost" | "promptTokens" | "requests"
	>,
	metadata: Partial<RouterUsageCompatBucket> = {},
): void {
	const bucket = target[key] ?? {
		requests: 0,
		promptTokens: 0,
		completionTokens: 0,
		cachedTokens: 0,
		cost: 0,
		...metadata,
	};
	bucket.requests += values.requests;
	bucket.promptTokens += values.promptTokens;
	bucket.completionTokens += values.completionTokens;
	bucket.cachedTokens += values.cachedTokens;
	bucket.cost = roundCurrency(bucket.cost + values.cost);
	if (
		metadata.lastUsed &&
		(!bucket.lastUsed ||
			new Date(metadata.lastUsed) > new Date(bucket.lastUsed))
	) {
		bucket.lastUsed = metadata.lastUsed;
	}
	target[key] = { ...bucket, ...metadata, lastUsed: bucket.lastUsed };
}

function toCompatRecentRequest(
	entry: RouterUsageEntry,
): RouterUsageCompatRecentRequest {
	return {
		timestamp: entry.timestamp,
		model: entry.model,
		provider: entry.provider,
		promptTokens: entry.requestTokens,
		completionTokens: entry.responseTokens,
		cachedTokens: 0,
		status: entry.success ? "ok" : String(entry.status),
	};
}

function buildLast10Minutes(
	usage: RouterUsageEntry[],
): RouterUsageMinuteBucket[] {
	const now = Date.now();
	const currentMinuteStart = Math.floor(now / 60_000) * 60_000;
	const buckets = Array.from({ length: 10 }, (_, index) => {
		const startMs = currentMinuteStart - (9 - index) * 60_000;
		return {
			startMs,
			requests: 0,
			promptTokens: 0,
			completionTokens: 0,
			cost: 0,
		};
	});

	for (const entry of usage) {
		const minuteStart = Math.floor(timestampMs(entry) / 60_000) * 60_000;
		const bucket = buckets.find(
			(candidate) => candidate.startMs === minuteStart,
		);
		if (!bucket) continue;
		bucket.requests++;
		bucket.promptTokens += entry.requestTokens;
		bucket.completionTokens += entry.responseTokens;
		bucket.cost = roundCurrency(bucket.cost + entry.estimatedCostUsd);
	}

	return buckets.map(({ cost, completionTokens, promptTokens, requests }) => ({
		cost,
		completionTokens,
		promptTokens,
		requests,
	}));
}

function modelStatsKey(entry: RouterUsageEntry): string {
	return entry.provider ? `${entry.model} (${entry.provider})` : entry.model;
}

function accountStatsKey(entry: RouterUsageEntry): string {
	const account = entry.accountName ?? entry.accountId ?? "Local (No API Key)";
	return `${entry.model} (${entry.provider} - ${account})`;
}

function formatLogDate(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function chartBuckets(
	period: Exclude<RouterUsagePeriod, "all">,
	now: Date,
): Array<RouterUsageChartBucket & { endMs: number; startMs: number }> {
	if (period === "today") {
		const start = new Date(now);
		start.setHours(0, 0, 0, 0);
		return Array.from({ length: 24 }, (_, index) => {
			const startMs = start.getTime() + index * 60 * 60 * 1000;
			return {
				label: new Date(startMs).toLocaleTimeString("en-US", {
					hour: "2-digit",
					hour12: false,
					minute: "2-digit",
				}),
				startMs,
				endMs: startMs + 60 * 60 * 1000,
				tokens: 0,
				cost: 0,
			};
		});
	}

	if (period === "24h") {
		const bucketMs = 60 * 60 * 1000;
		const startMs = now.getTime() - 24 * bucketMs;
		return Array.from({ length: 24 }, (_, index) => {
			const bucketStart = startMs + index * bucketMs;
			return {
				label: new Date(bucketStart).toLocaleTimeString("en-US", {
					hour: "2-digit",
					hour12: false,
					minute: "2-digit",
				}),
				startMs: bucketStart,
				endMs: bucketStart + bucketMs,
				tokens: 0,
				cost: 0,
			};
		});
	}

	const days = period === "7d" ? 7 : period === "30d" ? 30 : 60;
	return Array.from({ length: days }, (_, index) => {
		const day = new Date(now);
		day.setHours(0, 0, 0, 0);
		day.setDate(day.getDate() - (days - 1 - index));
		return {
			label: day.toLocaleDateString("en-US", {
				day: "numeric",
				month: "short",
			}),
			startMs: day.getTime(),
			endMs: day.getTime() + 24 * 60 * 60 * 1000,
			tokens: 0,
			cost: 0,
		};
	});
}

function normalizeAlias(alias: RouterModelAlias): RouterModelAlias {
	const normalized = {
		alias: alias.alias.trim(),
		targetModel: alias.targetModel.trim(),
	};
	if (!normalized.alias || !normalized.targetModel) {
		throw new Error("Alias and target model are required");
	}
	if (normalized.alias === normalized.targetModel) {
		throw new Error("Alias cannot point to itself");
	}
	return normalized;
}

function normalizeCustomCombo(combo: RouterCustomCombo): RouterCustomCombo {
	const normalized = {
		name: combo.name.trim(),
		models: combo.models.map((model) => model.trim()).filter(Boolean),
	};
	if (!normalized.name || normalized.models.length === 0) {
		throw new Error("Combo name and at least one model are required");
	}
	return normalized;
}

function normalizeCustomModel(
	model: Partial<RouterCustomModel>,
	existing?: RouterCustomModel,
): RouterCustomModel | null {
	const providerAlias = model.providerAlias?.trim() ?? "";
	const id = normalizeModelIdForProvider(providerAlias, model.id ?? "");
	const type = normalizeModelKind(model.type);
	if (!providerAlias || !id) return null;
	const now = new Date().toISOString();
	return {
		providerAlias,
		id,
		type,
		name: model.name?.trim() || existing?.name || id,
		createdAt: existing?.createdAt ?? model.createdAt ?? now,
		updatedAt: now,
	};
}

function normalizeDisabledModel(
	model: Partial<RouterDisabledModel>,
): RouterDisabledModel | null {
	const providerAlias = model.providerAlias?.trim() ?? "";
	const id = normalizeModelIdForProvider(providerAlias, model.id ?? "");
	if (!providerAlias || !id) return null;
	return {
		providerAlias,
		id,
		reason: model.reason?.trim() || null,
		disabledAt: model.disabledAt ?? new Date().toISOString(),
	};
}

function normalizeAvailabilityEntry(
	entry: Partial<RouterModelAvailabilityEntry>,
): RouterModelAvailabilityEntry {
	const model = entry.model?.trim() || "unknown";
	const provider = entry.provider?.trim() || inferProvider(model) || "router";
	return {
		id: entry.id ?? randomUUID(),
		provider,
		model,
		kind: normalizeModelKind(entry.kind),
		status:
			entry.status === "available" ||
			entry.status === "unavailable" ||
			entry.status === "cooldown"
				? entry.status
				: "unavailable",
		checkedAt: entry.checkedAt ?? new Date().toISOString(),
		latencyMs:
			typeof entry.latencyMs === "number" && Number.isFinite(entry.latencyMs)
				? Math.max(0, Math.round(entry.latencyMs))
				: null,
		httpStatus:
			typeof entry.httpStatus === "number" && Number.isFinite(entry.httpStatus)
				? Math.round(entry.httpStatus)
				: null,
		error: entry.error?.trim() || null,
		method: entry.method?.trim() || null,
	};
}

function normalizeModelKind(value: unknown): RouterModelKind {
	if (
		value === "llm" ||
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

function normalizeModelIdForProvider(
	providerAlias: string,
	modelId: string,
): string {
	let id = modelId.trim();
	const provider = providerAlias.trim();
	if (provider && id.startsWith(`${provider}/`)) {
		id = id.slice(provider.length + 1);
	}
	return id;
}

function normalizeProviderNode(node: RouterProviderNode): RouterProviderNode {
	const type = isProviderNodeType(node.type) ? node.type : "openai-compatible";
	const prefix = node.prefix.trim().replace(/^\/+|\/+$/g, "");
	const normalized: RouterProviderNode = {
		id: node.id || providerNodeId(type, node.apiType),
		type,
		name: node.name.trim() || prefix || "Provider node",
		prefix,
		baseUrl: sanitizeProviderNodeBaseUrl(
			node.baseUrl || defaultProviderNodeBaseUrl(type),
			type,
		),
		apiKeyProvider: isRouterProviderKeyId(node.apiKeyProvider)
			? node.apiKeyProvider
			: defaultProviderNodeKeyProvider(type),
		apiKeyAccountId: node.apiKeyAccountId?.trim() || null,
		models: Array.from(
			new Set(
				(Array.isArray(node.models) ? node.models : [])
					.map((model) => model.trim())
					.filter(Boolean),
			),
		).sort((a, b) => a.localeCompare(b)),
		isActive: node.isActive !== false,
		createdAt: node.createdAt || new Date().toISOString(),
		updatedAt: node.updatedAt || new Date().toISOString(),
	};

	if (type === "openai-compatible") {
		normalized.apiType =
			node.apiType === "responses" || node.apiType === "chat"
				? node.apiType
				: "chat";
	}

	if (!normalized.prefix) throw new Error("Provider node prefix is required");
	if (!normalized.baseUrl)
		throw new Error("Provider node base URL is required");

	return normalized;
}

function sanitizeProviderNodeBaseUrl(
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

function providerNodeId(
	type: RouterProviderNodeType,
	apiType?: RouterProviderNodeApiType,
): string {
	if (type === "openai-compatible") {
		return `openai-compatible-${apiType === "responses" ? "responses" : "chat"}-${randomUUID()}`;
	}
	if (type === "anthropic-compatible") {
		return `anthropic-compatible-${randomUUID()}`;
	}
	return `custom-embedding-${randomUUID()}`;
}

function isProviderNodeType(value: unknown): value is RouterProviderNodeType {
	return (
		value === "openai-compatible" ||
		value === "anthropic-compatible" ||
		value === "custom-embedding"
	);
}

function isRouterProviderKeyId(value: unknown): value is RouterProviderKeyId {
	return (
		typeof value === "string" &&
		ROUTER_PROVIDER_KEY_IDS.includes(value as RouterProviderKeyId)
	);
}

function sortProviderNodes(nodes: RouterProviderNode[]): RouterProviderNode[] {
	return [...nodes].sort(
		(a, b) => a.prefix.localeCompare(b.prefix) || a.name.localeCompare(b.name),
	);
}

function removeUndefinedValues<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	) as Partial<T>;
}

function readStore(): RouterStoreFile {
	const path = getStorePath();
	if (!existsSync(path)) return emptyStore();

	try {
		const parsed = JSON.parse(
			readFileSync(path, "utf8"),
		) as Partial<RouterStoreFile>;
		return {
			aliases: Array.isArray(parsed.aliases) ? parsed.aliases : [],
			apiKeys: Array.isArray(parsed.apiKeys)
				? sortRouterApiKeys(
						parsed.apiKeys
							.map((apiKey) =>
								normalizeRouterApiKey(apiKey as Partial<RouterGatewayApiKey>),
							)
							.filter((apiKey): apiKey is RouterGatewayApiKey =>
								Boolean(apiKey),
							),
					)
				: [],
			customCombos: Array.isArray(parsed.customCombos)
				? parsed.customCombos
				: [],
			customModels: Array.isArray(parsed.customModels)
				? sortCustomModels(
						parsed.customModels
							.map((model) =>
								normalizeCustomModel(model as Partial<RouterCustomModel>),
							)
							.filter((model): model is RouterCustomModel => Boolean(model)),
					)
				: [],
			disabledModels: Array.isArray(parsed.disabledModels)
				? sortDisabledModels(
						parsed.disabledModels
							.map((model) =>
								normalizeDisabledModel(model as Partial<RouterDisabledModel>),
							)
							.filter((model): model is RouterDisabledModel => Boolean(model)),
					)
				: [],
			mitmAliases: normalizeNestedStringMap(parsed.mitmAliases),
			modelAvailability: Array.isArray(parsed.modelAvailability)
				? parsed.modelAvailability
						.map((entry) =>
							normalizeAvailabilityEntry(
								entry as Partial<RouterModelAvailabilityEntry>,
							),
						)
						.filter(Boolean)
						.slice(0, MAX_AVAILABILITY_ENTRIES)
				: [],
			pricing: normalizePricingTable(parsed.pricing),
			proxyPools: Array.isArray(parsed.proxyPools)
				? sortProxyPools(
						parsed.proxyPools
							.map((pool) => normalizeProxyPool(pool as RouterProxyPool))
							.filter((pool): pool is RouterProxyPool => Boolean(pool)),
					)
				: [],
			providerAccounts: Array.isArray(parsed.providerAccounts)
				? sortAccounts(
						parsed.providerAccounts
							.map((account) =>
								normalizeProviderAccount(
									account as Partial<RouterProviderAccount>,
								),
							)
							.filter((account): account is RouterProviderAccount =>
								Boolean(account),
							),
					)
				: [],
			providerNodes: Array.isArray(parsed.providerNodes)
				? parsed.providerNodes
						.map((node) => normalizeProviderNode(node as RouterProviderNode))
						.filter(Boolean)
				: [],
			settings: normalizeRouterSettings(parsed.settings),
			accountCursor:
				parsed.accountCursor && typeof parsed.accountCursor === "object"
					? parsed.accountCursor
					: {},
			usage: Array.isArray(parsed.usage)
				? parsed.usage.map(normalizeUsageEntry)
				: [],
		};
	} catch (error) {
		console.error("[agent-router-store] Failed to read store:", error);
		return emptyStore();
	}
}

function writeStore(data: RouterStoreFile): void {
	const path = getStorePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function emptyStore(): RouterStoreFile {
	return {
		aliases: [],
		apiKeys: [],
		customCombos: [],
		customModels: [],
		disabledModels: [],
		mitmAliases: {},
		modelAvailability: [],
		pricing: {},
		proxyPools: [],
		providerAccounts: [],
		providerNodes: [],
		settings: normalizeRouterSettings({}),
		accountCursor: {},
		usage: [],
	};
}

function normalizeUsageEntry(
	entry: Partial<RouterUsageEntry>,
): RouterUsageEntry {
	return {
		id: entry.id ?? randomUUID(),
		timestamp: entry.timestamp ?? new Date().toISOString(),
		endpoint: entry.endpoint ?? "unknown",
		method: entry.method ?? "POST",
		provider: entry.provider ?? "router",
		model: entry.model ?? "unknown",
		accountId: entry.accountId ?? null,
		accountName: entry.accountName ?? null,
		status: entry.status ?? 0,
		success: entry.success ?? false,
		durationMs: entry.durationMs ?? 0,
		requestTokens: entry.requestTokens ?? 0,
		responseTokens: entry.responseTokens ?? 0,
		error: entry.error ?? null,
		totalTokens:
			entry.totalTokens ??
			(entry.requestTokens ?? 0) + (entry.responseTokens ?? 0),
		estimatedCostUsd: entry.estimatedCostUsd ?? 0,
	};
}

function getStorePath(): string {
	return join(app.getPath("userData"), "agent-router-state.json");
}

function inferProvider(model?: string | null): string | null {
	if (!model) return null;
	if (model.startsWith("openrouter/") || model.includes("/"))
		return "openrouter";
	const profile =
		AGENT_ROUTER_PROFILES[model as keyof typeof AGENT_ROUTER_PROFILES];
	return profile?.provider ?? null;
}

function estimateModelCostUsd(
	model: string,
	inputTokens: number,
	outputTokens: number,
): number {
	const pricing = findPricing(model);
	if (!pricing) return 0;
	return roundCurrency(
		(inputTokens / 1_000_000) * pricing.inputPerMillion +
			(outputTokens / 1_000_000) * pricing.outputPerMillion,
	);
}

function findPricing(model: string): AgentPricing | null {
	const normalized = model.startsWith("openrouter/")
		? model.slice("openrouter/".length)
		: model;
	const editable = findEditablePricing(model, normalized);
	if (editable) {
		return {
			inputPerMillion: editable.input ?? 0,
			outputPerMillion: editable.output ?? 0,
		};
	}
	const profile = Object.values(AGENT_ROUTER_PROFILES).find(
		(entry) => entry.modelId === normalized || entry.agent === normalized,
	);
	return profile?.pricing ?? null;
}

function findEditablePricing(
	model: string,
	normalized: string,
): RouterPricingRate | null {
	const table = getRouterPricing();
	const candidates = Array.from(new Set([model, normalized]));

	for (const candidate of candidates) {
		for (const [provider, models] of Object.entries(table)) {
			if (models[candidate]) return models[candidate];
			const prefix = `${provider}/`;
			if (candidate.startsWith(prefix)) {
				const modelId = candidate.slice(prefix.length);
				if (models[modelId]) return models[modelId];
			}
		}
	}

	return null;
}

function clonePricingTable(table: RouterPricingTable): RouterPricingTable {
	return Object.fromEntries(
		Object.entries(table).map(([provider, models]) => [
			provider,
			Object.fromEntries(
				Object.entries(models).map(([model, pricing]) => [
					model,
					{ ...pricing },
				]),
			),
		]),
	);
}

function mergePricingTables(
	base: RouterPricingTable,
	overrides: RouterPricingTable,
): RouterPricingTable {
	const next = clonePricingTable(base);
	for (const [provider, models] of Object.entries(overrides)) {
		next[provider] = {
			...(next[provider] ?? {}),
			...models,
		};
	}
	return next;
}

function normalizePricingTable(value: unknown): RouterPricingTable {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const table: RouterPricingTable = {};
	for (const [rawProvider, rawModels] of Object.entries(value)) {
		const provider = rawProvider.trim();
		if (!provider || !rawModels || typeof rawModels !== "object") continue;
		const models: Record<string, RouterPricingRate> = {};
		for (const [rawModel, rawPricing] of Object.entries(rawModels)) {
			const model = rawModel.trim();
			const pricing = normalizePricingRate(rawPricing);
			if (!model || !pricing) continue;
			models[model] = pricing;
		}
		if (Object.keys(models).length > 0) table[provider] = models;
	}
	return table;
}

function normalizePricingRate(value: unknown): RouterPricingRate | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const rate: RouterPricingRate = {};
	for (const key of [
		"input",
		"output",
		"cached",
		"reasoning",
		"cache_creation",
	] as const) {
		const candidate = (value as Record<string, unknown>)[key];
		if (candidate === undefined) continue;
		const numeric = Number(candidate);
		if (!Number.isFinite(numeric) || numeric < 0) {
			throw new Error(`Invalid pricing value for ${key}`);
		}
		rate[key] = numeric;
	}
	return Object.keys(rate).length > 0 ? rate : null;
}

function normalizeNestedStringMap(
	value: unknown,
): Record<string, Record<string, string>> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const map: Record<string, Record<string, string>> = {};
	for (const [tool, mappings] of Object.entries(value)) {
		const toolName = tool.trim();
		if (!toolName || !mappings || typeof mappings !== "object") continue;
		const normalized = normalizeStringMap(mappings as Record<string, unknown>);
		if (Object.keys(normalized).length > 0) map[toolName] = normalized;
	}
	return map;
}

function normalizeStringMap(
	value: Record<string, unknown>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(value)
			.map(([key, entry]) => [key.trim(), String(entry ?? "").trim()])
			.filter(([key, entry]) => key && entry),
	);
}

function normalizeRouterApiKey(
	apiKey: Partial<RouterGatewayApiKey>,
): RouterGatewayApiKey | null {
	const keyHash = apiKey.keyHash?.trim();
	const name = apiKey.name?.trim();
	if (!keyHash || !name) return null;
	const now = new Date().toISOString();
	return {
		id: apiKey.id?.trim() || randomUUID(),
		keyHash,
		keyPreview: apiKey.keyPreview?.trim() || "stored key",
		name,
		machineId: apiKey.machineId?.trim() || getRouterMachineId(),
		isActive: apiKey.isActive !== false,
		createdAt: apiKey.createdAt ?? now,
		updatedAt: apiKey.updatedAt ?? apiKey.createdAt ?? now,
		lastUsedAt: apiKey.lastUsedAt ?? null,
	};
}

function normalizeRouterSettings(value: unknown): RouterGatewaySettings {
	const raw =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const safe = Object.fromEntries(
		Object.entries(raw).filter(
			([key, entry]) =>
				!PROTECTED_ROUTER_SETTING_KEYS.has(key) && entry !== undefined,
		),
	);
	return {
		...DEFAULT_ROUTER_GATEWAY_SETTINGS,
		...safe,
		authMode:
			typeof safe.authMode === "string"
				? safe.authMode
				: DEFAULT_ROUTER_GATEWAY_SETTINGS.authMode,
		headroomUrl:
			typeof safe.headroomUrl === "string"
				? safe.headroomUrl
				: DEFAULT_ROUTER_GATEWAY_SETTINGS.headroomUrl,
		mitmRouterBaseUrl:
			typeof safe.mitmRouterBaseUrl === "string"
				? safe.mitmRouterBaseUrl
				: DEFAULT_ROUTER_GATEWAY_SETTINGS.mitmRouterBaseUrl,
		outboundNoProxy:
			typeof safe.outboundNoProxy === "string"
				? safe.outboundNoProxy
				: DEFAULT_ROUTER_GATEWAY_SETTINGS.outboundNoProxy,
		outboundProxyUrl:
			typeof safe.outboundProxyUrl === "string"
				? safe.outboundProxyUrl
				: DEFAULT_ROUTER_GATEWAY_SETTINGS.outboundProxyUrl,
		tailscaleUrl:
			typeof safe.tailscaleUrl === "string"
				? safe.tailscaleUrl
				: DEFAULT_ROUTER_GATEWAY_SETTINGS.tailscaleUrl,
		tunnelProvider:
			typeof safe.tunnelProvider === "string"
				? safe.tunnelProvider
				: DEFAULT_ROUTER_GATEWAY_SETTINGS.tunnelProvider,
		tunnelUrl:
			typeof safe.tunnelUrl === "string"
				? safe.tunnelUrl
				: DEFAULT_ROUTER_GATEWAY_SETTINGS.tunnelUrl,
	} satisfies RouterGatewaySettings;
}

function hashRouterApiKey(key: string): string {
	return createHash("sha256").update(key).digest("hex");
}

function previewRouterApiKey(key: string): string {
	return `${key.slice(0, 10)}...${key.slice(-6)}`;
}

function getRouterMachineId(): string {
	return createHash("sha256")
		.update(app.getPath("userData"))
		.digest("hex")
		.slice(0, 16);
}

function normalizeProxyPool(pool: Partial<RouterProxyPool>): RouterProxyPool {
	const name = pool.name?.trim() ?? "";
	const proxyUrl = pool.proxyUrl?.trim() ?? "";
	if (!name) throw new Error("Name is required");
	if (!proxyUrl) throw new Error("Proxy URL is required");
	const now = new Date().toISOString();
	return {
		id: pool.id?.trim() || randomUUID(),
		name,
		proxyUrl,
		noProxy: pool.noProxy?.trim() ?? "",
		type: normalizeProxyPoolType(pool.type),
		isActive: pool.isActive !== false,
		strictProxy: pool.strictProxy === true,
		testStatus: normalizeProxyPoolTestStatus(pool.testStatus),
		lastTestedAt: pool.lastTestedAt ?? null,
		lastError: pool.lastError?.trim() || null,
		createdAt: pool.createdAt ?? now,
		updatedAt: pool.updatedAt ?? now,
	};
}

function normalizeProxyPoolType(value: unknown): RouterProxyPoolType {
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

function normalizeProxyPoolTestStatus(
	value: unknown,
): RouterProxyPoolTestStatus {
	if (value === "active" || value === "error" || value === "unknown") {
		return value;
	}
	return "unknown";
}

function roundCurrency(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

function sortAccounts(
	accounts: RouterProviderAccount[],
): RouterProviderAccount[] {
	return [...accounts].sort(
		(a, b) => a.priority - b.priority || a.name.localeCompare(b.name),
	);
}

function sortCustomModels(models: RouterCustomModel[]): RouterCustomModel[] {
	return [...models].sort(
		(a, b) =>
			a.providerAlias.localeCompare(b.providerAlias) ||
			a.id.localeCompare(b.id) ||
			a.type.localeCompare(b.type),
	);
}

function sortDisabledModels(
	models: RouterDisabledModel[],
): RouterDisabledModel[] {
	return [...models].sort(
		(a, b) =>
			a.providerAlias.localeCompare(b.providerAlias) ||
			a.id.localeCompare(b.id),
	);
}

function sortProxyPools(pools: RouterProxyPool[]): RouterProxyPool[] {
	return [...pools].sort(
		(a, b) =>
			new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() ||
			a.name.localeCompare(b.name),
	);
}

function sortRouterApiKeys(
	apiKeys: RouterGatewayApiKey[],
): RouterGatewayApiKey[] {
	return [...apiKeys].sort(
		(a, b) =>
			new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
			a.name.localeCompare(b.name),
	);
}

function normalizeProviderAccount(
	account: Partial<RouterProviderAccount>,
): RouterProviderAccount | null {
	if (!account.id || !account.provider) return null;
	const provider = isRouterProviderKeyId(account.provider)
		? account.provider
		: null;
	if (!provider) return null;
	const now = new Date().toISOString();
	const authType = normalizeProviderAccountAuthType(account.authType);
	return {
		id: String(account.id),
		provider,
		name: account.name?.trim() || `${provider} account`,
		authType,
		email: typeof account.email === "string" ? account.email : null,
		expiresAt: typeof account.expiresAt === "string" ? account.expiresAt : null,
		providerSpecificData:
			account.providerSpecificData &&
			typeof account.providerSpecificData === "object" &&
			!Array.isArray(account.providerSpecificData)
				? account.providerSpecificData
				: {},
		priority:
			typeof account.priority === "number"
				? Math.max(1, Math.round(account.priority))
				: 1,
		isActive: account.isActive !== false,
		createdAt: account.createdAt || now,
		updatedAt: account.updatedAt || now,
		lastUsedAt: account.lastUsedAt ?? null,
		consecutiveUseCount:
			typeof account.consecutiveUseCount === "number"
				? account.consecutiveUseCount
				: 0,
		requestCount:
			typeof account.requestCount === "number" ? account.requestCount : 0,
		failureCount:
			typeof account.failureCount === "number" ? account.failureCount : 0,
		backoffLevel:
			typeof account.backoffLevel === "number" ? account.backoffLevel : 0,
		rateLimitedUntil:
			typeof account.rateLimitedUntil === "string"
				? account.rateLimitedUntil
				: null,
		lastError:
			account.lastError &&
			typeof account.lastError === "object" &&
			typeof account.lastError.message === "string"
				? {
						status:
							typeof account.lastError.status === "number"
								? account.lastError.status
								: undefined,
						message: account.lastError.message,
						timestamp:
							typeof account.lastError.timestamp === "string"
								? account.lastError.timestamp
								: now,
					}
				: null,
	};
}

function normalizeProviderAccountAuthType(
	value: unknown,
): RouterProviderAccountAuthType {
	if (value === "oauth" || value === "access-token") return value;
	return "api-key";
}

function isCooldownActive(rateLimitedUntil: string | null): boolean {
	if (!rateLimitedUntil) return false;
	return new Date(rateLimitedUntil).getTime() > Date.now();
}

function sanitizeProviderAccountUpdates(
	updates: Partial<RouterProviderAccount>,
): Partial<RouterProviderAccount> {
	const sanitized = Object.fromEntries(
		Object.entries(updates).filter(([, value]) => value !== undefined),
	) as Partial<RouterProviderAccount>;
	if (sanitized.name !== undefined) {
		sanitized.name = sanitized.name.trim();
	}
	if (sanitized.priority !== undefined) {
		sanitized.priority = Math.max(1, Math.round(sanitized.priority));
	}
	if (sanitized.authType !== undefined) {
		sanitized.authType = normalizeProviderAccountAuthType(sanitized.authType);
	}
	if (
		sanitized.providerSpecificData !== undefined &&
		(!sanitized.providerSpecificData ||
			typeof sanitized.providerSpecificData !== "object" ||
			Array.isArray(sanitized.providerSpecificData))
	) {
		sanitized.providerSpecificData = {};
	}
	return sanitized;
}
