import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	HISTORY_FILE,
	readTaskHistory,
} from "main/lib/project-history/task-history";
import { checksPassed, loadProjectChecks } from "./checks";
import {
	branchChange,
	codeState,
	currentBranch,
	taskChanges,
} from "./identity";
import { cheaperFallback, resolveRunModel } from "./models";
import { type ProjectWorkflow, portablePath } from "./project-workflow";
import {
	applicableCustomRoles,
	type CustomRole,
	listSpecialists,
	type ResolvedSpecialist,
	resolveRole,
	resolveSpecialist,
	type Specialist,
} from "./specialists";
import { parseVerdict, stagePrompt } from "./stage-prompts";
import type {
	PermissionMode,
	StageProgress,
	StageRunHandle,
	StageRunResult,
	StageRunSpec,
} from "./stage-runner";
import {
	activeRun,
	type CheckResult,
	getTask,
	type ModelStage,
	type RunKind,
	readTaskFiles,
	saveTask,
	type TaskFiles,
	type TaskIdentity,
	type TaskLimits,
	type TaskRecord,
	type TaskRun,
	withTaskLock,
} from "./tasks";
import { applyTriage, parseTriage, TRIAGE_ROUTING } from "./triage";
import type { RoleName, WorkflowSettings } from "./workflow-settings";

/**
 * The app-owned stage controller. A deterministic state machine decides each
 * next step from the task record (runs and their outcomes), the files the
 * agents wrote, the approved checks and the limits. Model runs are child
 * processes ADE starts and watches; checks are commands ADE runs itself.
 *
 * Auto mode advances after every run until the task is verified done, or
 * stops for a real reason: a question only the user can answer, a failure it
 * may not retry, an exhausted limit or budget, or Pause/Cancel. Manual mode
 * runs one requested step at a time, with the same prerequisites and lock.
 *
 * Done means: the approved checks passed after the last change, and an
 * independent review run returned PASS (quick tasks with passing checks skip
 * the review; without checks, every task needs the review).
 */

const IMPLEMENTATION_KINDS: RunKind[] = ["quick", "implement", "build", "fix"];

export const STAGE_ROLE: Record<
	Exclude<ModelStage, "custom" | "triage">,
	RoleName
> = {
	quick: "quick",
	implement: "implementer",
	plan: "planner",
	build: "implementer",
	fix: "implementer",
	review: "reviewer",
	escalate: "architect",
};

const READ_ONLY_GIT = [
	"Bash(git diff:*)",
	"Bash(git status:*)",
	"Bash(git log:*)",
	"Bash(git show:*)",
];

export type Decision =
	| { type: "wait" }
	| { type: "none" }
	| {
			type: "run";
			kind: ModelStage;
			fallbackFrom?: string;
			/** For kind "custom": which custom role. */
			customRoleId?: string;
			reason: string;
	  }
	| { type: "checks"; reason: string }
	| { type: "done"; reason: string }
	| { type: "pause"; reason: string }
	| { type: "needs-input"; reason: string }
	| { type: "block"; reason: string }
	| { type: "reroute"; route: "implement"; reason: string };

export interface ApprovedChecks {
	commands: string[];
}

export interface TaskSpend {
	/** Known spend: Claude Code's reported cost, else ADE's estimate. */
	usd: number;
	/**
	 * The most the task may have spent: runs whose cost is uncertain count at
	 * their spending cap (or their estimate, if higher). Budget decisions use
	 * this, never `usd`, so an unknown cost is never treated as zero.
	 */
	worstCaseUsd: number;
	/** Runs still in progress (their cost is still growing). */
	pendingRuns: number;
	/** Finished runs with no usage at all: their cost is unknown. */
	unknownRuns: number;
	/** Runs where some responses could not be priced: the total is low. */
	partialRuns: number;
	/** Runs whose cost is not reported (unknown, partial, cut short, running). */
	uncertainRuns: number;
	/** Uncertain runs without a recorded cap (from before ADE set one). */
	unboundedRuns: number;
}

/** What a task's model runs have cost, each run counted once. */
export function taskSpend(task: TaskRecord): TaskSpend {
	const spend: TaskSpend = {
		usd: 0,
		worstCaseUsd: 0,
		pendingRuns: 0,
		unknownRuns: 0,
		partialRuns: 0,
		uncertainRuns: 0,
		unboundedRuns: 0,
	};
	for (const run of task.runs) {
		if (run.kind === "checks" || run.status === "queued") continue;
		// A run that never started spent nothing.
		if (run.failure === "launch" && run.liveCostUsd === undefined) continue;
		if (run.status === "running") spend.pendingRuns++;
		const known = run.reportedCostUsd ?? run.liveCostUsd ?? 0;
		spend.usd += known;
		if (run.costState === "partial") spend.partialRuns++;
		const certain =
			run.reportedCostUsd !== undefined ||
			(run.status === "succeeded" && run.costState === "estimated");
		if (certain) {
			spend.worstCaseUsd += known;
			continue;
		}
		spend.uncertainRuns++;
		if (
			run.status !== "running" &&
			run.reportedCostUsd === undefined &&
			run.liveCostUsd === undefined
		) {
			spend.unknownRuns++;
		}
		if (run.maxBudgetUsd === undefined) {
			spend.unboundedRuns++;
			spend.worstCaseUsd += known;
		} else {
			spend.worstCaseUsd += Math.max(known, run.maxBudgetUsd);
		}
	}
	return spend;
}

const NEEDS_IMPLEMENTER = /Needs implementer/i;

/** A quick run that found the change is too big did not implement it. */
function needsImplementer(run: TaskRun): boolean {
	return run.kind === "quick" && NEEDS_IMPLEMENTER.test(run.summary ?? "");
}

/** A succeeded run that implemented (part of) the task. */
function isImplementation(run: TaskRun): boolean {
	return (
		(IMPLEMENTATION_KINDS.includes(run.kind) ||
			(run.kind === "custom" && run.customAccess === "edit")) &&
		run.status === "succeeded" &&
		!needsImplementer(run)
	);
}

/**
 * The runs that count as evidence: those since the task's last move. Earlier
 * runs stay in the record (and in the spend) as history.
 */
export function evidenceView(task: TaskRecord): TaskRecord {
	const start = task.evidenceStart ?? 0;
	return start > 0 ? { ...task, runs: task.runs.slice(start) } : task;
}

function lastIndex(task: TaskRecord, test: (run: TaskRun) => boolean): number {
	for (let i = task.runs.length - 1; i >= 0; i--) {
		if (test(task.runs[i])) return i;
	}
	return -1;
}

const count = (task: TaskRecord, kind: RunKind) =>
	task.runs.filter((run) => run.kind === kind && run.status !== "queued")
		.length;

const sameCommands = (a: string[] | undefined, b: string[]) =>
	!!a && a.length === b.length && a.every((command, i) => command === b[i]);

/** What ADE observed about the worktree just before deciding. */
/** A custom role the manager may schedule for this task. */
export interface CustomRoleRef {
	id: string;
	name: string;
	access: "read-only" | "edit";
}

