import {
	closestCorners,
	DndContext,
	type DragEndEvent,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import type { AgentTaskStatus } from "@superset/local-db";
import { Button } from "@superset/ui/button";
import { useMemo, useState } from "react";
import { HiOutlinePlus } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useDispatchTask } from "../../hooks/useDispatchTask";
import type { BoardAgent, BoardTask } from "../../types";
import { BoardColumn } from "../BoardColumn";
import { NewTaskDialog } from "../NewTaskDialog";
import { TaskCard } from "../TaskCard";

const COLUMNS: { status: AgentTaskStatus; title: string }[] = [
	{ status: "todo", title: "To do" },
	{ status: "in_progress", title: "In progress" },
	{ status: "review", title: "Review" },
	{ status: "done", title: "Done" },
];

const byBoardOrder = (a: BoardTask, b: BoardTask) =>
	a.position - b.position || a.createdAt - b.createdAt;

/** Midpoint between neighbours; wide gaps keep integer positions apart. */
function positionBetween(prev?: number, next?: number): number {
	if (prev === undefined && next === undefined) return 1024;
	if (prev === undefined) return (next as number) - 1024;
	if (next === undefined) return prev + 1024;
	return Math.floor((prev + next) / 2);
}

/**
 * The ADE task board: four status columns of draggable cards, each assignable
 * to an agent and dispatchable (launches the agent's CLI on the task).
 */
export function BoardView() {
	const utils = electronTrpc.useUtils();
	const { data: tasks = [] } = electronTrpc.agentTasks.getAll.useQuery();
	const { data: groups = [] } =
		electronTrpc.workspaces.getAllGrouped.useQuery();
	const { dispatchTask } = useDispatchTask();

	const moveTask = electronTrpc.agentTasks.move.useMutation({
		onSettled: () => utils.agentTasks.getAll.invalidate(),
	});
	const deleteTask = electronTrpc.agentTasks.delete.useMutation({
		onSuccess: () => utils.agentTasks.getAll.invalidate(),
	});

	const [newTaskOpen, setNewTaskOpen] = useState(false);

	const agents = useMemo<BoardAgent[]>(
		() =>
			groups.flatMap((group) =>
				group.workspaces.map((ws) => ({
					id: ws.id,
					name: ws.name,
					runtime: ws.runtime,
					worktreePath: ws.worktreePath,
					iconUrl: ws.iconUrl,
					teamName: group.project.name,
				})),
			),
		[groups],
	);
	const agentById = useMemo(
		() => new Map(agents.map((agent) => [agent.id, agent])),
		[agents],
	);

	const columns = useMemo(
		() =>
			COLUMNS.map(({ status, title }) => ({
				status,
				title,
				tasks: tasks.filter((t) => t.status === status).sort(byBoardOrder),
			})),
		[tasks],
	);

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
	);

	const handleDragEnd = ({ active, over }: DragEndEvent) => {
		if (!over) return;
		const taskId = String(active.id);
		const overId = String(over.id);
		if (taskId === overId) return;

		// Target column: either the droppable column itself or the card under it.
		const overColumn = overId.startsWith("column-")
			? (overId.slice("column-".length) as AgentTaskStatus)
			: tasks.find((t) => t.id === overId)?.status;
		if (!overColumn) return;

		const columnTasks =
			columns
				.find((c) => c.status === overColumn)
				?.tasks.filter((t) => t.id !== taskId) ?? [];

		let position: number;
		if (overId.startsWith("column-")) {
			position = positionBetween(columnTasks.at(-1)?.position, undefined);
		} else {
			const overIndex = columnTasks.findIndex((t) => t.id === overId);
			position = positionBetween(
				columnTasks[overIndex - 1]?.position,
				columnTasks[overIndex]?.position,
			);
		}

		// Optimistic: reflect the move locally, reconcile on settle.
		utils.agentTasks.getAll.setData(undefined, (old) =>
			old?.map((t) =>
				t.id === taskId ? { ...t, status: overColumn, position } : t,
			),
		);
		moveTask.mutate({ id: taskId, status: overColumn, position });
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between px-4 py-3">
				<h1 className="text-lg font-semibold">Task Board</h1>
				<Button size="sm" onClick={() => setNewTaskOpen(true)}>
					<HiOutlinePlus className="mr-1 h-4 w-4" />
					New task
				</Button>
			</div>

			<div className="flex flex-1 gap-3 overflow-x-auto px-4 pb-4">
				<DndContext
					sensors={sensors}
					collisionDetection={closestCorners}
					onDragEnd={handleDragEnd}
				>
					{columns.map((column) => (
						<BoardColumn
							key={column.status}
							status={column.status}
							title={column.title}
							count={column.tasks.length}
							taskIds={column.tasks.map((t) => t.id)}
						>
							{column.tasks.map((task) => {
								const agent = task.workspaceId
									? (agentById.get(task.workspaceId) ?? null)
									: null;
								return (
									<TaskCard
										key={task.id}
										task={task}
										agent={agent}
										onDispatch={() => {
											if (agent) dispatchTask(task, agent);
										}}
										onDelete={() => deleteTask.mutate({ id: task.id })}
									/>
								);
							})}
						</BoardColumn>
					))}
				</DndContext>
			</div>

			<NewTaskDialog
				open={newTaskOpen}
				onOpenChange={setNewTaskOpen}
				agents={agents}
			/>
		</div>
	);
}
