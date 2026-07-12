import {
	previewRouterTokenSaver,
	ROUTER_MODEL_KINDS,
	ROUTER_PROVIDER_KEY_IDS,
	ROUTER_PROXY_POOL_TYPES,
	type RouterCustomModel,
	type RouterDashboardSnapshot,
	type RouterDisabledModel,
	type RouterModelAvailabilityEntry,
	type RouterModelKind,
	type RouterModelTestResult,
	type RouterPricingTable,
	type RouterProviderAccount,
	type RouterProviderAccountAuthType,
	type RouterProviderKeyId,
	type RouterProviderNode,
	type RouterProviderNodeType,
	type RouterProxyPool,
	type RouterProxyPoolType,
	type RouterTokenSaverMode,
} from "@superset/shared/router-control-plane";
import { cn } from "@superset/ui/utils";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import {
	LuActivity,
	LuAudioLines,
	LuBadgeCheck,
	LuBookOpen,
	LuCheck,
	LuChevronDown,
	LuCopy,
	LuExternalLink,
	LuGauge,
	LuImage,
	LuKeyRound,
	LuListChecks,
	LuNetwork,
	LuPlay,
	LuRoute,
	LuSearch,
	LuSettings2,
	LuShieldAlert,
	LuSparkles,
} from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";

export const Route = createFileRoute("/_authenticated/_dashboard/router/")({
	component: RouterDashboardPage,
});

type TabId =
	| "overview"
	| "coordinator"
	| "guide"
	| "providers"
	| "nodes"
	| "models"
	| "pricing"
	| "proxies"
	| "combos"
	| "endpoints"
	| "token-savers"
	| "fallback"
	| "usage"
	| "aliases";

type ProviderAccountView = RouterProviderAccount & {
	hasIdToken: boolean;
	hasKey: boolean;
	hasRefreshToken: boolean;
};
type ProviderAccountInput = {
	authType?: RouterProviderAccountAuthType;
	email?: string | null;
	expiresAt?: string | null;
	idToken?: string | null;
	key: string;
	name?: string;
	provider: RouterProviderKeyId;
	providerSpecificData?: Record<string, unknown>;
	refreshToken?: string | null;
};
type ProviderAccountUpdates = {
	authType?: RouterProviderAccountAuthType;
	email?: string | null;
	expiresAt?: string | null;
	idToken?: string | null;
	isActive?: boolean;
	key?: string;
	name?: string;
	priority?: number;
	providerSpecificData?: Record<string, unknown>;
	refreshToken?: string | null;
};
type ProviderNodeValidationState = {
	valid: boolean;
	error?: string;
	method?: string;
	models?: Array<{ id: string; name: string }>;
} | null;
type ProviderNodeDiscoveryState = {
	ok: boolean;
	error?: string;
	models: Array<{ id: string; name: string }>;
} | null;

const SIMPLE_TABS: { id: TabId; label: string }[] = [
	{ id: "overview", label: "Start" },
	{ id: "coordinator", label: "Coordinator" },
	{ id: "guide", label: "Guia" },
	{ id: "providers", label: "Accounts" },
	{ id: "combos", label: "Agent teams" },
	{ id: "usage", label: "Usage" },
];

const ADVANCED_TABS: { id: TabId; label: string }[] = [
	{ id: "nodes", label: "Nodes" },
	{ id: "models", label: "Models" },
	{ id: "pricing", label: "Pricing" },
	{ id: "proxies", label: "Proxies" },
	{ id: "endpoints", label: "Endpoints" },
	{ id: "token-savers", label: "Token Saver" },
	{ id: "fallback", label: "Fallback" },
	{ id: "aliases", label: "Aliases" },
];

type OAuthProviderId = "claude" | "codex" | "gemini";
type OAuthSession = {
	providerId: OAuthProviderId;
	providerLabel: string;
	authUrl: string;
	codeVerifier: string | null;
	redirectUri: string;
	state: string;
	instructions: string;
};
type SubscriptionStatus = {
	installed: boolean;
	authenticated: boolean;
	plan: string | null;
};

const SAMPLE_TOKEN_INPUT = [
	"Sure, here is the build output:",
	"npm warn deprecated left-pad@1.3.0",
	"Compiling packages/shared/src/router-control-plane.ts",
	"Successfully built package @superset/shared",
	"ERROR: src/app/example.ts:42: missing provider mapping",
	"Here are the next steps I will take.",
	...Array.from(
		{ length: 90 },
		(_, index) => `packages/example/file-${index}.ts:12:sample match ${index}`,
	),
	"Finished with 1 warning and 1 actionable error.",
].join("\n");

function RouterDashboardPage() {
	const [activeTab, setActiveTab] = useState<TabId>("overview");
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [oauthSession, setOAuthSession] = useState<OAuthSession | null>(null);
	const [oauthCode, setOAuthCode] = useState("");
	const [oauthError, setOAuthError] = useState<string | null>(null);
	const utils = electronTrpc.useUtils();
	const { data, isLoading, error } =
		electronTrpc.agentRouter.dashboard.useQuery(undefined, {
			refetchInterval: 15_000,
		});
	const providerAccounts = electronTrpc.agentRouter.providerAccounts.useQuery(
		undefined,
		{
			refetchInterval: 15_000,
		},
	);
	const subscriptionStatuses =
		electronTrpc.agentRouter.subscriptionStatuses.useQuery();
	const invalidateRouter = () => {
		utils.agentRouter.dashboard.invalidate();
		utils.agentRouter.providerAccounts.invalidate();
	};
	const invalidateDashboard = () => utils.agentRouter.dashboard.invalidate();
	const startGateway = electronTrpc.agentRouter.startGateway.useMutation({
		onSuccess: invalidateDashboard,
	});
	const stopGateway = electronTrpc.agentRouter.stopGateway.useMutation({
		onSuccess: invalidateDashboard,
	});
	const restartGateway = electronTrpc.agentRouter.restartGateway.useMutation({
		onSuccess: invalidateDashboard,
	});
	const setProviderKey = electronTrpc.settings.providerKeys.set.useMutation({
		onSuccess: invalidateDashboard,
	});
	const clearProviderKey = electronTrpc.settings.providerKeys.clear.useMutation(
		{
			onSuccess: invalidateDashboard,
		},
	);
	const createProviderAccount =
		electronTrpc.agentRouter.createProviderAccount.useMutation({
			onSuccess: invalidateRouter,
		});
	const updateProviderAccount =
		electronTrpc.agentRouter.updateProviderAccount.useMutation({
			onSuccess: invalidateRouter,
		});
	const refreshProviderAccount =
		electronTrpc.agentRouter.refreshProviderAccount.useMutation({
			onSuccess: invalidateRouter,
		});
	const deleteProviderAccount =
		electronTrpc.agentRouter.deleteProviderAccount.useMutation({
			onSuccess: invalidateRouter,
		});
	const beginOAuth = electronTrpc.agentRouter.beginOAuth.useMutation();
	const completeOAuth = electronTrpc.agentRouter.completeOAuth.useMutation({
		onSuccess: invalidateRouter,
	});

	const startOAuth = async (providerId: OAuthProviderId) => {
		setOAuthError(null);
		try {
			const session = await beginOAuth.mutateAsync({ providerId });
			setOAuthSession(session);
			setOAuthCode("");
			window.open(session.authUrl, "_blank", "noopener,noreferrer");
		} catch (oauthStartError) {
			setOAuthError(errorMessage(oauthStartError));
		}
	};

	const finishOAuth = async () => {
		if (!oauthSession || !oauthCode.trim()) return;
		setOAuthError(null);
		try {
			await completeOAuth.mutateAsync({
				providerId: oauthSession.providerId,
				rawCode: oauthCode.trim(),
				codeVerifier: oauthSession.codeVerifier,
				redirectUri: oauthSession.redirectUri,
				expectedState: oauthSession.state,
			});
			setOAuthSession(null);
			setOAuthCode("");
		} catch (oauthCompletionError) {
			setOAuthError(errorMessage(oauthCompletionError));
		}
	};

	if (isLoading) {
		return (
			<main className="flex-1 overflow-hidden bg-background">
				<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
					Loading router control plane...
				</div>
			</main>
		);
	}

	if (error || !data) {
		return (
			<main className="flex-1 overflow-hidden bg-background">
				<div className="flex h-full items-center justify-center text-sm text-destructive">
					Could not load router dashboard.
				</div>
			</main>
		);
	}

	return (
		<main className="flex-1 overflow-y-auto bg-background">
			<div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-6 py-5">
				<header className="flex flex-wrap items-start justify-between gap-4">
					<div className="min-w-0">
						<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
							<LuRoute className="size-4" />
							ADE smart router
						</div>
						<h1 className="mt-2 text-2xl font-semibold tracking-tight">
							AI team
						</h1>
						<p className="mt-1 max-w-3xl text-sm text-muted-foreground">
							Connect your subscriptions once. Fable 5 coordinates the best
							specialist for each job and falls back automatically.
						</p>
					</div>
					<div className="flex min-w-72 flex-col gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
						<div className="flex items-center justify-between gap-3">
							<span className="font-medium text-foreground">
								Gateway {data.gateway?.running ? "running" : "stopped"}
							</span>
							<span
								className={cn(
									"rounded px-1.5 py-0.5",
									data.gateway?.running
										? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
										: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
								)}
							>
								{data.gateway?.running ? "live" : "offline"}
							</span>
						</div>
						<div className="truncate font-mono text-muted-foreground">
							{data.gateway?.url ?? "http://127.0.0.1:20128"}
						</div>
						<div className="flex gap-2">
							<button
								type="button"
								onClick={() => startGateway.mutate()}
								disabled={data.gateway?.running || startGateway.isPending}
								className="rounded border px-2 py-1 text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
							>
								Start
							</button>
							<button
								type="button"
								onClick={() => restartGateway.mutate()}
								disabled={restartGateway.isPending}
								className="rounded border px-2 py-1 text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
							>
								Restart
							</button>
							<button
								type="button"
								onClick={() => stopGateway.mutate()}
								disabled={!data.gateway?.running || stopGateway.isPending}
								className="rounded border px-2 py-1 text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
							>
								Stop
							</button>
						</div>
						<div className="text-muted-foreground">
							Updated {new Date(data.generatedAt).toLocaleTimeString()}
						</div>
					</div>
				</header>

				<nav className="flex flex-wrap items-center gap-2 border-b pb-3">
					{[...SIMPLE_TABS, ...(showAdvanced ? ADVANCED_TABS : [])].map(
						(tab) => (
							<button
								key={tab.id}
								type="button"
								onClick={() => setActiveTab(tab.id)}
								className={cn(
									"rounded-md px-3 py-1.5 text-sm transition-colors",
									activeTab === tab.id
										? "bg-foreground text-background"
										: "text-muted-foreground hover:bg-muted hover:text-foreground",
								)}
							>
								{tab.label}
							</button>
						),
					)}
					<button
						type="button"
						onClick={() => {
							setShowAdvanced((current) => !current);
							if (
								showAdvanced &&
								ADVANCED_TABS.some((tab) => tab.id === activeTab)
							) {
								setActiveTab("overview");
							}
						}}
						className="ml-auto inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						<LuSettings2 className="size-4" />
						Advanced
						<LuChevronDown
							className={cn(
								"size-3.5 transition-transform",
								showAdvanced && "rotate-180",
							)}
						/>
					</button>
				</nav>

				{activeTab === "overview" && (
					<QuickStartTab
						accounts={providerAccounts.data ?? []}
						beginOAuth={startOAuth}
						completeOAuth={finishOAuth}
						data={data}
						isOAuthBusy={beginOAuth.isPending || completeOAuth.isPending}
						oauthCode={oauthCode}
						oauthError={oauthError}
						oauthSession={oauthSession}
						openAccounts={() => setActiveTab("providers")}
						setOAuthCode={setOAuthCode}
						subscriptionStatuses={subscriptionStatuses.data}
					/>
				)}
				{activeTab === "coordinator" && <CoordinatorTab />}
				{activeTab === "guide" && (
					<GuideTab
						openAccounts={() => setActiveTab("providers")}
						openStart={() => setActiveTab("overview")}
						openTeams={() => setActiveTab("combos")}
					/>
				)}
				{activeTab === "providers" && (
					<ProvidersTab
						data={data}
						clearProviderKey={(provider) =>
							clearProviderKey.mutateAsync({ provider })
						}
						createProviderAccount={(input) =>
							createProviderAccount.mutateAsync(input)
						}
						deleteProviderAccount={(id) =>
							deleteProviderAccount.mutateAsync({ id })
						}
						isSavingKey={setProviderKey.isPending || clearProviderKey.isPending}
						isSavingProviderAccount={
							createProviderAccount.isPending ||
							updateProviderAccount.isPending ||
							refreshProviderAccount.isPending ||
							deleteProviderAccount.isPending
						}
						providerAccounts={providerAccounts.data ?? []}
						refreshProviderAccount={(id) =>
							refreshProviderAccount.mutateAsync({ force: true, id })
						}
						setProviderKey={(provider, key) =>
							setProviderKey.mutateAsync({ provider, key })
						}
						updateProviderAccount={(id, updates) =>
							updateProviderAccount.mutateAsync({ id, ...updates })
						}
					/>
				)}
				{activeTab === "nodes" && <NodesTab />}
				{activeTab === "models" && <ModelsTab />}
				{activeTab === "pricing" && <PricingTab />}
				{activeTab === "proxies" && <ProxiesTab />}
				{activeTab === "combos" && <CombosTab data={data} />}
				{activeTab === "endpoints" && <EndpointsTab data={data} />}
				{activeTab === "token-savers" && <TokenSaversTab data={data} />}
				{activeTab === "fallback" && <FallbackTab data={data} />}
				{activeTab === "usage" && <UsageTab />}
				{activeTab === "aliases" && <AliasesTab />}
			</div>
		</main>
	);
}

