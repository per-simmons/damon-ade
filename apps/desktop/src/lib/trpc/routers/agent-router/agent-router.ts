import { classifyFallbackError } from "@superset/shared/agent-router";
import {
	buildRouterDashboardSnapshot,
	previewRouterTokenSaver,
	ROUTER_MODEL_KINDS,
	ROUTER_PROVIDER_KEY_IDS,
	ROUTER_PROXY_POOL_TYPES,
	TOKEN_SAVER_MODES,
} from "@superset/shared/router-control-plane";
import {
	createRouterProviderAccount,
	deleteRouterProviderAccount,
	listRouterProviderAccountViews,
	updateRouterProviderAccount,
} from "main/lib/agent-router-accounts";
import {
	beginRouterOAuthAuthorization,
	cancelAgentCoordinatorRun,
	completeRouterOAuthAuthorization,
	discoverRouterProviderNodeModels,
	getAgentCoordinatorEvents,
	getAgentCoordinatorRun,
	getAgentRouterGatewayStatus,
	getRouterSubscriptionStatuses,
	listAgentCoordinatorRuns,
	refreshRouterProviderAccount,
	removeAgentCoordinatorRun,
	startAgentCoordinatorRun,
	startAgentRouterGateway,
	stopAgentRouterGateway,
	testRouterModel,
	testRouterProxyPool,
	validateRouterProviderNode,
} from "main/lib/agent-router-gateway";
import {
	clearRouterUsage,
	createRouterProviderNode,
	createRouterProxyPool,
	deleteRouterAlias,
	deleteRouterCustomCombo,
	deleteRouterCustomModel,
	deleteRouterProviderNode,
	deleteRouterProxyPool,
	disableRouterModels,
	enableRouterModels,
	getRouterAliases,
	getRouterCustomCombos,
	getRouterCustomModels,
	getRouterDefaultPricing,
	getRouterDisabledModels,
	getRouterModelAvailability,
	getRouterPricing,
	getRouterProviderNodes,
	getRouterProxyPoolById,
	getRouterProxyPools,
	getRouterSettings,
	getRouterUsageStats,
	resetRouterPricing,
	updateRouterPricing,
	updateRouterProviderNode,
	updateRouterProxyPool,
	updateRouterSettings,
	upsertRouterAlias,
	upsertRouterCustomCombo,
	upsertRouterCustomModel,
} from "main/lib/agent-router-store";
import { getProviderKeyStatus } from "main/lib/provider-keys";
import { z } from "zod";
import { publicProcedure, router } from "../..";

const tokenSaverModeSchema = z.enum(TOKEN_SAVER_MODES);
const routerModelKindSchema = z.enum(ROUTER_MODEL_KINDS);
const proxyPoolTypeSchema = z.enum(ROUTER_PROXY_POOL_TYPES);
const providerKeySchema = z.enum(ROUTER_PROVIDER_KEY_IDS);
const providerAccountAuthTypeSchema = z.enum([
	"api-key",
	"oauth",
	"access-token",
]);
const providerNodeTypeSchema = z.enum([
	"openai-compatible",
	"anthropic-compatible",
	"custom-embedding",
]);
const providerSpecificDataSchema = z.record(z.string(), z.unknown());
const providerNodeApiTypeSchema = z.enum(["chat", "responses"]);
const providerNodeInputSchema = z.object({
	apiKey: z.string().optional(),
	apiKeyAccountId: z.string().nullable().optional(),
	apiKeyProvider: providerKeySchema.optional(),
	apiType: providerNodeApiTypeSchema.optional(),
	baseUrl: z.string().min(1).optional(),
	isActive: z.boolean().optional(),
	models: z.array(z.string()).optional(),
	name: z.string().min(1).optional(),
	prefix: z.string().min(1).optional(),
	type: providerNodeTypeSchema.optional(),
});
const providerNodeValidationInputSchema = providerNodeInputSchema.extend({
	apply: z.boolean().optional(),
	id: z.string().min(1).optional(),
	modelId: z.string().optional(),
});
const pricingRateSchema = z.object({
	input: z.number().nonnegative().optional(),
	output: z.number().nonnegative().optional(),
	cached: z.number().nonnegative().optional(),
	reasoning: z.number().nonnegative().optional(),
	cache_creation: z.number().nonnegative().optional(),
});
const pricingTableSchema = z.record(
	z.string(),
	z.record(z.string(), pricingRateSchema),
);
const proxyPoolInputSchema = z.object({
	name: z.string().min(1),
	proxyUrl: z.string().min(1),
	noProxy: z.string().optional(),
	type: proxyPoolTypeSchema.default("http"),
	isActive: z.boolean().optional(),
	strictProxy: z.boolean().optional(),
});
const proxyPoolUpdateSchema = proxyPoolInputSchema.partial().extend({
	id: z.string().min(1),
});
const coordinatorBriefSchema = z.object({
	id: z.string().min(1),
	objective: z.string().min(1),
	role: z.string().optional(),
	context: z.unknown().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});
