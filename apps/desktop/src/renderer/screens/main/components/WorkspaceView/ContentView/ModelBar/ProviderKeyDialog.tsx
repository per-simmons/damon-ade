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
import { Label } from "@superset/ui/label";
import { toast } from "@superset/ui/sonner";
import { useEffect, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useProviderKeys } from "renderer/stores/model-bar/useProviderKeys";

const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";

export type ProviderKeyDialogMode = "launch" | "manage";

interface ProviderKeyDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	mode: ProviderKeyDialogMode;
	/** For launch mode: the model whose launch is gated on the key. */
	modelLabel?: string;
	/** For launch mode: called after the key is saved so the caller can spawn. */
	onSaved?: () => void;
}

/**
 * Bring-your-own-key entry for OpenRouter. Two modes:
 * - launch: gate shown before spawning an OpenRouter-proxied model; saving the
 *   key immediately hands back to the caller to launch.
 * - manage: opened from the ModelBar "+" affordance to set / replace / clear the
 *   stored key. The stored key is never displayed.
 */
export function ProviderKeyDialog({
	open,
	onOpenChange,
	mode,
	modelLabel,
	onSaved,
}: ProviderKeyDialogProps) {
	const { openrouterConfigured, setKey, clearKey, isSaving, isClearing } =
		useProviderKeys();
	const openUrl = electronTrpc.external.openUrl.useMutation();
	const [key, setKeyInput] = useState("");

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on each open
	useEffect(() => {
		if (open) setKeyInput("");
	}, [open]);

	const trimmed = key.trim();
	const canSave = trimmed.length > 0 && !isSaving;

	const handleSave = async () => {
		if (!canSave) return;
		try {
			await setKey(trimmed);
			setKeyInput("");
			if (mode === "launch") {
				onOpenChange(false);
				onSaved?.();
			} else {
				toast.success("OpenRouter key saved");
			}
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Could not save the key",
			);
		}
	};

	const handleClear = async () => {
		try {
			await clearKey();
			setKeyInput("");
			toast.success("OpenRouter key removed");
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Could not remove the key",
			);
		}
	};

	const isLaunch = mode === "launch";
	const saveLabel = isLaunch
		? isSaving
			? "Launching…"
			: "Save & Launch"
		: isSaving
			? "Saving…"
			: openrouterConfigured
				? "Replace key"
				: "Save key";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[440px]">
				<DialogHeader>
					<DialogTitle>
						{isLaunch ? "Connect OpenRouter" : "OpenRouter"}
					</DialogTitle>
					<DialogDescription>
						{isLaunch ? (
							<>
								{modelLabel ? `${modelLabel} runs` : "This model runs"} through
								OpenRouter. Paste your API key to launch — get one at{" "}
							</>
						) : openrouterConfigured ? (
							<>
								An OpenRouter key is configured. Replace or remove it below —
								keys are managed at{" "}
							</>
						) : (
							<>
								Add an OpenRouter API key to unlock the OpenRouter-proxied
								models — get one at{" "}
							</>
						)}
						<button
							type="button"
							className="text-foreground underline underline-offset-2 hover:no-underline"
							onClick={() => openUrl.mutate(OPENROUTER_KEYS_URL)}
						>
							openrouter.ai/keys
						</button>
						.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-1.5 py-1">
					<Label htmlFor="openrouter-key">
						{openrouterConfigured && !isLaunch
							? "New API key"
							: "OpenRouter API key"}
					</Label>
					<Input
						id="openrouter-key"
						type="password"
						autoComplete="off"
						spellCheck={false}
						value={key}
						onChange={(e) => setKeyInput(e.target.value)}
						placeholder="sk-or-…"
						// biome-ignore lint/a11y/noAutofocus: key entry is the sole intent
						autoFocus
						onKeyDown={(e) => {
							if (e.key === "Enter" && canSave) handleSave();
						}}
					/>
					{!isLaunch && (
						<p className="text-xs text-muted-foreground">
							Applies to new sessions. Restart a running session to pick up a
							changed key.
						</p>
					)}
				</div>

				<DialogFooter className="gap-2 sm:justify-between">
					{!isLaunch && openrouterConfigured ? (
						<Button
							variant="ghost"
							className="text-destructive hover:text-destructive"
							onClick={handleClear}
							disabled={isClearing}
						>
							{isClearing ? "Removing…" : "Remove key"}
						</Button>
					) : (
						<span />
					)}
					<div className="flex justify-end gap-2">
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							{isLaunch ? "Cancel" : "Done"}
						</Button>
						<Button onClick={handleSave} disabled={!canSave}>
							{saveLabel}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
