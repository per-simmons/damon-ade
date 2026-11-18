#!/usr/bin/env bun
/**
 * Multi-model workflow tooling: configuration checks and M4 measurement.
 * Nothing here calls a model or spends tokens.
 *
 *   bun run workflow doctor [project...]         check a project's workflow + installed CLI
 *   bun run workflow label <task>/<arm> [--cwd d] tag new sessions in a folder
 *   bun run workflow label --clear [--cwd d]
 *   bun run workflow import [--cwd d]            record every transcript for a folder
 *   bun run workflow record <transcript.jsonl>   record one transcript
 *   bun run workflow result <task>/<arm> pass|fail [--note text]
 *   bun run workflow check <task>/<arm> [--cwd d] -- "<cmd>" ["<cmd>" ...]
 *   bun run workflow sessions                    list recorded sessions
 *   bun run workflow report [--update file]      print or update the M4 report
 *
 * Common: --home <ADE home> (default: $ADE_HOME_DIR, else ~/.ade-default if it
 * exists, else ~/.ade). Arms: A = current baseline, A2 = efficient single
 * model, B = multi-model workflow.
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	ensureProjectWorkflow,
	portablePath,
} from "../src/main/lib/agent-workflow/project-workflow";
import { listTasks } from "../src/main/lib/agent-workflow/tasks";
import {
	checkAgentsFile,
	checkClaudeCliSupport,
	modelMatches,
} from "../src/main/lib/agent-workflow/workflow-check";
import { loadWorkflowSettings } from "../src/main/lib/agent-workflow/workflow-settings";
import {
	costOf,
	dedupeAcrossSessions,
	summarizeArms,
	summarizeRuns,
} from "../src/main/lib/usage-metrics/aggregate";
import {
	renderM4Report,
	replaceReportSection,
} from "../src/main/lib/usage-metrics/report";
import {
	appendRunResult,
	isValidRunLabel,
	loadRunResults,
	loadSessions,
	recordSessionUsage,
} from "../src/main/lib/usage-metrics/store";
import {
	claudeProjectsRoot,
	encodeProjectDir,
} from "../src/main/lib/usage-metrics/transcript";

interface Args {
	positional: string[];
	flags: Map<string, string | true>;
	rest: string[];
}

function parseArgs(argv: string[]): Args {
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	const sep = argv.indexOf("--");
	const head = sep === -1 ? argv : argv.slice(0, sep);
	const rest = sep === -1 ? [] : argv.slice(sep + 1);
	for (let i = 0; i < head.length; i++) {
		const arg = head[i];
		if (arg.startsWith("--")) {
			const next = head[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags.set(arg.slice(2), next);
				i++;
			} else {
				flags.set(arg.slice(2), true);
			}
		} else {
			positional.push(arg);
		}
	}
	return { positional, flags, rest };
}

function fail(message: string): never {
	console.error(`error: ${message}`);
	process.exit(2);
}

function flag(args: Args, name: string): string | undefined {
	const value = args.flags.get(name);
	return typeof value === "string" ? value : undefined;
}

function resolveHome(args: Args): string {
	const explicit = flag(args, "home") ?? process.env.ADE_HOME_DIR;
	if (explicit) return resolve(explicit);
	const legacy = join(homedir(), ".ade-default");
	return existsSync(legacy) ? legacy : join(homedir(), ".ade");
}

function findClaudeBinary(args: Args): string | undefined {
	const explicit = flag(args, "claude-binary");
	if (explicit) return explicit;
	const launcher = Bun.which("claude");
	if (!launcher) return undefined;
	// npm installs a shell launcher next to node_modules/@anthropic-ai/claude-code.
	const packageDir = join(
		dirname(launcher),
		"node_modules",
		"@anthropic-ai",
		"claude-code",
	);
	for (const candidate of [
		join(packageDir, "bin", "claude.exe"),
		join(packageDir, "bin", "claude"),
		join(packageDir, "cli.js"),
	]) {
		if (existsSync(candidate)) return candidate;
	}
	return launcher;
}

function claudeVersion(): string | undefined {
	const result = spawnSync("claude", ["--version"], {
		encoding: "utf8",
		shell: process.platform === "win32",
		timeout: 20_000,
	});
	return result.status === 0 ? result.stdout.trim() : undefined;
}

function doctor(args: Args): void {
	const targets = args.positional.length ? args.positional : [process.cwd()];
	const home = resolveHome(args);
	const settings = loadWorkflowSettings(home);
	let problems = 0;

	const version = claudeVersion();
	console.log(`Claude Code: ${version ?? "not found on PATH"}`);
	const binary = findClaudeBinary(args);
	const support = binary ? checkClaudeCliSupport(binary) : undefined;
	if (support) {
		const mark = (ok: boolean) => (ok ? "yes" : "not confirmed");
		console.log(`  --agents flag: ${mark(support.supportsAgentsFlag)}`);
		console.log(`  effort field: ${mark(support.supportsEffortField)}`);
		console.log(`  maxTurns field: ${mark(support.supportsMaxTurnsField)}`);
		console.log(`  fable alias: ${mark(support.knowsFableAlias)}`);
	}

	for (const target of targets) {
		// Creates or refreshes the project's folder under the ADE home only;
		// the project itself is not touched.
		const project = ensureProjectWorkflow(home, resolve(target), settings);
		const check = checkAgentsFile(
			project.agentsFile,
			Object.fromEntries(
				Object.entries(settings.roles).map(([name, routing]) => [
					name,
					routing,
				]),
			),
			portablePath(project.tasksDir),
		);
		console.log(`
${project.root}`);
		console.log(`  workflow folder: ${project.dir}`);
		for (const problem of check.problems) console.log(`  !! ${problem}`);
		for (const role of check.roles) {
			console.log(
				`  ${role.name.padEnd(12)} ${role.model ?? "-"} / ${role.effort ?? "-"} / ${role.maxTurns ?? "-"} turns${role.problems.length ? `  !! ${role.problems.join("; ")}` : ""}`,
			);
		}
		console.log(`  tasks: ${listTasks(project).length}`);
		if (!check.ok) problems++;

		// Runtime confirmation: models actually used, from recorded transcripts.
		const observed = observedModelsByRole(
			loadSessions(join(home, "metrics")),
			project.key,
			project.root,
		);
		if (observed.size === 0) {
			console.log(
				"  models actually used: no recorded sessions in this project yet",
			);
			continue;
		}
		console.log("  models actually used (recorded sessions):");
		for (const [role, models] of observed) {
			const configured =
				settings.roles[role as keyof typeof settings.roles]?.model;
			const mismatched = configured
				? [...models].filter((model) => !modelMatches(configured, model))
				: [];
			if (mismatched.length) problems++;
			console.log(
				`    ${role.padEnd(12)} ${[...models].join(", ")}${mismatched.length ? `  !! configured ${configured}` : ""}`,
			);
		}
	}
	process.exit(problems ? 1 : 0);
}

/**
 * Models seen per role ("main" or subagent type) in a project's sessions:
 * those recorded with its key, or (sessions recorded before keys existed)
 * run in its root folder.
 */