function QuickStartTab({
	accounts,
	beginOAuth,
	completeOAuth,
	data,
	isOAuthBusy,
	oauthCode,
	oauthError,
	oauthSession,
	openAccounts,
	setOAuthCode,
	subscriptionStatuses,
}: {
	accounts: ProviderAccountView[];
	beginOAuth: (providerId: OAuthProviderId) => Promise<void>;
	completeOAuth: () => Promise<void>;
	data: RouterDashboardSnapshot;
	isOAuthBusy: boolean;
	oauthCode: string;
	oauthError: string | null;
	oauthSession: OAuthSession | null;
	openAccounts: () => void;
	setOAuthCode: (value: string) => void;
	subscriptionStatuses?: Record<OAuthProviderId, SubscriptionStatus>;
}) {
	const providers: Array<{
		id: OAuthProviderId;
		keyProvider: RouterProviderKeyId;
		label: string;
		models: string;
		note: string;
	}> = [
		{
			id: "claude",
			keyProvider: "anthropic",
			label: "Claude",
			models: "Fable 5 + Sonnet 5",
			note: "Coordinator and final judge",
		},
		{
			id: "codex",
			keyProvider: "openai",
			label: "ChatGPT / Codex",
			models: "GPT-5.5 + GPT-5.4 mini",
			note: "Implementation and debugging",
		},
		{
			id: "gemini",
			keyProvider: "gemini",
			label: "Google",
			models: "Gemini 3.5 Flash",
			note: "Research and large context. Sign-in is managed by Gemini CLI.",
		},
	];
	const recommendedCombos = data.combos.filter((combo) =>
		[
			"fable-orchestrated",
			"premium-coding",
			"precision-debug",
			"deep-research",
		].includes(combo.name),
	);

	return (
		<div className="grid gap-5">
			<section>
				<div className="mb-3 flex items-center gap-2">
					<span className="flex size-6 items-center justify-center rounded bg-foreground text-xs font-semibold text-background">
						1
					</span>
					<h2 className="text-sm font-semibold">Connect subscriptions</h2>
				</div>
				<div className="grid gap-3 md:grid-cols-3">
					{providers.map((provider) => {
						const nativeStatus = subscriptionStatuses?.[provider.id];
						const connected =
							nativeStatus?.authenticated === true ||
							accounts.some(
								(account) =>
									account.provider === provider.keyProvider && account.isActive,
							);
						return (
							<div key={provider.id} className="rounded-lg border bg-card p-4">
								<div className="flex items-start justify-between gap-3">
									<div>
										<div className="text-sm font-semibold">
											{provider.label}
										</div>
										<div className="mt-1 text-xs text-muted-foreground">
											{provider.models}
										</div>
									</div>
									{connected && (
										<span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
											<LuBadgeCheck className="size-3.5" />
											{nativeStatus?.plan
												? `${nativeStatus.plan} connected`
												: "Connected"}
										</span>
									)}
								</div>
								<p className="mt-3 text-xs text-muted-foreground">
									{provider.note}
								</p>
								<button
									type="button"
									onClick={() => {
										if (provider.id === "gemini") {
											window.open(
												"https://github.com/google-gemini/gemini-cli",
												"_blank",
												"noopener,noreferrer",
											);
											return;
										}
										beginOAuth(provider.id);
									}}
									disabled={isOAuthBusy}
									className="mt-4 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium enabled:hover:bg-muted disabled:opacity-50"
								>
									<LuExternalLink className="size-3.5" />
									{connected
										? "Reconnect"
										: provider.id === "gemini"
											? "Set up Gemini CLI"
											: "Connect"}
								</button>
							</div>
						);
					})}
				</div>

				{oauthSession && (
					<div className="mt-3 rounded-lg border bg-card p-4">
						<div className="text-sm font-semibold">
							Finish {oauthSession.providerLabel} login
						</div>
						<p className="mt-1 text-xs text-muted-foreground">
							{oauthSession.instructions}
						</p>
						<div className="mt-3 flex flex-col gap-2 sm:flex-row">
							<input
								value={oauthCode}
								onChange={(event) => setOAuthCode(event.target.value)}
								placeholder="Paste code or callback URL"
								className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
							/>
							<button
								type="button"
								onClick={completeOAuth}
								disabled={isOAuthBusy || !oauthCode.trim()}
								className="rounded-md bg-foreground px-4 py-2 text-sm text-background disabled:opacity-50"
							>
								Finish login
							</button>
						</div>
					</div>
				)}
				{oauthError && (
					<div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
						{oauthError}
					</div>
				)}
			</section>

			<section>
				<div className="mb-3 flex items-center gap-2">
					<span className="flex size-6 items-center justify-center rounded bg-foreground text-xs font-semibold text-background">
						2
					</span>
					<h2 className="text-sm font-semibold">Describe the job</h2>
				</div>
				<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
					{recommendedCombos.map((combo) => (
						<div key={combo.name} className="rounded-lg border bg-card p-4">
							<div className="text-sm font-semibold">
								{simpleComboLabel(combo.name)}
							</div>
							<p className="mt-2 text-xs leading-relaxed text-muted-foreground">
								{combo.description}
							</p>
							<div className="mt-3 flex flex-wrap gap-1.5">
								{combo.agents.map((agent) => (
									<Pill key={`${combo.name}-${agent}`}>{agent}</Pill>
								))}
							</div>
						</div>
					))}
				</div>
			</section>

			<section className="rounded-lg border bg-card p-4">
				<div className="flex flex-wrap items-center justify-between gap-4">
					<div>
						<div className="flex items-center gap-2">
							<span className="flex size-6 items-center justify-center rounded bg-foreground text-xs font-semibold text-background">
								3
							</span>
							<h2 className="text-sm font-semibold">
								Use the Orchestrator agent
							</h2>
						</div>
						<p className="mt-2 text-xs text-muted-foreground">
							Create or open a task and choose Orchestrator. Fable 5 detects the
							intent, loads matching skills, delegates, verifies, and falls back
							automatically.
						</p>
					</div>
					<button
						type="button"
						onClick={openAccounts}
						className="rounded-md border px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						Manage keys and accounts
					</button>
				</div>
			</section>
		</div>
	);
}

function simpleComboLabel(name: string): string {
	if (name === "fable-orchestrated") return "Complex project";
	if (name === "premium-coding") return "Build a feature";
	if (name === "precision-debug") return "Find and fix a bug";
	if (name === "deep-research") return "Research and decide";
	return name;
}

function CoordinatorTab() {
	const [objective, setObjective] = useState("");
	const utils = electronTrpc.useUtils();
	const runs = electronTrpc.agentRouter.coordinatorRuns.useQuery(undefined, {
		refetchInterval: 1000,
	});
	const startRun = electronTrpc.agentRouter.startCoordinatorRun.useMutation({
		onSuccess: () => {
			setObjective("");
			utils.agentRouter.coordinatorRuns.invalidate();
		},
	});
	const cancelRun = electronTrpc.agentRouter.cancelCoordinatorRun.useMutation({
		onSuccess: () => utils.agentRouter.coordinatorRuns.invalidate(),
	});
	const removeRun = electronTrpc.agentRouter.removeCoordinatorRun.useMutation({
		onSuccess: () => utils.agentRouter.coordinatorRuns.invalidate(),
	});
	const sortedRuns = [...(runs.data ?? [])].sort(
		(a, b) => b.createdAt - a.createdAt,
	);

	const submit = () => {
		const task = objective.trim();
		if (!task) return;
		startRun.mutate({
			objective: task,
			metadata: { synthesisModel: "claude-fable-5" },
			briefs: [
				{
					id: "solution",
					role: "implementation specialist",
					objective: `Create the strongest concrete solution for: ${task}`,
					metadata: { model: "claude-sonnet-5" },
				},
				{
					id: "review",
					role: "critical reviewer",
					objective: `Find correctness, security, UX, and regression risks for: ${task}`,
					metadata: { model: "claude-sonnet-5" },
				},
				{
					id: "verification",
					role: "verification specialist",
					objective: `Define decisive evidence and end-to-end validation for: ${task}`,
					metadata: { model: "claude-sonnet-5" },
				},
			],
		});
	};

	return (
		<div className="grid gap-5">
			<section className="rounded-lg border bg-card p-4">
				<div className="flex items-start gap-3">
					<span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
						<LuNetwork className="size-4" />
					</span>
					<div>
						<h2 className="text-sm font-semibold">Run a specialist team</h2>
						<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
							Three Sonnet 5 workers execute focused briefs in parallel. Fable 5
							waits for every report, resolves conflicts, and produces the final
							answer. Your Claude subscription is used first.
						</p>
					</div>
				</div>
				<textarea
					value={objective}
					onChange={(event) => setObjective(event.target.value)}
					placeholder="Describe the outcome, constraints, and how success should be verified..."
					className="mt-4 min-h-28 w-full resize-y rounded-md border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-ring"
				/>
				<div className="mt-3 flex items-center justify-between gap-3">
					<span className="text-xs text-muted-foreground">
						Plan big, execute small, verify once.
					</span>
					<button
						type="button"
						onClick={submit}
						disabled={!objective.trim() || startRun.isPending}
						className="inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
					>
						<LuPlay className="size-4" />
						{startRun.isPending ? "Starting..." : "Start team"}
					</button>
				</div>
				{startRun.error && (
					<p className="mt-3 text-xs text-destructive">
						{errorMessage(startRun.error)}
					</p>
				)}
			</section>

			<section>
				<div className="mb-3 flex items-center justify-between">
					<h2 className="text-sm font-semibold">Team runs</h2>
					<span className="text-xs text-muted-foreground">
						{sortedRuns.length} total
					</span>
				</div>
				{sortedRuns.length === 0 ? (
					<div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
						No coordinator runs yet.
					</div>
				) : (
					<div className="grid gap-3">
						{sortedRuns.map((run) => {
							const terminal = ["completed", "failed", "cancelled"].includes(
								run.status,
							);
							return (
								<div key={run.id} className="rounded-lg border bg-card p-4">
									<div className="flex flex-wrap items-start justify-between gap-3">
										<div className="min-w-0">
											<div className="flex items-center gap-2">
												<h3 className="text-sm font-semibold">
													{run.objective}
												</h3>
												<Pill>{run.status}</Pill>
											</div>
											<p className="mt-1 text-xs text-muted-foreground">
												{run.usage.total.totalTokens.toLocaleString()} tokens
												across the team
											</p>
										</div>
										<button
											type="button"
											onClick={() =>
												terminal
													? removeRun.mutate({ id: run.id })
													: cancelRun.mutate({ id: run.id })
											}
											className="rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
										>
											{terminal ? "Remove" : "Cancel"}
										</button>
									</div>
									<div className="mt-3 flex flex-wrap gap-2">
										{run.workers.map((worker) => (
											<span
												key={worker.brief.id}
												className="rounded-md border bg-background px-2.5 py-1 text-xs"
											>
												{worker.brief.id}: {worker.status}
											</span>
										))}
									</div>
									{run.output?.text && (
										<div className="mt-4 whitespace-pre-wrap rounded-md bg-muted/35 p-3 text-xs leading-relaxed">
											{run.output.text}
										</div>
									)}
									{run.error?.message && (
										<p className="mt-3 text-xs text-destructive">
											{run.error.message}
										</p>
									)}
								</div>
							);
						})}
					</div>
				)}
			</section>
		</div>
	);
}

const GUIDE_PROMPTS = [
	{
		label: "Construir",
		prompt:
			"Implementa [funcionalidade] neste projeto. Mantém os padrões existentes, testa o fluxo completo e mostra-me o resultado final.",
	},
	{
		label: "Corrigir",
		prompt:
			"Reproduz [problema], encontra a causa raiz, faz a correção mais pequena e segura, e executa testes de regressão.",
	},
	{
		label: "Investigar",
		prompt:
			"Pesquisa [decisão ou tecnologia] em fontes oficiais, compara as opções e implementa a recomendação vencedora.",
	},
] as const;

