import { Checkbox } from "@superset/ui/checkbox";
import { Label } from "@superset/ui/label";
import { toast } from "@superset/ui/sonner";
import { Switch } from "@superset/ui/switch";
import { useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { HistoryProjectInfo, HistoryScope } from "../../types";
import { shortDate } from "../../utils/shortDate";
import { ScopeConfirm } from "../ScopeConfirm";

interface SessionImportProps {
	workspaceId: string;
	project: HistoryProjectInfo;
	onImported: () => void;
}

/**
 * Claude Code sessions (CLI, or the Claude desktop app's Code tab) that ran
 * in this repository: in any of its worktrees, or in another clone of the
 * same remote. Sessions from other repositories appear only on request, and
 * linking one needs an explicit confirmation.
 */
export function SessionImport({
	workspaceId,
	project,
	onImported,
}: SessionImportProps) {
	const [showAll, setShowAll] = useState(false);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [scope, setScope] = useState<HistoryScope>("project");
	const [confirmOther, setConfirmOther] = useState(false);
	const { data, isLoading, error } =
		electronTrpc.projectHistory.listSessions.useQuery({
			workspaceId,
			showAll,
		});
	const importSessions = electronTrpc.projectHistory.importSessions.useMutation(
		{
			onSuccess: (result) => {
				toast.success(
					`Linked ${result.added.length} new, ${result.updated.length} updated, ${result.unchanged.length} unchanged`,
				);
				setSelected(new Set());
				setConfirmOther(false);
				onImported();
			},
			onError: (err) => toast.error(err.message),
		},
	);

	const sessions = data?.sessions ?? [];
	const chosen = sessions.filter((s) => selected.has(s.transcriptPath));
	const otherRepo = chosen.some((s) => !s.matches);
	const toggle = (path: string, on: boolean) => {
		const next = new Set(selected);
		if (on) next.add(path);
		else next.delete(path);
		setSelected(next);
	};

	return (
		<div className="space-y-3" data-history-sessions>
			<div className="flex items-center justify-between gap-2">
				<p className="text-xs text-muted-foreground">
					Read from Claude Code's local transcripts. Matched by the git
					repository each session ran in, not by its name.
				</p>
				<div className="flex shrink-0 items-center gap-2">
					<Switch
						id="history-show-all"
						checked={showAll}
						onCheckedChange={setShowAll}
					/>
					<Label htmlFor="history-show-all" className="text-xs">
						Other repositories
					</Label>
				</div>
			</div>
			{isLoading && <p className="text-xs">Reading sessions…</p>}
			{error && <p className="text-xs text-destructive">{error.message}</p>}
			{data && sessions.length === 0 && (
				<p className="text-xs text-muted-foreground">
					No Claude Code sessions ran in this repository on this machine
					{data.otherCount > 0
						? ` (${data.otherCount} ran in other repositories).`
						: "."}
				</p>
			)}
			<ul className="max-h-[320px] space-y-1.5 overflow-y-auto">
				{sessions.map((session) => (
					<li
						key={session.transcriptPath}
						className="flex items-start gap-2 rounded border p-2"
					>
						<Checkbox
							aria-label={`Select ${session.title}`}
							checked={selected.has(session.transcriptPath)}
							onCheckedChange={(on) =>
								toggle(session.transcriptPath, on === true)
							}
						/>
						<div className="min-w-0 flex-1 text-xs">
							<p className="truncate font-medium" title={session.title}>
								{session.title}
								{session.importedId && (
									<span className="ml-1 font-normal text-muted-foreground">
										(linked)
									</span>
								)}
							</p>
							<p className="text-muted-foreground">
								{session.source} · {shortDate(session.firstAt)} to{" "}
								{shortDate(session.lastAt)} · {session.messageCount} messages
								{session.branch ? ` · ${session.branch}` : ""}
							</p>
							<p
								className={
									session.matches ? "text-muted-foreground" : "text-amber-600"
								}
							>
								{session.reason}
								{session.cwd ? ` · ${session.cwd}` : ""}
							</p>
						</div>
					</li>
				))}
			</ul>
			{otherRepo && (
				<div className="flex items-start gap-2 text-xs">
					<Checkbox
						id="history-confirm-other"
						checked={confirmOther}
						onCheckedChange={(on) => setConfirmOther(on === true)}
					/>
					<Label
						htmlFor="history-confirm-other"
						className="text-xs font-normal"
					>
						Some selected sessions ran in another repository. Link them to{" "}
						{project.name} anyway.
					</Label>
				</div>
			)}
			<ScopeConfirm
				project={project}
				count={chosen.length}
				scope={scope}
				onScopeChange={setScope}
				busy={importSessions.isPending}
				blockedReason={
					otherRepo && !confirmOther
						? "Confirm the sessions from another repository first"
						: null
				}
				onConfirm={() =>
					importSessions.mutate({
						workspaceId,
						transcriptPaths: chosen.map((s) => s.transcriptPath),
						scope,
						confirmOtherRepository: confirmOther,
					})
				}
			/>
		</div>
	);
}
