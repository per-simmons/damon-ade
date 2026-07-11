import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
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
import { Textarea } from "@superset/ui/textarea";
import { useEffect, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { ScheduleAgent } from "../../types";

const CRON_PRESETS: { label: string; expression: string }[] = [
	{ label: "Every hour", expression: "0 * * * *" },
	{ label: "Every morning at 9", expression: "0 9 * * *" },
	{ label: "Weekdays at 9", expression: "0 9 * * 1-5" },
	{ label: "Every 30 minutes", expression: "*/30 * * * *" },
	{ label: "Sundays at 8", expression: "0 8 * * 0" },
	{ label: "Custom…", expression: "" },
];

interface NewScheduleDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agents: ScheduleAgent[];
}

/** Create a recurring dispatch: name, cadence, agent, and the prompt to run. */
export function NewScheduleDialog({
	open,
	onOpenChange,
	agents,
}: NewScheduleDialogProps) {
	const utils = electronTrpc.useUtils();
	const createSchedule = electronTrpc.schedules.create.useMutation({
		onSuccess: () => utils.schedules.getAll.invalidate(),
	});

	const [name, setName] = useState("");
	const [preset, setPreset] = useState(CRON_PRESETS[1].expression);
	const [customCron, setCustomCron] = useState("");
	const [agentId, setAgentId] = useState<string>("");
	const [prompt, setPrompt] = useState("");

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on each open
	useEffect(() => {
		if (open) {
			setName("");
			setPreset(CRON_PRESETS[1].expression);
			setCustomCron("");
			setAgentId(agents[0]?.id ?? "");
			setPrompt("");
		}
	}, [open]);

	const cronExpression = preset === "" ? customCron.trim() : preset;
	const canCreate =
		name.trim().length > 0 &&
		cronExpression.length > 0 &&
		agentId.length > 0 &&
		prompt.trim().length > 0 &&
		!createSchedule.isPending;

	const handleCreate = async () => {
		if (!canCreate) return;
		try {
			await createSchedule.mutateAsync({
				name: name.trim(),
				cronExpression,
				workspaceId: agentId,
				prompt: prompt.trim(),
			});
			onOpenChange(false);
			toast.success("Schedule created");
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to create schedule",
			);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[480px]">
				<DialogHeader>
					<DialogTitle>New schedule</DialogTitle>
					<DialogDescription>
						Runs the prompt in the agent's worktree on a cron cadence (local
						time), while ADE is open.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4 py-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="schedule-name">Name</Label>
						<Input
							id="schedule-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="e.g. Morning issue triage"
						/>
					</div>

					<div className="flex gap-3">
						<div className="flex flex-1 flex-col gap-1.5">
							<Label>Cadence</Label>
							<Select value={preset} onValueChange={setPreset}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{CRON_PRESETS.map((p) => (
										<SelectItem key={p.label} value={p.expression}>
											{p.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div className="flex flex-1 flex-col gap-1.5">
							<Label>Agent</Label>
							<Select value={agentId} onValueChange={setAgentId}>
								<SelectTrigger>
									<SelectValue placeholder="Pick an agent" />
								</SelectTrigger>
								<SelectContent>
									{agents.map((agent) => (
										<SelectItem key={agent.id} value={agent.id}>
											{agent.name}
											<span className="text-muted-foreground">
												{" "}
												· {agent.teamName}
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>

					{preset === "" && (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="schedule-cron">Cron expression</Label>
							<Input
								id="schedule-cron"
								value={customCron}
								onChange={(e) => setCustomCron(e.target.value)}
								placeholder="0 9 * * 1-5"
								className="font-mono"
							/>
						</div>
					)}

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="schedule-prompt">Prompt</Label>
						<Textarea
							id="schedule-prompt"
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							rows={5}
							placeholder="What should the agent do each run? e.g. Review open GitHub issues, triage new ones, and update TRIAGE.md with anything urgent."
							className="resize-none"
						/>
					</div>
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button onClick={handleCreate} disabled={!canCreate}>
						Create
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