export interface DecisionContext {
	/** identity.ts codeState of the task's worktree now (undefined: not git). */
	codeState?: string;
	/**
	 * The specialist's custom roles that apply to this task (trigger and
	 * keywords already matched): before the first implementation, and after
	 * implementation and passing checks (before the review).
	 */
	customRoles?: { before: CustomRoleRef[]; after: CustomRoleRef[] };
}

/**
 * The next step, decided from recorded facts only. Pure: no I/O, so every
 * transition is unit-testable.
 */
export function decideNext(
	task: TaskRecord,
	files: TaskFiles,
	checks: ApprovedChecks,
	settings: Pick<WorkflowSettings, "execution">,
	context: DecisionContext = {},
): Decision {
	if (activeRun(task)) return { type: "wait" };
	if (task.state === "done" || task.state === "cancelled")
		return { type: "none" };

	// Budget: over all runs, history included, at their worst case.
	const spend = taskSpend(task);
	if (spend.unboundedRuns > 0) {
		return {
			type: "block",
			reason: `${spend.unboundedRuns} earlier run(s) have no recorded cost or cap, so ADE cannot tell how much of the budget is left. Continue in Manual mode.`,
		};
	}
	if (spend.worstCaseUsd >= task.limits.budgetUsd) {
		return {
			type: "block",
			reason:
				spend.uncertainRuns > 0
					? `The task's budget of $${task.limits.budgetUsd.toFixed(2)} may be used up: $${spend.usd.toFixed(2)} known, up to $${spend.worstCaseUsd.toFixed(2)} counting ${spend.uncertainRuns} run(s) of uncertain cost at their cap.`
					: `The task's budget of $${task.limits.budgetUsd.toFixed(2)} is used up ($${spend.usd.toFixed(2)} estimated).`,
		};
	}

	// Everything else: only the runs since the last move.
	const t = evidenceView(task);

	// A failed last run decides first, unless the user resumed past it.
	const last = t.runs[t.runs.length - 1];
	if (
		last &&
		last.status !== "succeeded" &&
		last.id !== task.acknowledgedRunId
	) {
		const kind = last.kind;
		switch (last.failure) {
			case "model-unavailable": {
				const fallback =
					kind !== "checks" &&
					settings.execution.cheaperFallback &&
					!last.fallbackFrom &&
					last.model
						? cheaperFallback(last.model)
						: undefined;
				if (fallback && kind !== "checks") {
					return {
						type: "run",
						kind,
						customRoleId: last.customRoleId,
						fallbackFrom: last.model,
						reason: `${last.model} is unavailable; trying the cheaper ${fallback} once`,
					};
				}
				return {
					type: "block",
					reason: `${last.model ?? "The model"} is unavailable for this account or provider.`,
				};
			}
			case "rate-limited":
				return {
					type: "pause",
					reason: "Rate limited. Resume when the limit resets.",
				};
			case "auth":
				return {
					type: "block",
					reason:
						"Claude Code is not signed in or not authorized for this model.",
				};
			case "budget":
				return { type: "block", reason: "The run hit its spending cap." };
			case "max-turns":
				return {
					type: "block",
					reason: `The ${kind} run hit its turn limit. Raise the limit or narrow the task, then resume.`,
				};
			case "cancelled":
				return { type: "none" };
			case "interrupted":
				return {
					type: "pause",
					reason: "ADE stopped while this ran. Check the work, then resume.",
				};
			case "launch":
				return {
					type: "block",
					reason: `The ${kind} run could not start: ${last.error ?? ""}`.trim(),
				};
			default:
				return {
					type: "block",
					reason: `The ${kind} run failed: ${(last.error ?? "unknown error").slice(0, 300)}`,
				};
		}
	}

	// "Chosen by AI": one short triage run picks the pathway first.
	if (task.routeBy === "ai" && !task.triage) {
		return {
			type: "run",
			kind: "triage",
			reason: "choose the pathway and models",
		};
	}

	// Routing for quick tasks that turned out not to be small: the quick run
	// changed nothing that counts, so the implementer runs next.
	const lastQuick = lastIndex(
		t,
		(run) => run.kind === "quick" && run.status === "succeeded",
	);
	if (
		task.route === "quick" &&
		lastQuick >= 0 &&
		needsImplementer(t.runs[lastQuick])
	) {
		return {
			type: "reroute",
			route: "implement",
			reason: "the quick run found the change is not small",
		};
	}

	const limits = task.limits;
	const lastImpl = lastIndex(t, isImplementation);

	// Plan first for planned routes.
	const planned = task.route === "plan" || task.route === "exceptional";
	if (planned) {
		const planRun = lastIndex(
			task,
			(run) => run.kind === "plan" && run.status === "succeeded",
		);
		if (!files.hasPlan) {
			if (planRun >= 0) {
				return {
					type: "block",
					reason: "The planner finished without writing plan.md.",
				};
			}
			return { type: "run", kind: "plan", reason: "complex task: plan first" };
		}
		if (files.planQuestions.length > 0 && !task.answers) {
			return {
				type: "needs-input",
				reason: `The plan needs your decision: ${files.planQuestions.join("; ")}`,
			};
		}
	}

	if (lastImpl < 0) {
		// The specialist's roles that run before implementation, once each.
		for (const role of context.customRoles?.before ?? []) {
			const ran = t.runs.some(
				(run) =>
					run.kind === "custom" &&
					run.customRoleId === role.id &&
					run.status === "succeeded",
			);
			if (!ran) {
				return {
					type: "run",
					kind: "custom",
					customRoleId: role.id,
					reason: `${role.name} before implementation`,
				};
			}
		}
		const first: ModelStage =
			task.route === "quick"
				? "quick"
				: task.route === "implement"
					? "implement"
					: "build";
		return {
			type: "run",
			kind: first,
			reason: task.evidenceStart
				? "reconcile the work in this worktree"
				: "implement the task",
		};
	}

	// Escalation: an open report after the last implementation run.
	if (files.openEscalations.length > 0) {
		if (count(t, "escalate") >= limits.maxEscalations) {
			return {
				type: "block",
				reason: `Still blocked after ${limits.maxEscalations} escalation(s): ${files.openEscalations.join(", ")}`,
			};
		}
		return {
			type: "run",
			kind: "escalate",
			reason: `blocked: ${files.openEscalations[0]}`,
		};
	}
	const lastEscalate = lastIndex(
		t,
		(run) => run.kind === "escalate" && run.status === "succeeded",
	);
	if (lastEscalate > lastImpl) {
		return {
			type: "run",
			kind: planned ? "build" : "fix",
			reason: "continue after the escalation was resolved",
		};
	}
	if (
		/^blocked\b/i.test(files.progressStatus ?? "") &&
		lastEscalate < lastImpl
	) {
		return {
			type: "needs-input",
			reason:
				"The implementation reports it is blocked but wrote no escalation report.",
		};
	}

	const corrections = count(t, "fix");
	const correctOrBlock = (what: string, feedbackReason: string): Decision =>
		corrections >= limits.maxCorrections
			? {
					type: "block",
					reason: `${what} after ${limits.maxCorrections} correction(s).`,
				}
			: { type: "run", kind: "fix", reason: feedbackReason };

	// Evidence counts only for the code it ran on.
	const current = context.codeState;
	const fresh = (run: TaskRun) =>
		current === undefined || run.codeState === current;

	// Checks after the last change: the exact approved commands, on this code.
	if (checks.commands.length > 0) {
		const lastChecks = lastIndex(
			t,
			(run) => run.kind === "checks" && run.status === "succeeded",
		);
		if (lastChecks < lastImpl)
			return { type: "checks", reason: "verify the change" };
		const run = t.runs[lastChecks];
		if (!sameCommands(run.commands, checks.commands)) {
			return { type: "checks", reason: "the approved checks changed" };
		}
		if (!fresh(run)) {
			const reruns = t.runs
				.slice(lastImpl + 1)
				.filter((r) => r.kind === "checks" && r.status === "succeeded").length;
			if (reruns >= 3) {
				return {
					type: "block",
					reason:
						"The code keeps changing while the checks run (do the checks write files git does not ignore?).",
				};
			}
			return {
				type: "checks",
				reason: "the code changed since the checks ran",
			};
		}
		if (!checksPassed(run.checks ?? [], checks.commands.length)) {
			return correctOrBlock("Checks still fail", "checks failed");
		}
		if (task.route === "quick") {
			return { type: "done", reason: "small change; the checks passed" };
		}
	}

	// The specialist's read-only roles after implementation and checks.
	for (const role of context.customRoles?.after ?? []) {
		const last = lastIndex(
			t,
			(run) =>
				run.kind === "custom" &&
				run.customRoleId === role.id &&
				run.status === "succeeded",
		);
		if (last < lastImpl || !fresh(t.runs[last])) {
			const rounds = t.runs.filter(
				(run) => run.kind === "custom" && run.customRoleId === role.id,
			).length;
			if (rounds >= limits.maxReviewRounds) {
				return {
					type: "block",
					reason: `${role.name} has not passed after ${limits.maxReviewRounds} round(s).`,
				};
			}
			return {
				type: "run",
				kind: "custom",
				customRoleId: role.id,
				reason: `${role.name} after implementation`,
			};
		}
		const verdict = t.runs[last].verdict;
		if (verdict === undefined) {
			return {
				type: "block",
				reason: `${role.name} finished without a verdict.`,
			};
		}
		if (verdict === "FAIL") {
			return correctOrBlock(
				`${role.name} still fails`,
				`${role.name} found problems`,
			);
		}
	}

	// Independent review after the last change, of this code.
	const lastReview = lastIndex(
		t,
		(run) => run.kind === "review" && run.status === "succeeded",
	);
	if (lastReview < lastImpl || !fresh(t.runs[lastReview])) {
		if (count(t, "review") >= limits.maxReviewRounds) {
			return {
				type: "block",
				reason: `No passing review after ${limits.maxReviewRounds} review round(s).`,
			};
		}
		return {
			type: "run",
			kind: "review",
			reason:
				lastReview < lastImpl
					? "independent review"
					: "the code changed since the review",
		};
	}
	const verdict = t.runs[lastReview].verdict;
	if (verdict === "PASS") {
		return {
			type: "done",
			reason:
				checks.commands.length > 0
					? "the checks passed and the review passed"
					: "the review passed (no checks configured)",
		};
	}
	if (verdict === undefined) {
		return { type: "block", reason: "The review finished without a verdict." };
	}
	return correctOrBlock("The review still fails", "the review failed");
}

