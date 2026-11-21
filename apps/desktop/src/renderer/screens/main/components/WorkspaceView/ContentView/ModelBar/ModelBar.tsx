import {
	type AgentBinary,
	type CheckedBinary,
	RUNTIME_BINARY,
} from "@superset/shared/agent-binaries";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	LuClipboardList,
	LuHistory,
	LuListTodo,
	LuMessagesSquare,
	LuUserCog,
} from "react-icons/lu";
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
import { TeamChatSheet } from "./components/TeamChatSheet";
import { useTeamChatTab } from "./hooks/useTeamChatTab";
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
	const [chatOpen, setChatOpen] = useState(false);
	// The team's Coordinator: a Claude Code tab that starts by itself.
	const teamChat = useTeamChatTab(workspaceId);
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

			<div className="ml-auto flex items-center gap-0.5">
				{ready && <GitHubSync workspaceId={workspaceId} />}
				<div className="mx-1 h-4 w-px bg-border" aria-hidden />
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							disabled={!ready}
							onClick={() => setSpecialistsOpen(true)}
							className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
						>
							<LuUserCog className="size-3.5" aria-hidden />
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
							className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
						>
							<LuHistory className="size-3.5" aria-hidden />
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
							className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
						>
							<LuListTodo className="size-3.5" aria-hidden />
							Tasks
						</button>
					</TooltipTrigger>
					<TooltipContent side="bottom" showArrow={false}>
						Auto: describe a task; ADE runs it through checks and review to a
						verified finish
					</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							disabled={!ready}
							onClick={() => setChatOpen(true)}
							className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
						>
							<LuClipboardList className="size-3.5" aria-hidden />
							Team plans
						</button>
					</TooltipTrigger>
					<TooltipContent side="bottom" showArrow={false}>
						Every team plan and how far it got; you can also plan one here
					</TooltipContent>
				</Tooltip>
				{teamChat.available && (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={teamChat.open}
								className="ml-1 flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90"
							>
								<LuMessagesSquare className="size-3.5" aria-hidden />
								Team chat
							</button>
						</TooltipTrigger>
						<TooltipContent side="bottom" showArrow={false}>
							Claude Code as your team's Coordinator: plan the work together,
							say go, and it hands each part to the right agent
						</TooltipContent>
					</Tooltip>
				)}
			</div>

			<TasksSheet
				workspaceId={workspaceId}
				open={tasksOpen}
				onOpenChange={setTasksOpen}
			/>

			<TeamChatSheet
				workspaceId={workspaceId}
				open={chatOpen}
				onOpenChange={setChatOpen}
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
