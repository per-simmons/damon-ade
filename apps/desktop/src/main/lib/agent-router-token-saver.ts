import { applyRouterTokenSaver } from "@superset/shared/router-control-plane";

export interface RouterRequestTokenSaverSettings {
	rtkEnabled: boolean;
	headroomEnabled: boolean;
	headroomCompressUserMessages: boolean;
	headroomUrl: string;
	cavemanEnabled: boolean;
	cavemanLevel: string;
	ponytailEnabled: boolean;
	ponytailLevel: string;
}

export interface RouterRequestTokenSaverResult {
	body: Record<string, unknown>;
	changed: boolean;
	bytesBefore: number;
	bytesAfter: number;
	savedBytes: number;
	modes: string[];
	headroomFailed: boolean;
}

export type RouterRequestProtocol =
	| "openai-chat"
	| "openai-responses"
	| "anthropic-messages"
	| "gemini";

interface TransformStats {
	bytesBefore: number;
	bytesAfter: number;
	headroomFailed: boolean;
	modes: Set<string>;
}

interface WalkContext {
	toolPayload: boolean;
	userPayload: boolean;
	textPayload: boolean;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const TOOL_TEXT_KEYS = new Set([
	"content",
	"output",
	"response",
	"result",
	"text",
]);

const CAVEMAN_MARKER = "[ADE Caveman]";
const PONYTAIL_MARKER = "[ADE Ponytail]";

export async function applyRouterTokenSaversToRequest(
	input: unknown,
	settings: RouterRequestTokenSaverSettings,
	options: {
		fetchImpl?: FetchLike;
		headroomTimeoutMs?: number;
		protocol?: RouterRequestProtocol;
	} = {},
): Promise<RouterRequestTokenSaverResult> {
	const body = isRecord(input) ? input : {};
	const stats: TransformStats = {
		bytesBefore: 0,
		bytesAfter: 0,
		headroomFailed: false,
		modes: new Set<string>(),
	};
	const transformed = (await walkValue(
		body,
		{ toolPayload: false, userPayload: false, textPayload: false },
		settings,
		stats,
		options,
	)) as Record<string, unknown>;
	const withInstructions = injectEfficiencyInstructions(
		transformed,
		settings,
		options.protocol,
	);
	if (withInstructions !== transformed) {
		if (settings.cavemanEnabled) stats.modes.add("caveman");
		if (settings.ponytailEnabled) stats.modes.add("ponytail");
	}

	return {
		body: withInstructions,
		changed: stats.modes.size > 0,
		bytesBefore: stats.bytesBefore,
		bytesAfter: stats.bytesAfter,
		savedBytes: Math.max(0, stats.bytesBefore - stats.bytesAfter),
		modes: [...stats.modes],
		headroomFailed: stats.headroomFailed,
	};
}

async function walkValue(
	value: unknown,
	context: WalkContext,
	settings: RouterRequestTokenSaverSettings,
	stats: TransformStats,
	options: { fetchImpl?: FetchLike; headroomTimeoutMs?: number },
): Promise<unknown> {
	if (typeof value === "string") {
		if (!context.textPayload) return value;
		return compressText(value, context, settings, stats, options);
	}
	if (Array.isArray(value)) {
		return Promise.all(
			value.map((entry) => walkValue(entry, context, settings, stats, options)),
		);
	}
	if (!isRecord(value)) return value;

	const role = typeof value.role === "string" ? value.role.toLowerCase() : "";
	const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
	const toolPayload =
		context.toolPayload ||
		role === "tool" ||
		type === "tool_result" ||
		type === "function_call_output" ||
		type === "functionresponse";
	const userPayload = context.userPayload || role === "user";
	const output: Record<string, unknown> = {};

	for (const [key, entry] of Object.entries(value)) {
		const normalizedKey = key.toLowerCase();
		const nestedToolPayload =
			toolPayload ||
			normalizedKey === "functionresponse" ||
			normalizedKey === "toolresult" ||
			normalizedKey === "tool_result";
		const textPayload =
			(nestedToolPayload && TOOL_TEXT_KEYS.has(normalizedKey)) ||
			(settings.headroomCompressUserMessages &&
				userPayload &&
				(normalizedKey === "content" || normalizedKey === "text"));
		output[key] = await walkValue(
			entry,
			{
				toolPayload: nestedToolPayload,
				userPayload,
				textPayload,
			},
			settings,
			stats,
			options,
		);
	}
	return output;
}

async function compressText(
	text: string,
	context: WalkContext,
	settings: RouterRequestTokenSaverSettings,
	stats: TransformStats,
	options: { fetchImpl?: FetchLike; headroomTimeoutMs?: number },
): Promise<string> {
	stats.bytesBefore += text.length;
	let next = text;
	if (settings.rtkEnabled && context.toolPayload) {
		const result = applyRouterTokenSaver(next, "rtk");
		if (result.changed) {
			next = result.text;
			stats.modes.add("rtk");
		}
	}
	if (
		settings.headroomEnabled &&
		(context.toolPayload ||
			(settings.headroomCompressUserMessages && context.userPayload))
	) {
		const result = await compressWithHeadroom(
			next,
			settings.headroomUrl,
			options,
		);
		if (result.ok && result.text.length < next.length) {
			next = result.text;
			stats.modes.add("headroom");
		} else if (!result.ok) {
			stats.headroomFailed = true;
		}
	}
	stats.bytesAfter += next.length;
	return next;
}

async function compressWithHeadroom(
	text: string,
	baseUrl: string,
	options: { fetchImpl?: FetchLike; headroomTimeoutMs?: number },
): Promise<{ ok: true; text: string } | { ok: false }> {
	const fetchImpl: FetchLike =
		options.fetchImpl ?? ((url, init) => fetch(url, init));
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		options.headroomTimeoutMs ?? 4000,
	);
	try {
		const normalized = baseUrl.trim().replace(/\/+$/, "");
		const url = normalized.endsWith("/v1/compress")
			? normalized
			: `${normalized}/v1/compress`;
		const response = await fetchImpl(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text }),
			signal: controller.signal,
		});
		if (!response.ok) return { ok: false };
		const body = (await response.json()) as Record<string, unknown>;
		const compressed = [body.text, body.compressed, body.content].find(
			(value): value is string => typeof value === "string",
		);
		return compressed ? { ok: true, text: compressed } : { ok: false };
	} catch {
		return { ok: false };
	} finally {
		clearTimeout(timeout);
	}
}