function GuideTab({
	openAccounts,
	openStart,
	openTeams,
}: {
	openAccounts: () => void;
	openStart: () => void;
	openTeams: () => void;
}) {
	const [copiedPrompt, setCopiedPrompt] = useState<string | null>(null);

	const copyPrompt = async (label: string, prompt: string) => {
		try {
			await navigator.clipboard.writeText(prompt);
			setCopiedPrompt(label);
			window.setTimeout(() => setCopiedPrompt(null), 1600);
		} catch {
			setCopiedPrompt(null);
		}
	};

	return (
		<div className="grid gap-6">
			<section className="rounded-lg border bg-foreground p-5 text-background">
				<div className="flex flex-wrap items-start justify-between gap-5">
					<div className="max-w-2xl">
						<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-background/70">
							<LuBookOpen className="size-4" />
							Guia rápido
						</div>
						<h2 className="mt-3 text-xl font-semibold">
							A tua equipa de IA em 60 segundos
						</h2>
						<p className="mt-2 text-sm leading-relaxed text-background/75">
							Pensa na ADE como um router para agentes: ligas as tuas
							subscrições uma vez, descreves o resultado e o Coordinator
							escolhe, delega e verifica por ti.
						</p>
					</div>
					<button
						type="button"
						onClick={openStart}
						className="inline-flex items-center gap-2 rounded-md bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-background/90"
					>
						<LuPlay className="size-4" />
						Começar
					</button>
				</div>
			</section>

			<section>
				<h2 className="text-sm font-semibold">O fluxo normal</h2>
				<div className="mt-3 grid gap-3 md:grid-cols-3">
					{[
						{
							icon: LuKeyRound,
							number: "1",
							title: "Liga as contas",
							text: "Claude, Codex e Gemini. A ADE usa primeiro o que já está incluído nas tuas subscrições.",
						},
						{
							icon: LuSparkles,
							number: "2",
							title: "Escolhe Orchestrator",
							text: "Cria ou abre uma tarefa e seleciona Orchestrator. Não precisas escolher modelos manualmente.",
						},
						{
							icon: LuCheck,
							number: "3",
							title: "Pede o resultado",
							text: "Explica o objetivo e as restrições. O Coordinator planeia, distribui trabalho e valida no fim.",
						},
					].map(({ icon: Icon, number, text, title }) => (
						<div key={number} className="rounded-lg border bg-card p-4">
							<div className="flex items-center justify-between">
								<span className="flex size-8 items-center justify-center rounded-md bg-muted">
									<Icon className="size-4" />
								</span>
								<span className="text-xs font-semibold text-muted-foreground">
									PASSO {number}
								</span>
							</div>
							<h3 className="mt-4 text-sm font-semibold">{title}</h3>
							<p className="mt-2 text-xs leading-relaxed text-muted-foreground">
								{text}
							</p>
						</div>
					))}
				</div>
			</section>

			<section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
				<div>
					<div className="flex items-center gap-2">
						<LuCopy className="size-4 text-muted-foreground" />
						<h2 className="text-sm font-semibold">Pedidos que funcionam bem</h2>
					</div>
					<div className="mt-3 grid gap-2">
						{GUIDE_PROMPTS.map(({ label, prompt }) => (
							<div
								key={label}
								className="flex items-start gap-3 rounded-lg border bg-card p-3"
							>
								<div className="min-w-0 flex-1">
									<div className="text-xs font-semibold">{label}</div>
									<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
										{prompt}
									</p>
								</div>
								<button
									type="button"
									onClick={() => copyPrompt(label, prompt)}
									className="shrink-0 rounded-md border p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
									title={`Copiar pedido: ${label}`}
								>
									{copiedPrompt === label ? (
										<LuCheck className="size-3.5" />
									) : (
										<LuCopy className="size-3.5" />
									)}
								</button>
							</div>
						))}
					</div>
				</div>

				<div className="rounded-lg border bg-card p-4">
					<div className="flex items-center gap-2">
						<LuListChecks className="size-4 text-muted-foreground" />
						<h2 className="text-sm font-semibold">Boas práticas</h2>
					</div>
					<div className="mt-4 grid gap-3 text-xs text-muted-foreground">
						<p>Diz qual é o resultado final, não apenas a ferramenta a usar.</p>
						<p>
							Inclui limites importantes: plataforma, prazo, ficheiros ou custo.
						</p>
						<p>Pede testes e verificação visual quando existe uma interface.</p>
						<p>
							Usa Advanced apenas para routing, APIs ou modelos personalizados.
						</p>
					</div>
					<div className="mt-5 flex flex-wrap gap-2">
						<button
							type="button"
							onClick={openAccounts}
							className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
						>
							Ver contas
						</button>
						<button
							type="button"
							onClick={openTeams}
							className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
						>
							Ver equipas
						</button>
					</div>
				</div>
			</section>

			<section className="border-t pt-5">
				<div className="flex items-center gap-2">
					<LuNetwork className="size-4 text-muted-foreground" />
					<h2 className="text-sm font-semibold">Como o Coordinator trabalha</h2>
				</div>
				<div className="mt-3 grid gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-center">
					<GuideStage
						title="Planeia grande"
						text="Fable 5 entende o objetivo, cria o plano e separa tarefas independentes."
					/>
					<span className="hidden text-muted-foreground md:block">&gt;</span>
					<GuideStage
						title="Executa pequeno"
						text="Workers especializados recebem apenas um brief curto e trabalham em paralelo."
					/>
					<span className="hidden text-muted-foreground md:block">&gt;</span>
					<GuideStage
						title="Verifica tudo"
						text="O Coordinator junta os resultados, resolve conflitos e executa os testes finais."
					/>
				</div>
			</section>
		</div>
	);
}

function GuideStage({ text, title }: { text: string; title: string }) {
	return (
		<div className="rounded-lg border bg-muted/25 px-4 py-3">
			<div className="text-xs font-semibold">{title}</div>
			<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
				{text}
			</p>
		</div>
	);
}

function ProvidersTab({
	data,
	clearProviderKey,
	createProviderAccount,
	deleteProviderAccount,
	isSavingKey,
	isSavingProviderAccount,
	providerAccounts,
	refreshProviderAccount,
	setProviderKey,
	updateProviderAccount,
}: {
	data: RouterDashboardSnapshot;
	clearProviderKey: (provider: RouterProviderKeyId) => Promise<unknown>;
	createProviderAccount: (input: ProviderAccountInput) => Promise<unknown>;
	deleteProviderAccount: (id: string) => Promise<unknown>;
	isSavingKey: boolean;
	isSavingProviderAccount: boolean;
	providerAccounts: ProviderAccountView[];
	refreshProviderAccount: (id: string) => Promise<unknown>;
	setProviderKey: (
		provider: RouterProviderKeyId,
		key: string,
	) => Promise<unknown>;
	updateProviderAccount: (
		id: string,
		updates: ProviderAccountUpdates,
	) => Promise<unknown>;
}) {
	const [inputs, setInputs] = useState<Record<string, string>>({});
	const [pendingProvider, setPendingProvider] = useState<string | null>(null);

	const saveKey = async (provider: RouterProviderKeyId) => {
		const key = inputs[provider]?.trim();
		if (!key) return;
		setPendingProvider(provider);
		try {
			await setProviderKey(provider, key);
			setInputs((current) => ({ ...current, [provider]: "" }));
		} finally {
			setPendingProvider(null);
		}
	};

	const clearKey = async (provider: RouterProviderKeyId) => {
		setPendingProvider(provider);
		try {
			await clearProviderKey(provider);
		} finally {
			setPendingProvider(null);
		}
	};

	return (
		<section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
			{data.providers.map((provider) => (
				<div key={provider.id} className="rounded-lg border bg-card p-4">
					<div className="flex items-start justify-between gap-3">
						<div className="min-w-0">
							<h2 className="truncate text-sm font-semibold">
								{provider.label}
							</h2>
							<p className="mt-1 text-xs text-muted-foreground">
								{provider.connection} / {provider.auth}
							</p>
						</div>
						<TierBadge tier={provider.tier} />
					</div>

					<p className="mt-3 text-xs leading-relaxed text-muted-foreground">
						{provider.notes}
					</p>

					<div className="mt-4 flex flex-wrap gap-1.5">
						{provider.capabilities.map((capability) => (
							<Pill key={capability}>{capability}</Pill>
						))}
					</div>

					<div className="mt-4 flex items-center justify-between gap-3 border-t pt-3 text-xs">
						<span className="text-muted-foreground">Credential</span>
						{provider.keyConfigured === null ? (
							<span className="text-muted-foreground">managed by runtime</span>
						) : provider.keyConfigured ? (
							<span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
								<LuBadgeCheck className="size-3.5" />
								configured
							</span>
						) : (
							<span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
								<LuKeyRound className="size-3.5" />
								needs key
							</span>
						)}
					</div>

					{provider.keyProvider && (
						<div className="mt-3 flex flex-col gap-3">
							<div className="grid grid-cols-[1fr_auto_auto] gap-2">
								<input
									type="password"
									value={inputs[provider.keyProvider] ?? ""}
									onChange={(event) =>
										setInputs((current) => ({
											...current,
											[provider.keyProvider as string]: event.target.value,
										}))
									}
									placeholder={`${provider.keyProvider} default key`}
									className="min-w-0 rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
								/>
								<button
									type="button"
									onClick={() =>
										saveKey(provider.keyProvider as RouterProviderKeyId)
									}
									disabled={
										isSavingKey ||
										pendingProvider === provider.keyProvider ||
										!inputs[provider.keyProvider]?.trim()
									}
									className="rounded-md border px-2 py-1.5 text-xs text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
								>
									Save
								</button>
								<button
									type="button"
									onClick={() =>
										clearKey(provider.keyProvider as RouterProviderKeyId)
									}
									disabled={
										isSavingKey ||
										pendingProvider === provider.keyProvider ||
										!provider.keyConfigured
									}
									className="rounded-md border px-2 py-1.5 text-xs text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
								>
									Clear
								</button>
							</div>
							<ProviderAccountsPanel
								accounts={providerAccounts.filter(
									(account) => account.provider === provider.keyProvider,
								)}
								createProviderAccount={createProviderAccount}
								deleteProviderAccount={deleteProviderAccount}
								isBusy={isSavingProviderAccount}
								provider={provider.keyProvider}
								refreshProviderAccount={refreshProviderAccount}
								updateProviderAccount={updateProviderAccount}
							/>
						</div>
					)}
				</div>
			))}
		</section>
	);
}

