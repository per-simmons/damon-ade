import { Button } from "@superset/ui/button";
import { formatDistanceToNow } from "date-fns";
import { useMemo, useState } from "react";
import {
	HiOutlineClock,
	HiOutlinePlay,
	HiOutlinePlus,
	HiOutlineTrash,
} from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { ScheduleAgent } from "../../types";
import { NewScheduleDialog } from "../NewScheduleDialog";

/**
 * Recurring agent dispatches: each row shows cadence, target agent, and
 * last/next fire, with enable, run-now, and delete controls. Fires only run
 * while ADE is open — the clock lives in the app's main process.
 */
export function SchedulesView() {
	const utils = electronTrpc.useUtils();
	const { data: schedules = [] } = electronTrpc.schedules.getAll.useQuery();
	const { data: groups = [] } =
		electronTrpc.workspaces.getAllGrouped.useQuery();

	const invalidate = () => utils.schedules.getAll.invalidate();
	const updateSchedule = electronTrpc.schedules.update.useMutation({
		onSuccess: invalidate,
	});
	const deleteSchedule = electronTrpc.schedules.delete.useMutation({
		onSuccess: invalidate,
	});
	const runNow = electronTrpc.schedules.runNow.useMutation({
		onSuccess: invalidate,
	});

	const [newOpen, setNewOpen] = useState(false);

	const agents = useMemo<ScheduleAgent[]>(
		() =>
			groups.flatMap((group) =>
				group.workspaces.map((ws) => ({
					id: ws.id,
					name: ws.name,
					teamName: group.project.name,
				})),
			),
		[groups],
	);
	const agentNameById = useMemo(
		() => new Map(agents.map((a) => [a.id, a.name])),
		[agents],
	);

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between px-4 py-3">
				<h1 className="text-lg font-semibold">Schedules</h1>
				<Button size="sm" onClick={() => setNewOpen(true)}>
					<HiOutlinePlus className="mr-1 h-4 w-4" />
					New schedule
				</Button>
			</div>

			<div className="flex-1 overflow-y-auto px-4 pb-4">
				{schedules.length === 0 ? (
					<div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
						<HiOutlineClock className="h-8 w-8 opacity-50" />
						<p className="text-sm">
							No schedules yet — put an agent on a recurring job.
						</p>
					</div>
				) : (
					<div className="flex flex-col gap-2">
						{schedules.map((schedule) => (
							<div
								key={schedule.id}
								className={`group flex items-center gap-4 rounded-lg border p-3 ${
									schedule.enabled ? "" : "opacity-55"
								}`}
							>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="truncate text-sm font-medium">
											{schedule.name}
										</span>
										<code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
											{schedule.cronExpression}
										</code>
									</div>
									<p className="mt-0.5 truncate text-xs text-muted-foreground">
										{agentNameById.get(schedule.workspaceId) ??
											"(deleted agent)"}
										{" · "}
										{schedule.lastRunAt
											? `last ran ${formatDistanceToNow(schedule.lastRunAt, { addSuffix: true })}`
											: "never run"}
										{schedule.enabled && schedule.nextRunAt
											? ` · next ${formatDistanceToNow(schedule.nextRunAt, { addSuffix: true })}`
											: ""}
									</p>
								</div>

								<div className="flex items-center gap-1.5">
									<Button
										size="sm"
										variant="ghost"
										onClick={() => runNow.mutate({ id: schedule.id })}
										disabled={runNow.isPending}
										title="Run now"
									>
										<HiOutlinePlay className="h-4 w-4" />
									</Button>
									<Button
										size="sm"
										variant="ghost"
										onClick={() =>
											updateSchedule.mutate({
												id: schedule.id,
												enabled: !schedule.enabled,
											})
										}
									>
										{schedule.enabled ? "Pause" : "Resume"}
									</Button>
									<Button
										size="sm"
										variant="ghost"
										onClick={() => deleteSchedule.mutate({ id: schedule.id })}
										title="Delete"
										className="text-muted-foreground hover:text-destructive"
									>
										<HiOutlineTrash className="h-4 w-4" />
									</Button>
								</div>
							</div>
						))}
					</div>
				)}
			</div>

			<NewScheduleDialog
				open={newOpen}
				onOpenChange={setNewOpen}
				agents={agents}
			/>
		</div>
	);
}
