export type AgentProviderProtocol =
	| "openai-chat"
	| "openai-responses"
	| "anthropic-messages"
	| "gemini-generate-content"
	| "gemini-cli"
	| "agent-compatible";

export type AgentProviderProtocolHint =
	| AgentProviderProtocol
	| "auto"
	| "openai"
	| "responses"
	| "codex"
	| "anthropic"
	| "claude"
	| "gemini"
	| "cursor"
	| "kiro"
	| "commandcode";

export type NormalizedFinishReason =
	| "stop"
	| "length"
	| "tool-calls"
	| "content-filter"
	| "cancelled"
	| "error"
	| "other";

export interface NormalizedProviderUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedInputTokens?: number;
	reasoningTokens?: number;
}

export interface NormalizedProviderToolCall {
	id: string;
	index: number;
	name: string;
	arguments: string;
	input?: unknown;
}

export function takeAccumulatedArgumentsDelta(
	argumentsValue: string,
	emittedLength: number,
): { delta: string; emittedLength: number } {
	const safeLength = Math.max(
		0,
		Math.min(emittedLength, argumentsValue.length),
	);
	return {
		delta: argumentsValue.slice(safeLength),
		emittedLength: Math.max(emittedLength, argumentsValue.length),
	};
}

export interface NormalizedProviderError {
	message: string;
	code?: string;
	status?: number;
	retryable?: boolean;
	type?: string;
}

interface NormalizedProviderEventBase {
	protocol: AgentProviderProtocol;
	raw?: unknown;
}

export type NormalizedProviderEvent =
	| (NormalizedProviderEventBase & {
			type: "text-delta";
			text: string;
	  })
	| (NormalizedProviderEventBase & {
			type: "reasoning-delta";
			text: string;
	  })
	| (NormalizedProviderEventBase & {
			type: "tool-call-delta";
			toolCall: NormalizedProviderToolCall;
	  })
	| (NormalizedProviderEventBase & {
			type: "tool-call";
			toolCall: NormalizedProviderToolCall;
	  })
	| (NormalizedProviderEventBase & {
			type: "usage";
			usage: NormalizedProviderUsage;
	  })
	| (NormalizedProviderEventBase & {
			type: "finish";
			finishReason: NormalizedFinishReason;
			providerReason?: string;
	  })
	| (NormalizedProviderEventBase & {
			type: "error";
			error: NormalizedProviderError;
	  });

export interface AgentProviderNormalizerOptions {
	protocol?: AgentProviderProtocolHint;
	provider?: string;
	apiType?: "chat" | "responses";
	contentType?: string;
}

export interface AgentProviderExecutor {
	readonly protocol: AgentProviderProtocol;
	detect(payload: unknown): boolean;
	normalize(
		payload: unknown,
		state?: AgentProviderNormalizationState,
	): NormalizedProviderEvent[];
}

type JsonObject = Record<string, unknown>;

interface PendingToolCall {
	id: string;
	index: number;
	name: string;
	arguments: string;
	emitted: boolean;
}

export interface AgentProviderNormalizationState {
	toolCalls: Map<string, PendingToolCall>;
	toolBlockIds: Map<number, string>;
	nextToolIndex: number;
	finished: boolean;
}

function createState(): AgentProviderNormalizationState {
	return {
		toolCalls: new Map(),
		toolBlockIds: new Map(),
		nextToolIndex: 0,
		finished: false,
	};
}

const PROTOCOL_ALIASES: Record<string, AgentProviderProtocol> = {
	"openai-chat": "openai-chat",
	openai: "openai-chat",
	chat: "openai-chat",
	"openai-responses": "openai-responses",
	responses: "openai-responses",
	codex: "openai-responses",
	"anthropic-messages": "anthropic-messages",
	anthropic: "anthropic-messages",
	claude: "anthropic-messages",
	"gemini-generate-content": "gemini-generate-content",
	gemini: "gemini-generate-content",
	"gemini-cli": "gemini-cli",
	"agent-compatible": "agent-compatible",
	cursor: "agent-compatible",
	kiro: "agent-compatible",
	commandcode: "agent-compatible",
};

export function resolveAgentProviderProtocol(
	options: AgentProviderNormalizerOptions = {},
): AgentProviderProtocol | null {
	const hint = options.protocol?.toLowerCase();
	if (hint && hint !== "auto" && PROTOCOL_ALIASES[hint]) {
		if (hint === "gemini" && /cli/i.test(options.provider ?? "")) {
			return "gemini-cli";
		}
		if (
			(hint === "openai" || hint === "chat") &&
			options.apiType === "responses"
		) {
			return "openai-responses";
		}
		return PROTOCOL_ALIASES[hint];
	}
	if (options.apiType === "responses") return "openai-responses";
	const provider = options.provider?.toLowerCase() ?? "";
	if (/codex|responses/.test(provider)) return "openai-responses";
	if (/anthropic|claude/.test(provider)) return "anthropic-messages";
	if (/gemini.*cli|google.*cli/.test(provider)) return "gemini-cli";
	if (/gemini|google/.test(provider)) return "gemini-generate-content";
	if (/cursor|kiro|commandcode|command-code/.test(provider)) {
		return "agent-compatible";
	}
	if (/openai/.test(provider)) return "openai-chat";
	return null;
}

