import { Badge } from "@superset/ui/badge";
import { STATE_LABELS, type TaskView } from "../../types";

interface SubtaskProgressProps {
	request: TaskView;
	subtasks: TaskView[];
}

/** After Go: the plan's subtasks, where each runs and how far it got. */
export function SubtaskProgress({ request, subtasks }: SubtaskProgressProps) {
	return (
		<div
			className="space-y-2 rounded-md border bg-background p-2.5"
			data-chat-progress
		>
			<div className="flex items-center justify-between gap-2">
				<p className="text-xs font-medium">The team is on it</p>
				<Badge variant={request.state === "done" ? "default" : "secondary"}>
					{STATE_LABELS[request.state] ?? request.state}
				</Badge>
			</div>
			{request.stateReason && (
				<p className="break-words text-xs text-muted-foreground">
					{request.stateReason}
				</p>
			)}
			<ol className="space-y-1">
				{subtasks.map((sub, index) => (
					<li
						key={sub.slug}
						className="flex items-start justify-between gap-2 text-xs"
						data-chat-subtask={sub.state}
					>
						<span className="min-w-0">
							{index + 1}. {sub.title}
							<span className="block text-muted-foreground">
								{sub.specialist?.name ?? "Default workflow"}
								{sub.agentName ? ` · ${sub.agentName}` : ""}
								{sub.stateReason && sub.state !== "done"
									? ` · ${sub.stateReason}`
									: ""}
							</span>
						</span>
						<span className="shrink-0 text-muted-foreground">
							{STATE_LABELS[sub.state] ?? sub.state}
						</span>
					</li>
				))}
			</ol>
			<p className="text-xs text-muted-foreground">
				Each subtask's runs, checks and review are in Tasks.
			</p>
		</div>
	);
}
