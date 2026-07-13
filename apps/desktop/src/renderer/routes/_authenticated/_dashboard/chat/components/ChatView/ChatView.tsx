import { Button } from "@superset/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { toast } from "@superset/ui/sonner";
import { Textarea } from "@superset/ui/textarea";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	HiOutlineChatBubbleLeftRight,
	HiOutlinePaperAirplane,
	HiOutlineStop,
	HiOutlineWrenchScrewdriver,
} from "react-icons/hi2";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { electronTrpc } from "renderer/lib/electron-trpc";

/** In-flight assistant turn assembled from streaming events. */
interface DraftTurn {
	text: string;
	tools: string[];
}

/**
 * Conductor-style chat with an agent: pick an agent, type, and the reply
 * streams in as rendered markdown with tool activity shown as chips. Each
 * turn drives the agent's own CLI headlessly in its worktree (same login,
 * memory, and repo as its terminal sessions), so billing stays on the
 * user's subscriptions. History persists in agentMessages.
 */
export function ChatView() {
	const utils = electronTrpc.useUtils();
	const { data: groups = [] } =
		electronTrpc.workspaces.getAllGrouped.useQuery();

	const agents = useMemo(
		() =>
			groups.flatMap((group) =>
				group.workspaces.map((ws) => ({
					id: ws.id,
					name: ws.name,
					runtime: ws.runtime,
					iconUrl: ws.iconUrl,
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

	const { data: history = [] } = electronTrpc.agentChat.history.useQuery(
		{ workspaceId: agentId },
		{ enabled: !!agentId },
	);
	const { data: busyOnLoad } = electronTrpc.agentChat.isBusy.useQuery(
		{ workspaceId: agentId },
		{ enabled: !!agentId },
	);

	const [draftTurn, setDraftTurn] = useState<DraftTurn | null>(null);
	const [input, setInput] = useState("");
	const busy = draftTurn !== null || busyOnLoad === true;

	const sendMessage = electronTrpc.agentChat.send.useMutation({
		onSuccess: () => {
			setDraftTurn({ text: "", tools: [] });
			utils.agentChat.history.invalidate({ workspaceId: agentId });
		},
		onError: (error) => toast.error(error.message),
	});
	const stopTurn = electronTrpc.agentChat.stop.useMutation();

	// Live stream: append text/tool events for the selected agent to the draft.
	electronTrpc.agentChat.onEvent.useSubscription(undefined, {
		onData: (event) => {
			if (event.workspaceId !== agentId) return;
			if (event.type === "text") {
				setDraftTurn((prev) => ({
					text: (prev?.text ?? "") + (event.text ?? ""),
					tools: prev?.tools ?? [],
				}));
			} else if (event.type === "tool") {
				setDraftTurn((prev) => ({
					text: prev?.text ?? "",
					tools: [...(prev?.tools ?? []), event.toolName ?? "tool"],
				}));
			} else if (event.type === "done") {
				setDraftTurn(null);
				utils.agentChat.history.invalidate({ workspaceId: agentId });
				utils.agentChat.isBusy.invalidate({ workspaceId: agentId });
			} else if (event.type === "error") {
				setDraftTurn(null);
				utils.agentChat.isBusy.invalidate({ workspaceId: agentId });
				toast.error(event.text ?? "Chat turn failed");
			}
		},
	});

	// Reset the draft when switching agents.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on agent switch
	useEffect(() => {
		setDraftTurn(null);
	}, [agentId]);

	const scrollRef = useRef<HTMLDivElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content
	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
	}, [history.length, draftTurn?.text, draftTurn?.tools.length]);

	const handleSend = () => {
		const message = input.trim();
		if (!message || !agentId || busy) return;
		setInput("");
		sendMessage.mutate({ workspaceId: agentId, message });
	};

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

			<div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
				{history.length === 0 && !draftTurn ? (
					<div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
						<HiOutlineChatBubbleLeftRight className="h-8 w-8 opacity-50" />
						<p className="text-sm">
							{agent
								? `Say something to ${agent.name} — it replies from inside its own worktree.`
								: "Create an agent to start chatting."}
						</p>
					</div>
				) : (
					<div className="mx-auto flex max-w-3xl flex-col gap-4">
						{history.map((message) => (
							<MessageBubble
								key={message.id}
								role={message.role as "user" | "assistant"}
								content={message.content}
								agentName={agent?.name ?? message.agentName}
							/>
						))}
						{draftTurn && (
							<div className="flex flex-col gap-1.5">
								{draftTurn.tools.length > 0 && (
									<div className="flex flex-wrap gap-1.5">
										{draftTurn.tools.map((tool, i) => (
											<span
												// biome-ignore lint/suspicious/noArrayIndexKey: append-only list
												key={`${tool}-${i}`}
												className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
											>
												<HiOutlineWrenchScrewdriver className="h-3 w-3" />
												{tool}
											</span>
										))}
									</div>
								)}
								{draftTurn.text ? (
									<MessageBubble
										role="assistant"
										content={draftTurn.text}
										agentName={agent?.name ?? "Agent"}
									/>
								) : (
									<p className="text-xs text-muted-foreground animate-pulse">
										{agent?.name ?? "Agent"} is working…
									</p>
								)}
							</div>
						)}
					</div>
				)}
			</div>

			<div className="border-t px-4 py-3">
				<div className="mx-auto flex max-w-3xl items-end gap-2">
					<Textarea
						value={input}
						onChange={(e) => setInput(e.target.value)}
						rows={2}
						placeholder={
							agent ? `Message ${agent.name}…` : "Pick an agent first"
						}
						className="resize-none"
						disabled={!agentId}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								handleSend();
							}
						}}
					/>
					{busy ? (
						<Button
							variant="secondary"
							onClick={() => stopTurn.mutate({ workspaceId: agentId })}
							title="Stop this turn"
						>
							<HiOutlineStop className="h-4 w-4" />
						</Button>
					) : (
						<Button
							onClick={handleSend}
							disabled={!input.trim() || !agentId}
							title="Send (Enter)"
						>
							<HiOutlinePaperAirplane className="h-4 w-4" />
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}

function MessageBubble({
	role,
	content,
	agentName,
}: {
	role: "user" | "assistant";
	content: string;
	agentName: string;
}) {
	if (role === "user") {
		return (
			<div className="ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
				{content}
			</div>
		);
	}
	return (
		<div className="flex max-w-[95%] flex-col gap-1">
			<span className="text-xs font-medium text-muted-foreground">
				{agentName}
			</span>
			<div className="prose prose-sm dark:prose-invert max-w-none text-sm [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3">
				<ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
			</div>
		</div>
	);
}
