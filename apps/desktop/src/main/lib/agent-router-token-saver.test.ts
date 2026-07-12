import { describe, expect, it } from "bun:test";
import { applyRouterTokenSaversToRequest } from "./agent-router-token-saver";

const baseSettings = {
	rtkEnabled: true,
	headroomEnabled: false,
	headroomCompressUserMessages: false,
	headroomUrl: "http://localhost:8787",
	cavemanEnabled: false,
	cavemanLevel: "full",
	ponytailEnabled: false,
	ponytailLevel: "full",
};

const largeLog = Array.from(
	{ length: 180 },
	(_, index) => `src/file-${index}.ts:${index}: repeated match`,
).join("\n");

describe("applyRouterTokenSaversToRequest", () => {
	it("compresses OpenAI tool messages without touching user text", async () => {
		const result = await applyRouterTokenSaversToRequest(
			{
				messages: [
					{ role: "user", content: largeLog },
					{ role: "tool", content: largeLog },
				],
			},
			baseSettings,
		);
		const messages = result.body.messages as Array<Record<string, unknown>>;
		expect(messages[0]?.content).toBe(largeLog);
		expect(String(messages[1]?.content).length).toBeLessThan(largeLog.length);
		expect(result.modes).toContain("rtk");
		expect(result.savedBytes).toBeGreaterThan(0);
	});

	it("handles Anthropic and Responses tool result shapes", async () => {
		const result = await applyRouterTokenSaversToRequest(
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "1", content: largeLog },
						],
					},
				],
				input: [
					{ type: "function_call_output", call_id: "2", output: largeLog },
				],
			},
			baseSettings,
		);
		expect(result.savedBytes).toBeGreaterThan(0);
		expect(JSON.stringify(result.body)).toContain("token-cut");
	});

	it("handles Gemini function responses", async () => {
		const result = await applyRouterTokenSaversToRequest(
			{
				contents: [
					{
						role: "user",
						parts: [
							{ functionResponse: { name: "search", response: largeLog } },
						],
					},
				],
			},
			baseSettings,
		);
		expect(result.savedBytes).toBeGreaterThan(0);
	});

	it("uses Headroom when available and fails open when unavailable", async () => {
		const available = await applyRouterTokenSaversToRequest(
			{ messages: [{ role: "tool", content: largeLog }] },
			{ ...baseSettings, rtkEnabled: false, headroomEnabled: true },
			{
				fetchImpl: async () =>
					new Response(JSON.stringify({ text: "compressed" }), { status: 200 }),
			},
		);
		expect(available.modes).toEqual(["headroom"]);

		const unavailable = await applyRouterTokenSaversToRequest(
			{ messages: [{ role: "tool", content: largeLog }] },
			{ ...baseSettings, rtkEnabled: false, headroomEnabled: true },
			{ fetchImpl: async () => new Response("down", { status: 503 }) },
		);
		expect(unavailable.headroomFailed).toBe(true);
		expect(unavailable.body).toEqual({
			messages: [{ role: "tool", content: largeLog }],
		});
	});

	it("injects Caveman and Ponytail instructions only once", async () => {
		const settings = {
			...baseSettings,
			cavemanEnabled: true,
			ponytailEnabled: true,
		};
		const first = await applyRouterTokenSaversToRequest(
			{ messages: [{ role: "user", content: "build it" }] },
			settings,
		);
		const second = await applyRouterTokenSaversToRequest(first.body, settings);
		const serialized = JSON.stringify(second.body);
		expect(serialized.match(/\[ADE Caveman\]/g)?.length).toBe(1);
		expect(serialized.match(/\[ADE Ponytail\]/g)?.length).toBe(1);
	});

	it("uses the top-level Anthropic system field", async () => {
		const result = await applyRouterTokenSaversToRequest(
			{ messages: [{ role: "user", content: "build it" }] },
			{ ...baseSettings, cavemanEnabled: true },
			{ protocol: "anthropic-messages" },
		);
		expect(result.body.messages).toEqual([
			{ role: "user", content: "build it" },
		]);
		expect(JSON.stringify(result.body.system)).toContain("[ADE Caveman]");
	});

	it("preserves existing Gemini system instructions", async () => {
		const result = await applyRouterTokenSaversToRequest(
			{
				contents: [{ role: "user", parts: [{ text: "build it" }] }],
				systemInstruction: { parts: [{ text: "Keep the safety policy." }] },
			},
			{ ...baseSettings, ponytailEnabled: true },
			{ protocol: "gemini" },
		);
		const serialized = JSON.stringify(result.body.systemInstruction);
		expect(serialized).toContain("Keep the safety policy.");
		expect(serialized).toContain("[ADE Ponytail]");
	});
});
