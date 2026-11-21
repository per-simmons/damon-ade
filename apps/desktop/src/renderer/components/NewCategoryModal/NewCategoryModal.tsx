import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { toast } from "@superset/ui/sonner";
import { Tabs, TabsList, TabsTrigger } from "@superset/ui/tabs";
import { useNavigate } from "@tanstack/react-router";
import type { ChangeEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { downscaleImageToDataUrl } from "renderer/lib/downscale-image";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { navigateToWorkspace } from "renderer/routes/_authenticated/_dashboard/utils/workspace-navigation";
import {
	useCloseNewCategoryModal,
	useNewCategoryModalOpen,
} from "renderer/stores/new-category-modal";

type Source = "local" | "github" | "blank";

/** The last path segment of a folder or repository URL, without ".git". */
function repoName(value: string): string {
	const last =
		value
			.trim()
			.replace(/[\\/]+$/, "")
			.split(/[\\/:]/)
			.pop() ?? "";
	return last.replace(/\.git$/i, "");
}

/**
 * New team. One team = one repository: choose a local repository or a GitHub
 * repository (cloned only if ADE has no clone of it yet), name the team
 * (default: the repository's name), and it opens on its main workspace where
 * Tasks run at once. Agents are optional and added later; they inherit the
 * team's repository.
 */
export function NewCategoryModal() {
	const isOpen = useNewCategoryModalOpen();
	const closeModal = useCloseNewCategoryModal();
	const navigate = useNavigate();
	const utils = electronTrpc.useUtils();

	const [source, setSource] = useState<Source>("local");
	const [localPath, setLocalPath] = useState("");
	const [url, setUrl] = useState("");
	const [cloneDir, setCloneDir] = useState("");
	const [showRepos, setShowRepos] = useState(false);
	const [filter, setFilter] = useState("");
	const [name, setName] = useState("");
	const [nameEdited, setNameEdited] = useState(false);
	const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const photoInputRef = useRef<HTMLInputElement>(null);

	const [blankDir, setBlankDir] = useState("");
	// Default setup: agents with their specialties, added once the team exists.
	const [preset, setPreset] = useState("none");
	const { data: presets = [] } = electronTrpc.specialists.presets.useQuery(
		undefined,
		{ enabled: isOpen },
	);
	const applyPreset = electronTrpc.specialists.applyPreset.useMutation();
	const { data: projectsFolder } =
		electronTrpc.projects.getProjectsFolder.useQuery(undefined, {
			enabled: isOpen,
		});
	const github = electronTrpc.projectHistory.listGitHubRepos.useQuery(
		undefined,
		{ enabled: isOpen && showRepos, staleTime: 60_000 },
	);
	const selectDirectory = electronTrpc.projects.selectDirectory.useMutation();
	const createTeam = electronTrpc.projects.createTeam.useMutation();
	const cloneRepo = electronTrpc.projects.cloneRepo.useMutation();
	const createEmptyRepo = electronTrpc.projects.createEmptyRepo.useMutation();
	const updateProject = electronTrpc.projects.update.useMutation();
	const setProjectIcon = electronTrpc.projects.setProjectIcon.useMutation();

	useEffect(() => {
		if (!isOpen) return;
		setSource("local");
		setLocalPath("");
		setUrl("");
		setShowRepos(false);
		setFilter("");
		setName("");
		setNameEdited(false);
		setPhotoDataUrl(null);
		setBusy(false);
	}, [isOpen]);

	// New projects and clones go to the projects folder from Settings unless
	// the user picks another folder here.
	useEffect(() => {
		if (!isOpen || !projectsFolder) return;
		setCloneDir(projectsFolder.path);
		setBlankDir(projectsFolder.path);
	}, [isOpen, projectsFolder]);

	// The name follows the repository until the user types their own.
	useEffect(() => {
		if (nameEdited || source === "blank") return;
		setName(repoName(source === "local" ? localPath : url));
	}, [source, localPath, url, nameEdited]);

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

	const browse = async (set: (path: string) => void, current: string) => {
		const result = await selectDirectory.mutateAsync({
			defaultPath: current || undefined,
		});
		if (!result.canceled && result.path) set(result.path);
	};

	const openTeam = async (projectId: string, workspaceId: string | null) => {
		if (preset !== "none") {
			try {
				const result = await applyPreset.mutateAsync({
					projectId,
					presetId: preset,
				});
				toast.success(
					`${result.preset}: added ${result.agentsAdded.length} agent(s) with their specialties`,
				);
			} catch (err) {
				toast.error(
					`The team was created, but its agents were not added: ${err instanceof Error ? err.message : String(err)}. Right-click the team › Default setup to try again.`,
				);
			}
			void utils.specialists.invalidate();
		}
		await utils.workspaces.getAllGrouped.invalidate();
		await utils.projects.getRecents.invalidate();
		let target = workspaceId;
		if (!target) {
			const groups = await utils.workspaces.getAllGrouped.fetch();
			target =
				groups.find((g) => g.project.id === projectId)?.workspaces[0]?.id ??
				null;
		}
		closeModal();
		if (target) navigateToWorkspace(target, navigate);
		else navigate({ to: "/workspaces" });
	};

	const canCreate =
		!busy &&
		name.trim().length > 0 &&
		(source === "local"
			? localPath.trim().length > 0
			: source === "blank"
				? blankDir.trim().length > 0
				: url.trim().length > 0 && cloneDir.trim().length > 0);

	const handleCreate = async () => {
		if (!canCreate) return;
		setBusy(true);
		try {
			if (source === "local") {
				const result = await createTeam.mutateAsync({
					path: localPath.trim(),
					name: name.trim(),
				});
				if (result.existed) {
					toast.success(
						`This repository already has a team: "${result.project.name}". Opened it.`,
					);
				} else {
					if (photoDataUrl) {
						await setProjectIcon.mutateAsync({
							id: result.project.id,
							icon: photoDataUrl,
						});
					}
					toast.success(`Team "${result.project.name}" created`);
				}
				await openTeam(result.project.id, result.workspaceId);
				return;
			}

			if (source === "blank") {
				const created = await createEmptyRepo.mutateAsync({
					name: name.trim(),
					parentDir: blankDir.trim(),
				});
				if (!created.success || !("project" in created) || !created.project) {
					toast.error(
						("error" in created && created.error) ||
							"Could not create the project",
					);
					return;
				}
				if (photoDataUrl) {
					await setProjectIcon.mutateAsync({
						id: created.project.id,
						icon: photoDataUrl,
					});
				}
				toast.success(`Project "${name.trim()}" created`);
				await openTeam(created.project.id, null);
				return;
			}

			// GitHub: clone only when ADE has no clone of this repository yet.
			const found = await utils.projectHistory.findProjectByRemote.fetch({
				url: url.trim(),
			});
			if (found.project) {
				toast.success(
					`ADE already has this repository: team "${found.project.name}". Opened it.`,
				);
				await openTeam(found.project.id, null);
				return;
			}
			const cloned = await cloneRepo.mutateAsync({
				url: url.trim(),
				targetDirectory: cloneDir.trim(),
			});
			if (!cloned.success || !("project" in cloned) || !cloned.project) {
				if (!cloned.canceled) {
					toast.error(
						("error" in cloned && cloned.error) ||
							"Could not clone the repository",
					);
				}
				return;
			}
			if (name.trim() !== cloned.project.name) {
				await updateProject.mutateAsync({
					id: cloned.project.id,
					patch: { name: name.trim() },
				});
			}
			if (photoDataUrl) {
				await setProjectIcon.mutateAsync({
					id: cloned.project.id,
					icon: photoDataUrl,
				});
			}
			toast.success(`Team "${name.trim()}" created`);
			await openTeam(cloned.project.id, null);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to create team");
		} finally {
			setBusy(false);
		}
	};

	const repos = (github.data?.repos ?? []).filter((repo) =>
		repo.nameWithOwner.toLowerCase().includes(filter.trim().toLowerCase()),
	);

	return (
		<Dialog modal open={isOpen} onOpenChange={(open) => !open && closeModal()}>
			<DialogContent className="sm:max-w-[480px]" data-new-team>
				<DialogHeader>
					<DialogTitle>New team</DialogTitle>
				</DialogHeader>

				<p className="text-xs text-muted-foreground">
					A team works in one repository. Its tasks and agents all use it;
					agents get their own worktrees of it.
				</p>

				<Tabs
					value={source}
					onValueChange={(value) => setSource(value as Source)}
				>
					<TabsList>
						<TabsTrigger value="local">Local repository</TabsTrigger>
						<TabsTrigger value="github">GitHub</TabsTrigger>
						<TabsTrigger value="blank">New project</TabsTrigger>
					</TabsList>
				</Tabs>

				{source === "blank" ? (
					<div className="flex flex-col gap-1.5" data-new-project>
						<Label htmlFor="team-blank-dir">Create it in</Label>
						<div className="flex gap-2">
							<Input
								id="team-blank-dir"
								value={blankDir}
								onChange={(e) => setBlankDir(e.target.value)}
							/>
							<Button
								variant="outline"
								onClick={() => void browse(setBlankDir, blankDir)}
							>
								Browse…
							</Button>
						</div>
						<p className="text-xs text-muted-foreground">
							A new folder named after the team, with an empty git repository.
							{projectsFolder?.path && blankDir.trim() !== projectsFolder.path
								? " (Not your default projects folder.)"
								: " The default is set in Settings › Features › Projects folder."}
						</p>
						{name.trim() && blankDir.trim() && (
							<p className="break-all text-xs text-muted-foreground">
								{blankDir.trim().replace(/[\\/]+$/, "")}/{name.trim()}
							</p>
						)}
					</div>
				) : source === "local" ? (
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="team-repo-path">Repository folder</Label>
						<div className="flex gap-2">
							<Input
								id="team-repo-path"
								value={localPath}
								onChange={(e) => setLocalPath(e.target.value)}
								placeholder="C:\\code\\my-repo"
							/>
							<Button
								variant="outline"
								onClick={() => void browse(setLocalPath, localPath)}
							>
								Browse…
							</Button>
						</div>
					</div>
				) : (
					<div className="flex flex-col gap-2">
						<Label htmlFor="team-repo-url">Repository</Label>
						<Input
							id="team-repo-url"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							placeholder="https://github.com/owner/repo"
						/>
						{!showRepos ? (
							<Button
								variant="ghost"
								size="sm"
								className="w-fit"
								onClick={() => setShowRepos(true)}
							>
								Choose from my GitHub repositories
							</Button>
						) : github.isLoading ? (
							<p className="text-xs text-muted-foreground">
								Asking the GitHub CLI…
							</p>
						) : github.data && !github.data.available ? (
							<p className="text-xs text-muted-foreground">
								{github.data.reason}
							</p>
						) : (
							<>
								<Input
									value={filter}
									onChange={(e) => setFilter(e.target.value)}
									placeholder="Filter repositories"
									aria-label="Filter repositories"
									className="h-8"
								/>
								<ul className="max-h-[180px] space-y-1 overflow-y-auto">
									{repos.map((repo) => (
										<li key={repo.url}>
											<button
												type="button"
												className="w-full rounded px-2 py-1 text-left text-xs hover:bg-accent/40"
												onClick={() => setUrl(repo.url)}
											>
												<span className="font-medium">
													{repo.nameWithOwner}
												</span>
												{repo.isPrivate && (
													<span className="text-muted-foreground">
														{" "}
														· private
													</span>
												)}
											</button>
										</li>
									))}
								</ul>
							</>
						)}
						<Label htmlFor="team-clone-dir">Clone into</Label>
						<div className="flex gap-2">
							<Input
								id="team-clone-dir"
								value={cloneDir}
								onChange={(e) => setCloneDir(e.target.value)}
							/>
							<Button
								variant="outline"
								onClick={() => void browse(setCloneDir, cloneDir)}
							>
								Browse…
							</Button>
						</div>
						<p className="text-xs text-muted-foreground">
							If ADE already has a clone of this repository, that team opens
							instead; nothing is cloned twice.
						</p>
					</div>
				)}

				<div className="flex items-center gap-3">
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
						<Label htmlFor="team-name">Team name</Label>
						<Input
							id="team-name"
							value={name}
							onChange={(e) => {
								setName(e.target.value);
								setNameEdited(true);
							}}
							placeholder="The repository's name"
							onKeyDown={(e) => {
								if (e.key === "Enter" && canCreate) void handleCreate();
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

				<div className="flex flex-col gap-1.5" data-new-team-preset>
					<Label>Start with agents</Label>
					<Select value={preset} onValueChange={setPreset}>
						<SelectTrigger aria-label="Start with agents">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="none">No agents yet</SelectItem>
							{presets.map((p) => (
								<SelectItem key={p.id} value={p.id}>
									{p.name} · {p.agents.length} agents
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p className="text-xs text-muted-foreground">
						{preset === "none"
							? "You can add a group later: right-click the team › Default setup."
							: (presets.find((p) => p.id === preset)?.agents ?? [])
									.map((a) => a.name)
									.join(", ")}
					</p>
				</div>

				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={() => closeModal()}>
						Cancel
					</Button>
					<Button onClick={() => void handleCreate()} disabled={!canCreate}>
						{busy
							? source === "github"
								? "Cloning…"
								: "Creating…"
							: source === "blank"
								? "Create project"
								: "Create team"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
