import { useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { TeamMigrationDialog } from "../TeamMigrationDialog";

interface TeamRepoLineProps {
	projectId: string;
}

/**
 * Under a team's name: the repository it works in (local path and remote).
 * A team from before teams had one repository says so, and opens the
 * migration choice; nothing changes until the user picks one.
 */
export function TeamRepoLine({ projectId }: TeamRepoLineProps) {
	const [open, setOpen] = useState(false);
	const { data } = electronTrpc.projects.teamRepository.useQuery(
		{ projectId },
		{ staleTime: 60_000, refetchOnWindowFocus: false },
	);
	if (!data) return null;

	const needsChoice = !data.repoPath || data.needsMigration;
	return (
		<>
			<div className="pl-10 pr-2 pb-1 text-[11px] leading-tight" data-team-repo>
				{data.repoPath ? (
					<p
						className="truncate text-muted-foreground"
						title={`${data.repoPath}${data.remote ? `\n${data.remote}` : ""}`}
					>
						{data.remote ?? "local repository"} · {data.repoPath}
					</p>
				) : (
					<p className="text-amber-600">No repository</p>
				)}
				{needsChoice && (
					<button
						type="button"
						onClick={() => setOpen(true)}
						className="text-amber-600 underline underline-offset-2 hover:no-underline"
					>
						{data.repoPath
							? "Some agents use other repositories: review"
							: data.agents.length
								? "Agents have their own repositories: choose how to migrate"
								: "Choose this team's repository"}
					</button>
				)}
			</div>
			{needsChoice && (
				<TeamMigrationDialog status={data} open={open} onOpenChange={setOpen} />
			)}
		</>
	);
}
