import { Button } from "@superset/ui/button";
import type { SpecialistView } from "../../types";

interface SpecialistCardProps {
	specialist: SpecialistView;
	/** The agent that does its subtasks, if any. */
	agentName?: string;
	busy: boolean;
	onEdit: () => void;
	onRemove: () => void;
}

/** A specialist at a glance: specialty, template, role models, extra roles. */
export function SpecialistCard({
	specialist,
	agentName,
	busy,
	onEdit,
	onRemove,
}: SpecialistCardProps) {
	const { effective } = specialist;
	const roles = Object.values(effective.roles) as Array<{
		label: string;
		model: string;
	}>;
	return (
		<div
			className="space-y-1.5 rounded-md border p-3 text-xs"
			data-specialist={specialist.name}
		>
			<div className="flex items-start justify-between gap-2">
				<div>
					<p className="text-sm font-medium">{specialist.name}</p>
					<p className="text-muted-foreground">
						{specialist.specialty}
						{effective.templateName
							? ` · template: ${effective.templateName}`
							: ""}
					</p>
					<p className="text-muted-foreground" data-specialist-agent>
						{agentName
							? `Agent: ${agentName}`
							: "No agent: runs where the task is"}
					</p>
				</div>
				<div className="flex gap-1">
					<Button size="sm" variant="outline" disabled={busy} onClick={onEdit}>
						Edit
					</Button>
					<Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>
						Remove
					</Button>
				</div>
			</div>
			<p className="text-muted-foreground">
				Roles:{" "}
				{[
					...roles.map((r) => `${r.label} (${r.model})`),
					...effective.customRoles.map(
						(r) =>
							`${r.name} (${r.model ?? (r.access === "read-only" ? effective.roles.reviewer.model : effective.roles.implementer.model)})`,
					),
				].join(" · ")}
			</p>
			{effective.problems.map((problem) => (
				<p key={problem} className="text-amber-600">
					{problem}
				</p>
			))}
		</div>
	);
}
