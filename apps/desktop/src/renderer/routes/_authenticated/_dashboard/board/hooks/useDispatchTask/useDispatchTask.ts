import { buildAgentPromptCommand } from "@superset/shared/agent-command";
import { toast } from "@superset/ui/sonner";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useAgentSession } from "renderer/stores/tabs/useAgentSession";
import type { BoardAgent, BoardTask } from "../../types";

function buildTaskPrompt(task: BoardTask): string {
	const meta = task.priority !== "none" ? `Priority: ${task.priority}\n\n` : "";
	return `You are working on the task "${task.title}" from your ADE task board.

${meta}## Task Description

${task.description || "No description provided."}

## Instructions

Work autonomously — make decisions from the codebase and the task description without waiting for feedback.

1. Explore the relevant code and plan the change
2. Implement it
3. Verify it (tests, typecheck, lint — whatever the project has)
4. Finish with a short summary of what you did and anything the user should review`;
}

/**
 * Dispatch a board task to its assigned agent: spawn the agent's runtime CLI
 * in its worktree with the task as the opening prompt, stamp the card as
 * in_progress, and jump to the agent's workspace to watch it run.
 */
export function useDispatchTask() {
	const navigate = useNavigate();
	const utils = electronTrpc.useUtils();
	const { spawnAgentSession } = useAgentSession();
	const markDispatched = electronTrpc.agentTasks.markDispatched.useMutation({
		onSuccess: () => utils.agentTasks.getAll.invalidate(),
	});

	const dispatchTask = useCallback(
		async (task: BoardTask, agent: BoardAgent) => {
			if (!agent.worktreePath) {
				toast.error(
					`${agent.name} has no worktree yet — open the agent once first.`,
				);
				return;
			}

			const command = buildAgentPromptCommand({
				prompt: buildTaskPrompt(task),
				randomId: crypto.randomUUID(),
				agent: agent.runtime ?? "claude",
			});

			spawnAgentSession(
				{
					id: agent.id,
					runtime: agent.runtime ?? "claude",
					worktreePath: agent.worktreePath,
				},
				{ commands: [command], label: `Task · ${task.title.slice(0, 24)}` },
			);

			try {
				await markDispatched.mutateAsync({ id: task.id });
			} catch {
				// The session is already launching; a failed stamp shouldn't block it.
			}

			navigate({
				to: "/workspace/$workspaceId",
				params: { workspaceId: agent.id },
			});
			toast.success(`Dispatched to ${agent.name}`);
		},
		[markDispatched, navigate, spawnAgentSession],
	);

	return { dispatchTask, isDispatching: markDispatched.isPending };
}
