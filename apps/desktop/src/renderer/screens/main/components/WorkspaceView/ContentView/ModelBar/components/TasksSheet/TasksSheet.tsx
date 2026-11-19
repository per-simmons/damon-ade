import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@superset/ui/sheet";
import { toast } from "@superset/ui/sonner";
import { useDeferredValue, useMemo, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { TasksPanelView } from "./components/TasksPanelView";
import { useLaunchInNewTab } from "./hooks/useLaunchInNewTab";
import type { TaskActions } from "./types";

/**
 * The Tasks panel of a workspace: the container. It reads the project's
 * tasks, refreshes when ADE reports a change, and sends every action to the
 * workflow router, where the TaskController runs the stages. Nothing here
 * decides a transition.
 */

interface TasksSheetProps {
	workspaceId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

const onError = (err: { message: string }) => toast.error(err.message);

interface StateResult {
	state?: string;
	stateReason?: string | null;
}

export function TasksSheet({
	workspaceId,
	open,
	onOpenChange,
}: TasksSheetProps) {
	const utils = electronTrpc.useUtils();
	const launchInNewTab = useLaunchInNewTab();
	const [description, setDescription] = useState("");
	const deferredDescription = useDeferredValue(description.trim());

	const { data, error } = electronTrpc.workflow.getProjectTasks.useQuery(
		{ workspaceId },
		{
			enabled: open,
			// Change events refresh at once; polling is the fallback.
			refetchInterval: (query) =>
				open && query.state.data?.tasks.some((task) => task.state === "running")
					? 2000
					: open
						? 10_000
						: false,
		},
	);
	const { data: checks } = electronTrpc.workflow.getChecks.useQuery(
		{ workspaceId },
		{ enabled: open },
	);
	const { data: preview } = electronTrpc.workflow.classify.useQuery(
		{ description: deferredDescription },
		{ enabled: open && deferredDescription.length > 0 },
	);

	electronTrpc.workflow.onTaskChanged.useSubscription(undefined, {
		enabled: open,
		onData: (event) => {
			if (!data || event.projectKey === data.project.key) {
				void utils.workflow.getProjectTasks.invalidate({ workspaceId });
			}
		},
	});

	const refresh = () => {
		void utils.workflow.getProjectTasks.invalidate({ workspaceId });
		void utils.workflow.getChecks.invalidate({ workspaceId });
	};
	/** A launch that could not start comes back as a blocked task: say so. */
	const reportState = (result: StateResult) => {
		if (result.state === "blocked" || result.state === "failed") {
			toast.error(result.stateReason ?? "The task could not continue");
		}
		refresh();
	};
	const handlers = { onSuccess: reportState, onError };

	const createTask = electronTrpc.workflow.createTask.useMutation({
		onSuccess: (result) => {
			setDescription("");
			if (result.mode === "auto" && result.state === "running") {
				toast.success("Task started");
			}
			reportState(result);
		},
		onError,
	});
	const start = electronTrpc.workflow.start.useMutation(handlers);
	const resume = electronTrpc.workflow.resume.useMutation(handlers);
	const pause = electronTrpc.workflow.pause.useMutation(handlers);
	const cancel = electronTrpc.workflow.cancel.useMutation(handlers);
	const setMode = electronTrpc.workflow.setMode.useMutation(handlers);
	const answer = electronTrpc.workflow.answer.useMutation(handlers);
	const runStep = electronTrpc.workflow.runStep.useMutation(handlers);
	const moveHere = electronTrpc.workflow.moveHere.useMutation({
		onSuccess: refresh,
		onError,
	});
	const setBudget = electronTrpc.workflow.setBudget.useMutation({
		onSuccess: refresh,
		onError,
	});
	const setChecks = electronTrpc.workflow.setChecks.useMutation({
		onSuccess: (result) => {
			toast.success(
				result.commands.length
					? `${result.commands.length} check(s) approved`
					: "No checks: the review alone decides",
			);
			refresh();
		},
		onError,
	});

	const mutations = [
		createTask,
		start,
		resume,
		pause,
		cancel,
		setMode,
		answer,
		runStep,
		moveHere,
		setBudget,
		setChecks,
	];
	const busy = mutations.some((mutation) => mutation.isPending);

	const actions: TaskActions = useMemo(
		() => ({
			busy,
			onDescriptionChange: setDescription,
			onCreate: (input) => createTask.mutate({ workspaceId, ...input }),
			onStart: (slug) => start.mutate({ workspaceId, slug }),
			onResume: (slug) => resume.mutate({ workspaceId, slug }),
			onPause: (slug) => pause.mutate({ workspaceId, slug }),
			onCancel: (slug) => cancel.mutate({ workspaceId, slug }),
			onSetMode: (slug, mode) => setMode.mutate({ workspaceId, slug, mode }),
			onAnswer: (slug, answers) =>
				answer.mutate({ workspaceId, slug, answers }),
			onRunStep: (slug, kind, model) =>
				runStep.mutate({ workspaceId, slug, kind, model }),
			onMoveHere: (slug) => moveHere.mutate({ workspaceId, slug }),
			onSetBudget: (slug, budgetUsd) =>
				setBudget.mutate({ workspaceId, slug, budgetUsd }),
			onSaveChecks: (commands) => setChecks.mutate({ workspaceId, commands }),
			onOpenSession: (slug, runId) => {
				void (async () => {
					try {
						const session = await utils.workflow.sessionCommand.fetch({
							workspaceId,
							slug,
							runId,
						});
						await launchInNewTab(
							workspaceId,
							`Session · ${slug}`,
							session.command,
						);
					} catch (err) {
						onError(err as { message: string });
					}
				})();
			},
		}),
		[
			busy,
			workspaceId,
			createTask,
			start,
			resume,
			pause,
			cancel,
			setMode,
			answer,
			runStep,
			moveHere,
			setBudget,
			setChecks,
			utils,
			launchInNewTab,
		],
	);

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="w-[520px] overflow-y-auto sm:max-w-[520px]">
				<SheetHeader>
					<SheetTitle>Tasks{data ? ` · ${data.project.name}` : ""}</SheetTitle>
					<SheetDescription>
						Describe what you want. ADE picks the cheapest route that fits and
						runs it to a verified finish.
					</SheetDescription>
				</SheetHeader>
				<TasksPanelView
					data={data}
					error={error?.message}
					checks={checks}
					description={description}
					preview={preview}
					actions={actions}
				/>
			</SheetContent>
		</Sheet>
	);
}
