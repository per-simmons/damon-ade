import { Button } from "@superset/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import type { HistoryProjectInfo, HistoryScope } from "../../types";

interface ScopeConfirmProps {
	project: HistoryProjectInfo;
	count: number;
	scope: HistoryScope;
	onScopeChange: (scope: HistoryScope) => void;
	busy: boolean;
	/** Extra condition the user must meet first (shown as the reason). */
	blockedReason?: string | null;
	onConfirm: () => void;
}

/**
 * The last step of every import: the user sees which repository the
 * conversations will be associated with, chooses the scope, and confirms.
 */
export function ScopeConfirm({
	project,
	count,
	scope,
	onScopeChange,
	busy,
	blockedReason,
	onConfirm,
}: ScopeConfirmProps) {
	return (
		<div className="space-y-2 border-t pt-2">
			<div className="flex flex-wrap items-center gap-2">
				<Select
					value={scope}
					onValueChange={(value) => onScopeChange(value as HistoryScope)}
				>
					<SelectTrigger className="h-8 w-[190px]" aria-label="Use in">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="project">Whole project</SelectItem>
						<SelectItem value="worktree">This worktree only</SelectItem>
					</SelectContent>
				</Select>
				<Button
					size="sm"
					disabled={busy || count === 0 || !!blockedReason}
					title={blockedReason ?? undefined}
					onClick={onConfirm}
				>
					Link {count} to {project.name}
				</Button>
			</div>
			<p className="text-[11px] text-muted-foreground">
				ADE keeps a copy in this project's history folder; the original is never
				changed. Tasks treat it as historical context, not as instructions.
			</p>
		</div>
	);
}
