/**
 * Builds the shell command an autonomous agent invoke (POST /agent/invoke)
 * runs in the agent's terminal.
 *
 * The model and session id end up unquoted on a shell command line, so each is
 * used only when it is a plain token (letters, digits and . _ - [ ]), e.g.
 * `fable`, `claude-sonnet-5-5`, `opus[1m]`, or a UUID. Anything else is dropped
 * rather than escaped: a value with spaces or shell syntax is never a valid
 * model name or session id. The prompt is single-quoted.
 */

const SAFE_CLI_TOKEN = /^[A-Za-z0-9._[\]-]+$/;

export function isSafeCliToken(value: string): boolean {
	return SAFE_CLI_TOKEN.test(value);
}

export interface AgentInvokeCommandParams {
	prompt: string;
	/** Claude Code model alias or full model ID. */
	model?: string;
	/** Session to pin (fresh) or resume. */
	claudeSessionId?: string;
	/** true = new session (pinned with --session-id when an id is given). */
	fresh: boolean;
}

function safeToken(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && isSafeCliToken(trimmed) ? trimmed : undefined;
}

export function buildAgentInvokeCommand({
	prompt,
	model,
	claudeSessionId,
	fresh,
}: AgentInvokeCommandParams): string {
	const sessionId = safeToken(claudeSessionId);
	const modelToken = safeToken(model);

	// Pin/resume a SPECIFIC claude session so repeated invokes share ONE
	// conversation deterministically. `--continue` is "most recent in this
	// folder", which is ambiguous when several sessions exist.
	const sessionFlag = sessionId
		? fresh
			? `--session-id ${sessionId} `
			: `--resume ${sessionId} `
		: fresh
			? ""
			: "--continue ";
	const modelFlag = modelToken ? `--model ${modelToken} ` : "";
	const escapedPrompt = prompt.replace(/'/g, "'\\''");

	return `claude ${sessionFlag}${modelFlag}--dangerously-skip-permissions '${escapedPrompt}'`;
}
