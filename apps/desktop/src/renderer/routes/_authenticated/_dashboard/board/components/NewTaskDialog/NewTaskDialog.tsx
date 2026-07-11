import type { AgentTaskPriority } from "@superset/local-db";
import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { toast } from "@superset/ui/sonner";
import { Textarea } from "@superset/ui/textarea";
import { useEffect, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { BoardAgent } from "../../types";

const PRIORITIES: AgentTaskPriority[] = [
	"none",
	"low",
	"medium",
	"high",
	"urgent",
];

const UNASSIGNED = "__unassigned__";

interface NewTaskDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agents: BoardAgent[];
}

/** Create a board card: title, optional description/priority/agent. */
export function NewTaskDialog({
	open,
	onOpenChange,
	agents,
}: NewTaskDialogProps) {
	const utils = electronTrpc.useUtils();
	const createTask = electronTrpc.agentTasks.create.useMutation({
		onSuccess: () => utils.agentTasks.getAll.invalidate(),
	});

	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [priority, setPriority] = useState<AgentTaskPriority>("none");
	const [agentId, setAgentId] = useState<string>(UNASSIGNED);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on each open
	useEffect(() => {
		if (open) {
			setTitle("");
			setDescription("");
			setPriority("none");
			setAgentId(UNASSIGNED);
		}
	}, [open]);

	const canCreate = title.trim().length > 0 && !createTask.isPending;

	const handleCreate = async () => {
		if (!canCreate) return;
		try {
			await createTask.mutateAsync({
				title: title.trim(),
				description: description.trim() || undefined,
				priority,
				workspaceId: agentId === UNASSIGNED ? undefined : agentId,
			});
			onOpenChange(false);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to create task");
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[440px]">
				<DialogHeader>
					<DialogTitle>New task</DialogTitle>
				</DialogHeader>

				<div className="flex flex-col gap-4 py-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="task-title">Title</Label>
						<Input
							id="task-title"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="What needs doing?"
							onKeyDown={(e) => {
								if (e.key === "Enter" && canCreate) handleCreate();
							}}
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="task-description">Description</Label>
						<Textarea
							id="task-description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							rows={4}
							placeholder="Details the agent needs — files, constraints, definition of done (optional)"
							className="resize-none"
						/>
					</div>

					<div className="flex gap-3">
						<div className="flex flex-1 flex-col gap-1.5">
							<Label>Priority</Label>
							<Select
								value={priority}
								onValueChange={(v) => setPriority(v as AgentTaskPriority)}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{PRIORITIES.map((p) => (
										<SelectItem key={p} value={p}>
											{p}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div className="flex flex-1 flex-col gap-1.5">
							<Label>Agent</Label>
							<Select value={agentId} onValueChange={setAgentId}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
									{agents.map((agent) => (
										<SelectItem key={agent.id} value={agent.id}>
											{agent.name}
											<span className="text-muted-foreground">
												{" "}
												· {agent.teamName}
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button onClick={handleCreate} disabled={!canCreate}>
						Create
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
