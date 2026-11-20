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
import { Textarea } from "@superset/ui/textarea";
import { useState } from "react";
import type {
	AgentView,
	CustomRoleDraft,
	ModelCatalog,
	RoleDraft,
	RoleName,
	SpecialistDraft,
	SpecialistList,
	TemplateView,
} from "../../types";
import { TRIGGER_LABELS } from "../../types";
import { RoleCard } from "./components/RoleCard";

/** The workflow's own roles: when they run and what they may do is fixed. */
const BUILT_IN_ROLES: Record<
	RoleName,
	{ responsibility: string; runs: string; files: string }
> = {
	planner: {
		responsibility:
			"Breaks the task down, records decisions and acceptance criteria.",
		runs: "for tasks that need a plan",
		files: "writes the plan only",
	},
	architect: {
		responsibility:
			"Hard design decisions and escalations when implementation is blocked.",
		runs: "for exceptional tasks and on escalation",
		files: "may edit",
	},
	implementer: {
		responsibility:
			"Makes the change, and the corrections after failed checks or reviews.",
		runs: "for every non-trivial task",
		files: "may edit",
	},
	reviewer: {
		responsibility: "Independent review of the task's changes.",
		runs: "after the checks pass",
		files: "read-only",
	},
	quick: {
		responsibility: "Small, low-risk, well-scoped changes without planning.",
		runs: "for trivial tasks",
		files: "may edit",
	},
};

/**
 * Add a template's roles to the list, matched by the role's stable id (or
 * an existing role with the same name): applying a template again adds
 * nothing and never overwrites a role's settings.
 */
function withTemplateRoles(
	roles: CustomRoleDraft[],
	template: TemplateView | undefined,
): CustomRoleDraft[] {
	if (!template) return roles;
	const ids = new Set(roles.map((r) => r.id));
	const names = new Set(roles.map((r) => r.name.trim().toLowerCase()));
	const added = template.customRoles
		.filter((r) => !ids.has(r.id) && !names.has(r.name.trim().toLowerCase()))
		.map((r) => ({ ...(r as CustomRoleDraft), fromTemplate: template.id }));
	return [...roles, ...added];
}

const NONE = "__none__";

const BUILT_IN_ROLE_LABELS: Record<RoleName, string> = {
	planner: "Planner",
	architect: "Architect",
	implementer: "Implementer",
	reviewer: "Reviewer",
	quick: "Quick Worker",
};

interface SpecialistEditorProps {
	initial: SpecialistDraft;
	list: SpecialistList;
	templates: TemplateView[];
	models: ModelCatalog;
	/** The team's agents; the specialist can belong to one. */
	agents?: AgentView[];
	busy: boolean;
	onSave: (draft: SpecialistDraft) => void;
	onSaveTemplate: (draft: SpecialistDraft) => void;
	onCancel: () => void;
}

/**
 * Create or edit a specialist: name and specialty, an optional template,
 * specialty instructions and its Roles (the workflow's roles plus any added by
 * a template or by the user, all edited the same way). Values left
 * empty inherit from the template or the global defaults (Settings › Models
 * & Cost); the effective value and its source are shown for every role.
 */