function ProviderAccountsPanel({
	accounts,
	createProviderAccount,
	deleteProviderAccount,
	isBusy,
	provider,
	refreshProviderAccount,
	updateProviderAccount,
}: {
	accounts: ProviderAccountView[];
	createProviderAccount: (input: ProviderAccountInput) => Promise<unknown>;
	deleteProviderAccount: (id: string) => Promise<unknown>;
	isBusy: boolean;
	provider: RouterProviderKeyId;
	refreshProviderAccount: (id: string) => Promise<unknown>;
	updateProviderAccount: (
		id: string,
		updates: ProviderAccountUpdates,
	) => Promise<unknown>;
}) {
	const [accountName, setAccountName] = useState("");
	const [accountKey, setAccountKey] = useState("");
	const [accountAuthType, setAccountAuthType] =
		useState<RouterProviderAccountAuthType>("api-key");
	const [accountEmail, setAccountEmail] = useState("");
	const [accountExpiresAt, setAccountExpiresAt] = useState("");
	const [accountIdToken, setAccountIdToken] = useState("");
	const [accountMetadata, setAccountMetadata] = useState("");
	const [accountRefreshToken, setAccountRefreshToken] = useState("");
	const [accountError, setAccountError] = useState<string | null>(null);

	const addAccount = async () => {
		if (!accountKey.trim()) return;
		const parsedMetadata = parseDashboardJsonObject(accountMetadata);
		if (parsedMetadata.error) {
			setAccountError(parsedMetadata.error);
			return;
		}
		setAccountError(null);
		await createProviderAccount({
			authType: accountAuthType,
			email: accountEmail.trim() || null,
			expiresAt: accountExpiresAt.trim() || null,
			idToken: accountIdToken.trim() || null,
			key: accountKey.trim(),
			name: accountName.trim() || undefined,
			provider,
			providerSpecificData: parsedMetadata.value,
			refreshToken: accountRefreshToken.trim() || null,
		});
		setAccountName("");
		setAccountKey("");
		setAccountEmail("");
		setAccountExpiresAt("");
		setAccountIdToken("");
		setAccountMetadata("");
		setAccountRefreshToken("");
	};

	return (
		<div className="rounded-md border bg-background/60 p-2">
			<div className="mb-2 flex items-center justify-between gap-2">
				<span className="text-xs font-medium">Accounts</span>
				<Pill>{accounts.length} configured</Pill>
			</div>
			<div className="grid gap-2">
				<div className="grid gap-2 sm:grid-cols-2">
					<input
						value={accountName}
						onChange={(event) => setAccountName(event.target.value)}
						placeholder="name"
						className="min-w-0 rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
					/>
					<select
						value={accountAuthType}
						onChange={(event) => {
							const nextAuthType = event.target
								.value as RouterProviderAccountAuthType;
							setAccountAuthType(nextAuthType);
							if (nextAuthType === "api-key") {
								setAccountIdToken("");
								setAccountRefreshToken("");
							}
						}}
						className="min-w-0 rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
					>
						<option value="api-key">API key</option>
						<option value="oauth">OAuth token</option>
						<option value="access-token">Access token</option>
					</select>
				</div>
				<input
					type="password"
					value={accountKey}
					onChange={(event) => setAccountKey(event.target.value)}
					placeholder={providerAccountSecretPlaceholder(accountAuthType)}
					className="min-w-0 rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
				/>
				{accountAuthType !== "api-key" && (
					<div className="grid gap-2 sm:grid-cols-2">
						<input
							type="password"
							value={accountRefreshToken}
							onChange={(event) => setAccountRefreshToken(event.target.value)}
							placeholder="refresh token (optional)"
							className="min-w-0 rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
						/>
						<input
							type="password"
							value={accountIdToken}
							onChange={(event) => setAccountIdToken(event.target.value)}
							placeholder="id token (optional)"
							className="min-w-0 rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
						/>
					</div>
				)}
				<div className="grid gap-2 sm:grid-cols-2">
					<input
						value={accountEmail}
						onChange={(event) => setAccountEmail(event.target.value)}
						placeholder="email (optional)"
						className="min-w-0 rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
					/>
					<input
						value={accountExpiresAt}
						onChange={(event) => setAccountExpiresAt(event.target.value)}
						placeholder="expires ISO (optional)"
						className="min-w-0 rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
					/>
				</div>
				<textarea
					value={accountMetadata}
					onChange={(event) => setAccountMetadata(event.target.value)}
					placeholder='metadata JSON, e.g. {"scope":"chatgpt"}'
					rows={2}
					className="min-h-14 rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
				/>
				<div className="flex items-center justify-between gap-2">
					<div className="min-w-0 truncate text-xs text-destructive">
						{accountError}
					</div>
					<button
						type="button"
						onClick={addAccount}
						disabled={isBusy || !accountKey.trim()}
						className="rounded-md border px-2 py-1.5 text-xs text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
					>
						Add
					</button>
				</div>
			</div>

			<div className="mt-2 flex flex-col gap-2">
				{accounts.map((account) => {
					const cooldownActive =
						account.rateLimitedUntil &&
						new Date(account.rateLimitedUntil).getTime() > Date.now();
					return (
						<div
							key={account.id}
							className="rounded-md border bg-card px-2 py-2 text-xs"
						>
							<div className="flex items-center justify-between gap-2">
								<div className="min-w-0">
									<div className="truncate font-medium">{account.name}</div>
									<div className="text-muted-foreground">
										{providerAccountAuthLabel(account.authType)} / priority{" "}
										{account.priority} / {account.requestCount} req
									</div>
								</div>
								<div className="flex shrink-0 gap-1">
									<button
										type="button"
										onClick={() => {
											setAccountError(null);
											refreshProviderAccount(account.id).catch((error) =>
												setAccountError(errorMessage(error)),
											);
										}}
										disabled={isBusy || !account.hasRefreshToken}
										className="rounded border px-2 py-1 text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
									>
										Refresh
									</button>
									<button
										type="button"
										onClick={() =>
											updateProviderAccount(account.id, {
												isActive: !account.isActive,
											})
										}
										disabled={isBusy}
										className="rounded border px-2 py-1 text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
									>
										{account.isActive ? "Pause" : "Enable"}
									</button>
									<button
										type="button"
										onClick={() => deleteProviderAccount(account.id)}
										disabled={isBusy}
										className="rounded border px-2 py-1 text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
									>
										Delete
									</button>
								</div>
							</div>
							<div className="mt-2 flex flex-wrap gap-1.5">
								<Pill>{account.hasKey ? "key stored" : "missing key"}</Pill>
								{account.hasRefreshToken && <Pill>refresh stored</Pill>}
								{account.hasIdToken && <Pill>id token stored</Pill>}
								<Pill>{providerAccountAuthLabel(account.authType)}</Pill>
								<Pill>{account.isActive ? "active" : "paused"}</Pill>
								{account.email && <Pill>{account.email}</Pill>}
								{account.expiresAt && (
									<Pill>expires {formatDashboardDate(account.expiresAt)}</Pill>
								)}
								{account.providerSpecificData &&
									Object.keys(account.providerSpecificData).length > 0 && (
										<Pill>metadata</Pill>
									)}
								{cooldownActive && <Pill>cooldown</Pill>}
								{account.failureCount > 0 && (
									<Pill>{account.failureCount} failures</Pill>
								)}
							</div>
							{account.lastError && (
								<div className="mt-2 truncate text-muted-foreground">
									Last error: {account.lastError.message}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

function NodesTab() {
	const utils = electronTrpc.useUtils();
	const nodes = electronTrpc.agentRouter.providerNodes.useQuery(undefined, {
		refetchInterval: 15_000,
	});
	const providerAccounts = electronTrpc.agentRouter.providerAccounts.useQuery(
		undefined,
		{ refetchInterval: 15_000 },
	);
	const invalidate = () => {
		utils.agentRouter.providerNodes.invalidate();
		utils.agentRouter.dashboard.invalidate();
	};
	const createProviderNode =
		electronTrpc.agentRouter.createProviderNode.useMutation({
			onSuccess: invalidate,
		});
	const updateProviderNode =
		electronTrpc.agentRouter.updateProviderNode.useMutation({
			onSuccess: invalidate,
		});
	const deleteProviderNode =
		electronTrpc.agentRouter.deleteProviderNode.useMutation({
			onSuccess: invalidate,
		});
	const validateProviderNode =
		electronTrpc.agentRouter.validateProviderNode.useMutation();
	const discoverProviderNodeModels =
		electronTrpc.agentRouter.discoverProviderNodeModels.useMutation({
			onSuccess: (result) => {
				if (result.applied) invalidate();
			},
		});

	const [type, setType] = useState<RouterProviderNodeType>("openai-compatible");
	const [name, setName] = useState("");
	const [prefix, setPrefix] = useState("");
	const [baseUrl, setBaseUrl] = useState(defaultNodeBaseUrl(type));
	const [apiType, setApiType] = useState<"chat" | "responses">("chat");
	const [apiKeyProvider, setApiKeyProvider] =
		useState<RouterProviderKeyId>("openai");
	const [apiKeyAccountId, setApiKeyAccountId] = useState("");
	const [models, setModels] = useState("");
	const [checkModelId, setCheckModelId] = useState("");
	const [validationResult, setValidationResult] =
		useState<ProviderNodeValidationState>(null);
	const [discoveryResult, setDiscoveryResult] =
		useState<ProviderNodeDiscoveryState>(null);

	const accounts = providerAccounts.data ?? [];
	const matchingAccounts = accounts.filter(
		(account) => account.provider === apiKeyProvider,
	);

	const changeType = (nextType: RouterProviderNodeType) => {
		setType(nextType);
		setBaseUrl(defaultNodeBaseUrl(nextType));
		setApiKeyProvider(
			nextType === "anthropic-compatible" ? "anthropic" : "openai",
		);
		if (nextType !== "openai-compatible") setApiType("chat");
		setApiKeyAccountId("");
	};

	const saveNode = async () => {
		if (!name.trim() || !prefix.trim() || !baseUrl.trim()) return;
		await createProviderNode.mutateAsync({
			apiKeyAccountId: apiKeyAccountId || null,
			apiKeyProvider,
			apiType: type === "openai-compatible" ? apiType : undefined,
			baseUrl: baseUrl.trim(),
			models: parseDashboardModels(models),
			name: name.trim(),
			prefix: prefix.trim(),
			type,
		});
		setName("");
		setPrefix("");
		setModels("");
		setApiKeyAccountId("");
		setCheckModelId("");
		setValidationResult(null);
		setDiscoveryResult(null);
	};

	const draftNodeInput = () => ({
		apiKeyAccountId: apiKeyAccountId || null,
		apiKeyProvider,
		apiType: type === "openai-compatible" ? apiType : undefined,
		baseUrl: baseUrl.trim(),
		modelId: checkModelId.trim() || undefined,
		type,
	});

	const checkDraftNode = async () => {
		if (!baseUrl.trim()) return;
		const result = await validateProviderNode.mutateAsync(draftNodeInput());
		setValidationResult(result);
	};

	const importDraftModels = async () => {
		if (!baseUrl.trim()) return;
		const result = await discoverProviderNodeModels.mutateAsync(
			draftNodeInput(),
		);
		setDiscoveryResult(result);
		if (result.ok && result.models.length > 0) {
			setModels(result.models.map((model) => model.id).join("\n"));
		}
	};

	return (
		<section className="grid gap-4 xl:grid-cols-[0.85fr_1.15fr]">
			<div className="rounded-lg border bg-card p-4">
				<h2 className="text-sm font-semibold">Add provider node</h2>
				<div className="mt-4 grid gap-3">
					<label className="grid gap-1.5 text-xs font-medium">
						Type
						<select
							value={type}
							onChange={(event) =>
								changeType(event.target.value as RouterProviderNodeType)
							}
							className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
						>
							<option value="openai-compatible">OpenAI-compatible</option>
							<option value="anthropic-compatible">Anthropic-compatible</option>
							<option value="custom-embedding">Custom embedding</option>
						</select>
					</label>

					<div className="grid gap-3 md:grid-cols-2">
						<label className="grid gap-1.5 text-xs font-medium">
							Name
							<input
								value={name}
								onChange={(event) => setName(event.target.value)}
								placeholder="Local LM Studio"
								className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
							/>
						</label>
						<label className="grid gap-1.5 text-xs font-medium">
							Prefix
							<input
								value={prefix}
								onChange={(event) => setPrefix(event.target.value)}
								placeholder="lmstudio"
								className="rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
							/>
						</label>
					</div>

					<label className="grid gap-1.5 text-xs font-medium">
						Base URL
						<input
							value={baseUrl}
							onChange={(event) => setBaseUrl(event.target.value)}
							placeholder="http://127.0.0.1:1234/v1"
							className="rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
						/>
					</label>

					<div className="grid gap-3 md:grid-cols-2">
						<label className="grid gap-1.5 text-xs font-medium">
							Key provider
							<select
								value={apiKeyProvider}
								onChange={(event) => {
									setApiKeyProvider(event.target.value as RouterProviderKeyId);
									setApiKeyAccountId("");
								}}
								className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
							>
								{ROUTER_PROVIDER_KEY_IDS.map((provider) => (
									<option key={provider} value={provider}>
										{provider}
									</option>
								))}
							</select>
						</label>
						<label className="grid gap-1.5 text-xs font-medium">
							Account
							<select
								value={apiKeyAccountId}
								onChange={(event) => setApiKeyAccountId(event.target.value)}
								className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
							>
								<option value="">auto / no key for local nodes</option>
								{matchingAccounts.map((account) => (
									<option key={account.id} value={account.id}>
										{account.name}
									</option>
								))}
							</select>
						</label>
					</div>

					{type === "openai-compatible" && (
						<label className="grid gap-1.5 text-xs font-medium">
							OpenAI API type
							<select
								value={apiType}
								onChange={(event) =>
									setApiType(event.target.value as "chat" | "responses")
								}
								className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
							>
								<option value="chat">/chat/completions</option>
								<option value="responses">/responses</option>
							</select>
						</label>
					)}

					<div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
						<label className="grid gap-1.5 text-xs font-medium">
							Model ID for check
							<input
								value={checkModelId}
								onChange={(event) => setCheckModelId(event.target.value)}
								placeholder={
									type === "custom-embedding"
										? "text-embedding-3-small"
										: "optional fallback model"
								}
								className="rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
							/>
						</label>
						<button
							type="button"
							onClick={checkDraftNode}
							disabled={
								validateProviderNode.isPending ||
								!baseUrl.trim() ||
								(type === "custom-embedding" && !checkModelId.trim())
							}
							className="self-end rounded-md border px-3 py-2 text-sm text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
						>
							{validateProviderNode.isPending ? "Checking..." : "Check"}
						</button>
						<button
							type="button"
							onClick={importDraftModels}
							disabled={discoverProviderNodeModels.isPending || !baseUrl.trim()}
							className="self-end rounded-md border px-3 py-2 text-sm text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
						>
							{discoverProviderNodeModels.isPending
								? "Importing..."
								: "Import /models"}
						</button>
					</div>

					{validationResult && (
						<ProviderNodeValidationNotice result={validationResult} />
					)}
					{discoveryResult && (
						<ProviderNodeDiscoveryNotice result={discoveryResult} />
					)}

					<label className="grid gap-1.5 text-xs font-medium">
						Models
						<textarea
							value={models}
							onChange={(event) => setModels(event.target.value)}
							placeholder="gpt-oss-20b, qwen3-coder"
							className="min-h-24 rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
						/>
					</label>

					<button
						type="button"
						onClick={saveNode}
						disabled={
							createProviderNode.isPending ||
							!name.trim() ||
							!prefix.trim() ||
							!baseUrl.trim()
						}
						className="w-fit rounded-md border px-3 py-2 text-sm text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
					>
						Add node
					</button>
				</div>
			</div>

			<div className="rounded-lg border bg-card p-4">
				<div className="flex items-center justify-between gap-3">
					<h2 className="text-sm font-semibold">Configured nodes</h2>
					<Pill>{nodes.data?.length ?? 0} nodes</Pill>
				</div>
				<div className="mt-4 flex flex-col gap-3">
					{(nodes.data ?? []).length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No provider nodes configured yet.
						</p>
					) : (
						(nodes.data ?? []).map((node) => (
							<ProviderNodeRow
								key={node.id}
								accounts={accounts}
								deleteNode={(id) => deleteProviderNode.mutate({ id })}
								discoverModels={(id) =>
									discoverProviderNodeModels.mutateAsync({
										apply: true,
										id,
									})
								}
								isBusy={
									updateProviderNode.isPending ||
									deleteProviderNode.isPending ||
									discoverProviderNodeModels.isPending ||
									validateProviderNode.isPending
								}
								node={node}
								toggleNode={(id, isActive) =>
									updateProviderNode.mutate({ id, isActive })
								}
								validateNode={(id, modelId) =>
									validateProviderNode.mutateAsync({
										id,
										modelId,
									})
								}
							/>
						))
					)}
				</div>
			</div>
		</section>
	);
}

function ProviderNodeRow({
	accounts,
	deleteNode,
	discoverModels,
	isBusy,
	node,
	toggleNode,
	validateNode,
}: {
	accounts: ProviderAccountView[];
	deleteNode: (id: string) => void;
	discoverModels: (id: string) => Promise<ProviderNodeDiscoveryState>;
	isBusy: boolean;
	node: RouterProviderNode;
	toggleNode: (id: string, isActive: boolean) => void;
	validateNode: (
		id: string,
		modelId: string | undefined,
	) => Promise<ProviderNodeValidationState>;
}) {
	const [validationResult, setValidationResult] =
		useState<ProviderNodeValidationState>(null);
	const [discoveryResult, setDiscoveryResult] =
		useState<ProviderNodeDiscoveryState>(null);
	const accountName =
		accounts.find((account) => account.id === node.apiKeyAccountId)?.name ??
		(node.apiKeyAccountId ? "selected account" : "auto / no key");
	const firstModel = node.models[0];

	const checkNode = async () => {
		const result = await validateNode(node.id, firstModel);
		setValidationResult(result);
	};

	const importModels = async () => {
		const result = await discoverModels(node.id);
		setDiscoveryResult(result);
	};

	return (
		<div className="rounded-md border bg-background px-3 py-3">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<span className="truncate text-sm font-medium">{node.name}</span>
						<Pill>{node.isActive ? "active" : "paused"}</Pill>
						<Pill>{node.type}</Pill>
						{node.apiType && <Pill>{node.apiType}</Pill>}
					</div>
					<div className="mt-1 truncate font-mono text-xs text-muted-foreground">
						{`${node.prefix}/* -> ${node.baseUrl}`}
					</div>
				</div>
				<div className="flex shrink-0 gap-2">
					<button
						type="button"
						onClick={checkNode}
						disabled={
							isBusy ||
							(node.type === "custom-embedding" && node.models.length === 0)
						}
						className="rounded border px-2 py-1 text-xs text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
					>
						Check
					</button>
					<button
						type="button"
						onClick={importModels}
						disabled={isBusy}
						className="rounded border px-2 py-1 text-xs text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
					>
						Import /models
					</button>
					<button
						type="button"
						onClick={() => toggleNode(node.id, !node.isActive)}
						disabled={isBusy}
						className="rounded border px-2 py-1 text-xs text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
					>
						{node.isActive ? "Pause" : "Enable"}
					</button>
					<button
						type="button"
						onClick={() => deleteNode(node.id)}
						disabled={isBusy}
						className="rounded border px-2 py-1 text-xs text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
					>
						Delete
					</button>
				</div>
			</div>

			<div className="mt-3 flex flex-wrap gap-1.5">
				<Pill>key: {node.apiKeyProvider ?? "none"}</Pill>
				<Pill>{accountName}</Pill>
				{node.models.length === 0 ? (
					<Pill>routes any {node.prefix}/model</Pill>
				) : (
					node.models.map((model) => (
						<Pill key={`${node.id}-${model}`}>
							{node.prefix}/{model}
						</Pill>
					))
				)}
			</div>
			{validationResult && (
				<div className="mt-3">
					<ProviderNodeValidationNotice result={validationResult} />
				</div>
			)}
			{discoveryResult && (
				<div className="mt-3">
					<ProviderNodeDiscoveryNotice result={discoveryResult} />
				</div>
			)}
		</div>
	);
}

function ProviderNodeValidationNotice({
	result,
}: {
	result: ProviderNodeValidationState;
}) {
	if (!result) return null;
	if (result.valid) {
		return (
			<div className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs">
				<span className="font-medium text-emerald-700 dark:text-emerald-300">
					Valid
				</span>
				{result.method && <Pill>via {result.method}</Pill>}
				{result.models && result.models.length > 0 && (
					<Pill>{result.models.length} models found</Pill>
				)}
			</div>
		);
	}
	return (
		<div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
			{result.error ?? "Validation failed"}
		</div>
	);
}

function ProviderNodeDiscoveryNotice({
	result,
}: {
	result: ProviderNodeDiscoveryState;
}) {
	if (!result) return null;
	if (result.ok) {
		return (
			<div className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs">
				<span className="font-medium text-emerald-700 dark:text-emerald-300">
					Imported
				</span>
				<Pill>{result.models.length} models</Pill>
			</div>
		);
	}
	return (
		<div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
			{result.error ?? "Model discovery failed"}
		</div>
	);
}

function ModelsTab() {
	const utils = electronTrpc.useUtils();
	const customModels = electronTrpc.agentRouter.customModels.useQuery(
		undefined,
		{ refetchInterval: 15_000 },
	);
	const disabledModels = electronTrpc.agentRouter.disabledModels.useQuery(
		undefined,
		{ refetchInterval: 15_000 },
	);
	const availability = electronTrpc.agentRouter.modelAvailability.useQuery(
		undefined,
		{ refetchInterval: 15_000 },
	);
	const invalidate = () => {
		utils.agentRouter.customModels.invalidate();
		utils.agentRouter.disabledModels.invalidate();
		utils.agentRouter.modelAvailability.invalidate();
		utils.agentRouter.dashboard.invalidate();
	};
	const testModel = electronTrpc.agentRouter.testModel.useMutation({
		onSuccess: () => utils.agentRouter.modelAvailability.invalidate(),
	});
	const upsertCustomModel =
		electronTrpc.agentRouter.upsertCustomModel.useMutation({
			onSuccess: invalidate,
		});
	const deleteCustomModel =
		electronTrpc.agentRouter.deleteCustomModel.useMutation({
			onSuccess: invalidate,
		});
	const disableModels = electronTrpc.agentRouter.disableModels.useMutation({
		onSuccess: invalidate,
	});
	const enableModels = electronTrpc.agentRouter.enableModels.useMutation({
		onSuccess: invalidate,
	});

	const [testModelId, setTestModelId] = useState("premium-coding");
	const [testKind, setTestKind] = useState<RouterModelKind>("llm");
	const [testResult, setTestResult] = useState<RouterModelTestResult | null>(
		null,
	);
	const [customProvider, setCustomProvider] = useState("");
	const [customId, setCustomId] = useState("");
	const [customName, setCustomName] = useState("");
	const [customType, setCustomType] = useState<RouterModelKind>("llm");
	const [disabledProvider, setDisabledProvider] = useState("");
	const [disabledIds, setDisabledIds] = useState("");
	const [disabledReason, setDisabledReason] = useState("");

	const saveCustomModel = async () => {
		if (!customProvider.trim() || !customId.trim()) return;
		await upsertCustomModel.mutateAsync({
			providerAlias: customProvider.trim(),
			id: customId.trim(),
			type: customType,
			name: customName.trim() || undefined,
		});
		setCustomProvider("");
		setCustomId("");
		setCustomName("");
	};

	const saveDisabledModels = async () => {
		const ids = parseDashboardModels(disabledIds);
		if (!disabledProvider.trim() || ids.length === 0) return;
		await disableModels.mutateAsync({
			providerAlias: disabledProvider.trim(),
			ids,
			reason: disabledReason.trim() || undefined,
		});
		setDisabledIds("");
		setDisabledReason("");
	};

	const runModelTest = async () => {
		if (!testModelId.trim()) return;
		const result = await testModel.mutateAsync({
			model: testModelId.trim(),
			kind: testKind,
		});
		setTestResult(result);
	};

	return (
		<section className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
			<div className="flex flex-col gap-4">
				<div className="rounded-lg border bg-card p-4">
					<h2 className="text-sm font-semibold">Model test</h2>
					<div className="mt-4 grid gap-3 md:grid-cols-[1fr_150px_auto]">
						<input
							value={testModelId}
							onChange={(event) => setTestModelId(event.target.value)}
							placeholder="premium-coding or local/qwen3-coder"
							className="rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
						/>
						<ModelKindSelect value={testKind} onChange={setTestKind} />
						<button
							type="button"
							onClick={runModelTest}
							disabled={testModel.isPending || !testModelId.trim()}
							className="rounded-md border px-3 py-2 text-sm text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
						>
							{testModel.isPending ? "Testing..." : "Test"}
						</button>
					</div>
					{testResult && (
						<div
							className={cn(
								"mt-3 rounded-md border px-3 py-2 text-xs",
								testResult.ok
									? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
									: "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300",
							)}
						>
							<div className="flex flex-wrap items-center gap-2">
								<span className="font-medium">
									{testResult.ok ? "Available" : "Unavailable"}
								</span>
								<Pill>{testResult.method}</Pill>
								<Pill>{testResult.latencyMs}ms</Pill>
								{testResult.status && <Pill>HTTP {testResult.status}</Pill>}
							</div>
							{testResult.error && (
								<div className="mt-2 text-xs">{testResult.error}</div>
							)}
						</div>
					)}
				</div>

				<CustomModelsPanel
					customId={customId}
					customModels={customModels.data ?? []}
					customName={customName}
					customProvider={customProvider}
					customType={customType}
					deleteCustomModel={(model) =>
						deleteCustomModel.mutate({
							providerAlias: model.providerAlias,
							id: model.id,
							type: model.type,
						})
					}
					isBusy={upsertCustomModel.isPending || deleteCustomModel.isPending}
					saveCustomModel={saveCustomModel}
					setCustomId={setCustomId}
					setCustomName={setCustomName}
					setCustomProvider={setCustomProvider}
					setCustomType={setCustomType}
				/>
			</div>

			<div className="flex flex-col gap-4">
				<DisabledModelsPanel
					disabledIds={disabledIds}
					disabledModels={disabledModels.data ?? []}
					disabledProvider={disabledProvider}
					disabledReason={disabledReason}
					enableModels={(providerAlias, ids) =>
						enableModels.mutate({ providerAlias, ids })
					}
					isBusy={disableModels.isPending || enableModels.isPending}
					saveDisabledModels={saveDisabledModels}
					setDisabledIds={setDisabledIds}
					setDisabledProvider={setDisabledProvider}
					setDisabledReason={setDisabledReason}
				/>
				<ModelAvailabilityPanel availability={availability.data ?? []} />
			</div>
		</section>
	);
}

function CustomModelsPanel({
	customId,
	customModels,
	customName,
	customProvider,
	customType,
	deleteCustomModel,
	isBusy,
	saveCustomModel,
	setCustomId,
	setCustomName,
	setCustomProvider,
	setCustomType,
}: {
	customId: string;
	customModels: RouterCustomModel[];
	customName: string;
	customProvider: string;
	customType: RouterModelKind;
	deleteCustomModel: (model: RouterCustomModel) => void;
	isBusy: boolean;
	saveCustomModel: () => Promise<void>;
	setCustomId: (value: string) => void;
	setCustomName: (value: string) => void;
	setCustomProvider: (value: string) => void;
	setCustomType: (value: RouterModelKind) => void;
}) {
	return (
		<div className="rounded-lg border bg-card p-4">
			<div className="flex items-center justify-between gap-3">
				<h2 className="text-sm font-semibold">Custom models</h2>
				<Pill>{customModels.length} models</Pill>
			</div>
			<div className="mt-4 grid gap-2 md:grid-cols-[1fr_1fr_140px]">
				<input
					value={customProvider}
					onChange={(event) => setCustomProvider(event.target.value)}
					placeholder="provider alias, e.g. local"
					className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
				/>
				<input
					value={customId}
					onChange={(event) => setCustomId(event.target.value)}
					placeholder="model id"
					className="rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
				/>
				<ModelKindSelect value={customType} onChange={setCustomType} />
			</div>
			<div className="mt-2 grid gap-2 md:grid-cols-[1fr_auto]">
				<input
					value={customName}
					onChange={(event) => setCustomName(event.target.value)}
					placeholder="display name"
					className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
				/>
				<button
					type="button"
					onClick={saveCustomModel}
					disabled={isBusy || !customProvider.trim() || !customId.trim()}
					className="rounded-md border px-3 py-2 text-sm text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
				>
					Save model
				</button>
			</div>
			<div className="mt-4 flex flex-col gap-2">
				{customModels.length === 0 ? (
					<p className="text-sm text-muted-foreground">No custom models yet.</p>
				) : (
					customModels.map((model) => (
						<div
							key={`${model.providerAlias}-${model.id}-${model.type}`}
							className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm"
						>
							<div className="min-w-0">
								<div className="truncate font-mono">
									{model.providerAlias}/{model.id}
								</div>
								<div className="truncate text-xs text-muted-foreground">
									{model.name} / {model.type}
								</div>
							</div>
							<button
								type="button"
								onClick={() => deleteCustomModel(model)}
								disabled={isBusy}
								className="rounded border px-2 py-1 text-xs text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
							>
								Delete
							</button>
						</div>
					))
				)}
			</div>
		</div>
	);
}

function DisabledModelsPanel({
	disabledIds,
	disabledModels,
	disabledProvider,
	disabledReason,
	enableModels,
	isBusy,
	saveDisabledModels,
	setDisabledIds,
	setDisabledProvider,
	setDisabledReason,
}: {
	disabledIds: string;
	disabledModels: RouterDisabledModel[];
	disabledProvider: string;
	disabledReason: string;
	enableModels: (providerAlias: string, ids?: string[]) => void;
	isBusy: boolean;
	saveDisabledModels: () => Promise<void>;
	setDisabledIds: (value: string) => void;
	setDisabledProvider: (value: string) => void;
	setDisabledReason: (value: string) => void;
}) {
	return (
		<div className="rounded-lg border bg-card p-4">
			<div className="flex items-center justify-between gap-3">
				<h2 className="text-sm font-semibold">Disabled models</h2>
				<Pill>{disabledModels.length} disabled</Pill>
			</div>
			<div className="mt-4 grid gap-2 md:grid-cols-[1fr_1fr]">
				<input
					value={disabledProvider}
					onChange={(event) => setDisabledProvider(event.target.value)}
					placeholder="provider alias or node prefix"
					className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
				/>
				<input
					value={disabledReason}
					onChange={(event) => setDisabledReason(event.target.value)}
					placeholder="reason"
					className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
				/>
			</div>
			<div className="mt-2 grid gap-2 md:grid-cols-[1fr_auto]">
				<textarea
					value={disabledIds}
					onChange={(event) => setDisabledIds(event.target.value)}
					placeholder="model ids, comma or newline separated"
					className="min-h-20 rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
				/>
				<button
					type="button"
					onClick={saveDisabledModels}
					disabled={isBusy || !disabledProvider.trim() || !disabledIds.trim()}
					className="self-start rounded-md border px-3 py-2 text-sm text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
				>
					Disable
				</button>
			</div>
			<div className="mt-4 flex flex-col gap-2">
				{disabledModels.length === 0 ? (
					<p className="text-sm text-muted-foreground">No disabled models.</p>
				) : (
					disabledModels.map((model) => (
						<div
							key={`${model.providerAlias}-${model.id}`}
							className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm"
						>
							<div className="min-w-0">
								<div className="truncate font-mono">
									{model.providerAlias}/{model.id}
								</div>
								<div className="truncate text-xs text-muted-foreground">
									{model.reason ?? "no reason"} /{" "}
									{new Date(model.disabledAt).toLocaleString()}
								</div>
							</div>
							<button
								type="button"
								onClick={() => enableModels(model.providerAlias, [model.id])}
								disabled={isBusy}
								className="rounded border px-2 py-1 text-xs text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
							>
								Enable
							</button>
						</div>
					))
				)}
			</div>
		</div>
	);
}

function ModelAvailabilityPanel({
	availability,
}: {
	availability: RouterModelAvailabilityEntry[];
}) {
	return (
		<div className="rounded-lg border bg-card">
			<div className="flex items-center justify-between gap-3 border-b px-4 py-3">
				<h2 className="text-sm font-semibold">Availability history</h2>
				<Pill>{availability.length} recent checks</Pill>
			</div>
			<div className="divide-y">
				{availability.length === 0 ? (
					<p className="p-4 text-sm text-muted-foreground">
						No model checks yet.
					</p>
				) : (
					availability.slice(0, 12).map((entry) => (
						<div
							key={entry.id}
							className="grid grid-cols-[95px_1fr_90px_70px] gap-3 px-4 py-3 text-xs"
						>
							<span
								className={cn(
									entry.status === "available"
										? "text-emerald-600 dark:text-emerald-400"
										: "text-amber-600 dark:text-amber-400",
								)}
							>
								{entry.status}
							</span>
							<span className="min-w-0 truncate font-mono">{entry.model}</span>
							<span className="text-muted-foreground">{entry.method}</span>
							<span className="text-muted-foreground">
								{entry.latencyMs ?? 0}ms
							</span>
							{entry.error && (
								<span className="col-span-4 truncate text-muted-foreground">
									{entry.error}
								</span>
							)}
						</div>
					))
				)}
			</div>
		</div>
	);
}

function ModelKindSelect({
	onChange,
	value,
}: {
	onChange: (value: RouterModelKind) => void;
	value: RouterModelKind;
}) {
	return (
		<select
			value={value}
			onChange={(event) => onChange(event.target.value as RouterModelKind)}
			className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
		>
			{ROUTER_MODEL_KINDS.map((kind) => (
				<option key={kind} value={kind}>
					{kind}
				</option>
			))}
		</select>
	);
}

function PricingTab() {
	const utils = electronTrpc.useUtils();
	const pricing = electronTrpc.agentRouter.pricing.useQuery();
	const defaultPricing = electronTrpc.agentRouter.defaultPricing.useQuery();
	const updatePricing = electronTrpc.agentRouter.updatePricing.useMutation({
		onSuccess: () => {
			utils.agentRouter.pricing.invalidate();
			utils.agentRouter.usageStats.invalidate();
		},
	});
	const resetPricing = electronTrpc.agentRouter.resetPricing.useMutation({
		onSuccess: () => {
			utils.agentRouter.pricing.invalidate();
			utils.agentRouter.usageStats.invalidate();
		},
	});
	const [provider, setProvider] = useState("openrouter");
	const [model, setModel] = useState("z-ai/glm-5.2");
	const [input, setInput] = useState("1");
	const [output, setOutput] = useState("4");
	const [cached, setCached] = useState("");

	const rows = pricingRows(pricing.data ?? {});
	const defaultRows = pricingRows(defaultPricing.data ?? {});

	const save = async () => {
		if (!provider.trim() || !model.trim()) return;
		await updatePricing.mutateAsync({
			[provider.trim()]: {
				[model.trim()]: {
					input: parsePricingNumber(input),
					output: parsePricingNumber(output),
					...(cached.trim() ? { cached: parsePricingNumber(cached) } : {}),
				},
			},
		});
	};

	return (
		<section className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
			<div className="rounded-lg border bg-card p-4">
				<div className="flex items-center justify-between gap-3">
					<div>
						<h2 className="text-sm font-semibold">Pricing registry</h2>
						<p className="mt-1 text-xs text-muted-foreground">
							Values are USD per million tokens and feed usage cost estimates.
						</p>
					</div>
					<Pill>{rows.length} rates</Pill>
				</div>

				<div className="mt-4 grid gap-3">
					<label className="flex flex-col gap-1 text-xs font-medium">
						Provider
						<input
							value={provider}
							onChange={(event) => setProvider(event.target.value)}
							className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
							placeholder="openrouter"
						/>
					</label>
					<label className="flex flex-col gap-1 text-xs font-medium">
						Model
						<input
							value={model}
							onChange={(event) => setModel(event.target.value)}
							className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
							placeholder="z-ai/glm-5.2"
						/>
					</label>
					<div className="grid gap-3 sm:grid-cols-3">
						<label className="flex flex-col gap-1 text-xs font-medium">
							Input
							<input
								value={input}
								onChange={(event) => setInput(event.target.value)}
								className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
								inputMode="decimal"
							/>
						</label>
						<label className="flex flex-col gap-1 text-xs font-medium">
							Output
							<input
								value={output}
								onChange={(event) => setOutput(event.target.value)}
								className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
								inputMode="decimal"
							/>
						</label>
						<label className="flex flex-col gap-1 text-xs font-medium">
							Cached
							<input
								value={cached}
								onChange={(event) => setCached(event.target.value)}
								className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
								inputMode="decimal"
								placeholder="optional"
							/>
						</label>
					</div>
					<div className="flex flex-wrap gap-2">
						<button
							type="button"
							onClick={save}
							disabled={
								updatePricing.isPending || !provider.trim() || !model.trim()
							}
							className="rounded-md bg-foreground px-3 py-2 text-sm text-background disabled:opacity-50"
						>
							Save rate
						</button>
						<button
							type="button"
							onClick={() =>
								resetPricing.mutate({
									provider: provider.trim(),
									model: model.trim(),
								})
							}
							disabled={
								resetPricing.isPending || !provider.trim() || !model.trim()
							}
							className="rounded-md border px-3 py-2 text-sm text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
						>
							Reset model
						</button>
						<button
							type="button"
							onClick={() => resetPricing.mutate({})}
							disabled={resetPricing.isPending}
							className="rounded-md border px-3 py-2 text-sm text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
						>
							Reset all overrides
						</button>
					</div>
				</div>

				<div className="mt-5 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
					Default table currently contributes {defaultRows.length} baseline
					rates. Overrides are stored in the ADE router state file.
				</div>
			</div>

			<div className="rounded-lg border bg-card">
				<div className="grid grid-cols-[120px_1fr_80px_80px_80px] gap-3 border-b px-4 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					<span>Provider</span>
					<span>Model</span>
					<span>Input</span>
					<span>Output</span>
					<span>Cached</span>
				</div>
				<div className="max-h-[520px] divide-y overflow-auto">
					{pricing.isLoading ? (
						<p className="px-4 py-3 text-sm text-muted-foreground">
							Loading pricing...
						</p>
					) : rows.length === 0 ? (
						<p className="px-4 py-3 text-sm text-muted-foreground">
							No pricing rates configured.
						</p>
					) : (
						rows.map((row) => (
							<div
								key={`${row.provider}-${row.model}`}
								className="grid grid-cols-[120px_1fr_80px_80px_80px] gap-3 px-4 py-3 text-xs"
							>
								<span className="truncate">{row.provider}</span>
								<span className="truncate font-mono">{row.model}</span>
								<span>{formatPricingValue(row.input)}</span>
								<span>{formatPricingValue(row.output)}</span>
								<span>{formatPricingValue(row.cached)}</span>
							</div>
						))
					)}
				</div>
			</div>
		</section>
	);
}

function ProxiesTab() {
	const utils = electronTrpc.useUtils();
	const proxyPools = electronTrpc.agentRouter.proxyPools.useQuery(undefined, {
		refetchInterval: 15_000,
	});
	const createProxyPool = electronTrpc.agentRouter.createProxyPool.useMutation({
		onSuccess: () => utils.agentRouter.proxyPools.invalidate(),
	});
	const updateProxyPool = electronTrpc.agentRouter.updateProxyPool.useMutation({
		onSuccess: () => utils.agentRouter.proxyPools.invalidate(),
	});
	const deleteProxyPool = electronTrpc.agentRouter.deleteProxyPool.useMutation({
		onSuccess: () => utils.agentRouter.proxyPools.invalidate(),
	});
	const testProxyPool = electronTrpc.agentRouter.testProxyPool.useMutation({
		onSuccess: () => utils.agentRouter.proxyPools.invalidate(),
	});
	const [name, setName] = useState("Local proxy");
	const [proxyUrl, setProxyUrl] = useState("http://127.0.0.1:7890");
	const [noProxy, setNoProxy] = useState("localhost,127.0.0.1");
	const [type, setType] = useState<RouterProxyPoolType>("http");
	const [strictProxy, setStrictProxy] = useState(false);
	const [lastResult, setLastResult] = useState<{
		id: string;
		ok: boolean;
		error: string | null;
		elapsedMs: number;
	} | null>(null);

	const save = async () => {
		if (!name.trim() || !proxyUrl.trim()) return;
		await createProxyPool.mutateAsync({
			name: name.trim(),
			proxyUrl: proxyUrl.trim(),
			noProxy: noProxy.trim(),
			type,
			isActive: true,
			strictProxy,
		});
	};

	const testPool = async (pool: RouterProxyPool) => {
		const result = await testProxyPool.mutateAsync({ id: pool.id });
		setLastResult({
			id: pool.id,
			ok: result.ok,
			error: result.error,
			elapsedMs: result.elapsedMs,
		});
	};

	return (
		<section className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
			<div className="rounded-lg border bg-card p-4">
				<div className="flex items-center justify-between gap-3">
					<div>
						<h2 className="text-sm font-semibold">Proxy pool</h2>
						<p className="mt-1 text-xs text-muted-foreground">
							HTTP proxies and relay URLs compatible with the 9router proxy-pool
							API.
						</p>
					</div>
					<Pill>{proxyPools.data?.length ?? 0} pools</Pill>
				</div>

				<div className="mt-4 grid gap-3">
					<label className="flex flex-col gap-1 text-xs font-medium">
						Name
						<input
							value={name}
							onChange={(event) => setName(event.target.value)}
							className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
						/>
					</label>
					<label className="flex flex-col gap-1 text-xs font-medium">
						Proxy URL
						<input
							value={proxyUrl}
							onChange={(event) => setProxyUrl(event.target.value)}
							className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
							placeholder="http://127.0.0.1:7890 or relay URL"
						/>
					</label>
					<div className="grid gap-3 sm:grid-cols-2">
						<label className="flex flex-col gap-1 text-xs font-medium">
							Type
							<select
								value={type}
								onChange={(event) =>
									setType(event.target.value as RouterProxyPoolType)
								}
								className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
							>
								{ROUTER_PROXY_POOL_TYPES.map((poolType) => (
									<option key={poolType} value={poolType}>
										{poolType}
									</option>
								))}
							</select>
						</label>
						<label className="flex flex-col gap-1 text-xs font-medium">
							No proxy
							<input
								value={noProxy}
								onChange={(event) => setNoProxy(event.target.value)}
								className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
							/>
						</label>
					</div>
					<label className="flex items-center gap-2 text-xs text-muted-foreground">
						<input
							type="checkbox"
							checked={strictProxy}
							onChange={(event) => setStrictProxy(event.target.checked)}
						/>
						Strict proxy for future provider bindings
					</label>
					<button
						type="button"
						onClick={save}
						disabled={
							createProxyPool.isPending || !name.trim() || !proxyUrl.trim()
						}
						className="rounded-md bg-foreground px-3 py-2 text-sm text-background disabled:opacity-50"
					>
						Add proxy pool
					</button>
					{lastResult && (
						<div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
							Last test: {lastResult.ok ? "ok" : "failed"} in{" "}
							{lastResult.elapsedMs}ms
							{lastResult.error ? ` - ${lastResult.error}` : ""}
						</div>
					)}
				</div>
			</div>

			<div className="rounded-lg border bg-card">
				<div className="grid grid-cols-[100px_1fr_90px_90px_150px] gap-3 border-b px-4 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					<span>Status</span>
					<span>Proxy</span>
					<span>Type</span>
					<span>Active</span>
					<span>Actions</span>
				</div>
				<div className="divide-y">
					{proxyPools.isLoading ? (
						<p className="px-4 py-3 text-sm text-muted-foreground">
							Loading proxy pools...
						</p>
					) : (proxyPools.data ?? []).length === 0 ? (
						<p className="px-4 py-3 text-sm text-muted-foreground">
							No proxy pools configured.
						</p>
					) : (
						(proxyPools.data ?? []).map((pool) => (
							<div
								key={pool.id}
								className="grid grid-cols-[100px_1fr_90px_90px_150px] gap-3 px-4 py-3 text-xs"
							>
								<span
									className={cn(
										pool.testStatus === "active"
											? "text-emerald-600 dark:text-emerald-400"
											: pool.testStatus === "error"
												? "text-amber-600 dark:text-amber-400"
												: "text-muted-foreground",
									)}
								>
									{pool.testStatus}
								</span>
								<div className="min-w-0">
									<div className="truncate font-medium">{pool.name}</div>
									<div className="truncate font-mono text-muted-foreground">
										{pool.proxyUrl}
									</div>
									{pool.lastError && (
										<div className="truncate text-muted-foreground">
											{pool.lastError}
										</div>
									)}
								</div>
								<span>{pool.type}</span>
								<button
									type="button"
									onClick={() =>
										updateProxyPool.mutate({
											id: pool.id,
											isActive: !pool.isActive,
										})
									}
									className="text-left text-muted-foreground hover:text-foreground"
								>
									{pool.isActive ? "on" : "off"}
								</button>
								<div className="flex flex-wrap gap-2">
									<button
										type="button"
										onClick={() => testPool(pool)}
										disabled={testProxyPool.isPending}
										className="rounded-md border px-2 py-1 text-xs enabled:hover:bg-muted disabled:opacity-50"
									>
										Test
									</button>
									<button
										type="button"
										onClick={() => deleteProxyPool.mutate({ id: pool.id })}
										disabled={deleteProxyPool.isPending}
										className="rounded-md border px-2 py-1 text-xs text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
									>
										Delete
									</button>
								</div>
							</div>
						))
					)}
				</div>
			</div>
		</section>
	);
}

function CombosTab({ data }: { data: RouterDashboardSnapshot }) {
	return (
		<section className="grid gap-3 lg:grid-cols-2">
			{data.combos.map((combo) => (
				<div key={combo.name} className="rounded-lg border bg-card p-4">
					<div className="flex items-start justify-between gap-3">
						<div>
							<h2 className="text-sm font-semibold">{combo.name}</h2>
							<p className="mt-1 text-xs text-muted-foreground">
								{combo.description}
							</p>
						</div>
						<Pill>{combo.strategy}</Pill>
					</div>

					<div className="mt-4 flex flex-wrap items-center gap-2">
						{combo.agents.map((agent, index) => (
							<div
								key={`${combo.name}-${agent}`}
								className="flex items-center gap-2"
							>
								<span className="rounded-md border bg-background px-2 py-1 text-xs font-medium">
									{agent}
								</span>
								{index < combo.agents.length - 1 && (
									<span className="text-xs text-muted-foreground">then</span>
								)}
							</div>
						))}
					</div>

					{combo.judge && (
						<div className="mt-4 rounded-md bg-muted/40 px-3 py-2 text-xs">
							Judge: <span className="font-medium">{combo.judge}</span>
						</div>
					)}
				</div>
			))}
		</section>
	);
}

function EndpointsTab({ data }: { data: RouterDashboardSnapshot }) {
	return (
		<section className="rounded-lg border bg-card">
			<div className="grid grid-cols-[120px_1fr_120px_1fr_140px] gap-3 border-b px-4 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				<span>Method</span>
				<span>Path</span>
				<span>API</span>
				<span>Capability</span>
				<span>Status</span>
			</div>
			<div className="divide-y">
				{data.endpoints.map((endpoint) => (
					<div
						key={`${endpoint.method}-${endpoint.path}`}
						className="grid grid-cols-[120px_1fr_120px_1fr_140px] gap-3 px-4 py-3 text-sm"
					>
						<span className="font-mono text-xs">{endpoint.method}</span>
						<span className="min-w-0 truncate font-mono text-xs">
							{endpoint.path}
						</span>
						<span className="text-xs">{endpoint.compatibility}</span>
						<span className="min-w-0 truncate text-xs text-muted-foreground">
							{endpoint.capability}
						</span>
						<EndpointBadge status={endpoint.status} />
					</div>
				))}
			</div>
		</section>
	);
}

function TokenSaversTab({ data }: { data: RouterDashboardSnapshot }) {
	const [mode, setMode] = useState<RouterTokenSaverMode>("rtk");
	const [input, setInput] = useState(SAMPLE_TOKEN_INPUT);
	const utils = electronTrpc.useUtils();
	const settings = electronTrpc.agentRouter.tokenSaverSettings.useQuery();
	const updateSettings =
		electronTrpc.agentRouter.updateTokenSaverSettings.useMutation({
			onSuccess: () => utils.agentRouter.tokenSaverSettings.invalidate(),
		});
	const preview = useMemo(
		() => previewRouterTokenSaver({ text: input, mode }),
		[input, mode],
	);
	const savedPct =
		preview.result.bytesBefore > 0
			? Math.round(
					(preview.result.savedBytes / preview.result.bytesBefore) * 100,
				)
			: 0;

	return (
		<section className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
			<div className="rounded-lg border bg-card p-4">
				<div className="flex items-center justify-between gap-3">
					<div>
						<h2 className="text-sm font-semibold">Live token savers</h2>
						<p className="mt-1 text-xs text-muted-foreground">
							Applied automatically before provider routing.
						</p>
					</div>
					{updateSettings.isPending && (
						<span className="text-xs text-muted-foreground">Saving...</span>
					)}
				</div>
				<div className="mt-4 grid gap-2">
					{[
						{
							key: "rtkEnabled",
							label: "RTK",
							note: "Compress tool output",
						},
						{
							key: "headroomEnabled",
							label: "Headroom",
							note: "Use local compression proxy",
						},
						{
							key: "cavemanEnabled",
							label: "Caveman",
							note: "Terse technical answers",
						},
						{
							key: "ponytailEnabled",
							label: "Ponytail",
							note: "Minimal YAGNI-first changes",
						},
					].map((item) => {
						const enabled = Boolean(
							settings.data?.[
								item.key as
									| "rtkEnabled"
									| "headroomEnabled"
									| "cavemanEnabled"
									| "ponytailEnabled"
							],
						);
						return (
							<label
								key={item.key}
								className="flex cursor-pointer items-center justify-between gap-3 rounded-md border bg-background px-3 py-2.5"
							>
								<span>
									<span className="block text-xs font-medium">
										{item.label}
									</span>
									<span className="mt-0.5 block text-[11px] text-muted-foreground">
										{item.note}
									</span>
								</span>
								<input
									type="checkbox"
									checked={enabled}
									onChange={(event) =>
										updateSettings.mutate({
											[item.key]: event.target.checked,
										})
									}
									className="size-4 accent-foreground"
								/>
							</label>
						);
					})}
				</div>

				{settings.data?.headroomEnabled && (
					<div className="mt-3 grid gap-2">
						<label className="grid gap-1 text-xs font-medium">
							Headroom URL
							<input
								defaultValue={settings.data.headroomUrl}
								onBlur={(event) => {
									if (event.target.value !== settings.data?.headroomUrl) {
										updateSettings.mutate({ headroomUrl: event.target.value });
									}
								}}
								className="rounded-md border bg-background px-3 py-2 font-mono text-xs"
							/>
						</label>
						<label className="flex items-center gap-2 text-xs text-muted-foreground">
							<input
								type="checkbox"
								checked={settings.data.headroomCompressUserMessages}
								onChange={(event) =>
									updateSettings.mutate({
										headroomCompressUserMessages: event.target.checked,
									})
								}
								className="size-4 accent-foreground"
							/>
							Also compress user messages
						</label>
					</div>
				)}

				<h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Preview mode
				</h3>
				<div className="mt-4 flex flex-col gap-2">
					{data.tokenSavers.map((tokenSaver) => (
						<button
							key={tokenSaver.mode}
							type="button"
							onClick={() => setMode(tokenSaver.mode)}
							className={cn(
								"rounded-md border px-3 py-3 text-left transition-colors",
								mode === tokenSaver.mode
									? "border-foreground bg-foreground text-background"
									: "bg-background hover:bg-muted/60",
							)}
						>
							<div className="text-sm font-medium">{tokenSaver.label}</div>
							<div
								className={cn(
									"mt-1 text-xs",
									mode === tokenSaver.mode
										? "text-background/75"
										: "text-muted-foreground",
								)}
							>
								{tokenSaver.description}
							</div>
						</button>
					))}
				</div>
			</div>

			<div className="rounded-lg border bg-card p-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<h2 className="text-sm font-semibold">Compression preview</h2>
					<div className="flex gap-2 text-xs">
						<Pill>{preview.result.filter ?? "unchanged"}</Pill>
						<Pill>{savedPct}% saved</Pill>
					</div>
				</div>

				<div className="mt-4 grid gap-3 lg:grid-cols-2">
					<label className="flex flex-col gap-2 text-xs font-medium">
						Input
						<textarea
							value={input}
							onChange={(event) => setInput(event.target.value)}
							className="min-h-72 resize-y rounded-md border bg-background p-3 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
						/>
					</label>
					<label className="flex flex-col gap-2 text-xs font-medium">
						Output
						<textarea
							value={preview.result.text}
							readOnly
							className="min-h-72 resize-y rounded-md border bg-muted/30 p-3 font-mono text-xs outline-none"
						/>
					</label>
				</div>

				<div className="mt-3 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
					{preview.notice ??
						"No compression was needed for this payload and mode."}
				</div>
			</div>
		</section>
	);
}

function UsageTab() {
	const utils = electronTrpc.useUtils();
	const { data, isLoading } = electronTrpc.agentRouter.usageStats.useQuery(
		undefined,
		{ refetchInterval: 15_000 },
	);
	const clearUsage = electronTrpc.agentRouter.clearUsage.useMutation({
		onSuccess: () => utils.agentRouter.usageStats.invalidate(),
	});

	if (isLoading || !data) {
		return (
			<div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
				Loading usage...
			</div>
		);
	}

	return (
		<section className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="grid flex-1 gap-3 md:grid-cols-4">
					<StatCard
						icon={LuActivity}
						label="Requests"
						value={data.totalRequests}
					/>
					<StatCard
						icon={LuBadgeCheck}
						label="Succeeded"
						value={data.successfulRequests}
					/>
					<StatCard
						icon={LuShieldAlert}
						label="Failed"
						value={data.failedRequests}
					/>
					<StatCard icon={LuGauge} label="Tokens" value={data.totalTokens} />
				</div>
				<button
					type="button"
					onClick={() => clearUsage.mutate()}
					disabled={clearUsage.isPending || data.totalRequests === 0}
					className="rounded-md border px-3 py-2 text-sm text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
				>
					Clear usage
				</button>
			</div>

			<div className="rounded-lg border bg-card p-4">
				<div className="flex items-center justify-between gap-3">
					<h2 className="text-sm font-semibold">Provider totals</h2>
					<Pill>${data.estimatedCostUsd.toFixed(4)} estimated</Pill>
				</div>
				<div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
					{data.byProvider.length === 0 ? (
						<p className="text-sm text-muted-foreground">No usage yet.</p>
					) : (
						data.byProvider.map((provider) => (
							<div
								key={provider.provider}
								className="rounded-md border bg-background px-3 py-2"
							>
								<div className="flex items-center justify-between gap-3">
									<span className="text-sm font-medium">
										{provider.provider}
									</span>
									<Pill>{provider.requests} req</Pill>
								</div>
								<div className="mt-2 flex justify-between text-xs text-muted-foreground">
									<span>{provider.totalTokens.toLocaleString()} tokens</span>
									<span>${provider.estimatedCostUsd.toFixed(4)}</span>
								</div>
							</div>
						))
					)}
				</div>
			</div>

			<div className="rounded-lg border bg-card">
				<div className="grid grid-cols-[140px_70px_1fr_100px_100px_80px] gap-3 border-b px-4 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					<span>Time</span>
					<span>Status</span>
					<span>Endpoint</span>
					<span>Model</span>
					<span>Account</span>
					<span>Tokens</span>
				</div>
				<div className="divide-y">
					{data.recentRequests.map((request) => (
						<div
							key={request.id}
							className="grid grid-cols-[140px_70px_1fr_100px_100px_80px] gap-3 px-4 py-3 text-xs"
						>
							<span className="text-muted-foreground">
								{new Date(request.timestamp).toLocaleTimeString()}
							</span>
							<span
								className={cn(
									request.success
										? "text-emerald-600 dark:text-emerald-400"
										: "text-amber-600 dark:text-amber-400",
								)}
							>
								{request.status}
							</span>
							<span className="truncate font-mono">{request.endpoint}</span>
							<span className="truncate">{request.model}</span>
							<span className="truncate text-muted-foreground">
								{request.accountName ?? "-"}
							</span>
							<span>{request.totalTokens.toLocaleString()}</span>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}

function AliasesTab() {
	const utils = electronTrpc.useUtils();
	const aliases = electronTrpc.agentRouter.aliases.useQuery();
	const customCombos = electronTrpc.agentRouter.customCombos.useQuery();
	const [alias, setAlias] = useState("");
	const [targetModel, setTargetModel] = useState("");
	const [comboName, setComboName] = useState("");
	const [comboModels, setComboModels] = useState("");
	const invalidate = () => {
		utils.agentRouter.aliases.invalidate();
		utils.agentRouter.customCombos.invalidate();
		utils.agentRouter.dashboard.invalidate();
	};
	const upsertAlias = electronTrpc.agentRouter.upsertAlias.useMutation({
		onSuccess: invalidate,
	});
	const deleteAlias = electronTrpc.agentRouter.deleteAlias.useMutation({
		onSuccess: invalidate,
	});
	const upsertCustomCombo =
		electronTrpc.agentRouter.upsertCustomCombo.useMutation({
			onSuccess: invalidate,
		});
	const deleteCustomCombo =
		electronTrpc.agentRouter.deleteCustomCombo.useMutation({
			onSuccess: invalidate,
		});

	const saveAlias = async () => {
		if (!alias.trim() || !targetModel.trim()) return;
		await upsertAlias.mutateAsync({
			alias: alias.trim(),
			targetModel: targetModel.trim(),
		});
		setAlias("");
		setTargetModel("");
	};

	const saveCombo = async () => {
		const models = comboModels
			.split(/[\n,]+/)
			.map((model) => model.trim())
			.filter(Boolean);
		if (!comboName.trim() || models.length === 0) return;
		await upsertCustomCombo.mutateAsync({
			name: comboName.trim(),
			models,
		});
		setComboName("");
		setComboModels("");
	};

	return (
		<section className="grid gap-4 lg:grid-cols-2">
			<div className="rounded-lg border bg-card p-4">
				<h2 className="text-sm font-semibold">Model aliases</h2>
				<div className="mt-4 grid gap-2 md:grid-cols-[1fr_1fr_auto]">
					<input
						value={alias}
						onChange={(event) => setAlias(event.target.value)}
						placeholder="alias, e.g. fast-code"
						className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
					/>
					<input
						value={targetModel}
						onChange={(event) => setTargetModel(event.target.value)}
						placeholder="target, e.g. openrouter/z-ai/glm-5.2"
						className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
					/>
					<button
						type="button"
						onClick={saveAlias}
						disabled={
							upsertAlias.isPending || !alias.trim() || !targetModel.trim()
						}
						className="rounded-md border px-3 py-2 text-sm text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
					>
						Save
					</button>
				</div>

				<div className="mt-4 flex flex-col gap-2">
					{(aliases.data ?? []).length === 0 ? (
						<p className="text-sm text-muted-foreground">No aliases yet.</p>
					) : (
						(aliases.data ?? []).map((entry) => (
							<div
								key={entry.alias}
								className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm"
							>
								<span className="min-w-0 truncate">
									<span className="font-mono">{entry.alias}</span>
									<span className="text-muted-foreground"> {"->"} </span>
									<span className="font-mono text-muted-foreground">
										{entry.targetModel}
									</span>
								</span>
								<button
									type="button"
									onClick={() => deleteAlias.mutate({ alias: entry.alias })}
									className="rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
								>
									Delete
								</button>
							</div>
						))
					)}
				</div>
			</div>

			<div className="rounded-lg border bg-card p-4">
				<h2 className="text-sm font-semibold">Custom combos</h2>
				<div className="mt-4 grid gap-2">
					<input
						value={comboName}
						onChange={(event) => setComboName(event.target.value)}
						placeholder="combo name, e.g. my-budget-stack"
						className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
					/>
					<textarea
						value={comboModels}
						onChange={(event) => setComboModels(event.target.value)}
						placeholder="models, comma or newline separated"
						className="min-h-24 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
					/>
					<button
						type="button"
						onClick={saveCombo}
						disabled={
							upsertCustomCombo.isPending ||
							!comboName.trim() ||
							!comboModels.trim()
						}
						className="w-fit rounded-md border px-3 py-2 text-sm text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
					>
						Save combo
					</button>
				</div>

				<div className="mt-4 flex flex-col gap-2">
					{(customCombos.data ?? []).length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No custom combos yet.
						</p>
					) : (
						(customCombos.data ?? []).map((combo) => (
							<div
								key={combo.name}
								className="rounded-md border bg-background px-3 py-2"
							>
								<div className="flex items-center justify-between gap-3">
									<span className="font-mono text-sm">{combo.name}</span>
									<button
										type="button"
										onClick={() =>
											deleteCustomCombo.mutate({ name: combo.name })
										}
										className="rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
									>
										Delete
									</button>
								</div>
								<div className="mt-2 flex flex-wrap gap-1.5">
									{combo.models.map((model) => (
										<Pill key={`${combo.name}-${model}`}>{model}</Pill>
									))}
								</div>
							</div>
						))
					)}
				</div>
			</div>
		</section>
	);
}

function FallbackTab({ data }: { data: RouterDashboardSnapshot }) {
	return (
		<section className="grid gap-4 lg:grid-cols-[0.7fr_1.3fr]">
			<div className="rounded-lg border bg-card p-4">
				<h2 className="text-sm font-semibold">Tier order</h2>
				<div className="mt-4 flex flex-col gap-2">
					{data.tierOrder.map((tier, index) => (
						<div
							key={tier}
							className="flex items-center justify-between rounded-md border bg-background px-3 py-2 text-sm"
						>
							<span className="font-medium">{tier}</span>
							<span className="text-xs text-muted-foreground">
								priority {index + 1}
							</span>
						</div>
					))}
				</div>
			</div>

			<div className="rounded-lg border bg-card p-4">
				<h2 className="text-sm font-semibold">Fallback triggers</h2>
				<div className="mt-4 grid gap-2 md:grid-cols-2">
					{data.fallbackRules.map((rule, index) => (
						<div
							key={`${rule.status ?? rule.text}-${index}`}
							className="rounded-md border bg-background px-3 py-2"
						>
							<div className="flex items-center justify-between gap-2">
								<span className="font-mono text-xs">
									{rule.text ?? `HTTP ${rule.status}`}
								</span>
								{rule.backoff && <Pill>backoff</Pill>}
							</div>
							<div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
								<span>{rule.reason}</span>
								<span>{Math.round(rule.cooldownMs / 1000)}s</span>
							</div>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}

function StatCard({
	icon: Icon,
	label,
	value,
}: {
	icon: typeof LuActivity;
	label: string;
	value: number;
}) {
	return (
		<div className="rounded-lg border bg-card p-4">
			<div className="flex items-center justify-between gap-3">
				<span className="text-xs font-medium text-muted-foreground">
					{label}
				</span>
				<Icon className="size-4 text-muted-foreground" />
			</div>
			<div className="mt-3 text-2xl font-semibold tabular-nums">
				{value.toLocaleString()}
			</div>
		</div>
	);
}

function Pill({ children }: { children: ReactNode }) {
	return (
		<span className="inline-flex items-center rounded-md border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
			{children}
		</span>
	);
}

function defaultNodeBaseUrl(type: RouterProviderNodeType): string {
	if (type === "anthropic-compatible") return "https://api.anthropic.com/v1";
	return "https://api.openai.com/v1";
}

function providerAccountAuthLabel(
	authType: RouterProviderAccountAuthType,
): string {
	if (authType === "oauth") return "OAuth";
	if (authType === "access-token") return "access token";
	return "API key";
}

function providerAccountSecretPlaceholder(
	authType: RouterProviderAccountAuthType,
): string {
	if (authType === "oauth") return "oauth token";
	if (authType === "access-token") return "access token";
	return "api key";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseDashboardJsonObject(value: string): {
	error?: string;
	value?: Record<string, unknown>;
} {
	const trimmed = value.trim();
	if (!trimmed) return {};
	try {
		const parsed = JSON.parse(trimmed);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { value: parsed as Record<string, unknown> };
		}
		return { error: "Metadata JSON must be an object." };
	} catch {
		return { error: "Metadata JSON is invalid." };
	}
}

function formatDashboardDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function parseDashboardModels(value: string): string[] {
	return value
		.split(/[\n,]+/)
		.map((model) => model.trim())
		.filter(Boolean);
}

function pricingRows(table: RouterPricingTable) {
	return Object.entries(table)
		.flatMap(([provider, models]) =>
			Object.entries(models).map(([model, pricing]) => ({
				provider,
				model,
				input: pricing.input,
				output: pricing.output,
				cached: pricing.cached,
			})),
		)
		.sort(
			(a, b) =>
				a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
		);
}

function parsePricingNumber(value: string): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function formatPricingValue(value: number | undefined): string {
	return typeof value === "number"
		? value.toFixed(4).replace(/\.?0+$/, "")
		: "-";
}

function TierBadge({ tier }: { tier: string }) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center rounded-md px-2 py-1 text-[11px] font-medium",
				tier === "subscription" &&
					"bg-sky-500/10 text-sky-700 dark:text-sky-300",
				tier === "cheap" &&
					"bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
				tier === "free" && "bg-stone-500/10 text-stone-700 dark:text-stone-300",
				tier === "local" && "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
				tier === "search" &&
					"bg-amber-500/10 text-amber-700 dark:text-amber-300",
				tier === "media" && "bg-rose-500/10 text-rose-700 dark:text-rose-300",
			)}
		>
			{tier}
		</span>
	);
}

function EndpointBadge({
	status,
}: {
	status: "native-dashboard" | "gateway-live" | "gateway-catalogued";
}) {
	const Icon =
		status === "native-dashboard" || status === "gateway-live"
			? LuGauge
			: status.includes("image")
				? LuImage
				: status.includes("audio")
					? LuAudioLines
					: status.includes("search")
						? LuSearch
						: LuNetwork;

	return (
		<span
			className={cn(
				"inline-flex w-fit items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium",
				status === "native-dashboard" || status === "gateway-live"
					? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
					: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
			)}
		>
			<Icon className="size-3" />
			{status}
		</span>
	);
}
