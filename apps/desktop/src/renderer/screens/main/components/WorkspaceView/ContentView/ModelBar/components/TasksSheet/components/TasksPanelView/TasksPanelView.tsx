import { Button } from "@superset/ui/button";
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
import { LuListTodo, LuPlay, LuUsers } from "react-icons/lu";
import { AUTOMATIC, BY_AI, ROUTE_LABELS } from "../../constants";
import type {
	ChecksView,
	Mode,
	ProjectTasks,
	Route,
	RoutePreview,
	SpecialistOption,
	TaskActions,
	TaskView,
} from "../../types";
import { usd } from "../../utils/costLabel";
import { ChecksSection } from "./components/ChecksSection";
import { TaskCard } from "./components/TaskCard";

interface TasksPanelViewProps {
	data: ProjectTasks | undefined;
	error?: string;
	checks: ChecksView | undefined;
	description: string;
	preview: RoutePreview | undefined;
	actions: TaskActions;
	/** The team's specialists (optional; empty means the default workflow). */
	specialists?: SpecialistOption[];
}

/**
 * The Tasks panel without its data source (the container is TasksSheet), so
 * it can be rendered with fixed data in tests.
 *
 * One request in: in Auto mode ADE plans when the task needs it, implements,
 * runs the checks, gets an independent review and corrects within limits,
 * stopping only for a question, a failure it may not retry, or a limit.
 */
