import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { agentMessages } from "@superset/local-db";
import { BrowserWindow } from "electron";
import express from "express";
import { NOTIFICATION_EVENTS } from "shared/constants";
import { env } from "shared/env.shared";
import type {
	AgentInvokeEvent,
	AgentLifecycleEvent,
	AgentMessageEvent,
} from "shared/notification-types";
import { getAgentEntry } from "../agent-config/registry";
import {
	getInvokePromptDir,
	parseAgentInvokeRequest,
	resolveClaudeExecutable,
	runHeadlessClaude,
	shellKindFor,
	writeInvokePromptFile,
} from "../agent-invoke";
import {
	type HeadlessFinished,
	startHeadlessInvoke,
} from "../agent-invoke/headless-invoke";
import { findRealBinary } from "../agent-setup/utils";
import {
	ensureProjectWorkflow,
	portablePath,
	projectKeyFor,
} from "../agent-workflow/project-workflow";
import { loadWorkflowSettings } from "../agent-workflow/workflow-settings";
import { getSupersetHomeDir } from "../app-environment";
import { appState } from "../app-state";
import { localDb } from "../local-db";
import { getDefaultShell, HOOK_PROTOCOL_VERSION } from "../terminal/env";
import {
	appendHeadlessRun,
	decodeHookString,
	getMetricsDir,
	scheduleSessionRecording,
	transcriptPathFor,
} from "../usage-metrics";
import { mapEventType } from "./map-event-type";

// Re-export types for backwards compatibility
export type {
	AgentLifecycleEvent,
	NotificationIds,
} from "shared/notification-types";

/**
 * The environment this server is running in.
 * Used to validate incoming hook requests and detect cross-environment issues.
 */
const SERVER_ENV =
	env.NODE_ENV === "development" ? "development" : "production";
const debugHooksOverride = process.env.SUPERSET_DEBUG_HOOKS?.trim();
const DEBUG_HOOKS_ENABLED =
	debugHooksOverride === undefined
		? SERVER_ENV === "development"
		: !/^(0|false)$/i.test(debugHooksOverride);

export const notificationsEmitter = new EventEmitter();

const app = express();

// Parse JSON request bodies
app.use(express.json());

// CORS
app.use((req, res, next) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	if (req.method === "OPTIONS") {
		return res.status(200).end();
	}
	next();
});

/**
 * Resolves paneId from tabId or workspaceId using synced tabs state.
 * Falls back to focused pane in active tab.
 *
 * If a paneId is provided but doesn't exist in state (stale reference),
 * we fall through to tabId/workspaceId resolution instead of returning
 * an invalid paneId that would corrupt the store.
 */
function resolvePaneId(
	paneId: string | undefined,
	tabId: string | undefined,
	workspaceId: string | undefined,
	sessionId: string | undefined,
): string | undefined {
	try {
		const tabsState = appState.data.tabsState;
		if (!tabsState) return undefined;

		// If paneId provided, validate it exists before returning
		if (paneId && tabsState.panes?.[paneId]) {
			return paneId;
		}
		// If paneId was provided but doesn't exist, fall through to resolution

		// Try to resolve from tabId
		if (tabId) {
			const focusedPaneId = tabsState.focusedPaneIds?.[tabId];
			if (focusedPaneId && tabsState.panes?.[focusedPaneId]) {
				return focusedPaneId;
			}
		}

		// Try to resolve from workspaceId
		if (workspaceId) {
			const activeTabId = tabsState.activeTabIds?.[workspaceId];
			if (activeTabId) {
				const focusedPaneId = tabsState.focusedPaneIds?.[activeTabId];
				if (focusedPaneId && tabsState.panes?.[focusedPaneId]) {
					return focusedPaneId;
				}
			}
		}
	} catch {
		// App state not initialized yet, ignore
	}

	return undefined;
}

/** The project workflow for a headless run in `cwd`, or none if it fails. */
function headlessWorkflowFor(
	cwd: string,
): { tasksDir: string; agentsJson: string } | undefined {
	try {
		const workflow = ensureProjectWorkflow(getSupersetHomeDir(), cwd);
		return {
			tasksDir: portablePath(workflow.tasksDir),
			agentsJson: readFileSync(workflow.agentsFile, "utf8"),
		};
	} catch (error) {
		console.warn("[notifications] No workflow for headless run:", error);
		return undefined;
	}
}