export function detectAgentProviderProtocol(
	payload: unknown,
	options: AgentProviderNormalizerOptions = {},
): AgentProviderProtocol | null {
	const configured = resolveAgentProviderProtocol(options);
	if (configured) return configured;
	const value = unwrapPayload(payload);
	if (!isObject(value)) return null;
	const type = stringValue(value.type);
	if (
		type.startsWith("response.") ||
		value.object === "response" ||
		Array.isArray(value.output)
	) {
		return "openai-responses";
	}
	if (
		type === "message_start" ||
		type === "message_delta" ||
		type === "message_stop" ||
		type.startsWith("content_block_") ||
		(Array.isArray(value.content) &&
			value.role === "assistant" &&
			"stop_reason" in value)
	) {
		return "anthropic-messages";
	}
	if (
		Array.isArray(value.choices) ||
		stringValue(value.object).startsWith("chat.completion")
	) {
		return "openai-chat";
	}
	if (Array.isArray(value.candidates) || isObject(value.usageMetadata)) {
		return "gemini-generate-content";
	}
	if (
		["init", "message", "tool_use", "tool_result", "result"].includes(type) &&
		("timestamp" in value || "stats" in value || "tool_name" in value)
	) {
		return "gemini-cli";
	}
	if (
		[
			"assistant",
			"assistant_message",
			"text",
			"tool",
			"tool_call",
			"completion",
			"result",
			"error",
		].includes(type) ||
		"toolCall" in value ||
		"tool_call" in value
	) {
		return "agent-compatible";
	}
	return null;
}

export const detectProviderProtocol = detectAgentProviderProtocol;

function normalizeOpenAiChat(
	payload: unknown,
	state: AgentProviderNormalizationState,
): NormalizedProviderEvent[] {
	const value = unwrapPayload(payload);
	if (!isObject(value)) return [];
	const error = extractError(value);
	if (error) return [event("openai-chat", "error", { error }, value)];
	const result: NormalizedProviderEvent[] = [];
	const choices = Array.isArray(value.choices) ? value.choices : [];
	for (const rawChoice of choices) {
		if (!isObject(rawChoice)) continue;
		const content = isObject(rawChoice.delta)
			? rawChoice.delta
			: isObject(rawChoice.message)
				? rawChoice.message
				: rawChoice;
		pushText(result, "openai-chat", content.content, value);
		pushReasoning(
			result,
			"openai-chat",
			content.reasoning_content ?? content.reasoning ?? content.thinking,
			value,
		);
		const calls = Array.isArray(content.tool_calls)
			? content.tool_calls
			: isObject(content.function_call)
				? [{ index: 0, function: content.function_call }]
				: [];
		for (const rawCall of calls) {
			if (!isObject(rawCall)) continue;
			const fn = isObject(rawCall.function) ? rawCall.function : rawCall;
			const index = finiteNumber(rawCall.index) ?? 0;
			const explicitId = stringValue(rawCall.id);
			const id = explicitId || state.toolBlockIds.get(index) || `tool_${index}`;
			if (explicitId) state.toolBlockIds.set(index, explicitId);
			const pending = upsertTool(
				state,
				id,
				index,
				stringValue(fn.name),
				stringValue(fn.arguments),
			);
			result.push(
				event(
					"openai-chat",
					"tool-call-delta",
					{ toolCall: toToolCall(pending) },
					value,
				),
			);
		}
		const reason = stringValue(
			rawChoice.finish_reason || rawChoice.finishReason,
		);
		if (reason) {
			flushTools(result, "openai-chat", state, value);
			pushFinish(result, "openai-chat", reason, state, value);
		}
	}
	const usage = normalizeUsage(value.usage);
	if (usage) result.push(event("openai-chat", "usage", { usage }, value));
	return result;
}

