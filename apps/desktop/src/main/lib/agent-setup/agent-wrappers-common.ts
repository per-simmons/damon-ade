import fs from "node:fs";
import path from "node:path";
import {
	type AgentBinary,
	BINARY_INSTALL,
} from "@superset/shared/agent-binaries";
import { BIN_DIR } from "./paths";

export const WRAPPER_MARKER = "# ADE agent-wrapper v2";

// Marker for the Windows .cmd sibling wrapper. Keeps the "agent-wrapper" needle
// so find_real_binary (bash) and the batch resolver both skip it on PATH.
export const WRAPPER_CMD_MARKER = "@rem ADE agent-wrapper v2 (cmd)";

/**
 * Default Windows exec body: run the resolved real binary with all args and
 * propagate its exit code. `call` returns control for both .exe and .cmd/.bat
 * targets (npm-shim CLIs are .cmd), so the trailing `exit /b` always runs.
 */
export const DEFAULT_CMD_EXEC_BODY = `call "%REAL_BIN%" %*\r\nexit /b %ERRORLEVEL%`;

/**
 * Marker substring present in every agent-wrapper header (ADE's own wrappers and
 * the user's Damon install both use "... agent-wrapper ..."). find_real_binary
 * skips any candidate whose header contains it, so a wrapper never resolves to
 * another wrapper.
 */
const WRAPPER_HEADER_NEEDLE = "agent-wrapper";

