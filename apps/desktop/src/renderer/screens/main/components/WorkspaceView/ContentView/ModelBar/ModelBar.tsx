import {
	type AgentBinary,
	type CheckedBinary,
	RUNTIME_BINARY,
} from "@superset/shared/agent-binaries";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	getPresetIcon,
	useIsDarkTheme,
} from "renderer/assets/app-icons/preset-icons";
import { BinaryInstallDialog } from "renderer/components/BinaryInstallDialog/BinaryInstallDialog";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useRuntimeAvailability } from "renderer/stores/model-bar/useRuntimeAvailability";
import { useAgentSession } from "renderer/stores/tabs/useAgentSession";
import { GitHubSync } from "./components/GitHubSync";
import { HistorySheet } from "./components/HistorySheet";
import { SpecialistsSheet } from "./components/SpecialistsSheet";
import { TasksSheet } from "./components/TasksSheet";
import { MODEL_BAR_MODELS, type ModelDescriptor } from "./models";

/**
 * A quiet row of model logos below the session tab strip. Clicking a logo opens
 * a new session in the current agent's worktree running that model's CLI
 * (Claude Code or Codex).
 */
export function ModelBar() {
	const { workspaceId } = useParams({ strict: false });
	const isDark = useIsDarkTheme();
	const { spawnAgentSession } = useAgentSession();
	const { isAvailable, recheck, isFetching } = useRuntimeAvailability();

	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId! },
		{ enabled: !!workspaceId },
	);

	const [installBinary, setInstallBinary] = useState<AgentBinary | null>(null);
	const [tasksOpen, setTasksOpen] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [specialistsOpen, setSpecialistsOpen] = useState(false);

	// Close the install dialog once a re-check confirms the tool is now present.
	useEffect(() => {
		if (installBinary && isAvailable(installBinary as CheckedBinary)) {
			setInstallBinary(null);
		}
	}, [installBinary, isAvailable]);

	if (!workspaceId) return null;

	const worktreePath = workspace?.worktreePath ?? null;
	const ready = !!worktreePath;

	const spawn = (model: ModelDescriptor) => {
		spawnAgentSession({
			id: workspaceId,
			runtime: model.runtime,
			worktreePath,
		});
	};

	const handleModelClick = (model: ModelDescriptor) => {
		if (!ready) return;
		// The runtime's CLI must be installed before we spawn it.
		const binary = RUNTIME_BINARY[model.runtime];
		if (!isAvailable(binary as CheckedBinary)) {
			setInstallBinary(binary);
			return;
		}
		spawn(model);
	};

	return (
		<div className="flex h-9 shrink-0 items-center gap-0.5 border-b bg-background px-2">
			<div
				className={`flex items-center gap-0.5 ${
					ready ? "" : "pointer-events-none opacity-40"
				}`}
			>
				{MODEL_BAR_MODELS.map((model) => {
					const icon = getPresetIcon(model.iconName, isDark);
					const binary = RUNTIME_BINARY[model.runtime];
					const missing = !isAvailable(binary as CheckedBinary);
					return (
						<Tooltip key={model.runtime}>
							<TooltipTrigger asChild>
								<button
									type="button"
									aria-label={
										missing
											? `${model.label} — not detected, click to install`
											: `New interactive ${model.label} session (not a managed task)`
									}
									disabled={!ready}
									onClick={() => handleModelClick(model)}
									className="group relative flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted"
								>
									{icon ? (
										<img
											src={icon}
											alt=""
											className={`h-4 w-4 object-contain transition-opacity group-hover:opacity-100 ${
												missing
													? "opacity-30 grayscale group-hover:opacity-60"
													: model.isDefault
														? "opacity-90"
														: "opacity-55"
											}`}
										/>
									) : (
										<span className="text-[10px] text-muted-foreground">
											{model.label.slice(0, 2)}
										</span>
									)}
									{model.isDefault && !missing && (
										<span className="absolute -bottom-px h-[3px] w-[3px] rounded-full bg-foreground/40" />
									)}
									{missing && (
										<span className="absolute -right-px -top-px h-[5px] w-[5px] rounded-full bg-amber-500 ring-1 ring-background" />
									)}
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom" showArrow={false}>
								{missing
									? `${model.label} not detected — click to install`
									: `New interactive ${model.label} session${model.isDefault ? " · default" : ""}. For Auto, use Tasks.`}
							</TooltipContent>
						</Tooltip>
					);
				})}
			</div>

			<div className="ml-auto flex items-center">
				{ready && <GitHubSync workspaceId={workspaceId} />}
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							disabled={!ready}
							onClick={() => setSpecialistsOpen(true)}
							className="flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
						>
							Specialists
						</button>
					</TooltipTrigger>
					<TooltipContent side="bottom" showArrow={false}>
						Optional specialists (UI, Backend, your own…) with their own
						instructions and their own Roles
					</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							disabled={!ready}
							onClick={() => setHistoryOpen(true)}
							className="flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
						>
							History
						</button>
					</TooltipTrigger>
					<TooltipContent side="bottom" showArrow={false}>
						Link earlier Claude Code sessions and Claude app chats to this
						project; tasks use the relevant parts as history
					</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							disabled={!ready}
							onClick={() => setTasksOpen(true)}
							className="flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
						>
							Tasks
						</button>
					</TooltipTrigger>
					<TooltipContent side="bottom" showArrow={false}>
						Auto: describe a task; ADE runs it through checks and review to a
						verified finish
					</TooltipContent>
				</Tooltip>
			</div>

			<TasksSheet
				workspaceId={workspaceId}
				open={tasksOpen}
				onOpenChange={setTasksOpen}
			/>

			<SpecialistsSheet
				workspaceId={workspaceId}
				open={specialistsOpen}
				onOpenChange={setSpecialistsOpen}
			/>

			<HistorySheet
				workspaceId={workspaceId}
				open={historyOpen}
				onOpenChange={setHistoryOpen}
				onStartTask={() => {
					setHistoryOpen(false);
					setTasksOpen(true);
				}}
			/>

			<BinaryInstallDialog
				binary={installBinary}
				onOpenChange={(open) => !open && setInstallBinary(null)}
				onRecheck={recheck}
				isRechecking={isFetching}
			/>
		</div>
	);
}
