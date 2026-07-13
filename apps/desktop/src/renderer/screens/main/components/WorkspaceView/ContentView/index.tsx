import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { LuMessageSquare, LuSquareTerminal } from "react-icons/lu";
import { useSidebarStore } from "renderer/stores/sidebar-state";
import { SidebarControl } from "../../SidebarControl";
import { ContentHeader } from "./ContentHeader";
import { ModelBar } from "./ModelBar";
import { TabsContent } from "./TabsContent";
import { GroupStrip } from "./TabsContent/GroupStrip";
import { WorkspaceChat } from "./WorkspaceChat";

type WorkspaceViewMode = "chat" | "terminal";

function loadViewMode(workspaceId: string | undefined): WorkspaceViewMode {
	if (!workspaceId) return "terminal";
	const saved = localStorage.getItem(`ade.viewMode.${workspaceId}`);
	return saved === "terminal" ? "terminal" : "chat";
}

/**
 * An agent's workspace, in one of two modes: Chat (default — talk to the
 * agent directly, Conductor-style) or Terminal (the session tabs + model
 * bar). The choice persists per agent. Terminal keeps running in the
 * background either way — the mode only changes what's shown.
 */
export function ContentView() {
	const isSidebarOpen = useSidebarStore((s) => s.isSidebarOpen);
	const { workspaceId } = useParams({ strict: false });

	const [mode, setMode] = useState<WorkspaceViewMode>(() =>
		loadViewMode(workspaceId),
	);
	// Re-resolve when switching agents.
	useEffect(() => {
		setMode(loadViewMode(workspaceId));
	}, [workspaceId]);

	const switchMode = (next: WorkspaceViewMode) => {
		setMode(next);
		if (workspaceId) localStorage.setItem(`ade.viewMode.${workspaceId}`, next);
	};

	return (
		<div className="h-full flex flex-col overflow-hidden">
			<ContentHeader
				trailingAction={!isSidebarOpen ? <SidebarControl /> : undefined}
			>
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<div className="flex shrink-0 items-center rounded-md bg-muted/60 p-0.5">
						<ModeButton
							active={mode === "chat"}
							onClick={() => switchMode("chat")}
							icon={<LuMessageSquare className="size-3.5" />}
							label="Chat"
						/>
						<ModeButton
							active={mode === "terminal"}
							onClick={() => switchMode("terminal")}
							icon={<LuSquareTerminal className="size-3.5" />}
							label="Terminal"
						/>
					</div>
					{mode === "terminal" && <GroupStrip />}
				</div>
			</ContentHeader>
			{mode === "terminal" ? (
				<>
					<ModelBar />
					<TabsContent />
				</>
			) : (
				<WorkspaceChat />
			)}
		</div>
	);
}

function ModeButton({
	active,
	onClick,
	icon,
	label,
}: {
	active: boolean;
	onClick: () => void;
	icon: React.ReactNode;
	label: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors ${
				active
					? "bg-background text-foreground shadow-sm"
					: "text-muted-foreground hover:text-foreground"
			}`}
		>
			{icon}
			{label}
		</button>
	);
}
