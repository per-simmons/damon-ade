/**
 * Anthropic API list prices, USD per million tokens, for estimating the
 * API-equivalent cost of Claude Code sessions.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing, read
 * 2026-11-17. Re-check before quoting dollar figures. On a Claude subscription
 * these are estimates for comparison, not charges.
 */

export const PRICING_SOURCE =
	"platform.claude.com/docs/en/about-claude/pricing (read 2026-11-17)";

export interface ModelPrice {
	input: number;
	/** 5-minute cache write. */
	write5m: number;
	/** 1-hour cache write. */
	write1h: number;
	/** Cache hit or refresh. */
	read: number;
	output: number;
}

interface PriceEntry {
	standard: ModelPrice;
	/** Haiku 5.5 charges more when a request's prompt exceeds 100,000 tokens. */
	over100k?: ModelPrice;
}

export const MODEL_PRICES: Record<string, PriceEntry> = {
	"claude-fable-5-2": {
		standard: { input: 8, write5m: 10, write1h: 16, read: 0.2, output: 40 },
	},
	"claude-opus-5-5": {
		standard: { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 },
	},
	"claude-opus-5": {
		standard: { input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25 },
	},
	"claude-sonnet-5-5": {
		standard: { input: 2, write5m: 2.5, write1h: 4, read: 0.1, output: 10 },
	},
	"claude-sonnet-5": {
		standard: { input: 2, write5m: 2.5, write1h: 4, read: 0.2, output: 10 },
	},
	"claude-haiku-5-5": {
		standard: {
			input: 0.1,
			write5m: 0.125,
			write1h: 0.2,
			read: 0.01,
			output: 0.5,
		},
		over100k: {
			input: 0.5,
			write5m: 0.625,
			write1h: 1,
			read: 0.05,
			output: 2.5,
		},
	},
};

/** `inference_geo: "us"` multiplies every token category by 1.1. */
const US_GEO_MULTIPLIER = 1.1;
const HAIKU_TIER_THRESHOLD = 100_000;

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite5m: number;
	cacheWrite1h: number;
	speed?: string;
	geo?: string;
}

export type CostResult =
	| { usd: number; unpricedReason?: undefined }
	| { usd: null; unpricedReason: string };

/** Estimated list-price cost of one API response. */
export function estimateCost(model: string, usage: TokenUsage): CostResult {
	const entry = MODEL_PRICES[model];
	if (!entry) return { usd: null, unpricedReason: `no price for ${model}` };
	// Fast mode has separate prices that are not in this table.
	if (usage.speed && usage.speed !== "standard") {
		return { usd: null, unpricedReason: `${usage.speed} mode` };
	}

	const promptTokens =
		usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
	const price =
		entry.over100k && promptTokens > HAIKU_TIER_THRESHOLD
			? entry.over100k
			: entry.standard;

	const usd =
		(usage.input * price.input +
			usage.cacheWrite5m * price.write5m +
			usage.cacheWrite1h * price.write1h +
			usage.cacheRead * price.read +
			usage.output * price.output) /
		1_000_000;
	return { usd: usage.geo === "us" ? usd * US_GEO_MULTIPLIER : usd };
}
