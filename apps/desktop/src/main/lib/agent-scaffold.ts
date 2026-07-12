import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentRuntime } from "@superset/local-db";
import {
	getAgentCodexHome,
	getAgentHome,
	getAgentMemoryDir,
	getAgentWorktreePath,
} from "./agent-home";
import { seedBundledAgentSkills } from "./bundled-agent-skills";

/**
 * Memory scaffold written on agent creation (ADE Phase E, docs/memory.md).
 * Writes the canonical memory/*.md files, the write-back protocol,
 * a skills seed, and the per-runtime bridge files that point each CLI at the
 * canonical memory. Electron-free so it composes with setupAgentRepo and is
 * unit-verifiable. Templates are kept short — they are context on every turn.
 *
 * Faithful to the Hermes agent (github.com/NousResearch/hermes-agent): the
 * self-curation guidance in .writeback-protocol.md is ported from Hermes'
 * `memory` tool description (tools/memory_tool.py MEMORY_SCHEMA), AGENT.md
 * mirrors the short SOUL.md identity, the SKILL.md template follows Hermes'
 * skill-authoring standards (agent/learn_prompt.py), and the session-end
 * reflection is an ADE adaptation of Hermes' post-turn background review
 * (agent/background_review.py). See the spec for the full mapping.
 */

export interface ScaffoldParams {
	agentId: string;
	agentName: string;
	runtime: AgentRuntime;
	/** Human name for USER.md; falls back to "the user". */
	userName?: string;
	/**
	 * Optional role/purpose that seeds AGENT.md's persona section. Blank (the
	 * default flow) leaves an invitation for the agent to define its focus
	 * through conversation. A parallel agent-role-ui surface passes this from
	 * the New Agent modal.
	 */
	role?: string;
	/**
	 * Absolute worktree path the per-runtime bridge files (CLAUDE.md,
	 * .claude/, opencode.json, .git/info/exclude) are written into. Defaults to
	 * the derived <agent-home>/worktree. The local-path creation flow stores an
	 * EXTERNAL repo path on the workspace's worktrees row — for those agents the
	 * caller must pass that path so bridges land in the real repo, not a
	 * derived dir that doesn't exist. Memory/skills always stay under
	 * <agent-home> regardless. Callers should ensure the path exists and is a
	 * git repo before passing it.
	 */
	worktreePath?: string;
}

