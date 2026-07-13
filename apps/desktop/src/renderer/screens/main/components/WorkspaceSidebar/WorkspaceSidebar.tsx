import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { LuClock, LuKanban, LuMessageSquare, LuPlus } from "react-icons/lu";
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

			{!isCollapsed && (
				<>
					<Link
						to="/chat"
						className="mx-2 mb-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						activeProps={{ className: "bg-muted text-foreground" }}
					>
						<LuMessageSquare className="size-4" />
						Chat
					</Link>
					<Link
						to="/board"
						className="mx-2 mb-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						activeProps={{ className: "bg-muted text-foreground" }}
					>
						<LuKanban className="size-4" />
						Task Board
					</Link>
					<Link
						to="/schedules"
						className="mx-2 mb-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						activeProps={{ className: "bg-muted text-foreground" }}
					>
						<LuClock className="size-4" />
						Schedules
					</Link>
				</>
			)}
			{!isCollapsed && <PortsList />}
		</SidebarDropZone>
	);
}
