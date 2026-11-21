import { cn } from "@superset/ui/utils";
import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	LuArrowDown,
	LuArrowUp,
	LuCornerDownLeft,
	LuSendHorizontal,
} from "react-icons/lu";
import { electronTrpcClient } from "renderer/lib/trpc-client";

interface TerminalComposerProps {
	paneId: string;
	placeholder?: string;
}

/** Keys Claude Code's menus answer to (the trust question, permissions). */
const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	enter: "\r",
	escape: "\x1b",
};

const HISTORY_LIMIT = 50;

/**
 * A message box under a Claude Code terminal: write comfortably (several
 * lines, normal editing, your earlier messages with ↑), then Enter sends it
 * to the session as one message. Several lines go as a bracketed paste, so
 * Claude Code takes them as one message and not as several. With the box
 * empty, Enter, the arrows and Esc go to the terminal, to answer its menus.
 */
export function TerminalComposer({
	paneId,
	placeholder,
}: TerminalComposerProps) {
	const [text, setText] = useState("");
	const [history, setHistory] = useState<string[]>([]);
	const [browsing, setBrowsing] = useState<number | null>(null);
	const box = useRef<HTMLTextAreaElement>(null);

	// Grow with the text, up to about eight lines; back to one when empty.
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = text ? `${Math.min(el.scrollHeight, 180)}px` : "";
	}, [text]);

	const write = (data: string) =>
		electronTrpcClient.terminal.write.mutate({ paneId, data }).catch(() => {
			// The session has ended; the terminal shows it.
		});

	const send = async () => {
		const message = text.replace(/\s+$/, "");
		if (!message.trim()) {
			await write(KEYS.enter);
			return;
		}
		const body = message.includes("\n")
			? `\x1b[200~${message.replace(/\r?\n/g, "\r")}\x1b[201~`
			: message;
		await write(body);
		// A moment for the paste to land before submitting it.
		await new Promise((r) => setTimeout(r, 40));
		await write(KEYS.enter);
		setHistory((h) =>
			[message, ...h.filter((m) => m !== message)].slice(0, HISTORY_LIMIT),
		);
		setBrowsing(null);
		setText("");
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		const el = event.currentTarget;
		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault();
			void send();
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			void write(KEYS.escape);
			return;
		}
		const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
		const atEnd = el.selectionStart === text.length;
		if (
			event.key === "ArrowUp" &&
			(text === "" || browsing !== null) &&
			atStart
		) {
			if (text === "" && browsing === null && history.length === 0) {
				// Nothing to recall: move Claude Code's menu selection instead.
				event.preventDefault();
				void write(KEYS.up);
				return;
			}
			const next = Math.min((browsing ?? -1) + 1, history.length - 1);
			if (next >= 0) {
				event.preventDefault();
				setBrowsing(next);
				setText(history[next]);
			}
			return;
		}
		if (event.key === "ArrowDown" && browsing !== null && atEnd) {
			event.preventDefault();
			const next = browsing - 1;
			setBrowsing(next >= 0 ? next : null);
			setText(next >= 0 ? history[next] : "");
			return;
		}
		if (event.key === "ArrowDown" && text === "") {
			event.preventDefault();
			void write(KEYS.down);
		}
	};

	const key = (label: string, data: string, icon: ReactNode) => (
		<button
			type="button"
			title={label}
			aria-label={label}
			onClick={() => {
				void write(data);
				box.current?.focus();
			}}
			className="flex h-6 min-w-6 items-center justify-center rounded border bg-background px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
		>
			{icon}
		</button>
	);

	return (
		<div
			className="shrink-0 border-t bg-background/80 px-3 py-2"
			data-terminal-composer
		>
			<div className="flex items-end gap-2 rounded-lg border bg-card px-2.5 py-1.5 shadow-xs focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/30">
				<textarea
					ref={box}
					aria-label="Message to the session"
					rows={1}
					value={text}
					placeholder={
						placeholder ?? "Message… (Enter sends, Shift+Enter for a new line)"
					}
					onChange={(e) => {
						setText(e.target.value);
						setBrowsing(null);
					}}
					onKeyDown={onKeyDown}
					className="max-h-[180px] min-h-6 flex-1 resize-none bg-transparent py-0.5 text-sm leading-6 outline-none placeholder:text-muted-foreground"
				/>
				<button
					type="button"
					aria-label="Send"
					title="Send (Enter)"
					onClick={() => void send()}
					className={cn(
						"flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
						text.trim()
							? "bg-primary text-primary-foreground hover:bg-primary/90"
							: "text-muted-foreground hover:bg-muted",
					)}
				>
					<LuSendHorizontal className="size-4" aria-hidden />
				</button>
			</div>
			<div className="mt-1.5 flex items-center gap-1.5">
				<span className="mr-1 text-[11px] text-muted-foreground">
					Menu keys
				</span>
				{key("Up", KEYS.up, <LuArrowUp className="size-3" aria-hidden />)}
				{key("Down", KEYS.down, <LuArrowDown className="size-3" aria-hidden />)}
				{key(
					"Enter",
					KEYS.enter,
					<LuCornerDownLeft className="size-3" aria-hidden />,
				)}
				{key("Esc", KEYS.escape, "Esc")}
				<span className="ml-auto text-[11px] text-muted-foreground">
					↑ earlier messages · Esc stops Claude
				</span>
			</div>
		</div>
	);
}