function normalizeOpenAiResponses(
	payload: unknown,
	state: AgentProviderNormalizationState,
): NormalizedProviderEvent[] {
	const value = unwrapPayload(payload);
	if (!isObject(value)) return [];
	const error = extractError(value);
	if (error || value.type === "response.failed") {
		const response = isObject(value.response) ? value.response : value;
		const responseError = error ??
			extractError(response) ?? {
				message:
					stringValue(
						isObject(response.incomplete_details) &&
							response.incomplete_details.reason,
					) || "OpenAI response failed",
			};
		return [
			event("openai-responses", "error", { error: responseError }, value),
		];
	}
	const result: NormalizedProviderEvent[] = [];
	const type = stringValue(value.type);
	if (
		type === "response.output_text.delta" ||
		type === "response.refusal.delta"
	) {
		pushText(result, "openai-responses", value.delta, value);
	} else if (
		type === "response.reasoning_summary_text.delta" ||
		type === "response.reasoning_text.delta"
	) {
		pushReasoning(result, "openai-responses", value.delta, value);
	} else if (
		type === "response.output_item.added" ||
		type === "response.output_item.done"
	) {
		const item = isObject(value.item) ? value.item : {};
		if (item.type === "function_call") {
			const index = finiteNumber(value.output_index) ?? state.nextToolIndex;
			const id = stringValue(item.call_id || item.id) || `tool_${index}`;
			const pending = upsertTool(
				state,
				id,
				index,
				stringValue(item.name),
				stringValue(item.arguments),
			);
			if (type.endsWith(".done"))
				pushCompletedTool(result, "openai-responses", pending, value);
			else
				result.push(
					event(
						"openai-responses",
						"tool-call-delta",
						{ toolCall: toToolCall(pending) },
						value,
					),
				);
		}
	} else if (
		type === "response.function_call_arguments.delta" ||
		type === "response.function_call_arguments.done"
	) {
		const index = finiteNumber(value.output_index) ?? 0;
		const id = stringValue(value.call_id || value.item_id) || `tool_${index}`;
		const pending = upsertTool(
			state,
			id,
			index,
			stringValue(value.name),
			type.endsWith(".done")
				? replaceString(value.arguments)
				: stringValue(value.delta),
			type.endsWith(".done"),
		);
		if (type.endsWith(".done"))
			pushCompletedTool(result, "openai-responses", pending, value);
		else
			result.push(
				event(
					"openai-responses",
					"tool-call-delta",
					{ toolCall: toToolCall(pending) },
					value,
				),
			);
	}
	const response = isObject(value.response) ? value.response : value;
	if (!type && Array.isArray(response.output)) {
		normalizeResponsesOutput(response.output, result, state, value);
	}
	const usage = normalizeUsage(response.usage ?? value.usage);
	if (usage) result.push(event("openai-responses", "usage", { usage }, value));
	if (
		type === "response.completed" ||
		(!type && response.status === "completed")
	) {
		flushTools(result, "openai-responses", state, value);
		pushFinish(
			result,
			"openai-responses",
			stringValue(response.status) || "completed",
			state,
			value,
		);
	} else if (
		type === "response.incomplete" ||
		(!type && response.status === "incomplete")
	) {
		const details = isObject(response.incomplete_details)
			? response.incomplete_details
			: {};
		flushTools(result, "openai-responses", state, value);
		pushFinish(
			result,
			"openai-responses",
			stringValue(details.reason) || "max_output_tokens",
			state,
			value,
		);
	}
	return result;
}

function normalizeResponsesOutput(
	output: unknown[],
	result: NormalizedProviderEvent[],
	state: AgentProviderNormalizationState,
	raw: unknown,
): void {
	for (const rawItem of output) {
		if (!isObject(rawItem)) continue;
		if (rawItem.type === "function_call") {
			const index = state.nextToolIndex;
			const pending = upsertTool(
				state,
				stringValue(rawItem.call_id || rawItem.id) || `tool_${index}`,
				index,
				stringValue(rawItem.name),
				stringValue(rawItem.arguments),
			);
			pushCompletedTool(result, "openai-responses", pending, raw);
			continue;
		}
		if (!Array.isArray(rawItem.content)) continue;
		for (const content of rawItem.content) {
			if (!isObject(content)) continue;
			if (content.type === "output_text")
				pushText(result, "openai-responses", content.text, raw);
			else if (
				content.type === "reasoning_text" ||
				content.type === "summary_text"
			) {
				pushReasoning(result, "openai-responses", content.text, raw);
			}
		}
	}
}

