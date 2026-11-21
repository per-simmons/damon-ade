import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { toast } from "@superset/ui/sonner";
import { Switch } from "@superset/ui/switch";
import { useEffect, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	isItemVisible,
	SETTING_ITEM_ID,
	type SettingItemId,
} from "../../../utils/settings-search";
import {
	EFFORTS,
	type Effort,
	MODEL_ALIASES,
	ROLES,
	type RoleName,
} from "./constants";

interface ModelsSettingsProps {
	visibleItems?: SettingItemId[] | null;
}

interface RoleDraft {
	model: string;
	effort: Effort;
	maxTurns: string;
}

interface Draft {
	roles: Record<RoleName, RoleDraft>;
	sessionWarnUsd: string;
	dailyWarnUsd: string;
	headlessMaxBudgetUsd: string;
	headlessMaxTurns: string;
	execution: ExecutionDraft;
}

type PermissionProfile = "edits" | "edits-and-checks" | "bypass";

interface ExecutionData {
	permissions: PermissionProfile;
	taskBudgetUsd: number;
	maxCorrections: number;
	maxReviewRounds: number;
	maxEscalations: number;
	pinModels: boolean;
	cheaperFallback: boolean;
}

interface ExecutionDraft {
	permissions: PermissionProfile;
	taskBudgetUsd: string;
	maxCorrections: string;
	maxReviewRounds: string;
	maxEscalations: string;
	pinModels: boolean;
	cheaperFallback: boolean;
}

type LimitKey =
	| "taskBudgetUsd"
	| "maxCorrections"
	| "maxReviewRounds"
	| "maxEscalations";

const PERMISSION_LABELS: Record<PermissionProfile, string> = {
	edits: "Edit files only",
	"edits-and-checks": "Edit files and run the approved checks",
	bypass: "Skip all permission checks (unsafe)",
};

interface SettingsData {
	roles: Record<RoleName, { model: string; effort: Effort; maxTurns: number }>;
	budgets: {
		sessionWarnUsd: number | null;
		dailyWarnUsd: number | null;
		headlessMaxBudgetUsd: number;
		headlessMaxTurns: number;
	};
	execution: ExecutionData;
}

function toDraft(settings: SettingsData): Draft {
	return {
		roles: Object.fromEntries(
			ROLES.map(({ name }) => [
				name,
				{
					model: settings.roles[name].model,
					effort: settings.roles[name].effort,
					maxTurns: String(settings.roles[name].maxTurns),
				},
			]),
		) as Record<RoleName, RoleDraft>,
		sessionWarnUsd: settings.budgets.sessionWarnUsd?.toString() ?? "",
		dailyWarnUsd: settings.budgets.dailyWarnUsd?.toString() ?? "",
		headlessMaxBudgetUsd: String(settings.budgets.headlessMaxBudgetUsd),
		headlessMaxTurns: String(settings.budgets.headlessMaxTurns),
		execution: {
			permissions: settings.execution.permissions,
			taskBudgetUsd: String(settings.execution.taskBudgetUsd),
			maxCorrections: String(settings.execution.maxCorrections),
			maxReviewRounds: String(settings.execution.maxReviewRounds),
			maxEscalations: String(settings.execution.maxEscalations),
			pinModels: settings.execution.pinModels,
			cheaperFallback: settings.execution.cheaperFallback,
		},
	};
}

/** Blank = off. */
function parseBudget(value: string): number | null {
	const trimmed = value.trim();
	return trimmed === "" ? null : Number(trimmed);
}

function ModelSelect({
	value,
	onChange,
	id,
}: {
	value: string;
	onChange: (value: string) => void;
	id?: string;
}) {
	const known = MODEL_ALIASES.some((alias) => alias.value === value);
	return (
		<Select value={value} onValueChange={onChange}>
			<SelectTrigger id={id} className="w-[190px]">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{MODEL_ALIASES.map((alias) => (
					<SelectItem key={alias.value} value={alias.value}>
						{alias.label}
					</SelectItem>
				))}
				{/* A full model ID set in workflow-settings.json stays selectable. */}
				{!known && <SelectItem value={value}>{value}</SelectItem>}
			</SelectContent>
		</Select>
	);
}

