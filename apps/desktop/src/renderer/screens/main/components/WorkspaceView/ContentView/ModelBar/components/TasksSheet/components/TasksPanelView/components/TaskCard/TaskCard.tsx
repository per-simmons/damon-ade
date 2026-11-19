import { Badge } from "@superset/ui/badge";
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
import { useState } from "react";
import {
	BY_ROLE,
	MODEL_CHOICES,
	ROUTE_LABELS,
	ROUTE_STEPS,
	RUN_LABELS,
	STATE_LABELS,
} from "../../../../constants";
import type { Route, TaskActions, TaskView } from "../../../../types";
import { taskCostLabel, usd } from "../../../../utils/costLabel";
import { RunRow } from "./components/RunRow";

interface TaskCardProps {
	task: TaskView;
	actions: TaskActions;
}

/**
 * One task. In Auto mode ADE runs every stage itself; the card offers only
 * Start, Pause, Resume and Cancel, plus an answer box when the plan asks a
 * question. In Manual mode (or while an Auto task is paused or blocked) each
 * step has its own button, disabled with the reason when it cannot run.
 */
export function TaskCard({ task, actions }: TaskCardProps) {
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
		(task.state === "needs-input" && task.planQuestions.length === 0);
	const showSteps =
		!finished && !elsewhere && (task.mode === "manual" || stopped) && !running;
	// Uncertain costs count at their cap, as in ADE's budget decisions. A run
	// in progress always counts at its cap (the rest of the budget), so the
	// budget prompt waits until it has finished and reported its cost.
	const budgetSpent =
		!running && task.spend.worstCaseUsd >= task.limits.budgetUsd;

	return (
		<div
			className="space-y-3 rounded-md border p-3"
			data-task-slug={task.slug}
			data-task-state={task.state}
		>
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<p className="truncate text-sm font-medium" title={task.description}>
						{task.title}
					</p>
					<p className="text-xs text-muted-foreground">
						{ROUTE_LABELS[task.route as Route]} ·{" "}
						{task.identity.branch ?? task.identity.worktreePath}
					</p>
				</div>
				<div className="flex shrink-0 flex-col items-end gap-1">
					<Badge variant={task.state === "done" ? "default" : "secondary"}>
						{STATE_LABELS[task.state] ?? task.state}
					</Badge>
					<span
						className="text-xs text-muted-foreground"
						title="API-equivalent estimate; on a subscription this is not a charge"
					>
						{taskCostLabel(task.spend)} of {usd(task.limits.budgetUsd)}
					</span>
				</div>
			</div>

			{task.stateReason && (
				<p className="break-words text-xs text-muted-foreground">
					{task.stateReason}
				</p>
			)}

			{elsewhere && (
				<div className="space-y-2 rounded border border-amber-500/40 p-2">
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

			<div className="flex flex-wrap items-center gap-2">
				<div className="mr-2 flex items-center gap-2">
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
				{task.mode === "auto" && task.state === "idle" && (
					<Button
						size="sm"
						disabled={busy || elsewhere}
						onClick={() => actions.onStart(task.slug)}
					>
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
						Resume
					</Button>
				)}
				{!finished && (
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						onClick={() => actions.onCancel(task.slug)}
					>
						Cancel
					</Button>
				)}
			</div>

			{task.state === "needs-input" && task.planQuestions.length > 0 && (
				<div className="space-y-2">
					<ul className="list-disc pl-4 text-xs">
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
				<div className="space-y-2">
					<div className="flex flex-wrap gap-1.5">
						{ROUTE_STEPS[task.route as Route].map((kind) => {
							const blocker = task.manualBlockers[kind];
							const suggested =
								(task.next?.type === "run" && task.next.kind === kind) ||
								(task.next?.type === "checks" && kind === "checks");
							return (
								<Button
									key={kind}
									size="sm"
									variant={suggested ? "default" : "outline"}
									disabled={busy || blocker !== null}
									title={blocker ?? undefined}
									onClick={() =>
										actions.onRunStep(
											task.slug,
											kind,
											model === BY_ROLE ? undefined : model,
										)
									}
								>
									{RUN_LABELS[kind]}
									{suggested && task.nextModel && model === BY_ROLE
										? ` · ${task.nextModel}`
										: ""}
								</Button>
							);
						})}
					</div>
					<Select value={model} onValueChange={setModel}>
						<SelectTrigger
							className="h-8 w-[150px]"
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
			)}

			{task.runs.length > 0 && (
				<ol className="space-y-1.5 border-t pt-2">
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
			)}
		</div>
	);
}