function normalizeAnthropic(
	payload: unknown,
	state: AgentProviderNormalizationState,
): NormalizedProviderEvent[] {
	const value = unwrapPayload(payload);
	if (!isObject(value)) return [];
	const error = extractError(value);
	if (error || value.type === "error") {
		return [
			event(
				"anthropic-messages",
				"error",
				{ error: error ?? { message: "Anthropic stream error" } },
				value,
			),
		];
	}
	const result: NormalizedProviderEvent[] = [];
	const type = stringValue(value.type);
	if (type === "message_start") {
		const message = isObject(value.message) ? value.message : {};
		const usage = normalizeUsage(message.usage);
		if (usage)
			result.push(event("anthropic-messages", "usage", { usage }, value));
	} else if (type === "content_block_start") {
		const block = isObject(value.content_block) ? value.content_block : {};
		const blockIndex = finiteNumber(value.index) ?? 0;
		if (block.type === "tool_use") {
			const id = stringValue(block.id) || `tool_${blockIndex}`;
			state.toolBlockIds.set(blockIndex, id);
			const input =
				isObject(block.input) && Object.keys(block.input).length === 0
					? ""
					: block.input === undefined
						? ""
						: JSON.stringify(block.input);
			const pending = upsertTool(
				state,
				id,
				state.nextToolIndex,
				stringValue(block.name),
				input,
			);
			result.push(
				event(
					"anthropic-messages",
					"tool-call-delta",
					{ toolCall: toToolCall(pending) },
					value,
				),
			);
		} else if (block.type === "text")
			pushText(result, "anthropic-messages", block.text, value);
		else if (block.type === "thinking")
			pushReasoning(result, "anthropic-messages", block.thinking, value);
	} else if (type === "content_block_delta") {
		const delta = isObject(value.delta) ? value.delta : {};
		if (delta.type === "text_delta")
			pushText(result, "anthropic-messages", delta.text, value);
		else if (delta.type === "thinking_delta")
			pushReasoning(result, "anthropic-messages", delta.thinking, value);
		else if (delta.type === "input_json_delta") {
			const blockIndex = finiteNumber(value.index) ?? 0;
			const id = state.toolBlockIds.get(blockIndex) ?? `tool_${blockIndex}`;
			const pending = upsertTool(
				state,
				id,
				blockIndex,
				"",
				stringValue(delta.partial_json),
			);
			result.push(
				event(
					"anthropic-messages",
					"tool-call-delta",
					{ toolCall: toToolCall(pending) },
					value,
				),
			);
		}
	} else if (type === "content_block_stop") {
		const blockIndex = finiteNumber(value.index) ?? 0;
		const id = state.toolBlockIds.get(blockIndex);
		const pending = id ? state.toolCalls.get(id) : undefined;
		if (pending)
			pushCompletedTool(result, "anthropic-messages", pending, value);
	} else if (type === "message_delta") {
		const usage = normalizeUsage(value.usage);
		if (usage)
			result.push(event("anthropic-messages", "usage", { usage }, value));
		const delta = isObject(value.delta) ? value.delta : {};
		const reason = stringValue(delta.stop_reason);
		if (reason) pushFinish(result, "anthropic-messages", reason, state, value);
	} else if (type === "message_stop") {
		flushTools(result, "anthropic-messages", state, value);
		pushFinish(result, "anthropic-messages", "end_turn", state, value);
	} else if (!type && Array.isArray(value.content)) {
		for (const block of value.content)
			normalizeAnthropic(
				{ ...block, type: "content_block_start", index: state.nextToolIndex },
				state,
			).forEach((item) => {
				result.push(item);
			});
		const usage = normalizeUsage(value.usage);
		if (usage)
			result.push(event("anthropic-messages", "usage", { usage }, value));
		const reason = stringValue(value.stop_reason);
		if (reason) {
			flushTools(result, "anthropic-messages", state, value);
			pushFinish(result, "anthropic-messages", reason, state, value);
		}
	}
	return result;
}

function normalizeGemini(
	payload: unknown,
	state: AgentProviderNormalizationState,
): NormalizedProviderEvent[] {
	const value = unwrapPayload(payload);
	if (!isObject(value)) return [];
	const error = extractError(value);
	if (error)
		return [event("gemini-generate-content", "error", { error }, value)];
	const result: NormalizedProviderEvent[] = [];
	for (const rawCandidate of Array.isArray(value.candidates)
		? value.candidates
		: []) {
		if (!isObject(rawCandidate)) continue;
		const content = isObject(rawCandidate.content) ? rawCandidate.content : {};
		for (const rawPart of Array.isArray(content.parts) ? content.parts : []) {
			if (!isObject(rawPart)) continue;
			if (typeof rawPart.text === "string") {
				if (rawPart.thought === true)
					pushReasoning(result, "gemini-generate-content", rawPart.text, value);
				else pushText(result, "gemini-generate-content", rawPart.text, value);
			}
			const call = isObject(rawPart.functionCall)
				? rawPart.functionCall
				: undefined;
			if (call) {
				const index = state.nextToolIndex;
				const id = stringValue(call.id) || `gemini_tool_${index}`;
				const args = call.args === undefined ? "{}" : JSON.stringify(call.args);
				const pending = upsertTool(
					state,
					id,
					index,
					stringValue(call.name),
					args,
				);
				pushCompletedTool(result, "gemini-generate-content", pending, value);
			}
		}
		const reason = stringValue(
			rawCandidate.finishReason || rawCandidate.finish_reason,
		);
		if (reason)
			pushFinish(result, "gemini-generate-content", reason, state, value);
	}
	const usage = normalizeUsage(value.usageMetadata ?? value.usage);
	if (usage)
		result.push(event("gemini-generate-content", "usage", { usage }, value));
	return result;
}

