import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { Textarea } from "@superset/ui/textarea";
import {
	type CustomRoleDraft,
	type ModelCatalog,
	TRIGGER_LABELS,
} from "../../../../types";

const INHERIT = "__inherit__";

interface CustomRoleEditorProps {
	role: CustomRoleDraft;
	models: ModelCatalog["models"];
	onChange: (role: CustomRoleDraft) => void;
	onRemove: () => void;
}

/**
 * A custom role: what it does, its prompt, when the manager runs it, whether
 * it may edit files, and its model. Read-only roles end with a verdict; a
 * FAIL sends the work back for a bounded correction.
 */
export function CustomRoleEditor({
	role,
	models,
	onChange,
	onRemove,
}: CustomRoleEditorProps) {
	const set = (patch: Partial<CustomRoleDraft>) =>
		onChange({ ...role, ...patch });
	return (
		<div
			className="space-y-2 rounded border p-2 text-xs"
			data-custom-role={role.name}
		>
			<div className="flex gap-2">
				<Input
					className="h-8 text-xs"
					aria-label="Role name"
					placeholder="Role name, e.g. Accessibility Reviewer"
					value={role.name}
					onChange={(e) => set({ name: e.target.value })}
				/>
				<Button
					size="sm"
					variant="ghost"
					className="h-8 text-xs"
					onClick={onRemove}
				>
					Remove
				</Button>
			</div>
			<Input
				className="h-8 text-xs"
				aria-label="Role description"
				placeholder="What it is responsible for"
				value={role.description}
				onChange={(e) => set({ description: e.target.value })}
			/>
			<Textarea
				rows={3}
				className="text-xs"
				aria-label="Role instructions"
				placeholder="Instructions (its prompt)"
				value={role.instructions}
				onChange={(e) => set({ instructions: e.target.value })}
			/>
			<div className="grid grid-cols-2 gap-2">
				<div className="space-y-1">
					<span className="text-muted-foreground">When it runs</span>
					<Select
						value={role.trigger}
						onValueChange={(v) =>
							set({ trigger: v as CustomRoleDraft["trigger"] })
						}
					>
						<SelectTrigger className="h-8 text-xs" aria-label="When it runs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{Object.entries(TRIGGER_LABELS).map(([value, label]) => (
								<SelectItem key={value} value={value}>
									{label}
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
							set({ access: v as CustomRoleDraft["access"] })
						}
					>
						<SelectTrigger className="h-8 text-xs" aria-label="File access">
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
							set({
								keywords: e.target.value
									.split(",")
									.map((k) => k.trim())
									.filter(Boolean),
							})
						}
					/>
				</div>
				<div className="space-y-1">
					<span className="text-muted-foreground">Model</span>
					<Select
						value={role.model ?? INHERIT}
						onValueChange={(v) => set({ model: v === INHERIT ? undefined : v })}
					>
						<SelectTrigger className="h-8 text-xs" aria-label="Role model">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={INHERIT}>
								Inherit (
								{role.access === "read-only" ? "Reviewer" : "Implementer"})
							</SelectItem>
							{models.map((m) => (
								<SelectItem key={m.value} value={m.value}>
									{m.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>
			<Input
				className="h-8 text-xs"
				aria-label="Expected output"
				placeholder="What it must return"
				value={role.expectedOutput}
				onChange={(e) => set({ expectedOutput: e.target.value })}
			/>
		</div>
	);
}
