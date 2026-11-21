import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { workflowProjectsDir } from "../agent-workflow/project-workflow";
import { getSupersetHomeDir } from "../app-environment";
import { recordSessionUsage, type SessionMetrics } from "./store";

/**
 * Records a session's usage when Claude Code reports a Stop through ADE's
 * notification hook. Runs off the request path and never throws, so it can
 * not slow down or break the hook.
 */

const DEBOUNCE_MS = 750;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

export function getMetricsDir(): string {
	return join(getSupersetHomeDir(), "metrics");
}

/**
 * The hook forwards transcript_path as it appears inside Claude's hook JSON,
 * so JSON escapes (a Windows path's doubled backslashes) are still in it.
 */
export function decodeHookString(raw: string): string {
	try {
		const decoded: unknown = JSON.parse(`"${raw}"`);
		return typeof decoded === "string" ? decoded : raw;
	} catch {
		return raw;
	}
}

/** Only absolute paths to existing .jsonl files are read. */
export function isRecordableTranscript(path: string): boolean {
	if (!isAbsolute(path) || !path.endsWith(".jsonl")) return false;
	try {
		return existsSync(path) && statSync(path).isFile();
	} catch {
		return false;
	}
}

export type SessionRecordedListener = (metrics: SessionMetrics) => void;
const listeners = new Set<SessionRecordedListener>();

/** Called after every successful recording (used by cost controls). */
export function onSessionRecorded(
	listener: SessionRecordedListener,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Record a session shortly after it stops. `transcriptPath` must already be a
 * plain path; decode hook values with decodeHookString first.
 */
export function scheduleSessionRecording(params: {
	transcriptPath: string;
	workspaceId?: string;
	projectKey?: string;
	metricsDir?: string;
}): void {
	const transcriptPath = params.transcriptPath.trim();
	if (!isRecordableTranscript(transcriptPath)) return;

	// Stop can fire several times in quick succession; record once it settles.
	const existing = pending.get(transcriptPath);
	if (existing) clearTimeout(existing);
	pending.set(
		transcriptPath,
		setTimeout(() => {
			pending.delete(transcriptPath);
			try {
				const metrics = recordSessionUsage({
					transcriptPath,
					metricsDir: params.metricsDir ?? getMetricsDir(),
					workspaceId: params.workspaceId,
					projectKey: params.projectKey,
					workflowProjectsDir: workflowProjectsDir(getSupersetHomeDir()),
				});
				if (!metrics) return;
				for (const listener of listeners) {
					try {
						listener(metrics);
					} catch (error) {
						console.error("[usage-metrics] Listener failed:", error);
					}
				}
			} catch (error) {
				console.error("[usage-metrics] Failed to record session:", error);
			}
		}, DEBOUNCE_MS),
	);
}