const usd = (value: number) => `$${value.toFixed(2)}`;

export function ModelsSettings({ visibleItems }: ModelsSettingsProps) {
	const showRouting = isItemVisible(
		SETTING_ITEM_ID.MODELS_ROUTING,
		visibleItems,
	);
	const showCost = isItemVisible(SETTING_ITEM_ID.MODELS_COST, visibleItems);

	const utils = electronTrpc.useUtils();
	const { data, isLoading } = electronTrpc.workflow.getSettings.useQuery();
	const { data: usage } = electronTrpc.workflow.getUsageSummary.useQuery();
	const [draft, setDraft] = useState<Draft | null>(null);

	useEffect(() => {
		if (data && !draft) setDraft(toDraft(data.settings));
	}, [data, draft]);

	const save = electronTrpc.workflow.setSettings.useMutation({
		onSuccess: (result) => {
			setDraft(toDraft(result.settings));
			utils.workflow.getSettings.invalidate();
			toast.success(
				result.projectsUpdated > 0
					? `Saved. Applies to ${result.projectsUpdated} project(s) from the next session.`
					: "Saved.",
			);
		},
		onError: (error) => toast.error(error.message),
	});

	if (isLoading || !data || !draft) {
		return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
	}

	const setRole = (role: RoleName, patch: Partial<RoleDraft>) =>
		setDraft({
			...draft,
			roles: { ...draft.roles, [role]: { ...draft.roles[role], ...patch } },
		});

	const handleSave = () => {
		save.mutate({
			roles: Object.fromEntries(
				ROLES.map(({ name }) => [
					name,
					{
						model: draft.roles[name].model,
						effort: draft.roles[name].effort,
						maxTurns: Number(draft.roles[name].maxTurns),
					},
				]),
			) as Record<
				RoleName,
				{ model: string; effort: Effort; maxTurns: number }
			>,
			budgets: {
				sessionWarnUsd: parseBudget(draft.sessionWarnUsd),
				dailyWarnUsd: parseBudget(draft.dailyWarnUsd),
				headlessMaxBudgetUsd: Number(draft.headlessMaxBudgetUsd),
				headlessMaxTurns: Number(draft.headlessMaxTurns),
			},
			execution: {
				permissions: draft.execution.permissions,
				taskBudgetUsd: Number(draft.execution.taskBudgetUsd),
				maxCorrections: Number(draft.execution.maxCorrections),
				maxReviewRounds: Number(draft.execution.maxReviewRounds),
				maxEscalations: Number(draft.execution.maxEscalations),
				pinModels: draft.execution.pinModels,
				cheaperFallback: draft.execution.cheaperFallback,
			},
		});
	};

	const setExecution = (patch: Partial<ExecutionDraft>) =>
		setDraft({ ...draft, execution: { ...draft.execution, ...patch } });

	const limitInput = (id: string, label: string, key: LimitKey, step = "1") => (
		<div className="flex items-center justify-between">
			<Label htmlFor={id} className="text-sm font-medium">
				{label}
			</Label>
			<Input
				id={id}
				type="number"
				min={0}
				step={step}
				className="w-[120px]"
				value={draft.execution[key]}
				onChange={(event) => setExecution({ [key]: event.target.value })}
			/>
		</div>
	);

	return (
		<div className="p-6 max-w-4xl w-full">
			<div className="mb-8">
				<h2 className="text-xl font-semibold">Models & Cost</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Which model each workflow role runs on, and when to warn about cost.
					Costs are estimates at Anthropic API list prices.
				</p>
			</div>

			<div className="space-y-8">
				{showRouting && (
					<section className="space-y-4">
						<div>
							<h3 className="text-sm font-medium">Workflow models</h3>
							<p className="text-xs text-muted-foreground mt-1">
								Applies to every project in ADE: each task stage runs on its
								role's model, and Claude sessions can hand work to these roles.
								Takes effect for sessions started after you save.
							</p>
						</div>

						{ROLES.map((role) => (
							<div
								key={role.name}
								className="flex items-center justify-between gap-4"
							>
								<div className="space-y-0.5 min-w-0">
									<Label className="text-sm font-medium">{role.label}</Label>
									<p className="text-xs text-muted-foreground">
										{role.description}
									</p>
								</div>
								<div className="flex items-center gap-2 shrink-0">
									<ModelSelect
										value={draft.roles[role.name].model}
										onChange={(model) => setRole(role.name, { model })}
									/>
									<Select
										value={draft.roles[role.name].effort}
										onValueChange={(effort) =>
											setRole(role.name, { effort: effort as Effort })
										}
									>
										<SelectTrigger
											className="w-[110px]"
											aria-label={`${role.label} effort`}
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{EFFORTS.map((effort) => (
												<SelectItem key={effort} value={effort}>
													{effort}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<Input
										type="number"
										min={1}
										className="w-[90px]"
										aria-label={`${role.label} turn limit`}
										value={draft.roles[role.name].maxTurns}
										onChange={(event) =>
											setRole(role.name, { maxTurns: event.target.value })
										}
									/>
								</div>
							</div>
						))}
						<p className="text-xs text-muted-foreground">
							Columns: model, effort, turn limit. ADE passes all three to the
							runs it starts for tasks. In a session you start yourself, the
							roles it hands work to get these models, but ADE cannot enforce
							the effort or turn limit there.
						</p>
					</section>
				)}

				{showRouting && (
					<section className="space-y-4">
						<div>
							<h3 className="text-sm font-medium">Task runs</h3>
							<p className="text-xs text-muted-foreground mt-1">
								How ADE runs the stages of a task, in Auto and Manual mode. Each
								stage is a Claude Code run that ADE starts, watches and stops.
							</p>
						</div>
						<div className="flex items-center justify-between gap-4">
							<Label htmlFor="task-permissions" className="text-sm font-medium">
								Permissions
							</Label>
							<Select
								value={draft.execution.permissions}
								onValueChange={(value) =>
									setExecution({ permissions: value as PermissionProfile })
								}
							>
								<SelectTrigger id="task-permissions" className="w-[300px]">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{(Object.keys(PERMISSION_LABELS) as PermissionProfile[]).map(
										(profile) => (
											<SelectItem key={profile} value={profile}>
												{PERMISSION_LABELS[profile]}
											</SelectItem>
										),
									)}
								</SelectContent>
							</Select>
						</div>
						{draft.execution.permissions === "bypass" && (
							<p className="text-xs text-destructive">
								Runs may execute any command without asking, including commands
								that delete files or reach the network. Use this only in a
								disposable worktree.
							</p>
						)}
						{limitInput(
							"task-budget",
							"Budget per task ($)",
							"taskBudgetUsd",
							"0.5",
						)}
						<p className="text-xs text-muted-foreground">
							Once a task's estimated spend reaches this, ADE starts no further
							run. Each run gets only the remainder as its Claude Code spending
							limit. Claude Code checks that limit as the run goes, so a run can
							end slightly above it.
						</p>
						{limitInput(
							"task-corrections",
							"Corrections per task",
							"maxCorrections",
						)}
						{limitInput(
							"task-reviews",
							"Review rounds per task",
							"maxReviewRounds",
						)}
						{limitInput(
							"task-escalations",
							"Escalations per task",
							"maxEscalations",
						)}
						<div className="flex items-center justify-between gap-4">
							<div className="space-y-0.5">
								<Label htmlFor="pin-models" className="text-sm font-medium">
									Pin model versions
								</Label>
								<p className="text-xs text-muted-foreground">
									Run aliases as the exact model IDs ADE knows. ADE skips this
									when you use Bedrock, Vertex or Foundry, or set your own model
									environment variables.
								</p>
							</div>
							<Switch
								id="pin-models"
								checked={draft.execution.pinModels}
								onCheckedChange={(pinModels) => setExecution({ pinModels })}
							/>
						</div>
						<div className="flex items-center justify-between gap-4">
							<div className="space-y-0.5">
								<Label
									htmlFor="cheaper-fallback"
									className="text-sm font-medium"
								>
									Retry once on a cheaper model
								</Label>
								<p className="text-xs text-muted-foreground">
									When a model is unavailable to your account, ADE retries that
									stage once on the next cheaper model. It never moves to a more
									expensive one.
								</p>
							</div>
							<Switch
								id="cheaper-fallback"
								checked={draft.execution.cheaperFallback}
								onCheckedChange={(cheaperFallback) =>
									setExecution({ cheaperFallback })
								}
							/>
						</div>
					</section>
				)}

				{showCost && (
					<section className="space-y-4">
						<div>
							<h3 className="text-sm font-medium">Cost warnings</h3>
							<p className="text-xs text-muted-foreground mt-1">
								A notification when estimated cost passes a threshold. These are
								warnings only: sessions you run yourself are not stopped. Leave
								a field blank to turn that warning off.
							</p>
						</div>

						{usage && (
							<p className="text-xs text-muted-foreground">
								API-equivalent estimate, not a charge on a subscription.
								Recorded today: {usd(usage.todayUsd)}
								{usage.todayUnpriced > 0 ? " plus unpriced responses" : ""} ·
								all recorded sessions ({usage.sessions}):{" "}
								{usd(usage.allTimeUsd)}
								{usage.allTimeUnpriced > 0
									? ` plus ${usage.allTimeUnpriced} unpriced response(s)`
									: ""}
							</p>
						)}

						<div className="flex items-center justify-between">
							<Label htmlFor="session-warn" className="text-sm font-medium">
								Warn when one session passes ($)
							</Label>
							<Input
								id="session-warn"
								type="number"
								min={0}
								step="0.5"
								className="w-[120px]"
								placeholder="Off"
								value={draft.sessionWarnUsd}
								onChange={(event) =>
									setDraft({ ...draft, sessionWarnUsd: event.target.value })
								}
							/>
						</div>
						<div className="flex items-center justify-between">
							<Label htmlFor="daily-warn" className="text-sm font-medium">
								Warn when today passes ($)
							</Label>
							<Input
								id="daily-warn"
								type="number"
								min={0}
								step="1"
								className="w-[120px]"
								placeholder="Off"
								value={draft.dailyWarnUsd}
								onChange={(event) =>
									setDraft({ ...draft, dailyWarnUsd: event.target.value })
								}
							/>
						</div>

						<div className="pt-2">
							<h3 className="text-sm font-medium">Unattended runs</h3>
							<p className="text-xs text-muted-foreground mt-1">
								Hard limits for background agent runs started with{" "}
								<code className="bg-muted px-1 rounded">mode: "headless"</code>{" "}
								on /agent/invoke. Claude Code stops the run once it passes
								either limit. The last turn can take it slightly over the
								spending limit, so treat that limit as a cap, not an exact
								ceiling.
							</p>
						</div>
						<div className="flex items-center justify-between">
							<Label htmlFor="headless-budget" className="text-sm font-medium">
								Spending limit per run ($)
							</Label>
							<Input
								id="headless-budget"
								type="number"
								min={0}
								step="0.5"
								className="w-[120px]"
								value={draft.headlessMaxBudgetUsd}
								onChange={(event) =>
									setDraft({
										...draft,
										headlessMaxBudgetUsd: event.target.value,
									})
								}
							/>
						</div>
						<div className="flex items-center justify-between">
							<Label htmlFor="headless-turns" className="text-sm font-medium">
								Turn limit per run
							</Label>
							<Input
								id="headless-turns"
								type="number"
								min={1}
								className="w-[120px]"
								value={draft.headlessMaxTurns}
								onChange={(event) =>
									setDraft({ ...draft, headlessMaxTurns: event.target.value })
								}
							/>
						</div>
					</section>
				)}

				<div className="flex items-center gap-2">
					<Button onClick={handleSave} disabled={save.isPending}>
						{save.isPending ? "Saving…" : "Save"}
					</Button>
					<Button
						variant="outline"
						onClick={() => setDraft(toDraft(data.defaults))}
						disabled={save.isPending}
					>
						Reset to defaults
					</Button>
				</div>
			</div>
		</div>
	);
}
