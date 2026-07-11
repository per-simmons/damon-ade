import { buildAgentPromptCommand } from "@superset/shared/agent-command";
import { toast } from "@superset/ui/sonner";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useAgentSession } from "renderer/stores/tabs/useAgentSession";

/**
 * Turns schedule fires into real agent sessions. The main-process croner clock
 * emits schedules.onFire; this listener (mounted once in the authenticated
 * layout) resolves the target agent and launches its runtime CLI with the
 * schedule's prompt — exactly like a manual task-board dispatch.
 */
export function useScheduleFireListener() {
	const { spawnAgentSession } = useAgentSession();
	const utils = electronTrpc.useUtils();

	electronTrpc.schedules.onFire.useSubscription(undefined, {
		onData: async (event) => {
			try {
				// Throws NOT_FOUND if the agent was deleted; handled below.
				const workspace = await electronTrpcClient.workspaces.get.query({
					id: event.workspaceId,
				});

				const command = buildAgentPromptCommand({
					prompt: event.prompt,
					randomId: crypto.randomUUID(),
					agent: workspace.runtime ?? "claude",
				});

				spawnAgentSession(
					{
						id: workspace.id,
						runtime: workspace.runtime ?? "claude",
						worktreePath: workspace.worktreePath,
					},
					{
						commands: [command],
						label: `Cron · ${event.scheduleName.slice(0, 24)}`,
					},
				);
				utils.schedules.getAll.invalidate();
				toast.success(
					`Schedule "${event.scheduleName}" dispatched to ${workspace.name}`,
				);
			} catch (error) {
				console.error("[schedules] Dispatch failed:", error);
				toast.error(`Schedule "${event.scheduleName}" failed to dispatch`);
			}
		},
		onError: (error) => {
			console.error("[schedules] Subscription error:", error);
		},
	});
}
