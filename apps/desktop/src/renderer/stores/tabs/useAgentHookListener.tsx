import { toast } from "@superset/ui/sonner";
import { useNavigate } from "@tanstack/react-router";
import { useRef } from "react";
import { AgentReviewToast } from "renderer/components/AgentReviewToast/AgentReviewToast";
import { useCreateOrAttachWithTheme } from "renderer/hooks/useCreateOrAttachWithTheme";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { launchCommandInPane } from "renderer/lib/terminal/launch-command";
import { navigateToWorkspace } from "renderer/routes/_authenticated/_dashboard/utils/workspace-navigation";
import { NOTIFICATION_EVENTS } from "shared/constants";
import { debugLog } from "shared/debug";
import { useTabsStore } from "./store";
import { resolveNotificationTarget } from "./utils/resolve-notification-target";

/**
 * Hook that listens for agent lifecycle events via tRPC subscription and updates
 * pane status indicators accordingly.
 *
 * STATUS MAPPING:
 * - Start → "working" (amber pulsing indicator)
 * - Stop → "review" (green static) if pane's tab not active, "idle" if tab is active
 * - PermissionRequest → "permission" (red pulsing indicator)
 * - Terminal Exit → "idle" (handled in Terminal.tsx when mounted; also forwarded via notifications for unmounted panes)
 *
 * KNOWN LIMITATIONS (External - Claude Code / OpenCode hook systems):
 *
 * 1. User Interrupt (Ctrl+C): Claude Code's Stop hook does NOT fire when the user
 *    interrupts the agent. However, the terminal exit handler in Terminal.tsx
 *    will automatically clear the "working" indicator when the process exits.
 *
 * 2. Permission Denied: No hook fires when the user denies a permission request.
 *    The terminal exit handler will clear the "permission" indicator on process exit.
 *
 * 3. Tool Failures: No hook fires when a tool execution fails. The status
 *    continues until the agent stops or terminal exits.
 *
 * Note: Terminal exit detection (in Terminal.tsx) provides a reliable fallback
 * for clearing stuck indicators when agent hooks fail to fire.
 */
