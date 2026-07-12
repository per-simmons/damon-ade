import { describe, expect, it } from "bun:test";
import {
	createProviderStreamNormalizer,
	detectAgentProviderProtocol,
	getProviderExecutor,
	normalizeFinishReason,
	normalizeProviderChunk,
	takeAccumulatedArgumentsDelta,
} from "./agent-provider-executors";

describe("tool argument streaming", () => {
	it("emits only the new suffix from accumulated provider arguments", () => {
		const first = takeAccumulatedArgumentsDelta('{"x":', 0);
		const second = takeAccumulatedArgumentsDelta(
			'{"x":1}',
			first.emittedLength,
		);
		const completed = takeAccumulatedArgumentsDelta(
			'{"x":1}',
			second.emittedLength,
		);
		expect(first.delta + second.delta + completed.delta).toBe('{"x":1}');
		expect(completed.delta).toBe("");
	});
});

describe("agent provider protocol detection", () => {
	it("detects every specialized wire protocol", () => {
		expect(
			detectAgentProviderProtocol({ choices: [{ delta: { content: "hi" } }] }),
		).toBe("openai-chat");
		expect(
			detectAgentProviderProtocol({
				type: "response.output_text.delta",
				delta: "hi",
			}),
		).toBe("openai-responses");
		expect(
			detectAgentProviderProtocol({
				type: "content_block_delta",
				delta: { type: "text_delta", text: "hi" },
			}),
		).toBe("anthropic-messages");
		expect(
			detectAgentProviderProtocol({
				candidates: [{ content: { parts: [{ text: "hi" }] } }],
			}),
		).toBe("gemini-generate-content");
		expect(
			detectAgentProviderProtocol({
				type: "message",
				timestamp: "now",
				role: "assistant",
				content: "hi",
			}),
		).toBe("gemini-cli");
		expect(detectAgentProviderProtocol({ type: "assistant", text: "hi" })).toBe(
			"agent-compatible",
		);
	});

	it("honours gateway provider and api type hints", () => {
		expect(
			detectAgentProviderProtocol(
				{},
				{ provider: "openai", apiType: "responses" },
			),
		).toBe("openai-responses");
		expect(detectAgentProviderProtocol({}, { provider: "Cursor" })).toBe(
			"agent-compatible",
		);
		expect(getProviderExecutor("codex").protocol).toBe("openai-responses");
	});
});

describe("OpenAI normalizers", () => {
	it("normalizes fragmented chat SSE including tools, usage and finish", () => {
		const normalizer = createProviderStreamNormalizer({
			protocol: "openai-chat",
			contentType: "text/event-stream",
		});
		const events = [
			...normalizer.push('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'),
			...normalizer.push(
				'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\\"q\\":"}}]}}]}\n\n',
			),
			...normalizer.push(
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ADE\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}\n\n',
			),
			...normalizer.push("data: [DONE]\n\n"),
		];
		expect(
			events
				.filter((item) => item.type === "text-delta")
				.map((item) => item.text),
		).toEqual(["Hel", "lo"]);
		const tool = events.find((item) => item.type === "tool-call");
		expect(tool?.toolCall).toEqual(
			expect.objectContaining({
				id: "call_1",
				name: "lookup",
				arguments: '{"q":"ADE"}',
				input: { q: "ADE" },
			}),
		);
		expect(events.find((item) => item.type === "usage")?.usage).toEqual({
			inputTokens: 4,
			outputTokens: 3,
			totalTokens: 7,
		});
		expect(events.filter((item) => item.type === "finish")).toEqual([
			expect.objectContaining({
				finishReason: "tool-calls",
				providerReason: "tool_calls",
			}),
		]);
	});

	it("normalizes Responses/Codex events and completed response objects", () => {
		const normalizer = createProviderStreamNormalizer({ protocol: "codex" });
		const events = [
			...normalizer.push({
				type: "response.output_text.delta",
				delta: "answer",
			}),
			...normalizer.push({
				type: "response.reasoning_summary_text.delta",
				delta: "thinking",
			}),
			...normalizer.push({
				type: "response.output_item.added",
				output_index: 0,
				item: {
					type: "function_call",
					call_id: "call_x",
					name: "read_file",
					arguments: "",
				},
			}),
			...normalizer.push({
				type: "response.function_call_arguments.delta",
				output_index: 0,
				call_id: "call_x",
				delta: '{"path":',
			}),
			...normalizer.push({
				type: "response.function_call_arguments.done",
				output_index: 0,
				call_id: "call_x",
				arguments: '{"path":"a.ts"}',
			}),
			...normalizer.push({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						output_tokens_details: { reasoning_tokens: 2 },
					},
				},
			}),
		];
		expect(events).toContainEqual(
			expect.objectContaining({ type: "text-delta", text: "answer" }),
		);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "reasoning-delta", text: "thinking" }),
		);
		expect(
			events.find((item) => item.type === "tool-call")?.toolCall.input,
		).toEqual({ path: "a.ts" });
		expect(
			events.find((item) => item.type === "usage")?.usage.reasoningTokens,
		).toBe(2);
		expect(events.at(-1)).toEqual(
			expect.objectContaining({ type: "finish", finishReason: "stop" }),
		);
	});
});

