import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { toast } from "@superset/ui/sonner";
import { Switch } from "@superset/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@superset/ui/tabs";
import { useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface GitHubSyncProps {
	workspaceId: string;
}

const AUTO_SYNC_MS = 5 * 60_000;

type Outcome = { outcome: string; reason?: string; commits?: number };

function describe(pull: Outcome, push: Outcome): string {
	const parts: string[] = [];
	if (pull.outcome === "updated")
		parts.push(`pulled ${pull.commits} commit(s)`);
	if (push.outcome === "pushed") parts.push(`pushed ${push.commits} commit(s)`);
	return parts.length ? parts.join(", ") : "already the same";
}

/**
 * Keeps the team's local repository and its GitHub repository the same:
 * connect one (existing or new), then sync: pull new commits (fast-forward
 * only) and push local commits (never forced). Optional automatic sync while
 * ADE is open. Anything needing a merge or rebase is explained, not done.
 */
export function GitHubSync({ workspaceId }: GitHubSyncProps) {
	const utils = electronTrpc.useUtils();
	const [open, setOpen] = useState(false);
	const [mode, setMode] = useState<"existing" | "create">("existing");
	const [url, setUrl] = useState("");
	const [name, setName] = useState("");
	const [visibility, setVisibility] = useState<"private" | "public">("private");
	const [showRepos, setShowRepos] = useState(false);
	const status = electronTrpc.repoUpdate.status.useQuery(
		{ workspaceId, fetch: true },
		{ staleTime: 60_000, refetchOnWindowFocus: false, retry: false },
	);
	const { data: project } = electronTrpc.projectHistory.overview.useQuery(
		{ workspaceId },
		{ enabled: open },
	);
	const github = electronTrpc.projectHistory.listGitHubRepos.useQuery(
		undefined,
		{ enabled: open && showRepos, staleTime: 60_000 },
	);
	const refresh = () => {
		void utils.repoUpdate.status.invalidate({ workspaceId });
		void utils.projectHistory.overview.invalidate({ workspaceId });
		void utils.workflow.getProjectTasks.invalidate({ workspaceId });
	};
	const onError = (err: { message: string }) => toast.error(err.message);
	// Automatic syncs only speak up when something changed or failed.
	const quietRef = useRef(false);
	const sync = electronTrpc.repoUpdate.sync.useMutation({
		onSuccess: (result) => {
			const quiet = quietRef.current;
			quietRef.current = false;
			const problem = [result.pull, result.push].find(
				(r) => r.outcome === "blocked",
			) as Outcome | undefined;
			if (problem) toast.error(problem.reason ?? "Could not sync");
			else if (
				!quiet ||
				describe(result.pull, result.push) !== "already the same"
			)
				toast.success(`GitHub: ${describe(result.pull, result.push)}`);
			refresh();
		},
		onError,
	});
	const connect = electronTrpc.repoUpdate.connect.useMutation({
		onSuccess: (result) => {
			toast.success(
				result.remoteEmpty
					? "Connected. The GitHub repository is empty; Sync will push this branch."
					: `Connected${result.tracking ? `, tracking ${result.tracking}` : ""}.`,
			);
			refresh();
		},
		onError,
	});
	const create = electronTrpc.repoUpdate.createOnGitHub.useMutation({
		onSuccess: (result) => {
			toast.success(`Created ${result.remote ?? "the repository"} and pushed`);
			refresh();
		},
		onError,
	});
	const setAuto = electronTrpc.repoUpdate.setAutoSync.useMutation({
		onSuccess: refresh,
		onError,
	});

	const data = status.data;
	const connected = !!data?.remote;

	// Automatic sync while ADE is open (opt-in per team).
	const syncRef = useRef(sync);
	syncRef.current = sync;
	useEffect(() => {
		if (!data?.autoSync || !connected) return;
		const run = () => {
			if (!syncRef.current.isPending) {
				quietRef.current = true;
				syncRef.current.mutate({ workspaceId });
			}
		};
		const timer = setInterval(run, AUTO_SYNC_MS);
		return () => clearInterval(timer);
	}, [data?.autoSync, connected, workspaceId]);

	useEffect(() => {
		if (open && project && !name) {
			setName(project.project.name.replace(/[^A-Za-z0-9._-]+/g, "-"));
		}
	}, [open, project, name]);

	const ahead = data?.ahead ?? 0;
	const behind = data?.behind ?? 0;
	const label = !data
		? "GitHub"
		: !connected
			? "Connect GitHub"
			: ahead || behind || !data.upstream
				? `Sync ↑${ahead} ↓${behind}`
				: "GitHub: in sync";
	const busy =
		sync.isPending ||
		connect.isPending ||
		create.isPending ||
		setAuto.isPending;
	const repos = github.data?.repos ?? [];

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				data-github-sync
				className={`flex h-7 items-center rounded-md px-2 text-xs transition-colors hover:bg-muted ${
					connected && (ahead || behind)
						? "text-amber-600"
						: "text-muted-foreground hover:text-foreground"
				}`}
			>
				{sync.isPending ? "Syncing…" : label}
			</button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-[500px]" data-github-sync-dialog>
					<DialogHeader>
						<DialogTitle>Local and GitHub repository</DialogTitle>
						<DialogDescription>
							Keep this team's local repository and its GitHub repository the
							same. Sync brings in new commits (fast-forward only) and pushes
							yours (never forced). Anything that needs a merge or rebase is
							left to you, with the reason.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-1 rounded border p-2 text-xs">
						<p className="break-all">
							<span className="text-muted-foreground">Local: </span>
							{project?.project.root ?? "…"}
						</p>
						<p className="break-all">
							<span className="text-muted-foreground">GitHub: </span>
							{data?.remote ?? "not connected"}
						</p>
						{connected && data && (
							<p className="text-muted-foreground">
								{data.branch ? `Branch ${data.branch}` : "Detached HEAD"}
								{data.upstream
									? ` ↔ ${data.upstream}: ${ahead} to push, ${behind} to pull`
									: " has no GitHub branch yet; Sync pushes it"}
								{data.dirty ? " · uncommitted changes (not synced)" : ""}
							</p>
						)}
						{data?.fetchError && (
							<p className="text-amber-600">
								Could not reach GitHub: {data.fetchError}
							</p>
						)}
					</div>

					{connected ? (
						<div className="space-y-3">
							<div className="flex flex-wrap gap-2">
								<Button
									disabled={busy}
									onClick={() => {
										quietRef.current = false;
										sync.mutate({ workspaceId });
									}}
								>
									Sync now
								</Button>
								<Button
									variant="ghost"
									disabled={busy}
									onClick={() => void status.refetch()}
								>
									Check again
								</Button>
							</div>
							<div className="flex items-start gap-2 text-sm">
								<Switch
									id="auto-sync"
									checked={!!data?.autoSync}
									disabled={busy}
									onCheckedChange={(auto) =>
										setAuto.mutate({ workspaceId, auto })
									}
								/>
								<Label htmlFor="auto-sync" className="font-normal">
									Keep in sync automatically (every 5 minutes while ADE is open;
									skipped while a task runs in this folder). Pushes your commits
									to GitHub.
								</Label>
							</div>
							<p className="text-xs text-muted-foreground">
								Only committed work is synced; uncommitted changes stay local.
							</p>
						</div>
					) : (
						<div className="space-y-3">
							<Tabs
								value={mode}
								onValueChange={(v) => setMode(v as "existing" | "create")}
							>
								<TabsList>
									<TabsTrigger value="existing">
										Existing GitHub repository
									</TabsTrigger>
									<TabsTrigger value="create">Create on GitHub</TabsTrigger>
								</TabsList>
							</Tabs>
							{mode === "existing" ? (
								<div className="space-y-2">
									<Input
										aria-label="GitHub repository URL"
										placeholder="https://github.com/owner/repo"
										value={url}
										onChange={(e) => setUrl(e.target.value)}
									/>
									{!showRepos ? (
										<Button
											size="sm"
											variant="ghost"
											onClick={() => setShowRepos(true)}
										>
											Choose from my GitHub repositories
										</Button>
									) : github.data && !github.data.available ? (
										<p className="text-xs text-muted-foreground">
											{github.data.reason}
										</p>
									) : (
										<ul className="max-h-[160px] space-y-1 overflow-y-auto">
											{repos.map((repo) => (
												<li key={repo.url}>
													<button
														type="button"
														className="w-full rounded px-2 py-1 text-left text-xs hover:bg-accent/40"
														onClick={() => setUrl(repo.url)}
													>
														{repo.nameWithOwner}
														{repo.isPrivate ? " · private" : ""}
													</button>
												</li>
											))}
										</ul>
									)}
									<p className="text-xs text-muted-foreground">
										The GitHub repository must be empty or have the same history
										as this one; otherwise ADE refuses and changes nothing.
									</p>
									<Button
										disabled={busy || !url.trim()}
										onClick={() =>
											connect.mutate({ workspaceId, url: url.trim() })
										}
									>
										Connect
									</Button>
								</div>
							) : (
								<div className="space-y-2">
									<Input
										aria-label="New GitHub repository name"
										value={name}
										onChange={(e) => setName(e.target.value)}
									/>
									<div className="flex gap-4 text-sm">
										{(["private", "public"] as const).map((v) => (
											<label key={v} className="flex items-center gap-1.5">
												<input
													type="radio"
													name="visibility"
													checked={visibility === v}
													onChange={() => setVisibility(v)}
												/>
												{v === "private" ? "Private" : "Public"}
											</label>
										))}
									</div>
									<p className="text-xs text-muted-foreground">
										Creates the repository on your GitHub account with the gh
										CLI and pushes this branch to it.
										{visibility === "public"
											? " Public: anyone can see the code."
											: ""}
									</p>
									<Button
										disabled={busy || !name.trim()}
										onClick={() =>
											create.mutate({
												workspaceId,
												name: name.trim(),
												visibility,
											})
										}
									>
										Create {visibility} repository and push
									</Button>
								</div>
							)}
						</div>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
}
