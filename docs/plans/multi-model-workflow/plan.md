# Plan: multi-model coding workflow in ADE

Status: **Usable release (2026-11-18). ADE owns the stages: Auto mode takes one request to a verified finish, and Manual mode runs single steps (section A). Release checklist and one authorized real smoke task: section A, "Release verification".**
Created: 2026-11-17
Scope: `apps/desktop`. No new framework or dependency, no DB migration.

## A. v3: app-owned Auto mode (2026-11-18)

An independent review of v2 found that "Auto" was terminal launches plus model-side instructions: nothing in the app tracked outcomes, enforced limits, ran checks or required a review. v3 moves orchestration into ADE. Section 0 (v2) still describes the per-project state and terminal integration, which v3 keeps.

### How a task runs

- **TaskController** (`agent-workflow/controller.ts`), one per app (`service.ts`):
  - A pure function, `decideNext`, picks every next step from recorded facts: runs and their outcomes, the files the agents wrote, the approved checks and the limits. No model call routes or advances anything.
  - Auto mode advances after every run. It stops only when:
    - the plan asks the user something
    - a failure may not be retried (auth, turn limit, launch, exhausted fallback)
    - a limit or the budget is reached
    - the user pauses or cancels
  - A rate limit or an overloaded API pauses the task; the user resumes it.
  - Manual mode runs one requested step. It uses the same prerequisites and per-task lock, and every disabled step says why.
- **Runs are child processes of ADE** (`stage-runner.ts`):
  - Command: `claude -p --output-format stream-json`, with `--model`, `--effort`, `--max-turns`, `--permission-mode`, `--max-budget-usd`, the allowed and disallowed tools, `--add-dir <task folder>`, `--agents` and `--session-id`.
  - The prompt goes through stdin, never in process arguments.
  - Cancel and timeout kill the process tree.
  - ADE prices each streamed response while the run is going. At the end it records Claude Code's reported cost, which includes subagents.
- **Done means verified:**
  - The checks the user approved for the project passed after the last change, and an independent review run (read-only, Write and Edit disallowed) ended with `VERDICT: PASS`.
  - A quick task with passing checks needs no review.
  - Without checks, the review alone decides.
  - A failed check or review starts a correction run with the exact failure. Then checks and review run again.
- **Limits are kept in `task.json`:** corrections (2), review rounds (3), escalations (2) and the task budget ($10). Defaults are in Settings › Models & Cost › Task runs.
  - Once the estimated spend reaches the budget, ADE starts no further run.
  - Each run's `--max-budget-usd` is set to what is left of the budget.
  - Claude Code checks that cap as the run goes, so a run can end slightly above it. The UI says so and does not call it a strict ceiling.
- **Lifecycle:**
  - Runs record queued, running, succeeded, failed, cancelled, blocked and interrupted, with ids, timestamps and a failure reason.
  - Run events are idempotent: a duplicate or stale completion changes nothing.
  - After a restart, runs that were in progress become `interrupted` and their task is paused. Nothing is re-run until the user resumes.
  - On quit, ADE kills the process trees of its runs.
- **Models:**
  - Known aliases are pinned to their IDs (opus → `claude-opus-5-5`, …). Pinning is skipped when the user sets `ANTHROPIC_DEFAULT_*_MODEL` or uses Bedrock, Vertex or Foundry.
  - If the model is unavailable to the account, the stage is retried once on the next cheaper tier, and never on a pricier one (this can be turned off).
  - Auth and rate-limit failures are shown and never trigger a model switch.
- **Worktree identity:**
  - A task records its workspace, worktree, branch, HEAD and the content hashes of files that were already dirty.
  - Runs use that worktree as their working directory.
  - In another worktree of the same project, the task is shown but locked, except for Pause and Cancel, until the user moves it ("Move task to this worktree").
  - The reviewer gets only the task's own tracked, staged and untracked changes. Edits made before the task started are listed separately and excluded.
- **Role names are namespaced** (`ade-planner`, `ade-reviewer`, …), so a project's own agents with those names are never overridden.

### Security

- **No implicit permission bypass anywhere:**
  - Task runs use `acceptEdits`. The "edits and checks" profile also allows only the approved check commands and read-only git. "Bypass" is an explicit setting with a warning.
  - `/agent/invoke` runs, terminal and headless, use `acceptEdits` unless the agent's registry entry sets `permissionMode`.
  - Restored terminals resume with plain `claude --resume <id>`, so the user's own Claude Code settings apply.
