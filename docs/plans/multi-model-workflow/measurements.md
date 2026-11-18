# M4: measuring the multi-model workflow

Goal: find out, with real numbers, whether the workflow lowers the **cost per successfully completed task** without lowering the success rate.

Usage is now recorded automatically. You run the tasks and judge them; ADE records the rest. The results section at the end of this file is generated. Do not edit it by hand.

All commands below run from `apps/desktop` and spend no tokens. Only the task runs themselves (section 3) use your plan or API usage.

## 1. What is recorded automatically

Every time a Claude Code session in an ADE terminal stops, ADE reads that session's transcript and its subagents' transcripts. It stores one summary per session in `<ADE home>/metrics/sessions/`.

| Measured | From |
|---|---|
| Model actually used, per response and per role (main, planner, implementer, quick, reviewer, architect) | transcript `message.model` and the subagent's `meta.json` |
| Input, output, cache-read, 5-minute and 1-hour cache-write tokens | transcript `message.usage` |
| Estimated API-equivalent cost | list prices from the Anthropic pricing page (read 2026-11-17) |
| Active time (prompt to last response, summed over turns) and wall time | transcript timestamps |
| Escalations (architect calls), review rounds, step retries | Agent tool calls; `.ade/tasks/<slug>/progress.md` counters |
| Workflow status (planned / in progress / blocked / done) | `progress.md` |
| API errors | transcript error entries |

Each response is counted once by its API message id, so repeated Stops and resumed or forked sessions are never double-counted.

Sessions started outside ADE terminals can be added afterwards with `bun run workflow import --cwd <folder>`.

## 2. Before the first run

1. Update Claude Code if you want (`claude update`). The installed 2.1.193 already supports everything the workflow uses; `bun run workflow doctor` confirms this.
2. Choose 5–10 real tasks with a mix of sizes:
   - **S:** a one-file fix
   - **M:** a feature touching 2–5 files
   - **L:** a change across packages

   Name them T1, T2, ….
3. For each task, write the exact prompt and the acceptance-check commands **before** any run. The checks decide success for every arm, so they must not depend on tests a run writes: use existing tests, typecheck, lint, or a script you write now.
4. In each agent you will use, run `bun run workflow doctor <agent worktree>`. Every role should show its model (fable, fable, sonnet, haiku, sonnet) and no `!!` problems.

## 3. Running a task

Run every task once per arm, each from the **same starting commit** on its own branch, for example `git switch -c m4-T1-B <start>`.

**Before** starting the session, label the folder so its sessions are grouped:

```bash
bun run workflow label T1/B --cwd <agent worktree>
```

The arms:

| Arm | What it is | How to run it |
|---|---|---|
| **A** | Current baseline | `claude --model opus --dangerously-skip-permissions`, give the prompt directly, no workflow commands. Temporarily rename `.claude/agents` to `.claude/agents.off` so Claude does not call the workflow subagents on its own. |
| **A2** | Efficient single model | Same as A, but start with `CLAUDE_CODE_EFFORT_LEVEL=medium claude --model opus --dangerously-skip-permissions`. |
| **B** | Multi-model workflow | `/plan <prompt>`, approve the plan, `/build`, `/review`. |

When the session is done, judge it with the acceptance checks. This runs the commands and records pass or fail:

```bash
bun run workflow check T1/B --cwd <agent worktree> -- "bun run typecheck" "bun test src/feature"
```

Or record a manual verdict:

```bash
bun run workflow result T1/B fail --note "login button missing"
```

Clear the label when you finish a series: `bun run workflow label --clear --cwd <agent worktree>`.

## 4. Updating this report

```bash
bun run workflow report --update ../../docs/plans/multi-model-workflow/measurements.md
```

`bun run workflow sessions` lists every recorded session with its label and estimated cost.

## 5. Decision rule (proposal: confirm or change before looking at results)

Keep the workflow as the default if both hold:
1. Arm B's success rate is at least the better baseline's (A or A2).
2. Arm B's cost per success is at most **70%** of that baseline's.

**Cost per success** = everything an arm spent (planning, implementation, testing, review, retries, escalations, and the failed runs) ÷ its number of passing runs.

Otherwise:
- If Fable is most of arm B's cost, check escalation counts and lower the planner's effort or turn limit.
- If B fails more often, read the failed runs' `progress.md` and escalation reports to see which stage broke.
- If A2 matches B, prefer A2: one model is simpler and keeps one prompt cache.

## 6. Caveats

- Costs are list-price estimates. On a Claude subscription they show relative usage, not charges.
- Responses in fast mode or from models missing from the price table count as $0 and are listed as unpriced in the report.
- With 5–10 tasks run once each, a difference under about 20% may be noise. Re-run the tasks that decide the outcome.

## 7. Results

<!-- m4-report:start -->
_Not generated yet. Run `bun run workflow report --update ...` (section 4)._
<!-- m4-report:end -->
