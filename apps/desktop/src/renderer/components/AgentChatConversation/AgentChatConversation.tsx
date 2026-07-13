import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { Textarea } from "@superset/ui/textarea";
import { useEffect, useRef, useState } from "react";
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

interface AgentChatConversationProps {
	workspaceId: string;
	agentName: string;
}

/**
 * The chat surface for one agent: persisted history, streaming turn with
 * tool-activity chips, markdown rendering, and the composer. Used by both
 * the /chat route (with its agent picker) and the in-workspace chat view.
 * Turns drive the agent's own CLI headlessly in its worktree.
 */
export function AgentChatConversation({
	workspaceId,
	agentName,
}: AgentChatConversationProps) {
	const utils = electronTrpc.useUtils();

	const { data: history = [] } = electronTrpc.agentChat.history.useQuery(
		{ workspaceId },
		{ enabled: !!workspaceId },
	);
	const { data: busyOnLoad } = electronTrpc.agentChat.isBusy.useQuery(
		{ workspaceId },
		{ enabled: !!workspaceId },
	);

	const [draftTurn, setDraftTurn] = useState<DraftTurn | null>(null);
	const [input, setInput] = useState("");
	const busy = draftTurn !== null || busyOnLoad === true;

	const sendMessage = electronTrpc.agentChat.send.useMutation({
		onSuccess: () => {
			setDraftTurn({ text: "", tools: [] });
			utils.agentChat.history.invalidate({ workspaceId });
		},
		onError: (error) => toast.error(error.message),
	});
	const stopTurn = electronTrpc.agentChat.stop.useMutation();

	// Live stream: append text/tool events for this agent to the draft.
	electronTrpc.agentChat.onEvent.useSubscription(undefined, {
		onData: (event) => {
			if (event.workspaceId !== workspaceId) return;
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
				utils.agentChat.history.invalidate({ workspaceId });
				utils.agentChat.isBusy.invalidate({ workspaceId });
			} else if (event.type === "error") {
				setDraftTurn(null);
				utils.agentChat.isBusy.invalidate({ workspaceId });
				toast.error(event.text ?? "Chat turn failed");
			}
		},
	});

	// Reset the draft when switching agents.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on agent switch
	useEffect(() => {
		setDraftTurn(null);
	}, [workspaceId]);

	const scrollRef = useRef<HTMLDivElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content
	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
	}, [history.length, draftTurn?.text, draftTurn?.tools.length]);

	const handleSend = () => {
		const message = input.trim();
		if (!message || !workspaceId || busy) return;
		setInput("");
		sendMessage.mutate({ workspaceId, message });
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
				{history.length === 0 && !draftTurn ? (
					<div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
						<HiOutlineChatBubbleLeftRight className="h-8 w-8 opacity-50" />
						<p className="text-sm">
							Say something to {agentName} — it replies from inside its own
							worktree.
						</p>
					</div>
				) : (
					<div className="mx-auto flex max-w-3xl flex-col gap-4">
						{history.map((message) => (
							<MessageBubble
								key={message.id}
								role={message.role as "user" | "assistant"}
								content={message.content}
								agentName={agentName}
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
										agentName={agentName}
									/>
								) : (
									<p className="animate-pulse text-xs text-muted-foreground">
										{agentName} is working…
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
						placeholder={`Message ${agentName}…`}
						className="resize-none"
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
							onClick={() => stopTurn.mutate({ workspaceId })}
							title="Stop this turn"
						>
							<HiOutlineStop className="h-4 w-4" />
						</Button>
					) : (
						<Button
							onClick={handleSend}
							disabled={!input.trim()}
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
			<div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm">
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
