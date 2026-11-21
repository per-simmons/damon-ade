import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { HistoryProjectInfo, HistoryScope } from "../../types";
import { shortDate } from "../../utils/shortDate";
import { ScopeConfirm } from "../ScopeConfirm";

interface TranscriptImportProps {
	workspaceId: string;
	project: HistoryProjectInfo;
	onImported: () => void;
}

/**
 * One transcript file: a Claude Code session file (.jsonl, e.g. from another
 * machine) or a chat saved as text or Markdown with "User:" / "Claude:"
 * turns.
 */
export function TranscriptImport({
	workspaceId,
	project,
	onImported,
}: TranscriptImportProps) {
	const [path, setPath] = useState<string | null>(null);
	const [scope, setScope] = useState<HistoryScope>("project");
	const pick = electronTrpc.projectHistory.pickPath.useMutation({
		onSuccess: (picked) => picked && setPath(picked),
		onError: (err) => toast.error(err.message),
	});
	const { data, error } =
		electronTrpc.projectHistory.previewTranscript.useQuery(
			{ path: path ?? "" },
			{ enabled: !!path, retry: false },
		);
	const importTranscript =
		electronTrpc.projectHistory.importTranscript.useMutation({
			onSuccess: (result) => {
				toast.success(
					result.unchanged.length ? "Already linked" : "Transcript linked",
				);
				setPath(null);
				onImported();
			},
			onError: (err) => toast.error(err.message),
		});

	return (
		<div className="space-y-3" data-history-transcript>
			<p className="text-xs text-muted-foreground">
				A Claude Code session file (.jsonl), or a chat saved as text or Markdown
				with "User:" and "Claude:" turns.
			</p>
			<Button
				size="sm"
				variant="outline"
				disabled={pick.isPending}
				onClick={() => pick.mutate({ kind: "transcript" })}
			>
				Choose transcript…
			</Button>
			{path && (
				<p className="break-all text-[11px] text-muted-foreground">{path}</p>
			)}
			{error && <p className="text-xs text-destructive">{error.message}</p>}
			{data && path && (
				<>
					<div className="rounded border p-2 text-xs">
						<p className="font-medium">{data.title}</p>
						<p className="text-muted-foreground">
							{data.kind === "claude-code"
								? "Claude Code session"
								: "Text transcript"}{" "}
							· {data.messageCount} messages · {shortDate(data.updatedAt)}
						</p>
						<p className="mt-1 line-clamp-3 whitespace-pre-wrap">
							{data.firstMessage}
						</p>
					</div>
					<ScopeConfirm
						project={project}
						count={1}
						scope={scope}
						onScopeChange={setScope}
						busy={importTranscript.isPending}
						onConfirm={() =>
							importTranscript.mutate({ workspaceId, path, scope })
						}
					/>
				</>
			)}
		</div>
	);
}
