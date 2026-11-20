import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { Switch } from "@superset/ui/switch";
import { Textarea } from "@superset/ui/textarea";
import { cn } from "@superset/ui/utils";
import { useState } from "react";
import {
	LuGitBranch,
	LuPause,
	LuPlay,
	LuRotateCw,
	LuSquare,
} from "react-icons/lu";
import { StatusBadge } from "../../../../../StatusBadge";
import {
	BY_ROLE,
	MODEL_CHOICES,
	ROUTE_LABELS,
	ROUTE_STEPS,
	RUN_LABELS,
} from "../../../../constants";
import type { Route, TaskActions, TaskView } from "../../../../types";
import { taskCostLabel, usd } from "../../../../utils/costLabel";
import { Detail } from "./components/Detail";
import { RunRow } from "./components/RunRow";
import { TaskHistory } from "./components/TaskHistory";

interface TaskCardProps {
	task: TaskView;
	actions: TaskActions;
	/** A team request's subtasks, in the order they were planned. */
	subtasks?: TaskView[];
	/** For a subtask: the titles of the subtasks it builds on. */
	buildsOn?: string[];
}

/** The colour of the note under the header, by state. */
const NOTE_TONE: Record<string, string> = {
	running: "border-sky-500/50",
	paused: "border-amber-500/60",
	"needs-input": "border-amber-500/60",
	blocked: "border-destructive/60",
	failed: "border-destructive/60",
	done: "border-emerald-500/60",
};

/**
 * One task. In Auto mode ADE runs every stage itself; the card offers only
 * Start, Pause, Resume and Cancel, plus an answer box when the plan asks a
 * question. In Manual mode (or while an Auto task is paused or blocked) each
 * step has its own button, disabled with the reason when it cannot run.
 */