/** Log a finished headless run and record its usage from the transcript. */
function recordHeadlessRun(finished: HeadlessFinished): void {
	const { result } = finished;
	const report = result.report;
	appendHeadlessRun(getMetricsDir(), {
		at: new Date().toISOString(),
		agent: finished.agent,
		cwd: finished.cwd,
		model: finished.model,
		maxBudgetUsd: finished.maxBudgetUsd,
		maxTurns: finished.maxTurns,
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		durationMs: result.durationMs,
		sessionId: report?.sessionId,
		reportedCostUsd: report?.totalCostUsd,
		numTurns: report?.numTurns,
		isError: report?.isError,
		subtype: report?.subtype,
		error:
			result.parseError ??
			(result.exitCode === 0 ? undefined : result.stderrTail),
	});
	console.log(
		`[notifications] headless run for ${finished.agent} finished: exit ${result.exitCode}, ${report?.subtype ?? "no result"}, reported $${report?.totalCostUsd?.toFixed(4) ?? "?"}`,
	);
	// Headless runs bypass ADE's terminal hooks, so record usage directly.
	if (report?.sessionId) {
		scheduleSessionRecording({
			transcriptPath: transcriptPathFor(finished.cwd, report.sessionId),
			projectKey: projectKeyFor(finished.cwd),
		});
	}
}

// Agent lifecycle hook
app.get("/hook/complete", (req, res) => {
	const {
		paneId,
		tabId,
		workspaceId,
		sessionId,
		transcriptPath,
		projectKey,
		eventType,
		env: clientEnv,
		version,
	} = req.query;

	// Environment validation: detect dev/prod cross-talk
	// We still return success to not block the agent, but log a warning
	if (clientEnv && clientEnv !== SERVER_ENV) {
		console.warn(
			`[notifications] Environment mismatch: received ${clientEnv} request on ${SERVER_ENV} server. ` +
				`This may indicate a stale hook or misconfigured terminal. Ignoring request.`,
		);
		return res.json({ success: true, ignored: true, reason: "env_mismatch" });
	}

	// Log version for debugging (helpful when troubleshooting hook issues)
	if (version && version !== HOOK_PROTOCOL_VERSION) {
		console.log(
			`[notifications] Received hook v${version} request (server expects v${HOOK_PROTOCOL_VERSION})`,
		);
	}

	const mappedEventType = mapEventType(eventType as string | undefined);

	// Unknown or missing eventType: return success but don't process
	// This ensures forward compatibility and doesn't block the agent
	if (!mappedEventType) {
		if (eventType) {
			console.log("[notifications] Ignoring unknown eventType:", eventType);
		}
		return res.json({ success: true, ignored: true });
	}

	const resolvedPaneId = resolvePaneId(
		paneId as string | undefined,
		tabId as string | undefined,
		workspaceId as string | undefined,
		sessionId as string | undefined,
	);

	const event: AgentLifecycleEvent = {
		paneId: resolvedPaneId,
		tabId: tabId as string | undefined,
		workspaceId: workspaceId as string | undefined,
		eventType: mappedEventType,
	};

	if (DEBUG_HOOKS_ENABLED) {
		console.log("[notifications] hook event received", {
			eventType,
			mappedEventType,
			paneId: paneId as string | undefined,
			tabId: tabId as string | undefined,
			workspaceId: workspaceId as string | undefined,
			sessionId: sessionId as string | undefined,
			resolvedPaneId,
		});
	}

	notificationsEmitter.emit(NOTIFICATION_EVENTS.AGENT_LIFECYCLE, event);

	// Claude Code sends its transcript path; record the session's token usage
	// from it once the turn has stopped (debounced, off the request path).
	if (mappedEventType === "Stop" && typeof transcriptPath === "string") {
		scheduleSessionRecording({
			transcriptPath: decodeHookString(transcriptPath),
			workspaceId: typeof workspaceId === "string" ? workspaceId : undefined,
			projectKey:
				typeof projectKey === "string" && projectKey ? projectKey : undefined,
		});
	}

	res.json({ success: true, paneId: resolvedPaneId, tabId });
});

/**
 * Autonomous agent invocation. A cron/watcher (or external trigger) POSTs here;
 * we start the agent turn server-side on the Claude subscription (mastracode
 * runtime, identity+skills+MCP read from the agent's folder) and open/focus that
 * agent's chat-mastra tab in ADE so the user watches it work.
 *
 *   POST /agent/invoke
 *   { agent, prompt, tab?, claudeSessionId?, fresh?, model?,
 *     mode?: "terminal" | "headless", maxBudgetUsd? }
 *
 * mode "headless" runs `claude -p` in the background with a hard spending and
 * turn cap (Settings > Models & Cost) and answers 202 straight away.
 *
 * Validation, the prompt file and the shell choice live in main/lib/agent-invoke.
 */
