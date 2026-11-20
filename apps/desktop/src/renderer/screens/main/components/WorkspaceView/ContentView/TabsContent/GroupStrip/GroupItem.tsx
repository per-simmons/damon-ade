import { Button } from "@superset/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@superset/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useEffect, useRef, useState } from "react";
import { useDrag, useDrop } from "react-dnd";
import { getEmptyImage } from "react-dnd-html5-backend";
import { HiMiniXMark } from "react-icons/hi2";
import { LuCheck, LuPalette, LuPencil } from "react-icons/lu";
import { MosaicDragType } from "react-mosaic-component";
import { StatusIndicator } from "renderer/screens/main/components/StatusIndicator";
import { useDragPaneStore } from "renderer/stores/drag-pane-store";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { PaneStatus, Tab } from "renderer/stores/tabs/types";
import { getTabDisplayName } from "renderer/stores/tabs/utils";
import { TERMINAL_PROFILES } from "shared/terminal-profiles";

export const TAB_TYPE = "TAB";

interface GroupItemProps {
	tab: Tab;
	index: number;
	isActive: boolean;
	isRenaming?: boolean;
	status: PaneStatus | null;
	onSelect: () => void;
	onClose: () => void;
	onRename: (newName: string) => void;
	onRenameStarted?: () => void;
	onPaneDrop?: (paneId: string) => void;
	onReorder?: (fromIndex: number, toIndex: number) => void;
}

