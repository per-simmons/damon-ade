import {
	ESCALATION_RULE,
	fillTasksDir,
	WORKFLOW_SUBAGENTS,
} from "./agent-workflow";
import type { TaskRecord, TaskStage } from "./tasks";

/**
 * The prompt for each stage session ADE launches. A stage runs directly on its
 * role's model (no coordinator in between). With `canDelegate` (Claude Code,
 * which has the workflow roles as subagents), handoffs happen inside the
 * session: blocked steps go to the architect, finished work to the reviewer.
 * Without it (Codex), the session stops and ADE offers the next stage.
 */

export const MAX_ESCALATIONS_PER_STEP = 2;
export const MAX_REVIEW_ROUNDS = 2;

export interface StagePromptInput {
	stage: TaskStage;
	task: TaskRecord;
	/** The project's task folder (forward slashes). */
	tasksDir: string;
	canDelegate: boolean;
}

function roleBody(name: string, tasksDir: string, slug: string): string {
	const role = WORKFLOW_SUBAGENTS.find((agent) => agent.name === name);
	if (!role) throw new Error(`Unknown role ${name}`);
	return fillTasksDir(role.prompt, tasksDir).replaceAll("<slug>", slug);
}

function escalationHandoff(
	tasksDir: string,
	slug: string,
	canDelegate: boolean,
): string {
	const rule = fillTasksDir(ESCALATION_RULE, tasksDir).replaceAll(
		"<slug>",
		slug,
	);
	return canDelegate
		? `## Escalation
${rule}
3. Then hand the report to the \`architect\` subagent (pass only the report path), apply its resolution, and continue. At most ${MAX_ESCALATIONS_PER_STEP} escalations per step: count them in progress.md. If a step is still blocked after that, stop and say so; the user decides in ADE.`
		: `## Escalation
${rule}
3. Then stop. The user escalates from ADE.`;
}

function reviewHandoff(dir: string, canDelegate: boolean): string {
	return canDelegate
		? `## Review
When the work is done, ask the \`reviewer\` subagent to review task \`${dir}\`. Record its result under \`## Review\` in progress.md. On FAIL, fix only the failing criteria and ask for one more review; after ${MAX_REVIEW_ROUNDS} failed reviews, set Status to \`blocked\` and stop. Set Status to \`done\` only after a PASS.`
		: `## Review
When the work is done, set Status to \`ready for review\` in progress.md and stop. The user starts the review from ADE.`;
}

export function stagePrompt({
	stage,
	task,
	tasksDir,
	canDelegate,
}: StagePromptInput): string {
	const dir = `${tasksDir}/${task.slug}`;
	const header = `ADE task "${task.title}" (${task.slug}).
Task folder: ${dir}
The task description is in ${dir}/task.md. Write progress only inside the task folder; do not create workflow files in the repository.`;

	switch (stage) {
		case "quick":
			return `${header}

${roleBody("quick", tasksDir, task.slug)}

## The change
${task.description}

When finished, write ${dir}/progress.md with \`Status: done\` (or \`Status: blocked\` and the reason).${
				canDelegate
					? ` If you replied "Needs implementer", hand the task to the \`implementer\` subagent with the task folder path instead of stopping.`
					: ""
			}`;

		case "implement":
			return `${header}

Implement this task directly. It was judged focused enough to need no separate plan.

## The task
${task.description}

## Process
1. Read only the code the change needs: search first, then open the relevant files.
2. Make the change and run the relevant checks (typecheck, lint and tests for what you touched).
3. Keep ${dir}/progress.md current: \`Status: in progress\`, what you changed, and the checks you ran with their results.
4. Never report a check as passing unless you ran it and it passed.

${escalationHandoff(tasksDir, task.slug, canDelegate)}

${reviewHandoff(dir, canDelegate)}`;

		case "plan":
			return `${header}

${roleBody("planner", tasksDir, task.slug)}

When plan.md and progress.md are written, stop. The user reviews the plan and starts the build from ADE.`;

		case "build":
			return `${header}

${roleBody("implementer", tasksDir, task.slug)}

Do every remaining step of ${dir}/plan.md in order, updating progress.md after each.

${escalationHandoff(tasksDir, task.slug, canDelegate)}

${reviewHandoff(dir, canDelegate)}`;

		case "review":
			return `${header}

${roleBody("reviewer", tasksDir, task.slug)}

Exception to the read-only rule: record your result, with today's date, under \`## Review\` in ${dir}/progress.md, and set Status to \`done\` on PASS or \`changes requested\` on FAIL.`;

		case "escalate":
			return `${header}

${roleBody("architect", tasksDir, task.slug)}

Resolve the newest report in ${dir}/escalations/ that has no \`## Resolution\` section yet. When done, stop; the user continues the build from ADE.`;
	}
}
