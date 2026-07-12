import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = "https://github.com/davidondrej/skills";
const ANTHROPIC_COORDINATOR_SOURCE =
	"https://github.com/anthropics/claude-cookbooks/blob/main/managed_agents/CMA_plan_big_execute_small.ipynb";

const BUNDLED_AGENT_SKILLS: Record<string, string> = {
	"ade-orchestration": `---
name: ade-orchestration
description: Coordinate specialist agents for complex coding work.
version: 1.0.0
metadata:
  ade:
    tags: [orchestration, delegation, verification]
    source: ${SOURCE}
---

# ADE Orchestration

Use for work that benefits from several specialists. Fable 5 owns the plan,
delegation decisions, conflict resolution, and final answer.

## Procedure
1. Inspect the repository and define an observable completion condition.
2. Split work by capability, not by arbitrary file count.
3. Send implementation and terminal work to Codex, broad research to Gemini,
   fast agentic work to Sonnet, and cost-sensitive overflow to GLM/Kimi/MiniMax.
4. Give each delegate only the files, constraints, and expected artifact it needs.
5. Reconcile conflicting results against code and tests. Never decide by vote alone.
6. Run the repository checks and review the final diff before reporting completion.

## Verification
The final state must satisfy the stated completion condition and the relevant
tests, typecheck, lint, and build must pass or have a clearly reported blocker.
`,
	"goal-loop": `---
name: goal-loop
description: Run long work as a verified plan-act-test-review loop.
version: 1.0.0
metadata:
  ade:
    tags: [autonomy, goals, verification]
    source: ${SOURCE}
---

# Goal Loop

Use for tasks longer than about 30 minutes with a measurable finish condition.

## Contract
Define one objective, files to read first, constraints, an exact validation
command, checkpoints, and a stop condition. Never weaken tests to make the goal
pass and never refactor unrelated code.

## Loop
1. Plan the next small checkpoint.
2. Act within the stated scope.
3. Run the validation command.
4. Review failures and the diff.
5. Continue until the stop condition is true or human input is genuinely needed.

## Verification
Report the exact stop condition and the command output that proves it.
`,
	handoff: `---
name: handoff
description: Preserve compact verified state between agents or sessions.
version: 1.0.0
metadata:
  ade:
    tags: [context, delegation, continuity]
    source: ${SOURCE}
---

# Handoff

Capture session-specific state that a fresh agent cannot cheaply rediscover.

## Include
- Goal and current factual state: done, partial, and not started.
- Decisions and why they were made.
- Failed approaches and traps worth avoiding.
- Relevant files, commits, tests, and external artifacts.
- Open work and dependencies.

## Rules
Describe state rather than ordering the next agent around. Reference existing
artifacts instead of duplicating them. Remove secrets and personal data. Treat
every claim as context the receiving agent must verify against the repository.

## Verification
A fresh agent can continue after reading the handoff and referenced files without
repeating discovery or asking for information already established.
`,
	"source-backed-research": `---
name: source-backed-research
description: Research changing technical facts with primary sources.
version: 1.0.0
metadata:
  ade:
    tags: [research, web, citations]
    source: ${SOURCE}
---

# Source-Backed Research

Use for model comparisons, current APIs, pricing, releases, or technical choices
that may have changed.

## Procedure
1. State the decision the research must support.
2. Break it into three to six answerable questions.
3. Prefer official docs, changelogs, papers, repositories, and model cards.
4. Treat social posts and forums as leads, not proof.
5. Separate confirmed facts, inference, and unresolved uncertainty.
6. Run a gap pass for contradictions and single-source claims.

## Output
For each finding provide the source, the supported claim, confidence, and why it
matters to the decision. Do not present vendor benchmarks as neutral fact.
`,
	"model-evaluation": `---
name: model-evaluation
description: Compare candidate models with reproducible task evaluations.
version: 1.0.0
metadata:
  ade:
    tags: [models, benchmark, routing]
    source: ${SOURCE}
---

# Model Evaluation

Use before changing a production routing preference based only on launch claims.

## Procedure
1. Confirm exact model IDs, provider, pricing, region, and authentication method.
2. Select representative tasks from the real workload and freeze the prompts.
3. Run one smoke task before a paid batch.
4. Record success, latency, token use, cost, tool errors, and human quality score.
5. Repeat with the same harness and environment for every candidate.
6. Keep the previous winner as fallback until the new model proves reliable.

## Verification
Results include exact commands or request payloads, model versions, raw artifacts,
and a routing recommendation tied to measured workload performance.
`,
	"plan-big-execute-small": `---
name: plan-big-execute-small
description: Plan with a strong coordinator, execute with small workers.
version: 1.0.0
metadata:
  ade:
    tags: [orchestration, delegation, cost, parallelism]
    source: ${ANTHROPIC_COORDINATOR_SOURCE}
---

# Plan Big, Execute Small

Use for complex work with a small amount of planning and judgment plus a large
amount of reading, searching, checking, or mechanical execution. This is an ADE
adaptation of Anthropic's MIT-licensed coordinator cookbook.

## Roles
- The frontier coordinator owns decomposition, worker selection, conflict
  resolution, synthesis, and the final acceptance decision.
- Workers own one bounded brief each. Their raw pages, logs, or broad file reads
  stay in their own context; they return compact findings and evidence.

## Procedure
1. Inspect enough of the repository to define the global objective and acceptance
   checks without pulling every raw artifact into the coordinator context.
2. Split the work into independent, narrowly scoped briefs. Each brief states the
   objective, minimum context, allowed scope, expected artifact, validation, and
   stop condition.
3. Select the cheapest capable worker for each brief. Reserve the strongest model
   for ambiguous decisions, architecture, reconciliation, and final review.
4. Run independent workers in parallel. Keep dependent work sequential.
5. Wait for every expected worker report before concluding. Retry infrastructure
   failures with a fresh fallback worker; do not treat an error as a finding.
6. Reconcile reports against source files and tests. Resolve conflicts by evidence,
   not majority vote.
7. Produce one coherent result and run the end-to-end acceptance checks.

## Worker Report
Return only: outcome, evidence with file/line or source references, changed
artifacts, validation performed, uncertainty, and recommended next action. Never
paste an entire raw page, log, or repository scan into the coordinator context.

## Verification
The coordinator can account for every brief, every expected report arrived or was
retried, conflicts were resolved explicitly, and the final acceptance checks pass.
`,
};

export function seedBundledAgentSkills(skillsDir: string): void {
	for (const [name, content] of Object.entries(BUNDLED_AGENT_SKILLS)) {
		const directory = join(skillsDir, name);
		mkdirSync(directory, { recursive: true });
		const path = join(directory, "SKILL.md");
		if (!existsSync(path)) writeFileSync(path, content, "utf8");
	}
}
