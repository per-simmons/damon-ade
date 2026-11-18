# Plan: multi-model coding workflow for ADE agents

Status: **M1 and M2 done (2026-11-17); M3 next**
Created: 2026-11-17
Scope: `apps/desktop` agent scaffolding and agent invocation. No new orchestrator, no DB migration.

## 1. Goal

Use the expensive reasoning model only for planning and for unblocking hard problems. Do routine implementation, small edits and review on cheaper models. Keep task state in files so a new session resumes without rebuilding context.

Success is measured as **cost (or usage) per successfully completed task**, not cost per token. See section 9.

## 2. Decisions

| # | Decision | Status | Default used by this plan |
|---|---|---|---|
| A1 | Architecture: extend ADE's agent scaffold with native Claude Code subagents + task files. No custom orchestrator. | Approved 2026-11-17 | — |
| D1 | Billing: API key or Claude subscription? | Default accepted 2026-11-17 | Unknown. Record both tokens per model and list-price estimates; do not claim dollar savings for subscription users. |
| D2 | Main session model | Default accepted 2026-11-17 | `sonnet` coordinator. Fable runs only inside the `planner` and `architect` subagents. |
| D3 | Task files location | Default accepted 2026-11-17 | `<worktree>/.ade/tasks/<slug>/`, git-excluded. |
| D4 | Scope | Default accepted 2026-11-17 | Existing agents are updated by a launch-time sync. Codex and the in-app chat panel (mastracode) are unchanged. |

Changing a default later only touches the template constants in M1 and the sync in M2.

## 3. What exists (reused, not replaced)

- **Agent scaffold** — `apps/desktop/src/main/lib/agent-scaffold.ts`
  - `scaffoldAgentMemory()` writes `memory/`, `skills/`, `CLAUDE.md` (`CLAUDE_BRIDGE`), `.claude/settings.json` (Stop reflection hook + auto-memory) and `.claude/reflect-on-stop.mjs`.
  - `writeIfEmpty()` never overwrites a non-empty file.
  - `BRIDGE_EXCLUDES` adds generated files to `.git/info/exclude`.
- **Backfill at launch** — `agent-memory-backfill.ts`, called from `apps/desktop/src/main/index.ts:314`. It skips agents whose memory is non-empty, so it cannot deliver new files to existing agents.
- **Claude launch** — `AGENT_PRESET_COMMANDS.claude` is `claude --dangerously-skip-permissions` with no `--model`.
- **Autonomous invoke**
  - `POST /agent/invoke` in `main/lib/notifications/server.ts`.
  - The renderer builds `claude [--session-id|--resume|--continue] --dangerously-skip-permissions '<prompt>'` in `renderer/stores/tabs/useAgentHookListener.tsx`.
  - `~/agents/registry.json` has a `model` field (`main/lib/agent-config/registry.ts`) that is never used.
