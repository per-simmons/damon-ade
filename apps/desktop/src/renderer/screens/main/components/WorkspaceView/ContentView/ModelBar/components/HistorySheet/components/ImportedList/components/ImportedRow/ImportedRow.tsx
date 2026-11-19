import { Badge } from "@superset/ui/badge";
import { Button } from "@superset/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { Switch } from "@superset/ui/switch";
import { useState } from "react";
import type { HistoryScope, ImportedConversation } from "../../../../types";
import { shortDate } from "../../../../utils/shortDate";

interface ImportedRowProps {
	conversation: ImportedConversation;
	otherProjects: Array<{ id: string; name: string }>;
	busy: boolean;
	onInclude: (included: boolean) => void;
	onScope: (scope: HistoryScope) => void;
	onRefresh: () => void;
	onResume: () => void;
	onStartTask: () => void;
	onMove: (projectId: string) => void;
	onRemove: () => void;
}

const STATUS: Record<
	ImportedConversation["status"],
	{ label: string; hint: string }
> = {
	current: { label: "Up to date", hint: "The copy matches the original." },
	changed: {
		label: "Original changed",
		hint: "The original has new messages; refresh to update the copy.",
	},
	missing: {
		label: "Original gone",
		hint: "The original no longer exists; ADE keeps its copy.",
	},
};

const ASSOCIATION: Record<ImportedConversation["association"], string> = {
	"same-repository": "ran in this repository",
	"same-remote": "ran in another clone of this remote",
	path: "ran inside this project's folder",
	"user-confirmed": "linked by you",
};

const MOVE = "__move__";

export function ImportedRow({
	conversation,
	otherProjects,
	busy,
	onInclude,
	onScope,
	onRefresh,
	onResume,
	onStartTask,
	onMove,
	onRemove,
}: ImportedRowProps) {
	const [confirmRemove, setConfirmRemove] = useState(false);
	const status = STATUS[conversation.status];
	return (
		<li
			className="space-y-2 rounded border p-2 text-xs"
			data-history-item={conversation.id}
		>
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<p className="truncate font-medium" title={conversation.title}>
						{conversation.title}
					</p>
					<p className="text-muted-foreground">
						{conversation.source} · {shortDate(conversation.createdAt)} to{" "}
						{shortDate(conversation.updatedAt)} · {conversation.messageCount}{" "}
						messages
					</p>
					<p className="text-muted-foreground">
						{ASSOCIATION[conversation.association]}
						{conversation.scope === "worktree"
							? ` · worktree ${conversation.scopePath}`
							: " · whole project"}
						{conversation.inThisWorktree ? "" : " (not this worktree)"}
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<Badge
						variant={
							conversation.status === "current" ? "secondary" : "outline"
						}
						title={status.hint}
					>
						{status.label}
					</Badge>
					<Switch
						aria-label="Use in tasks"
						checked={conversation.included}
						disabled={busy}
						onCheckedChange={onInclude}
					/>
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-1.5">
				<Select
					value={conversation.scope}
					onValueChange={(value) => onScope(value as HistoryScope)}
					disabled={busy}
				>
					<SelectTrigger className="h-7 w-[160px] text-xs" aria-label="Use in">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="project">Whole project</SelectItem>
						<SelectItem value="worktree">This worktree only</SelectItem>
					</SelectContent>
				</Select>
				<Button
					size="sm"
					variant="ghost"
					className="h-7 px-2 text-xs"
					disabled={busy}
					onClick={onRefresh}
				>
					Refresh
				</Button>
				{conversation.canResume ? (
					<Button
						size="sm"
						variant="ghost"
						className="h-7 px-2 text-xs"
						disabled={busy}
						title="Opens a terminal running claude --resume in the session's folder"
						onClick={onResume}
					>
						Resume session
					</Button>
				) : (
					<Button
						size="sm"
						variant="ghost"
						className="h-7 px-2 text-xs"
						title={
							conversation.kind === "claude-code"
								? "This session can no longer be resumed; a new task gets it as history"
								: "Claude app chats cannot be resumed here; a new task gets it as history"
						}
						onClick={onStartTask}
					>
						New task with this history
					</Button>
				)}
				{otherProjects.length > 0 && (
					<Select value={MOVE} onValueChange={onMove} disabled={busy}>
						<SelectTrigger
							className="h-7 w-[150px] text-xs"
							aria-label="Move to project"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={MOVE} disabled>
								Move to project…
							</SelectItem>
							{otherProjects.map((p) => (
								<SelectItem key={p.id} value={p.id}>
									{p.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}
				{confirmRemove ? (
					<Button
						size="sm"
						variant="destructive"
						className="h-7 px-2 text-xs"
						disabled={busy}
						onClick={onRemove}
					>
						Remove ADE's copy
					</Button>
				) : (
					<Button
						size="sm"
						variant="ghost"
						className="h-7 px-2 text-xs"
						disabled={busy}
						title="Removes ADE's copy only; the original is not touched"
						onClick={() => setConfirmRemove(true)}
					>
						Remove
					</Button>
				)}
			</div>
		</li>
	);
}
