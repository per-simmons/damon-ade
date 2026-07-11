import { useDroppable } from "@dnd-kit/core";
import {
	SortableContext,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { AgentTaskStatus } from "@superset/local-db";
import type { ReactNode } from "react";

interface BoardColumnProps {
	status: AgentTaskStatus;
	title: string;
	count: number;
	children: ReactNode;
	taskIds: string[];
}

/** A droppable status column; cards inside sort vertically. */
export function BoardColumn({
	status,
	title,
	count,
	children,
	taskIds,
}: BoardColumnProps) {
	const { setNodeRef, isOver } = useDroppable({ id: `column-${status}` });

	return (
		<div className="flex w-64 shrink-0 flex-col">
			<div className="flex items-center gap-2 px-1 pb-2">
				<span className="text-sm font-medium">{title}</span>
				<span className="text-xs text-muted-foreground">{count}</span>
			</div>
			<SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
				<div
					ref={setNodeRef}
					className={`flex min-h-32 flex-1 flex-col gap-2 rounded-lg p-2 transition-colors ${
						isOver ? "bg-muted/70" : "bg-muted/35"
					}`}
				>
					{children}
				</div>
			</SortableContext>
		</div>
	);
}
