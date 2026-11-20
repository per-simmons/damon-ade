import { useCallback, useEffect, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useTabsWithPresets } from "renderer/stores/tabs/useTabsWithPresets";

/** Teams whose Team chat tab was started in this run of ADE. */
const startedThisRun = new Set<string>();

/**
 * The Team chat tab: Claude Code as the team's Coordinator, in the team's
 * own folder, with ADE's team tools (team-mcp.ts). It starts by itself the
 * first time a team's own workspace is opened in a run of ADE, unless the
 * tab is already there (terminal sessions outlive restarts). `open` brings
 * it back, or starts it again after it was closed.
 */
export function useTeamChatTab(workspaceId: string | undefined) {
	const { openPreset } = useTabsWithPresets();
	const tabs = useTabsStore((s) => s.tabs);
	const setActiveTab = useTabsStore((s) => s.setActiveTab);
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

	const existing =
		workspaceId && launch?.enabled
			? tabs.find(
					// A preset's name is kept as the tab's title (`name` becomes the
					// terminal's own title, e.g. "claude").
					(t) =>
						t.workspaceId === workspaceId &&
						(t.userTitle ?? t.name) === launch.tabName,
				)
			: undefined;

	const start = useCallback(() => {
		if (!workspaceId || !launch?.enabled) return;
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
	}, [workspaceId, launch, openPreset]);

	useEffect(() => {
		if (!hydrated || !workspaceId || !launch?.enabled) return;
		if (startedThisRun.has(workspaceId)) return;
		startedThisRun.add(workspaceId);
		if (!existing) start();
	}, [hydrated, workspaceId, launch, existing, start]);

	const open = useCallback(() => {
		if (!workspaceId) return;
		if (existing) setActiveTab(workspaceId, existing.id);
		else start();
	}, [workspaceId, existing, setActiveTab, start]);

	return { available: !!launch?.enabled, open };
}
