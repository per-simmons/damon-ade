import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Multi-model task workflow for ADE agents on the Claude Code runtime
 * (docs/plans/multi-model-workflow/plan.md).
 *
 * Generates native Claude Code subagents (.claude/agents/*.md) that pin a model
 * per role, plus slash commands (.claude/commands/*.md) that drive a
 * plan -> build -> review loop with durable task state under .ade/tasks/<slug>/.
 * The expensive reasoning model only runs inside `planner` and `architect`;
 * implementation, small edits and review run on cheaper models.
 *
 * Files are written only when missing or empty, so a user's edits survive
 * re-scaffolding and the launch-time sync.
 */

/** Model the main (coordinator) session runs on, via .claude/settings.json. */
export const WORKFLOW_MAIN_MODEL = "sonnet";

/** Task state directory, relative to the worktree. */
export const WORKFLOW_TASKS_DIR = ".ade/tasks";

/** Worktree paths the workflow adds to .git/info/exclude. */
export const WORKFLOW_EXCLUDES = [".ade/"];

/** Appended to the generated CLAUDE.md bridge. */
export const WORKFLOW_BRIDGE_POINTER = `
<!-- ADE task workflow -->
For multi-step coding tasks, use /plan, then /build, then /review. Task state lives in ${WORKFLOW_TASKS_DIR}/<slug>/ (plan.md, progress.md, escalations/). Do a small, fully specified edit directly or with the quick subagent.
`;

export interface WorkflowSubagent {
	name: string;
	description: string;
	/** Claude Code model alias or full model ID. */
	model: string;
	effort: "low" | "medium" | "high" | "xhigh" | "max";
	maxTurns: number;
	/** Omitted = all tools. */
	tools?: string[];
	prompt: string;
}

export interface WorkflowCommand {
	name: string;
	description: string;
	argumentHint: string;
	body: string;
}

const ESCALATION_RULE = `## When to stop and escalate

Stop working on the step and escalate when any of these is true:
1. A check still fails after two fixes to the same step.
2. The same error comes back after a change meant to fix it.
3. The plan's decisions conflict with what the code requires.
4. The step needs a design decision the plan does not make.

To escalate:
1. Write \`${WORKFLOW_TASKS_DIR}/<slug>/escalations/NNN.md\` (next free number, e.g. 001.md), at most about 150 lines:
   - **Step:** number and goal
   - **Error:** the exact failing output, trimmed to what matters
   - **Code:** the smallest relevant excerpts, with file paths and line numbers
   - **Attempts:** each thing you tried and why it failed
   - **Plan decisions involved:** quote them
   - **Question:** the one decision you need
2. In progress.md, set Status to \`blocked\` and record the report path under Next action.
3. Return immediately. Do not keep trying.

Never paste the whole conversation into a report.`;

export const WORKFLOW_SUBAGENTS: WorkflowSubagent[] = [
	{
		name: "planner",
		description:
			"Plans a multi-step coding task before any code is written: a new feature, a refactor, or a bug whose fix is not obvious. Writes .ade/tasks/<slug>/plan.md and progress.md and returns a short summary. Never edits source code.",
		model: "fable",
		effort: "high",
		maxTurns: 30,
		tools: ["Read", "Grep", "Glob", "Bash", "Write"],
		prompt: `You are the planner. You turn a task into a plan that a cheaper model can implement without redoing your analysis.

## Process
1. Read the task. Read only the code needed to understand it: search first, then open the relevant files. Do not scan the whole repository.
2. Decide the approach. Record each decision with its reason.
3. Write \`${WORKFLOW_TASKS_DIR}/<slug>/plan.md\` and \`progress.md\` using the formats below. Use the slug you were given, or a short kebab-case one.

## Rules
- Do not edit source code. The only files you write are plan.md and progress.md.
- Use Bash only for read-only commands (git log, git diff, ls, running an existing test to see current behavior).
- Steps must be small and verifiable: each names its files and the command that checks it.
- Acceptance criteria must be checkable, and each says how it is verified. Prefer checks that do not depend on tests the implementer writes: existing tests, typecheck, lint, observable behavior, or test cases you specify now.
- Keep plan.md under about 200 lines. It is read on every implementation call.
- Put project-wide, durable facts in memory, not in the plan.

## plan.md format
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
\`\`\`

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
Run /build <slug>
\`\`\`

## Return
At most 10 lines: the slug, the number of steps, the key decisions, and any question the user must answer before building.`,
	},
	{
		name: "architect",
		description:
			"Resolves one escalation report from .ade/tasks/<slug>/escalations/ when the implementer is blocked by a hard defect or a conflict with the plan. Updates the plan if a decision changes. Does not implement the feature.",
		model: "fable",
		effort: "high",
		maxTurns: 20,
		tools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit"],
		prompt: `You are the architect. You unblock one escalation so cheaper models can continue.

## Process
1. Read the escalation report you were given, then plan.md. Do not re-plan the whole task.
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
			"Implements the next unchecked steps of an approved plan in .ade/tasks/<slug>/plan.md, runs each step's check, and updates progress.md. Use for routine coding, refactoring and integration once a plan exists.",
		model: "sonnet",
		effort: "medium",
		maxTurns: 40,
		prompt: `You are the implementer. You carry out an approved plan in small, verified steps.

## Process
1. Read \`${WORKFLOW_TASKS_DIR}/<slug>/progress.md\`, then plan.md. If an escalation in escalations/ has a Resolution you have not applied, apply it first.
2. Take the next unchecked step(s) you were asked to do. Read only the files that step needs.
3. Make the change. Run the step's check command.
4. Update progress.md after every step: tick it, increment its attempts on a failed check, record the check output summary under Last checks, and set Next action.
5. Continue with the next step if asked to do several; stop when they are done.

## Rules
- Follow the plan's decisions. Do not redo architecture or rewrite plan.md.
- Keep changes inside the files the step names, plus what those changes strictly require.
- Tests you write are useful but are never the only evidence: always run the step's check and the plan's validation commands that apply.
- Never report a check as passing unless you ran it and it passed.

${ESCALATION_RULE}

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
- If the change is a plan step, update that step in \`${WORKFLOW_TASKS_DIR}/<slug>/progress.md\`.

## Return
At most 5 lines: what changed, and the check result.`,
	},
	{
		name: "reviewer",
		description:
			"Independently reviews a finished task against the acceptance criteria in .ade/tasks/<slug>/plan.md: reads the diff, runs typecheck, lint and tests, and reports pass or fail per criterion. Read-only.",
		model: "sonnet",
		effort: "medium",
		maxTurns: 25,
		tools: ["Read", "Grep", "Glob", "Bash"],
		prompt: `You are the reviewer. You check the work independently of the agent that wrote it.

## Process
1. Read the Acceptance criteria and Validation commands in \`${WORKFLOW_TASKS_DIR}/<slug>/plan.md\`.
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

export const WORKFLOW_COMMANDS: WorkflowCommand[] = [
	{
		name: "plan",
		description: "Plan a coding task with the planner subagent",
		argumentHint: "<task description>",
		body: `Plan this task with the planner subagent: $ARGUMENTS

1. Pick a short kebab-case slug that is not already used under \`${WORKFLOW_TASKS_DIR}/\`.
2. Delegate to the planner subagent with the task text and the slug. Do not do the analysis yourself.
3. Show the user the planner's summary and the path to plan.md.
4. Ask the user to approve the plan (or answer the planner's questions) before running /build.`,
	},
	{
		name: "build",
		description: "Implement the next steps of a planned task",
		argumentHint: "[slug]",
		body: `Continue implementing task: $ARGUMENTS

1. Find the task. If no slug was given, use the directory under \`${WORKFLOW_TASKS_DIR}/\` whose progress.md has unchecked steps and was updated most recently.
2. Read progress.md. Read plan.md only if progress.md does not say what to do next.
3. Delegate the next steps:
   - Use the implementer subagent for normal steps. Give it several related steps per call instead of one at a time.
   - Use the quick subagent only for a step whose exact change is already specified and small. If it replies "Needs implementer", hand the step to the implementer.
4. After each subagent returns, re-read progress.md.
   - If Status is \`blocked\`, follow /escalate for that task.
   - Limits: at most 2 escalations per step. If a step reaches 2 escalations and is still blocked, stop and ask the user.
5. When every step is checked, run /review for the task.

Do not implement steps yourself and do not re-plan. Report progress to the user in a few lines.`,
	},
	{
		name: "review",
		description: "Independently review a finished task",
		argumentHint: "[slug]",
		body: `Review task: $ARGUMENTS

1. Find the task the same way as /build.
2. Delegate to the reviewer subagent with the slug.
3. Record the reviewer's result under \`## Review\` in progress.md, with the date.
4. On PASS, set Status to \`done\` and tell the user.
5. On FAIL, send only the failing criteria and their evidence to the implementer subagent once, then review again. After 2 failed reviews, set Status to \`blocked\` and ask the user how to proceed.

Never mark the task done without a PASS from the reviewer.`,
	},
	{
		name: "escalate",
		description: "Send a blocked task to the architect subagent",
		argumentHint: "[slug]",
		body: `Escalate task: $ARGUMENTS

1. Find the task the same way as /build, preferring one whose Status is \`blocked\`.
2. Find the newest file in its escalations/ directory without a \`## Resolution\` section.
3. Check the step's escalation count in progress.md. If it is already 2, do not escalate again: stop and ask the user.
4. Increment the step's escalation count in progress.md.
5. Delegate to the architect subagent with the report path. Send only the report path and slug, not the conversation.
6. When the architect returns, continue with /build for the task.`,
	},
];

/**
 * YAML-safe scalar. Descriptions contain ": " and hints start with "[", both of
 * which break or change the meaning of a plain YAML scalar; a JSON string is a
 * valid YAML double-quoted scalar.
 */
function yamlString(value: string): string {
	return JSON.stringify(value);
}

/** Render a subagent as a Claude Code .claude/agents/<name>.md file. */
export function renderSubagent(agent: WorkflowSubagent): string {
	const frontmatter = [
		"---",
		`name: ${agent.name}`,
		`description: ${yamlString(agent.description)}`,
		`model: ${agent.model}`,
		`effort: ${agent.effort}`,
		`maxTurns: ${agent.maxTurns}`,
		...(agent.tools ? [`tools: ${agent.tools.join(", ")}`] : []),
		"---",
	].join("\n");
	return `${frontmatter}\n\n${agent.prompt}\n`;
}

/** Render a command as a Claude Code .claude/commands/<name>.md file. */
export function renderCommand(command: WorkflowCommand): string {
	return `---
description: ${yamlString(command.description)}
argument-hint: ${yamlString(command.argumentHint)}
---

${command.body}
`;
}

function writeIfEmpty(path: string, content: string): boolean {
	if (existsSync(path) && readFileSync(path, "utf8").trim().length > 0) {
		return false;
	}
	writeFileSync(path, content, "utf8");
	return true;
}

/**
 * Write the workflow subagents and commands into `<worktreePath>/.claude/`.
 * Existing non-empty files are left untouched. Returns the paths written,
 * relative to the worktree.
 */
export function writeAgentWorkflowFiles(worktreePath: string): string[] {
	const agentsDir = join(worktreePath, ".claude", "agents");
	const commandsDir = join(worktreePath, ".claude", "commands");
	mkdirSync(agentsDir, { recursive: true });
	mkdirSync(commandsDir, { recursive: true });

	const written: string[] = [];
	for (const agent of WORKFLOW_SUBAGENTS) {
		const rel = join(".claude", "agents", `${agent.name}.md`);
		if (writeIfEmpty(join(worktreePath, rel), renderSubagent(agent))) {
			written.push(rel);
		}
	}
	for (const command of WORKFLOW_COMMANDS) {
		const rel = join(".claude", "commands", `${command.name}.md`);
		if (writeIfEmpty(join(worktreePath, rel), renderCommand(command))) {
			written.push(rel);
		}
	}
	return written;
}
