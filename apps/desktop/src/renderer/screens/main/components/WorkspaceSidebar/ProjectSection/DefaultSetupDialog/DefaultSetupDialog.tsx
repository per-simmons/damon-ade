import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { useState } from "react";
import { LuCheck, LuUsers } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface DefaultSetupDialogProps {
	projectId: string;
	teamName: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * Default setup: add a group of agents to a team, each with its specialty
 * already assigned ("<Template> Agent" owning the template's specialist).
 * Agents and specialists the team already has are kept as they are.
 */
export function DefaultSetupDialog({
	projectId,
	teamName,
	open,
	onOpenChange,
}: DefaultSetupDialogProps) {
	const utils = electronTrpc.useUtils();
	const { data: presets = [] } = electronTrpc.specialists.presets.useQuery(
		undefined,
		{ enabled: open },
	);
	const [chosen, setChosen] = useState("web-app");
	const preset = presets.find((p) => p.id === chosen);
	const apply = electronTrpc.specialists.applyPreset.useMutation({
		onSuccess: (result) => {
			toast.success(
				result.agentsAdded.length
					? `${result.preset}: added ${result.agentsAdded.length} agent(s) with their specialties`
					: `${result.preset}: the team already had these agents`,
			);
			void utils.workspaces.invalidate();
			void utils.specialists.invalidate();
			void utils.projects.invalidate();
			onOpenChange(false);
		},
		onError: (error) => toast.error(error.message),
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="sm:max-w-[620px]"
				data-default-setup
				// Opened from the team's menu, which hands focus back to the team row
				// as it closes: that must not close this dialog.
				onFocusOutside={(event) => event.preventDefault()}
			>
				<DialogHeader>
					<DialogTitle>Default setup · {teamName}</DialogTitle>
					<DialogDescription>
						Add a group of agents with their specialties already assigned. Each
						agent works in its own folder and branch of the team's repository.
						Agents the team already has are kept.
					</DialogDescription>
				</DialogHeader>
				<div className="grid grid-cols-2 gap-2">
					{presets.map((p) => (
						<button
							key={p.id}
							type="button"
							aria-pressed={chosen === p.id}
							onClick={() => setChosen(p.id)}
							className={cn(
								"relative space-y-1 rounded-lg border p-3 text-left transition-colors hover:bg-muted/40",
								chosen === p.id && "border-primary bg-primary/5",
							)}
							data-preset={p.id}
						>
							<span className="flex items-center justify-between gap-2">
								<span className="text-sm font-semibold">{p.name}</span>
								{chosen === p.id ? (
									<LuCheck className="size-4 text-primary" aria-hidden />
								) : (
									<span className="text-[11px] text-muted-foreground">
										{p.agents.length} agents
									</span>
								)}
							</span>
							<span className="block text-xs text-muted-foreground">
								{p.description}
							</span>
						</button>
					))}
				</div>
				{preset && (
					<div className="space-y-1.5 rounded-lg bg-muted/30 p-3">
						<p className="flex items-center gap-1.5 text-xs font-medium">
							<LuUsers className="size-3.5" aria-hidden />
							Adds {preset.agents.length} agents
						</p>
						<div className="flex flex-wrap gap-1">
							{preset.agents.map((a) => (
								<span
									key={a.templateId}
									className="rounded bg-background px-1.5 py-0.5 text-[11px]"
								>
									{a.name}
								</span>
							))}
						</div>
					</div>
				)}
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Not now
					</Button>
					<Button
						disabled={!preset || apply.isPending}
						onClick={() => apply.mutate({ projectId, presetId: chosen })}
					>
						{apply.isPending
							? "Adding agents…"
							: `Set up ${preset?.name ?? ""}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
