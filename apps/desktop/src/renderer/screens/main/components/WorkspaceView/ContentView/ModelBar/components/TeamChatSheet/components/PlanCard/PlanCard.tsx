import { Button } from "@superset/ui/button";
import { LuPlay } from "react-icons/lu";
import { type PlanView, ROUTE_LABELS } from "../../types";

interface PlanCardProps {
	plan: PlanView;
	/** The agent that does a specialist's work, by specialist name. */
	agentOf: (specialist?: string) => string | undefined;
	/** Only the latest plan of a chat that has not started can be started. */
	canGo: boolean;
	busy: boolean;
	onGo: () => void;
}

const TAG = "rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground";

/** A plan the Coordinator proposed: its subtasks, and Go. */
export function PlanCard({ plan, agentOf, canGo, busy, onGo }: PlanCardProps) {
	return (
		<div
			className="space-y-3 rounded-lg border bg-background p-3 shadow-xs"
			data-plan
		>
			<div className="flex items-center justify-between gap-2">
				<p className="text-xs font-semibold">
					Plan · {plan.subtasks.length} subtask
					{plan.subtasks.length === 1 ? "" : "s"}
				</p>
			</div>
			<ol className="space-y-2.5">
				{plan.subtasks.map((sub, index) => {
					const agent = agentOf(sub.specialist);
					const models = Object.entries(sub.models)
						.map(([role, model]) => `${role} ${model}`)
						.join(", ");
					return (
						<li key={`${index}-${sub.title}`} className="flex gap-2.5 text-xs">
							<span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold tabular-nums text-primary">
								{index + 1}
							</span>
							<div className="min-w-0 space-y-1">
								<p className="font-medium leading-5">{sub.title}</p>
								<div className="flex flex-wrap gap-1">
									<span className={TAG}>
										{sub.specialist ?? "Default workflow"}
										{agent ? ` · ${agent}` : ""}
									</span>
									<span className={TAG}>
										{ROUTE_LABELS[sub.route] ?? sub.route}
									</span>
									{models && <span className={TAG}>{models}</span>}
									<span className={TAG}>
										{sub.dependsOn.length
											? `after ${sub.dependsOn.map((d) => d + 1).join(", ")}`
											: "can start right away"}
									</span>
								</div>
							</div>
						</li>
					);
				})}
			</ol>
			{plan.reason && (
				<p className="border-t pt-2 text-xs text-muted-foreground">
					{plan.reason}
				</p>
			)}
			{canGo && (
				<Button size="sm" className="w-full" disabled={busy} onClick={onGo}>
					<LuPlay className="size-3.5" aria-hidden />
					Go: start the plan
				</Button>
			)}
		</div>
	);
}
