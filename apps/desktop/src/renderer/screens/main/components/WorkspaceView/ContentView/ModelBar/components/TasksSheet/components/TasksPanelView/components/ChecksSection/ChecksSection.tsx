import { Button } from "@superset/ui/button";
import { Textarea } from "@superset/ui/textarea";
import { useEffect, useState } from "react";
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
		<section className="space-y-2" data-section="checks">
			<div className="flex items-center justify-between">
				<h3 className="text-sm font-medium">Checks</h3>
				<span className="text-xs text-muted-foreground">
					{checks?.approved
						? `${checks.commands.length} approved`
						: "not approved yet"}
				</span>
			</div>
			<p className="text-xs text-muted-foreground">
				ADE runs these after every change. A task is done only when they pass
				and an independent review passes. Without checks, the review alone
				decides. One command per line.
			</p>
			<Textarea
				aria-label="Check commands"
				rows={3}
				className="font-mono text-xs"
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
