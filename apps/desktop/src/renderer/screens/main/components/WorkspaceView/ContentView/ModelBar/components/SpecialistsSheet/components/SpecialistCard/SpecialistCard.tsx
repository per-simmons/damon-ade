import { Button } from "@superset/ui/button";
import type { SpecialistView } from "../../types";

interface SpecialistCardProps {
	specialist: SpecialistView;
	busy: boolean;
	onEdit: () => void;
	onRemove: () => void;
}

/** A specialist at a glance: specialty, template, role models, extra roles. */
export function SpecialistCard({
	specialist,
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
				{roles.map((r) => `${r.label}: ${r.model}`).join(" · ")}
			</p>
			{effective.customRoles.length > 0 && (
				<p className="text-muted-foreground">
					Extra roles: {effective.customRoles.map((r) => r.name).join(", ")}
				</p>
			)}
			{effective.problems.map((problem) => (
				<p key={problem} className="text-amber-600">
					{problem}
				</p>
			))}
		</div>
	);
}
