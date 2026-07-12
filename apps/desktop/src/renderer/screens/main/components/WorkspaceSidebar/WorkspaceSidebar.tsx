import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { LuPlus, LuRoute } from "react-icons/lu";
import { useWorkspaceShortcuts } from "renderer/hooks/useWorkspaceShortcuts";
import { useOpenNewCategoryModal } from "renderer/stores/new-category-modal";
import { PortsList } from "./PortsList";
import { ProjectSection } from "./ProjectSection";
import { SidebarDropZone } from "./SidebarDropZone";

interface WorkspaceSidebarProps {
	isCollapsed?: boolean;
	activeProjectId: string | null;
	activeProjectName: string | null;
}

export function WorkspaceSidebar({
	isCollapsed = false,
}: WorkspaceSidebarProps) {
	const { groups } = useWorkspaceShortcuts();
	const openNewCategory = useOpenNewCategoryModal();
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	const isRouterActive = !!matchRoute({ to: "/router", fuzzy: true });

	// Calculate shortcut base indices for each project group using cumulative offsets
	const projectShortcutIndices = useMemo(
		() =>
			groups.reduce<{ indices: number[]; cumulative: number }>(
				(acc, group) => ({
					indices: [...acc.indices, acc.cumulative],
					cumulative: acc.cumulative + group.workspaces.length,
				}),
				{ indices: [], cumulative: 0 },
			).indices,
		[groups],
	);

	return (
		<SidebarDropZone className="flex flex-col h-full bg-muted/45 dark:bg-muted/35">
			{!isCollapsed && (
				<div className="flex items-center justify-between px-3 h-10 shrink-0">
					<span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
						Teams
					</span>
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={() => openNewCategory()}
								className="flex items-center justify-center size-6 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
								aria-label="New team"
							>
								<LuPlus className="size-4" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="right">New team</TooltipContent>
					</Tooltip>
				</div>
			)}
			<div
				className={cn(
					"shrink-0 border-b border-border/70",
					isCollapsed ? "flex justify-center py-2" : "px-2 pb-2",
				)}
			>
				<Tooltip delayDuration={300}>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={() => navigate({ to: "/router" })}
							className={cn(
								"flex items-center rounded-md text-sm transition-colors",
								isCollapsed
									? "size-8 justify-center"
									: "h-8 w-full gap-2 px-2 text-left",
								isRouterActive
									? "bg-muted text-foreground"
									: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
							)}
							aria-label="Router dashboard"
						>
							<LuRoute className="size-4 shrink-0" />
							{!isCollapsed && (
								<>
									<span className="min-w-0 flex-1 truncate">Router</span>
									<span className="rounded border px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
										9R
									</span>
								</>
							)}
						</button>
					</TooltipTrigger>
					<TooltipContent side="right">Router dashboard</TooltipContent>
				</Tooltip>
			</div>
			<div className="flex-1 overflow-y-auto hide-scrollbar">
				{groups.map((group, index) => (
					<ProjectSection
						key={group.project.id}
						projectId={group.project.id}
						projectName={group.project.name}
						projectColor={group.project.color}
						githubOwner={group.project.githubOwner}
						mainRepoPath={group.project.mainRepoPath}
						hideImage={group.project.hideImage}
						iconUrl={group.project.iconUrl}
						workspaces={group.workspaces}
						shortcutBaseIndex={projectShortcutIndices[index]}
						index={index}
						isCollapsed={isCollapsed}
					/>
				))}

				{groups.length === 0 && !isCollapsed && (
					<div className="flex flex-col items-center justify-center h-32 text-muted-foreground text-sm px-4 text-center">
						<span>No teams yet</span>
						<button
							type="button"
							onClick={() => openNewCategory()}
							className="text-xs mt-2 text-foreground underline underline-offset-2"
						>
							Create your first team
						</button>
					</div>
				)}
			</div>

			{!isCollapsed && <PortsList />}
		</SidebarDropZone>
	);
}
