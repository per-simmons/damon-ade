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
import { useState } from "react";
import {
	type EffortLevel,
	type ModelCatalog,
	type RoleDraft,
	SOURCE_LABELS,
} from "../../../../types";

const INHERIT = "__inherit__";
const CUSTOM = "__custom__";
const EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

interface RoleRowProps {
	label: string;
	/** The value the role has without this specialist's own settings. */
	inherited: {
		model: string;
		effort: string;
		maxTurns: number;
		source: { model: string; effort: string; maxTurns: string };
	};
	value: RoleDraft;
	models: ModelCatalog["models"];
	onChange: (value: RoleDraft) => void;
}

/**
 * One base role of a specialist: model, reasoning effort, maximum turns and
 * extra instructions. Empty fields inherit; the effective value and where
 * it comes from are shown, and Reset returns to inheriting.
 */
export function RoleRow({
	label,
	inherited,
	value,
	models,
	onChange,
}: RoleRowProps) {
	const [showInstructions, setShowInstructions] = useState(
		!!value.instructions,
	);
	const knownModel =
		!value.model || models.some((m) => m.value === value.model);
	const modelValue = value.model
		? knownModel
			? value.model
			: CUSTOM
		: INHERIT;
	const effective = {
		model: value.model ?? inherited.model,
		effort: value.effort ?? inherited.effort,
		maxTurns: value.maxTurns ?? inherited.maxTurns,
	};
	const source = (key: "model" | "effort" | "maxTurns") =>
		value[key] !== undefined
			? SOURCE_LABELS.specialist
			: (SOURCE_LABELS[inherited.source[key]] ?? inherited.source[key]);
	const customized =
		value.model !== undefined ||
		value.effort !== undefined ||
		value.maxTurns !== undefined ||
		!!value.instructions;

	return (
		<div className="space-y-2 rounded border p-2" data-role-row={label}>
			<div className="flex items-center justify-between">
				<p className="text-sm font-medium">{label}</p>
				{customized && (
					<Button
						size="sm"
						variant="ghost"
						className="h-6 px-2 text-xs"
						onClick={() => onChange({})}
					>
						Reset to inherited
					</Button>
				)}
			</div>
			<div className="grid grid-cols-3 gap-2 text-xs">
				<div className="space-y-1">
					<span className="text-muted-foreground">Model</span>
					<Select
						value={modelValue}
						onValueChange={(v) =>
							onChange({
								...value,
								model: v === INHERIT ? undefined : v === CUSTOM ? "" : v,
							})
						}
					>
						<SelectTrigger
							className="h-8 text-xs"
							aria-label={`${label} model`}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={INHERIT}>
								Inherit ({inherited.model})
							</SelectItem>
							{models.map((m) => (
								<SelectItem key={m.value} value={m.value}>
									{m.label}
									{m.priced ? "" : " (unpriced)"}
								</SelectItem>
							))}
							<SelectItem value={CUSTOM}>Other Claude model ID…</SelectItem>
						</SelectContent>
					</Select>
					{modelValue === CUSTOM && (
						<Input
							className="h-8 text-xs"
							value={value.model ?? ""}
							placeholder="claude-…"
							aria-label={`${label} model ID`}
							onChange={(e) => onChange({ ...value, model: e.target.value })}
						/>
					)}
				</div>
				<div className="space-y-1">
					<span className="text-muted-foreground">Reasoning effort</span>
					<Select
						value={value.effort ?? INHERIT}
						onValueChange={(v) =>
							onChange({
								...value,
								effort: v === INHERIT ? undefined : (v as EffortLevel),
							})
						}
					>
						<SelectTrigger
							className="h-8 text-xs"
							aria-label={`${label} effort`}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={INHERIT}>
								Inherit ({inherited.effort})
							</SelectItem>
							{EFFORTS.map((e) => (
								<SelectItem key={e} value={e}>
									{e}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="space-y-1">
					<span
						className="text-muted-foreground"
						title="The most agent turns (model replies and tool calls) one run of this role may take before it stops. Not the number of agents, and not model quality."
					>
						Maximum turns
					</span>
					<Input
						type="number"
						min={1}
						max={500}
						className="h-8 text-xs"
						aria-label={`${label} maximum turns`}
						placeholder={`Inherit (${inherited.maxTurns})`}
						value={value.maxTurns ?? ""}
						onChange={(e) =>
							onChange({
								...value,
								maxTurns: e.target.value ? Number(e.target.value) : undefined,
							})
						}
					/>
				</div>
			</div>
			<p className="text-[11px] text-muted-foreground" data-role-effective>
				Runs on {effective.model} ({source("model")}), effort {effective.effort}{" "}
				({source("effort")}), at most {effective.maxTurns} turns (
				{source("maxTurns")}).
			</p>
			{showInstructions ? (
				<Textarea
					rows={3}
					className="text-xs"
					aria-label={`${label} extra instructions`}
					placeholder="Extra instructions for this role (added to its built-in instructions)"
					value={value.instructions ?? ""}
					onChange={(e) =>
						onChange({ ...value, instructions: e.target.value || undefined })
					}
				/>
			) : (
				<Button
					size="sm"
					variant="ghost"
					className="h-6 px-2 text-xs"
					onClick={() => setShowInstructions(true)}
				>
					Add instructions for this role
				</Button>
			)}
		</div>
	);
}
