import { useParams } from "@tanstack/react-router";
import { AgentChatConversation } from "renderer/components/AgentChatConversation";
import { electronTrpc } from "renderer/lib/electron-trpc";

/** The in-workspace chat surface: the current agent's conversation, no picker. */
export function WorkspaceChat() {
	const { workspaceId } = useParams({ strict: false });
	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId! },
		{ enabled: !!workspaceId },
	);

	if (!workspaceId || !workspace) return null;

	return (
		<AgentChatConversation
			workspaceId={workspaceId}
			agentName={workspace.name}
		/>
	);
}