export function TasksPanelView({
	data,
	error,
	checks,
	description,
	preview,
	actions,
	specialists = [],
}: TasksPanelViewProps) {
	const [specialist, setSpecialist] = useState("auto");
	const [route, setRoute] = useState<Route | typeof AUTOMATIC | typeof BY_AI>(
		BY_AI,
	);
	const [mode, setMode] = useState<Mode>("auto");
	const [useHistory, setUseHistory] = useState(true);
	const [teamRequest, setTeamRequest] = useState(false);
	const split = teamRequest && mode === "auto";
	const tasks = data?.tasks ?? [];
	const bySlug = new Map(tasks.map((t) => [t.slug, t]));
	const historyAvailable = data?.historyAvailable ?? 0;
	const usage = data?.usage;

	return (
		<div className="space-y-5 px-4 pb-6" data-panel="tasks">
			<section className="space-y-3 rounded-lg border bg-card p-3 shadow-xs">
				<div className="flex items-center gap-2">
					<LuListTodo className="size-4 text-muted-foreground" aria-hidden />
					<p className="text-sm font-semibold">New task</p>
				</div>
				<Textarea
					aria-label="Task description"
					className="resize-none"
					placeholder={
						split
							? "What should the team do? The Coordinator splits it across your specialists."
							: "What should be done?"
					}
					rows={4}
					value={description}
					onChange={(event) => actions.onDescriptionChange(event.target.value)}
				/>
				{split && (
					<p className="text-xs text-muted-foreground" data-team-request>
						A Coordinator (Sonnet, read-only) splits it into up to 6 subtasks
						for your specialists' agents. Independent ones run at the same time;
						each gets its own checks and review.
					</p>
				)}
				{!split && route === BY_AI && mode === "auto" && (
					<p className="text-xs text-muted-foreground" data-route-ai>
						A short read-only Sonnet run (a few cents) picks the pathway and the
						model for each role when the task starts.
					</p>
				)}
				{preview &&
					!split &&
					(route === AUTOMATIC || (route === BY_AI && mode === "manual")) && (
						<p className="text-xs text-muted-foreground">
							Route: <strong>{ROUTE_LABELS[preview.route]}</strong>, first step
							on {preview.model}. {preview.reasons.join("; ")}
						</p>
					)}
				<div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-t pt-3">
					<div className="space-y-1" hidden={split}>
						<Label className="text-xs">Route</Label>
						<Select
							value={route}
							onValueChange={(value) =>
								setRoute(value as Route | typeof AUTOMATIC | typeof BY_AI)
							}
						>
							<SelectTrigger
								className="h-8 w-[180px] text-xs"
								aria-label="Route"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={BY_AI}>Chosen by AI</SelectItem>
								<SelectItem value={AUTOMATIC}>Chosen by ADE's rules</SelectItem>
								{(Object.keys(ROUTE_LABELS) as Route[]).map((r) => (
									<SelectItem key={r} value={r}>
										{ROUTE_LABELS[r]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="flex items-center gap-2 pb-2">
						<Switch
							id="new-task-auto"
							checked={mode === "auto"}
							onCheckedChange={(auto) => setMode(auto ? "auto" : "manual")}
						/>
						<Label htmlFor="new-task-auto" className="text-xs">
							{mode === "auto" ? "Auto" : "Manual"}
						</Label>
					</div>
					{mode === "auto" && (
						<div className="flex items-center gap-2 pb-2">
							<Switch
								id="new-task-team"
								checked={teamRequest}
								onCheckedChange={setTeamRequest}
							/>
							<Label htmlFor="new-task-team" className="text-xs">
								Split across the team
							</Label>
						</div>
					)}
					{specialists.length > 0 && !split && (
						<div className="space-y-1">
							<Label className="text-xs">Specialist</Label>
							<Select value={specialist} onValueChange={setSpecialist}>
								<SelectTrigger
									className="h-8 w-[180px] text-xs"
									aria-label="Specialist"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="auto">Chosen by ADE</SelectItem>
									<SelectItem value="none">None (default workflow)</SelectItem>
									{specialists.map((s) => (
										<SelectItem key={s.id} value={s.id}>
											{s.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}
					{historyAvailable > 0 && (
						<div className="flex items-center gap-2 pb-2">
							<Switch
								id="new-task-history"
								checked={useHistory}
								onCheckedChange={setUseHistory}
							/>
							<Label htmlFor="new-task-history" className="text-xs">
								Use project history
							</Label>
						</div>
					)}
					<Button
						className="ml-auto"
						disabled={actions.busy || !description.trim()}
						onClick={() =>
							actions.onCreate({
								description,
								route:
									route === AUTOMATIC || route === BY_AI ? undefined : route,
								aiRouting: route === BY_AI,
								mode,
								useHistory: historyAvailable > 0 && useHistory,
								specialist,
								split,
							})
						}
					>
						{split ? (
							<LuUsers className="size-4" aria-hidden />
						) : (
							<LuPlay className="size-4" aria-hidden />
						)}
						{split
							? "Send to the team"
							: mode === "auto"
								? "Run task"
								: "Create task"}
					</Button>
				</div>
				<p className="text-xs text-muted-foreground">
					{mode === "auto"
						? "Auto runs every stage, the checks and an independent review, and stops only to ask you something or at a limit."
						: "Manual: you run each step yourself."}
					{historyAvailable > 0
						? useHistory
							? ` Uses relevant excerpts from ${historyAvailable} linked conversation(s), with no model call.`
							: " No project history."
						: ""}
				</p>
				{data?.runtime === "codex" && (
					<p className="text-xs text-amber-600">
						This is a Codex workspace. ADE runs task stages with Claude Code;
						Codex sessions you open yourself are not part of a task.
					</p>
				)}
				{data?.permissions === "bypass" && (
					<p className="text-xs text-destructive">
						Task runs skip all permission checks (Settings › Models & Cost).
					</p>
				)}
			</section>

			{error && <p className="text-sm text-destructive">{error}</p>}

			<ChecksSection
				checks={checks}
				busy={actions.busy}
				onSave={actions.onSaveChecks}
			/>

			<section className="space-y-3">
				<div className="flex items-center justify-between">
					<p className="text-sm font-semibold">Tasks</p>
					{tasks.length > 0 && (
						<span className="text-xs text-muted-foreground">
							{tasks.filter((t) => !t.parentSlug).length} total
						</span>
					)}
				</div>
				{tasks.length === 0 && (
					<div className="rounded-lg border border-dashed px-4 py-8 text-center">
						<p className="text-sm font-medium">No tasks yet</p>
						<p className="mt-1 text-xs text-muted-foreground">
							Describe one above, or plan a bigger piece of work in Team chat.
						</p>
					</div>
				)}
				{tasks
					// Subtasks show inside their team request.
					.filter((task) => !task.parentSlug || !bySlug.has(task.parentSlug))
					.map((task) => (
						<TaskCard
							key={task.slug}
							task={task}
							actions={actions}
							subtasks={task.subtaskSlugs
								.map((slug) => bySlug.get(slug))
								.filter((t): t is TaskView => !!t)}
						/>
					))}
			</section>

			{data && usage && (
				<div className="space-y-1 break-all rounded-lg bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
					<p>
						Task runs in this project: {usd(usage.tasks.usd)}
						{usage.tasks.worstCaseUsd > usage.tasks.usd + 0.0005
							? ` (up to ${usd(usage.tasks.worstCaseUsd)}: ${usage.tasks.uncertainRuns} run(s) of uncertain cost counted at their cap)`
							: ""}
						{usage.tasks.pendingRuns > 0
							? `, ${usage.tasks.pendingRuns} still running`
							: ""}
						{usage.tasks.unknownRuns > 0
							? `, ${usage.tasks.unknownRuns} of unknown cost`
							: ""}
						{usage.tasks.partialRuns > 0
							? `, ${usage.tasks.partialRuns} partly unpriced`
							: ""}
						. Your own sessions: {usd(usage.sessions.usd)} across{" "}
						{usage.sessions.count}
						{usage.sessions.unpricedMessages > 0
							? ` (plus ${usage.sessions.unpricedMessages} unpriced responses)`
							: ""}
						.
					</p>
					<p>
						All amounts are API-equivalent estimates. On a Claude subscription
						they are not charges. Task files: {data.project.tasksDir}
					</p>
				</div>
			)}
		</div>
	);
}