- **The local server** (127.0.0.1 only) no longer sends wildcard CORS headers. It refuses requests that carry a browser `Origin` or a non-local `Host` (DNS rebinding).
  - `POST /agent/invoke` needs `Authorization: Bearer <ADE home>/invoke-token`. The token is random and created with mode 0600. ADE's watcher sends it.
  - `POST /agent/message` and transcript recording on `/hook/complete` need either that token or the hook token that ADE terminals get as `SUPERSET_HOOK_TOKEN`. The hook token cannot start agents.
  - Transcript recording accepts only `.jsonl` paths.
- **Headless invoke** writes the prompt to stdin (the 30,000-character argv limit is gone) and kills the process tree on timeout.

**Migration:**
- External scripts that POST to `/agent/invoke` must send the invoke token.
- Agents that relied on the old unconditional bypass need `"permissionMode": "bypassPermissions"` in `~/agents/registry.json`.

### UI

- **Tasks panel** (model bar › Tasks):
  - One request box with an Auto/Manual switch and a route preview. Auto's button is "Run task".
  - Approve the project's checks once; ADE suggests them from package.json.
  - Per task:
    - state and reason
    - live run list with model, observed model, verdict, check results, failure and cost
    - Pause, Resume and Cancel
    - an answer box for plan questions
    - Raise budget
    - in Manual mode, step buttons with the reason a step is disabled
    - "Open session in terminal", labelled as interactive, where ADE's limits do not apply
- **Cost labels:**
  - Each amount is shown as reported, `~` estimate, "so far" while the run is going, "at least" when some responses could not be priced, or "unknown".
  - Task runs and your own sessions are totalled separately.
  - Everything is labelled as an API-equivalent estimate, not a charge on a subscription.
- **Labels:**
  - The model-bar logos say they open a plain interactive session, not a managed task.
  - Codex workspaces say that task stages run on Claude Code.

### Codex boundary

Managed stages always run on Claude Code, including in Codex workspaces, and the panel says so. Codex sessions you open yourself are not part of a task.

### Verification (no billable calls)

Every test uses a fake `claude` script (`agent-workflow/testing/fake-claude.ts`). Guards fail the test if a real `claude` or `codex` would be spawned, or if `fetch` is called.

- **`workflow.acceptance.test.tsx`:** the workflow tRPC router with the real controller, runner and check commands, against real git repositories, 14 scenarios:
  - an existing repository with its own CLAUDE.md and its own `reviewer` agent: one Auto request goes plan (opus), build (sonnet), checks, review (sonnet), then done, with no Build or Review click
    - the effort, turn limit and permissions on each process are the role's
    - the reviewer saw only the task's own change
    - no files were added to the repository
    - the panel renders the result
  - a trivial task: quick (haiku), then checks, then done, with no plan and no review
  - a plan question, then needs-input, then the user's answer, then done
  - a failed review, then a fix with the reviewer's findings, then re-checks, then a passing re-review
  - retry exhaustion: blocked after 2 corrections
  - an unavailable model: a cheaper retry on sonnet; Haiku has nothing cheaper, so the task blocks
  - budget exhaustion: no further launch, and the run was capped at the remainder
  - usage on an unpriced model shows as partial
  - Claude Code missing: the launch failure is surfaced
  - cancel kills the process tree, grandchild included
  - concurrent Start clicks launch once; duplicate and stale completions change nothing
  - restart: the run becomes interrupted, nothing is replayed, and the user resumes
  - Manual mode: single steps, a model override, disabled steps with their reasons
  - two projects and two worktrees of one project: the task is locked in the other worktree; an explicit move makes later runs use that worktree's cwd and branch
- **Unit tests:**
  - `controller.test.ts`: transitions and spend accounting
  - `stage-runner.test.ts`: stdin, flags, streamed cost, unknown price, failure classes, tree kill on cancel
  - `identity-checks.test.ts`
  - `models.test.ts`
  - `project-tasks.test.ts`: task records, the v1 upgrade, the lock
  - `local-auth.test.ts`
  - `server-auth.test.ts`: real HTTP: no CORS, 401 without the token, 403 for browsers
  - `headless-run.test.ts`: stdin, explicit permissions, tree kill on timeout
  - `agent-invoke.test.ts`: the registry permission mode through a real bash

