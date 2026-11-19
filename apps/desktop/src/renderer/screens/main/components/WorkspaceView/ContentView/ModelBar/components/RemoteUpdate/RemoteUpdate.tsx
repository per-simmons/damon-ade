import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface RemoteUpdateProps {
	workspaceId: string;
	/** "bar": a compact button shown only when behind; "card": the full status. */
	variant: "bar" | "card";
}

/**
 * Update from GitHub: how far this checkout is behind its remote branch, and
 * a fast-forward-only update. Local work is never touched: with uncommitted
 * changes or local commits not on the remote, ADE says why and changes
 * nothing.
 */
export function RemoteUpdate({ workspaceId, variant }: RemoteUpdateProps) {
	const utils = electronTrpc.useUtils();
	const status = electronTrpc.repoUpdate.status.useQuery(
		{ workspaceId, fetch: true },
		{ staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: false },
	);
	const update = electronTrpc.repoUpdate.update.useMutation({
		onSuccess: (result) => {
			if (result.outcome === "updated") {
				toast.success(
					`Updated ${result.from} → ${result.to} (${result.commits} commit(s))`,
				);
			} else if (result.outcome === "up-to-date") {
				toast.success("Already up to date");
			} else {
				toast.error(result.reason);
			}
			void utils.repoUpdate.status.invalidate({ workspaceId });
			void utils.workflow.getProjectTasks.invalidate({ workspaceId });
			void utils.projectHistory.overview.invalidate({ workspaceId });
		},
		onError: (err) => toast.error(err.message),
	});
	const data = status.data;

	if (variant === "bar") {
		if (!data?.upstream || data.behind === 0) return null;
		return (
			<button
				type="button"
				disabled={update.isPending}
				title={
					data.blocked ??
					`${data.upstream} has ${data.behind} new commit(s). Fast-forward this checkout (local work is never touched).`
				}
				onClick={() => update.mutate({ workspaceId })}
				className="flex h-7 items-center rounded-md px-2 text-xs text-amber-600 transition-colors hover:bg-muted disabled:opacity-40"
				data-remote-update
			>
				{update.isPending
					? "Updating…"
					: `↓${data.behind} Update from ${data.upstream.split("/")[0]}`}
			</button>
		);
	}

	let line: string;
	if (status.isLoading) line = "Checking the remote…";
	else if (status.error) line = status.error.message;
	else if (!data) line = "";
	else if (!data.upstream)
		line = data.branch
			? `Branch ${data.branch} does not track a remote branch.`
			: "Not on a branch (detached HEAD).";
	else if (data.behind === 0 && data.ahead === 0)
		line = `Branch ${data.branch} is up to date with ${data.upstream}.`;
	else if (data.behind === 0)
		line = `Branch ${data.branch} has ${data.ahead} local commit(s) not on ${data.upstream} (nothing to update).`;
	else
		line = `${data.upstream} has ${data.behind} new commit(s) not in this checkout.`;

	return (
		<div className="space-y-1" data-remote-status>
			<p className="text-muted-foreground">{line}</p>
			{data?.fetchError && (
				<p className="text-amber-600">
					Could not reach the remote ({data.fetchError}); counts are from the
					last fetch.
				</p>
			)}
			{data?.blocked && data.behind > 0 && (
				<p className="text-amber-600">{data.blocked}</p>
			)}
			<div className="flex gap-2">
				<Button
					size="sm"
					variant="ghost"
					className="h-7 px-2 text-xs"
					disabled={status.isFetching}
					onClick={() => void status.refetch()}
				>
					{status.isFetching ? "Checking…" : "Check for updates"}
				</Button>
				{data?.upstream && data.behind > 0 && (
					<Button
						size="sm"
						className="h-7 px-2 text-xs"
						disabled={update.isPending || !!data.blocked}
						title={data.blocked ?? undefined}
						onClick={() => update.mutate({ workspaceId })}
					>
						{update.isPending ? "Updating…" : "Update from GitHub"}
					</Button>
				)}
			</div>
		</div>
	);
}