function normalizeCli(
	payload: unknown,
	state: AgentProviderNormalizationState,
	protocol: "gemini-cli" | "agent-compatible",
): NormalizedProviderEvent[] {
	const value = unwrapPayload(payload);
	if (!isObject(value)) return [];
	const error = extractError(value);
	if (error || value.type === "error") {
		return [
			event(
				protocol,
				"error",
				{
					error: error ?? {
						message:
							stringValue(value.error ?? value.message) || "Agent stream error",
					},
				},
				value,
			),
		];
	}
	const result: NormalizedProviderEvent[] = [];
	const type = stringValue(value.type || value.event).toLowerCase();
	const message = isObject(value.message) ? value.message : undefined;
	if (
		[
			"message",
			"assistant",
			"assistant_message",
			"text",
			"content",
			"completion",
		].includes(type)
	) {
		const role = stringValue(value.role || message?.role);
		if (!role || role === "assistant" || type !== "message") {
			pushText(
				result,
				protocol,
				value.content ??
					value.text ??
					message?.content ??
					value.message ??
					value.delta,
				value,
			);
		}
	}
	const content = Array.isArray(value.content)
		? value.content
		: Array.isArray(message?.content)
			? message.content
			: [];
	for (const part of content) {
		if (
			!isObject(part) ||
			!["tool", "tool_use", "tool_call"].includes(stringValue(part.type))
		) {
			continue;
		}
		const index = finiteNumber(part.index) ?? state.nextToolIndex;
		const id =
			stringValue(part.id || part.tool_id || part.call_id) || `tool_${index}`;
		const input = part.input ?? part.arguments ?? part.parameters;
		const args =
			typeof input === "string"
				? input
				: input === undefined
					? ""
					: JSON.stringify(input);
		const pending = upsertTool(
			state,
			id,
			index,
			stringValue(part.name || part.tool_name),
			args,
		);
		pushCompletedTool(result, protocol, pending, value);
	}
	const rawTool = isObject(value.toolCall)
		? value.toolCall
		: isObject(value.tool_call)
			? value.tool_call
			: value;
	if (
		[
			"tool_use",
			"tool",
			"tool_call",
			"tool_call_delta",
			"function_call",
			"function_call_delta",
		].includes(type) ||
		rawTool !== value
	) {
		const fn = isObject(rawTool.function) ? rawTool.function : undefined;
		const index = finiteNumber(rawTool.index) ?? state.nextToolIndex;
		const id =
			stringValue(rawTool.tool_id || rawTool.id || rawTool.call_id) ||
			`tool_${index}`;
		const name = stringValue(
			rawTool.tool_name || rawTool.name || fn?.name || rawTool.function,
		);
		const input =
			rawTool.parameters ??
			rawTool.input ??
			rawTool.arguments ??
			rawTool.args ??
			fn?.arguments;
		const args =
			typeof input === "string"
				? input
				: input === undefined
					? ""
					: JSON.stringify(input);
		const pending = upsertTool(state, id, index, name, args);
		if (type.endsWith("_delta")) {
			result.push(
				event(
					protocol,
					"tool-call-delta",
					{ toolCall: toToolCall(pending) },
					value,
				),
			);
		} else {
			pushCompletedTool(result, protocol, pending, value);
		}
	}
	const usage = normalizeUsage(
		value.usage ?? message?.usage ?? value.stats ?? value.metrics,
	);
	if (usage) result.push(event(protocol, "usage", { usage }, value));
	if (["result", "done", "complete", "completed", "finish"].includes(type)) {
		const status = stringValue(
			value.status || value.finish_reason || value.stop_reason,
		);
		if (/fail|error/i.test(status)) {
			result.push(
				event(
					protocol,
					"error",
					{
						error: {
							message:
								stringValue(value.error || value.message) ||
								`${protocol} failed`,
						},
					},
					value,
				),
			);
		} else pushFinish(result, protocol, status || "stop", state, value);
	}
	return result;
}

function makeExecutor(
	protocol: AgentProviderProtocol,
	normalize: (
		payload: unknown,
		state: AgentProviderNormalizationState,
	) => NormalizedProviderEvent[],
): AgentProviderExecutor {
	return {
		protocol,
		detect: (payload) => detectAgentProviderProtocol(payload) === protocol,
		normalize: (payload, state = createState()) => normalize(payload, state),
	};
}

export const AGENT_PROVIDER_EXECUTORS: Readonly<
	Record<AgentProviderProtocol, AgentProviderExecutor>
