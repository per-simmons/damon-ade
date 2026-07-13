import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { useEffect, useMemo, useState } from "react";
import { AgentChatConversation } from "renderer/components/AgentChatConversation";
import { electronTrpc } from "renderer/lib/electron-trpc";

/**
 * Cross-agent chat page: an agent picker over the shared conversation
 * surface. The same conversation also lives inside each agent's workspace
 * (the Chat/Terminal toggle) — this page is for hopping between agents.
 */
export function ChatView() {
	const { data: groups = [] } =
		electronTrpc.workspaces.getAllGrouped.useQuery();

	const agents = useMemo(
		() =>
			groups.flatMap((group) =>
				group.workspaces.map((ws) => ({
					id: ws.id,
					name: ws.name,
					teamName: group.project.name,
				})),
			),
		[groups],
	);

	const [agentId, setAgentId] = useState<string>(
		() => localStorage.getItem("ade.chat.lastAgentId") ?? "",
	);
	const agent = agents.find((a) => a.id === agentId) ?? null;

	// Default to the first agent once the list loads.
	useEffect(() => {
		if (!agentId && agents.length > 0) {
			setAgentId(agents[0].id);
		}
	}, [agentId, agents]);
	useEffect(() => {
		if (agentId) localStorage.setItem("ade.chat.lastAgentId", agentId);
	}, [agentId]);

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
				<h1 className="text-lg font-semibold">Chat</h1>
				<div className="w-64">
					<Select value={agentId} onValueChange={setAgentId}>
						<SelectTrigger>
							<SelectValue placeholder="Pick an agent" />
						</SelectTrigger>
						<SelectContent>
							{agents.map((a) => (
								<SelectItem key={a.id} value={a.id}>
									{a.name}
									<span className="text-muted-foreground"> · {a.teamName}</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			{agent ? (
				<AgentChatConversation workspaceId={agent.id} agentName={agent.name} />
			) : (
				<div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
					Create an agent to start chatting.
				</div>
			)}
		</div>
	);
}
