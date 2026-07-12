import { describe, expect, it } from "bun:test";
import {
	AGENT_COMBOS,
	buildSmartRoutingPlan,
	chooseComboForIntent,
	classifyFallbackError,
	estimateTaskUsage,
} from "./agent-router";

const task = {
	id: "task-1",
	slug: "router",
	title: "Add smart routing",
	description: "Implement 9router-style fallback and token saver.",
	priority: "high",
	statusName: "Todo",
	labels: ["architecture"],
};

describe("agent-router", () => {
	it("chooses fusion review for architecture work", () => {
		const combo = chooseComboForIntent("architecture");
		expect(combo.name).toBe("fable-orchestrated");
		expect(combo.strategy).toBe("fusion");
		expect(combo.judge).toBe("claude");
	});

	it("builds a tiered fallback plan with subscription, cheap, and free agents", () => {
		const plan = buildSmartRoutingPlan({
			task,
			intent: "implementation",
			primary: "codex",
			delegates: ["claude", "gemini"],
		});

		expect(plan.combo.name).toBe(AGENT_COMBOS["premium-coding"].name);
		expect(plan.fallbackChain[0]).toBe("codex");
		expect(plan.tieredFallback.subscription).toContain("claude");
		expect(plan.tieredFallback.cheap).toContain("glm");
		expect(plan.tieredFallback.free).toContain("opencode");
		expect(plan.usage.estimated).toBe(true);
	});

	it("classifies quota and rate-limit errors as fallbackable with backoff", () => {
		const first = classifyFallbackError({
			status: 429,
			text: "Rate limit exceeded",
		});
		const second = classifyFallbackError({
			status: 429,
			text: "Rate limit exceeded",
			backoffLevel: first.backoffLevel,
		});

		expect(first.shouldFallback).toBe(true);
		expect(first.reason).toBe("rate limited");
		expect(second.cooldownMs).toBeGreaterThan(first.cooldownMs);
	});

	it("estimates token usage with a safety buffer", () => {
		const usage = estimateTaskUsage(task);
		expect(usage.inputTokens).toBeGreaterThan(2000);
		expect(usage.outputTokens).toBe(4000);
		expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
	});
});