function sub(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

/**
 * Write `content` only if the target is missing or empty. Makes the scaffold
 * idempotent so the launch-time backfill (agent-memory-backfill.ts) can re-run
 * over an existing agent without ever clobbering a canonical file or bridge the
 * user (or the agent) has already filled in. On a fresh agent every file is
 * absent, so this behaves exactly like a plain write.
 */
function writeIfEmpty(path: string, content: string): void {
	if (existsSync(path) && readFileSync(path, "utf8").trim().length > 0) return;
	writeFileSync(path, content, "utf8");
}

// AGENT.md is the ADE analog of Hermes' SOUL.md: a short identity that leads the
// context (who you are + voice), followed by an operating brief. Hermes keeps
// SOUL.md to a single prose paragraph — we keep AGENT.md deliberately short too.
// {{role_section}} is built in code from the optional `role` param.
const AGENT_MD = `# {{agent_name}}

You are {{agent_name}}, an autonomous coding agent working in a dedicated git
worktree. You are direct, precise, and prize being genuinely useful over being
verbose. You admit uncertainty, prefer small verifiable changes, and you keep
your own persistent memory (MEMORY.md, USER.md) current as you learn — read it,
trust it, and maintain it per the write-back protocol.

## Role
{{role_section}}

## Operating brief
- Work only within your worktree: {{agent_home}}/worktree
- Prefer small, verifiable changes. Run the project's checks before declaring done.
- When you learn something durable about {{user_name}} or the project, save it to
  memory per the write-back protocol.
- Reusable procedures become skills under {{agent_home}}/skills/, not memory notes.

## Standing preferences
- (none yet — {{user_name}} will add these, or you will learn them)
`;

const USER_MD = `# User profile

- Name: {{user_name}}
- (The agent maintains this file. Add stable facts about the user: role,
  timezone, tech preferences, communication style, hard "always/never" rules.)

## Preferences
- (learned over time)

## Do not
- (pet peeves / things to avoid)
`;

const MEMORY_MD = `# Memory — {{agent_name}}

<!-- Maintain this file per the write-back protocol. One fact per bullet.
     Keep inline notes under ~2,200 chars; offload detail to memory/<topic>.md
     and leave a one-line pointer here. -->

## Environment
- Agent home: {{agent_home}}
- Runtime: {{runtime}}
- Created: {{created_date}}

## Project
- (conventions, build/test commands, architecture notes — learned over time)

## Lessons
- (tool quirks, workarounds, corrections that shouldn't repeat)

## Detail files
- (e.g. \`- debugging → memory/debugging.md\`)
`;

// Ported from Hermes' `memory` tool description (tools/memory_tool.py
// MEMORY_SCHEMA — the "WHEN / TARGETS / SKIP / IF FULL" self-curation guidance)
// and its background-review prompts (agent/background_review.py), adapted to
// file-edit semantics: ADE has no custom memory tool, so the agent edits these
// files with its normal Edit/Write tools. The reflection section is the ADE
// analog of Hermes' post-turn learning loop.
const WRITEBACK_PROTOCOL = `## Your persistent memory — how to maintain it

You have three memory files, loaded into your context at the start of every
session. Memory is injected into every future turn, so keep entries compact and
high-signal — everything here costs tokens forever. The best memory stops
{{user_name}} from having to repeat themselves.

- {{agent_home}}/memory/USER.md   — who the human is: name, role, preferences,
  communication style, hard "always/never" rules. Target < 1,375 chars.
- {{agent_home}}/memory/MEMORY.md — your own notes: environment facts, project
  conventions, tool quirks, lessons learned, and a short index of any
  memory/<topic>.md detail files. Target < 2,200 chars for the inline notes.
- {{agent_home}}/memory/AGENT.md  — your persona and standing brief. You rarely
  change this; the human owns it.

WHEN to save (edit the file with your normal file tools, proactively — don't
wait to be asked):
- the user states a preference, correction, or personal detail  → USER.md
- you learn a stable fact about their environment, stack, conventions, or
  workflow  → MEMORY.md
- a correction would otherwise be repeated next session
Priority when space is tight: user preferences & corrections > environment
facts > procedures.

SKIP: trivial or obvious info, easily re-discovered facts, raw data/log dumps,
task progress, completed-work logs, temporary TODO or debugging state, one-off
paths. Reusable step-by-step procedures belong in a skill (see below), not a
memory entry.

FORMAT: one fact per bullet, present tense, no dates unless load-bearing.
Convert relative dates to absolute. If MEMORY.md's inline notes grow past the
target, move the least-critical section into memory/<topic>.md and leave a
one-line pointer in MEMORY.md.

WHEN FULL: don't just append. Consolidate — merge overlapping bullets, drop the
stalest, then add, all in one edit. A write that only ever grows becomes a
bloated memory that gets ignored; that is the failure mode. Editing is cheap.

Never write secrets, tokens, or anything you wouldn't want replayed into a
future prompt.

## Skills — reusable know-how

A skill is a folder under {{agent_home}}/skills/<name>/ with a SKILL.md
(agentskills.io format). Only its name + one-line description sit in context;
the body loads on demand. Create a skill for any reusable, multi-step procedure
or a class-of-task lesson — NOT for one-off facts (those go in MEMORY.md). When
the user corrects your style, format, or workflow for a kind of task, embed that
correction in the skill that governs that task, so the next session starts
already knowing.

## Session-end reflection

Before you finish a session (or when a substantial piece of work concludes),
review the conversation and update your memory and skills so the next session
starts smarter. Be active: a review that changes nothing is usually a missed
learning opportunity, not a neutral outcome.

1. Memory — did the user reveal a preference, correction, personal detail, or
   expectation about how you should work (→ USER.md), or did you learn a stable
   fact about their environment/stack/conventions (→ MEMORY.md)? Save it, per
   the WHEN/SKIP rules above.
2. Skills — if the user corrected your style, tone, format, or workflow, embed
   the lesson in the skill that governs this class of task (create one if none
   exists). If a non-trivial technique, fix, or debugging path emerged, capture
   it. A preference correction belongs in a skill, not only in memory.

Do NOT capture as durable memory or skills (these harden into false constraints
that bite you later when the environment changes):
- environment-dependent failures: missing binaries, "command not found",
  unconfigured credentials, uninstalled packages — the user can fix these.
- negative claims about tools ("X is broken", "can't use Y") — capture the FIX
  instead, under a troubleshooting note.
- transient errors that resolved on retry — the lesson is the retry, not the
  failure.
- one-off task narratives.

If the session produced no durable fact and no correction, that's fine — make no
changes and finish.
`;

const SKILLS_README = `# Skills for {{agent_name}}

Each skill is a folder with a SKILL.md (agentskills.io format). Only the
name + description sit in context; the body loads on demand. Create a skill
for any reusable, multi-step procedure or class-of-task lesson — not for
one-off facts (those go in MEMORY.md). See SKILL.template.md for the frontmatter
and section order to follow.
`;

// SKILL authoring template — mirrors Hermes' skill-authoring standards
// (agent/learn_prompt.py _AUTHORING_STANDARDS) and the shipped SKILL.md files:
// description <=60 chars, version, optional platforms, metadata.<ns>.tags, and
// the canonical body section order. agentskills.io-compatible.
const SKILL_TEMPLATE = `---
name: my-skill
description: One line, <= 60 chars, what this does.
version: 0.1.0
platforms: [macos, linux]
metadata:
  ade:
    tags: [Example]
---

# Skill Title

Two or three sentences: what it does, what it does NOT do, and the key
dependency stance.

## When to Use
- Concrete trigger phrases / conditions.

## Prerequisites
- Exact env vars, install steps, credentials (omit if none).

## Procedure
1. Step one — copy-paste-exact commands.
2. Step two.

## Pitfalls
- Known limits and things that look broken but aren't.

## Verification
A single command or check that proves the skill worked.
`;

const CLAUDE_BRIDGE = `@{{agent_md_path}}
@{{user_md_path}}
<!-- MEMORY.md is loaded via Claude Code native auto-memory (autoMemoryDirectory). -->
`;

// Claude Code Stop-hook script: the native analog of Hermes' post-turn
// background review (agent/background_review.py). When the agent tries to stop,
// this forces ONE review turn (decision:block feeds `reason` back to the model);
// the stop_hook_active guard means the review turn itself stops cleanly instead
// of looping. Runs under `node` (always present in a Claude Code host); reads
// the hook JSON from stdin (fd 0). Lives in .claude/ (git-excluded) so it never
// enters the repo. See docs/memory.md.
function reflectHookScript(agentHome: string, userName: string): string {
	const reason =
		`[session reflection] Before you finish, review this conversation and update ` +
		`your persistent memory and skills so the next session starts smarter, per the ` +
		`Session-end reflection section of your write-back protocol ` +
		`(${agentHome}/memory/.writeback-protocol.md). Save durable preferences/facts ` +
		`about ${userName} to USER.md, stable environment/convention facts to MEMORY.md, ` +
		`and embed any style/format/workflow correction in the skill that governs that ` +
		`class of task under ${agentHome}/skills/. Do NOT capture environment-dependent ` +
		`failures, negative tool claims, transient errors, or one-off narratives. Make ` +
		`the edits with your file tools, then finish. If nothing durable came up, make no ` +
		`changes and stop.`;
	return `#!/usr/bin/env node
// ADE session-reflection hook (Claude Code Stop hook). Native analog of the
// Hermes post-turn review loop. Generated by agent-scaffold.ts; do not edit —
// it is regenerated on scaffold. See docs/memory.md.
import { readFileSync } from "node:fs";
let raw = "";
try { raw = readFileSync(0, "utf8"); } catch {}
let data = {};
try { data = JSON.parse(raw || "{}"); } catch {}
// Already inside the reflection turn we injected — let it stop (no loop).
if (data && data.stop_hook_active) process.exit(0);
const reason = ${JSON.stringify(reason)};
process.stdout.write(JSON.stringify({ decision: "block", reason }));
process.exit(0);
`;
}

/** Bridge files written into the worktree (git-excluded, never committed). */
const BRIDGE_EXCLUDES = ["CLAUDE.md", ".claude/", "opencode.json", "AGENTS.md"];

/**
 * Regenerate <agent-home>/.codex/AGENTS.md from the canonical memory files.
 * Codex cannot @import, so its bridge is the concatenation, rebuilt on each
 * launch (and once at creation). Call this before launching a codex agent.
 */
export function regenerateCodexAgentsMd(agentId: string): void {
	const memoryDir = getAgentMemoryDir(agentId);
	const codexHome = getAgentCodexHome(agentId);
	mkdirSync(codexHome, { recursive: true });

	const parts: string[] = [];
	for (const file of [
		"AGENT.md",
		"USER.md",
		"MEMORY.md",
		".writeback-protocol.md",
	]) {
		const p = join(memoryDir, file);
		if (existsSync(p)) {
			parts.push(readFileSync(p, "utf8"));
		}
	}
	// No canonical memory (e.g. an agent created before the scaffold was
	// enabled): leave any existing bridge untouched rather than clobbering it
	// with an empty file. Codex then falls back to no global AGENTS.md.
	if (parts.length === 0) return;
	writeFileSync(join(codexHome, "AGENTS.md"), parts.join("\n\n"), "utf8");
}

/**
 * Build AGENT.md's "## Role" body from the optional role/purpose string.
 * Provided → the role text verbatim (as a bullet). Blank (default flow) → an
 * invitation for the agent to define its focus through conversation, which
 * matches the user's default of building the persona in-session.
 */
function roleSection(role: string | undefined, userName: string): string {
	const trimmed = role?.trim();
	if (trimmed) return `- ${trimmed}`;
	return (
		`- Not set yet. You and ${userName} will define your focus through\n` +
		`  conversation; once it's clear, write a one-line purpose here and refine\n` +
		`  it over time.`
	);
}

export function scaffoldAgentMemory({
	agentId,
	agentName,
	runtime,
	userName,
	role,
	worktreePath: worktreePathOverride,
}: ScaffoldParams): void {
	const agentHome = getAgentHome(agentId);
	const memoryDir = getAgentMemoryDir(agentId);
	// Bridges go into the agent's real worktree — which is the external repo path
	// for local-path agents, and the derived <agent-home>/worktree otherwise.
	// Memory/skills stay under <agent-home> either way.
	const worktreePath =
		worktreePathOverride?.trim() || getAgentWorktreePath(agentId);
	const skillsDir = join(agentHome, "skills");
	const resolvedUserName = userName?.trim() || "the user";

	const vars: Record<string, string> = {
		agent_name: agentName,
		agent_id: agentId,
		agent_home: agentHome,
		agent_md_path: join(memoryDir, "AGENT.md"),
		user_name: resolvedUserName,
		user_md_path: join(memoryDir, "USER.md"),
		role_section: roleSection(role, resolvedUserName),
		runtime,
		created_date: new Date().toISOString().slice(0, 10),
	};

	mkdirSync(memoryDir, { recursive: true });
	mkdirSync(skillsDir, { recursive: true });

	// Canonical memory files (source of truth, never committed). Idempotent:
	// a non-empty file the agent/user has already written is preserved.
	writeIfEmpty(join(memoryDir, "AGENT.md"), sub(AGENT_MD, vars));
	writeIfEmpty(join(memoryDir, "USER.md"), sub(USER_MD, vars));
	writeIfEmpty(join(memoryDir, "MEMORY.md"), sub(MEMORY_MD, vars));
	writeIfEmpty(
		join(memoryDir, ".writeback-protocol.md"),
		sub(WRITEBACK_PROTOCOL, vars),
	);
	writeIfEmpty(join(skillsDir, "README.md"), sub(SKILLS_README, vars));
	writeIfEmpty(join(skillsDir, "SKILL.template.md"), sub(SKILL_TEMPLATE, vars));
	seedBundledAgentSkills(skillsDir);

	// Per-runtime bridge files in the worktree (point each CLI at canonical
	// memory). Idempotent so we never clobber a bridge the user customized.
	writeIfEmpty(join(worktreePath, "CLAUDE.md"), sub(CLAUDE_BRIDGE, vars));
	const claudeDir = join(worktreePath, ".claude");
	mkdirSync(claudeDir, { recursive: true });
	// Session-reflection hook script + settings that wire it as a Stop hook and
	// point native auto-memory at the canonical dir. Both are Claude-Code-only
	// surfaces; harmless to the other runtimes.
	const reflectHookPath = join(claudeDir, "reflect-on-stop.mjs");
	writeIfEmpty(reflectHookPath, reflectHookScript(agentHome, resolvedUserName));
	writeIfEmpty(
		join(claudeDir, "settings.json"),
		`${JSON.stringify(
			{
				autoMemoryDirectory: join(memoryDir),
				autoMemoryEnabled: true,
				hooks: {
					Stop: [
						{
							matcher: "*",
							hooks: [
								{
									type: "command",
									command: `node ${JSON.stringify(reflectHookPath)}`,
									timeout: 120,
								},
							],
						},
					],
				},
			},
			null,
			2,
		)}\n`,
	);
	writeIfEmpty(
		join(worktreePath, "opencode.json"),
		`${JSON.stringify(
			{
				$schema: "https://opencode.ai/config.json",
				instructions: [
					"../memory/AGENT.md",
					"../memory/USER.md",
					"../memory/MEMORY.md",
					"../memory/.writeback-protocol.md",
				],
			},
			null,
			2,
		)}\n`,
	);

	// Keep the generated bridge files out of the repo (local, per-worktree).
	// Guard against a duplicate block when re-run by the backfill.
	const excludePath = join(worktreePath, ".git", "info", "exclude");
	const excludeMarker = "# ADE agent bridge files (generated, not committed)";
	if (existsSync(join(worktreePath, ".git"))) {
		mkdirSync(join(worktreePath, ".git", "info"), { recursive: true });
		const existingExclude = existsSync(excludePath)
			? readFileSync(excludePath, "utf8")
			: "";
		if (!existingExclude.includes(excludeMarker)) {
			appendFileSync(
				excludePath,
				`\n${excludeMarker}\n${BRIDGE_EXCLUDES.join("\n")}\n`,
				"utf8",
			);
		}
	}

	// Codex needs the concatenated bridge (it can't import). Generate it now;
	// it is regenerated on each codex launch.
	if (runtime === "codex") {
		regenerateCodexAgentsMd(agentId);
	}
}
