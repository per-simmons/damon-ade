import type { AGENT_RUNTIMES } from "@superset/local-db";
import {
	type AgentBinary,
	type CheckedBinary,
	RUNTIME_BINARY,
} from "@superset/shared/agent-binaries";
import { AGENT_LABELS } from "@superset/shared/agent-command";
import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { RadioGroup, RadioGroupItem } from "@superset/ui/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { toast } from "@superset/ui/sonner";
import { Textarea } from "@superset/ui/textarea";
import { useNavigate } from "@tanstack/react-router";
import type { ChangeEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { HiArrowPath } from "react-icons/hi2";
import { BinaryInstallDialog } from "renderer/components/BinaryInstallDialog/BinaryInstallDialog";
import { downscaleImageToDataUrl } from "renderer/lib/downscale-image";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useRuntimeAvailability } from "renderer/stores/model-bar/useRuntimeAvailability";
import {
	useCloseNewWorkspaceModal,
	useNewWorkspaceModalOpen,
	usePreSelectedProjectId,
} from "renderer/stores/new-workspace-modal";

type RepoMode = "init" | "clone" | "local";

/**
 * Runtimes offered in the New Agent picker. The full AGENT_RUNTIMES enum (and
 * the launch presets) still support the rest — they return for the later
 * models stage.
 */
const RUNTIME_CHOICES = [
	"orchestrator",
	"claude",
	"codex",
	"opencode",
] as const;

/**
 * Create an Agent inside a Category. ADE agents own a standalone repo, so this
 * asks for name + runtime + repo source (empty or clone) + optional avatar and
 * calls workspaces.createAgent (which builds the repo and scaffolds memory).
 * Reuses the new-workspace-modal store (preSelectedProjectId = the category).
 */
