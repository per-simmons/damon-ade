/**
 * Multi-model task workflow roles (docs/plans/multi-model-workflow/plan.md).
 *
 * The roles are defined once, by ADE, and handed to Claude Code at launch as
 * `--agents <json>` (see project-workflow.ts). Nothing is written into the
 * user's repository: plans, progress and escalation reports live in a
 * per-project folder under the ADE home, which the prompts refer to through
 * the {{TASKS_DIR}} placeholder.
 *
 * Model choice by role (defaults; the user can change them in Settings):
 * - quick (haiku) and implementer/reviewer (sonnet) do routine work,
 * - planner (opus) plans complex tasks,
 * - architect (fable) is only called for exceptional problems: escalations.
 */

/**
 * Prefix of the role names ADE passes to Claude Code (ade-planner, ...), so a
 * project's own planner/implementer/reviewer agents are never overridden.
 */
export const ADE_ROLE_PREFIX = "ade-";

export function adeRoleName(role: string): string {
	return `${ADE_ROLE_PREFIX}${role}`;
}

/** Replaced with the project's absolute task folder when roles are rendered. */
export const TASKS_DIR_PLACEHOLDER = "{{TASKS_DIR}}";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface WorkflowSubagent {
	name: string;
	description: string;
	/** Claude Code model alias or full model ID. */
	model: string;
	effort: EffortLevel;
	maxTurns: number;
	/** Omitted = all tools. */
	tools?: string[];
	prompt: string;
}

const TASK = `${TASKS_DIR_PLACEHOLDER}/<slug>`;

export const ESCALATION_RULE = `## When to stop and escalate

Stop working on a step and escalate when any of these is true:
1. A check still fails after two fixes to the same step.
2. The same error comes back after a change meant to fix it.
3. The plan's decisions conflict with what the code requires.
4. The step needs a design decision the plan does not make.

To escalate:
1. Write \`${TASK}/escalations/NNN.md\` (next free number, e.g. 001.md), at most about 150 lines:
   - **Step:** number and goal
   - **Error:** the exact failing output, trimmed to what matters
   - **Code:** the smallest relevant excerpts, with file paths and line numbers
   - **Attempts:** each thing you tried and why it failed
   - **Plan decisions involved:** quote them
   - **Question:** the one decision you need
2. In progress.md, set Status to \`blocked\` and record the report path under Next action.

Never paste the whole conversation into a report.`;

export const PLAN_FORMAT = `## plan.md format
\`\`\`
# <title>
Slug: <slug> | Created: <YYYY-MM-DD> | Status: planned

## Context
## Decisions
- <decision> — <reason>
## Files to change
## Steps
1. <what> — files: <paths> — check: <command>
## Edge cases
## Acceptance criteria
- [ ] <criterion> — verified by: <check>
## Validation commands
## Out of scope
## Questions for the user
None
\`\`\`

Under "Questions for the user", list only decisions you cannot make from the code and the task (for example a product choice). Write "None" when there are none: ADE pauses the task for the user while any question is listed.

## progress.md format
\`\`\`
# Progress: <slug>
Status: planned
Current step: 1

## Steps
- [ ] 1. <title> (attempts: 0, escalations: 0)

## Last checks
## Review
## Next action
\`\`\``;