export function TaskCard({
	task,
	actions,
	subtasks = [],
	buildsOn = [],
}: TaskCardProps) {
	const [answer, setAnswer] = useState("");
	const [model, setModel] = useState<string>(BY_ROLE);
	const [budget, setBudget] = useState(String(task.limits.budgetUsd));
	const { busy } = actions;
	const elsewhere = task.mismatch !== null;
	const running = task.state === "running";
	const finished = task.state === "done" || task.state === "cancelled";
	const stopped =
		task.state === "paused" ||
		task.state === "blocked" ||
		task.state === "failed" ||
		(task.state === "needs-input" &&
			task.planQuestions.length === 0 &&
			// A team chat waiting for the user's reply is answered in Team plans.
			!(task.chat && task.subtaskSlugs.length === 0));
	// A team request has no steps of its own: its subtasks do the work.
	const showSteps =
		!task.isRequest &&
		!finished &&
		!elsewhere &&
		(task.mode === "manual" || stopped) &&
		!running;
	// Uncertain costs count at their cap, as in ADE's budget decisions. A run
	// in progress always counts at its cap (the rest of the budget), so the
	// budget prompt waits until it has finished and reported its cost.
	const budgetSpent =
		!running && task.spend.worstCaseUsd >= task.limits.budgetUsd;
	const kind = task.isRequest
		? "Team request"
		: ROUTE_LABELS[task.route as Route];
	const where = task.agentName ?? task.identity.branch ?? null;

	const pathway =
		task.routeBy === "ai" && !task.isRequest
			? task.triage
				? task.triage.applied
					? `${ROUTE_LABELS[task.triage.route as Route]}${
							Object.keys(task.triage.models).length
								? ` · ${Object.entries(task.triage.models)
										.map(([role, m]) => `${role} ${m}`)
										.join(", ")}`
								: ""
						} · chosen by AI: ${task.triage.reason}`
					: task.triage.reason
				: "Chosen by AI when the task starts"
			: null;

	return (
		<div
			className="overflow-hidden rounded-lg border bg-card shadow-xs"
			data-task-slug={task.slug}
			data-task-state={task.state}
		>
			<div className="flex items-start justify-between gap-3 px-3 pt-3">
				<div className="min-w-0 space-y-1">
					<p
						className="truncate text-sm font-semibold leading-tight"
						title={task.description}
					>
						{task.title}
					</p>
					<p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
						<span>{kind}</span>
						{where && (
							<span className="inline-flex items-center gap-1">
								<LuGitBranch className="size-3" aria-hidden />
								{where}
							</span>
						)}
					</p>
				</div>
				<div className="flex shrink-0 flex-col items-end gap-1">
					<StatusBadge state={task.state} />
					<span
						className="text-[11px] tabular-nums text-muted-foreground"
						title="API-equivalent estimate; on a subscription this is not a charge"
					>
						{taskCostLabel(task.spend)} of {usd(task.limits.budgetUsd)}
					</span>
				</div>
			</div>

			<div className="space-y-3 p-3">
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
					{task.isRequest && (
						<Detail label="Plan" data-task-request>
							{task.subtaskSlugs.length
								? `${task.subtaskSlugs.length} subtask(s), each starts once the work it builds on is done${task.splitReason ? ` · ${task.splitReason}` : ""}`
								: "The Coordinator splits it into subtasks, one per specialist"}
						</Detail>
					)}
					{task.parentSlug && (
						<Detail label="Agent" data-task-parent>
							{task.agentName
								? `${task.agentName} (its own folder and branch${task.identity.branch ? `, ${task.identity.branch}` : ""})`
								: "Runs where the request was sent"}
							{buildsOn.length
								? ` · builds on ${buildsOn.map((t) => `"${t}"`).join(", ")}`
								: " · independent: can run alongside the others"}
							{task.resultCommit
								? ` · committed as ${task.resultCommit.slice(0, 7)} for the next agent`
								: ""}
						</Detail>
					)}
					{pathway && (
						<Detail label="Pathway" data-task-pathway>
							{pathway}
						</Detail>
					)}
					{!task.isRequest && (
						<Detail label="Specialist" data-task-specialist>
							{task.specialist
								? `${task.specialist.name} (${task.specialist.specialty})`
								: "None: default workflow"}
							{task.supportingSpecialists.length
								? ` · also: ${task.supportingSpecialists.join(", ")}`
								: ""}
							{task.specialistReason ? (
								<span className="text-muted-foreground">
									{" "}
									· {task.specialistReason}
								</span>
							) : null}
						</Detail>
					)}
					{task.nextRole && !finished && (
						<Detail label="Next" data-task-next>
							{task.nextRole} on {task.nextModel}
							{task.nextModelSource && task.nextModelSource !== "global"
								? ` (${task.nextModelSource === "template" ? "from template" : task.nextModelSource === "task" ? "this task's override" : "specialist's setting"})`
								: ""}
						</Detail>
					)}
				</dl>

				{task.stateReason && (
					<p
						className={cn(
							"break-words rounded-md border-l-2 bg-muted/40 px-2.5 py-1.5 text-xs",
							NOTE_TONE[task.state] ?? "border-border",
						)}
					>
						{task.stateReason}
					</p>
				)}

				<TaskHistory
					task={task}
					actions={actions}
					disabled={running || elsewhere || finished}
				/>

				{elsewhere && !task.parentSlug && (
					<div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5">
						<p className="text-xs">{task.mismatch}</p>
						<Button
							size="sm"
							variant="outline"
							disabled={busy || running}
							onClick={() => actions.onMoveHere(task.slug)}
						>
							Move task here
						</Button>
					</div>
				)}

				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<Switch
							id={`mode-${task.slug}`}
							checked={task.mode === "auto"}
							disabled={busy || elsewhere || finished}
							onCheckedChange={(auto) =>
								actions.onSetMode(task.slug, auto ? "auto" : "manual")
							}
						/>
						<Label htmlFor={`mode-${task.slug}`} className="text-xs">
							{task.mode === "auto" ? "Auto" : "Manual"}
						</Label>
					</div>
					<div className="flex flex-wrap items-center gap-1.5">
						{task.mode === "auto" && task.state === "idle" && (
							<Button
								size="sm"
								disabled={busy || elsewhere}
								onClick={() => actions.onStart(task.slug)}
							>
								<LuPlay className="size-3.5" aria-hidden />
								Start
							</Button>
						)}
						{running && task.mode === "auto" && (
							<Button
								size="sm"
								variant="outline"
								disabled={busy || task.pauseRequested}
								onClick={() => actions.onPause(task.slug)}
							>
								<LuPause className="size-3.5" aria-hidden />
								{task.pauseRequested ? "Pausing…" : "Pause"}
							</Button>
						)}
						{stopped && (
							<Button
								size="sm"
								disabled={busy || elsewhere || budgetSpent}
								title={budgetSpent ? "Raise the task budget first" : undefined}
								onClick={() => actions.onResume(task.slug)}
							>
								<LuRotateCw className="size-3.5" aria-hidden />
								Resume
							</Button>
						)}
						{!finished && (
							<Button
								size="sm"
								variant="ghost"
								className="text-muted-foreground"
								disabled={busy}
								onClick={() => actions.onCancel(task.slug)}
							>
								<LuSquare className="size-3" aria-hidden />
								Cancel
							</Button>
						)}
					</div>
				</div>

				{task.state === "needs-input" && task.planQuestions.length > 0 && (
					<div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5">
						<p className="text-xs font-medium">
							The plan has questions for you
						</p>
						<ul className="list-disc space-y-0.5 pl-4 text-xs">
							{task.planQuestions.map((question) => (
								<li key={question}>{question}</li>
							))}
						</ul>
						<Textarea
							aria-label="Your answers"
							rows={3}
							value={answer}
							onChange={(event) => setAnswer(event.target.value)}
						/>
						<Button
							size="sm"
							disabled={busy || !answer.trim()}
							onClick={() => actions.onAnswer(task.slug, answer)}
						>
							Answer and continue
						</Button>
					</div>
				)}

				{budgetSpent && !finished && (
					<div className="flex items-center gap-2">
						<Input
							type="number"
							min={0}
							step="0.5"
							className="h-8 w-[100px]"
							aria-label="New task budget"
							value={budget}
							onChange={(event) => setBudget(event.target.value)}
						/>
						<Button
							size="sm"
							variant="outline"
							disabled={busy || !(Number(budget) > task.limits.budgetUsd)}
							onClick={() => actions.onSetBudget(task.slug, Number(budget))}
						>
							Raise budget
						</Button>
					</div>
				)}

				{showSteps && (
					<div className="space-y-2 rounded-md border bg-muted/20 p-2.5">
						<div className="flex items-center justify-between gap-2">
							<p className="text-xs font-medium">Run a step</p>
							<Select value={model} onValueChange={setModel}>
								<SelectTrigger
									className="h-7 w-[140px] text-xs"
									aria-label="Model for the next step"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={BY_ROLE}>Model by role</SelectItem>
									{MODEL_CHOICES.map((choice) => (
										<SelectItem key={choice} value={choice}>
											{choice}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-wrap gap-1.5">
							{ROUTE_STEPS[task.route as Route].map((stepKind) => {
								const blocker = task.manualBlockers[stepKind];
								const suggested =
									(task.next?.type === "run" && task.next.kind === stepKind) ||
									(task.next?.type === "checks" && stepKind === "checks");
								return (
									<Button
										key={stepKind}
										size="sm"
										variant={suggested ? "default" : "outline"}
										disabled={busy || blocker !== null}
										title={blocker ?? undefined}
										onClick={() =>
											actions.onRunStep(
												task.slug,
												stepKind,
												model === BY_ROLE ? undefined : model,
											)
										}
									>
										{RUN_LABELS[stepKind]}
										{suggested && task.nextModel && model === BY_ROLE
											? ` · ${task.nextModel}`
											: ""}
									</Button>
								);
							})}
						</div>
						{task.customRoles.length > 0 && (
							<div className="flex flex-wrap gap-1.5">
								{task.customRoles.map((role) => (
									<Button
										key={role.id}
										size="sm"
										variant="outline"
										disabled={busy || task.manualBlockers.custom !== null}
										title={task.manualBlockers.custom ?? undefined}
										onClick={() =>
											actions.onRunStep(
												task.slug,
												"custom",
												model === BY_ROLE ? undefined : model,
												role.id,
											)
										}
									>
										{role.name}
									</Button>
								))}
							</div>
						)}
					</div>
				)}

				{task.runs.length > 0 && (
					<div className="space-y-1.5 border-t pt-2.5">
						<p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
							Runs ({task.runs.length})
						</p>
						<ol className="space-y-1">
							{task.runs.map((run) => (
								<RunRow
									key={run.id}
									run={run}
									onOpenSession={
										run.sessionId &&
										run.kind !== "checks" &&
										run.status !== "queued" &&
										!elsewhere
											? () => actions.onOpenSession(task.slug, run.id)
											: undefined
									}
								/>
							))}
						</ol>
					</div>
				)}

				{subtasks.length > 0 && (
					<div className="space-y-2 border-t pt-2.5" data-task-subtasks>
						<p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
							Subtasks ({subtasks.length})
						</p>
						{subtasks.map((subtask, index) => (
							<div key={subtask.slug} className="flex gap-2">
								<span className="mt-3 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium tabular-nums">
									{index + 1}
								</span>
								<div className="min-w-0 flex-1">
									<span className="sr-only">
										Subtask {index + 1} of {subtasks.length}
									</span>
									<TaskCard
										task={subtask}
										actions={actions}
										buildsOn={subtask.dependsOn
											.map(
												(slug) => subtasks.find((s) => s.slug === slug)?.title,
											)
											.filter((t): t is string => !!t)}
									/>
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
