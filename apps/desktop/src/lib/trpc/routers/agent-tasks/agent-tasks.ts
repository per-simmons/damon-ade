import { type AgentTaskStatus, agentTasks } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import { z } from "zod";
import { publicProcedure, router } from "../..";

const statusSchema = z.enum(["todo", "in_progress", "review", "done"]);
const prioritySchema = z.enum(["urgent", "high", "medium", "low", "none"]);

/** Column order for a fresh card: append after the current max position. */
function nextPosition(status: AgentTaskStatus): number {
	const top = localDb
		.select({ position: agentTasks.position })
		.from(agentTasks)
		.where(eq(agentTasks.status, status))
		.orderBy(desc(agentTasks.position))
		.limit(1)
		.get();
	return (top?.position ?? 0) + 1024;
}

/**
 * ADE task board CRUD. Dispatch itself happens in the renderer (it spawns a
 * terminal session in the assigned agent's workspace); this router only owns
 * the card data and the dispatch/complete timestamps.
 */
export const createAgentTasksRouter = () => {
	return router({
		getAll: publicProcedure.query(() => {
			return localDb.select().from(agentTasks).all();
		}),

		create: publicProcedure
			.input(
				z.object({
					title: z.string().trim().min(1).max(200),
					description: z.string().trim().max(10_000).optional(),
					priority: prioritySchema.optional(),
					workspaceId: z.string().optional(),
				}),
			)
			.mutation(({ input }) => {
				return localDb
					.insert(agentTasks)
					.values({
						title: input.title,
						description: input.description || null,
						priority: input.priority ?? "none",
						workspaceId: input.workspaceId ?? null,
						position: nextPosition("todo"),
					})
					.returning()
					.get();
			}),

		update: publicProcedure
			.input(
				z.object({
					id: z.string(),
					title: z.string().trim().min(1).max(200).optional(),
					description: z.string().trim().max(10_000).nullable().optional(),
					priority: prioritySchema.optional(),
					workspaceId: z.string().nullable().optional(),
				}),
			)
			.mutation(({ input }) => {
				const { id, ...patch } = input;
				const task = localDb
					.update(agentTasks)
					.set({ ...patch, updatedAt: Date.now() })
					.where(eq(agentTasks.id, id))
					.returning()
					.get();
				if (!task) {
					throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
				}
				return task;
			}),

		/** Move a card to a status column at a given position (drag-drop). */
		move: publicProcedure
			.input(
				z.object({
					id: z.string(),
					status: statusSchema,
					position: z.number(),
				}),
			)
			.mutation(({ input }) => {
				const now = Date.now();
				const task = localDb
					.update(agentTasks)
					.set({
						status: input.status,
						position: input.position,
						completedAt: input.status === "done" ? now : null,
						updatedAt: now,
					})
					.where(eq(agentTasks.id, input.id))
					.returning()
					.get();
				if (!task) {
					throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
				}
				return task;
			}),

		/** Stamp a card as dispatched and move it to in_progress. */
		markDispatched: publicProcedure
			.input(z.object({ id: z.string() }))
			.mutation(({ input }) => {
				const now = Date.now();
				const task = localDb
					.update(agentTasks)
					.set({
						status: "in_progress",
						dispatchedAt: now,
						updatedAt: now,
					})
					.where(eq(agentTasks.id, input.id))
					.returning()
					.get();
				if (!task) {
					throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
				}
				return task;
			}),

		delete: publicProcedure
			.input(z.object({ id: z.string() }))
			.mutation(({ input }) => {
				localDb.delete(agentTasks).where(eq(agentTasks.id, input.id)).run();
				return { success: true };
			}),
	});
};