The argument-capture tests check only that flags are passed correctly. The acceptance tests are what show the orchestration works.

### Release verification (2026-11-18)

**Bugs fixed in release testing** (regression tests in `controller.test.ts` and `workflow.acceptance.test.tsx`, under "release regressions"):

- A quick run that says "Needs implementer" no longer counts as the implementation; the implementer runs before checks or review.
- Check results count only for the exact approved commands and for the code state they ran on. Reviews are tied to their code state too.
- Uncertain spend counts at the run's cap in every budget decision, and the UI shows it as a range.
- The branch is revalidated before every stage.
- A move voids earlier evidence (the runs are kept as history), then the task reconciles and is verified again.
- Cancelling a task waits only for that task's own runs.
- Opening an existing folder now lists the project in the sidebar and opens its workspace. Before, it was invisible and navigated to a missing route.

**Real app with mocked execution.** Dev build, isolated ADE home, a compiled stand-in for `claude` set through `ADE_CLAUDE_BINARY`, driven through the dev test bridge on port 41732.

- An existing repo was opened. An Auto request ran implement, `npm run test`, then review, ending in Done (verified), with live progress, model and cost.
- Manual mode: disabled steps show their reasons, and a model override ran on Haiku.
- Cancel killed the process tree.
- After quitting and relaunching, the workspace, tasks, runs, checks and totals were restored.

**Real smoke task** (authorized by the user):

- Project: a disposable repo.
- Task: Fix the typo in README.md: change "Teh greeter" to "The greeter".
- Run: Auto, budget $0.50, with the installed Claude Code 2.1.193. The route was quick (`claude-haiku-5-5`, low effort, 15 turns, `acceptEdits`).
- Result: ADE ran `npm run test` and it passed, ending in Done (verified) with no stage clicks.
- Changes: only `README.md`, with exactly the requested fix.
- Cost: Claude Code reported $0.011; ADE's live estimate was $0.0105.

### Known limits

- Real-model coverage is one quick task. The plan, review, correction and escalation paths have been exercised only with the fake `claude`.
- While a run is in progress, its cost counts at its cap, so with a small budget the task card can show "Raise budget" during a normal run (cosmetic).
- After a restart mid-run, the interrupted run's cost is uncertain. The budget must be raised before resuming.
- Earlier wording in this section: the run was not yet tried against a real model. The stream-json fields, the failure texts and how far `--max-budget-usd` can be exceeded come from the CLI's help text and earlier transcripts, not a live run. Watch the first real run.
- Checks run through Git Bash on Windows (cmd.exe if it is missing) and the login shell elsewhere. A project whose checks need another shell must write them accordingly.
- ADE cannot enforce effort or turn limits in interactive sessions, including sessions opened with "Open session in terminal". The UI says so.
- The built-in chat (mastracode) is still not part of the workflow.

## 0. v2: any project, managed by ADE (2026-11-17)

Sections 1–11 below record how the work got here (M1–M5). Where they describe files written into agent repositories, slash commands, `.ade/tasks` or a main-session model, **v2 replaces them**. Where v2 describes terminal stage launches, unprefixed role names or "Inside Claude sessions, handoffs are automatic", **v3 (section A) replaces them**.

### What was missing in v1

- **Only scaffolded agents got the workflow,** and only by writing files into their repositories: `.claude/agents`, `.claude/commands`, a settings model, a CLAUDE.md note and `.ade/tasks`. A project opened in ADE got nothing.
- **No task interface:** no place to describe a task, no automatic choice between planning and going straight to work, and stages ran only as typed slash commands.
- **Usage was not grouped by project or task.**
- **Defaults put planning on Fable;** the requirement is Opus for planning and Fable only for exceptional problems.
- **Headless runs** bypassed ADE's wrapper and got no roles.

### Design

- **Per-project state outside the project.** `<ADE home>/workflow/projects/<key>/` holds:
  - `agents.json`: the roles as Claude Code `--agents` JSON, generated from Settings
  - `tasks/<slug>/`: task.json, task.md, plan.md, progress.md, escalations/
  - `run-label`

  The key is `<folder name>-<hash of root>`, so a reopened project finds its state and projects never mix. The root is the project's main repo, or an ADE agent's worktree.