export function observedModelsByRole(
	sessions: ReturnType<typeof loadSessions>,
	projectKey: string,
	root: string,
): Map<string, Set<string>> {
	const normalize = (path: string) =>
		resolve(path)
			.replace(/[\\/]+$/, "")
			.toLowerCase();
	const target = normalize(root);
	const byRole = new Map<string, Set<string>>();
	for (const session of sessions) {
		const inProject = session.projectKey
			? session.projectKey === projectKey
			: !!session.cwd && normalize(session.cwd) === target;
		if (!inProject) continue;
		for (const record of session.records) {
			const models = byRole.get(record.agentType) ?? new Set<string>();
			models.add(record.model);
			byRole.set(record.agentType, models);
		}
	}
	return byRole;
}

function label(args: Args): void {
	const cwd = resolve(flag(args, "cwd") ?? process.cwd());
	const path = join(cwd, ".ade", "run-label");
	if (args.flags.has("clear")) {
		rmSync(path, { force: true });
		console.log(`Cleared ${path}`);
		return;
	}
	const value = args.positional[0];
	if (!value || !isValidRunLabel(value)) {
		fail('label must look like "<task>/<arm>", e.g. T1/B');
	}
	mkdirSync(join(cwd, ".ade"), { recursive: true });
	writeFileSync(path, `${value}\n`, "utf8");
	console.log(
		`New Claude Code sessions in ${cwd} will be recorded as ${value}.`,
	);
}

function recordPaths(home: string, paths: string[]): void {
	const metricsDir = join(home, "metrics");
	let recorded = 0;
	for (const path of paths) {
		const metrics = recordSessionUsage({ transcriptPath: path, metricsDir });
		if (!metrics) continue;
		recorded++;
		const cost = costOf(metrics.records);
		console.log(
			`${metrics.sessionId}  ${metrics.label ?? "(no label)"}  ${metrics.records.length} responses  $${cost.usd.toFixed(4)}`,
		);
	}
	console.log(`Recorded ${recorded} session(s) into ${metricsDir}`);
}

