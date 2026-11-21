import { RemoteUpdate } from "../../../RemoteUpdate";
import type { HistoryProjectInfo } from "../../types";

interface RepositoryCardProps {
	workspaceId: string;
	project: HistoryProjectInfo;
}

/**
 * The repository conversations are linked to: this workspace's project,
 * identified by its folder and remote. Another project's history is never
 * shown here, however similar its name.
 */
export function RepositoryCard({ workspaceId, project }: RepositoryCardProps) {
	const worktreeDiffers =
		project.worktreePath.replace(/\\/g, "/").toLowerCase() !==
		project.root.replace(/\\/g, "/").toLowerCase();
	return (
		<div className="space-y-1 rounded-md border p-3 text-xs" data-history-repo>
			<p className="text-sm font-medium">Repository: {project.name}</p>
			<p className="break-all text-muted-foreground">Folder: {project.root}</p>
			<p className="break-all text-muted-foreground">
				{project.remote
					? `Remote: ${project.remote}`
					: project.isGitRepository
						? "No remote: matched by its local repository only"
						: "Not a git repository: sessions match by folder only"}
			</p>
			{worktreeDiffers && (
				<p className="break-all text-muted-foreground">
					This workspace's worktree: {project.worktreePath}
				</p>
			)}
			{project.remote && (
				<RemoteUpdate workspaceId={workspaceId} variant="card" />
			)}
			<p className="text-muted-foreground">
				Conversations are linked to this repository only. To use another
				repository, open it from the sidebar; to connect one from GitHub, use
				New project › Clone.
			</p>
		</div>
	);
}
