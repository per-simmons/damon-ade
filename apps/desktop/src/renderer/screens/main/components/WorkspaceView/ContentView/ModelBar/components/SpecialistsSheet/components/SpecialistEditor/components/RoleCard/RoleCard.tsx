import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import {
	type CustomRoleDraft,
	type ModelCatalog,
	type RoleDraft,
	TRIGGER_LABELS,
} from "../../../../types";
import { type InheritedRole, RoleFields } from "../RoleFields";

interface BuiltInRole {
	/** What the role does; when and with which access it runs is fixed. */
	responsibility: string;
	runs: string;
	files: string;
}

interface RoleCardProps {
	title: string;
	inherited: InheritedRole;
	models: ModelCatalog["models"];
	/** A role every specialist has (Planner, Reviewer…). */
	builtIn?: BuiltInRole & {
		value: RoleDraft;
		onChange: (value: RoleDraft) => void;
	};
	/** A role added by the user or a template. */
	added?: {
		role: CustomRoleDraft;
		templateName?: string;
		onChange: (role: CustomRoleDraft) => void;
		onRemove: () => void;
	};
}

/**
 * One role in the Roles list. Every role has the same controls: model,
 * reasoning effort, maximum turns, instructions, when it runs and what it
 * may do with files. For the workflow's own roles the last two are fixed by
 * the workflow; for added roles they are set here.
 */
export function RoleCard({
	title,
	inherited,
	models,
	builtIn,
	added,
}: RoleCardProps) {
	const role = added?.role;
	const value: RoleDraft = builtIn
		? builtIn.value
		: {
				model: role?.model,
				effort: role?.effort,
				maxTurns: role?.maxTurns,
				instructions: role?.instructions,
			};
	const setValue = (next: RoleDraft) => {
		if (builtIn) builtIn.onChange(next);
		else if (added && role) {
			added.onChange({
				...role,
				model: next.model,
				effort: next.effort,
				maxTurns: next.maxTurns,
				instructions: next.instructions ?? "",
			});
		}
	};
	const setRole = (patch: Partial<CustomRoleDraft>) =>
		added && role && added.onChange({ ...role, ...patch });
	const customized = builtIn
		? Object.values(builtIn.value).some((v) => v !== undefined && v !== "")
		: !!(role?.model || role?.effort || role?.maxTurns);

	return (
		<div
			className="space-y-2 rounded border p-2 text-xs"
			data-role={title || "new role"}
		>
			<div className="flex items-start justify-between gap-2">
				{role ? (
					<Input
						className="h-8 text-sm font-medium"
						aria-label="Role name"
						placeholder="Role name, e.g. Accessibility Reviewer"
						value={role.name}
						onChange={(e) => setRole({ name: e.target.value })}
					/>
				) : (
					<p className="text-sm font-medium">{title}</p>
				)}
				<div className="flex shrink-0 gap-1">
					{customized && (
						<Button
							size="sm"
							variant="ghost"
							className="h-7 px-2 text-xs"
							onClick={() =>
								builtIn
									? builtIn.onChange({})
									: setValue({ instructions: role?.instructions })
							}
						>
							Reset to inherited
						</Button>
					)}
					{added && (
						<Button
							size="sm"
							variant="ghost"
							className="h-7 px-2 text-xs"
							onClick={added.onRemove}
						>
							Remove
						</Button>
					)}
				</div>
			</div>

			{builtIn ? (
				<div className="space-y-0.5 text-muted-foreground">
					<p>{builtIn.responsibility}</p>
					<p>
						Runs: {builtIn.runs} · Files: {builtIn.files}
					</p>
				</div>
			) : (
				role && (
					<>
						{added?.templateName && (
							<p className="text-muted-foreground">
								Added by the {added.templateName} template
							</p>
						)}
						<Input
							className="h-8 text-xs"
							aria-label="Role description"
							placeholder="What it is responsible for"
							value={role.description}
							onChange={(e) => setRole({ description: e.target.value })}
						/>
						<div className="grid grid-cols-3 gap-2">
							<div className="space-y-1">
								<span className="text-muted-foreground">Runs</span>
								<Select
									value={role.trigger}
									onValueChange={(v) =>
										setRole({ trigger: v as CustomRoleDraft["trigger"] })
									}
								>
									<SelectTrigger
										className="h-8 text-xs"
										aria-label="When it runs"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{Object.entries(TRIGGER_LABELS).map(([v, l]) => (
											<SelectItem key={v} value={v}>
												{l}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1">
								<span className="text-muted-foreground">Files</span>
								<Select
									value={role.access}
									onValueChange={(v) =>
										setRole({ access: v as CustomRoleDraft["access"] })
									}
								>
									<SelectTrigger
										className="h-8 text-xs"
										aria-label="File access"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="read-only">
											Read-only (reports a verdict)
										</SelectItem>
										<SelectItem value="edit">May edit files</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1">
								<span className="text-muted-foreground">
									Only when the task mentions
								</span>
								<Input
									className="h-8 text-xs"
									aria-label="Trigger keywords"
									placeholder="Comma-separated; empty = always"
									value={role.keywords.join(", ")}
									onChange={(e) =>
										setRole({
											keywords: e.target.value
												.split(",")
												.map((k) => k.trim())
												.filter(Boolean),
										})
									}
								/>
							</div>
						</div>
					</>
				)
			)}

			<RoleFields
				label={title || "New role"}
				inherited={inherited}
				value={value}
				models={models}
				onChange={setValue}
				instructionsLabel={builtIn ? "Extra instructions" : "Instructions"}
				instructionsPlaceholder={
					builtIn
						? "Extra instructions for this role (added to its built-in instructions)"
						: "Instructions (this role's prompt)"
				}
			/>

			{role && (
				<Input
					className="h-8 text-xs"
					aria-label="Expected output"
					placeholder="What it must return"
					value={role.expectedOutput}
					onChange={(e) => setRole({ expectedOutput: e.target.value })}
				/>
			)}
		</div>
	);
}
