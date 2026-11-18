/**
 * The shell ADE runs sessions in on Windows.
 *
 * Git Bash, when it can be found. Everything ADE types into a session is POSIX
 * shell: the runtime commands (`&&`-joined setup commands, the agent invoke
 * command that reads its prompt with `$(cat ...)`), the agent wrappers in ~/.ade/bin and
 * the notify hooks are all bash. Claude Code on Windows itself needs Git Bash,
 * and Git is already an ADE prerequisite, so it is the shell that makes every
 * runtime work unchanged.
 *
 * Without Git Bash, PowerShell: the runtimes (claude, codex)
 * still start, but the bash wrappers and hooks do not run.
 *
 * Never C:\Windows\System32\bash.exe: that is WSL, a different machine as far
 * as paths, PATH and installed CLIs go.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

let cachedGitBash: string | null | undefined;

function bashBesideGit(gitExe: string): string | null {
	// git.exe lives in <root>\cmd, <root>\bin or <root>\mingw64\bin;
	// the bash that sets up PATH and MSYSTEM is <root>\bin\bash.exe.
	let dir = path.dirname(gitExe);
	for (let i = 0; i < 3; i++) {
		const candidate = path.join(dir, "bin", "bash.exe");
		if (existsSync(candidate)) return candidate;
		dir = path.dirname(dir);
	}
	return null;
}

export function findGitBash(): string | null {
	if (cachedGitBash !== undefined) return cachedGitBash;
	cachedGitBash = locateGitBash();
	return cachedGitBash;
}

function locateGitBash(): string | null {
	// An explicit choice wins. CLAUDE_CODE_GIT_BASH_PATH is the variable Claude
	// Code reads for the same purpose, so a machine set up for it works here too.
	for (const key of ["ADE_GIT_BASH_PATH", "CLAUDE_CODE_GIT_BASH_PATH"]) {
		const value = process.env[key]?.trim();
		if (value && existsSync(value)) return value;
	}

	try {
		const found = execFileSync("where.exe", ["git"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
			windowsHide: true,
		});
		for (const gitExe of found.split(/\r?\n/).filter(Boolean)) {
			const bash = bashBesideGit(gitExe.trim());
			if (bash) return bash;
		}
	} catch {
		// git not on PATH; try the usual install folders below.
	}

	const roots = [
		process.env.ProgramFiles,
		process.env["ProgramFiles(x86)"],
		process.env.ProgramW6432,
		process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"),
	].filter((root): root is string => Boolean(root));
	for (const root of roots) {
		const candidate = path.join(root, "Git", "bin", "bash.exe");
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

export function getWindowsDefaultShell(): string {
	return findGitBash() ?? "powershell.exe";
}
