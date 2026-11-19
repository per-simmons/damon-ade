/**
 * Which model a workflow run actually uses.
 *
 * Settings name models by alias (fable, opus, sonnet, haiku) or by full ID.
 * When ADE talks to the Anthropic API directly, aliases are pinned to the
 * exact IDs below, so the model shown is the model that runs. When the user
 * has redirected aliases (ANTHROPIC_DEFAULT_*_MODEL) or uses a cloud provider
 * (Bedrock, Vertex, Foundry: IDs differ there), the alias is passed through
 * unchanged and Claude Code resolves it.
 *
 * IDs confirmed on https://platform.claude.com/docs/en/about-claude/models/overview
 * (2026-11-17). Being listed does not prove an account may use a model;
 * unavailable models are reported by the run and handled by the fallback
 * policy below.
 */

export const PINNED_MODEL_IDS: Record<string, string> = {
	fable: "claude-fable-5-2",
	opus: "claude-opus-5-5",
	sonnet: "claude-sonnet-5-5",
	haiku: "claude-haiku-5-5",
};

/** Most to least expensive. A fallback only ever moves right. */
export const MODEL_TIERS = ["fable", "opus", "sonnet", "haiku"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

const PROVIDER_ENV = [
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
];

function aliasOverridden(alias: string, env: NodeJS.ProcessEnv): boolean {
	return Boolean(env[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`]);
}

function usesCloudProvider(env: NodeJS.ProcessEnv): boolean {
	return PROVIDER_ENV.some((name) => {
		const value = env[name]?.trim().toLowerCase();
		return (
			value !== undefined && value !== "" && value !== "0" && value !== "false"
		);
	});
}

export interface ResolvedModel {
	/** What is passed to --model. */
	model: string;
	/** Why it is not pinned, when it is not. */
	note?: string;
}

/** The --model value for a configured model. */
export function resolveRunModel(
	configured: string,
	options: { pin: boolean; env?: NodeJS.ProcessEnv },
): ResolvedModel {
	const env = options.env ?? process.env;
	const base = configured.replace(/\[1m\]$/, "");
	const pinned = PINNED_MODEL_IDS[base];
	if (!pinned || !options.pin) return { model: configured };
	if (aliasOverridden(base, env)) {
		return {
			model: configured,
			note: `ANTHROPIC_DEFAULT_${base.toUpperCase()}_MODEL is set; using your alias mapping`,
		};
	}
	if (usesCloudProvider(env)) {
		return {
			model: configured,
			note: "a cloud provider is configured; the provider resolves the alias",
		};
	}
	return { model: configured.endsWith("[1m]") ? `${pinned}[1m]` : pinned };
}

/** The tier of a model alias or ID, if it is one of the known tiers. */
export function tierOf(model: string): ModelTier | undefined {
	const base = model.replace(/\[1m\]$/, "").toLowerCase();
	return MODEL_TIERS.find(
		(tier) =>
			base === tier ||
			base.startsWith(`claude-${tier}-`) ||
			base === `claude-${tier}`,
	);
}

/**
 * The next cheaper tier, for one fallback when a model is unavailable.
 * Unknown models get no fallback: ADE cannot tell whether another model is
 * cheaper.
 */
export function cheaperFallback(model: string): ModelTier | undefined {
	const tier = tierOf(model);
	if (!tier) return undefined;
	return MODEL_TIERS[MODEL_TIERS.indexOf(tier) + 1];
}