export function SpecialistEditor({
	initial,
	list,
	templates,
	models,
	agents = [],
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
			// Its roles join the Roles list (once; edits are kept).
			customRoles: draft.templateUses.models
				? withTemplateRoles(draft.customRoles, t)
				: draft.customRoles,
			appliedTemplates:
				t && draft.templateUses.models
					? [...new Set([...(draft.appliedTemplates ?? []), t.id])]
					: draft.appliedTemplates,
		});
	};

	/** What an added role inherits: the Reviewer's or the Implementer's settings. */
	const inheritedForAdded = (access: "read-only" | "edit") => {
		const base: RoleName = access === "read-only" ? "reviewer" : "implementer";
		const inherited = inheritedFor(base);
		const own = draft.roles[base] ?? {};
		return {
			model: own.model || inherited.model,
			effort: own.effort ?? inherited.effort,
			maxTurns: own.maxTurns ?? inherited.maxTurns,
			source: inherited.source,
			from: BUILT_IN_ROLE_LABELS[base],
		};
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

			{agents.length > 0 && (
				<div className="space-y-1">
					<Label>Agent</Label>
					<Select
						value={draft.agentWorkspaceId ?? NONE}
						onValueChange={(v) =>
							set({ agentWorkspaceId: v === NONE ? null : v })
						}
					>
						<SelectTrigger className="h-8" aria-label="Agent">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={NONE}>
								No agent (runs where the task is)
							</SelectItem>
							{agents.map((a) => (
								<SelectItem key={a.workspaceId} value={a.workspaceId}>
									{a.name}
									{a.current ? " (this agent)" : ""}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p className="text-xs text-muted-foreground">
						In a team request, this agent does the specialist's subtasks in its
						own folder and branch. Its own tasks use this specialty by default.
					</p>
				</div>
			)}

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
								aria-label="Use its instructions"
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
							Use its instructions
						</div>
						<div className="flex items-center gap-1.5">
							<Checkbox
								aria-label="Use its role and model settings"
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
							Use its role and model settings
						</div>
					</div>
				)}
				{template && (
					<table className="w-full text-[11px]" data-template-preview>
						<thead className="text-left text-muted-foreground">
							<tr>
								<th className="font-normal">Role</th>
								<th className="font-normal">Model</th>
								<th className="font-normal">Effort</th>
								<th className="font-normal">Max turns</th>
								<th className="font-normal">Runs</th>
								<th className="font-normal">Files</th>
							</tr>
						</thead>
						<tbody>
							{list.baseRoles.map(({ role, label }) => {
								const v = inheritedFor(role);
								return (
									<tr key={role}>
										<td>{label}</td>
										<td>{v.model}</td>
										<td>{v.effort}</td>
										<td>{v.maxTurns} (global)</td>
										<td>{BUILT_IN_ROLES[role].runs}</td>
										<td>{BUILT_IN_ROLES[role].files}</td>
									</tr>
								);
							})}
							{template.customRoles.map((r) => (
								<tr key={r.id}>
									<td>{r.name}</td>
									<td>{r.model ?? "as Reviewer"}</td>
									<td>{r.effort ?? "as Reviewer"}</td>
									<td>{r.maxTurns ?? "as Reviewer"}</td>
									<td>
										{TRIGGER_LABELS[r.trigger]}, when the task or its changed
										files match
									</td>
									<td>{r.access === "read-only" ? "read-only" : "may edit"}</td>
								</tr>
							))}
						</tbody>
					</table>
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

			<div className="space-y-2" data-roles>
				<div className="flex items-center justify-between">
					<p className="text-sm font-medium">Roles</p>
					<Button size="sm" variant="outline" onClick={addCustomRole}>
						Add role
					</Button>
				</div>
				<p className="text-xs text-muted-foreground">
					ADE runs only the roles a task needs: a typo gets the Quick Worker,
					not a planner and an architect. Every role's model, effort, turn limit
					and instructions can be changed.
				</p>
				{list.baseRoles.map(({ role, label }) => (
					<RoleCard
						key={role}
						title={label}
						inherited={inheritedFor(role)}
						models={models.models}
						builtIn={{
							...BUILT_IN_ROLES[role],
							value: draft.roles[role] ?? {},
							onChange: (value: RoleDraft) =>
								set({ roles: { ...draft.roles, [role]: value } }),
						}}
					/>
				))}
				{draft.customRoles.map((role, i) => (
					<RoleCard
						key={role.id || `new-${i}`}
						title={role.name}
						inherited={inheritedForAdded(role.access)}
						models={models.models}
						added={{
							role,
							templateName: templates.find((t) => t.id === role.fromTemplate)
								?.name,
							onChange: (next: CustomRoleDraft) =>
								set({
									customRoles: draft.customRoles.map((r, j) =>
										j === i ? next : r,
									),
								}),
							onRemove: () =>
								set({
									customRoles: draft.customRoles.filter((_, j) => j !== i),
								}),
						}}
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