function importFolder(args: Args): void {
	const cwd = resolve(flag(args, "cwd") ?? process.cwd());
	const dir = join(claudeProjectsRoot(), encodeProjectDir(cwd));
	if (!existsSync(dir))
		fail(`no Claude Code sessions found for ${cwd} (${dir})`);
	const paths = readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(dir, name));
	recordPaths(resolveHome(args), paths);
}

function result(args: Args): void {
	const [runLabel, outcome] = args.positional;
	if (!runLabel || !isValidRunLabel(runLabel))
		fail("first argument must be <task>/<arm>");
	if (outcome !== "pass" && outcome !== "fail")
		fail("outcome must be pass or fail");
	appendRunResult(join(resolveHome(args), "metrics"), {
		label: runLabel,
		outcome,
		at: new Date().toISOString(),
		source: "manual",
		details: flag(args, "note"),
	});
	console.log(`Recorded ${runLabel}: ${outcome}`);
}

/** Run the user's own acceptance-check commands through their shell. */
function check(args: Args): void {
	const runLabel = args.positional[0];
	if (!runLabel || !isValidRunLabel(runLabel))
		fail("first argument must be <task>/<arm>");
	if (args.rest.length === 0) fail('give the check commands after "--"');
	const cwd = resolve(flag(args, "cwd") ?? process.cwd());

	const outcomes: string[] = [];
	let passed = true;
	for (const command of args.rest) {
		console.log(`$ ${command}`);
		const run =
			process.platform === "win32" && !Bun.which("bash")
				? spawnSync("cmd.exe", ["/d", "/s", "/c", command], {
						cwd,
						stdio: "inherit",
					})
				: spawnSync(Bun.which("bash") ?? "sh", ["-c", command], {
						cwd,
						stdio: "inherit",
					});
		const code = run.status ?? 1;
		outcomes.push(`${command} -> exit ${code}`);
		if (code !== 0) passed = false;
	}
	appendRunResult(join(resolveHome(args), "metrics"), {
		label: runLabel,
		outcome: passed ? "pass" : "fail",
		at: new Date().toISOString(),
		source: "check",
		details: outcomes.join("; ").slice(0, 2000),
	});
	console.log(`Recorded ${runLabel}: ${passed ? "pass" : "fail"}`);
	process.exit(passed ? 0 : 1);
}

function sessions(args: Args): void {
	const all = loadSessions(join(resolveHome(args), "metrics"));
	const owned = dedupeAcrossSessions(all);
	for (const session of all.sort((a, b) =>
		(a.firstAt ?? "").localeCompare(b.firstAt ?? ""),
	)) {
		const cost = costOf(owned.get(session.sessionId) ?? []);
		console.log(
			`${session.firstAt?.slice(0, 16) ?? "?"}  ${session.sessionId}  ${(session.label ?? "-").padEnd(8)}  $${cost.usd.toFixed(4)}  ${Object.keys(cost.byModel).join(", ")}`,
		);
	}
}

function report(args: Args): void {
	const metricsDir = join(resolveHome(args), "metrics");
	const all = loadSessions(metricsDir);
	const runs = summarizeRuns(all, loadRunResults(metricsDir));
	const owned = dedupeAcrossSessions(all);
	const unlabeled = all.filter((session) => !session.label);
	const markdown = renderM4Report({
		runs,
		arms: summarizeArms(runs),
		unlabeledSessions: unlabeled.length,
		unlabeledUsd: unlabeled.reduce(
			(sum, session) => sum + costOf(owned.get(session.sessionId) ?? []).usd,
			0,
		),
		generatedAt: new Date(),
	});

	const target = flag(args, "update");
	if (!target) {
		process.stdout.write(markdown);
		return;
	}
	const path = resolve(target);
	writeFileSync(
		path,
		replaceReportSection(readFileSync(path, "utf8"), markdown),
		"utf8",
	);
	console.log(`Updated ${path}`);
}

const COMMANDS: Record<string, (args: Args) => void> = {
	doctor,
	label,
	import: importFolder,
	record: (args) =>
		recordPaths(
			resolveHome(args),
			args.positional.map((p) => resolve(p)),
		),
	result,
	check,
	sessions,
	report,
};

if (import.meta.main) {
	const [command, ...rest] = process.argv.slice(2);
	const handler = command ? COMMANDS[command] : undefined;
	if (!handler) {
		console.log(readFileSync(import.meta.path, "utf8").split("*/")[0]);
		process.exit(command ? 2 : 0);
	}
	handler(parseArgs(rest));
}
