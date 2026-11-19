import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useLaunchInNewTab } from "../../../../hooks/useLaunchInNewTab";
import type { ImportedConversation } from "../../types";
import { ImportedRow } from "./components/ImportedRow";

interface ImportedListProps {
	workspaceId: string;
	conversations: ImportedConversation[];
	onChanged: () => void;
	onStartTask: () => void;
}

const onError = (err: { message: string }) => toast.error(err.message);

/**
 * Conversations linked to this project. Turning one off, narrowing it to a
 * worktree, moving it to another project or removing it changes only ADE's
 * copy; refreshing re-reads the original.
 */
export function ImportedList({
	workspaceId,
	conversations,
	onChanged,
	onStartTask,
}: ImportedListProps) {
	const utils = electronTrpc.useUtils();
	const launchInNewTab = useLaunchInNewTab();
	const { data: otherProjects } =
		electronTrpc.projectHistory.otherProjects.useQuery({ workspaceId });
	const handlers = { onSuccess: onChanged, onError };
	const setIncluded =
		electronTrpc.projectHistory.setIncluded.useMutation(handlers);
	const setScope = electronTrpc.projectHistory.setScope.useMutation(handlers);
	const remove = electronTrpc.projectHistory.remove.useMutation(handlers);
	const move = electronTrpc.projectHistory.move.useMutation({
		onSuccess: (result) => {
			toast.success(`Moved to ${result.movedTo}`);
			onChanged();
		},
		onError,
	});
	const refresh = electronTrpc.projectHistory.refresh.useMutation({
		onSuccess: (results) => {
			const outcomes = Object.values(results);
			const count = (name: string) =>
				outcomes.filter((r) => r.outcome === name).length;
			const failed = outcomes.find((r) => r.outcome === "failed");
			if (failed) toast.error(failed.message ?? "Refresh failed");
			toast.success(
				`Refreshed: ${count("updated")} updated, ${count("unchanged")} unchanged, ${count("missing")} original(s) gone`,
			);
			onChanged();
		},
		onError,
	});
	const busy = [setIncluded, setScope, remove, move, refresh].some(
		(m) => m.isPending,
	);

	const resume = async (id: string, title: string) => {
		try {
			const session = await utils.projectHistory.resumeCommand.fetch({
				workspaceId,
				id,
			});
			await launchInNewTab(workspaceId, `Resume · ${title}`, session.command);
		} catch (err) {
			onError(err as { message: string });
		}
	};

	if (conversations.length === 0) {
		return (
			<p className="text-xs text-muted-foreground">
				Nothing linked yet. Tasks in this project run without history.
			</p>
		);
	}
	const used = conversations.filter((c) => c.included && c.inThisWorktree);
	return (
		<div className="space-y-2" data-history-imported>
			<div className="flex items-center justify-between gap-2">
				<p className="text-xs text-muted-foreground">
					{used.length} of {conversations.length} used by new tasks in this
					worktree.
				</p>
				<Button
					size="sm"
					variant="ghost"
					className="h-7 px-2 text-xs"
					disabled={busy}
					onClick={() => refresh.mutate({ workspaceId })}
				>
					Refresh all
				</Button>
			</div>
			<ul className="space-y-1.5">
				{conversations.map((conversation) => (
					<ImportedRow
						key={conversation.id}
						conversation={conversation}
						otherProjects={otherProjects ?? []}
						busy={busy}
						onInclude={(included) =>
							setIncluded.mutate({ workspaceId, id: conversation.id, included })
						}
						onScope={(scope) =>
							setScope.mutate({ workspaceId, id: conversation.id, scope })
						}
						onRefresh={() =>
							refresh.mutate({ workspaceId, ids: [conversation.id] })
						}
						onResume={() => void resume(conversation.id, conversation.title)}
						onStartTask={onStartTask}
						onMove={(targetProjectId) =>
							move.mutate({ workspaceId, id: conversation.id, targetProjectId })
						}
						onRemove={() => remove.mutate({ workspaceId, id: conversation.id })}
					/>
				))}
			</ul>
		</div>
	);
}