describe("Anthropic Messages", () => {
	it("assembles input_json_delta blocks and maps token usage", () => {
		const normalizer = createProviderStreamNormalizer({
			protocol: "anthropic",
		});
		const input = [
			'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":8,"output_tokens":0}}}\n\n',
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Hi"}}\n\n',
			'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"search","input":{}}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"x\\"}"}}\n\n',
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\n\n',
		].join("");
		const events = normalizer.end(input);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "text-delta", text: "Hi" }),
		);
		expect(events.find((item) => item.type === "tool-call")?.toolCall).toEqual(
			expect.objectContaining({
				id: "toolu_1",
				name: "search",
				input: { query: "x" },
			}),
		);
		expect(
			events.filter((item) => item.type === "usage").map((item) => item.usage),
		).toEqual([
			{ inputTokens: 8, outputTokens: 0, totalTokens: 8 },
			{ inputTokens: 0, outputTokens: 4, totalTokens: 4 },
		]);
		expect(events.at(-1)).toEqual(
			expect.objectContaining({ type: "finish", finishReason: "tool-calls" }),
		);
	});
});

describe("Gemini normalizers", () => {
	it("normalizes generateContent text, thoughts, function calls and usage", () => {
		const events = normalizeProviderChunk({
			candidates: [
				{
					content: {
						parts: [
							{ text: "plan", thought: true },
							{ text: "done" },
							{ functionCall: { name: "run", args: { command: "pwd" } } },
						],
					},
					finishReason: "STOP",
				},
			],
			usageMetadata: {
				promptTokenCount: 6,
				candidatesTokenCount: 3,
				totalTokenCount: 9,
				cachedContentTokenCount: 2,
				thoughtsTokenCount: 1,
			},
		});
		expect(events).toContainEqual(
			expect.objectContaining({ type: "reasoning-delta", text: "plan" }),
		);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "text-delta", text: "done" }),
		);
		expect(
			events.find((item) => item.type === "tool-call")?.toolCall.input,
		).toEqual({ command: "pwd" });
		expect(events.find((item) => item.type === "usage")?.usage).toEqual({
			inputTokens: 6,
			outputTokens: 3,
			totalTokens: 9,
			cachedInputTokens: 2,
			reasoningTokens: 1,
		});
	});

	it("normalizes Gemini CLI stream-json NDJSON", () => {
		const normalizer = createProviderStreamNormalizer({
			protocol: "gemini-cli",
		});
		const events = normalizer.end(
			[
				JSON.stringify({
					type: "message",
					role: "assistant",
					content: "hello",
					timestamp: "now",
				}),
				JSON.stringify({
					type: "tool_use",
					tool_id: "t1",
					tool_name: "shell",
					parameters: { command: "ls" },
					timestamp: "now",
				}),
				JSON.stringify({
					type: "result",
					status: "success",
					stats: { input_tokens: 3, output_tokens: 2 },
					timestamp: "now",
				}),
			].join("\n"),
		);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "text-delta", text: "hello" }),
		);
		expect(events.find((item) => item.type === "tool-call")?.toolCall).toEqual(
			expect.objectContaining({
				id: "t1",
				name: "shell",
				input: { command: "ls" },
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "finish", finishReason: "stop" }),
		);
	});
});

