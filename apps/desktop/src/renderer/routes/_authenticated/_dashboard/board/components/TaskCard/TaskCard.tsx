import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { HiOutlinePlay, HiOutlineTrash } from "react-icons/hi2";
import type { BoardAgent, BoardTask } from "../../types";

const PRIORITY_COLORS: Record<BoardTask["priority"], string> = {
	urgent: "bg-red-500",
	high: "bg-orange-400",
	medium: "bg-yellow-400",
	low: "bg-sky-400",
	none: "bg-muted-foreground/30",
};

interface TaskCardProps {
	task: BoardTask;
	agent: BoardAgent | null;
	onDispatch: () => void;
	onDelete: () => void;
}

/** A draggable board card: title, priority dot, assigned agent, actions. */
export function TaskCard({ task, agent, onDispatch, onDelete }: TaskCardProps) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: task.id, data: { status: task.status } });

	return (
		<div
			ref={setNodeRef}
			style={{ transform: CSS.Transform.toString(transform), transition }}
			{...attributes}
			{...listeners}
			className={`group flex flex-col gap-1.5 rounded-md border bg-background p-2.5 shadow-sm ${
				isDragging ? "opacity-40" : ""
			}`}
		>
			<div className="flex items-start gap-2">
				<span
					className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${PRIORITY_COLORS[task.priority]}`}
					title={`Priority: ${task.priority}`}
				/>
				<span className="flex-1 text-sm leading-snug">{task.title}</span>
				<button
					type="button"
					aria-label="Delete task"
					onClick={onDelete}
					className="hidden text-muted-foreground/60 transition-colors hover:text-destructive group-hover:block"
				>
					<HiOutlineTrash className="h-3.5 w-3.5" />
				</button>
			</div>

			<div className="flex items-center justify-between pl-4">
				{agent ? (
					<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
						{agent.iconUrl ? (
							<img
								src={agent.iconUrl}
								alt=""
								className="h-4 w-4 rounded-full object-cover"
							/>
						) : (
							<span className="flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[9px] uppercase">
								{agent.name.slice(0, 1)}
							</span>
						)}
						{agent.name}
					</span>
				) : (
					<span className="text-xs text-muted-foreground/60">Unassigned</span>
				)}

				{agent && task.status !== "done" && (
					<button
						type="button"
						onClick={onDispatch}
						className="hidden items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground group-hover:flex"
						title={`Launch ${agent.name} on this task`}
					>
						<HiOutlinePlay className="h-3.5 w-3.5" />
						{task.dispatchedAt ? "Re-dispatch" : "Dispatch"}
					</button>
				)}
			</div>
		</div>
	);
}
