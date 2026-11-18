# M4: measuring the multi-model workflow

Goal: find out, with real numbers, whether the workflow lowers the **cost (or usage) per successfully completed task** without lowering the success rate.

Everything in this file except the "How to fill it in" text is a blank to fill in. Nothing here is measured yet.

## 1. Before the first run

- [ ] Update Claude Code: `claude update`, then `claude --version`. Record the version: ________
  - 2.1.193 was installed on 2026-11-17. The docs used for the design describe a newer release, so the `effort` field and the `fable` alias may not work on 2.1.193.
- [ ] Billing (decision D1): API key / Claude subscription (circle one).
  - On a subscription, `/usage` dollar figures are list-price estimates. Use them to compare the two runs, not as money spent.
- [ ] In an ADE agent's terminal, run `/agents`. Confirm planner, architect, implementer, quick and reviewer appear with the models fable, fable, sonnet, haiku and sonnet.
- [ ] Run `/model` and confirm the main session shows Sonnet.
- [ ] Pick the tasks (section 2) and write each one's acceptance checks **before** any run.

## 2. Tasks

Use 5–10 real tasks from your backlog, with a mix of sizes:
- **S:** a one-file fix
- **M:** a feature touching 2–5 files
- **L:** a change across packages

Write each task as one fixed prompt, so both runs get the same words.

The checks decide success for **both** runs. They must not depend on tests either run writes: use existing tests, typecheck, lint, or a manual check you describe now.

| # | Size | Task prompt (exact text) | Acceptance checks (commands or manual steps) |
|---|---|---|---|
| T1 | | | |
| T2 | | | |
| T3 | | | |
| T4 | | | |
| T5 | | | |

## 3. The runs

Run every task once in each arm, each time from the **same starting commit** in a clean checkout. For example, use `git switch -c m4-T1-A <start>` and `git switch -c m4-T1-B <start>`, so the second run never sees the first one's work.

Start every run in a **new session** (or after `/clear`). `/usage` resets on `/clear`; read it at the end of the run, before closing the session.

### Arm A: baseline (how you work today)

- Start Claude with the model you normally use (today's default is Opus 5.5): `claude --model opus --dangerously-skip-permissions`.
- Give the task prompt directly. Do **not** use `/plan`, `/build` or `/review`.
- The agent folder now contains the workflow subagents, and Claude may call them on its own. For a clean baseline, either:
  - run Arm A in a plain checkout without `.claude/agents/`, or
  - temporarily rename `.claude/agents/` to `.claude/agents.off/` and restore it afterwards.

### Arm A2 (optional): strong model at lower effort

Anthropic's guidance is to measure this before trusting a multi-model setup: one model means one prompt cache.

- `CLAUDE_CODE_EFFORT_LEVEL=medium claude --model opus --dangerously-skip-permissions`
- Same rules as Arm A.

### Arm B: the workflow

1. `/plan <task prompt>`. Read the plan; approve or answer its questions.
2. `/build <slug>`. Repeat until the task's steps are all done.
3. `/review <slug>`.

The run is over when the reviewer passes it, or when it stops and asks you.

## 4. What to record per run

From `/usage`, read the session's **Usage by model**. For each model, record the input, output, cache-read and cache-write tokens and the estimated cost; subagent usage is included.

| Run | Task | Arm | Models used (tokens in / out / cache read / cache write) | Est. cost ($) | Wall time (min) | Checks pass? | Your corrections (#) | Escalations (#) | Review rounds (#) | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | T1 | A | | | | | | – | – | |
| 2 | T1 | B | | | | | | | | |

- **Checks pass?** Yes only if every acceptance check from section 2 passes when you run it yourself after the session.
- **Your corrections:** count each time you had to step in: a fix, a re-prompt, or an answer the run could not continue without. Planning approvals in Arm B are not counted.

## 5. Results

Fill in after all runs.

| Arm | Runs | Successful | Success rate | Total est. cost ($) | **Cost per success ($)** | Median wall time (min) | Corrections per run |
|---|---|---|---|---|---|---|---|
| A | | | | | | | |
| A2 | | | | | | | |
| B | | | | | | | |

- **Cost per success** = total estimated cost of all runs in that arm (including failed ones) ÷ number of successful runs.
- Use the Arm B per-model rows to see where its cost went:
  - Fable share = planning + escalations
  - Sonnet share = coordination, implementation, review
  - Haiku share = quick edits

## 6. Decision rule (proposal: confirm or change before looking at results)

Keep the workflow as the default if both hold:
1. Arm B's success rate is at least Arm A's (or A2's, if run).
2. Arm B's cost per success is at most **70%** of the better baseline.

Otherwise:
- If Fable is most of Arm B's cost, check escalation counts and lower the planner's effort or turn limit.
- If B is slower or fails more often, compare its failed runs' `progress.md` and escalation reports to see which stage broke.
- If A2 matches B on cost per success, prefer A2: it is simpler.

## 7. Caveats

- `/usage` is a local estimate at list price. It is a fair comparison between arms, not an invoice.
- With 5–10 tasks and one run each, a difference under about 20% may be noise. Re-run the tasks that changed the answer before deciding.
- Prices used in the plan come from Anthropic's model table dated 2026-11-03. Check the pricing page before quoting dollar figures.
