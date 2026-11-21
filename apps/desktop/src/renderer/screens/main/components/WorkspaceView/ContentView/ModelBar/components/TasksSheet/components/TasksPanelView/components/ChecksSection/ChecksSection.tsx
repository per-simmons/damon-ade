import { Button } from "@superset/ui/button";
import { Textarea } from "@superset/ui/textarea";
import { useEffect, useState } from "react";
import { LuShieldCheck } from "react-icons/lu";
import type { ChecksView } from "../../../../types";

interface ChecksSectionProps {
	checks: ChecksView | undefined;
	busy: boolean;
	onSave: (commands: string[]) => void;
}

/**
 * The commands ADE runs to verify every task in this project (typecheck,
 * lint, tests). ADE runs them only after you approve them here; they are
 * stored in ADE's project folder, never in the repository.
 */
export function ChecksSection({ checks, busy, onSave }: ChecksSectionProps) {
	const initial = checks?.commands.length
		? checks.commands
		: (checks?.suggestions ?? []);
	const initialText = initial.join("\n");
	const [text, setText] = useState(initialText);
	const [touched, setTouched] = useState(false);

	useEffect(() => {
		if (!touched) setText(initialText);
	}, [initialText, touched]);

	const commands = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	return (
		<section
			className="space-y-2.5 rounded-lg border bg-card p-3 shadow-xs"
			data-section="checks"
		>
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<LuShieldCheck className="size-4 text-muted-foreground" aria-hidden />
					<h3 className="text-sm font-semibold">Checks</h3>
				</div>
				<span
					className={
						checks?.approved
							? "rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400"
							: "rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400"
					}
				>
					{checks?.approved
						? `${checks.commands.length} approved`
						: "not approved yet"}
				</span>
			</div>
			<p className="text-xs text-muted-foreground">
				Run after every change; a task is done only when they and an independent
				review pass. One command per line.
			</p>
			<Textarea
				aria-label="Check commands"
				rows={3}
				className="resize-none bg-muted/30 font-mono text-xs"
				placeholder="bun run typecheck"
				value={text}
				onChange={(event) => {
					setTouched(true);
					setText(event.target.value);
				}}
			/>
			<Button
				size="sm"
				variant="outline"
				disabled={busy}
				onClick={() => {
					setTouched(false);
					onSave(commands);
				}}
			>
				{commands.length === 0 ? "Use no checks" : "Approve these checks"}
			</Button>
		</section>
	);
}
