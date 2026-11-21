import { Button } from "@superset/ui/button";
import type { TaskActions, TaskView } from "../../../../../../types";

interface TaskHistoryProps {
	task: TaskView;
	actions: TaskActions;
	/** Changing the history waits for the current run to finish. */
	disabled: boolean;
}

const KIND_LABELS: Record<string, string> = {
	"claude-code": "Claude Code session",
	"claude-export": "Claude app chat (export)",
	"transcript-file": "Transcript file",
};

/**
 * Which earlier conversations a task was given (excerpts in history.md in
 * the task folder). The user can drop one from this task, choose again from
 * the project's current imports, or run the task without history; the
 * imported conversations themselves are not changed.
 */
export function TaskHistory({ task, actions, disabled }: TaskHistoryProps) {
	const history = task.history;
	if (!history) return null;
	const off = disabled || actions.busy;
	return (
		<div className="space-y-1.5 rounded border p-2" data-task-history>
			<div className="flex items-center justify-between gap-2">
				<p className="text-xs font-medium">
					{history.excerpts > 0
						? `Project history: ${history.excerpts} excerpt(s) from ${history.sources.length} conversation(s)`
						: "Project history: no linked conversation matched this task"}
				</p>
				<div className="flex shrink-0 gap-1">
					<Button
						size="sm"
						variant="ghost"
						className="h-6 px-2 text-xs"
						disabled={off}
						onClick={() => actions.onRefreshHistory(task.slug)}
					>
						Refresh
					</Button>
					<Button
						size="sm"
						variant="ghost"
						className="h-6 px-2 text-xs"
						disabled={off}
						onClick={() => actions.onClearHistory(task.slug)}
					>
						Don't use
					</Button>
				</div>
			</div>
			{history.sources.length > 0 && (
				<ul className="space-y-1">
					{history.sources.map((source) => (
						<li
							key={source.conversationId}
							className="flex items-center justify-between gap-2 text-xs"
						>
							<span className="min-w-0 truncate" title={source.title}>
								{source.title}{" "}
								<span className="text-muted-foreground">
									· {KIND_LABELS[source.originKind] ?? source.originKind} ·{" "}
									{source.excerpts} excerpt(s)
								</span>
							</span>
							<Button
								size="sm"
								variant="ghost"
								className="h-6 shrink-0 px-2 text-xs"
								disabled={off}
								title="Stop using this conversation in this task (the import is kept)"
								onClick={() =>
									actions.onExcludeHistory(task.slug, source.conversationId)
								}
							>
								Remove
							</Button>
						</li>
					))}
				</ul>
			)}
			{history.excerpts > 0 && (
				<p
					className="break-all text-[11px] text-muted-foreground"
					title="The exact excerpts the models were given"
				>
					Excerpts: {history.file}
				</p>
			)}
			{history.excluded.length > 0 && (
				<p className="text-[11px] text-muted-foreground">
					{history.excluded.length} conversation(s) removed from this task.
				</p>
			)}
		</div>
	);
}
