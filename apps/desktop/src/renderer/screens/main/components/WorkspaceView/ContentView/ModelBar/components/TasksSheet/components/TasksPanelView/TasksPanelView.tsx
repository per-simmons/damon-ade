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
import { AUTOMATIC, ROUTE_LABELS } from "../../constants";
import type {
	ChecksView,
	Mode,
	ProjectTasks,
	Route,
	RoutePreview,
	TaskActions,
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
}: TasksPanelViewProps) {
	const [route, setRoute] = useState<Route | typeof AUTOMATIC>(AUTOMATIC);
	const [mode, setMode] = useState<Mode>("auto");
	const [useHistory, setUseHistory] = useState(true);
	const historyAvailable = data?.historyAvailable ?? 0;
	const usage = data?.usage;

	return (
		<div className="space-y-6 px-4 pb-6" data-panel="tasks">
			<section className="space-y-3">
				<Textarea
					aria-label="Task description"
					placeholder="What should be done?"
					rows={4}
					value={description}
					onChange={(event) => actions.onDescriptionChange(event.target.value)}
				/>
				{preview && route === AUTOMATIC && (
					<p className="text-xs text-muted-foreground">
						Route: <strong>{ROUTE_LABELS[preview.route]}</strong>, first step on{" "}
						{preview.model}. {preview.reasons.join("; ")}
					</p>
				)}
				<div className="flex flex-wrap items-end gap-3">
					<div className="space-y-1">
						<Label className="text-xs">Route</Label>
						<Select
							value={route}
							onValueChange={(value) =>
								setRoute(value as Route | typeof AUTOMATIC)
							}
						>
							<SelectTrigger className="w-[190px]" aria-label="Route">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={AUTOMATIC}>Chosen by ADE</SelectItem>
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
						disabled={actions.busy || !description.trim()}
						onClick={() =>
							actions.onCreate({
								description,
								route: route === AUTOMATIC ? undefined : route,
								mode,
								useHistory: historyAvailable > 0 && useHistory,
							})
						}
					>
						{mode === "auto" ? "Run task" : "Create task"}
					</Button>
				</div>
				<p className="text-xs text-muted-foreground">
					{mode === "auto"
						? "Auto: ADE runs every stage, the checks and an independent review, and corrects within your limits. It stops only to ask you something or when a limit is reached."
						: "Manual: ADE creates the task; you run each step yourself."}
				</p>
				{historyAvailable > 0 && (
					<p className="text-xs text-muted-foreground">
						{useHistory
							? `ADE searches the ${historyAvailable} conversation(s) linked to this project (History) and gives the task only the relevant excerpts, as historical context. No model is used for this.`
							: "This task gets no project history."}
					</p>
				)}
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
				{data?.tasks.length === 0 && (
					<p className="text-sm text-muted-foreground">
						No tasks in this project yet.
					</p>
				)}
				{data?.tasks.map((task) => (
					<TaskCard key={task.slug} task={task} actions={actions} />
				))}
			</section>

			{data && usage && (
				<div className="space-y-1 break-all text-xs text-muted-foreground">
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