/** Feedback for a fix run: the failing checks and/or the failed review. */
export function correctionFeedback(task: TaskRecord): string {
	const parts: string[] = [];
	const lastChecks = [...task.runs]
		.reverse()
		.find((run) => run.kind === "checks");
	for (const check of lastChecks?.checks ?? []) {
		if (check.exitCode !== 0 || check.timedOut) {
			parts.push(
				`Check \`${check.command}\` ${check.timedOut ? "timed out" : `failed (exit ${check.exitCode})`}:\n\`\`\`\n${check.outputTail.slice(-2500)}\n\`\`\``,
			);
		}
	}
	const lastReview = [...task.runs]
		.reverse()
		.find((run) => run.kind === "review");
	if (lastReview?.verdict === "FAIL") {
		parts.push(
			`The independent review failed:\n${(lastReview.summary ?? "").slice(-3000)}`,
		);
	}
	const latestCustom = new Map<string, TaskRun>();
	for (const run of task.runs) {
		if (run.kind === "custom" && run.customRoleId) {
			latestCustom.set(run.customRoleId, run);
		}
	}
	for (const run of latestCustom.values()) {
		if (run.verdict === "FAIL") {
			parts.push(
				`${run.role ?? "A specialist role"} found problems:\n${(run.summary ?? "").slice(-3000)}`,
			);
		}
	}
	return parts.join("\n\n") || "(no failure details recorded)";
}

export interface TaskSpecialists {
	primary?: ResolvedSpecialist;
	supporting: ResolvedSpecialist[];
}

/** The task's specialists, resolved with the task's own role overrides. */
export function taskSpecialists(
	homeDir: string,
	project: ProjectWorkflow,
	task: TaskRecord,
	settings: Pick<WorkflowSettings, "roles">,
): TaskSpecialists {
	const all = listSpecialists(project);
	const byId = (id: string | undefined) => all.find((s) => s.id === id);
	const primary = byId(task.specialistId);
	return {
		primary: primary
			? resolveSpecialist(primary, settings, homeDir, task.roleOverrides)
			: undefined,
		supporting: (task.supportingSpecialistIds ?? [])
			.map(byId)
			.filter((s): s is Specialist => !!s)
			.map((s) => resolveSpecialist(s, settings, homeDir)),
	};
}

/** The custom roles the manager schedules for this task. */
export function customRoleContext(
	specialists: TaskSpecialists,
	task: TaskRecord,
	/** Files the task has changed so far (for after-implementation roles). */
	changedFiles: string[] = [],
): NonNullable<DecisionContext["customRoles"]> {
	// A quick change stays quick: no extra roles.
	if (task.route === "quick" || !specialists.primary) {
		return { before: [], after: [] };
	}
	const text = `${task.title}\n${task.description}`;
	const ref = (r: CustomRole): CustomRoleRef => ({
		id: r.id,
		name: r.name,
		access: r.access,
	});
	return {
		before: applicableCustomRoles(
			specialists.primary,
			text,
			"before-implementation",
		).map(ref),
		after: applicableCustomRoles(
			specialists.primary,
			text,
			"after-implementation",
			changedFiles,
		)
			.filter((r) => r.access === "read-only")
			.map(ref),
	};
}

/**
 * The role, model, effort and turn limit a stage runs with: the task's
 * specialist (template, specialist and task layers over the global
 * defaults), or the global defaults with the task's overrides. The runner
 * and the Tasks panel both use this, so the model shown is the one run.
 */
