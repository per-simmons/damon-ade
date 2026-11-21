import { Button } from "@superset/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@superset/ui/sheet";
import { toast } from "@superset/ui/sonner";
import { Textarea } from "@superset/ui/textarea";
import { useEffect, useRef, useState } from "react";
import { LuBot, LuMessagesSquare, LuSendHorizontal } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { PlanCard } from "./components/PlanCard";
import { SubtaskProgress } from "./components/SubtaskProgress";
import { STATE_LABELS, type TaskView } from "./types";

interface TeamChatSheetProps {
	workspaceId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

const NEW = "__new__";

/**
 * The team chat: a conversation with the Coordinator. It reads the code,
 * asks what it needs and proposes a plan for the team's specialists (and
 * their agents); the plan changes as the conversation goes, and nothing is
 * built until the user presses Go. Each conversation is a team request
 * underneath, so its runs, cost and subtasks also show in Tasks.
 */
export function TeamChatSheet({
	workspaceId,
	open,
	onOpenChange,
}: TeamChatSheetProps) {
	const utils = electronTrpc.useUtils();
	const [selected, setSelected] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const bottom = useRef<HTMLDivElement>(null);

	const { data, error } = electronTrpc.workflow.getProjectTasks.useQuery(
		{ workspaceId },
		{
			enabled: open,
			refetchInterval: (query) =>
				open && query.state.data?.tasks.some((t) => t.state === "running")
					? 2000
					: open
						? 10_000
						: false,
		},
	);
	const { data: agents = [] } = electronTrpc.specialists.agents.useQuery(
		{ workspaceId },
		{ enabled: open },
	);
	electronTrpc.workflow.onTaskChanged.useSubscription(undefined, {
		enabled: open,
		onData: (event) => {
			if (!data || event.projectKey === data.project.key) {
				void utils.workflow.getProjectTasks.invalidate({ workspaceId });
			}
		},
	});

	const tasks = data?.tasks ?? [];
	const chats = tasks
		.filter((t) => t.chat)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	const chat: TaskView | undefined = chats.find((c) => c.slug === selected);
	const messages = chat?.chat ?? [];
	const started = (chat?.subtaskSlugs.length ?? 0) > 0;
	const replying =
		!!chat && !started && chat.runs.some((run) => run.status === "running");
	const latestPlan = messages.reduce((index, m, i) => (m.plan ? i : index), -1);
	const subtasks = (chat?.subtaskSlugs ?? [])
		.map((slug) => tasks.find((t) => t.slug === slug))
		.filter((t): t is TaskView => !!t);
	const agentOf = (specialist?: string) =>
		specialist
			? agents.find((a) =>
					a.specialties.some(
						(s) => s.name.toLowerCase() === specialist.toLowerCase(),
					),
				)?.name
			: undefined;

	// Open on the latest conversation still being planned or run.
	useEffect(() => {
		if (!open || selected !== null || chats.length === 0) return;
		const live = chats.find(
			(c) => c.state !== "done" && c.state !== "cancelled",
		);
		if (live) setSelected(live.slug);
	}, [open, selected, chats]);

	// Keep the newest message in view: scroll when a message arrives or the
	// Coordinator starts replying.
	const messageCount = messages.length;
	useEffect(() => {
		if (messageCount > 0 || replying) {
			bottom.current?.scrollIntoView({ block: "end" });
		}
	}, [messageCount, replying]);

	const refresh = () =>
		void utils.workflow.getProjectTasks.invalidate({ workspaceId });
	const onError = (err: { message: string }) => toast.error(err.message);
	const startChat = electronTrpc.workflow.startChat.useMutation({
		onSuccess: (result) => {
			setSelected(result.slug);
			setDraft("");
			refresh();
		},
		onError,
	});
	const say = electronTrpc.workflow.chatSay.useMutation({
		onSuccess: () => {
			setDraft("");
			refresh();
		},
		onError,
	});
	const go = electronTrpc.workflow.chatGo.useMutation({
		onSuccess: refresh,
		onError,
	});
	const busy = startChat.isPending || say.isPending || go.isPending;

	const send = () => {
		const message = draft.trim();
		if (!message || busy || replying) return;
		if (chat) say.mutate({ workspaceId, slug: chat.slug, message });
		else startChat.mutate({ workspaceId, message });
	};

	const problem =
		chat &&
		!started &&
		!replying &&
		["blocked", "paused", "failed"].includes(chat.state)
			? chat.stateReason
			: null;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="flex w-[560px] flex-col sm:max-w-[560px]">
				<SheetHeader>
					<SheetTitle>
						Team plans{data ? ` · ${data.project.name}` : ""}
					</SheetTitle>
					<SheetDescription>
						Every plan for this team and how far it got, including those started
						from the Team chat tab. You can also plan one here with the
						Coordinator; nothing is built until you press Go.
					</SheetDescription>
				</SheetHeader>

				<div className="px-4">
					<Select
						value={chat ? chat.slug : NEW}
						onValueChange={(v) => setSelected(v === NEW ? null : v)}
					>
						<SelectTrigger className="h-8" aria-label="Conversation">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={NEW}>New conversation</SelectItem>
							{chats.map((c) => (
								<SelectItem key={c.slug} value={c.slug}>
									{c.title} · {STATE_LABELS[c.state] ?? c.state}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div
					className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-2"
					data-panel="team-chat"
				>
					{error && <p className="text-xs text-destructive">{error.message}</p>}
					{!chat && (
						<div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
							<span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
								<LuMessagesSquare className="size-5" aria-hidden />
							</span>
							<p className="text-sm font-medium">
								Plan work with the Coordinator
							</p>
							<p className="text-xs text-muted-foreground">
								Say what you want built, as you would to a lead engineer. It
								asks what matters, proposes who does what, and starts when you
								press Go. You can also use the Team chat tab (Claude Code).
							</p>
						</div>
					)}
					{messages.map((m, index) => (
						<div
							key={`${m.at}-${index}`}
							className={
								m.role === "user" ? "flex justify-end" : "flex justify-start"
							}
							data-chat-message={m.role}
						>
							<div
								className={
									m.role === "user"
										? "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground shadow-xs"
										: "max-w-[92%] space-y-2 rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm"
								}
							>
								{m.role === "coordinator" && (
									<p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
										<LuBot className="size-3.5" aria-hidden />
										Coordinator
									</p>
								)}
								<p className="whitespace-pre-wrap break-words">{m.text}</p>
								{m.plan && (
									<PlanCard
										plan={m.plan}
										agentOf={agentOf}
										canGo={index === latestPlan && !started && !replying}
										busy={busy}
										onGo={() =>
											chat && go.mutate({ workspaceId, slug: chat.slug })
										}
									/>
								)}
							</div>
						</div>
					))}
					{replying && (
						<p className="text-xs text-muted-foreground" data-chat-replying>
							The Coordinator is reading the code and writing a reply…
						</p>
					)}
					{problem && (
						<p className="text-xs text-amber-600" data-chat-problem>
							{problem} Send a message to try again.
						</p>
					)}
					{chat && started && (
						<SubtaskProgress request={chat} subtasks={subtasks} />
					)}
					<div ref={bottom} />
				</div>

				<div className="space-y-2 border-t px-4 py-3">
					<Textarea
						aria-label="Message to the Coordinator"
						rows={3}
						value={draft}
						disabled={started}
						placeholder={
							started
								? "This plan has started. Pick New conversation for more work."
								: chat
									? "Reply, or type go to start the plan (Enter sends, Shift+Enter for a new line)"
									: "What should the team build?"
						}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								send();
							}
						}}
					/>
					<div className="flex items-center justify-between gap-2">
						<span className="text-xs text-muted-foreground">
							{chat
								? `Coordinator replies: $${chat.spend.usd.toFixed(2)} (API-equivalent estimate; subtasks are in Tasks)`
								: "Each reply is a short read-only Opus run."}
						</span>
						<Button
							size="sm"
							disabled={busy || replying || started || !draft.trim()}
							onClick={send}
						>
							<LuSendHorizontal className="size-3.5" aria-hidden />
							Send
						</Button>
					</div>
				</div>
			</SheetContent>
		</Sheet>
	);
}
