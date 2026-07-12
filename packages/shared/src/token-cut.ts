export type TokenCutFilter =
	| "git-diff"
	| "git-status"
	| "grep"
	| "find"
	| "ls"
	| "build-output"
	| "read-numbered"
	| "dedup-log"
	| "smart-truncate";

export interface TokenCutResult {
	text: string;
	changed: boolean;
	filter: TokenCutFilter | null;
	bytesBefore: number;
	bytesAfter: number;
	savedBytes: number;
}

export interface TokenCutOptions {
	minSize?: number;
	maxSize?: number;
	headLines?: number;
	tailLines?: number;
}

const DEFAULT_MIN_SIZE = 500;
const DEFAULT_MAX_SIZE = 10 * 1024 * 1024;
const DEFAULT_HEAD_LINES = 120;
const DEFAULT_TAIL_LINES = 60;
const DETECT_WINDOW = 1024;
const GIT_DIFF_CONTEXT_KEEP = 3;
const GIT_DIFF_HUNK_MAX_LINES = 120;
const GREP_PER_FILE_MAX = 10;
const FIND_PER_DIR_MAX = 10;
const FIND_TOTAL_DIR_MAX = 20;

const BUILD_OUTPUT_RE =
	/^(npm (warn|error|ERR!)|yarn (warn|error)|\s*Compiling\s+\S+|\s*Downloading\s+\S+|\[ERROR\]|BUILD (SUCCESS|FAILED)|\s*Finished\s+|Successfully (installed|built)|ERROR:)/i;
const GIT_STATUS_RE =
	/^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:/m;
const PORCELAIN_RE = /^[ MADRCU?!][ MADRCU?!] \S/;
const LS_ROW_RE = /^[-dlbcps][rwx-]{9}/;
const READ_NUMBERED_RE = /^\s*\d+\|/;

export function tokenCut(
	text: string,
	options: TokenCutOptions = {},
): TokenCutResult {
	const bytesBefore = text.length;
	const minSize = options.minSize ?? DEFAULT_MIN_SIZE;
	const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;

	if (bytesBefore < minSize || bytesBefore > maxSize) {
		return unchanged(text);
	}

	const filter = detectTokenCutFilter(text);
	if (!filter) return unchanged(text);

	const next = applyDetectedFilter(text, filter, options);
	if (!next || next.length >= text.length) {
		return unchanged(text);
	}

	return {
		text: next,
		changed: true,
		filter,
		bytesBefore,
		bytesAfter: next.length,
		savedBytes: bytesBefore - next.length,
	};
}

export function detectTokenCutFilter(text: string): TokenCutFilter | null {
	const head =
		text.length > DETECT_WINDOW ? text.slice(0, DETECT_WINDOW) : text;
	const lines = head.split("\n");
	const nonEmpty = lines.filter((line) => line.trim().length > 0);

	if (/^diff --git /m.test(head) || /^@@ /m.test(head)) return "git-diff";
	if (GIT_STATUS_RE.test(head) || isMostlyPorcelain(nonEmpty)) {
		return "git-status";
	}
	if (nonEmpty.some((line) => BUILD_OUTPUT_RE.test(line))) {
		return "build-output";
	}
	if (nonEmpty.slice(0, 5).some(isGrepLine)) return "grep";
	if (nonEmpty.length >= 3 && nonEmpty.every(isPathLike)) return "find";
	if (
		/^total \d+$/m.test(head) ||
		nonEmpty.filter((line) => LS_ROW_RE.test(line)).length >= 3
	) {
		return "ls";
	}
	if (lines.length >= 80 && isLineNumbered(lines)) return "read-numbered";
	if (nonEmpty.length >= 5 && hasDuplicates(nonEmpty)) return "dedup-log";
	if (text.split("\n").length >= 250) return "smart-truncate";

	return null;
}