- **Claude Code native features** (verified against code.claude.com docs on 2026-11-17)
  - `.claude/agents/*.md` frontmatter: `model` (aliases `fable`/`opus`/`sonnet`/`haiku`/`inherit` or full ID), `effort`, `maxTurns`, `tools`, `disallowedTools`.
  - Project `.claude/settings.json` `model` key sets the main session model. `--model`, `ANTHROPIC_MODEL` and `/model` take precedence.
  - Automatic prompt caching, **per model**. A model switch re-reads history uncached.
  - `/usage` shows per-model tokens and estimated cost. OpenTelemetry metrics `claude_code.cost.usage` / `claude_code.token.usage` carry `model` and `query_source`/`agent.name`.
  - `--max-budget-usd` and `--max-turns` work only with `-p` (not ADE's interactive terminals). Subagent `maxTurns` works interactively.

## 4. Models and prices

Source: Anthropic model table cached 2026-11-03. Re-check https://platform.claude.com/docs/en/about-claude/pricing before quoting.

| Role | Alias | Model ID | Input / output per 1M tokens |
|---|---|---|---|
| Planner, architect | `fable` | `claude-fable-5-2` | $8 / $40 |
| (baseline only) | `opus` | `claude-opus-5-5` | $4 / $20 |
| Coordinator, implementer, reviewer | `sonnet` | `claude-sonnet-5-5` | $2 / $10 |
| Quick edits | `haiku` | `claude-haiku-5-5` | $0.10 / $0.50 (prompts ≤100K) |

Aliases resolve as above on the Anthropic API. On Bedrock or Vertex, `sonnet`/`haiku` resolve to 4.5 models, so templates use aliases and the alias-override env vars (`ANTHROPIC_DEFAULT_*_MODEL`) remain the override path.

## 5. Design

### 5.1 Roles (generated into `<worktree>/.claude/agents/`)

| File | model | effort | maxTurns | Tools | Job |
|---|---|---|---|---|---|
| `planner.md` | `fable` | `high` | 30 | Read, Grep, Glob, Bash (read-only use), Write | Read the task + only relevant code. Write `plan.md` and an initial `progress.md`. Return a ≤10-line summary. |
| `architect.md` | `fable` | `high` | 20 | Read, Grep, Glob, Bash, Write | Resolve one escalation report. Update the plan's decisions if needed. Write the resolution into the report file. |
| `implementer.md` | `sonnet` | `medium` | 40 | all | Implement the next unchecked step(s) of `plan.md`. Update `progress.md`. Follow the escalation rule. |
| `quick.md` | `haiku` | `low` | 15 | all | One bounded change fully specified in the request (rename, boilerplate, formatting, small fix). Escalates to `implementer` if the change is not bounded. |
| `reviewer.md` | `sonnet` | `medium` | 25 | Read, Grep, Glob, Bash (no Edit/Write) | Check the diff against the acceptance criteria written at planning time. Run typecheck, lint and the relevant tests. Report pass/fail per criterion. |

The main session (D2 default) runs on `sonnet`. It is set via `"model": "sonnet"` in the project `.claude/settings.json`, so `/model` or `--model` still override it.

### 5.2 Commands (generated into `<worktree>/.claude/commands/`)

- `/plan <task>` — delegate to `planner`; create `.ade/tasks/<slug>/`.
- `/build [slug]` — resume from `progress.md`; delegate steps to `implementer` or `quick`.
- `/review [slug]` — delegate to `reviewer`. Mark the task done only on reviewer pass.
- `/escalate [slug]` — delegate the newest open escalation report to `architect`, then resume `/build`.

### 5.3 Task state: `.ade/tasks/<slug>/`

- `plan.md` — context, decisions (with reasons), files to change, ordered steps, edge cases, **acceptance criteria**, validation commands. Written once by the planner; changed only by the architect.
- `progress.md` — step checklist, current step, attempts per step, escalation count, last check results, next action. Updated after every step.
- `escalations/NNN.md` — one compact report per escalation (5.4), with the architect's resolution appended.

Files are plain markdown, so Codex sessions can read them too. Durable, project-wide rules stay in CLAUDE.md and memory. Task details never go there.

### 5.4 Escalation rule (in `implementer.md` and `quick.md`)

Escalate (stop, write a report, return) when any of these holds:
1. Two failed attempts at the same step (a check still fails after two fixes).
2. The same error recurs after a change meant to fix it.
3. The plan's decisions conflict with what the code requires.
4. The step needs a design choice the plan does not make.

Report contents (target ≤150 lines):
- step and goal
- exact error output (trimmed)
- the smallest relevant code excerpts
- each attempt and why it failed
- the plan decisions involved

Never the full conversation.

### 5.5 Loop and spend guards

- `maxTurns` on every subagent (table 5.1).
- `progress.md` attempt counters. Max **2 escalations per step**; after that, the coordinator stops and asks the user.
- The reviewer may fail a task at most twice before the coordinator asks the user.
- The existing Stop reflection hook is unchanged (it already guards against looping).
- A hard dollar cap is not available interactively. It is deferred to M5 for headless `/agent/invoke` runs only.

## 6. Milestones

Each milestone ends with typecheck, Biome and the touched tests passing.

### M0 — Baseline (manual, before code)

Pick 5–10 real tasks of mixed size. Run them the current way (no subagents, user's default model). Record:
- `/usage` per-model tokens and estimate
- wall time
- whether checks passed
- number of user corrections

Store results in `docs/plans/multi-model-workflow/measurements.md`. Optional second baseline: Opus 5.5 at `medium` effort for all work.

### M1 — Generate workflow files for new agents (done 2026-11-17)

- New module `apps/desktop/src/main/lib/agent-workflow/`:
  - `agent-workflow.ts` — template constants for the 5 agents and 4 commands, plus `writeAgentWorkflowFiles(worktreePath)`. Uses write-if-empty.
  - `index.ts`
  - `agent-workflow.test.ts`
- `agent-scaffold.ts`:
  - call `writeAgentWorkflowFiles()`
  - add `".ade/"` to `BRIDGE_EXCLUDES`
  - add `"model": "sonnet"` to the generated settings
  - append a 3-line workflow pointer to `CLAUDE_BRIDGE`
- Tests:
  - files exist
  - frontmatter has the expected `model`/`effort`/`maxTurns`
  - reruns do not overwrite edited files
  - `.ade/` is git-excluded

**Acceptance:** a newly created agent's worktree contains all files; Claude Code lists the 5 agents (`/agents`); an edited agent file survives a rescaffold.

**Result:**
- Built as planned.
- Frontmatter `description` and `argument-hint` are written as JSON strings, which are valid YAML: descriptions contain ": " and `[slug]` would otherwise parse as a list.
- Desktop typecheck passes. Biome is clean.
- `agent-workflow.test.ts`: 17/17 pass. `agent-scaffold.test.ts`: all new tests pass. The one failure is the pre-existing Windows path test.
- Not yet checked in a live Claude Code session (`/agents`).
- The installed CLI is 2.1.193. Docs checked describe the current release, so `effort` and the `fable` alias need confirming on that version, or an update first.

### M2 — Deliver to existing agents (done 2026-11-17)

- Also append `WORKFLOW_BRIDGE_POINTER` to an existing `CLAUDE.md` if it is missing.
- `syncAgentWorkflowFiles()` runs at launch next to `backfillAgentMemory()` in `main/index.ts`:
  - for every agent with a runtime and an existing worktree, write missing workflow files
  - merge `"model"` into `.claude/settings.json` only if the key is absent
  - append the `.ade/` exclude only if missing
- Per-agent try/catch, as in the backfill.

**Acceptance:** an agent created before M1 gets the files on the next launch; nothing user-edited changes; a second launch makes no changes.

**Result:**
- `upgradeAgentWorkflow(worktreePath)` in `agent-workflow.ts` does the per-worktree upgrade.
- `syncAgentWorkflowFiles()` in `agent-workflow-sync.ts` runs it for every agent at launch, right after `backfillAgentMemory()`. It is kept out of the module index so the scaffold does not import the database.
- "Nothing user-edited changes" is implemented as **additive only**. Existing text is never rewritten or removed; ADE may add:
  - missing workflow files
  - a `model` key when none is set
  - the CLAUDE.md pointer once, detected by its marker
  - an `.ade/` exclude line when none exists
- Left alone:
  - a user's own `model` choice
  - invalid settings JSON
  - a missing CLAUDE.md or settings.json (the memory backfill creates those)
  - a `.git` that is a file rather than a folder (linked git worktree)
- Gated by `ADE_MEMORY_SCAFFOLD`, like the scaffold itself.
- Tests: 12 new (8 upgrade, 4 sync), all passing.
  - Run together with `agent-scaffold.test.ts`: 63 pass, 1 fail (the pre-existing Windows path test).
  - Desktop typecheck and Biome pass.
- Not yet checked against a real existing agent in the running app.

### M3 — Honor the registry model on `/agent/invoke`

- Pass `entry.model` through `AgentInvokeEvent`.
- Add `--model <value>` to the command built in `useAgentHookListener.tsx` when present. Validate it against `^[A-Za-z0-9._\[\]-]+$` before putting it in the shell command.
- Tests for command building (extract it into a small pure helper so it can be tested).

**Acceptance:** an invoke for an agent with `model: "fable"` launches `claude --model fable ...`; without it the command is unchanged.

### M4 — Measure and tune

- Re-run the M0 tasks with `/plan` → `/build` → `/review`. Record the same metrics.
- Compare cost/usage per completed task.
- Tune `effort`/`maxTurns` only where the data shows a problem.

Report measured numbers separately from estimates.

### M5 — Optional, only if M4 justifies it

- Opt-in OpenTelemetry capture: set `CLAUDE_CODE_ENABLE_TELEMETRY` and an OTLP endpoint on ADE's local notifications server in `buildTerminalEnv` to store per-model cost per agent/task.
- Headless budgeted runs (`claude -p --max-budget-usd`) for unattended invokes.
- A settings screen mapping role → model.

## 7. User overrides

- In session: `/model`, or name a model when asking for a subagent.
- Per agent: edit `.claude/agents/*.md` or `.claude/settings.json` (never overwritten by ADE).
- Machine-wide: `ANTHROPIC_DEFAULT_FABLE_MODEL` / `_SONNET_` / `_HAIKU_` change what each alias means.

## 8. Expected benefit (estimate, not measured)

- Sonnet 5.5 is 1/4 of Fable 5.2 per token. Haiku 5.5 input is 1/80.
- If 70–85% of a task's tokens are implementation and review, moving them from Fable to Sonnet puts a task at roughly 35–50% of an all-Fable run.
- Against an Opus 5.5 default the saving is smaller (Sonnet is 1/2 of Opus).
- Offsets:
  - subagents re-read context in their own cache
  - handoff overhead
  - retries
  - escalations

M4 replaces these estimates with measurements.

## 9. Validation

- Automated: `bun run typecheck` (desktop), Biome on changed files, `bun test` for agent-workflow, agent-scaffold, backfill/sync and the invoke command helper.
- Pre-existing, unrelated failures on Windows (path separators, "Superset" vs "ADE" wording): 5 tests in agent-scaffold, agent-wrappers, shell-wrappers and env. Do not count them as regressions; do not mask them.
- Manual: create an agent, run `/agents`, run one small task through `/plan` → `/build` → `/review`, confirm `.ade/tasks/<slug>/` contents and `/usage` per-model split.

## 10. Risks

- **The model may not follow the workflow.** Mitigation: commands make each stage explicit; `maxTurns` bounds damage; the reviewer is a separate agent.
- **Per-model caches.** Too many small handoffs can cost more than they save. Mitigation: implementer handles several steps per call; M4 measures.
- **Haiku 5.5 price rises above 100K-token prompts.** Mitigation: `quick` gets only bounded tasks with small context.
- **Alias drift on non-Anthropic providers** (see section 4).
- **Subscription users** see usage-limit headroom, not dollars (D1).

## 11. Out of scope

- Codex role routing (Codex can still read `.ade/tasks/`).
- mastracode / in-app chat model routing and its outdated model list (`packages/trpc/src/router/chat/chat.ts`).
- Cloud task table changes.
- Any DB migration.