describe("Cursor, Kiro and CommandCode-compatible streams", () => {
	it("normalizes fragmented NDJSON and structured errors", () => {
		const normalizer = createProviderStreamNormalizer({ provider: "kiro" });
		const first = normalizer.push('{"type":"assistant","text":"hel');
		const second = normalizer.push(
			'lo"}\n{"type":"tool_call","tool_call":{"id":"c1","name":"write","arguments":{"file":"x"}}}\n',
		);
		const third = normalizer.end(
			'{"type":"result","status":"success","usage":{"inputTokens":2,"outputTokens":1}}',
		);
		expect(first).toEqual([]);
		expect([...second, ...third]).toContainEqual(
			expect.objectContaining({ type: "text-delta", text: "hello" }),
		);
		expect(
			[...second, ...third].find((item) => item.type === "tool-call")?.toolCall
				.input,
		).toEqual({ file: "x" });

		const errors = normalizeProviderChunk(
			{
				type: "error",
				error: {
					message: "rate limited",
					code: "rate_limit",
					status: 429,
					retryable: true,
				},
			},
			{ protocol: "agent-compatible" },
		);
		expect(errors).toEqual([
			expect.objectContaining({
				type: "error",
				error: {
					message: "rate limited",
					code: "rate_limit",
					status: 429,
					retryable: true,
				},
			}),
		]);
	});

	it("normalizes Cursor-style nested assistant content", () => {
		const normalizer = createProviderStreamNormalizer({ provider: "cursor" });
		const events = normalizer.end(
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "nested" },
						{
							type: "tool_use",
							id: "cursor_tool",
							name: "read",
							input: { path: "README.md" },
						},
					],
					usage: { input_tokens: 5, output_tokens: 2 },
				},
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "text-delta", text: "nested" }),
		);
		expect(events.find((item) => item.type === "tool-call")?.toolCall).toEqual(
			expect.objectContaining({
				id: "cursor_tool",
				name: "read",
				input: { path: "README.md" },
			}),
		);
		expect(
			events.find((item) => item.type === "usage")?.usage.totalTokens,
		).toBe(7);
	});
});

describe("transport and finish edge cases", () => {
	it("supports JSON arrays and does not duplicate terminal events", () => {
		const normalizer = createProviderStreamNormalizer({
			protocol: "gemini-generate-content",
		});
		const events = normalizer.end(
			JSON.stringify([
				{ candidates: [{ content: { parts: [{ text: "a" }] } }] },
				{
					candidates: [
						{ content: { parts: [{ text: "b" }] }, finishReason: "MAX_TOKENS" },
					],
				},
			]),
		);
		expect(
			events
				.filter((item) => item.type === "text-delta")
				.map((item) => item.text),
		).toEqual(["a", "b"]);
		expect(events.filter((item) => item.type === "finish")).toHaveLength(1);
		expect(events.at(-1)).toEqual(
			expect.objectContaining({ finishReason: "length" }),
		);
	});

	it("normalizes provider finish reason variants", () => {
		expect(normalizeFinishReason("end_turn")).toBe("stop");
		expect(normalizeFinishReason("MAX_TOKENS")).toBe("length");
		expect(normalizeFinishReason("SAFETY")).toBe("content-filter");
		expect(normalizeFinishReason("cancelled")).toBe("cancelled");
	});
});