export function useAgentHookListener() {
	const navigate = useNavigate();
	const utils = electronTrpc.useUtils();
	const createOrAttach = useCreateOrAttachWithTheme();
	const writeToTerminal = electronTrpc.terminal.write.useMutation();

	// Ref avoids stale closure; parsed from URL since hook runs in _authenticated/layout
	const currentWorkspaceIdRef = useRef<string | null>(null);
	try {
		const match = window.location.pathname.match(/\/workspace\/([^/]+)/);
		currentWorkspaceIdRef.current = match ? match[1] : null;
	} catch {
		currentWorkspaceIdRef.current = null;
	}

	electronTrpc.notifications.subscribe.useSubscription(undefined, {
		onData: (event) => {
			if (!event.data) return;

			const state = useTabsStore.getState();

			// Autonomous invocation: open a terminal in the agent's folder and run
			// `claude` with the prompt. The agent works live in the terminal on the
			// user's subscription; claude's hooks fire Start/Stop (dot + review
			// toast) and its terminal title auto-names the tab.
			if (event.type === NOTIFICATION_EVENTS.AGENT_INVOKE) {
				const invoke = event.data as {
					workspaceId?: string;
					prompt?: string;
					tabTitle?: string;
					claudeSessionId?: string;
					fresh?: boolean;
				};
				const wsId = invoke.workspaceId;
				const prompt = invoke.prompt;
				if (!wsId || !prompt) return;
				const csid = invoke.claudeSessionId;
				const fresh = invoke.fresh !== false; // default to a fresh session

				// Tab title: explicit tabTitle (e.g. "Nightly maintenance", reused
				// across runs) or today's date (e.g. "6.17.26") for dated invokes.
				const now = new Date();
				const dateLabel = `${now.getMonth() + 1}.${now.getDate()}.${String(
					now.getFullYear(),
				).slice(-2)}`;
				const label = invoke.tabTitle?.trim() || dateLabel;

				// Background invoke: create (or REUSE) the agent's terminal + run
				// claude in it, but DON'T navigate the user's view there (no
				// pop-over). claude's hooks light the rail dot + fire the review toast.
				// Reuse an existing tab with this title so e.g. nightly maintenance
				// always writes to the same tab.
				const existingTab = state.tabs.find(
					(t) => t.workspaceId === wsId && (t.userTitle ?? t.name) === label,
				);
				let tabId: string;
				let paneId: string;
				// True when we're reusing a tab that already has a live claude
				// session running in it (vs. creating a fresh terminal).
				let reuseLiveSession = false;
				if (existingTab) {
					tabId = existingTab.id;
					paneId =
						state.focusedPaneIds[tabId] ??
						Object.values(state.panes).find((p) => p.tabId === tabId)?.id ??
						"";
					if (!paneId) {
						const created = state.addTab(wsId);
						tabId = created.tabId;
						paneId = created.paneId;
						state.renameTab(tabId, label);
					} else {
						reuseLiveSession = true;
					}
				} else {
					const created = state.addTab(wsId);
					tabId = created.tabId;
					paneId = created.paneId;
					state.renameTab(tabId, label);
				}

				const escaped = prompt.replace(/'/g, "'\\''");
				// Pin/resume a SPECIFIC claude session so repeated picks share ONE
				// conversation deterministically. `--continue` is "most recent in this
				// folder" — ambiguous when several Cicero sessions exist — so it loses
				// context. `--session-id <id>` (fresh) then `--resume <id>` is exact.
				const flag = csid
					? fresh
						? `--session-id ${csid} `
						: `--resume ${csid} `
					: fresh
						? ""
						: "--continue ";
				const command = `claude ${flag}--dangerously-skip-permissions '${escaped}'`;

				const launch = () =>
					launchCommandInPane({
						paneId,
						tabId,
						workspaceId: wsId,
						command,
						createOrAttach: (input) => createOrAttach.mutateAsync(input),
						write: (input) => writeToTerminal.mutateAsync(input),
					});

				if (reuseLiveSession) {
					// The tab already has a claude session (or a leftover stuck command).
					// You can't submit a message into a live claude TUI, so exit it back
					// to a shell first, then launch claude (resuming the day's session
					// keeps it one conversation).
					//
					// A MID-TASK claude needs THREE Ctrl-Cs to reach the shell (interrupt
					// the running task → arm exit → exit); an IDLE one needs two; at a
					// shell they're harmless. Sending only two left a mid-task claude
					// alive, so the relaunch command landed in its INPUT and never ran.
					// Send several, spaced out, so we always reach the shell from any state.
					void (async () => {
						for (let i = 0; i < 4; i++) {
							await writeToTerminal.mutateAsync({ paneId, data: "\x03" });
							await new Promise((r) => setTimeout(r, 450));
						}
						await new Promise((r) => setTimeout(r, 600));
						await launch();
					})();
				} else {
					void launch();
				}
				return;
			}

			const target = resolveNotificationTarget(event.data, state);
			if (!target) return;

			const { paneId, workspaceId } = target;

			if (event.type === NOTIFICATION_EVENTS.AGENT_LIFECYCLE) {
				if (!paneId) return;

				const lifecycleEvent = event.data;
				if (!lifecycleEvent) return;

				const { eventType } = lifecycleEvent;

				if (eventType === "Start") {
					state.setPaneStatus(paneId, "working");
				} else if (eventType === "PermissionRequest") {
					state.setPaneStatus(paneId, "permission");
				} else if (eventType === "Stop") {
					const activeTabId = state.activeTabIds[workspaceId];
					const pane = state.panes[paneId];
					const isInActiveTab =
						currentWorkspaceIdRef.current === workspaceId &&
						pane?.tabId === activeTabId;

					debugLog("agent-hooks", "Stop event:", {
						isInActiveTab,
						activeTabId,
						paneTabId: pane?.tabId,
						paneId,
						willSetTo: isInActiveTab ? "idle" : "review",
					});

					state.setPaneStatus(paneId, isInActiveTab ? "idle" : "review");

					// Agent-fleet review toast: an agent finished while you were
					// looking elsewhere. Scoped to agent workspaces (those with a
					// bust iconUrl) so regular off-screen terminal work doesn't toast.
					if (!isInActiveTab) {
						const agent = utils.workspaces.getAllGrouped
							.getData()
							?.flatMap((g) => g.workspaces)
							.find((w) => w.id === workspaceId);
						if (agent?.iconUrl) {
							const targetTabId = pane?.tabId;
							const iconUrl = agent.iconUrl;
							const name = agent.name;
							const role = agent.role;
							toast.custom(
								(id) => (
									<AgentReviewToast
										toastId={id}
										agentName={name}
										role={role}
										iconUrl={iconUrl}
										onOpen={() => {
											if (targetTabId) {
												state.setActiveTab(workspaceId, targetTabId);
												state.setFocusedPane(targetTabId, paneId);
												navigateToWorkspace(workspaceId, navigate, {
													search: { tabId: targetTabId, paneId },
												});
											}
											toast.dismiss(id);
										}}
									/>
								),
								{
									id: `agent-review-${workspaceId}`,
									duration: 10000,
									position: "top-right",
									unstyled: true,
								},
							);
						}
					}
				}
			} else if (event.type === NOTIFICATION_EVENTS.TERMINAL_EXIT) {
				// Clear transient status for unmounted panes (mounted panes handle this via stream subscription)
				if (!paneId) return;
				const currentPane = state.panes[paneId];
				if (
					currentPane?.status === "working" ||
					currentPane?.status === "permission"
				) {
					state.setPaneStatus(paneId, "idle");
				}
			} else if (event.type === NOTIFICATION_EVENTS.FOCUS_TAB) {
				navigateToWorkspace(workspaceId, navigate, {
					search: {
						tabId: target.tabId,
						paneId: target.paneId,
					},
				});
			}
		},
	});
}