> = {
	"openai-chat": makeExecutor("openai-chat", normalizeOpenAiChat),
	"openai-responses": makeExecutor(
		"openai-responses",
		normalizeOpenAiResponses,
	),
	"anthropic-messages": makeExecutor("anthropic-messages", normalizeAnthropic),
	"gemini-generate-content": makeExecutor(
		"gemini-generate-content",
		normalizeGemini,
	),
	"gemini-cli": makeExecutor("gemini-cli", (payload, state) =>
		normalizeCli(payload, state, "gemini-cli"),
	),
	"agent-compatible": makeExecutor("agent-compatible", (payload, state) =>
		normalizeCli(payload, state, "agent-compatible"),
	),
};

export const providerExecutors = AGENT_PROVIDER_EXECUTORS;

export function getAgentProviderExecutor(
	protocol: AgentProviderProtocolHint,
): AgentProviderExecutor {
	const resolved = resolveAgentProviderProtocol({ protocol });
	if (!resolved)
		throw new Error(`Unsupported agent provider protocol: ${protocol}`);
	return AGENT_PROVIDER_EXECUTORS[resolved];
}

export const getProviderExecutor = getAgentProviderExecutor;

export class ProviderStreamNormalizer {
	private protocol: AgentProviderProtocol | null;
	private readonly options: AgentProviderNormalizerOptions;
	private readonly state = createState();
	private buffer = "";
	private sseEvent: string | undefined;
	private readonly decoder = new TextDecoder();

	constructor(options: AgentProviderNormalizerOptions = {}) {
		this.options = options;
		this.protocol = resolveAgentProviderProtocol(options);
	}

	get detectedProtocol(): AgentProviderProtocol | null {
		return this.protocol;
	}

	push(chunk: string | Uint8Array | unknown): NormalizedProviderEvent[] {
		if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
			return this.normalizePayload(chunk);
		}
		this.buffer +=
			typeof chunk === "string"
				? chunk
				: this.decoder.decode(chunk, { stream: true });
		return this.drain(false);
	}

	end(chunk?: string | Uint8Array): NormalizedProviderEvent[] {
		if (chunk !== undefined) {
			this.buffer +=
				typeof chunk === "string"
					? chunk
					: this.decoder.decode(chunk, { stream: true });
		}
		this.buffer += this.decoder.decode();
		return this.drain(true);
	}

	private drain(final: boolean): NormalizedProviderEvent[] {
		const result: NormalizedProviderEvent[] = [];
		const contentType = this.options.contentType?.toLowerCase() ?? "";
		const looksLikeSse =
			contentType.includes("text/event-stream") ||
			/^\s*(?:event|data|id):/m.test(this.buffer);
		if (looksLikeSse) {
			const blocks = this.buffer.split(/\r?\n\r?\n/);
			this.buffer = final ? "" : (blocks.pop() ?? "");
			if (final && blocks.length === 0 && this.buffer) blocks.push(this.buffer);
			for (const block of blocks) result.push(...this.normalizeSseBlock(block));
			return result;
		}
		const lines = this.buffer.split(/\r?\n/);
		this.buffer = final ? "" : (lines.pop() ?? "");
		for (const line of lines) result.push(...this.normalizeSerialized(line));
		if (final && this.buffer.trim()) {
			result.push(...this.normalizeSerialized(this.buffer));
			this.buffer = "";
		} else if (!final && this.buffer.trim()) {
			const parsed = parseJson(this.buffer.trim());
			if (parsed !== undefined) {
				this.buffer = "";
				result.push(...this.normalizePayload(parsed));
			}
		}
		return result;
	}

	private normalizeSseBlock(block: string): NormalizedProviderEvent[] {
		const data: string[] = [];
		for (const line of block.split(/\r?\n/)) {
			if (line.startsWith("event:")) this.sseEvent = line.slice(6).trim();
			else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
		}
		if (data.length === 0) return [];
		const serialized = data.join("\n");
		if (serialized === "[DONE]") return this.finishFromTransport();
		const parsed = parseJson(serialized);
		if (parsed === undefined) return [];
		if (this.sseEvent && isObject(parsed) && typeof parsed.type !== "string") {
			parsed.type = this.sseEvent;
		}
		this.sseEvent = undefined;
		return this.normalizePayload(parsed);
	}

	private normalizeSerialized(serialized: string): NormalizedProviderEvent[] {
		const trimmed = serialized.trim();
		if (!trimmed || trimmed.startsWith(":")) return [];
		if (trimmed === "[DONE]" || trimmed === "data: [DONE]")
			return this.finishFromTransport();
		const json = trimmed.startsWith("data:")
			? trimmed.slice(5).trimStart()
			: trimmed;
		const parsed = parseJson(json);
		if (parsed === undefined) return [];
		if (Array.isArray(parsed))
			return parsed.flatMap((item) => this.normalizePayload(item));
		return this.normalizePayload(parsed);
	}

	private normalizePayload(payload: unknown): NormalizedProviderEvent[] {
		this.protocol ??= detectAgentProviderProtocol(payload, this.options);
		if (!this.protocol) return [];
		return AGENT_PROVIDER_EXECUTORS[this.protocol].normalize(
			payload,
			this.state,
		);
	}

	private finishFromTransport(): NormalizedProviderEvent[] {
		if (!this.protocol || this.state.finished) return [];
		const result: NormalizedProviderEvent[] = [];
		flushTools(result, this.protocol, this.state, "[DONE]");
		pushFinish(result, this.protocol, "stop", this.state, "[DONE]");
		return result;
	}
}