// Matches ADE-managed hook paths under the app home dir (~/.ade or
// ~/.ade-<workspace>). MUST be ADE's own dir, not ~/.damon — otherwise ADE would
// treat the user's real Damon install's hooks as its own and clobber them, and
// fail to recognize (so would duplicate) its own hooks in shared agent settings.
const SUPERSET_MANAGED_HOOK_PATH_PATTERN = /\/\.ade(?:-[^/'"\s\\]+)?\//;

export function writeFileIfChanged(
	filePath: string,
	content: string,
	mode: number,
): boolean {
	const existing = fs.existsSync(filePath)
		? fs.readFileSync(filePath, "utf-8")
		: null;
	if (existing === content) {
		try {
			fs.chmodSync(filePath, mode);
		} catch {
			// Best effort.
		}
		return false;
	}

	fs.writeFileSync(filePath, content, { mode });
	return true;
}

export function isSupersetManagedHookCommand(
	command: string | undefined,
	scriptName: string,
): boolean {
	if (!command) return false;
	const normalized = command.replaceAll("\\", "/");
	if (!normalized.includes(`/hooks/${scriptName}`)) return false;
	return SUPERSET_MANAGED_HOOK_PATH_PATTERN.test(normalized);
}

function buildRealBinaryResolver(): string {
	return `find_real_binary() {
  local name="$1"
  local IFS=:
  for dir in $PATH; do
    [ -z "$dir" ] && continue
    dir="\${dir%/}"
    case "$dir" in
      "${BIN_DIR}"|"$HOME"/.ade/bin|"$HOME"/.ade-*/bin) continue ;;
    esac
    local candidate="$dir/$name"
    if [ -x "$candidate" ] && [ ! -d "$candidate" ]; then
      # Skip other agent-wrapper shims (another ADE wrapper on PATH, or the
      # user's Damon install) so we resolve the real binary directly. Chaining
      # wrappers ping-pongs and keeps prepending --settings, which breaks the
      # CLI's interactive TUI.
      if head -c 512 "$candidate" 2>/dev/null | grep -qa "${WRAPPER_HEADER_NEEDLE}"; then
        continue
      fi
      printf "%s\\n" "$candidate"
      return 0
    fi
  done
  return 1
}
`;
}

function getMissingBinaryMessage(name: string): string {
	// Enrich with the per-tool install command + URL so the terminal fallback is
	// self-explanatory. Embedded inside a bash double-quoted echo, so the message
	// must stay on one line and avoid double quotes / $ / backticks (install
	// commands and URLs contain none).
	const info = BINARY_INSTALL[name as AgentBinary];
	if (info) {
		return `ADE: ${name} not found on PATH. Install ${info.label}: ${info.command} — ${info.url}`;
	}
	return `ADE: ${name} not found in PATH. Install it and ensure it is on PATH, then retry.`;
}

export function getWrapperPath(binaryName: string): string {
	return path.join(BIN_DIR, binaryName);
}

export function buildWrapperScript(
	binaryName: string,
	execLine: string,
): string {
	return `#!/bin/bash
${WRAPPER_MARKER}
# ADE wrapper for ${binaryName}

${buildRealBinaryResolver()}
REAL_BIN="$(find_real_binary "${binaryName}")"
if [ -z "$REAL_BIN" ]; then
  echo "${getMissingBinaryMessage(binaryName)}" >&2
  exit 127
fi

${execLine}
`;
}

// Escape a one-line message for a batch `echo`. Batch metacharacters must be
// caret-escaped; a literal `%` must be doubled; the em dash is downgraded to
// ASCII so it renders in cmd.exe's OEM code page instead of mojibake.
function escapeBatchEchoMessage(message: string): string {
	return message
		.replaceAll("—", "-")
		.replaceAll("%", "%%")
		.replace(/[&<>|^()]/g, (char) => `^${char}`);
}

/**
 * Windows sibling of buildWrapperScript. cmd.exe resolves `<name>.cmd` via
 * PATHEXT and PowerShell also picks it up from PATH, so this one file shims both
 * shells. The batch resolver mirrors find_real_binary: it walks `where <name>`
 * and skips any candidate whose file contains the "agent-wrapper" needle (our
 * own .cmd/bash shims and the user's Damon install), landing on the real binary.
 *
 * ponytail: the batch resolver skips wrappers only by the file-content marker,
 * not by an explicit BIN_DIR path check like the bash resolver — the marker
 * already covers our own shims on PATH, and dropping the path pipe avoids
 * breaking on candidate paths that contain cmd metacharacters.
 */
export function buildCmdWrapperScript(
	binaryName: string,
	cmdExecBody: string = DEFAULT_CMD_EXEC_BODY,
): string {
	const message = escapeBatchEchoMessage(getMissingBinaryMessage(binaryName));
	return [
		"@echo off",
		WRAPPER_CMD_MARKER,
		`@rem ADE wrapper for ${binaryName}`,
		"setlocal",
		'set "REAL_BIN="',
		`for /f "delims=" %%I in ('where "${binaryName}" 2^>nul') do call :_ade_pick "%%I"`,
		"if defined REAL_BIN goto :_ade_run",
		`>&2 echo ${message}`,
		"exit /b 127",
		":_ade_run",
		cmdExecBody,
		":_ade_pick",
		"if defined REAL_BIN goto :eof",
		'findstr /I /L /C:"agent-wrapper" %1 >nul 2>nul && goto :eof',
		'set "REAL_BIN=%~1"',
		"goto :eof",
		"",
	].join("\r\n");
}

export function createWrapper(
	binaryName: string,
	script: string,
	cmdExecBody?: string,
): void {
	const changed = writeFileIfChanged(getWrapperPath(binaryName), script, 0o755);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} ${binaryName} wrapper`,
	);

	// ponytail: cmd-only wrapper; native PowerShell function shims are not
	// implemented — the .cmd on PATH (resolved via PATHEXT) covers cmd.exe and
	// PowerShell both. The extensionless bash wrapper above is inert on Windows.
	if (process.platform === "win32") {
		const cmdScript = buildCmdWrapperScript(binaryName, cmdExecBody);
		const cmdChanged = writeFileIfChanged(
			`${getWrapperPath(binaryName)}.cmd`,
			cmdScript,
			0o755,
		);
		console.log(
			`[agent-setup] ${cmdChanged ? "Updated" : "Verified"} ${binaryName} .cmd wrapper`,
		);
	}
}
