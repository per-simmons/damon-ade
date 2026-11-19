import { useParams } from "@tanstack/react-router";
import { HiOutlineWifi } from "react-icons/hi2";
import { useOnlineStatus } from "renderer/hooks/useOnlineStatus";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { NavigationControls } from "./components/NavigationControls";
import { OpenInMenuButton } from "./components/OpenInMenuButton";
import { OrganizationDropdown } from "./components/OrganizationDropdown";
import { ResourceConsumption } from "./components/ResourceConsumption";
import { SidebarToggle } from "./components/SidebarToggle";

export function TopBar() {
	const { data: platform } = electronTrpc.window.getPlatform.useQuery();
	const { workspaceId } = useParams({ strict: false });
	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId ?? "" },
		{ enabled: !!workspaceId },
	);
	const isOnline = useOnlineStatus();
	// Default to Mac layout while loading to avoid overlap with traffic lights
	const isMac = platform === undefined || platform === "darwin";

	return (
		<div
			className={`${isMac ? "drag " : ""}gap-2 h-12 w-full flex items-center justify-between bg-muted/45 border-b border-border relative dark:bg-muted/35`}
		>
			<div
				className="flex items-center gap-1.5 h-full"
				style={{
					paddingLeft: isMac ? "88px" : "16px",
				}}
			>
				<SidebarToggle />
				<NavigationControls />
				<ResourceConsumption />
			</div>

			{workspace?.project?.name && (
				<div className="absolute inset-0 flex items-center justify-center pointer-events-none">
					<div className="flex items-center gap-2 max-w-[calc(100vw-36rem)] lg:max-w-[calc(100vw-52rem)]">
						{workspace.iconUrl && (
							<img
								src={workspace.iconUrl}
								alt=""
								className="size-5 shrink-0 rounded-full object-cover"
							/>
						)}
						<span className="text-sm text-muted-foreground font-medium truncate">
							{[workspace.project.name, workspace.name]
								.filter(Boolean)
								.join(" - ")}
						</span>
						{workspace.role && (
							<span className="text-sm text-muted-foreground/60 truncate">
								· {workspace.role}
							</span>
						)}
					</div>
				</div>
			)}

			<div className="flex items-center gap-3 h-full pr-4 shrink-0">
				{!isOnline && (
					<div className="no-drag flex items-center gap-1.5 text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
						<HiOutlineWifi className="size-3.5" />
						<span>Offline</span>
					</div>
				)}
				{workspace?.worktreePath && (
					<OpenInMenuButton
						worktreePath={workspace.worktreePath}
						branch={workspace.worktree?.branch}
						projectId={workspace.project?.id}
					/>
				)}
				<OrganizationDropdown />
			</div>
		</div>
	);
}