const coordinatorRunSchema = z.object({
	id: z.string().min(1).optional(),
	objective: z.string().min(1),
	briefs: z.array(coordinatorBriefSchema).max(16),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

export const createAgentRouterRouter = () => {
	return router({
		dashboard: publicProcedure.query(() =>
			buildRouterDashboardSnapshot({
				providerKeyStatus: getProviderKeyStatus(),
				gateway: getAgentRouterGatewayStatus(),
			}),
		),

		gatewayStatus: publicProcedure.query(() => getAgentRouterGatewayStatus()),

		coordinatorRuns: publicProcedure.query(() => listAgentCoordinatorRuns()),

		coordinatorRun: publicProcedure
			.input(z.object({ id: z.string().min(1) }))
			.query(({ input }) => getAgentCoordinatorRun(input.id) ?? null),

		coordinatorEvents: publicProcedure
			.input(
				z.object({
					id: z.string().min(1),
					afterSequence: z.number().int().min(0).default(0),
				}),
			)
			.query(({ input }) =>
				getAgentCoordinatorEvents(input.id, input.afterSequence),
			),

		startCoordinatorRun: publicProcedure
			.input(coordinatorRunSchema)
			.mutation(({ input }) => startAgentCoordinatorRun(input)),

		cancelCoordinatorRun: publicProcedure
			.input(z.object({ id: z.string().min(1) }))
			.mutation(({ input }) => ({
				cancelled: cancelAgentCoordinatorRun(input.id),
			})),

		removeCoordinatorRun: publicProcedure
			.input(z.object({ id: z.string().min(1) }))
			.mutation(({ input }) => ({
				removed: removeAgentCoordinatorRun(input.id),
			})),

		subscriptionStatuses: publicProcedure.query(() =>
			getRouterSubscriptionStatuses(),
		),

		startGateway: publicProcedure.mutation(() => startAgentRouterGateway()),

		stopGateway: publicProcedure.mutation(async () => {
			await stopAgentRouterGateway();
			return getAgentRouterGatewayStatus();
		}),

		restartGateway: publicProcedure.mutation(async () => {
			await stopAgentRouterGateway();
			return startAgentRouterGateway();
		}),

		providerAccounts: publicProcedure
			.input(z.object({ provider: providerKeySchema.optional() }).optional())
			.query(({ input }) => listRouterProviderAccountViews(input?.provider)),

		beginOAuth: publicProcedure
			.input(z.object({ providerId: z.enum(["claude", "codex", "gemini"]) }))
			.mutation(({ input }) => beginRouterOAuthAuthorization(input.providerId)),

		completeOAuth: publicProcedure
			.input(
				z.object({
					providerId: z.enum(["claude", "codex", "gemini"]),
					rawCode: z.string().min(1),
					codeVerifier: z.string().nullable().optional(),
					redirectUri: z.string().url(),
					expectedState: z.string().min(1),
				}),
			)
			.mutation(({ input }) => completeRouterOAuthAuthorization(input)),

		createProviderAccount: publicProcedure
			.input(
				z.object({
					provider: providerKeySchema,
					name: z.string().optional(),
					key: z.string().min(1),
					authType: providerAccountAuthTypeSchema.optional(),
					email: z.string().nullable().optional(),
					expiresAt: z.string().nullable().optional(),
					idToken: z.string().nullable().optional(),
					providerSpecificData: providerSpecificDataSchema.optional(),
					refreshToken: z.string().nullable().optional(),
				}),
			)
			.mutation(({ input }) => createRouterProviderAccount(input)),

		updateProviderAccount: publicProcedure
			.input(
				z.object({
					id: z.string().min(1),
					name: z.string().optional(),
					key: z.string().optional(),
					authType: providerAccountAuthTypeSchema.optional(),
					email: z.string().nullable().optional(),
					expiresAt: z.string().nullable().optional(),
					idToken: z.string().nullable().optional(),
					isActive: z.boolean().optional(),
					priority: z.number().int().positive().optional(),
					providerSpecificData: providerSpecificDataSchema.optional(),
					refreshToken: z.string().nullable().optional(),
				}),
			)
			.mutation(({ input }) => updateRouterProviderAccount(input)),

		deleteProviderAccount: publicProcedure
			.input(z.object({ id: z.string().min(1) }))
			.mutation(({ input }) => deleteRouterProviderAccount(input.id)),

		refreshProviderAccount: publicProcedure
			.input(
				z.object({
					force: z.boolean().optional(),
					id: z.string().min(1),
				}),
			)
			.mutation(({ input }) => refreshRouterProviderAccount(input)),

		usageStats: publicProcedure.query(() => getRouterUsageStats()),

		clearUsage: publicProcedure.mutation(() => clearRouterUsage()),

		pricing: publicProcedure.query(() => getRouterPricing()),

		defaultPricing: publicProcedure.query(() => getRouterDefaultPricing()),

		updatePricing: publicProcedure
			.input(pricingTableSchema)
			.mutation(({ input }) => updateRouterPricing(input)),

		resetPricing: publicProcedure
			.input(
				z
					.object({
						provider: z.string().optional(),
						model: z.string().optional(),
					})
					.optional(),
			)
			.mutation(({ input }) => resetRouterPricing(input)),

		proxyPools: publicProcedure
			.input(z.object({ isActive: z.boolean().optional() }).optional())
			.query(({ input }) => getRouterProxyPools(input ?? {})),

		createProxyPool: publicProcedure
			.input(proxyPoolInputSchema)
			.mutation(({ input }) => createRouterProxyPool(input)),

		updateProxyPool: publicProcedure
			.input(proxyPoolUpdateSchema)
			.mutation(({ input }) => {
				const { id, ...updates } = input;
				const updated = updateRouterProxyPool(id, updates);
				if (!updated) throw new Error("Proxy pool not found");
				return updated;
			}),

		deleteProxyPool: publicProcedure
			.input(z.object({ id: z.string().min(1) }))
			.mutation(({ input }) => {
				const deleted = deleteRouterProxyPool(input.id);
				if (!deleted) throw new Error("Proxy pool not found");
				return { success: true };
			}),

		testProxyPool: publicProcedure
			.input(
				z.object({
					id: z.string().min(1),
					testUrl: z.string().optional(),
					timeoutMs: z.number().int().positive().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				const proxyPool = getRouterProxyPoolById(input.id);
				if (!proxyPool) throw new Error("Proxy pool not found");
				const result = await testRouterProxyPool(proxyPool, input);
				updateRouterProxyPool(proxyPool.id, {
					isActive: result.ok,
					lastError: result.error,
					lastTestedAt: result.testedAt,
					testStatus: result.ok ? "active" : "error",
				});
				return result;
			}),

		aliases: publicProcedure.query(() => getRouterAliases()),

		upsertAlias: publicProcedure
			.input(
				z.object({
					alias: z.string().min(1),
					targetModel: z.string().min(1),
				}),
			)
			.mutation(({ input }) => upsertRouterAlias(input)),

		deleteAlias: publicProcedure
			.input(z.object({ alias: z.string().min(1) }))
			.mutation(({ input }) => deleteRouterAlias(input.alias)),

		customCombos: publicProcedure.query(() => getRouterCustomCombos()),

		customModels: publicProcedure.query(() => getRouterCustomModels()),

		upsertCustomModel: publicProcedure
			.input(
				z.object({
					providerAlias: z.string().min(1),
					id: z.string().min(1),
					type: routerModelKindSchema.default("llm"),
					name: z.string().optional(),
				}),
			)
			.mutation(({ input }) => upsertRouterCustomModel(input)),

		deleteCustomModel: publicProcedure
			.input(
				z.object({
					providerAlias: z.string().min(1),
					id: z.string().min(1),
					type: routerModelKindSchema.default("llm"),
				}),
			)
			.mutation(({ input }) => deleteRouterCustomModel(input)),

		disabledModels: publicProcedure
			.input(z.object({ providerAlias: z.string().optional() }).optional())
			.query(({ input }) => getRouterDisabledModels(input?.providerAlias)),

		disableModels: publicProcedure
			.input(
				z.object({
					providerAlias: z.string().min(1),
					ids: z.array(z.string().min(1)).min(1),
					reason: z.string().optional(),
				}),
			)
			.mutation(({ input }) => disableRouterModels(input)),

		enableModels: publicProcedure
			.input(
				z.object({
					providerAlias: z.string().min(1),
					ids: z.array(z.string().min(1)).optional(),
				}),
			)
			.mutation(({ input }) => enableRouterModels(input)),

		modelAvailability: publicProcedure.query(() =>
			getRouterModelAvailability(),
		),

		testModel: publicProcedure
			.input(
				z.object({
					model: z.string().min(1),
					kind: routerModelKindSchema.default("llm"),
				}),
			)
			.mutation(({ input }) => testRouterModel(input)),

		providerNodes: publicProcedure
			.input(z.object({ type: providerNodeTypeSchema.optional() }).optional())
			.query(({ input }) => getRouterProviderNodes(input?.type)),

		createProviderNode: publicProcedure
			.input(
				providerNodeInputSchema.extend({
					baseUrl: z.string().min(1),
					name: z.string().min(1),
					prefix: z.string().min(1),
				}),
			)
			.mutation(({ input }) => createRouterProviderNode(input)),

		updateProviderNode: publicProcedure
			.input(
				providerNodeInputSchema.extend({
					id: z.string().min(1),
				}),
			)
			.mutation(({ input }) => {
				const { id, ...updates } = input;
				return updateRouterProviderNode(id, updates);
			}),

		deleteProviderNode: publicProcedure
			.input(z.object({ id: z.string().min(1) }))
			.mutation(({ input }) => deleteRouterProviderNode(input.id)),

		validateProviderNode: publicProcedure
			.input(providerNodeValidationInputSchema)
			.mutation(({ input }) => validateRouterProviderNode(input)),

		discoverProviderNodeModels: publicProcedure
			.input(providerNodeValidationInputSchema)
			.mutation(({ input }) => discoverRouterProviderNodeModels(input)),

		upsertCustomCombo: publicProcedure
			.input(
				z.object({
					name: z.string().min(1),
					models: z.array(z.string().min(1)).min(1),
				}),
			)
			.mutation(({ input }) => upsertRouterCustomCombo(input)),

		deleteCustomCombo: publicProcedure
			.input(z.object({ name: z.string().min(1) }))
			.mutation(({ input }) => deleteRouterCustomCombo(input.name)),

		previewTokenSaver: publicProcedure
			.input(
				z.object({
					text: z.string(),
					mode: tokenSaverModeSchema.default("rtk"),
				}),
			)
			.mutation(({ input }) =>
				previewRouterTokenSaver({
					text: input.text,
					mode: input.mode,
				}),
			),

		tokenSaverSettings: publicProcedure.query(() => getRouterSettings()),

		updateTokenSaverSettings: publicProcedure
			.input(
				z.object({
					rtkEnabled: z.boolean().optional(),
					headroomEnabled: z.boolean().optional(),
					headroomCompressUserMessages: z.boolean().optional(),
					headroomUrl: z.string().url().optional(),
					cavemanEnabled: z.boolean().optional(),
					cavemanLevel: z.enum(["lite", "full", "ultra"]).optional(),
					ponytailEnabled: z.boolean().optional(),
					ponytailLevel: z.enum(["lite", "full", "ultra"]).optional(),
				}),
			)
			.mutation(({ input }) => updateRouterSettings(input)),

		classifyFallback: publicProcedure
			.input(
				z.object({
					status: z.number().int().optional(),
					text: z.string().optional(),
					backoffLevel: z.number().int().min(0).default(0),
				}),
			)
			.query(({ input }) => classifyFallbackError(input)),
	});
};

export type AgentRouterRouter = ReturnType<typeof createAgentRouterRouter>;
