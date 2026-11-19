import { useCallback } from "react";
import { useCreateOrAttachWithTheme } from "renderer/hooks/useCreateOrAttachWithTheme";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { launchCommandInPane } from "renderer/lib/terminal/launch-command";
import { useTabsStore } from "renderer/stores/tabs/store";

/** Open a new terminal tab in the workspace, show it, and run `command`. */
export function useLaunchInNewTab() {
	const createOrAttach = useCreateOrAttachWithTheme();
	const writeToTerminal = electronTrpc.terminal.write.useMutation();

	return useCallback(
		(workspaceId: string, title: string, command: string) => {
			const state = useTabsStore.getState();
			const { tabId, paneId } = state.addTab(workspaceId);
			state.renameTab(tabId, title);
			state.setActiveTab(workspaceId, tabId);
			return launchCommandInPane({
				paneId,
				tabId,
				workspaceId,
				command,
				createOrAttach: (input) => createOrAttach.mutateAsync(input),
				write: (input) => writeToTerminal.mutateAsync(input),
			});
		},
		[createOrAttach, writeToTerminal],
	);
}
