import { StatusBadge } from "../../../StatusBadge";
import type { TaskView } from "../../types";

interface SubtaskProgressProps {
	request: TaskView;
	subtasks: TaskView[];
}

/** After Go: the plan's subtasks, where each runs and how far it got. */
export function SubtaskProgress({ request, subtasks }: SubtaskProgressProps) {
	const done = subtasks.filter((s) => s.state === "done").length;
	return (
		<div
			className="space-y-3 rounded-lg border bg-background p-3 shadow-xs"
			data-chat-progress
		>
			<div className="flex items-center justify-between gap-2">
				<p className="text-xs font-semibold">
					The team is on it · {done} of {subtasks.length} done
				</p>
				<StatusBadge state={request.state} />
			</div>
			<div className="h-1 overflow-hidden rounded-full bg-muted">
				<div
					className="h-full rounded-full bg-emerald-500 transition-all"
					style={{
						width: `${subtasks.length ? (done / subtasks.length) * 100 : 0}%`,
					}}
				/>
			</div>
			{request.stateReason && (
				<p className="break-words text-xs text-muted-foreground">
					{request.stateReason}
				</p>
			)}
			<ol className="divide-y">
				{subtasks.map((sub, index) => (
					<li
						key={sub.slug}
						className="flex items-start justify-between gap-3 py-2 text-xs first:pt-0 last:pb-0"
						data-chat-subtask={sub.state}
					>
						<span className="min-w-0">
							<span className="font-medium">
								{index + 1}. {sub.title}
							</span>
							<span className="block text-muted-foreground">
								{sub.specialist?.name ?? "Default workflow"}
								{sub.agentName ? ` · ${sub.agentName}` : ""}
								{sub.stateReason && sub.state !== "done"
									? ` · ${sub.stateReason}`
									: ""}
							</span>
						</span>
						<StatusBadge state={sub.state} />
					</li>
				))}
			</ol>
			<p className="text-[11px] text-muted-foreground">
				Each subtask's runs, checks and review are in Tasks.
			</p>
		</div>
	);
}