export function formatTokenCutNotice(result: TokenCutResult): string {
	if (!result.changed || !result.filter) return "";
	const pct =
		result.bytesBefore > 0
			? Math.round((result.savedBytes / result.bytesBefore) * 100)
			: 0;
	return `[token-cut: compacted ${result.filter}, saved ${result.savedBytes} chars (${pct}%)]`;
}

function unchanged(text: string): TokenCutResult {
	return {
		text,
		changed: false,
		filter: null,
		bytesBefore: text.length,
		bytesAfter: text.length,
		savedBytes: 0,
	};
}

function applyDetectedFilter(
	text: string,
	filter: TokenCutFilter,
	options: TokenCutOptions,
): string {
	switch (filter) {
		case "git-diff":
			return compactGitDiff(text);
		case "git-status":
			return compactGitStatus(text);
		case "grep":
			return compactGrep(text);
		case "find":
			return compactPathList(text);
		case "ls":
			return compactLs(text);
		case "build-output":
			return compactBuildOutput(text, options);
		case "read-numbered":
		case "smart-truncate":
			return smartTruncate(text, options);
		case "dedup-log":
			return compactDuplicateLog(text, options);
	}
}

function compactGitDiff(text: string): string {
	const out: string[] = [];
	let omittedContext = 0;
	let contextKept = 0;
	let changedInHunk = 0;

	for (const line of text.split("\n")) {
		if (
			line.startsWith("diff --git ") ||
			line.startsWith("index ") ||
			line.startsWith("--- ") ||
			line.startsWith("+++ ") ||
			line.startsWith("@@ ")
		) {
			out.push(line);
			contextKept = 0;
			changedInHunk = 0;
			continue;
		}

		if (line.startsWith("+") || line.startsWith("-")) {
			if (changedInHunk < GIT_DIFF_HUNK_MAX_LINES) {
				out.push(line);
			} else {
				omittedContext++;
			}
			changedInHunk++;
			contextKept = 0;
			continue;
		}

		if (line.startsWith(" ")) {
			if (
				contextKept < GIT_DIFF_CONTEXT_KEEP &&
				changedInHunk < GIT_DIFF_HUNK_MAX_LINES
			) {
				out.push(line);
			} else {
				omittedContext++;
			}
			contextKept++;
			continue;
		}

		if (line.trim()) out.push(line);
	}

	if (omittedContext > 0) {
		out.push(`[token-cut omitted ${omittedContext} low-signal diff lines]`);
	}

	return out.join("\n");
}

function compactGitStatus(text: string): string {
	const lines = text.split("\n");
	if (lines.length <= 120) return text;
	return [
		...lines.slice(0, 80),
		`[token-cut omitted ${lines.length - 120} status lines]`,
		...lines.slice(-40),
	].join("\n");
}

function compactGrep(text: string): string {
	const byFile = new Map<string, string[]>();
	let omitted = 0;

	for (const line of text.split("\n")) {
		if (!isGrepLine(line)) {
			omitted++;
			continue;
		}
		const first = line.indexOf(":");
		const file = line.slice(0, first);
		const bucket = byFile.get(file) ?? [];
		if (bucket.length < GREP_PER_FILE_MAX) {
			bucket.push(line);
			byFile.set(file, bucket);
		} else {
			omitted++;
		}
	}

	const out: string[] = [];
	let fileCount = 0;
	for (const lines of byFile.values()) {
		if (fileCount >= FIND_TOTAL_DIR_MAX) {
			omitted += lines.length;
			continue;
		}
		out.push(...lines);
		fileCount++;
	}
	if (omitted > 0) out.push(`[token-cut omitted ${omitted} grep lines]`);
	return out.join("\n");
}

