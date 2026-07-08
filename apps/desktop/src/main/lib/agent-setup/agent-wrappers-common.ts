import fs from "node:fs";
import path from "node:path";
import {
	type AgentBinary,
	BINARY_INSTALL,
} from "@superset/shared/agent-binaries";
import { BIN_DIR } from "./paths";
import { findRealBinary } from "./utils";

export const WRAPPER_MARKER = "# ADE agent-wrapper v2";

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

export function createWrapper(binaryName: string, script: string): void {
	const changed = writeFileIfChanged(getWrapperPath(binaryName), script, 0o755);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} ${binaryName} wrapper`,
	);
}

/**
 * Builds a Windows .cmd shim for an agent binary.
 *
 * Unlike the bash wrappers (which resolve the real binary at run time), the
 * real binary path is resolved once at setup time via where.exe and embedded
 * as an absolute path — batch has no sane equivalent of find_real_binary, and
 * an absolute path also rules out shim-recursion. setupAgentHooks runs on
 * every app boot, so a CLI installed after ADE is picked up on next launch.
 *
 * `extraArgsLine` is inserted verbatim before the user's arguments (%*),
 * e.g. `--settings "C:\...\claude-settings.json"`. `preludeLines` are emitted
 * before the exec line (e.g. `set "VAR=value"`).
 */
export function buildWindowsCmdWrapperScript(
	binaryName: string,
	options: { extraArgsLine?: string; preludeLines?: string[] } = {},
): string {
	const realBinary = findRealBinary(binaryName);
	const header = `@echo off\r\nrem ${WRAPPER_MARKER}\r\nrem ADE wrapper for ${binaryName}\r\n`;

	if (!realBinary) {
		// echo the same guidance the bash wrapper gives; keep it ASCII for cmd.
		const message = getMissingBinaryMessage(binaryName).replaceAll("—", "-");
		return `${header}echo ${message} 1>&2\r\nexit /b 127\r\n`;
	}

	const prelude = (options.preludeLines ?? [])
		.map((line) => `${line}\r\n`)
		.join("");
	const args = options.extraArgsLine ? `${options.extraArgsLine} ` : "";
	return `${header}${prelude}"${realBinary}" ${args}%*\r\n`;
}

export function createWindowsCmdWrapper(
	binaryName: string,
	options: { extraArgsLine?: string; preludeLines?: string[] } = {},
): void {
	const script = buildWindowsCmdWrapperScript(binaryName, options);
	const changed = writeFileIfChanged(
		getWrapperPath(`${binaryName}.cmd`),
		script,
		0o755,
	);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} ${binaryName}.cmd wrapper`,
	);
}