export function stageRouting(
	specialists: TaskSpecialists,
	task: TaskRecord,
	settings: Pick<WorkflowSettings, "roles">,
	kind: ModelStage,
	customRoleId?: string,
) {
	if (kind === "triage") {
		const resolvedRole = resolveRole(
			"reviewer",
			settings,
			undefined,
			undefined,
			undefined,
		);
		return {
			customRole: undefined,
			resolvedRole: { ...resolvedRole, label: "Pathway", instructions: [] },
			routing: {
				role: "Pathway",
				model: TRIAGE_ROUTING.model,
				effort: TRIAGE_ROUTING.effort,
				maxTurns: TRIAGE_ROUTING.maxTurns,
				modelSource: "global" as const,
			},
		};
	}
	const customRole =
		kind === "custom"
			? specialists.primary?.customRoles.find((r) => r.id === customRoleId)
			: undefined;
	if (kind === "custom" && !customRole) {
		throw new Error(
			"That role is not part of this task's specialist any more. Choose another step.",
		);
	}
	// Custom roles inherit from the base role closest to their access.
	const role: RoleName = customRole
		? customRole.access === "read-only"
			? "reviewer"
			: "implementer"
		: kind === "plan" && task.route === "exceptional"
			? "architect"
			: STAGE_ROLE[kind as Exclude<ModelStage, "custom" | "triage">];
	let resolvedRole =
		specialists.primary?.roles[role] ??
		resolveRole(role, settings, undefined, undefined, task.roleOverrides);
	// The Exceptional route is the escalation tier: it plans with the global
	// Architect (Fable by default) unless the user set this specialist's or
	// task's Architect model themselves. A template's ordinary Architect
	// preset does not downgrade it.
	if (
		!customRole &&
		kind === "plan" &&
		task.route === "exceptional" &&
		resolvedRole.source.model === "template"
	) {
		resolvedRole = resolveRole(
			"architect",
			settings,
			undefined,
			undefined,
			task.roleOverrides,
		);
	}
	return {
		customRole,
		resolvedRole,
		routing: {
			role: customRole?.name ?? resolvedRole.label,
			model: customRole?.model ?? resolvedRole.model,
			effort: customRole?.effort ?? resolvedRole.effort,
			maxTurns: customRole?.maxTurns ?? resolvedRole.maxTurns,
			modelSource: customRole?.model
				? ("specialist" as const)
				: resolvedRole.source.model,
		},
	};
}

/** Files the task has changed so far (empty outside git). */
export function changedFilesOf(task: TaskRecord): string[] {
	try {
		return taskChanges(task.identity).files;
	} catch {
		return [];
	}
}

/** The specialty guidance a stage gets (empty without a specialist). */
function specialtyNote(
	specialists: TaskSpecialists,
	task: TaskRecord,
	kind: ModelStage,
	roleInstructions: string[],
): string {
	const parts: string[] = [];
	const primary = specialists.primary;
	if (primary?.instructions && kind !== "custom") {
		parts.push(
			`## Specialty: ${primary.specialist.specialty} (${primary.specialist.name})\n${primary.instructions}`,
		);
	}
	for (const s of specialists.supporting) {
		if (s.instructions && kind !== "quick" && kind !== "custom") {
			parts.push(
				`## Also relevant: ${s.specialist.specialty} (${s.specialist.name})\nThis task also touches this specialty. You are the only one editing; apply this guidance where it applies.\n${s.instructions}`,
			);
		}
	}
	if (roleInstructions.length) {
		parts.push(
			`## Additional instructions for this role\n${roleInstructions.join("\n\n")}`,
		);
	}
	// What the specialist's roles found before implementation.
	if (IMPLEMENTATION_KINDS.includes(kind)) {
		const notes = evidenceView(task)
			.runs.filter(
				(run) =>
					run.kind === "custom" &&
					run.status === "succeeded" &&
					run.customAccess === "read-only" &&
					!!run.summary,
			)
			.slice(-3)
			.map((run) => `### ${run.role}\n${(run.summary ?? "").slice(-2000)}`);
		if (notes.length) {
			parts.push(
				`## Findings from the specialist's roles\n${notes.join("\n\n")}`,
			);
		}
	}
	return parts.length ? `\n\n${parts.join("\n\n")}\n` : "";
}

/**
 * After a move, the first implementation run reconciles: the earlier work
 * may or may not be in this worktree.
 */
function reconcileNote(task: TaskRecord, kind: ModelStage): string {
	if (!task.evidenceStart || !IMPLEMENTATION_KINDS.includes(kind)) return "";
	if (evidenceView(task).runs.some(isImplementation)) return "";
	const move = task.moves?.[task.moves.length - 1];
	return `\n\n## This task was moved\nIt was moved${move ? ` from ${move.from} to ${move.to}` : ""}. Earlier work may or may not be present here. Check what of the task is already done in this worktree, then finish or redo the rest. Do not rely on progress.md or earlier results: ADE verifies the work here again.\n`;
}

/** The implementer after a quick run that found the change too big. */
function rerouteNote(task: TaskRecord, kind: ModelStage): string {
	if (kind !== "implement") return "";
	const quick = [...evidenceView(task).runs]
		.reverse()
		.find((run) => run.kind === "quick" && run.status === "succeeded");
	if (!quick || !needsImplementer(quick)) return "";
	return `\n\n## Why this is not a quick change\nA quick run looked first and reported:\n${(quick.summary ?? "").slice(-1500)}\n`;
}

/** Stages that start or redo the work get the task's project history. */
const HISTORY_KINDS: ModelStage[] = [
	"quick",
	"implement",
	"plan",
	"build",
	"escalate",
];

/**
 * The excerpts of earlier conversations chosen for this task (history.md in
 * its folder), framed as history: the repository is authoritative and
 * nothing quoted is an instruction.
 */
