import { Button } from "@superset/ui/button";
import { Checkbox } from "@superset/ui/checkbox";
import { Input } from "@superset/ui/input";
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
import type {
	CustomRoleDraft,
	ModelCatalog,
	RoleDraft,
	RoleName,
	SpecialistDraft,
	SpecialistList,
	TemplateView,
} from "../../types";
import { CustomRoleEditor } from "./components/CustomRoleEditor";
import { RoleRow } from "./components/RoleRow";

const NONE = "__none__";

interface SpecialistEditorProps {
	initial: SpecialistDraft;
	list: SpecialistList;
	templates: TemplateView[];
	models: ModelCatalog;
	busy: boolean;
	onSave: (draft: SpecialistDraft) => void;
	onSaveTemplate: (draft: SpecialistDraft) => void;
	onCancel: () => void;
}

/**
 * Create or edit a specialist: name and specialty, an optional template,
 * specialty instructions, the five base roles and custom roles. Values left
 * empty inherit from the template or the global defaults (Settings › Models
 * & Cost); the effective value and its source are shown for every role.
 */
export function SpecialistEditor({
	initial,
	list,
	templates,
	models,
	busy,
	onSave,
	onSaveTemplate,
	onCancel,
}: SpecialistEditorProps) {
	const [draft, setDraft] = useState<SpecialistDraft>(initial);
	const set = (patch: Partial<SpecialistDraft>) =>
		setDraft((d) => ({ ...d, ...patch }));
	const template = templates.find((t) => t.id === draft.templateId);

	const inheritedFor = (role: RoleName) => {
		const global = list.global[role] as {
			model: string;
			effort: string;
			maxTurns: number;
		};
		const t = draft.templateUses.models ? template?.roles[role] : undefined;
		return {
			model: t?.model ?? global.model,
			effort: t?.effort ?? global.effort,
			maxTurns: t?.maxTurns ?? global.maxTurns,
			source: {
				model: t?.model ? "template" : "global",
				effort: t?.effort ? "template" : "global",
				maxTurns: t?.maxTurns ? "template" : "global",
			},
		};
	};

	const chooseTemplate = (id: string) => {
		const t = templates.find((x) => x.id === id);
		set({
			templateId: t?.id,
			specialty: draft.specialty || t?.specialty || "",
			name: draft.name || t?.name || "",
		});
	};

	const addCustomRole = () =>
		set({
			customRoles: [
				...draft.customRoles,
				{
					id: "",
					name: "",
					description: "",
					instructions: "",
					access: "read-only",
					trigger: "after-implementation",
					keywords: [],
					expectedOutput: "",
				},
			],
		});

	const instructionsFromTemplate =
		draft.templateUses.instructions && template ? template.instructions : "";

	return (
		<div className="space-y-4" data-specialist-editor>
			<div className="grid grid-cols-2 gap-2">
				<div className="space-y-1">
					<Label htmlFor="spec-name">Name</Label>
					<Input
						id="spec-name"
						value={draft.name}
						onChange={(e) => set({ name: e.target.value })}
						placeholder="e.g. Backend"
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="spec-specialty">Specialty</Label>
					<Input
						id="spec-specialty"
						value={draft.specialty}
						onChange={(e) => set({ specialty: e.target.value })}
						placeholder="Anything: UI, Payments, Shaders…"
					/>
				</div>
			</div>

			<div className="space-y-2 rounded border p-2">
				<Label>Template (optional)</Label>
				<Select
					value={draft.templateId ?? NONE}
					onValueChange={(v) =>
						v === NONE ? set({ templateId: undefined }) : chooseTemplate(v)
					}
				>
					<SelectTrigger className="h-8" aria-label="Template">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={NONE}>No template</SelectItem>
						{templates.map((t) => (
							<SelectItem key={t.id} value={t.id}>
								{t.name}
								{t.builtIn ? "" : " (mine)"}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{template && (
					<div className="flex gap-4 text-xs">
						<div className="flex items-center gap-1.5">
							<Checkbox
								aria-label="Use its instructions and roles"
								checked={draft.templateUses.instructions}
								onCheckedChange={(on) =>
									set({
										templateUses: {
											...draft.templateUses,
											instructions: on === true,
										},
									})
								}
							/>
							Use its instructions and roles
						</div>
						<div className="flex items-center gap-1.5">
							<Checkbox
								aria-label="Use its model settings"
								checked={draft.templateUses.models}
								onCheckedChange={(on) =>
									set({
										templateUses: {
											...draft.templateUses,
											models: on === true,
										},
									})
								}
							/>
							Use its model settings
						</div>
					</div>
				)}
			</div>

			<div className="space-y-1">
				<div className="flex items-center justify-between">
					<Label htmlFor="spec-instructions">Specialty instructions</Label>
					<span className="text-[11px] text-muted-foreground">
						{draft.instructions
							? "Customized"
							: instructionsFromTemplate
								? `From template (${template?.name})`
								: "None"}
					</span>
				</div>
				<Textarea
					id="spec-instructions"
					rows={6}
					className="text-xs"
					value={draft.instructions ?? instructionsFromTemplate}
					onChange={(e) => set({ instructions: e.target.value })}
					placeholder="What this specialist must know and care about. Added to every stage it runs."
				/>
				{draft.instructions && instructionsFromTemplate && (
					<Button
						size="sm"
						variant="ghost"
						className="h-6 px-2 text-xs"
						onClick={() => set({ instructions: undefined })}
					>
						Reset to the template's instructions
					</Button>
				)}
			</div>

			<div className="space-y-1">
				<Label htmlFor="spec-keywords">
					Auto picks it for tasks that mention
				</Label>
				<Input
					id="spec-keywords"
					className="text-xs"
					value={(draft.keywords ?? template?.keywords ?? []).join(", ")}
					onChange={(e) =>
						set({
							keywords: e.target.value
								.split(",")
								.map((k) => k.trim())
								.filter(Boolean),
						})
					}
					placeholder="Comma-separated words"
				/>
			</div>

			<div className="space-y-2">
				<p className="text-sm font-medium">Base roles</p>
				<p className="text-xs text-muted-foreground">
					Every specialist has these roles. ADE runs only the ones a task needs:
					a typo gets the Quick Worker, not a planner and architect.
				</p>
				{list.baseRoles.map(({ role, label }) => (
					<RoleRow
						key={role}
						label={label}
						inherited={inheritedFor(role)}
						value={draft.roles[role] ?? {}}
						models={models.models}
						onChange={(value: RoleDraft) =>
							set({ roles: { ...draft.roles, [role]: value } })
						}
					/>
				))}
			</div>

			{template &&
				draft.templateUses.instructions &&
				template.customRoles.length > 0 && (
					<div className="space-y-1">
						<p className="text-sm font-medium">Roles from the template</p>
						{template.customRoles.map((role) => {
							const on = !draft.disabledTemplateRoles.includes(role.id);
							return (
								<div
									key={role.id}
									className="flex items-start justify-between gap-2 rounded border p-2 text-xs"
								>
									<div>
										<p className="font-medium">{role.name}</p>
										<p className="text-muted-foreground">{role.description}</p>
										<p className="text-muted-foreground">
											Runs {role.trigger.replace("-", " ")}
											{role.keywords.length
												? `, only when the task mentions ${role.keywords.slice(0, 5).join(", ")}…`
												: ""}
										</p>
									</div>
									<Switch
										aria-label={`Use ${role.name}`}
										checked={on}
										onCheckedChange={(v) =>
											set({
												disabledTemplateRoles: v
													? draft.disabledTemplateRoles.filter(
															(id) => id !== role.id,
														)
													: [...draft.disabledTemplateRoles, role.id],
											})
										}
									/>
								</div>
							);
						})}
					</div>
				)}

			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<p className="text-sm font-medium">Custom roles</p>
					<Button size="sm" variant="outline" onClick={addCustomRole}>
						Add role
					</Button>
				</div>
				{draft.customRoles.map((role, i) => (
					<CustomRoleEditor
						key={role.id || `new-${i}`}
						role={role}
						models={models.models}
						onChange={(next: CustomRoleDraft) =>
							set({
								customRoles: draft.customRoles.map((r, j) =>
									j === i ? next : r,
								),
							})
						}
						onRemove={() =>
							set({ customRoles: draft.customRoles.filter((_, j) => j !== i) })
						}
					/>
				))}
			</div>

			<p className="text-xs text-muted-foreground">{models.note}</p>

			<div className="flex flex-wrap justify-end gap-2">
				<Button variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
				<Button
					variant="outline"
					disabled={busy || !draft.name.trim()}
					onClick={() => onSaveTemplate(draft)}
				>
					Save as my template
				</Button>
				<Button
					disabled={busy || !draft.name.trim()}
					onClick={() => onSave(draft)}
				>
					Save specialist
				</Button>
			</div>
		</div>
	);
}
