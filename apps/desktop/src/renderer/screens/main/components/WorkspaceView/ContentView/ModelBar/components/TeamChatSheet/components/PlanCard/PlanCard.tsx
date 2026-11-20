import { Button } from "@superset/ui/button";
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

/** A plan the Coordinator proposed: its subtasks, and Go. */
export function PlanCard({ plan, agentOf, canGo, busy, onGo }: PlanCardProps) {
	return (
		<div className="space-y-2 rounded-md border bg-background p-2.5" data-plan>
			<p className="text-xs font-medium">
				Plan: {plan.subtasks.length} subtask
				{plan.subtasks.length === 1 ? "" : "s"}
			</p>
			<ol className="space-y-1.5">
				{plan.subtasks.map((sub, index) => {
					const agent = agentOf(sub.specialist);
					const models = Object.entries(sub.models)
						.map(([role, model]) => `${role} ${model}`)
						.join(", ");
					return (
						<li key={`${index}-${sub.title}`} className="text-xs">
							<span className="font-medium">
								{index + 1}. {sub.title}
							</span>
							<span className="block text-muted-foreground">
								{sub.specialist ?? "Default workflow"}
								{agent ? ` · agent ${agent}` : ""} ·{" "}
								{ROUTE_LABELS[sub.route] ?? sub.route}
								{models ? ` · ${models}` : ""}
								{sub.dependsOn.length
									? ` · after ${sub.dependsOn.map((d) => d + 1).join(", ")}`
									: " · can start right away"}
							</span>
						</li>
					);
				})}
			</ol>
			{plan.reason && (
				<p className="text-xs text-muted-foreground">{plan.reason}</p>
			)}
			{canGo && (
				<Button size="sm" disabled={busy} onClick={onGo}>
					Go: start the plan
				</Button>
			)}
		</div>
	);
}