export function createProviderStreamNormalizer(
	options: AgentProviderNormalizerOptions = {},
): ProviderStreamNormalizer {
	return new ProviderStreamNormalizer(options);
}

export function normalizeProviderChunk(
	payload: unknown,
	options: AgentProviderNormalizerOptions = {},
): NormalizedProviderEvent[] {
	const normalizer = createProviderStreamNormalizer(options);
	return typeof payload === "string" || payload instanceof Uint8Array
		? normalizer.end(payload)
		: normalizer.push(payload);
}

export const normalizeAgentProviderChunk = normalizeProviderChunk;

function pushText(
	result: NormalizedProviderEvent[],
	protocol: AgentProviderProtocol,
	value: unknown,
	raw: unknown,
): void {
	for (const text of extractText(value)) {
		if (text) result.push(event(protocol, "text-delta", { text }, raw));
	}
}

function pushReasoning(
	result: NormalizedProviderEvent[],
	protocol: AgentProviderProtocol,
	value: unknown,
	raw: unknown,
): void {
	for (const text of extractText(value)) {
		if (text) result.push(event(protocol, "reasoning-delta", { text }, raw));
	}
}

function extractText(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.flatMap((part) => {
		if (typeof part === "string") return [part];
		if (!isObject(part)) return [];
		return typeof part.text === "string" ? [part.text] : [];
	});
}

function upsertTool(
	state: AgentProviderNormalizationState,
	id: string,
	index: number,
	name: string,
	argumentsDelta: string,
	replace = false,
): PendingToolCall {
	let pending = state.toolCalls.get(id);
	if (!pending) {
		pending = { id, index, name, arguments: argumentsDelta, emitted: false };
		state.toolCalls.set(id, pending);
		state.nextToolIndex = Math.max(state.nextToolIndex, index + 1);
	} else {
		if (name) pending.name = name;
		pending.arguments = replace
			? argumentsDelta
			: pending.arguments + argumentsDelta;
	}
	return pending;
}

function toToolCall(pending: PendingToolCall): NormalizedProviderToolCall {
	const parsed = parseJson(pending.arguments);
	return {
		id: pending.id,
		index: pending.index,
		name: pending.name,
		arguments: pending.arguments,
		...(parsed !== undefined ? { input: parsed } : {}),
	};
}

function pushCompletedTool(
	result: NormalizedProviderEvent[],
	protocol: AgentProviderProtocol,
	pending: PendingToolCall,
	raw: unknown,
): void {
	if (pending.emitted) return;
	pending.emitted = true;
	result.push(
		event(protocol, "tool-call", { toolCall: toToolCall(pending) }, raw),
	);
}

function flushTools(
	result: NormalizedProviderEvent[],
	protocol: AgentProviderProtocol,
	state: AgentProviderNormalizationState,
	raw: unknown,
): void {
	for (const pending of state.toolCalls.values())
		pushCompletedTool(result, protocol, pending, raw);
}

function pushFinish(
	result: NormalizedProviderEvent[],
	protocol: AgentProviderProtocol,
	reason: string,
	state: AgentProviderNormalizationState,
	raw: unknown,
): void {
	if (state.finished) return;
	state.finished = true;
	result.push(
		event(
			protocol,
			"finish",
			{ finishReason: normalizeFinishReason(reason), providerReason: reason },
			raw,
		),
	);
}

export function normalizeFinishReason(reason: unknown): NormalizedFinishReason {
	const value = stringValue(reason)
		.toLowerCase()
		.replace(/[\s_]+/g, "-");
	if (
		[
			"stop",
			"completed",
			"complete",
			"success",
			"end-turn",
			"end-sequence",
			"stop-sequence",
		].includes(value)
	)
		return "stop";
	if (
		["length", "max-tokens", "max-output-tokens", "token-limit"].includes(value)
	)
		return "length";
	if (
		["tool-calls", "tool-use", "function-call", "function-calls"].includes(
			value,
		)
	)
		return "tool-calls";
	if (
		[
			"content-filter",
			"safety",
			"blocked",
			"recitation",
			"prohibited-content",
		].includes(value)
	)
		return "content-filter";
	if (["cancelled", "canceled", "abort", "aborted"].includes(value))
		return "cancelled";
	if (["error", "failed", "failure"].includes(value)) return "error";
	return "other";
}

