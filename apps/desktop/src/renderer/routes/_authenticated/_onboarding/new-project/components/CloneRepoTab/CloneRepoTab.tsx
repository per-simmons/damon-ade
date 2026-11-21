import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useProjectCreationHandler } from "../../hooks/useProjectCreationHandler";

interface CloneRepoTabProps {
	onError: (error: string) => void;
	parentDir: string;
}

/**
 * Clone a repository, or open it if ADE already has a clone with the same
 * remote. The user's GitHub repositories are listed through the gh CLI they
 * are already signed in to; cloning uses git's own credentials.
 */
export function CloneRepoTab({ onError, parentDir }: CloneRepoTabProps) {
	const [url, setUrl] = useState("");
	const [showGitHub, setShowGitHub] = useState(false);
	const [filter, setFilter] = useState("");
	const [existing, setExisting] = useState<{
		id: string;
		name: string;
		root: string;
	} | null>(null);
	const utils = electronTrpc.useUtils();
	const cloneRepo = electronTrpc.projects.cloneRepo.useMutation();
	const github = electronTrpc.projectHistory.listGitHubRepos.useQuery(
		undefined,
		{ enabled: showGitHub, staleTime: 60_000 },
	);
	const { handleResult, handleError } = useProjectCreationHandler(onError);
	const isLoading = cloneRepo.isPending;

	const clone = () =>
		cloneRepo.mutate(
			{ url: url.trim(), targetDirectory: parentDir.trim() },
			{
				onSuccess: (result) => handleResult(result, () => setUrl("")),
				onError: handleError,
			},
		);

	const handleClone = async () => {
		if (!url.trim()) {
			onError("Please enter a repository URL");
			return;
		}
		if (!parentDir.trim()) {
			onError("Please select a team location");
			return;
		}
		// Clone only when needed: an existing clone of this remote opens instead.
		try {
			const found = await utils.projectHistory.findProjectByRemote.fetch({
				url: url.trim(),
			});
			if (found.project) {
				setExisting(found.project);
				return;
			}
		} catch {
			// Not resolvable here: fall back to cloning.
		}
		clone();
	};

	const repos = (github.data?.repos ?? []).filter((repo) =>
		repo.nameWithOwner.toLowerCase().includes(filter.trim().toLowerCase()),
	);

	return (
		<div className="flex flex-col gap-5">
			<div>
				<label
					htmlFor="clone-url"
					className="block text-sm font-medium text-foreground mb-2"
				>
					Repository URL
				</label>
				<Input
					id="clone-url"
					value={url}
					onChange={(e) => {
						setUrl(e.target.value);
						setExisting(null);
					}}
					placeholder="https:// or git@github.com:user/repo.git"
					disabled={isLoading}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !isLoading) {
							void handleClone();
						}
					}}
					autoFocus
				/>
			</div>

			<div className="space-y-2">
				{!showGitHub ? (
					<Button variant="ghost" size="sm" onClick={() => setShowGitHub(true)}>
						Choose from my GitHub repositories
					</Button>
				) : github.isLoading ? (
					<p className="text-xs text-muted-foreground">
						Asking the GitHub CLI…
					</p>
				) : github.data && !github.data.available ? (
					<p className="text-xs text-muted-foreground">{github.data.reason}</p>
				) : (
					<>
						<Input
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder="Filter repositories"
							aria-label="Filter repositories"
							className="h-8"
						/>
						<ul className="max-h-[220px] space-y-1 overflow-y-auto">
							{repos.map((repo) => (
								<li key={repo.url}>
									<button
										type="button"
										className="w-full rounded px-2 py-1 text-left text-xs hover:bg-accent/40"
										onClick={() => {
											setUrl(repo.url);
											setExisting(null);
										}}
									>
										<span className="font-medium">{repo.nameWithOwner}</span>
										{repo.isPrivate && (
											<span className="text-muted-foreground"> · private</span>
										)}
										{repo.description && (
											<span className="block truncate text-muted-foreground">
												{repo.description}
											</span>
										)}
									</button>
								</li>
							))}
						</ul>
					</>
				)}
			</div>

			{existing && (
				<div className="space-y-2 rounded-md border p-3 text-sm">
					<p>
						ADE already has this repository: <strong>{existing.name}</strong> at{" "}
						<span className="break-all">{existing.root}</span>.
					</p>
					<div className="flex gap-2">
						<Button
							size="sm"
							onClick={() =>
								handleResult({ success: true, project: existing }, () =>
									setUrl(""),
								)
							}
						>
							Open it
						</Button>
						<Button size="sm" variant="ghost" onClick={clone}>
							Clone another copy
						</Button>
					</div>
				</div>
			)}

			<div className="flex justify-end pt-2 border-t border-border/40">
				<Button
					onClick={() => void handleClone()}
					disabled={isLoading}
					size="sm"
				>
					{isLoading ? "Cloning..." : "Clone"}
				</Button>
			</div>
		</div>
	);
}
