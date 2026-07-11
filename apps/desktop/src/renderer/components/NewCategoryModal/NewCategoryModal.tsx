import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { toast } from "@superset/ui/sonner";
import { useNavigate } from "@tanstack/react-router";
import type { ChangeEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { downscaleImageToDataUrl } from "renderer/lib/downscale-image";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	useCloseNewCategoryModal,
	useNewCategoryModalOpen,
} from "renderer/stores/new-category-modal";

/**
 * Create a Category (a repo-less grouping) with a name + optional square photo.
 * Calls projects.createCategory, then projects.setProjectIcon if a photo was
 * chosen.
 */
export function NewCategoryModal() {
	const isOpen = useNewCategoryModalOpen();
	const closeModal = useCloseNewCategoryModal();
	const navigate = useNavigate();
	const utils = electronTrpc.useUtils();

	const [name, setName] = useState("");
	const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
	const photoInputRef = useRef<HTMLInputElement>(null);
	const nameInputRef = useRef<HTMLInputElement>(null);

	const createCategory = electronTrpc.projects.createCategory.useMutation();
	const setProjectIcon = electronTrpc.projects.setProjectIcon.useMutation();

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset each open
	useEffect(() => {
		if (!isOpen) return;
		setName("");
		setPhotoDataUrl(null);
		const t = setTimeout(() => nameInputRef.current?.focus(), 50);
		return () => clearTimeout(t);
	}, [isOpen]);

	const handlePhoto = async (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (!file) return;
		try {
			setPhotoDataUrl(await downscaleImageToDataUrl(file));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Could not load image");
		}
	};

	const canCreate = name.trim().length > 0 && !createCategory.isPending;

	const handleCreate = async () => {
		if (!canCreate) return;
		try {
			const category = await createCategory.mutateAsync({ name: name.trim() });
			if (photoDataUrl) {
				await setProjectIcon.mutateAsync({
					id: category.id,
					icon: photoDataUrl,
				});
			}
			await utils.workspaces.getAllGrouped.invalidate();
			closeModal();
			// Go straight to the rail + list. Navigating via /workspace would
			// race the getAllGrouped refetch (its redirect can bounce back to
			// /welcome before the new category is in cache); /workspaces renders
			// the rail unconditionally.
			navigate({ to: "/workspaces" });
			toast.success(`Category "${name.trim()}" created`);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to create category",
			);
		}
	};

	return (
		<Dialog modal open={isOpen} onOpenChange={(open) => !open && closeModal()}>
			<DialogContent className="sm:max-w-[420px]">
				<DialogHeader>
					<DialogTitle>New category</DialogTitle>
				</DialogHeader>

				<div className="flex items-center gap-3 py-2">
					<button
						type="button"
						onClick={() => photoInputRef.current?.click()}
						className="size-12 shrink-0 rounded overflow-hidden bg-muted flex items-center justify-center text-xs text-muted-foreground border border-border"
					>
						{photoDataUrl ? (
							<img
								src={photoDataUrl}
								alt=""
								className="size-full object-cover"
							/>
						) : (
							"Photo"
						)}
					</button>
					<div className="flex-1">
						<Label htmlFor="category-name">Name</Label>
						<Input
							id="category-name"
							ref={nameInputRef}
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="e.g. Newsletter"
							onKeyDown={(e) => {
								if (e.key === "Enter" && canCreate) handleCreate();
							}}
						/>
					</div>
				</div>
				<input
					ref={photoInputRef}
					type="file"
					accept="image/png,image/jpeg,image/webp,image/svg+xml"
					className="hidden"
					onChange={handlePhoto}
				/>

				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={() => closeModal()}>
						Cancel
					</Button>
					<Button onClick={handleCreate} disabled={!canCreate}>
						{createCategory.isPending ? "Creating…" : "Create category"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