- **Every terminal gets its project's workflow.** `buildTerminalEnv` sets `SUPERSET_PROJECT_KEY`, `SUPERSET_WORKFLOW_AGENTS` and `SUPERSET_WORKFLOW_TASKS_DIR`; they survive the terminal host's `SUPERSET_` allowlist. ADE's `claude` wrapper adds `--add-dir <tasks> --agents <roles>` to sessions (not to subcommands such as `claude update`). Confirmed in the installed 2.1.193: `--agents` accepts description, prompt, tools, model, effort and maxTurns.
- **Routing without an AI call.** `shared/utils/task-routing.ts` sends small, specified changes to `quick` (Haiku), focused changes to `implement` (Sonnet, no plan), and complex ones to `plan` (Opus plans, Sonnet builds and reviews). `exceptional` (Fable plans) is chosen by the user. Route and model can be overridden.
- **Stages run on their role's model directly,** with no coordinator, each in a new terminal tab with a pinned `--session-id`. Inside Claude sessions, handoffs are automatic through the injected roles: blocked steps go to `architect` (Fable, at most 2 per step) and finished work to `reviewer` (at most 2 review rounds). Plans are reused; nothing is re-planned once plan.md exists.
- **Tasks panel** (model bar > Tasks) in every workspace: describe a task with a live route preview, override route or model, and see each task's status, next stage, cost and models used, plus the project's total.
- **Usage per project and per task.** The hook forwards the project key, and tasks match sessions by their pinned ids.
- **Retired:** in-repo role and command files, the launch-time sync that wrote them, and the scaffold's workflow additions. ADE agents get only their memory files again. Old settings keys (mainModel, appliedMainModel) are ignored.

### Integrations

| Path | Shares the orchestration? | How |
|---|---|---|
| Claude Code terminals (model bar, presets, plain `claude`) | Yes | ADE's wrapper injects the roles and task folder. |
| Task stages (Tasks panel) | Yes | Launch command with `--model` and a pinned session id, through the same wrapper. |
| `/agent/invoke`, terminal mode | Yes | Runs `claude` through the wrapper. |
| `/agent/invoke`, headless mode | Yes | `--add-dir` and `--agents` passed directly, plus the spending and turn caps. |
| Codex terminals | Partly (adapter) | Stages run single-agent on Codex's own model. Codex has no subagents, so handoffs stop and ADE offers the next stage. |
| Built-in chat (mastracode) | No | Needs a provider-specific adapter: mastracode routes by its own modes and subagents through `harness.switchModel`. Not wired. |
| Agent scaffolding | Not needed | Agents are covered by the terminal path; the scaffold writes no workflow files. |
| Agent registry `model` | Yes | Still applied per invoke. |

### Verification (no billable calls)

- **End to end in bash** through ADE's real wrapper script and a fake `claude` (`orchestration.e2e.test.ts`):
  - a pre-existing project with its own CLAUDE.md and `.claude/agents` gets the roles in a plain session
  - a planned task's stages run on opus, sonnet, sonnet and fable with pinned sessions
  - the project's files stay byte-identical
  - `claude update` and `claude mcp list` get no extra flags
  - a newly scaffolded ADE agent gets its own isolated workflow and no workflow files in its repository
- **Unit tests:** router, project keys and isolation, tasks and next stage, stage models and overrides, Codex prompts, terminal env through the terminal-host filter, hook and headless wiring.
- **`bun run workflow doctor <any folder>`** on this repo: all roles correct, CLI support confirmed, repository unchanged.

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

### M3 — Honor the registry model on `/agent/invoke` (done 2026-11-17)

- Pass `entry.model` through `AgentInvokeEvent`.
- Add `--model <value>` to the command built in `useAgentHookListener.tsx` when present. Validate it against `^[A-Za-z0-9._\[\]-]+$` before putting it in the shell command.
- Tests for command building (extract it into a small pure helper so it can be tested).

**Acceptance:** an invoke for an agent with `model: "fable"` launches `claude --model fable ...`; without it the command is unchanged.

