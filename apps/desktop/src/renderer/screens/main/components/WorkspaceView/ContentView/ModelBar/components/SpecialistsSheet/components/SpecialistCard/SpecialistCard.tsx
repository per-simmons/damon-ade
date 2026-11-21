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
			className="space-y-2.5 rounded-lg border bg-card p-3 text-xs shadow-xs"
			data-specialist={specialist.name}
		>
			<div className="flex items-start justify-between gap-2">
				<div>
					<p className="text-sm font-semibold">{specialist.name}</p>
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
			<div className="flex flex-wrap gap-1" data-specialist-roles>
				{[
					...roles.map((r) => ({
						name: r.label,
						model: r.model,
						added: false,
					})),
					...effective.customRoles.map((r) => ({
						name: r.name,
						model:
							r.model ??
							(r.access === "read-only"
								? effective.roles.reviewer.model
								: effective.roles.implementer.model),
						added: true,
					})),
				].map((role) => (
					<span
						key={role.name}
						className={
							role.added
								? "rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary"
								: "rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
						}
					>
						{role.name} · {role.model}
					</span>
				))}
			</div>
			{effective.problems.map((problem) => (
				<p key={problem} className="text-amber-600">
					{problem}
				</p>
			))}
		</div>
	);
}
