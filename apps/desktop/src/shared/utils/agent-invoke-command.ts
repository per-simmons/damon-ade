/**
 * Builds the command an autonomous agent invoke (POST /agent/invoke) types
 * into the agent's terminal.
 *
 * The prompt never appears on the command line. The main process writes it to
 * a private file, and the command reads it from there:
 * - POSIX shells (bash, zsh, sh): `"$(cat -- '<file>')"`. Command substitution
 *   inside double quotes passes the file's text as one argument, byte for byte
 *   (apart from trailing newlines), and its contents are never re-parsed as
 *   shell syntax.
 * - PowerShell and cmd.exe: neither can pass arbitrary text to a native
 *   program reliably (Windows PowerShell 5.1 mangles embedded double quotes),
 *   so the argument is a fixed instruction to read the file.
 *
 * Keeping prompt text off the command line also keeps its control characters
 * (Ctrl-C, Tab, escape sequences) out of the terminal's input, where the line
 * editor would act on them.
 *
 * The model and session id are interpolated as bare words, so each is used only
 * when it is a plain token (letters, digits and . _ - [ ]).
 */

export type InvokeShellKind = "posix" | "powershell" | "cmd";

const SAFE_CLI_TOKEN = /^[A-Za-z0-9._[\]-]+$/;

export function isSafeCliToken(value: string): boolean {
	return SAFE_CLI_TOKEN.test(value);
}

export interface AgentInvokeCommandParams {
	/** Absolute path of the file holding the prompt. */
	promptFile: string;
	shell: InvokeShellKind;
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

/** POSIX single quotes: nothing inside is special except the quote itself. */
export function posixQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell single quotes: literal text; a quote is escaped by doubling. */
function powershellQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

// Characters a path may not contain on the Windows instruction line: the quote
// that delimits it, cmd's % and ! expansion, line breaks and NUL.
const UNSAFE_WINDOWS_PATH = /["%!\r\n\0]/;

export function readPromptFileInstruction(promptFile: string): string {
	return `Read the file ${promptFile} and carry out the request in it exactly as written.`;
}

/**
 * The shell argument that passes the prompt in `promptFile` to a program
 * (see the module comment for why it is read from a file).
 */
export function promptArgument(
	promptFile: string,
	shell: InvokeShellKind,
): string {
	if (/[\r\n\0]/.test(promptFile)) {
		throw new Error("Prompt file path contains a line break or NUL");
	}
	if (shell === "posix") {
		return `"$(cat -- ${posixQuote(promptFile)})"`;
	}
	if (UNSAFE_WINDOWS_PATH.test(promptFile)) {
		throw new Error(`Prompt file path is not safe for ${shell}: ${promptFile}`);
	}
	const instruction = readPromptFileInstruction(promptFile);
	return shell === "powershell"
		? powershellQuote(instruction)
		: `"${instruction}"`;
}

export function buildAgentInvokeCommand({
	promptFile,
	shell,
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

	return `claude ${sessionFlag}${modelFlag}--dangerously-skip-permissions ${promptArgument(promptFile, shell)}`;
}