app.post("/agent/invoke", async (req, res) => {
	const parsed = parseAgentInvokeRequest(req.body, getAgentEntry);
	if (!parsed.ok) {
		return res
			.status(parsed.status)
			.json({ success: false, error: parsed.error });
	}
	const request = parsed.request;
	if (request.ignoredRegistryModel) {
		console.warn(
			`[notifications] /agent/invoke: ignoring registry model for ${request.agent}; it is not a plain model name`,
		);
	}

	if (request.mode === "headless") {
		const started = startHeadlessInvoke(request, {
			limits: () => loadWorkflowSettings(getSupersetHomeDir()).budgets,
			findExecutable: () => resolveClaudeExecutable(findRealBinary("claude")),
			// Same workflow roles as the agent's terminal sessions.
			run: (params) =>
				runHeadlessClaude({
					...params,
					workflow: headlessWorkflowFor(request.entry.cwd),
				}),
			onFinished: recordHeadlessRun,
		});
		return res.status(started.status).json(started.body);
	}

	try {
		// The prompt goes to a private file, never onto the command line.
		const promptFile = writeInvokePromptFile(
			getInvokePromptDir(getSupersetHomeDir()),
			request.prompt,
		);

		// Tell the renderer to open a terminal in the agent's folder and run
		// `claude` with the prompt. The agent works live in the terminal on Pat's
		// subscription; claude's own hooks fire Start/Stop (dot + review toast)
		// and its terminal title auto-names the tab.
		const invokeEvent: AgentInvokeEvent = {
			agentName: request.agent,
			sessionId: request.entry.sessionId,
			workspaceId: request.entry.workspaceId,
			prompt: request.prompt,
			promptFile,
			shell: shellKindFor(getDefaultShell()),
			cwd: request.entry.cwd,
			tabTitle: request.tabTitle,
			claudeSessionId: request.claudeSessionId,
			fresh: request.fresh,
			model: request.model,
		};
		notificationsEmitter.emit(NOTIFICATION_EVENTS.AGENT_INVOKE, invokeEvent);

		// Intentionally do NOT foreground ADE or steal focus — invokes are
		// background (cron/watcher). The agent's terminal opens + runs silently;
		// claude's hooks light the rail dot + fire the review toast, and the user
		// clicks in when they're ready.

		res.json({
			success: true,
			agent: request.agent,
			sessionId: request.entry.sessionId,
		});
	} catch (error) {
		console.error("[notifications] /agent/invoke failed:", error);
		res.status(500).json({ success: false, error: String(error) });
	}
});

/**
 * Agent feed message. An agent (from its terminal, via the post-to-feed skill)
 * or any trigger POSTs a finding here; we persist it to `agent_messages` and
 * broadcast it so the feed pane updates live. This is ADE's local "Convex":
 * research streams in and shows up in a persistent channel.
 *
 *   POST /agent/message  { agent, content, conversation?, role?, metadata? }
 */
app.post("/agent/message", (req, res) => {
	const { agent, content, conversation, role, metadata } = (req.body ?? {}) as {
		agent?: string;
		content?: string;
		conversation?: string;
		role?: "assistant" | "user";
		metadata?: Record<string, unknown>;
	};

	if (!agent || !content) {
		return res
			.status(400)
			.json({ success: false, error: "agent and content are required" });
	}

	// Resolve the agent's workspace (for avatar/role in the feed). Optional —
	// an unknown agent name still posts (workspaceId stays undefined).
	const entry = getAgentEntry(agent);
	const conversationId = (conversation ?? "main").trim() || "main";
	const messageRole = role === "user" ? "user" : "assistant";

	try {
		const inserted = localDb
			.insert(agentMessages)
			.values({
				conversationId,
				agentName: agent,
				workspaceId: entry?.workspaceId,
				content,
				role: messageRole,
				metadata: metadata ?? undefined,
			})
			.returning()
			.get();

		const event: AgentMessageEvent = {
			id: inserted.id,
			conversationId: inserted.conversationId,
			agentName: inserted.agentName,
			workspaceId: inserted.workspaceId ?? undefined,
			content: inserted.content,
			role: messageRole,
			metadata: metadata ?? undefined,
			createdAt: inserted.createdAt,
		};
		notificationsEmitter.emit(NOTIFICATION_EVENTS.AGENT_MESSAGE, event);

		res.json({ success: true, id: inserted.id });
	} catch (error) {
		console.error("[notifications] /agent/message failed:", error);
		res.status(500).json({ success: false, error: String(error) });
	}
});

// Health check
app.get("/health", (_req, res) => {
	res.json({ status: "ok" });
});

// 404
app.use((_req, res) => {
	res.status(404).json({ error: "Not found" });
});

export const notificationsApp = app;
