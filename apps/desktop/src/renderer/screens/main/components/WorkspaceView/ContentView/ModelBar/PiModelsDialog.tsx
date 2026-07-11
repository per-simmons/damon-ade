import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { toast } from "@superset/ui/sonner";
import { useEffect, useState } from "react";
import { HiOutlineTrash } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";

/** Mirrors the setPiModels input validation so bad patterns fail inline. */
const MODEL_PATTERN = /^[A-Za-z0-9*][A-Za-z0-9._\-/:*]*$/;

interface PiModelsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * Manage the pi model list shown in the ModelBar pi picker. Each entry is a
 * `pi --model` pattern ("provider/id", globs like *deepseek*, optional
 * ":<thinking>" suffix). The list lives in local settings; auth stays in the
 * user's own pi config.
 */
export function PiModelsDialog({ open, onOpenChange }: PiModelsDialogProps) {
	const utils = electronTrpc.useUtils();
	const { data: savedModels } = electronTrpc.settings.getPiModels.useQuery();
	const setPiModels = electronTrpc.settings.setPiModels.useMutation({
		onSuccess: () => utils.settings.getPiModels.invalidate(),
	});

	const [models, setModels] = useState<string[]>([]);
	const [draft, setDraft] = useState("");

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on each open
	useEffect(() => {
		if (open) {
			setModels(savedModels ?? []);
			setDraft("");
		}
	}, [open]);

	const trimmed = draft.trim();
	const draftValid = MODEL_PATTERN.test(trimmed);
	const canAdd = trimmed.length > 0 && draftValid && !models.includes(trimmed);

	const addDraft = () => {
		if (!canAdd) return;
		setModels((prev) => [...prev, trimmed]);
		setDraft("");
	};

	const handleSave = async () => {
		try {
			await setPiModels.mutateAsync({ models });
			onOpenChange(false);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to save pi models",
			);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[440px]">
				<DialogHeader>
					<DialogTitle>pi models</DialogTitle>
					<DialogDescription>
						Patterns passed to <code>pi --model</code> — e.g.{" "}
						<code>deepseek/deepseek-chat</code>, <code>zai/glm-*</code> or{" "}
						<code>*sonnet*</code>. Provider auth comes from your own pi setup.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-2 py-1">
					{models.length === 0 && (
						<p className="text-sm text-muted-foreground">
							No models yet — add the ones you use in pi.
						</p>
					)}
					{models.map((model) => (
						<div
							key={model}
							className="flex items-center justify-between rounded-md border px-2.5 py-1.5"
						>
							<span className="font-mono text-sm">{model}</span>
							<button
								type="button"
								aria-label={`Remove ${model}`}
								onClick={() =>
									setModels((prev) => prev.filter((m) => m !== model))
								}
								className="text-muted-foreground/70 transition-colors hover:text-destructive"
							>
								<HiOutlineTrash className="h-4 w-4" />
							</button>
						</div>
					))}

					<div className="flex gap-2 pt-1">
						<Input
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							placeholder="provider/model or pattern"
							className="font-mono"
							onKeyDown={(e) => {
								if (e.key === "Enter") addDraft();
							}}
						/>
						<Button variant="secondary" disabled={!canAdd} onClick={addDraft}>
							Add
						</Button>
					</div>
					{trimmed.length > 0 && !draftValid && (
						<p className="text-xs text-destructive">
							Only letters, digits, and . _ - / : * are allowed.
						</p>
					)}
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button onClick={handleSave} disabled={setPiModels.isPending}>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
