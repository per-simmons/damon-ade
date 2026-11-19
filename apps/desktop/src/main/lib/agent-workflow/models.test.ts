import { describe, expect, it } from "bun:test";
import { cheaperFallback, resolveRunModel, tierOf } from "./models";

describe("resolveRunModel", () => {
	it("pins known aliases to their model IDs", () => {
		expect(resolveRunModel("opus", { pin: true, env: {} }).model).toBe(
			"claude-opus-5-5",
		);
		expect(resolveRunModel("fable", { pin: true, env: {} }).model).toBe(
			"claude-fable-5-2",
		);
		expect(resolveRunModel("opus", { pin: false, env: {} }).model).toBe("opus");
	});

	it("keeps full IDs and the user's or provider's overrides", () => {
		expect(
			resolveRunModel("claude-opus-4-5", { pin: true, env: {} }).model,
		).toBe("claude-opus-4-5");
		expect(
			resolveRunModel("opus", {
				pin: true,
				env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "my-opus" },
			}).model,
		).toBe("opus");
		expect(
			resolveRunModel("sonnet", {
				pin: true,
				env: { CLAUDE_CODE_USE_BEDROCK: "1" },
			}).model,
		).toBe("sonnet");
	});
});

describe("cheaperFallback", () => {
	it("only ever moves to a cheaper tier", () => {
		expect(cheaperFallback("claude-fable-5-2")).toBe("opus");
		expect(cheaperFallback("opus")).toBe("sonnet");
		expect(cheaperFallback("claude-sonnet-5-5")).toBe("haiku");
		expect(cheaperFallback("haiku")).toBeUndefined();
		expect(cheaperFallback("some-other-model")).toBeUndefined();
		expect(tierOf("claude-haiku-5-5")).toBe("haiku");
	});
});