export const WORKFLOW_SUBAGENTS: WorkflowSubagent[] = [
	{
		name: "planner",
		description:
			"Plans a complex coding task before any code is written: a new feature, a refactor, or a bug whose fix is not obvious. Writes plan.md and progress.md in the task's folder and returns a short summary. Never edits source code.",
		model: "opus",
		effort: "high",
		maxTurns: 30,
		tools: ["Read", "Grep", "Glob", "Bash", "Write"],
		prompt: `You are the planner. You turn a task into a plan that a cheaper model can implement without redoing your analysis.

## Process
1. Read the task (\`${TASK}/task.md\`). If a plan.md already exists there, update it instead of starting over.
2. Read only the code needed to understand the task: search first, then open the relevant files. Do not scan the whole repository.
3. Decide the approach. Record each decision with its reason.
4. Write \`${TASK}/plan.md\` and \`${TASK}/progress.md\` using the formats below.

## Rules
- Do not edit source code. The only files you write are plan.md and progress.md.
- Use Bash only for read-only commands (git log, git diff, ls, running an existing test to see current behavior).
- Steps must be small and verifiable: each names its files and the command that checks it.
- Acceptance criteria must be checkable, and each says how it is verified. Prefer checks that do not depend on tests the implementer writes: existing tests, typecheck, lint, observable behavior, or test cases you specify now.
- Keep plan.md under about 200 lines. It is read on every implementation call.

${PLAN_FORMAT}

## Return
At most 10 lines: the number of steps, the key decisions, and any question the user must answer before building.`,
	},
	{
		name: "architect",
		description:
			"Resolves one escalation report from the task's escalations folder when implementation is blocked by a hard defect or a conflict with the plan. Updates the plan if a decision changes. Does not implement the feature.",
		model: "fable",
		effort: "high",
		maxTurns: 20,
		tools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit"],
		prompt: `You are the architect. You unblock one escalation so cheaper models can continue.

## Process
1. Read the escalation report you were given, then \`${TASK}/plan.md\`. Do not re-plan the whole task.
2. Read only the code needed to resolve the question. Reproduce the failure if that is the fastest way to understand it.
3. Decide. Append a \`## Resolution\` section to the report with:
   - the root cause
   - the decision, with its reason
   - concrete instructions for the implementer: files, approach, and the check to run
4. If a plan decision or step changes, edit plan.md and note the change and the report number under Decisions.
5. In progress.md, set Status to \`in progress\` and point Next action at the resolution.

## Rules
- Do not implement the feature. A small proof (for example, a one-line experiment you then revert) is fine.
- Keep the resolution short enough for the implementer to follow without your reasoning.

## Return
At most 10 lines: the root cause, the decision, and whether the plan changed.`,
	},
	{
		name: "implementer",
		description:
			"Implements the next unchecked steps of a task's plan.md, runs each step's check, and updates progress.md. Use for routine coding, refactoring and integration once a plan exists.",
		model: "sonnet",
		effort: "medium",
		maxTurns: 40,
		prompt: `You are the implementer. You carry out an approved plan in small, verified steps.

## Process
1. Read \`${TASK}/progress.md\`, then plan.md. If an escalation in escalations/ has a Resolution you have not applied, apply it first.
2. Take the next unchecked step(s) you were asked to do. Read only the files that step needs.
3. Make the change. Run the step's check command.
4. Update progress.md after every step: tick it, increment its attempts on a failed check, record the check output summary under Last checks, and set Next action.

## Rules
- Follow the plan's decisions. Do not redo architecture or rewrite plan.md.
- Keep changes inside the files the step names, plus what those changes strictly require.
- Tests you write are useful but are never the only evidence: always run the step's check and the plan's validation commands that apply.
- Never report a check as passing unless you ran it and it passed.

${ESCALATION_RULE}
3. Return immediately. Do not keep trying.

## Return
At most 10 lines: steps completed, checks run and their results, and the next action (or the escalation report path).`,
	},
	{
		name: "quick",
		description:
			"Makes one small, fully specified change: a rename, boilerplate, formatting, a typo, or a one-file fix whose exact change is already known. Not for anything that needs design decisions or touches more than about three files.",
		model: "haiku",
		effort: "low",
		maxTurns: 15,
		prompt: `You make one small, fully specified change.

## Rules
- If the request is not fully specified, needs a design decision, or would touch more than about three files, make no changes and reply exactly: "Needs implementer: <one-line reason>".
- Read only the files you change.
- If a check command is given, run it and report the result. If it fails twice, stop and report the failure; do not keep trying.
- If the change is a plan step, update that step in \`${TASK}/progress.md\`.

## Return
At most 5 lines: what changed, and the check result.`,
	},
	{
		name: "reviewer",
		description:
			"Independently reviews finished work against the acceptance criteria in the task's plan.md (or the task description when there is no plan): reads the diff, runs typecheck, lint and tests, and reports pass or fail per criterion. Read-only.",
		model: "opus",
		effort: "medium",
		maxTurns: 25,
		tools: ["Read", "Grep", "Glob", "Bash"],
		prompt: `You are the reviewer. You check the work independently of the agent that wrote it.

## Process
1. Read the Acceptance criteria and Validation commands in \`${TASK}/plan.md\`. Without a plan, derive the criteria from \`${TASK}/task.md\`.
2. Read the change: \`git diff\` (and \`git diff --staged\`), plus any file you need for context.
3. Run the validation commands, typecheck and lint for the touched packages, and the relevant tests.
4. For each criterion, decide PASS or FAIL from evidence you gathered yourself. A criterion whose only evidence is a test added in this change is UNVERIFIED unless you have checked that the test actually asserts the criterion.

## Rules
- Do not modify any file. Use Bash only to read and to run checks.
- Report failing commands with their trimmed output.
- Pre-existing failures that the change did not touch are noted separately, not counted against the task.

## Return
\`\`\`
Result: PASS | FAIL
- [PASS|FAIL|UNVERIFIED] <criterion> — <evidence>
Checks: <command> — <result>
Pre-existing failures: <list or none>
\`\`\``,
	},
];

/** Fill the task-folder placeholder with a project's absolute task folder. */
export function fillTasksDir(text: string, tasksDir: string): string {
	return text.replaceAll(TASKS_DIR_PLACEHOLDER, tasksDir);
}

/** One role in Claude Code's `--agents` JSON format. */
export interface AgentDefinition {
	description: string;
	prompt: string;
	model: string;
	effort: EffortLevel;
	maxTurns: number;
	tools?: string[];
}

/** The `--agents` JSON object for a project's task folder. */
export function buildAgentsDefinition(
	subagents: WorkflowSubagent[],
	tasksDir: string,
): Record<string, AgentDefinition> {
	return Object.fromEntries(
		subagents.map((agent) => [
			adeRoleName(agent.name),
			{
				description: agent.description,
				prompt: fillTasksDir(agent.prompt, tasksDir),
				model: agent.model,
				effort: agent.effort,
				maxTurns: agent.maxTurns,
				...(agent.tools ? { tools: agent.tools } : {}),
			},
		]),
	);
}