function injectEfficiencyInstructions(
	body: Record<string, unknown>,
	settings: RouterRequestTokenSaverSettings,
	protocol?: RouterRequestProtocol,
): Record<string, unknown> {
	const prompts = [
		settings.cavemanEnabled
			? `${CAVEMAN_MARKER} Reply tersely. Keep technical substance, commands, errors, and safety details; remove greetings, repetition, and narration. Level: ${settings.cavemanLevel}.`
			: null,
		settings.ponytailEnabled
			? `${PONYTAIL_MARKER} Prefer the smallest correct change. Follow YAGNI, existing dependencies, and repository patterns; do not trade away validation, security, accessibility, or requested behavior. Level: ${settings.ponytailLevel}.`
			: null,
	].filter((value): value is string => Boolean(value));
	if (prompts.length === 0) return body;
	const instruction = prompts.join("\n");
	const serialized = JSON.stringify(body);
	if (
		serialized.includes(CAVEMAN_MARKER) ||
		serialized.includes(PONYTAIL_MARKER)
	) {
		return body;
	}

	if (protocol === "anthropic-messages") {
		const system =
			typeof body.system === "string"
				? `${body.system}\n${instruction}`
				: Array.isArray(body.system)
					? [...body.system, { type: "text", text: instruction }]
					: [{ type: "text", text: instruction }];
		return { ...body, system };
	}
	if (protocol === "gemini" || Array.isArray(body.contents)) {
		const current = isRecord(body.systemInstruction)
			? body.systemInstruction
			: {};
		const parts = Array.isArray(current.parts) ? current.parts : [];
		return {
			...body,
			systemInstruction: {
				...current,
				parts: [...parts, { text: instruction }],
			},
		};
	}
	if (Array.isArray(body.messages)) {
		return {
			...body,
			messages: [{ role: "system", content: instruction }, ...body.messages],
		};
	}
	if (typeof body.instructions === "string") {
		return { ...body, instructions: `${body.instructions}\n${instruction}` };
	}
	if (body.system !== undefined) {
		const system =
			typeof body.system === "string"
				? `${body.system}\n${instruction}`
				: [body.system, { type: "text", text: instruction }];
		return { ...body, system };
	}
	return { ...body, instructions: instruction };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
