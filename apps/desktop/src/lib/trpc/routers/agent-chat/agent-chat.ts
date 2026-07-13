import { agentMessages, workspaces, worktrees } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { asc, eq } from "drizzle-orm";
import {
	type AgentChatEvent,
	chatConversationId,
	chatEvents,
	isChatRunning,
	sendChatMessage,
	stopChat,
} from "main/lib/agent-chat";
import { localDb } from "main/lib/local-db";
import { z } from "zod";
import { publicProcedure, router } from "../..";

/** Runtimes the headless chat can drive today (the claude binary). */
const CHAT_RUNTIMES = new Set(["claude"]);

/**
 * Chat-with-an-agent: history from agentMessages, turns via the headless
 * chat runner, live streaming through an observable subscription
 * (trpc-electron requires observables).
 */
export const createAgentChatRouter = () => {
	return router({
		history: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(({ input }) => {
				return localDb
					.select()
					.from(agentMessages)
					.where(
						eq(
							agentMessages.conversationId,
							chatConversationId(input.workspaceId),
						),
					)
					.orderBy(asc(agentMessages.createdAt))
					.all();
			}),

		isBusy: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(({ input }) => isChatRunning(input.workspaceId)),

		send: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					message: z.string().trim().min(1).max(50_000),
				}),
			)
			.mutation(({ input }) => {
				const workspace = localDb
					.select()
					.from(workspaces)
					.where(eq(workspaces.id, input.workspaceId))
					.get();
				if (!workspace) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Agent not found",
					});
				}
				if (!CHAT_RUNTIMES.has(workspace.runtime ?? "")) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"Chat currently supports Claude-runtime agents. Open a terminal session for this agent instead.",
					});
				}

				const worktree = workspace.worktreeId
					? localDb
							.select()
							.from(worktrees)
							.where(eq(worktrees.id, workspace.worktreeId))
							.get()
					: null;
				if (!worktree?.path) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "This agent has no worktree yet — open it once first.",
					});
				}

				try {
					sendChatMessage({
						workspaceId: workspace.id,
						agentName: workspace.name,
						worktreePath: worktree.path,
						prompt: input.message,
					});
				} catch (error) {
					throw new TRPCError({
						code: "CONFLICT",
						message:
							error instanceof Error ? error.message : "Failed to start turn",
					});
				}
				return { success: true };
			}),

		stop: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.mutation(({ input }) => {
				stopChat(input.workspaceId);
				return { success: true };
			}),

		onEvent: publicProcedure.subscription(() => {
			return observable<AgentChatEvent>((emit) => {
				const handler = (event: AgentChatEvent) => {
					emit.next(event);
				};
				chatEvents.on("event", handler);
				return () => {
					chatEvents.off("event", handler);
				};
			});
		}),
	});
};
