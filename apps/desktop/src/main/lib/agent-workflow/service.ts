import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { resolveClaudeExecutable } from "../agent-invoke/headless-run";
import { findRealBinary } from "../agent-setup/utils";
import { getSupersetHomeDir } from "../app-environment";
import { findGitBash } from "../terminal/windows-shell";
import { treeKillWithEscalation } from "../tree-kill";
import { scheduleSessionRecording, transcriptPathFor } from "../usage-metrics";
import { runChecks } from "./checks";
import { TaskController } from "./controller";
import { listWorkflowProjects, type ProjectWorkflow } from "./project-workflow";
import { startStageRun } from "./stage-runner";
import { listTaskRecords } from "./tasks";
import { loadWorkflowSettings } from "./workflow-settings";

/**
 * The controller ADE's main process uses: real `claude -p` runs, checks run
 * through the user's shell, and process-tree kills. One per app, so the
 * per-task lock and the live-run table are shared by every caller.
 */

export interface TaskChangeEvent {
	projectKey: string;
	slug: string;
}

export const workflowEvents = new EventEmitter();
workflowEvents.setMaxListeners(50);

const killTree = async (pid: number): Promise<void> => {
	await treeKillWithEscalation({ pid });
};

/** How check commands are run: Git Bash on Windows when present, else cmd. */
export function checkShell(): string[] {
	if (process.platform === "win32") {
		const bash = findGitBash();
		return bash ? [bash, "-lc"] : ["cmd.exe", "/d", "/s", "/c"];
	}
	return [process.env.SHELL || "/bin/sh", "-lc"];
}

let controller: TaskController | undefined;

export function getTaskController(): TaskController {
	if (controller) return controller;
	const homeDir = getSupersetHomeDir();
	controller = new TaskController({
		homeDir,
		loadSettings: () => loadWorkflowSettings(homeDir),
		resolveClaude: () => {
			const executable = resolveClaudeExecutable(findRealBinary("claude"));
			return executable ? [executable] : null;
		},
		startRun: (spec, onProgress) =>
			startStageRun(spec, { killTree, onProgress }),
		runChecks: ({ cwd, commands, signal }) =>
			runChecks({ cwd, commands, signal, shell: checkShell(), killTree }),
		newId: randomUUID,
		now: () => new Date(),
		env: process.env,
		// Task runs are recorded like terminal sessions, under the project, so
		// `bun run workflow report` includes them (the panel counts them once,
		// from task.json).
		onRunFinished: (project, task, run) => {
			if (!run.sessionId) return;
			scheduleSessionRecording({
				transcriptPath: transcriptPathFor(
					task.identity.worktreePath,
					run.sessionId,
				),
				workspaceId: task.identity.workspaceId || undefined,
				projectKey: project.key,
			});
		},
		onChange: (project: ProjectWorkflow, slug: string) => {
			workflowEvents.emit("task-changed", {
				projectKey: project.key,
				slug,
			} satisfies TaskChangeEvent);
		},
	});
	return controller;
}

/** App quit: stop every managed run's process tree. */
export async function shutdownWorkflowRuns(): Promise<void> {
	if (controller) await controller.shutdown();
}

/**
 * At startup: runs that were in flight when ADE stopped are marked
 * interrupted and their tasks paused. Nothing paid is re-run.
 */
export function recoverWorkflowTasks(): number {
	const recovered = getTaskController().recover(
		listWorkflowProjects(getSupersetHomeDir()),
		(project) => listTaskRecords(project).map((task) => task.slug),
	);
	if (recovered > 0) {
		console.log(
			`[workflow] ${recovered} task(s) paused after an interrupted run`,
		);
	}
	return recovered;
}