export function GroupItem({
	tab,
	index,
	isActive,
	isRenaming,
	status,
	onSelect,
	onClose,
	onRename,
	onRenameStarted,
	onPaneDrop,
	onReorder,
}: GroupItemProps) {
	const displayName = getTabDisplayName(tab);
	const focusedPaneId = useTabsStore((s) => s.focusedPaneIds[tab.id]);
	const focusedPane = useTabsStore((s) =>
		focusedPaneId ? s.panes[focusedPaneId] : undefined,
	);
	const setPaneTerminalProfile = useTabsStore((s) => s.setPaneTerminalProfile);
	const isTerminalTab = focusedPane?.type === "terminal";
	const currentProfileId = focusedPane?.terminalProfileId;
	const [isEditing, setIsEditing] = useState(false);
	const [editValue, setEditValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	// Drag source for tab reordering
	const [{ isDragging }, drag, preview] = useDrag(
		() => ({
			type: TAB_TYPE,
			item: { tabId: tab.id, index },
			collect: (monitor) => ({
				isDragging: monitor.isDragging(),
			}),
		}),
		[tab.id, index],
	);

	// Hide the default browser drag preview to prevent snap-back animation
	useEffect(() => {
		preview(getEmptyImage(), { captureDraggingState: true });
	}, [preview]);

	// Drop target for pane drops AND tab reordering
	const [{ isOver, canDrop }, drop] = useDrop<
		{ tabId?: string; index?: number },
		{ handled: true },
		{ isOver: boolean; canDrop: boolean }
	>(
		() => ({
			accept: [MosaicDragType.WINDOW, TAB_TYPE],
			canDrop: (_item, monitor) => {
				const itemType = monitor.getItemType();
				if (itemType === TAB_TYPE) {
					// Tab reordering - can drop on any other tab
					const item = monitor.getItem() as { tabId: string; index: number };
					return item.tabId !== tab.id;
				}
				// Pane drop
				const { draggingPaneId, draggingSourceTabId } =
					useDragPaneStore.getState();
				return (
					!!draggingPaneId &&
					!!draggingSourceTabId &&
					draggingSourceTabId !== tab.id
				);
			},
			hover: (item, monitor) => {
				const itemType = monitor.getItemType();
				if (
					itemType === TAB_TYPE &&
					item.index !== undefined &&
					item.index !== index
				) {
					onReorder?.(item.index, index);
					item.index = index;
				}
			},
			drop: (_item, monitor) => {
				const itemType = monitor.getItemType();
				if (itemType === TAB_TYPE) {
					// Tab reorder is handled in hover
					return { handled: true };
				}
				// Pane drop
				const { draggingPaneId, draggingSourceTabId, clearDragging } =
					useDragPaneStore.getState();
				if (
					draggingPaneId &&
					draggingSourceTabId &&
					draggingSourceTabId !== tab.id
				) {
					onPaneDrop?.(draggingPaneId);
				}
				clearDragging();
				return { handled: true };
			},
			collect: (monitor) => ({
				isOver: monitor.isOver(),
				canDrop: monitor.canDrop(),
			}),
		}),
		[onPaneDrop, onReorder, tab.id, index],
	);

	useEffect(() => {
		if (isEditing && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [isEditing]);

	// External trigger for rename (e.g. from Cmd+I hotkey)
	useEffect(() => {
		if (isRenaming) {
			setEditValue(displayName);
			setIsEditing(true);
			onRenameStarted?.();
		}
	}, [isRenaming]);

	const startEditing = () => {
		setEditValue(displayName);
		setIsEditing(true);
	};

	const handleSave = () => {
		const trimmedValue = editValue.trim();
		if (trimmedValue && trimmedValue !== displayName) {
			onRename(trimmedValue);
		}
		setIsEditing(false);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			handleSave();
		} else if (e.key === "Escape") {
			e.preventDefault();
			setIsEditing(false);
		}
	};

	// Conductor style: understated text tabs — no filled background, just a
	// muted/foreground label; the active tab is marked by a thin accent
	// underline bar (rendered on the container below).
	const tabStyles = cn(
		"flex items-center gap-2 transition-colors w-full shrink-0 pl-3 pr-8 h-full",
		isActive
			? "text-foreground"
			: "text-muted-foreground/70 hover:text-foreground",
	);

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					ref={(node) => {
						drag(drop(node));
					}}
					className={cn(
						"group relative flex items-center shrink-0 h-full",
						isOver && canDrop && "bg-primary/5",
						isDragging && "opacity-50 text-muted-foreground/50",
					)}
					style={{ cursor: isDragging ? "grabbing" : undefined }}
				>
					{isActive && !isEditing && (
						<div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
					)}
					{isEditing ? (
						<div className="flex items-center w-full shrink-0 px-2 h-full">
							<input
								ref={inputRef}
								type="text"
								value={editValue}
								onChange={(e) => setEditValue(e.target.value)}
								onBlur={handleSave}
								onKeyDown={handleKeyDown}
								maxLength={64}
								className="text-sm w-full min-w-0 px-1 py-0.5 rounded border border-border bg-background text-foreground outline-none focus:ring-1 focus:ring-ring"
							/>
						</div>
					) : (
						<button
							type="button"
							onClick={onSelect}
							onDoubleClick={startEditing}
							onAuxClick={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									onClose();
								}
							}}
							className={tabStyles}
						>
							<span className="text-sm truncate flex-1 text-left">
								{displayName}
							</span>
							{status && status !== "idle" && (
								<StatusIndicator status={status} />
							)}
						</button>
					)}
					{!isEditing && (
						<div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 hidden group-hover:flex">
							<Tooltip delayDuration={500}>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										onClick={(e) => {
											e.stopPropagation();
											onClose();
										}}
										className="cursor-pointer size-6 hover:bg-muted"
										aria-label="Close pane"
									>
										<HiMiniXMark className="size-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="top" showArrow={false}>
									Close pane
								</TooltipContent>
							</Tooltip>
						</div>
					)}
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onSelect={startEditing}>
					<LuPencil className="size-4 mr-2" />
					Rename
				</ContextMenuItem>
				{isTerminalTab && focusedPaneId && (
					<ContextMenuSub>
						<ContextMenuSubTrigger>
							<LuPalette className="size-4 mr-2" />
							Terminal Profile
						</ContextMenuSubTrigger>
						<ContextMenuSubContent>
							<ContextMenuItem
								onSelect={() =>
									setPaneTerminalProfile(focusedPaneId, undefined)
								}
							>
								{!currentProfileId && <LuCheck className="size-3 mr-2" />}
								<span className={!currentProfileId ? "" : "ml-5"}>Default</span>
							</ContextMenuItem>
							{TERMINAL_PROFILES.map((profile) => (
								<ContextMenuItem
									key={profile.id}
									onSelect={() =>
										setPaneTerminalProfile(focusedPaneId, profile.id)
									}
								>
									{currentProfileId === profile.id && (
										<LuCheck className="size-3 mr-2" />
									)}
									<span
										className={currentProfileId === profile.id ? "" : "ml-5"}
									>
										{profile.name}
									</span>
									<span
										className="ml-auto size-3 rounded-sm border border-white/20"
										style={{
											backgroundColor: profile.colors.background,
										}}
									/>
								</ContextMenuItem>
							))}
						</ContextMenuSubContent>
					</ContextMenuSub>
				)}
				<ContextMenuItem onSelect={onClose}>
					<HiMiniXMark className="size-4 mr-2" />
					Close
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}