**Result:**
- New helper `apps/desktop/src/shared/utils/agent-invoke-command.ts` (`buildAgentInvokeCommand`, `isSafeCliToken`). `useAgentHookListener.tsx` now calls it instead of building the string inline.
- Model source: the request body's `model` first (the endpoint's doc comment already advertised `model?`), then the registry entry's `model`. Carried on `AgentInvokeEvent.model`.
- Validation: the model **and the session id** are used only when they match `^[A-Za-z0-9._[\]-]+$`; otherwise they are dropped, never escaped. The session id was previously inserted into the shell command unchecked.
- Without a model, the command is byte-for-byte what it was before (covered by a test).
- Tests: 8 new, all passing. Notifications tests still pass (64 in that run). Desktop typecheck passes.
- Biome: the 2 warnings in `server.ts` (unused import and parameter) predate this change. Biome also re-sorted one import and reformatted a destructure in that file.
- Not yet tried with a real `/agent/invoke` call.

### M4 — Measure and tune

**Sheet:** [measurements.md](measurements.md) is the protocol and the generated report. The runs themselves need the user's real tasks and spend their tokens or plan usage.

- Re-run the M0 tasks with `/plan` → `/build` → `/review`. Record the same metrics.
- Compare cost/usage per completed task.
- Tune `effort`/`maxTurns` only where the data shows a problem.

Report measured numbers separately from estimates.

**Tooling (done 2026-11-17).** Usage is recorded automatically; nothing is typed in by hand:
- **Recording.** On every Stop, the notify hook forwards `transcript_path`, and ADE rebuilds that session's summary from the transcript and its subagents' transcripts (`main/lib/usage-metrics`). Each summary has the model per response and per role, all five token categories, active/wall time, escalations, review rounds, retries, API errors and task progress.
  - Responses are keyed by API message id, so resumed or forked sessions are not double-counted.
  - Interactive sessions have no JSON output mode; the transcript holds the same data.
- **Commands** (`bun run workflow ...`): `label` tags runs, `check`/`result` record pass or fail, `import`/`record` add other sessions, and `report --update measurements.md` writes the results.
- **Report.** Cost per success for each arm counts all spending (failed runs included) and applies the decision rule.
- **Verified against real data.** This repo's own transcript was imported (179 Opus 5.5 responses; subagents correctly attributed to Haiku 5.5).

### M5 — Model routing settings and cost controls (done 2026-11-17)

- **Settings > Models & Cost.** Model, effort and turn limit per role and for the main session, stored in `<ADE home>/workflow-settings.json`.
  - Saving and every launch re-apply it to all agents, but only to unedited ADE files.
  - The main model changes only where it still holds ADE's last value (`appliedMainModel`).
- **Cost warnings.** A desktop notification when a session or the day passes its estimated threshold (defaults $10 and $50). Interactive sessions cannot be capped from outside, so these are warnings.
- **Headless runs with a hard cap.** `/agent/invoke` with `mode: "headless"` runs `claude -p --max-budget-usd --max-turns`.
  - Limits come from settings (defaults $5 and 50 turns); a request may lower them, not raise them.
  - One run per agent at a time.
  - Launched with an argument array and no shell.
  - Logged to `metrics/headless-runs.jsonl` with Claude Code's reported cost.
- **Not done:** OpenTelemetry capture. Transcripts give the same per-model data with no collector to run.

### Security hardening of M3 (done 2026-11-17)

- Invoke prompts no longer go on the command line. They are written to a private file (0600, pruned after a day), and the command reads it:
  - POSIX: `"$(cat -- '<file>')"`.
  - PowerShell and cmd: an instruction to read the file.
- Requests are validated strictly: types, NUL, length, and plain-token model and session ids.
- Integration tests run the command through a real bash and Windows PowerShell with a fake `claude`.

### Verification of role models (P3)

- `bun run workflow doctor <agent worktree>` checks, with no model call:
  - each role's file (default, customized, missing or invalid)
  - the main model, the CLAUDE.md pointer and the `.ade/` exclude
  - the installed CLI's support for the `effort` and `maxTurns` fields and the `fable` alias (all present in 2.1.193)
- With recorded sessions, it also lists the models each role actually ran on and flags mismatches.
- The first real arm-B run therefore confirms the routing from usage data.

## 7. User overrides

- In the app: Settings > Models & Cost (all agents; edited files are left alone).
- In session: `/model`, or name a model when asking for a subagent.
- Per agent: edit `.claude/agents/*.md` or `.claude/settings.json` (never overwritten by ADE).
- Per invoke: `model` in the `/agent/invoke` body, or `model` in `~/agents/registry.json`.
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
