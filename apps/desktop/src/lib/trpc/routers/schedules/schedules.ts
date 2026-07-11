import { agentSchedules } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import {
	getNextRun,
	type ScheduleFireEvent,
	scheduleEvents,
	startScheduler,
	syncSchedulerJobs,
	validateCronExpression,
} from "main/lib/schedules";
import { z } from "zod";
import { publicProcedure, router } from "../..";

const cronSchema = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.refine(validateCronExpression, {
		message: "Invalid cron expression (expected e.g. '0 9 * * 1-5')",
	});

/**
 * CRUD + live fire feed for recurring agent dispatches. The croner clock lives
 * in main/lib/schedules; every mutation re-syncs the armed jobs from the DB.
 */
export const createSchedulesRouter = () => {
	// Arm persisted schedules as soon as the app router is built.
	startScheduler();

	return router({
		getAll: publicProcedure.query(() => {
			return localDb
				.select()
				.from(agentSchedules)
				.all()
				.map((row) => ({
					...row,
					nextRunAt: row.enabled ? getNextRun(row.cronExpression) : null,
				}));
		}),

		create: publicProcedure
			.input(
				z.object({
					name: z.string().trim().min(1).max(120),
					cronExpression: cronSchema,
					workspaceId: z.string().min(1),
					prompt: z.string().trim().min(1).max(10_000),
					enabled: z.boolean().optional(),
				}),
			)
			.mutation(({ input }) => {
				const schedule = localDb
					.insert(agentSchedules)
					.values({
						name: input.name,
						cronExpression: input.cronExpression,
						workspaceId: input.workspaceId,
						prompt: input.prompt,
						enabled: input.enabled ?? true,
					})
					.returning()
					.get();
				syncSchedulerJobs();
				return schedule;
			}),

		update: publicProcedure
			.input(
				z.object({
					id: z.string(),
					name: z.string().trim().min(1).max(120).optional(),
					cronExpression: cronSchema.optional(),
					workspaceId: z.string().min(1).optional(),
					prompt: z.string().trim().min(1).max(10_000).optional(),
					enabled: z.boolean().optional(),
				}),
			)
			.mutation(({ input }) => {
				const { id, ...patch } = input;
				const schedule = localDb
					.update(agentSchedules)
					.set({ ...patch, updatedAt: Date.now() })
					.where(eq(agentSchedules.id, id))
					.returning()
					.get();
				if (!schedule) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Schedule not found",
					});
				}
				syncSchedulerJobs();
				return schedule;
			}),

		delete: publicProcedure
			.input(z.object({ id: z.string() }))
			.mutation(({ input }) => {
				localDb
					.delete(agentSchedules)
					.where(eq(agentSchedules.id, input.id))
					.run();
				syncSchedulerJobs();
				return { success: true };
			}),

		/** Fire a schedule immediately (same event path as the cron clock). */
		runNow: publicProcedure
			.input(z.object({ id: z.string() }))
			.mutation(({ input }) => {
				const schedule = localDb
					.select()
					.from(agentSchedules)
					.where(eq(agentSchedules.id, input.id))
					.get();
				if (!schedule) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Schedule not found",
					});
				}

				const firedAt = Date.now();
				localDb
					.update(agentSchedules)
					.set({ lastRunAt: firedAt, updatedAt: firedAt })
					.where(eq(agentSchedules.id, schedule.id))
					.run();

				const event: ScheduleFireEvent = {
					scheduleId: schedule.id,
					scheduleName: schedule.name,
					workspaceId: schedule.workspaceId,
					prompt: schedule.prompt,
					firedAt,
				};
				scheduleEvents.emit("fire", event);
				return { success: true };
			}),

		// trpc-electron requires the observable pattern for subscriptions.
		onFire: publicProcedure.subscription(() => {
			return observable<ScheduleFireEvent>((emit) => {
				const handler = (event: ScheduleFireEvent) => {
					emit.next(event);
				};
				scheduleEvents.on("fire", handler);
				return () => {
					scheduleEvents.off("fire", handler);
				};
			});
		}),
	});
};
