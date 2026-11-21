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
import { LuFolderInput, LuFolderSearch } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";

interface ChangeFolderDialogProps {
	projectId: string;
	teamName: string;
	currentPath: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

type Mode = "move" | "relink";

function folderName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * Change a team's folder: move its repository into another folder, or point
 * the team at where it was already moved. The agents come along (their own
 * folders are re-linked to the repository), and so do its tasks and
 * specialists. Moving closes the terminals of the team's own folder first,
 * since a folder in use cannot be moved.
 */
export function ChangeFolderDialog({
	projectId,
	teamName,
	currentPath,
	open,
	onOpenChange,
}: ChangeFolderDialogProps) {
	const utils = electronTrpc.useUtils();
	const [mode, setMode] = useState<Mode>("move");
	const [target, setTarget] = useState<string | null>(null);
	const { data: all = [] } = electronTrpc.workspaces.getAll.useQuery(
		undefined,
		{ enabled: open },
	);
	const tabs = useTabsStore((s) => s.tabs);
	const removeTab = useTabsStore((s) => s.removeTab);
	const select = electronTrpc.projects.selectDirectory.useMutation();
	const relocate = electronTrpc.projects.relocateTeam.useMutation({
		onSuccess: (result) => {
			toast.success(
				`${teamName} is now at ${result.path}${result.agentsRelinked ? `; ${result.agentsRelinked} agent(s) re-linked` : ""}`,
			);
			void utils.invalidate();
			setTarget(null);
			onOpenChange(false);
		},
		onError: (error) => toast.error(error.message),
	});

	const mainWorkspace = all.find(
		(w) => w.projectId === projectId && w.type === "branch",
	);
	const ownTabs = tabs.filter((t) => t.workspaceId === mainWorkspace?.id);
	const result =
		target && mode === "move"
			? `${target.replace(/[\\/]+$/, "")}\\${folderName(currentPath)}`
			: target;

	const choose = async () => {
		const picked = await select.mutateAsync({ defaultPath: currentPath });
		if (!picked.canceled && picked.path) setTarget(picked.path);
	};

	const run = async () => {
		if (!target) return;
		if (mode === "move") {
			// A folder with terminals in it cannot be moved (Windows).
			for (const tab of ownTabs) removeTab(tab.id);
			await new Promise((r) => setTimeout(r, 1500));
		}
		relocate.mutate({ projectId, target, mode });
	};

	const option = (value: Mode, title: string, text: string) => (
		<button
			type="button"
			aria-pressed={mode === value}
			onClick={() => {
				setMode(value);
				setTarget(null);
			}}
			className={cn(
				"space-y-1 rounded-lg border p-3 text-left transition-colors hover:bg-muted/40",
				mode === value && "border-primary bg-primary/5",
			)}
		>
			<span className="block text-sm font-semibold">{title}</span>
			<span className="block text-xs text-muted-foreground">{text}</span>
		</button>
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="sm:max-w-[560px]"
				data-change-folder
				// Opened from the team's menu, which hands focus back to the team row
				// as it closes: that must not close this dialog.
				onFocusOutside={(event) => event.preventDefault()}
			>
				<DialogHeader>
					<DialogTitle>Change folder · {teamName}</DialogTitle>
					<DialogDescription className="break-all">
						Now at {currentPath}
					</DialogDescription>
				</DialogHeader>
				<div className="grid grid-cols-2 gap-2">
					{option(
						"move",
						"Move the folder",
						"ADE moves the team's repository into a folder you choose.",
					)}
					{option(
						"relink",
						"I already moved it",
						"Point the team at the repository's new place.",
					)}
				</div>
				<div className="space-y-2">
					<Button variant="outline" size="sm" onClick={choose}>
						{mode === "move" ? (
							<LuFolderInput className="size-3.5" aria-hidden />
						) : (
							<LuFolderSearch className="size-3.5" aria-hidden />
						)}
						{mode === "move"
							? "Choose where to move it"
							: "Find the repository"}
					</Button>
					{result && (
						<p className="break-all rounded-md bg-muted/30 px-2.5 py-1.5 text-xs">
							New folder: {result}
						</p>
					)}
					<p className="text-xs text-muted-foreground">
						The agents come along (their own folders are re-linked), and so do
						the team's tasks and specialists. Nothing is deleted.
						{mode === "move" && ownTabs.length > 0
							? ` Moving first closes the ${ownTabs.length} terminal tab(s) of the team's own folder, including Team chat.`
							: ""}
					</p>
				</div>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button disabled={!target || relocate.isPending} onClick={run}>
						{relocate.isPending
							? "Changing…"
							: mode === "move"
								? "Move folder"
								: "Use this folder"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
