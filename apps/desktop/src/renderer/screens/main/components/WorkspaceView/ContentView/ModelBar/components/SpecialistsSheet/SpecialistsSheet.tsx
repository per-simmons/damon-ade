import { Button } from "@superset/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@superset/ui/sheet";
import { toast } from "@superset/ui/sonner";
import { useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { SpecialistCard } from "./components/SpecialistCard";
import { SpecialistEditor } from "./components/SpecialistEditor";
import type { RoleDraft, SpecialistDraft, SpecialistView } from "./types";

interface SpecialistsSheetProps {
	workspaceId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

const emptyDraft = (): SpecialistDraft => ({
	name: "",
	specialty: "",
	templateUses: { instructions: true, models: true },
	roles: {},
	customRoles: [],
	disabledTemplateRoles: [],
});

function toDraft(s: SpecialistView): SpecialistDraft {
	return {
		id: s.id,
		name: s.name,
		specialty: s.specialty,
		templateId: s.templateId,
		templateUses: s.templateUses,
		instructions: s.instructions,
		keywords: s.keywords,
		roles: s.roles as SpecialistDraft["roles"],
		customRoles: s.customRoles as SpecialistDraft["customRoles"],
		disabledTemplateRoles: s.disabledTemplateRoles,
	};
}

/** Drop unset values so they inherit instead of overriding. */
function cleanRoles(roles: SpecialistDraft["roles"]) {
	const out: Record<string, RoleDraft> = {};
	for (const [role, value] of Object.entries(roles)) {
		if (!value) continue;
		const clean: RoleDraft = {};
		if (value.model?.trim()) clean.model = value.model.trim();
		if (value.effort) clean.effort = value.effort;
		if (value.maxTurns) clean.maxTurns = value.maxTurns;
		if (value.instructions?.trim()) clean.instructions = value.instructions;
		if (Object.keys(clean).length) out[role] = clean;
	}
	return out;
}

/**
 * The team's specialists. Optional: a team without specialists runs tasks
 * with the default workflow. With them, Auto picks the one a task is about
 * and runs its roles with its instructions and models.
 */
export function SpecialistsSheet({
	workspaceId,
	open,
	onOpenChange,
}: SpecialistsSheetProps) {
	const utils = electronTrpc.useUtils();
	const [editing, setEditing] = useState<SpecialistDraft | null>(null);
	const { data: list, error } = electronTrpc.specialists.list.useQuery(
		{ workspaceId },
		{ enabled: open },
	);
	const { data: templates } = electronTrpc.specialists.templates.useQuery(
		undefined,
		{ enabled: open },
	);
	const { data: models } = electronTrpc.specialists.models.useQuery(undefined, {
		enabled: open,
	});
	const refresh = () => {
		void utils.specialists.invalidate();
		void utils.workflow.getProjectTasks.invalidate({ workspaceId });
	};
	const onError = (err: { message: string }) => toast.error(err.message);
	const save = electronTrpc.specialists.save.useMutation({
		onSuccess: (s) => {
			toast.success(`Specialist "${s.name}" saved`);
			setEditing(null);
			refresh();
		},
		onError,
	});
	const remove = electronTrpc.specialists.remove.useMutation({
		onSuccess: refresh,
		onError,
	});
	const saveTemplate = electronTrpc.specialists.saveTemplate.useMutation({
		onSuccess: (t) => {
			toast.success(
				`Template "${t.name}" saved; it is available for every team`,
			);
			refresh();
		},
		onError,
	});
	const busy = save.isPending || remove.isPending || saveTemplate.isPending;

	const submit = (draft: SpecialistDraft) =>
		save.mutate({
			workspaceId,
			specialist: {
				...draft,
				roles: cleanRoles(draft.roles),
				customRoles: draft.customRoles.map((r) => ({
					...r,
					model: r.model || undefined,
				})),
			},
		});

	const submitTemplate = (draft: SpecialistDraft) => {
		const template = templates?.find((t) => t.id === draft.templateId);
		const fromTemplate = draft.templateUses.instructions ? template : undefined;
		saveTemplate.mutate({
			name: draft.name,
			specialty: draft.specialty,
			instructions: draft.instructions ?? fromTemplate?.instructions ?? "",
			keywords: draft.keywords ?? template?.keywords ?? [],
			roles: cleanRoles({
				...(draft.templateUses.models ? (template?.roles ?? {}) : {}),
				...draft.roles,
			}) as SpecialistDraft["roles"],
			customRoles: [
				...(fromTemplate?.customRoles ?? []).filter(
					(r) => !draft.disabledTemplateRoles.includes(r.id),
				),
				...draft.customRoles,
			].map((r) => ({ ...r, id: "" })),
		});
	};

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="w-[600px] overflow-y-auto sm:max-w-[600px]">
				<SheetHeader>
					<SheetTitle>
						Specialists{list ? ` · ${list.team.name}` : ""}
					</SheetTitle>
					<SheetDescription>
						Optional. Specialists give tasks a specialty's instructions and
						their own role models. All of them work in this team's repository.
					</SheetDescription>
				</SheetHeader>
				<div className="space-y-4 px-4 pb-6" data-panel="specialists">
					{error && <p className="text-xs text-destructive">{error.message}</p>}
					{list && templates && models && editing && (
						<SpecialistEditor
							initial={editing}
							list={list}
							templates={templates}
							models={models}
							busy={busy}
							onSave={submit}
							onSaveTemplate={submitTemplate}
							onCancel={() => setEditing(null)}
						/>
					)}
					{list && !editing && (
						<>
							<Button onClick={() => setEditing(emptyDraft())}>
								New specialist
							</Button>
							{list.specialists.length === 0 && (
								<p className="text-xs text-muted-foreground">
									No specialists yet. Tasks use the default workflow with the
									global role models (Settings › Models & Cost).
								</p>
							)}
							{list.specialists.map((s) => (
								<SpecialistCard
									key={s.id}
									specialist={s}
									busy={busy}
									onEdit={() => setEditing(toDraft(s))}
									onRemove={() => remove.mutate({ workspaceId, id: s.id })}
								/>
							))}
						</>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
