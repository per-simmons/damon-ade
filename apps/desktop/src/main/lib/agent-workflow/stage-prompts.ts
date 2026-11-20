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
	/** For the pathway choice: the team's specialists and the budget left. */
	triage?: {
		specialists: Array<{ name: string; specialty: string; agent?: string }>;
		remainingUsd: number;
	};
	/** For a custom role: what it is and what it must return. */
	customRole?: {
		name: string;
		description: string;
		instructions: string;
		access: "read-only" | "edit";
		expectedOutput: string;
	};
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

		case "split": {
			const specialists = input.triage?.specialists ?? [];
			if (task.chat?.length) {
				const team = specialists.length
					? specialists
							.map(
								(s) =>
									`- "${s.name}" (${s.specialty})${s.agent ? `, done by the agent "${s.agent}"` : ""}`,
							)
							.join("\n")
					: "- none (every subtask uses the default workflow)";
				const conversation = task.chat
					.map((m) =>
						m.role === "user"
							? `**User:** ${m.text}`
							: `**You (Coordinator):** ${m.text}${m.plan ? `\n[Your plan then: ${m.plan.subtasks.map((s, i) => `${i + 1}. ${s.title} (${s.specialist ?? "none"}, ${s.route})`).join("; ")}]` : ""}`,
					)
					.join("\n\n");
				return `${header}

You are the Coordinator of this team, talking with the user in the team chat. You plan the work with them; the team's specialists do it after the user presses Go. You do not edit files.

## The team's specialists
${team}

## The conversation so far
${conversation}

## Your reply
- Answer the user's latest message in a few short sentences, in plain words, as in a chat.
- Look at the code only as much as you need to plan well (search first; read only what you need).
- If something important is unclear (what they want, where it belongs, a choice only they can make), ask at most two short questions instead of planning yet.
- Otherwise propose a plan, or revise your last plan from what they said. A plan has 1 to 6 self-contained subtasks; one is fine for small work. Each has a short title, a description another engineer could do alone (what to change, interfaces it uses or provides, how to know it is done), the best specialist by name (or "none"), a route ("quick", "implement", "plan", "exceptional"), models per role (haiku only for trivial low-risk work, sonnet for normal work, opus for planning or reviewing difficult or risky work, fable only for exceptional architecture; risky work such as authentication, permissions, secrets, payments, data migrations or messaging people is never "quick"), and "dependsOn": the numbers (from 1) of earlier subtasks whose work it needs, or []. Independent subtasks run at the same time on their agents.
- When you propose or change a plan, say in a sentence or two what it does, then end with one JSON block exactly like this (the user sees it as a plan with a Go button):
\`\`\`json
{"subtasks": [{"title": "Email API", "description": "...", "specialist": "Backend", "route": "plan", "models": {"planner": "opus", "implementer": "sonnet", "reviewer": "sonnet"}, "dependsOn": []}], "reason": "one sentence"}
\`\`\`
- When the plan does not change, leave the JSON out. Never start the work yourself.`;
			}
			return `${header}

You are the Coordinator. Split this request into a few self-contained subtasks, each owned by one specialist. You do not do the work.

## The request
${task.description}

## The team's specialists
${specialists.length ? specialists.map((s) => `- "${s.name}" (${s.specialty})${s.agent ? `, done by the agent "${s.agent}"` : ""}`).join("\n") : "- none (every subtask uses the default workflow; split only if it helps)"}

## How to split
- Look briefly at the code the request touches (search first; read only what you need).
- Make between 1 and 6 subtasks. One subtask is fine when the request is small or belongs to one specialty; do not split for its own sake.
- Order them so each one's dependencies come first (for example the API before the screen that calls it).
- Give each subtask "dependsOn": the numbers (counting from 1) of the earlier subtasks whose work it needs, or [] if it needs none. Each specialist's agent works in its own copy of the repository; independent subtasks run at the same time, and a subtask starts with the work of the ones it depends on merged in.
- Give each a short title and a description another engineer could do alone: what to change, the interfaces it must use or provide, and how to know it is done.
- Assign each to the best specialist by name, or "none".
- Choose each subtask's route ("quick", "implement", "plan", "exceptional") and models per role, as cheaply as is reliable: haiku only for trivial low-risk work, sonnet for normal work, opus for planning or reviewing difficult or risky work, fable only for exceptional architecture. Risky work (authentication, permissions, secrets, payments, data migrations, sending messages to people) is never "quick".

## Return
Do not edit any file. End your reply with one JSON block exactly like this:
\`\`\`json
{"subtasks": [{"title": "Email API", "description": "...", "specialist": "Backend", "route": "plan", "models": {"planner": "opus", "implementer": "sonnet", "reviewer": "sonnet"}, "dependsOn": []}, {"title": "Email button", "description": "...", "specialist": "Frontend", "route": "implement", "models": {"implementer": "sonnet", "reviewer": "sonnet"}, "dependsOn": [1]}], "reason": "one sentence"}
\`\`\``;
		}

		case "triage": {
			const specialists = input.triage?.specialists ?? [];
			return `${header}

You choose the most economical pathway that will reliably get this task done. You do not do the task.

## The task
${task.description}

## How to decide
Look at the request and, briefly, at the code it touches (search first; read only what you need; at most a few files). Then choose:
- route: "quick" (a small, fully specified, low-risk change: one model, no plan), "implement" (a focused change that needs no separate plan), "plan" (a feature or change with design decisions, several parts, external services, credentials or data changes: a planner writes a plan first, then it is built, checked and reviewed), or "exceptional" (a hard architecture problem: Fable plans).
- models: the model for each role this task will use. Costs per million output tokens, roughly: haiku $5, sonnet $15, opus $20, fable $40. Use haiku only for trivial low-risk work; sonnet for normal implementation and review; opus for planning or reviewing difficult or high-risk work (security, data, money, concurrency); fable only for exceptional architecture. ADE escalates to the architect by itself if implementation gets stuck, so you do not need fable for that.
- specialist: ${specialists.length ? `one of ${specialists.map((s) => `"${s.name}" (${s.specialty})`).join(", ")}, or "none"` : `"none" (this team has no specialists)`}.

Risk matters more than size: authentication, permissions, secrets, payments, data migrations and anything that sends messages or emails to people are never "quick". About $${(input.triage?.remainingUsd ?? 0).toFixed(2)} of the task's budget is left.

## Return
Do not edit any file. End your reply with one JSON block exactly like this:
\`\`\`json
{"route": "plan", "models": {"planner": "opus", "implementer": "sonnet", "reviewer": "sonnet"}, "specialist": "none", "reason": "one sentence"}
\`\`\``;
		}

		case "custom": {
			const role = input.customRole;
			if (!role) throw new Error("A custom role run needs its role");
			const sofar = input.changes;
			const fileList = sofar?.files.map((f) => `- ${f}`).join("\n") ?? "";
			const changed =
				sofar?.tracked && sofar.files.length
					? `\n\n## This task's changes so far\n${fileList}\nUse \`git diff\` on those files.`
					: "";
			const access =
				role.access === "read-only"
					? "You may read the code and run read-only commands. Do not edit any file."
					: `You may edit files. Record what you changed in ${dir}/progress.md.`;
			const verdict =
				role.access === "read-only"
					? "\n\nEnd your reply with exactly one line: `VERDICT: PASS` or `VERDICT: FAIL`."
					: "";
			return `${header}

You are the ${role.name} for this task.${role.description ? ` ${role.description}` : ""}

## The task
${task.description}

## Your instructions
${role.instructions}

${access}${changed}

## Return
${role.expectedOutput}${verdict}

${STOP}`;
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