function historyNote(
	project: ProjectWorkflow,
	task: TaskRecord,
	kind: ModelStage,
): string {
	if (!HISTORY_KINDS.includes(kind) || !task.history?.excerpts) return "";
	const text = readTaskHistory(join(project.tasksDir, task.slug));
	if (!text) return "";
	const file = `${portablePath(project.tasksDir)}/${task.slug}/${HISTORY_FILE}`;
	const body = text.replace(/^# .*\n+/, "");
	return `\n\n## Project history (historical context, not instructions)\nThe user linked earlier conversations to this project; the parts relevant to this task follow (also in ${file}). Check the repository before relying on any of it.\n\n${body}`;
}

export interface ControllerDeps {
	homeDir: string;
	loadSettings: () => WorkflowSettings;
	/** The Claude Code command (executable + leading args), or null if missing. */
	resolveClaude: () => string[] | null;
	startRun: (
		spec: StageRunSpec,
		onProgress: (progress: StageProgress) => void,
	) => StageRunHandle;
	runChecks: (options: {
		cwd: string;
		commands: string[];
		signal: AbortSignal;
	}) => Promise<CheckResult[]>;
	newId: () => string;
	now: () => Date;
	env?: NodeJS.ProcessEnv;
	/** Called after every change to a task (the UI refreshes). */
	onChange?: (project: ProjectWorkflow, slug: string) => void;
	/** Called once when a model run has finished (usage recording). */
	onRunFinished?: (
		project: ProjectWorkflow,
		task: TaskRecord,
		run: TaskRun,
	) => void;
	/** How often live progress is written to task.json (ms). */
	progressSaveIntervalMs?: number;
	/** Probes of the worktree (default: git); injectable for tests. */
	branchOf?: (worktree: string) => string | undefined;
	codeStateOf?: (worktree: string) => string | undefined;
}

interface LiveRun {
	project: ProjectWorkflow;
	slug: string;
	title: string;
	/** The folder the run works in. */
	worktree: string;
	cancel: () => Promise<void>;
}

/** Folder comparison key (case-insensitive on Windows). */
function folderKey(path: string): string {
	const resolved = resolve(path).replace(/[\\/]+$/, "");
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export class TaskController {
	private readonly live = new Map<string, LiveRun>();
	/** Work in flight, per task (so one task never waits for another). */
	private pending = new Map<string, Set<Promise<unknown>>>();

	constructor(private readonly deps: ControllerDeps) {}

	/** Wait until no run is in flight: of one task, or of all (tests, shutdown). */
	async idle(project?: ProjectWorkflow, slug?: string): Promise<void> {
		const key = project && slug ? `${project.key}/${slug}` : undefined;
		const inFlight = () =>
			key
				? [...(this.pending.get(key) ?? [])]
				: [...this.pending.values()].flatMap((set) => [...set]);
		for (let batch = inFlight(); batch.length > 0; batch = inFlight()) {
			await Promise.allSettled(batch);
		}
	}

	private branchOf(worktree: string): string | undefined {
		return (this.deps.branchOf ?? currentBranch)(worktree);
	}

	private codeStateOf(worktree: string): string | undefined {
		return (this.deps.codeStateOf ?? codeState)(worktree);
	}

	/**
	 * Revalidated before every automatic or manual stage: the worktree still
	 * exists and is on the task's branch.
	 */
	private identityProblem(task: TaskRecord): string | undefined {
		if (!existsSync(task.identity.worktreePath)) {
			return `The task's worktree is gone: ${task.identity.worktreePath}. Move the task to a worktree to continue.`;
		}
		return branchChange(
			task.identity,
			this.branchOf(task.identity.worktreePath),
		);
	}

	/**
	 * Another task's run in the same folder. Two runs never edit one working
	 * folder at once: the second waits (paused) until the first is done.
	 * Worktrees of the same repository are separate folders and may run
	 * side by side.
	 */
	private folderBusy(
		project: ProjectWorkflow,
		task: TaskRecord,
	): string | undefined {
		const here = folderKey(task.identity.worktreePath);
		for (const live of this.live.values()) {
			if (live.slug === task.slug && live.project.key === project.key) continue;
			if (folderKey(live.worktree) === here) {
				return `Task "${live.title}" is running in this folder (${task.identity.worktreePath}). Resume this task when it has finished, or run it in another worktree.`;
			}
		}
		return undefined;
	}

	/** Runs in progress, by run id (for the UI and shutdown). */
	liveRunIds(): string[] {
		return [...this.live.keys()];
	}

	/**
	 * App quit: kill every run's process tree (bounded wait). Their records
	 * stay "running" and are marked interrupted at the next start (recover).
	 */
	async shutdown(timeoutMs = 3000): Promise<void> {
		const kills = [...this.live.values()].map((live) =>
			live.cancel().catch(() => undefined),
		);
		await Promise.race([
			Promise.all(kills),
			new Promise((resolve) => setTimeout(resolve, timeoutMs)),
		]);
	}

	private track<T>(
		project: ProjectWorkflow,
		slug: string,
		promise: Promise<T>,
	): Promise<T> {
		const key = `${project.key}/${slug}`;
		const set = this.pending.get(key) ?? new Set();
		this.pending.set(key, set);
		set.add(promise);
		void promise
			.catch(() => undefined)
			.finally(() => {
				set.delete(promise);
				if (set.size === 0) this.pending.delete(key);
			});
		return promise;
	}

	private changed(project: ProjectWorkflow, slug: string): void {
		this.deps.onChange?.(project, slug);
	}

	private load(project: ProjectWorkflow, slug: string): TaskRecord {
		const task = getTask(project, slug);
		if (!task) throw new Error(`Unknown task: ${slug}`);
		return task;
	}

	private approvedChecks(project: ProjectWorkflow): ApprovedChecks {
		const checks = loadProjectChecks(project);
		return { commands: checks.approvedAt ? checks.commands : [] };
	}

	/**
	 * After an app restart: runs that were in flight are marked interrupted
	 * and their tasks paused. Nothing is re-run automatically.
	 */
	recover(
		projects: ProjectWorkflow[],
		listSlugs: (p: ProjectWorkflow) => string[],
	): number {
		let recovered = 0;
		for (const project of projects) {
			for (const slug of listSlugs(project)) {
				const task = getTask(project, slug);
				if (!task) continue;
				let changed = false;
				for (const run of task.runs) {
					if (run.status === "running" || run.status === "queued") {
						run.status = "interrupted";
						run.failure = "interrupted";
						run.endedAt = this.deps.now().toISOString();
						run.error = "ADE stopped while this run was in progress";
						changed = true;
					}
				}
				if (changed) {
					task.state = "paused";
					task.stateReason =
						"ADE stopped while a run was in progress. Check the work, then resume.";
					saveTask(project, task);
					recovered++;
				}
			}
		}
		return recovered;
	}

	/** Start or continue a task in its mode (Auto advances; Manual waits). */
	start(project: ProjectWorkflow, slug: string): Promise<TaskRecord> {
		return withTaskLock(project, slug, () => {
			const task = this.load(project, slug);
			if (activeRun(task)) throw new Error("This task is already running");
			if (task.state === "done" || task.state === "cancelled") {
				throw new Error(`This task is ${task.state}`);
			}
			task.pauseRequested = false;
			if (task.mode === "manual") {
				task.state = "idle";
				task.stateReason = undefined;
				saveTask(project, task);
				return task;
			}
			return this.advance(project, task);
		});
	}

	/**
	 * Resume after a pause or block: the last failure is acknowledged (it may
	 * be retried once), then the task continues in its mode.
	 */
	resume(project: ProjectWorkflow, slug: string): Promise<TaskRecord> {
		return withTaskLock(project, slug, () => {
			const task = this.load(project, slug);
			if (activeRun(task)) throw new Error("This task is already running");
			if (task.state === "done" || task.state === "cancelled") {
				throw new Error(`This task is ${task.state}`);
			}
			const last = task.runs[task.runs.length - 1];
			if (last && last.status !== "succeeded") task.acknowledgedRunId = last.id;
			task.pauseRequested = false;
			task.state = "idle";
			task.stateReason = undefined;
			if (task.mode === "manual") {
				saveTask(project, task);
				return task;
			}
			return this.advance(project, task);
		});
	}

	/** Auto: finish the current run, then stop. */
	pause(project: ProjectWorkflow, slug: string): Promise<TaskRecord> {
		return withTaskLock(project, slug, () => {
			const task = this.load(project, slug);
			task.pauseRequested = true;
			if (!activeRun(task)) {
				task.state = "paused";
				task.stateReason = "Paused.";
			} else {
				task.stateReason = "Pausing after the current run.";
			}
			saveTask(project, task);
			this.changed(project, slug);
			return task;
		});
	}

	/** Stop the current run (and its child processes) and cancel the task. */
	async cancel(project: ProjectWorkflow, slug: string): Promise<TaskRecord> {
		const liveRuns = [...this.live.entries()].filter(
			([, live]) => live.project.key === project.key && live.slug === slug,
		);
		await withTaskLock(project, slug, () => {
			const task = this.load(project, slug);
			task.state = "cancelled";
			task.stateReason = "Cancelled.";
			task.pauseRequested = true;
			saveTask(project, task);
		});
		await Promise.all(liveRuns.map(([, live]) => live.cancel()));
		// Only this task's runs; other tasks keep running.
		await this.idle(project, slug);
		return this.load(project, slug);
	}

	setMode(
		project: ProjectWorkflow,
		slug: string,
		mode: "auto" | "manual",
	): Promise<TaskRecord> {
		return withTaskLock(project, slug, () => {
			const task = this.load(project, slug);
			task.mode = mode;
			saveTask(project, task);
			this.changed(project, slug);
			return task;
		});
	}

	answer(
		project: ProjectWorkflow,
		slug: string,
		answers: string,
	): Promise<TaskRecord> {
		return withTaskLock(project, slug, () => {
			const task = this.load(project, slug);
			const text = answers.trim();
			if (!text) throw new Error("Write an answer first");
			task.answers = text.slice(0, 10_000);
			if (task.state === "needs-input") {
				task.state = "idle";
				task.stateReason = undefined;
				if (task.mode === "auto" && !activeRun(task)) {
					return this.advance(project, task);
				}
			}
			saveTask(project, task);
			this.changed(project, slug);
			return task;
		});
	}

	/** Change a task's limits (e.g. raise its budget), then continue if Auto. */
	setLimits(
		project: ProjectWorkflow,
		slug: string,
		limits: Partial<TaskLimits>,
	): Promise<TaskRecord> {
		return withTaskLock(project, slug, () => {
			const task = this.load(project, slug);
			task.limits = { ...task.limits, ...limits };
			saveTask(project, task);
			this.changed(project, slug);
			return task;
		});
	}

	/**
	 * Explicitly move a task to another worktree (the user chose to continue it
	 * there). The change baseline is the new worktree's current state.
	 */
	adopt(
		project: ProjectWorkflow,
		slug: string,
		identity: TaskIdentity,
	): Promise<TaskRecord> {
		return withTaskLock(project, slug, () => {
			const task = this.load(project, slug);
			if (activeRun(task))
				throw new Error("Wait for the current run to finish");
			if (task.state === "cancelled") throw new Error("This task is cancelled");
			const where = (id: TaskIdentity) =>
				`${id.worktreePath}${id.branch ? ` (${id.branch})` : ""}`;
			task.moves = [
				...(task.moves ?? []),
				{
					at: this.deps.now().toISOString(),
					from: where(task.identity),
					to: where(identity),
				},
			];
			task.identity = identity;
			task.routeReasons = [...task.routeReasons, `moved to ${where(identity)}`];
			// Earlier runs stay as history; none of them counts as evidence here.
			task.evidenceStart = task.runs.length;
			task.acknowledgedRunId = undefined;
			task.pauseRequested = false;
			task.state = "paused";
			task.stateReason = `Moved to ${where(identity)}. Earlier runs are kept as history; resume to reconcile the work here and verify it again.`;
			saveTask(project, task);
			this.changed(project, slug);
			return task;
		});
	}

	/** Why a manual step may not run now, or undefined if it may. */
	static manualBlocker(
		task: TaskRecord,
		files: TaskFiles,
		checks: ApprovedChecks,
		kind: RunKind,
	): string | undefined {
		if (activeRun(task)) return "Another run of this task is in progress";
		if (task.state === "done" || task.state === "cancelled")
			return `The task is ${task.state}`;
		if (
			kind !== "checks" &&
			taskSpend(task).worstCaseUsd >= task.limits.budgetUsd
		) {
			return "The task's budget may be used up (counting uncertain costs at their cap); raise it to continue";
		}
		const evidence = evidenceView(task);
		const implemented = evidence.runs.some(isImplementation);
		switch (kind) {
			case "build":
				return files.hasPlan ? undefined : "Build needs a plan first";
			case "review":
			case "checks":
				if (kind === "checks" && checks.commands.length === 0) {
					return "No approved check commands for this project";
				}
				return implemented ? undefined : "Nothing has been implemented yet";
			case "fix": {
				const failed =
					evidence.runs.some(
						(run) => run.kind === "review" && run.verdict === "FAIL",
					) ||
					evidence.runs.some(
						(run) =>
							run.kind === "checks" &&
							(run.checks ?? []).some((c) => c.exitCode !== 0 || c.timedOut),
					);
				return failed ? undefined : "There is no failed check or review to fix";
			}
			case "escalate":
				return files.openEscalations.length > 0
					? undefined
					: "There is no open escalation report";
			case "custom":
				return undefined;
			default:
				return undefined;
		}
	}

	/** Manual mode (or a paused Auto task): run exactly one step. */
	runStep(
		project: ProjectWorkflow,
		slug: string,
		kind: RunKind,
		modelOverride?: string,
		customRoleId?: string,
	): Promise<TaskRecord> {
		return withTaskLock(project, slug, () => {
			if (kind === "custom" && !customRoleId) {
				throw new Error("Choose which specialist role to run");
			}
			const task = this.load(project, slug);
			const blocker = TaskController.manualBlocker(
				task,
				readTaskFiles(project, slug),
				this.approvedChecks(project),
				kind,
			);
			if (blocker) throw new Error(blocker);
			const problem = this.identityProblem(task);
			if (problem) throw new Error(problem);
			const busy = this.folderBusy(project, task);
			if (busy) throw new Error(busy);
			if (
				task.mode === "auto" &&
				!task.pauseRequested &&
				task.state !== "paused" &&
				task.state !== "blocked"
			) {
				throw new Error(
					"Pause the task, or switch it to Manual, to run a single step",
				);
			}
			task.state = "idle";
			task.stateReason = undefined;
			if (kind === "checks") return this.launchChecks(project, task, false);
			return this.launchModel(project, task, kind, {
				modelOverride,
				customRoleId,
				continueAfter: false,
			});
		});
	}

	/** Decide and act. Caller holds the task lock. */
	private advance(project: ProjectWorkflow, task: TaskRecord): TaskRecord {
		// Revalidated before every automatic stage.
		const problem = this.identityProblem(task);
		if (problem) {
			task.state = "blocked";
			task.stateReason = problem;
			saveTask(project, task);
			this.changed(project, task.slug);
			return task;
		}
		const busy = this.folderBusy(project, task);
		if (busy) {
			task.state = "paused";
			task.stateReason = busy;
			saveTask(project, task);
			this.changed(project, task.slug);
			return task;
		}
		const settings = this.deps.loadSettings();
		const decision = decideNext(
			task,
			readTaskFiles(project, task.slug),
			this.approvedChecks(project),
			settings,
			{
				codeState: this.codeStateOf(task.identity.worktreePath),
				customRoles: customRoleContext(
					taskSpecialists(this.deps.homeDir, project, task, settings),
					task,
					changedFilesOf(task),
				),
			},
		);
		switch (decision.type) {
			case "wait":
			case "none":
				saveTask(project, task);
				break;
			case "reroute":
				task.route = decision.route;
				task.routeReasons = [
					...task.routeReasons,
					`rerouted: ${decision.reason}`,
				];
				saveTask(project, task);
				return this.advance(project, task);
			case "run":
				return this.launchModel(project, task, decision.kind, {
					fallbackFrom: decision.fallbackFrom,
					customRoleId: decision.customRoleId,
					continueAfter: true,
				});
			case "checks":
				return this.launchChecks(project, task, true);
			case "done":
				task.state = "done";
				task.stateReason = `Verified: ${decision.reason}.`;
				saveTask(project, task);
				break;
			case "pause":
				task.state = "paused";
				task.stateReason = decision.reason;
				saveTask(project, task);
				break;
			case "needs-input":
				task.state = "needs-input";
				task.stateReason = decision.reason;
				saveTask(project, task);
				break;
			case "block":
				task.state = "blocked";
				task.stateReason = decision.reason;
				saveTask(project, task);
				break;
		}
		this.changed(project, task.slug);
		return task;
	}

	private nextAttempt(task: TaskRecord, kind: RunKind): number {
		return task.runs.filter((run) => run.kind === kind).length + 1;
	}

	private launchModel(
		project: ProjectWorkflow,
		task: TaskRecord,
		kind: ModelStage,
		options: {
			modelOverride?: string;
			fallbackFrom?: string;
			customRoleId?: string;
			continueAfter: boolean;
		},
	): TaskRecord {
		const settings = this.deps.loadSettings();
		const specialists = taskSpecialists(
			this.deps.homeDir,
			project,
			task,
			settings,
		);
		const { customRole, resolvedRole, routing } = stageRouting(
			specialists,
			task,
			settings,
			kind,
			options.customRoleId,
		);
		const readOnly =
			kind === "review" ||
			kind === "triage" ||
			(kind === "custom" && customRole?.access === "read-only");
		const configured =
			options.modelOverride?.trim() ||
			(options.fallbackFrom
				? (cheaperFallback(options.fallbackFrom) ?? routing.model)
				: routing.model);
		const model = resolveRunModel(configured, {
			pin: settings.execution.pinModels,
			env: this.deps.env,
		}).model;

		const checks = this.approvedChecks(project);
		const mayRunChecks =
			settings.execution.permissions !== "edits" && checks.commands.length > 0;
		const permissionMode: PermissionMode =
			settings.execution.permissions === "bypass"
				? "bypassPermissions"
				: "acceptEdits";
		const allowedTools = [
			...(mayRunChecks ? checks.commands.map((c) => `Bash(${c}:*)`) : []),
			...(readOnly || kind === "plan" || kind === "escalate"
				? READ_ONLY_GIT
				: []),
		];
		const disallowedTools = readOnly
			? ["Write", "Edit", "MultiEdit", "NotebookEdit"]
			: kind === "plan"
				? ["Edit", "MultiEdit", "NotebookEdit"]
				: [];

		const files = readTaskFiles(project, task.slug);
		const prompt =
			stagePrompt({
				stage: kind,
				task,
				tasksDir: portablePath(project.tasksDir),
				checks: checks.commands,
				mayRunChecks,
				feedback:
					kind === "fix" ? correctionFeedback(evidenceView(task)) : undefined,
				changes:
					kind === "review" || kind === "custom"
						? taskChanges(task.identity)
						: undefined,
				customRole,
				triage:
					kind === "triage"
						? {
								specialists: listSpecialists(project).map((s) => ({
									name: s.name,
									specialty: s.specialty,
								})),
								remainingUsd: Math.max(
									task.limits.budgetUsd - taskSpend(task).worstCaseUsd,
									0,
								),
							}
						: undefined,
				escalationReport:
					kind === "escalate" && files.openEscalations[0]
						? `${portablePath(project.tasksDir)}/${task.slug}/escalations/${files.openEscalations[0]}`
						: undefined,
			}) +
			(task.answers
				? `\n\n## The user's answers to the plan's questions\n${task.answers}\n`
				: "") +
			reconcileNote(task, kind) +
			rerouteNote(task, kind) +
			(kind === "triage"
				? ""
				: specialtyNote(
						specialists,
						task,
						kind,
						customRole ? [] : resolvedRole.instructions,
					) + historyNote(project, task, kind));

		const spend = taskSpend(task);
		// Uncertain costs count at their cap, so the remainder is never overstated.
		const remaining = Math.max(
			task.limits.budgetUsd - spend.worstCaseUsd,
			0.01,
		);
		const run: TaskRun = {
			id: this.deps.newId(),
			kind,
			status: "queued",
			attempt: this.nextAttempt(task, kind),
			queuedAt: this.deps.now().toISOString(),
			model,
			effort: routing.effort,
			maxTurns: routing.maxTurns,
			permissionMode,
			maxBudgetUsd: Number(remaining.toFixed(2)),
			sessionId: this.deps.newId(),
			fallbackFrom: options.fallbackFrom,
			costState: "pending",
			role: customRole?.name ?? resolvedRole.label,
			specialist: specialists.primary?.specialist.name,
			effortNote: this.deps.env?.CLAUDE_CODE_EFFORT_LEVEL
				? `CLAUDE_CODE_EFFORT_LEVEL=${this.deps.env.CLAUDE_CODE_EFFORT_LEVEL} overrides the requested effort`
				: undefined,
			customRoleId: customRole?.id,
			customAccess: customRole?.access,
		};
		task.runs.push(run);
		task.state = "running";
		task.stateReason = `${kind} on ${model}`;

		const command = this.deps.resolveClaude();
		if (!command) {
			Object.assign(run, {
				status: "failed",
				failure: "launch",
				error: "Claude Code (claude) was not found",
				endedAt: this.deps.now().toISOString(),
				costState: "unknown",
			});
			task.state = "blocked";
			task.stateReason = "Claude Code (claude) was not found";
			saveTask(project, task);
			this.changed(project, task.slug);
			return task;
		}

		let agentsJson: string | undefined;
		try {
			agentsJson = readFileSync(project.agentsFile, "utf8");
		} catch {
			agentsJson = undefined;
		}
		saveTask(project, task);

		let lastSave = 0;
		let handle: StageRunHandle;
		try {
			handle = this.deps.startRun(
				{
					command,
					cwd: task.identity.worktreePath,
					prompt,
					model,
					effort: routing.effort,
					maxTurns: routing.maxTurns,
					maxBudgetUsd: run.maxBudgetUsd,
					permissionMode,
					allowedTools,
					disallowedTools,
					addDirs: [portablePath(project.tasksDir)],
					agentsJson,
					sessionId: run.sessionId as string,
					env: this.deps.env,
				},
				(progress) => {
					const now = Date.now();
					if (now - lastSave < (this.deps.progressSaveIntervalMs ?? 2000))
						return;
					lastSave = now;
					void withTaskLock(project, task.slug, () => {
						const current = getTask(project, task.slug);
						const live = current?.runs.find((r) => r.id === run.id);
						if (!current || !live || live.status !== "running") return;
						live.liveCostUsd = progress.liveCostUsd;
						live.costState = progress.costState;
						live.observedModels = progress.observedModels;
						saveTask(project, current);
						this.changed(project, task.slug);
					});
				},
			);
		} catch (error) {
			Object.assign(run, {
				status: "failed",
				failure: "launch",
				error: error instanceof Error ? error.message : String(error),
				endedAt: this.deps.now().toISOString(),
				costState: "unknown",
			});
			task.state = "blocked";
			task.stateReason = `The ${kind} run could not start: ${run.error}`;
			saveTask(project, task);
			this.changed(project, task.slug);
			return task;
		}
		run.status = "running";
		run.startedAt = this.deps.now().toISOString();
		saveTask(project, task);
		this.changed(project, task.slug);

		this.live.set(run.id, {
			project,
			slug: task.slug,
			title: task.title,
			worktree: task.identity.worktreePath,
			cancel: handle.cancel,
		});
		this.track(
			project,
			task.slug,
			handle.done.then((result) =>
				this.finishModelRun(
					project,
					task.slug,
					run.id,
					result,
					options.continueAfter,
				),
			),
		);
		return task;
	}

	/**
	 * Record a finished model run. Idempotent: an event for a run that is not
	 * the task's running run (a duplicate, or a stale run) changes nothing.
	 */
	finishModelRun(
		project: ProjectWorkflow,
		slug: string,
		runId: string,
		result: StageRunResult,
		continueAfter: boolean,
	): Promise<TaskRecord | undefined> {
		this.live.delete(runId);
		return withTaskLock(project, slug, () => {
			const task = getTask(project, slug);
			const run = task?.runs.find((r) => r.id === runId);
			if (!task || !run || run.status !== "running") return task;

			run.endedAt = this.deps.now().toISOString();
			run.exitCode = result.exitCode;
			run.reportedCostUsd = result.reportedCostUsd;
			run.liveCostUsd = result.liveCostUsd;
			run.costState = result.costState;
			run.observedModels = result.observedModels;
			run.unpricedModels = result.unpricedModels.length
				? result.unpricedModels
				: undefined;
			run.summary = result.text;
			if (result.sessionId) run.sessionId = result.sessionId;
			run.codeState = this.codeStateOf(task.identity.worktreePath);
			try {
				this.deps.onRunFinished?.(project, task, run);
			} catch (error) {
				console.warn("[workflow] Recording a run's usage failed:", error);
			}

			if (task.state === "cancelled" || result.cancelled) {
				run.status = "cancelled";
				run.failure = "cancelled";
				saveTask(project, task);
				this.changed(project, slug);
				return task;
			}
			if (result.failure) {
				run.status = "failed";
				run.failure = result.failure;
				run.error = result.error;
			} else {
				run.status = "succeeded";
				if (
					run.kind === "review" ||
					(run.kind === "custom" && run.customAccess === "read-only")
				)
					run.verdict = parseVerdict(result.text);
			}

			if (run.kind === "triage") {
				this.applyTriageResult(project, task, run);
			}

			if (task.mode === "manual" || !continueAfter) {
				task.state = run.status === "succeeded" ? "idle" : "blocked";
				task.stateReason =
					run.status === "succeeded"
						? `${run.kind} finished`
						: `${run.kind} failed: ${(run.error ?? run.failure ?? "").slice(0, 300)}`;
				saveTask(project, task);
				this.changed(project, slug);
				return task;
			}
			if (task.pauseRequested) {
				task.state = "paused";
				task.stateReason = "Paused.";
				saveTask(project, task);
				this.changed(project, slug);
				return task;
			}
			return this.advance(project, task);
		});
	}

	/**
	 * Apply the AI's pathway choice to the task, or fall back to ADE's
	 * rule-based route (with the reason) when the run failed or its answer
	 * could not be read. A failed triage never blocks the task by itself.
	 */
	private applyTriageResult(
		project: ProjectWorkflow,
		task: TaskRecord,
		run: TaskRun,
	): void {
		const decision =
			run.status === "succeeded" ? parseTriage(run.summary) : undefined;
		if (!decision) {
			task.triage = {
				applied: false,
				route: task.route,
				models: {},
				reason:
					run.status === "succeeded"
						? "The pathway choice could not be read; ADE's rules chose the route."
						: `The pathway choice failed (${run.failure ?? "error"}); ADE's rules chose the route.`,
			};
			if (run.status !== "succeeded") task.acknowledgedRunId = run.id;
			return;
		}
		const wanted = decision.specialist?.toLowerCase();
		const match = wanted
			? listSpecialists(project).find(
					(s) =>
						s.name.toLowerCase() === wanted ||
						s.specialty.toLowerCase() === wanted,
				)
			: undefined;
		// A specialist the user chose is kept.
		const keepUsers = task.specialistReason === "chosen by you";
		Object.assign(
			task,
			applyTriage(task, decision, keepUsers ? undefined : match?.id),
		);
	}

	private launchChecks(
		project: ProjectWorkflow,
		task: TaskRecord,
		continueAfter: boolean,
	): TaskRecord {
		const checks = this.approvedChecks(project);
		const run: TaskRun = {
			id: this.deps.newId(),
			kind: "checks",
			status: "running",
			attempt: this.nextAttempt(task, "checks"),
			queuedAt: this.deps.now().toISOString(),
			startedAt: this.deps.now().toISOString(),
			// The exact commands: results count only while they stay approved.
			commands: [...checks.commands],
		};
		task.runs.push(run);
		task.state = "running";
		task.stateReason = "running the project's checks";
		saveTask(project, task);
		this.changed(project, task.slug);

		const abort = new AbortController();
		this.live.set(run.id, {
			project,
			slug: task.slug,
			title: task.title,
			worktree: task.identity.worktreePath,
			cancel: async () => abort.abort(),
		});
		this.track(
			project,
			task.slug,
			this.deps
				.runChecks({
					cwd: task.identity.worktreePath,
					commands: checks.commands,
					signal: abort.signal,
				})
				.catch((error): CheckResult[] => [
					{
						command: "(checks)",
						exitCode: null,
						timedOut: false,
						durationMs: 0,
						outputTail: String(error),
					},
				])
				.then((results) =>
					this.finishChecks(
						project,
						task.slug,
						run.id,
						results,
						abort.signal.aborted,
						continueAfter,
					),
				),
		);
		return task;
	}

	private finishChecks(
		project: ProjectWorkflow,
		slug: string,
		runId: string,
		results: CheckResult[],
		aborted: boolean,
		continueAfter: boolean,
	): Promise<TaskRecord | undefined> {
		this.live.delete(runId);
		return withTaskLock(project, slug, () => {
			const task = getTask(project, slug);
			const run = task?.runs.find((r) => r.id === runId);
			if (!task || !run || run.status !== "running") return task;
			run.endedAt = this.deps.now().toISOString();
			run.checks = results;
			run.codeState = this.codeStateOf(task.identity.worktreePath);
			if (aborted || task.state === "cancelled") {
				run.status = "cancelled";
				run.failure = "cancelled";
				saveTask(project, task);
				this.changed(project, slug);
				return task;
			}
			// Failing checks are a recorded result, not a failed run.
			run.status = "succeeded";
			if (task.mode === "manual" || !continueAfter) {
				task.state = "idle";
				task.stateReason = checksPassed(results, results.length)
					? "checks passed"
					: "checks failed";
				saveTask(project, task);
				this.changed(project, slug);
				return task;
			}
			if (task.pauseRequested) {
				task.state = "paused";
				task.stateReason = "Paused.";
				saveTask(project, task);
				this.changed(project, slug);
				return task;
			}
			return this.advance(project, task);
		});
	}
}
