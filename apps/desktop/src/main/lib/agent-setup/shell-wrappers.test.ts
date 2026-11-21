import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bashPath, forwardSlashPath } from "./shell-path";
import {
	createBashWrapper,
	createZshWrapper,
	getCommandShellArgs,
	getShellArgs,
	type ShellWrapperPaths,
} from "./shell-wrappers";

const TEST_ROOT = path.join(
	tmpdir(),
	`superset-shell-wrappers-${process.pid}-${Date.now()}`,
);
const TEST_BIN_DIR = path.join(TEST_ROOT, "bin");
const TEST_ZSH_DIR = path.join(TEST_ROOT, "zsh");
const TEST_BASH_DIR = path.join(TEST_ROOT, "bash");
// Shims and the rcfile path are written in bash form on Windows (shell-path.ts);
// on macOS and Linux these equal the plain paths.
const SHIM_BIN_DIR = bashPath(TEST_BIN_DIR);
const TEST_PATHS: ShellWrapperPaths = {
	BIN_DIR: TEST_BIN_DIR,
	ZSH_DIR: TEST_ZSH_DIR,
	BASH_DIR: TEST_BASH_DIR,
};

describe("shell-wrappers", () => {
	beforeEach(() => {
		mkdirSync(TEST_BIN_DIR, { recursive: true });
		mkdirSync(TEST_ZSH_DIR, { recursive: true });
		mkdirSync(TEST_BASH_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(TEST_ROOT, { recursive: true, force: true });
	});

	it("creates zsh wrappers with interactive .zlogin sourcing and command shims", () => {
		createZshWrapper(TEST_PATHS);

		const zshenv = readFileSync(path.join(TEST_ZSH_DIR, ".zshenv"), "utf-8");
		const zshrc = readFileSync(path.join(TEST_ZSH_DIR, ".zshrc"), "utf-8");
		const zlogin = readFileSync(path.join(TEST_ZSH_DIR, ".zlogin"), "utf-8");

		expect(zshenv).toContain('source "$_superset_home/.zshenv"');
		expect(zshenv).toContain(`export ZDOTDIR="${TEST_ZSH_DIR}"`);

		expect(zshrc).toContain("_superset_prepend_bin()");
		expect(zshrc).toContain(`claude() { "${SHIM_BIN_DIR}/claude" "$@"; }`);
		expect(zshrc).toContain(`codex() { "${SHIM_BIN_DIR}/codex" "$@"; }`);
		expect(zshrc).toContain(
			`mastracode() { "${SHIM_BIN_DIR}/mastracode" "$@"; }`,
		);
		expect(zshrc).toContain("rehash 2>/dev/null || true");

		expect(zlogin).toContain("if [[ -o interactive ]]; then");
		expect(zlogin).toContain('source "$_superset_home/.zlogin"');
		expect(zlogin).toContain("_superset_prepend_bin()");
		expect(zlogin).toContain(`claude() { "${SHIM_BIN_DIR}/claude" "$@"; }`);
		expect(zlogin).toContain(
			`mastracode() { "${SHIM_BIN_DIR}/mastracode" "$@"; }`,
		);
		expect(zlogin).toContain("rehash 2>/dev/null || true");
	});

	it("creates bash wrapper with command shims and idempotent PATH prepend", () => {
		createBashWrapper(TEST_PATHS);

		const rcfile = readFileSync(path.join(TEST_BASH_DIR, "rcfile"), "utf-8");
		expect(rcfile).toContain("_superset_prepend_bin()");
		expect(rcfile).toContain(`claude() { "${SHIM_BIN_DIR}/claude" "$@"; }`);
		expect(rcfile).toContain(`codex() { "${SHIM_BIN_DIR}/codex" "$@"; }`);
		expect(rcfile).toContain(
			`mastracode() { "${SHIM_BIN_DIR}/mastracode" "$@"; }`,
		);
		expect(rcfile).toContain("hash -r 2>/dev/null || true");
	});

	it("uses login zsh command args when wrappers exist", () => {
		createZshWrapper(TEST_PATHS);

		const args = getCommandShellArgs("/bin/zsh", "echo ok", TEST_PATHS);
		expect(args).toEqual([
			"-lc",
			`source "${path.join(TEST_ZSH_DIR, ".zshrc")}" && echo ok`,
		]);
	});

	it("falls back to login shell args when zsh wrappers are missing", () => {
		const args = getCommandShellArgs("/bin/zsh", "echo ok", TEST_PATHS);
		expect(args).toEqual(["-lc", "echo ok"]);
	});

	it("uses bash rcfile args for interactive bash shells", () => {
		expect(getShellArgs("/bin/bash", TEST_PATHS)).toEqual([
			"--rcfile",
			forwardSlashPath(path.join(TEST_BASH_DIR, "rcfile")),
		]);
	});

	it("uses login args for other interactive shells", () => {
		expect(getShellArgs("/bin/zsh")).toEqual(["-l"]);
		expect(getShellArgs("/bin/sh")).toEqual(["-l"]);
		expect(getShellArgs("/bin/ksh")).toEqual(["-l"]);
	});

	it("returns empty args for unrecognized shells", () => {
		expect(getShellArgs("/bin/csh")).toEqual([]);
		expect(getShellArgs("powershell")).toEqual([]);
	});

	describe("fish shell", () => {
		it("uses --init-command to prepend BIN_DIR to PATH for fish", () => {
			const args = getShellArgs("/opt/homebrew/bin/fish", TEST_PATHS);

			expect(args).toEqual([
				"-l",
				"--init-command",
				`set -l _superset_bin "${TEST_BIN_DIR}"; contains -- "$_superset_bin" $PATH; or set -gx PATH "$_superset_bin" $PATH`,
			]);
		});

		it("escapes fish init-command BIN_DIR safely", () => {
			const fishPath = '/tmp/with space/quote"buck$slash\\bin';
			const args = getShellArgs("/opt/homebrew/bin/fish", {
				...TEST_PATHS,
				BIN_DIR: fishPath,
			});

			expect(args).toEqual([
				"-l",
				"--init-command",
				`set -l _superset_bin "/tmp/with space/quote\\"buck\\$slash\\\\bin"; contains -- "$_superset_bin" $PATH; or set -gx PATH "$_superset_bin" $PATH`,
			]);
		});
	});
});