function compactPathList(text: string): string {
	const byDir = new Map<string, string[]>();
	let omitted = 0;

	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const slash = Math.max(line.lastIndexOf("/"), line.lastIndexOf("\\"));
		const dir = slash >= 0 ? line.slice(0, slash) : ".";
		const bucket = byDir.get(dir) ?? [];
		if (bucket.length < FIND_PER_DIR_MAX) {
			bucket.push(line);
			byDir.set(dir, bucket);
		} else {
			omitted++;
		}
	}

	const out: string[] = [];
	let dirCount = 0;
	for (const [dir, lines] of byDir) {
		if (dirCount >= FIND_TOTAL_DIR_MAX) {
			omitted += lines.length;
			continue;
		}
		out.push(`# ${dir}`, ...lines);
		dirCount++;
	}
	if (omitted > 0) out.push(`[token-cut omitted ${omitted} path lines]`);
	return out.join("\n");
}

function compactLs(text: string): string {
	const lines = text.split("\n");
	const visible = lines.filter((line) => !isNoisyLsEntry(line));
	if (visible.length === lines.length) return smartTruncate(text);
	return [
		...visible.slice(0, 120),
		`[token-cut omitted ${lines.length - visible.length} noisy ls entries]`,
	].join("\n");
}

function compactBuildOutput(
	text: string,
	options: TokenCutOptions = {},
): string {
	const lines = text.split("\n");
	const important = lines.filter((line) =>
		/(error|failed|failure|exception|panic|warn|warning|traceback|\[ERROR\])/i.test(
			line,
		),
	);
	const tail = lines.slice(-(options.tailLines ?? DEFAULT_TAIL_LINES));
	const merged = Array.from(new Set([...important, ...tail]));
	if (merged.length === lines.length) return smartTruncate(text, options);
	return [
		...merged,
		`[token-cut omitted ${lines.length - merged.length} build output lines]`,
	].join("\n");
}

function compactDuplicateLog(
	text: string,
	options: TokenCutOptions = {},
): string {
	const out: string[] = [];
	let previous = "";
	let count = 0;

	const flush = () => {
		if (!previous) return;
		out.push(count > 1 ? `${previous} [repeated ${count}x]` : previous);
	};

	for (const line of text.split("\n")) {
		if (line === previous) {
			count++;
			continue;
		}
		flush();
		previous = line;
		count = 1;
	}
	flush();

	return smartTruncate(out.join("\n"), options);
}

function smartTruncate(text: string, options: TokenCutOptions = {}): string {
	const lines = text.split("\n");
	const head = options.headLines ?? DEFAULT_HEAD_LINES;
	const tail = options.tailLines ?? DEFAULT_TAIL_LINES;
	if (lines.length <= head + tail + 1) return text;
	return [
		...lines.slice(0, head),
		`[token-cut omitted ${lines.length - head - tail} middle lines]`,
		...lines.slice(-tail),
	].join("\n");
}

function isGrepLine(line: string): boolean {
	const first = line.indexOf(":");
	if (first === -1) return false;
	const second = line.indexOf(":", first + 1);
	if (second === -1) return false;
	return /^\d+$/.test(line.slice(first + 1, second));
}

function isPathLike(line: string): boolean {
	const value = line.trim();
	if (!value || value.includes(":")) return false;
	return (
		value.startsWith(".") ||
		value.startsWith("/") ||
		value.includes("/") ||
		value.includes("\\")
	);
}

function isMostlyPorcelain(lines: string[]): boolean {
	if (lines.length < 3) return false;
	const hits = lines.filter((line) => PORCELAIN_RE.test(line)).length;
	return hits / lines.length >= 0.6;
}

function isLineNumbered(lines: string[]): boolean {
	const sample = lines.slice(0, 100).filter((line) => line.length > 0);
	if (sample.length < 5) return false;
	const hits = sample.filter((line) => READ_NUMBERED_RE.test(line)).length;
	return hits / sample.length >= 0.7;
}

function hasDuplicates(lines: string[]): boolean {
	const seen = new Set<string>();
	for (const line of lines) {
		if (seen.has(line)) return true;
		seen.add(line);
	}
	return false;
}

function isNoisyLsEntry(line: string): boolean {
	return / node_modules$| \.git$| dist$| build$| \.next$| \.turbo$| coverage$/.test(
		line,
	);
}
