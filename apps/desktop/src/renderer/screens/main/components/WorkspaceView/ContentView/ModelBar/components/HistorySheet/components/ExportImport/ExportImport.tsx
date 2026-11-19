import { Button } from "@superset/ui/button";
import { Checkbox } from "@superset/ui/checkbox";
import { Input } from "@superset/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { toast } from "@superset/ui/sonner";
import { useMemo, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { HistoryProjectInfo, HistoryScope } from "../../types";
import { shortDate } from "../../utils/shortDate";
import { ScopeConfirm } from "../ScopeConfirm";

interface ExportImportProps {
	workspaceId: string;
	project: HistoryProjectInfo;
	onImported: () => void;
}

const ALL = "__all__";
const NONE = "__none__";

/**
 * Claude app chats (claude.ai and the desktop/mobile chat, including Claude
 * Projects). No API lists them for a personal account, so they come from the
 * user's own data export. Chats carry no repository information: the user
 * picks them and confirms the association.
 */
export function ExportImport({
	workspaceId,
	project,
	onImported,
}: ExportImportProps) {
	const [path, setPath] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [projectFilter, setProjectFilter] = useState(ALL);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [scope, setScope] = useState<HistoryScope>("project");
	const pick = electronTrpc.projectHistory.pickPath.useMutation({
		onSuccess: (picked) => {
			if (!picked) return;
			setPath(picked);
			setSelected(new Set());
		},
		onError: (err) => toast.error(err.message),
	});
	const { data, error, isFetching } =
		electronTrpc.projectHistory.previewExport.useQuery(
			{ workspaceId, path: path ?? "" },
			{ enabled: !!path, retry: false },
		);
	const importExport = electronTrpc.projectHistory.importExport.useMutation({
		onSuccess: (result) => {
			toast.success(
				`Linked ${result.added.length} new, ${result.updated.length} updated, ${result.unchanged.length} already linked`,
			);
			setSelected(new Set());
			onImported();
		},
		onError: (err) => toast.error(err.message),
	});

	const visible = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		return (data?.conversations ?? []).filter(
			(c) =>
				(projectFilter === ALL ||
					(projectFilter === NONE
						? !c.projectUuid
						: c.projectUuid === projectFilter)) &&
				(!needle || c.title.toLowerCase().includes(needle)),
		);
	}, [data, filter, projectFilter]);

	const toggle = (uuid: string, on: boolean) => {
		const next = new Set(selected);
		if (on) next.add(uuid);
		else next.delete(uuid);
		setSelected(next);
	};

	return (
		<div className="space-y-3" data-history-export>
			<p className="text-xs text-muted-foreground">
				In Claude, open Settings › Privacy › Export data. Anthropic emails a
				download link; select the zip, its conversations.json, or the extracted
				folder. ADE reads it locally and never signs in to Claude.
			</p>
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="outline"
					disabled={pick.isPending}
					onClick={() => pick.mutate({ kind: "export-file" })}
				>
					Choose export file…
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={pick.isPending}
					onClick={() => pick.mutate({ kind: "export-folder" })}
				>
					Choose extracted folder…
				</Button>
			</div>
			{path && (
				<p className="break-all text-[11px] text-muted-foreground">{path}</p>
			)}
			{isFetching && <p className="text-xs">Reading the export…</p>}
			{error && <p className="text-xs text-destructive">{error.message}</p>}
			{data && (
				<>
					{data.warnings.map((warning) => (
						<p key={warning} className="text-xs text-amber-600">
							{warning}
						</p>
					))}
					<div className="flex flex-wrap gap-2">
						<Input
							className="h-8 w-[200px]"
							placeholder="Filter by title"
							aria-label="Filter chats"
							value={filter}
							onChange={(event) => setFilter(event.target.value)}
						/>
						{data.hasProjectLinks && (
							<Select value={projectFilter} onValueChange={setProjectFilter}>
								<SelectTrigger
									className="h-8 w-[180px]"
									aria-label="Claude Project"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={ALL}>All chats</SelectItem>
									<SelectItem value={NONE}>Not in a Project</SelectItem>
									{data.projects.map((p) => (
										<SelectItem key={p.uuid} value={p.uuid}>
											{p.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
						<Button
							size="sm"
							variant="ghost"
							onClick={() => setSelected(new Set(visible.map((c) => c.uuid)))}
						>
							Select shown ({visible.length})
						</Button>
					</div>
					<ul className="max-h-[320px] space-y-1.5 overflow-y-auto">
						{visible.map((chat) => (
							<li
								key={chat.uuid}
								className="flex items-start gap-2 rounded border p-2"
							>
								<Checkbox
									aria-label={`Select ${chat.title}`}
									checked={selected.has(chat.uuid)}
									onCheckedChange={(on) => toggle(chat.uuid, on === true)}
								/>
								<div className="min-w-0 flex-1 text-xs">
									<p className="truncate font-medium" title={chat.title}>
										{chat.title}
										{chat.importedId && (
											<span className="ml-1 font-normal text-muted-foreground">
												(linked)
											</span>
										)}
									</p>
									<p className="text-muted-foreground">
										Claude app chat
										{chat.projectName ? ` · Project: ${chat.projectName}` : ""}{" "}
										· {shortDate(chat.createdAt)} to {shortDate(chat.updatedAt)}{" "}
										· {chat.messageCount} messages
									</p>
								</div>
							</li>
						))}
					</ul>
					<ScopeConfirm
						project={project}
						count={selected.size}
						scope={scope}
						onScopeChange={setScope}
						busy={importExport.isPending}
						onConfirm={() =>
							path &&
							importExport.mutate({
								workspaceId,
								path,
								uuids: [...selected],
								scope,
							})
						}
					/>
				</>
			)}
		</div>
	);
}