export function NewAgentModal() {
	const navigate = useNavigate();
	const isOpen = useNewWorkspaceModalOpen();
	const closeModal = useCloseNewWorkspaceModal();
	const categoryId = usePreSelectedProjectId();
	const utils = electronTrpc.useUtils();
	const { isAvailable, recheck, isFetching } = useRuntimeAvailability();

	const [name, setName] = useState("");
	const [role, setRole] = useState("");
	const [runtime, setRuntime] =
		useState<(typeof AGENT_RUNTIMES)[number]>("orchestrator");
	const [repoMode, setRepoMode] = useState<RepoMode>("init");
	const [cloneUrl, setCloneUrl] = useState("");
	const [localPath, setLocalPath] = useState("");
	const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
	const [installBinary, setInstallBinary] = useState<AgentBinary | null>(null);
	const photoInputRef = useRef<HTMLInputElement>(null);
	const nameInputRef = useRef<HTMLInputElement>(null);

	const createAgent = electronTrpc.workspaces.createAgent.useMutation();
	const setWorkspaceIcon =
		electronTrpc.workspaces.setWorkspaceIcon.useMutation();

	useEffect(() => {
		if (!isOpen) return;
		setName("");
		setRole("");
		setRuntime("orchestrator");
		setRepoMode("init");
		setCloneUrl("");
		setLocalPath("");
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

	// Building the agent's repo (init OR clone) shells to git, which a fresh Mac
	// lacks until the Command Line Tools are installed. Block create until it's
	// present rather than letting agent-repo fail with a generic error.
	const gitMissing = !isAvailable("git");
	const runtimeBinary = RUNTIME_BINARY[runtime];
	const runtimeMissing = !isAvailable(runtimeBinary as CheckedBinary);

	const canCreate =
		!!categoryId &&
		name.trim().length > 0 &&
		!gitMissing &&
		(repoMode === "init" ||
			(repoMode === "clone" && cloneUrl.trim().length > 0) ||
			(repoMode === "local" && localPath.trim().length > 0)) &&
		!createAgent.isPending;

	const handleCreate = async () => {
		if (!categoryId || !canCreate) return;
		try {
			const result = await createAgent.mutateAsync({
				projectId: categoryId,
				name: name.trim(),
				role: role.trim() || undefined,
				runtime,
				repo:
					repoMode === "clone"
						? { type: "clone", url: cloneUrl.trim() }
						: repoMode === "local"
							? { type: "clone", url: localPath.trim() }
							: { type: "init" },
			});
			if (photoDataUrl) {
				await setWorkspaceIcon.mutateAsync({
					id: result.workspace.id,
					icon: photoDataUrl,
				});
			}
			await utils.workspaces.getAllGrouped.invalidate();
			closeModal();
			navigate({
				to: "/workspace/$workspaceId",
				params: { workspaceId: result.workspace.id },
			});
			toast.success(`Agent "${name.trim()}" created`);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to create agent",
			);
		}
	};

	return (
		<Dialog modal open={isOpen} onOpenChange={(open) => !open && closeModal()}>
			<DialogContent className="sm:max-w-[440px]">
				<DialogHeader>
					<DialogTitle>New agent</DialogTitle>
				</DialogHeader>

				<div className="flex flex-col gap-4 py-2">
					<div className="flex items-center gap-3">
						<button
							type="button"
							onClick={() => photoInputRef.current?.click()}
							className="size-12 shrink-0 rounded-full overflow-hidden bg-muted flex items-center justify-center text-xs text-muted-foreground border border-border"
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
							<Label htmlFor="agent-name">Name</Label>
							<Input
								id="agent-name"
								ref={nameInputRef}
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="e.g. Scout"
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

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="agent-role">Role</Label>
						<Textarea
							id="agent-role"
							value={role}
							onChange={(e) => setRole(e.target.value)}
							rows={2}
							maxLength={280}
							placeholder="What is this agent? (optional — you can also just talk with the agent and shape it together)"
							className="resize-none"
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label>Runtime</Label>
						<Select
							value={runtime}
							onValueChange={(v) =>
								setRuntime(v as (typeof AGENT_RUNTIMES)[number])
							}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{RUNTIME_CHOICES.map((r) => {
									const missing = !isAvailable(
										RUNTIME_BINARY[r] as CheckedBinary,
									);
									return (
										<SelectItem key={r} value={r}>
											<span className="flex items-center gap-2">
												{AGENT_LABELS[r]}
												{missing && (
													<span className="text-xs text-muted-foreground">
														· not installed
													</span>
												)}
											</span>
										</SelectItem>
									);
								})}
							</SelectContent>
						</Select>
						{runtimeMissing && (
							<p className="text-xs text-muted-foreground">
								{AGENT_LABELS[runtime]}'s CLI isn't installed — the agent will
								be created, but you'll need it to run sessions.{" "}
								<button
									type="button"
									className="text-foreground underline underline-offset-2 hover:no-underline"
									onClick={() => setInstallBinary(runtimeBinary)}
								>
									Install
								</button>
							</p>
						)}
					</div>

					<div className="flex flex-col gap-1.5">
						<Label>Repository</Label>
						<RadioGroup
							value={repoMode}
							onValueChange={(v) => setRepoMode(v as RepoMode)}
							className="flex flex-col gap-2"
						>
							<div className="flex items-center gap-2">
								<RadioGroupItem value="init" id="repo-init" />
								<Label htmlFor="repo-init" className="font-normal">
									New empty repo
								</Label>
							</div>
							<div className="flex items-center gap-2">
								<RadioGroupItem value="clone" id="repo-clone" />
								<Label htmlFor="repo-clone" className="font-normal">
									Clone from URL
								</Label>
							</div>
							<div className="flex items-center gap-2">
								<RadioGroupItem value="local" id="repo-local" />
								<Label htmlFor="repo-local" className="font-normal">
									Clone from local path
								</Label>
							</div>
						</RadioGroup>
						{repoMode === "clone" && (
							<Input
								value={cloneUrl}
								onChange={(e) => setCloneUrl(e.target.value)}
								placeholder="https://github.com/owner/repo.git"
							/>
						)}
						{repoMode === "local" && (
							<Input
								value={localPath}
								onChange={(e) => setLocalPath(e.target.value)}
								placeholder="/Users/you/code/my-repo"
							/>
						)}
					</div>
				</div>

				{gitMissing && (
					<div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs">
						<p className="font-medium text-foreground">Git is required</p>
						<p className="text-muted-foreground">
							Creating an agent sets up a git repository, and Git isn't
							installed. Install Apple's Command Line Tools, then re-check:
						</p>
						<code className="select-all rounded bg-background/60 px-2 py-1 font-mono">
							xcode-select --install
						</code>
						<button
							type="button"
							onClick={recheck}
							disabled={isFetching}
							className="inline-flex w-fit items-center gap-1 text-foreground underline underline-offset-2 hover:no-underline disabled:opacity-50"
						>
							<HiArrowPath
								className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`}
							/>
							{isFetching ? "Checking…" : "Re-check"}
						</button>
					</div>
				)}

				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={() => closeModal()}>
						Cancel
					</Button>
					<Button onClick={handleCreate} disabled={!canCreate}>
						{createAgent.isPending ? "Creating…" : "Create agent"}
					</Button>
				</div>

				<BinaryInstallDialog
					binary={installBinary}
					onOpenChange={(open) => !open && setInstallBinary(null)}
					onRecheck={recheck}
					isRechecking={isFetching}
				/>
			</DialogContent>
		</Dialog>
	);
}
