import {
	adeRoleName,
	ESCALATION_RULE,
	fillTasksDir,
	WORKFLOW_SUBAGENTS,
} from "./agent-workflow";
import type { TaskChanges } from "./identity";
import type { ModelStage, TaskRecord } from "./tasks";

/**
 * The prompt for each managed stage run. ADE decides every transition (plan,
 * build, checks, review, corrections, escalation) and bounds them in the task
 * record, so prompts never ask the user to start the next stage and never
 * rely on the model to count retries. Each run gets only what it needs: the
 * task folder, the check commands ADE will run, and for fixes and reviews the
 * exact failures and the task's own changed files.
 */

export const VERDICT_PATTERN = /^\s*`?VERDICT:\s*(PASS|FAIL)`?\s*$/gim;

export interface StagePromptInput {
	stage: ModelStage;
	task: TaskRecord;
	/** The project's task folder (forward slashes). */
	tasksDir: string;
	/** Commands ADE runs after implementation. */
	checks: string[];
	/** Whether the run may run those commands itself. */
	mayRunChecks: boolean;
	/** For fix runs: what failed. */
	feedback?: string;
	/** For reviews: the task's own changes. */
	changes?: TaskChanges;
	/** For escalations: the report to resolve. */
	escalationReport?: string;
}

function roleBody(name: string, tasksDir: string, slug: string): string {
	const role = WORKFLOW_SUBAGENTS.find((agent) => agent.name === name);
	if (!role) throw new Error(`Unknown role ${name}`);
	return fillTasksDir(role.prompt, tasksDir).replaceAll("<slug>", slug);
}

function checksNote(input: StagePromptInput): string {
	if (input.checks.length === 0) {
		return "No check commands are configured for this project; an independent reviewer checks the work.";
	}
	const list = input.checks.map((command) => `- \`${command}\``).join("\n");
	return input.mayRunChecks
		? `When you finish, ADE runs these checks itself; you may also run them while you work (they are allowed):\n${list}`
		: `When you finish, ADE runs these checks itself (you cannot run shell commands in this run):\n${list}`;
}

const STOP = "When you are done, stop. ADE runs the next step.";

export function stagePrompt(input: StagePromptInput): string {
	const { stage, task, tasksDir } = input;
	const dir = `${tasksDir}/${task.slug}`;
	const header = `ADE task "${task.title}" (${task.slug}).
Task folder: ${dir}
The task description is in ${dir}/task.md. Write progress only inside the task folder; do not create workflow files in the repository.`;
	const rule = fillTasksDir(ESCALATION_RULE, tasksDir).replaceAll(
		"<slug>",
		task.slug,
	);

	switch (stage) {
		case "quick":
			return `${header}

${roleBody("quick", tasksDir, task.slug)}

## The change
${task.description}

${checksNote(input)}

When finished, write ${dir}/progress.md with \`Status: implemented\` and what you changed. ${STOP}`;

		case "implement":
			return `${header}

Implement this task directly. It was judged focused enough to need no separate plan.

## The task
${task.description}

## Process
1. Read only the code the change needs: search first, then open the relevant files.
2. Make the change.
3. Keep ${dir}/progress.md current: \`Status: implemented\` when you are done, what you changed, and anything the reviewer should know.

${checksNote(input)}

${rule}
3. Then stop. ADE escalates.

${STOP}`;

		case "plan":
			return `${header}

${roleBody("planner", tasksDir, task.slug)}

The project's checks (ADE runs these after implementation; refer to them under Validation commands):
${input.checks.length ? input.checks.map((c) => `- \`${c}\``).join("\n") : "- none configured"}

${STOP}`;

		case "build":
			return `${header}

${roleBody("implementer", tasksDir, task.slug)}

Do every remaining step of ${dir}/plan.md in order, updating progress.md after each. When every step is done, set Status to \`implemented\`.

${checksNote(input)}

If you get blocked, follow the escalation rule above and stop; ADE escalates and then resumes the build. ${STOP}`;

		case "fix":
			return `${header}

You are correcting this task's implementation. Fix only what is listed below; do not redo work that passed.

## What failed
${input.feedback ?? "(no details recorded)"}

Read ${dir}/progress.md${task.route === "plan" || task.route === "exceptional" ? ` and ${dir}/plan.md` : ""} for context. Update progress.md with what you changed and set Status to \`implemented\`.

${checksNote(input)}

${rule}
3. Then stop. ADE escalates.

${STOP}`;

		case "review": {
			const changes = input.changes;
			const changed = changes?.tracked
				? changes.files.length
					? changes.files.map((f) => `- ${f}`).join("\n")
					: "- (no file changes found)"
				: "- (not a git repository: review the files the task describes)";
			const preexisting = changes?.preexisting.length
				? `\n\nThese files were already changed before the task started; ignore their pre-existing edits:\n${changes.preexisting.map((f) => `- ${f}`).join("\n")}`
				: "";
			return `${header}

${roleBody("reviewer", tasksDir, task.slug)}

## This task's changes
${changed}${preexisting}

Use \`git diff\` on those files. ${input.mayRunChecks && input.checks.length ? "You may run the project's checks." : "ADE has already run the project's checks."}

End your reply with exactly one line: \`VERDICT: PASS\` or \`VERDICT: FAIL\`. Any FAIL criterion means FAIL.`;
		}

		case "escalate":
			return `${header}

${roleBody("architect", tasksDir, task.slug)}

Resolve this escalation report: ${input.escalationReport ?? `the newest report in ${dir}/escalations/ without a Resolution`}.

${STOP}`;
	}
}

/** The reviewer's verdict: the last VERDICT line of its final text. */
export function parseVerdict(
	text: string | undefined,
): "PASS" | "FAIL" | undefined {
	const matches = [...(text ?? "").matchAll(VERDICT_PATTERN)];
	const last = matches[matches.length - 1];
	return last ? (last[1].toUpperCase() as "PASS" | "FAIL") : undefined;
}

export { adeRoleName };
