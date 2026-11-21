import { useCallback, useEffect, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Tab } from "renderer/stores/tabs/types";
import { useTabsWithPresets } from "renderer/stores/tabs/useTabsWithPresets";

/** Teams whose Team chat was checked in this run of ADE. */
const startedThisRun = new Set<string>();

/** Restored terminals report their title shortly after start-up. */
const SETTLE_MS = 3000;
/** A tab this new may not have reported "claude" as its title yet. */
const STARTING_MS = 15_000;

/**
 * Whether Claude Code is (still) running in a Team chat tab. A preset's name
 * is kept as the tab's title; `name` follows the terminal's own title, which
 * is "claude" while Claude Code runs and the shell's name once it has exited
 * (after a reboot, a restored tab is only a shell).
 */
function isRunning(tab: Tab): boolean {
	return /claude/i.test(tab.name) || Date.now() - tab.createdAt < STARTING_MS;
}

/**
 * The Team chat tab: Claude Code as the team's Coordinator, in the team's
 * own folder, with ADE's team tools (team-mcp.ts). It starts by itself the
 * first time a team's own workspace is opened in a run of ADE; a tab where
 * Claude Code is still running is reused, and one where it has exited is
 * replaced. `open` brings it back, or starts it again.
 */
export function useTeamChatTab(workspaceId: string | undefined) {
	const { openPreset } = useTabsWithPresets();
	const setActiveTab = useTabsStore((s) => s.setActiveTab);
	const removeTab = useTabsStore((s) => s.removeTab);
	// Saved tabs load after start-up: decide only once they have, or a tab
	// that survived the restart would be started a second time.
	const [hydrated, setHydrated] = useState(() =>
		useTabsStore.persist.hasHydrated(),
	);
	useEffect(() => {
		if (hydrated) return;
		if (useTabsStore.persist.hasHydrated()) {
			setHydrated(true);
			return;
		}
		return useTabsStore.persist.onFinishHydration(() => setHydrated(true));
	}, [hydrated]);
	const { data: launch } = electronTrpc.workflow.teamChatLaunch.useQuery(
		{ workspaceId: workspaceId ?? "" },
		{ enabled: !!workspaceId, staleTime: Number.POSITIVE_INFINITY },
	);

	/** The team's Team chat tabs, read fresh from the store. */
	const teamTabs = useCallback((): Tab[] => {
		if (!workspaceId || !launch?.enabled) return [];
		return useTabsStore
			.getState()
			.tabs.filter(
				(t) =>
					t.workspaceId === workspaceId &&
					(t.userTitle ?? t.name) === launch.tabName,
			);
	}, [workspaceId, launch]);

	/** Show a running Team chat, or start one in place of exited ones. */
	const ensure = useCallback(
		(focus: boolean) => {
			if (!workspaceId || !launch?.enabled) return;
			const tabs = teamTabs();
			const running = tabs.find(isRunning);
			// Tabs where Claude Code has exited are only shells: tidy them away.
			for (const dead of tabs.filter((t) => !isRunning(t))) removeTab(dead.id);
			if (running) {
				if (focus) setActiveTab(workspaceId, running.id);
				return;
			}
			openPreset(
				workspaceId,
				{
					id: "team-chat",
					name: launch.tabName,
					cwd: launch.cwd,
					commands: [launch.command],
					executionMode: "new-tab",
				},
				{ target: "new-tab" },
			);
		},
		[workspaceId, launch, teamTabs, setActiveTab, removeTab, openPreset],
	);

	useEffect(() => {
		if (!hydrated || !workspaceId || !launch?.enabled) return;
		if (startedThisRun.has(workspaceId)) return;
		// No saved tab: start at once. Saved tabs: wait for their terminals
		// to report what is running in them. Marked when it fires, so a
		// re-render that cancels the timer schedules it again.
		const delay = teamTabs().length ? SETTLE_MS : 0;
		const timer = setTimeout(() => {
			if (startedThisRun.has(workspaceId)) return;
			startedThisRun.add(workspaceId);
			ensure(false);
		}, delay);
		return () => clearTimeout(timer);
	}, [hydrated, workspaceId, launch, teamTabs, ensure]);

	const open = useCallback(() => ensure(true), [ensure]);

	return { available: !!launch?.enabled, open };
}
