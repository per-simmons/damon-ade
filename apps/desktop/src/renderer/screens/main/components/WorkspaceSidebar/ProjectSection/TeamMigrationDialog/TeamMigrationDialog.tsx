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
import { RadioGroup, RadioGroupItem } from "@superset/ui/radio-group";
import { toast } from "@superset/ui/sonner";
import { useState } from "react";
import {
	type ElectronRouterOutputs,
	electronTrpc,
} from "renderer/lib/electron-trpc";

type TeamStatus = ElectronRouterOutputs["projects"]["teamRepository"];

interface TeamMigrationDialogProps {
	status: TeamStatus;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

const SPLIT = "__split__";
const OTHER = "__other__";

/**
 * The migration choice for a team from before one team = one repository.
 * The user sees every agent with its repository and what will happen to
 * it, then confirms. Only team membership changes: no repository, file,
 * customization or task history is moved, combined or deleted.
 */
export function TeamMigrationDialog({
	status,
	open,
	onOpenChange,
}: TeamMigrationDialogProps) {
	const utils = electronTrpc.useUtils();
	const outside = status.agents.filter((agent) => !agent.inTeamRepo);
	const [choice, setChoice] = useState<string>(
		status.repoPath || outside.length === 0
			? SPLIT
			: (outside[0]?.workspaceId ?? SPLIT),
	);
	const [path, setPath] = useState("");
	const selectDirectory = electronTrpc.projects.selectDirectory.useMutation();
	const refresh = async () => {
		await utils.projects.teamRepository.invalidate();
		await utils.workspaces.getAllGrouped.invalidate();
		await utils.projects.getRecents.invalidate();
	};
	const setRepository = electronTrpc.projects.setTeamRepository.useMutation({
		onSuccess: async () => {
			toast.success("The team's repository is set");
			await refresh();
		},
		onError: (err) => toast.error(err.message),
	});
	const migrate = electronTrpc.projects.migrateTeam.useMutation({
		onSuccess: async (result) => {
			const parts = [
				result.repoPath ? `This team now uses ${result.repoPath}.` : "",
				result.createdTeams.length
					? `New teams: ${result.createdTeams.map((t) => t.name).join(", ")}.`
					: "",
				result.movedToExisting.length
					? `Moved to existing teams: ${result.movedToExisting.map((m) => `${m.agent} → ${m.team}`).join(", ")}.`
					: "",
			].filter(Boolean);
			toast.success(parts.join(" ") || "Done");
			onOpenChange(false);
			await refresh();
		},
		onError: (err) => toast.error(err.message),
	});

	// What each agent will become, for the confirmation.
	const teamRepoAgent =
		!status.repoPath && choice !== SPLIT && choice !== OTHER
			? outside.find((a) => a.workspaceId === choice)
			: undefined;
	const sameRepo = (a: { repoRoot: string | null }) =>
		!!teamRepoAgent?.repoRoot &&
		a.repoRoot?.toLowerCase() === teamRepoAgent.repoRoot.toLowerCase();
	const plan = outside.map((agent) => ({
		agent,
		outcome: sameRepo(agent)
			? `stays in "${status.name}", whose repository becomes ${agent.repoRoot}`
			: `moves to a team for ${agent.repoRoot ?? "(folder missing)"} (an existing team for that repository, or a new team named "${agent.name}")`,
	}));

	const busy = migrate.isPending || setRepository.isPending;
	const noAgents = outside.length === 0;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[560px]" data-team-migration>
				<DialogHeader>
					<DialogTitle>One repository for "{status.name}"</DialogTitle>
					<DialogDescription>
						A team now works in exactly one repository, and its agents work in
						worktrees of it.{" "}
						{status.repoPath
							? `This team uses ${status.repoPath}, but some agents work in other repositories.`
							: "This team was created before that, and has no repository of its own."}{" "}
						Nothing changes until you confirm, and no files, repositories or
						task history are moved or deleted.
					</DialogDescription>
				</DialogHeader>

				{outside.length > 0 && (
					<div className="space-y-1.5 text-xs">
						<p className="font-medium">Agents and their repositories</p>
						<ul className="space-y-1">
							{outside.map((agent) => (
								<li key={agent.workspaceId} className="rounded border p-2">
									<span className="font-medium">{agent.name}</span>
									<span className="block break-all text-muted-foreground">
										{agent.repoRoot ?? "folder missing"}
										{agent.remote ? ` · ${agent.remote}` : ""}
									</span>
								</li>
							))}
						</ul>
					</div>
				)}

				{!status.repoPath && (
					<RadioGroup
						value={choice}
						onValueChange={setChoice}
						className="flex flex-col gap-2 text-sm"
					>
						{outside.map((agent) => (
							<div key={agent.workspaceId} className="flex items-start gap-2">
								<RadioGroupItem
									value={agent.workspaceId}
									id={`team-repo-${agent.workspaceId}`}
								/>
								<Label
									htmlFor={`team-repo-${agent.workspaceId}`}
									className="font-normal"
								>
									Use {agent.name}'s repository for this team; other
									repositories get their own teams
								</Label>
							</div>
						))}
						{!noAgents && (
							<div className="flex items-start gap-2">
								<RadioGroupItem value={SPLIT} id="team-repo-split" />
								<Label htmlFor="team-repo-split" className="font-normal">
									Give each repository its own team (this team keeps no agents;
									choose its repository later or close it)
								</Label>
							</div>
						)}
						<div className="flex items-start gap-2">
							<RadioGroupItem value={OTHER} id="team-repo-other" />
							<Label htmlFor="team-repo-other" className="font-normal">
								Choose another repository for this team
								{noAgents ? "" : " (the agents stay as they are for now)"}
							</Label>
						</div>
					</RadioGroup>
				)}

				{choice === OTHER && (
					<div className="flex gap-2">
						<Input
							value={path}
							onChange={(e) => setPath(e.target.value)}
							placeholder="Repository folder"
							aria-label="Repository folder"
						/>
						<Button
							variant="outline"
							onClick={async () => {
								const result = await selectDirectory.mutateAsync({});
								if (!result.canceled && result.path) setPath(result.path);
							}}
						>
							Browse…
						</Button>
					</div>
				)}

				{choice !== OTHER && plan.length > 0 && (
					<div className="space-y-1 text-xs">
						<p className="font-medium">What will happen</p>
						<ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
							{plan.map(({ agent, outcome }) => (
								<li key={agent.workspaceId}>
									{agent.name} {outcome}.
								</li>
							))}
						</ul>
					</div>
				)}

				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Keep it as it is
					</Button>
					{choice === OTHER ? (
						<Button
							disabled={busy || !path.trim()}
							onClick={() =>
								setRepository.mutate({
									projectId: status.projectId,
									path: path.trim(),
								})
							}
						>
							Use this repository
						</Button>
					) : (
						<Button
							disabled={busy || noAgents}
							onClick={() =>
								migrate.mutate({
									projectId: status.projectId,
									teamRepoAgentId:
										status.repoPath || choice === SPLIT ? null : choice,
								})
							}
						>
							Migrate
						</Button>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
