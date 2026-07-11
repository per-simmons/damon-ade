import { EventEmitter } from "node:events";
import { agentSchedules } from "@superset/local-db";
import { Cron } from "croner";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";

/**
 * The cron clock for agent schedules. Runs in the main process for the whole
 * app lifetime; on each fire it stamps lastRunAt and emits a fire event. The
 * renderer subscribes (schedules.onFire) and performs the actual dispatch so
 * the launched session shows up as a normal terminal tab. If no window is
 * subscribed when a job fires, that fire is skipped — by design for v1.
 */
export interface ScheduleFireEvent {
	scheduleId: string;
	scheduleName: string;
	workspaceId: string;
	prompt: string;
	firedAt: number;
}

export const scheduleEvents = new EventEmitter();

const jobs = new Map<string, Cron>();

export function validateCronExpression(expression: string): boolean {
	try {
		new Cron(expression, { paused: true }).stop();
		return true;
	} catch {
		return false;
	}
}

/** Next fire time for an expression, or null if it never fires / is invalid. */
export function getNextRun(expression: string): number | null {
	try {
		const cron = new Cron(expression, { paused: true });
		const next = cron.nextRun();
		cron.stop();
		return next ? next.getTime() : null;
	} catch {
		return null;
	}
}

function registerJob(schedule: {
	id: string;
	name: string;
	cronExpression: string;
	workspaceId: string;
	prompt: string;
}): void {
	try {
		const job = new Cron(schedule.cronExpression, () => {
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
			console.log(
				`[schedules] Fired "${schedule.name}" (${schedule.id}) -> workspace ${schedule.workspaceId}`,
			);
		});
		jobs.set(schedule.id, job);
	} catch (error) {
		console.error(
			`[schedules] Failed to register "${schedule.name}" (${schedule.cronExpression}):`,
			error,
		);
	}
}

/** Rebuild all cron jobs from the DB. Called at startup and after any CRUD. */
export function syncSchedulerJobs(): void {
	for (const job of jobs.values()) {
		job.stop();
	}
	jobs.clear();

	const rows = localDb
		.select()
		.from(agentSchedules)
		.where(eq(agentSchedules.enabled, true))
		.all();

	for (const row of rows) {
		registerJob(row);
	}
	console.log(`[schedules] ${rows.length} schedule(s) armed`);
}

export function startScheduler(): void {
	syncSchedulerJobs();
}