export function normalizeProviderUsage(
	value: unknown,
): NormalizedProviderUsage | null {
	return normalizeUsage(value);
}

function normalizeUsage(value: unknown): NormalizedProviderUsage | null {
	if (!isObject(value)) return null;
	const input = firstNumber(value, [
		"input_tokens",
		"inputTokens",
		"prompt_tokens",
		"promptTokenCount",
		"prompt_tokens_count",
	]);
	const output = firstNumber(value, [
		"output_tokens",
		"outputTokens",
		"completion_tokens",
		"candidatesTokenCount",
		"completion_tokens_count",
	]);
	const total = firstNumber(value, [
		"total_tokens",
		"totalTokens",
		"totalTokenCount",
	]);
	const cached = firstNumber(value, [
		"cached_input_tokens",
		"cachedInputTokens",
		"cachedContentTokenCount",
		"cache_read_input_tokens",
	]);
	const reasoning = firstNumber(value, [
		"reasoning_tokens",
		"reasoningTokens",
		"thoughtsTokenCount",
	]);
	const inputDetails = isObject(value.input_tokens_details)
		? value.input_tokens_details
		: isObject(value.prompt_tokens_details)
			? value.prompt_tokens_details
			: undefined;
	const outputDetails = isObject(value.output_tokens_details)
		? value.output_tokens_details
		: isObject(value.completion_tokens_details)
			? value.completion_tokens_details
			: undefined;
	const normalizedInput = input ?? 0;
	const normalizedOutput = output ?? 0;
	if (
		input === undefined &&
		output === undefined &&
		total === undefined &&
		cached === undefined &&
		reasoning === undefined
	)
		return null;
	return {
		inputTokens: normalizedInput,
		outputTokens: normalizedOutput,
		totalTokens: total ?? normalizedInput + normalizedOutput,
		...((cached ?? firstNumber(inputDetails ?? {}, ["cached_tokens"])) !==
		undefined
			? {
					cachedInputTokens:
						cached ?? firstNumber(inputDetails ?? {}, ["cached_tokens"]),
				}
			: {}),
		...((reasoning ??
			firstNumber(outputDetails ?? {}, ["reasoning_tokens"])) !== undefined
			? {
					reasoningTokens:
						reasoning ?? firstNumber(outputDetails ?? {}, ["reasoning_tokens"]),
				}
			: {}),
	};
}

function extractError(value: JsonObject): NormalizedProviderError | null {
	const raw = isObject(value.error) ? value.error : undefined;
	if (!raw && value.type !== "error") return null;
	const source = raw ?? value;
	const nested = isObject(source.error) ? source.error : undefined;
	const message =
		stringValue(source.message || nested?.message || value.message) ||
		"Provider request failed";
	const code = stringValue(source.code || nested?.code);
	const status = finiteNumber(
		source.status || source.status_code || value.status,
	);
	const type = stringValue(source.type || nested?.type);
	const retryableValue = source.retryable ?? nested?.retryable;
	return {
		message,
		...(code ? { code } : {}),
		...(status !== undefined ? { status } : {}),
		...(typeof retryableValue === "boolean"
			? { retryable: retryableValue }
			: {}),
		...(type && type !== "error" ? { type } : {}),
	};
}

function event<T extends NormalizedProviderEvent["type"]>(
	protocol: AgentProviderProtocol,
	type: T,
	fields: Omit<
		Extract<NormalizedProviderEvent, { type: T }>,
		"protocol" | "type" | "raw"
	>,
	raw: unknown,
): Extract<NormalizedProviderEvent, { type: T }> {
	return { protocol, type, ...fields, raw } as Extract<
		NormalizedProviderEvent,
		{ type: T }
	>;
}

function unwrapPayload(payload: unknown): unknown {
	if (typeof payload !== "string") return payload;
	const trimmed = payload.trim();
	const serialized = trimmed.startsWith("data:")
		? trimmed.slice(5).trim()
		: trimmed;
	return parseJson(serialized) ?? payload;
}

function parseJson(value: string): unknown | undefined {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function replaceString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown): number | undefined {
	const number =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number(value)
				: Number.NaN;
	return Number.isFinite(number) ? number : undefined;
}

function firstNumber(value: JsonObject, keys: string[]): number | undefined {
	for (const key of keys) {
		const number = finiteNumber(value[key]);
		if (number !== undefined) return number;
	}
	return undefined;
}

function isObject(value: unknown): value is JsonObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
