import { Badge } from "@superset/ui/badge";
import { Button } from "@superset/ui/button";
import { Label } from "@superset/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@superset/ui/sheet";
import { toast } from "@superset/ui/sonner";
import { Textarea } from "@superset/ui/textarea";
import { useDeferredValue, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useLaunchInNewTab } from "./hooks/useLaunchInNewTab";

/**
 * The multi-model workflow for the current workspace's project: describe a
 * task, let ADE route it (or override), and run each stage on its model. Each
 * stage opens in its own terminal tab; plans and progress live in ADE, not in
 * the repository.
 */

type Route = "quick" | "implement" | "plan" | "exceptional";
type Stage = "quick" | "implement" | "plan" | "build" | "review" | "escalate";

const ROUTE_LABELS: Record<Route, string> = {
	quick: "Quick edit",
	implement: "Implement directly",
	plan: "Plan first",
	exceptional: "Exceptional (Fable plans)",
};

const STAGE_LABELS: Record<Stage, string> = {
	quick: "Make the change",
	implement: "Implement",
	plan: "Plan",
	build: "Build",
	review: "Review",
	escalate: "Escalate",
};

/** Stages each route can run, in order. */
const ROUTE_STAGES: Record<Route, Stage[]> = {
	quick: ["quick", "review", "escalate"],
	implement: ["implement", "review", "escalate"],
	plan: ["plan", "build", "review", "escalate"],
	exceptional: ["plan", "build", "review", "escalate"],
};

const MODEL_CHOICES = ["fable", "opus", "sonnet", "haiku"] as const;
const AUTO = "auto";

const usd = (value: number) => `$${value.toFixed(value < 1 ? 3 : 2)}`;

interface TasksSheetProps {
	workspaceId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function TasksSheet({
	workspaceId,
	open,
	onOpenChange,
}: TasksSheetProps) {
	const utils = electronTrpc.useUtils();
	const launchInNewTab = useLaunchInNewTab();
	const [description, setDescription] = useState("");
	const [route, setRoute] = useState<Route | typeof AUTO>(AUTO);
	const [model, setModel] = useState<string>(AUTO);
	const deferredDescription = useDeferredValue(description.trim());

	const { data, error } = electronTrpc.workflow.getProjectTasks.useQuery(
		{ workspaceId },
		// Statuses come from files the agents write; refresh while open.
		{ enabled: open, refetchInterval: open ? 5000 : false },
	);
	const { data: preview } = electronTrpc.workflow.classify.useQuery(
		{ description: deferredDescription },
		{ enabled: open && deferredDescription.length > 0 },
	);

	const onLaunched = (launch: {
		command: string;
		stage: string;
		model: string;
		slug: string;
	}) => {
		void launchInNewTab(
			workspaceId,
			`${STAGE_LABELS[launch.stage as Stage] ?? launch.stage} · ${launch.slug}`,
			launch.command,
		);
		toast.success(
			`${STAGE_LABELS[launch.stage as Stage]} started on ${launch.model}`,
		);
		void utils.workflow.getProjectTasks.invalidate({ workspaceId });
	};
	const onError = (err: { message: string }) => toast.error(err.message);

	const createTask = electronTrpc.workflow.createTask.useMutation({
		onSuccess: (launch) => {
			setDescription("");
			onLaunched(launch);
		},
		onError,
	});
	const launchStage = electronTrpc.workflow.launchStage.useMutation({
		onSuccess: onLaunched,
		onError,
	});

	const modelOverride = model === AUTO ? undefined : model;
	const busy = createTask.isPending || launchStage.isPending;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="w-[480px] sm:max-w-[480px] overflow-y-auto">
				<SheetHeader>
					<SheetTitle>Tasks{data ? ` · ${data.project.name}` : ""}</SheetTitle>
					<SheetDescription>
						Describe a task. ADE picks the cheapest route that fits; planning
						runs only when the task needs it.
					</SheetDescription>
				</SheetHeader>

				<div className="space-y-6 px-4 pb-6">
					<section className="space-y-3">
						<Textarea
							aria-label="Task description"
							placeholder="What should be done?"
							rows={4}
							value={description}
							onChange={(event) => setDescription(event.target.value)}
						/>
						{preview && route === AUTO && (
							<p className="text-xs text-muted-foreground">
								Route: <strong>{ROUTE_LABELS[preview.route]}</strong> on{" "}
								{preview.model} — {preview.reasons.join("; ")}
							</p>
						)}
						<div className="flex flex-wrap items-end gap-2">
							<div className="space-y-1">
								<Label className="text-xs">Route</Label>
								<Select
									value={route}
									onValueChange={(value) =>
										setRoute(value as Route | typeof AUTO)
									}
								>
									<SelectTrigger className="w-[190px]" aria-label="Route">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={AUTO}>Automatic</SelectItem>
										{(Object.keys(ROUTE_LABELS) as Route[]).map((r) => (
											<SelectItem key={r} value={r}>
												{ROUTE_LABELS[r]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1">
								<Label className="text-xs">Model</Label>
								<Select value={model} onValueChange={setModel}>
									<SelectTrigger
										className="w-[130px]"
										aria-label="Model override"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={AUTO}>By role</SelectItem>
										{MODEL_CHOICES.map((m) => (
											<SelectItem key={m} value={m}>
												{m}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<Button
								disabled={busy || !description.trim()}
								onClick={() =>
									createTask.mutate({
										workspaceId,
										description,
										route: route === AUTO ? undefined : route,
										model: modelOverride,
									})
								}
							>
								Start
							</Button>
						</div>
						<p className="text-xs text-muted-foreground">
							The model choice also applies to the stage buttons below.
						</p>
					</section>

					{error && <p className="text-sm text-destructive">{error.message}</p>}

					<section className="space-y-3">
						{data?.tasks.length === 0 && (
							<p className="text-sm text-muted-foreground">
								No tasks in this project yet.
							</p>
						)}
						{data?.tasks.map((task) => (
							<div key={task.slug} className="rounded-md border p-3 space-y-2">
								<div className="flex items-start justify-between gap-2">
									<div className="min-w-0">
										<p
											className="text-sm font-medium truncate"
											title={task.description}
										>
											{task.title}
										</p>
										<p className="text-xs text-muted-foreground">
											{ROUTE_LABELS[task.route as Route]} · {task.status}
											{task.openEscalations > 0
												? ` · ${task.openEscalations} open escalation(s)`
												: ""}
										</p>
									</div>
									<Badge variant="secondary" title={task.models.join(", ")}>
										{usd(task.usd)}
									</Badge>
								</div>
								<div className="flex flex-wrap gap-1.5">
									{ROUTE_STAGES[task.route as Route].map((stage) => {
										const isNext = stage === task.nextStage;
										return (
											<Button
												key={stage}
												size="sm"
												variant={isNext ? "default" : "outline"}
												disabled={busy}
												onClick={() =>
													launchStage.mutate({
														workspaceId,
														slug: task.slug,
														stage,
														model: modelOverride,
													})
												}
											>
												{STAGE_LABELS[stage]}
												{isNext && task.nextStageModel && !modelOverride
													? ` · ${task.nextStageModel}`
													: ""}
											</Button>
										);
									})}
								</div>
							</div>
						))}
					</section>

					{data && (
						<p className="text-xs text-muted-foreground break-all">
							This project: {usd(data.usage.usd)} estimated across{" "}
							{data.usage.sessions} recorded session(s). Plans and progress:{" "}
							{data.project.tasksDir}
							{data.runtime === "codex"
								? ". Codex runs every stage on its own model; handoffs between roles need Claude Code."
								: ""}
						</p>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
