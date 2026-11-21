import { basename } from "node:path";
import { projects, workspaces, worktrees } from "@superset/local-db";
import { and, eq, isNull } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import {
	pathKey,
	type RepoIdentity,
	repoIdentity,
} from "main/lib/project-history";
import { getWorkspacePath } from "../../workspaces/utils/worktree";

/**
 * One team = one repository. A team (a `projects` row) has its repository in
 * mainRepoPath; its agents work in worktrees of that repository.
 *
 * Teams created before this rule are "categories" with no repository
 * (mainRepoPath ""), whose agents each own a repository of their own; or
 * repository teams whose agents were given separate repositories. Nothing
 * about them changes until the user picks a migration here: no data is moved,
 * combined or deleted on disk, only the rows that say which team an agent
 * belongs to.
 */

export interface TeamAgent {
	workspaceId: string;
	name: string;
	/** The agent's working folder. */
	folder: string | null;
	/** The top of the repository the folder belongs to. */
	repoRoot: string | null;
	remote: string | null;
	/** It works in the team's own repository (or a worktree of it). */
	inTeamRepo: boolean;
}

export interface TeamRepositoryStatus {
	projectId: string;
	name: string;
	/** The team's repository, or null for a team created before teams had one. */
	repoPath: string | null;
	remote: string | null;
	defaultBranch: string | null;
	agents: TeamAgent[];
	/** Agents whose work lives in another repository than the team's. */
	needsMigration: boolean;
}

function identityOf(
	folder: string | null,
	cache: Map<string, RepoIdentity>,
): RepoIdentity | null {
	if (!folder) return null;
	const key = pathKey(folder);
	let identity = cache.get(key);
	if (!identity) {
		identity = repoIdentity(folder);
		cache.set(key, identity);
	}
	return identity;
}

export function teamRepositoryStatus(projectId: string): TeamRepositoryStatus {
	const project = localDb
		.select()
		.from(projects)
		.where(eq(projects.id, projectId))
		.get();
	if (!project) throw new Error("Team not found");
	const cache = new Map<string, RepoIdentity>();
	const teamIdentity = project.mainRepoPath
		? identityOf(project.mainRepoPath, cache)
		: null;
	const rows = localDb
		.select()
		.from(workspaces)
		.where(
			and(eq(workspaces.projectId, projectId), isNull(workspaces.deletingAt)),
		)
		.all();
	const agents: TeamAgent[] = rows.map((workspace) => {
		const folder = getWorkspacePath(workspace);
		const identity = identityOf(folder, cache);
		const inTeamRepo =
			workspace.type === "branch" ||
			(!!teamIdentity?.commonDir &&
				identity?.commonDir === teamIdentity.commonDir);
		return {
			workspaceId: workspace.id,
			name: workspace.name,
			folder,
			repoRoot: identity?.toplevel ?? null,
			remote: identity?.remote ?? null,
			inTeamRepo,
		};
	});
	return {
		projectId,
		name: project.name,
		repoPath: project.mainRepoPath || null,
		remote: teamIdentity?.remote ?? null,
		defaultBranch: project.defaultBranch ?? null,
		agents,
		needsMigration: agents.some((agent) => !agent.inTeamRepo),
	};
}

/** The team that already uses this repository, if any. */
export function teamForRepository(repoRoot: string) {
	const key = pathKey(repoRoot);
	return localDb
		.select()
		.from(projects)
		.all()
		.find((p) => p.mainRepoPath && pathKey(p.mainRepoPath) === key);
}

function nextTabOrder(): number {
	return (
		localDb
			.select({ tabOrder: projects.tabOrder })
			.from(projects)
			.all()
			.reduce((max, p) => Math.max(max, p.tabOrder ?? -1), -1) + 1
	);
}

/**
 * Make an agent whose folder IS a repository's top the team's main ("branch")
 * workspace. A "worktree" workspace's folder is deleted with it; the main
 * workspace's folder never is, so deleting the agent later cannot delete the
 * team's repository. Its id, name, runtime, icon and memory are kept.
 */
function becomeMainWorkspace(workspaceId: string, projectId: string): void {
	const workspace = localDb
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.get();
	if (!workspace) return;
	const worktreeId = workspace.worktreeId;
	localDb
		.update(workspaces)
		.set({ projectId, type: "branch", worktreeId: null, updatedAt: Date.now() })
		.where(eq(workspaces.id, workspaceId))
		.run();
	if (worktreeId) {
		localDb.delete(worktrees).where(eq(worktrees.id, worktreeId)).run();
	}
}

function moveAgent(workspaceId: string, projectId: string): void {
	const workspace = localDb
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.get();
	if (!workspace) return;
	localDb
		.update(workspaces)
		.set({ projectId, updatedAt: Date.now() })
		.where(eq(workspaces.id, workspaceId))
		.run();
	if (workspace.worktreeId) {
		localDb
			.update(worktrees)
			.set({ projectId })
			.where(eq(worktrees.id, workspace.worktreeId))
			.run();
	}
}

function hasMainWorkspace(projectId: string): boolean {
	return !!localDb
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(
			and(eq(workspaces.projectId, projectId), eq(workspaces.type, "branch")),
		)
		.get();
}

export interface MigrationResult {
	/** The team's repository after the migration. */
	repoPath: string | null;
	/** Teams created for agents with other repositories. */
	createdTeams: Array<{ id: string; name: string; repoPath: string }>;
	/** Agents moved into teams that already used their repository. */
	movedToExisting: Array<{ agent: string; team: string }>;
}

/**
 * Give every agent of an old team a team whose repository is its own.
 * - `teamRepoAgentId` (only for a team without a repository): that agent's
 *   repository becomes this team's repository.
 * - Every other repository gets its own team (or the existing team that
 *   already uses it), named after the agent, and its agents move there.
 * Files on disk are not touched; task history follows, because ADE keys it
 * by the repository's folder.
 */
export function migrateTeam(
	projectId: string,
	teamRepoAgentId: string | null,
): MigrationResult {
	const status = teamRepositoryStatus(projectId);
	const project = localDb
		.select()
		.from(projects)
		.where(eq(projects.id, projectId))
		.get();
	if (!project) throw new Error("Team not found");
	const result: MigrationResult = {
		repoPath: status.repoPath,
		createdTeams: [],
		movedToExisting: [],
	};
	const outside = status.agents.filter((agent) => !agent.inTeamRepo);
	if (outside.some((agent) => !agent.repoRoot)) {
		const missing = outside.filter((agent) => !agent.repoRoot);
		throw new Error(
			`These agents' folders are missing or not git repositories, so ADE cannot tell which repository they belong to: ${missing.map((a) => a.name).join(", ")}. Nothing was changed.`,
		);
	}

	// Group the agents by repository.
	const groups = new Map<string, TeamAgent[]>();
	for (const agent of outside) {
		const key = pathKey(agent.repoRoot as string);
		groups.set(key, [...(groups.get(key) ?? []), agent]);
	}

	// Check everything before changing anything.
	if (!status.repoPath && teamRepoAgentId) {
		const chosen = outside.find((a) => a.workspaceId === teamRepoAgentId);
		if (!chosen?.repoRoot) throw new Error("Choose one of this team's agents");
		const other = teamForRepository(chosen.repoRoot);
		if (other) {
			throw new Error(
				`Team "${other.name}" already uses ${chosen.repoRoot}. Choose another agent's repository, or give every agent its own team.`,
			);
		}
	}
	for (const [key, agents] of groups) {
		const existing = teamForRepository(agents[0].repoRoot as string);
		const sameFolder = agents.find(
			(agent) => agent.folder && pathKey(agent.folder) === key,
		);
		if (existing && sameFolder && hasMainWorkspace(existing.id)) {
			throw new Error(
				`Agent "${sameFolder.name}" works directly in ${sameFolder.folder}, which is also team "${existing.name}"'s checkout. Two workspaces in one folder would edit the same files, so nothing was changed. Remove one of them first, or keep this team as it is.`,
			);
		}
	}

	if (!status.repoPath && teamRepoAgentId) {
		const chosen = outside.find(
			(a) => a.workspaceId === teamRepoAgentId,
		) as TeamAgent & { repoRoot: string };
		localDb
			.update(projects)
			.set({ mainRepoPath: chosen.repoRoot, lastOpenedAt: Date.now() })
			.where(eq(projects.id, projectId))
			.run();
		const key = pathKey(chosen.repoRoot);
		for (const agent of groups.get(key) ?? []) {
			if (
				agent.folder &&
				pathKey(agent.folder) === key &&
				!hasMainWorkspace(projectId)
			) {
				becomeMainWorkspace(agent.workspaceId, projectId);
			}
		}
		groups.delete(key);
		result.repoPath = chosen.repoRoot;
	}

	for (const [key, agents] of groups) {
		const repoRoot = agents[0].repoRoot as string;
		const existing = teamForRepository(repoRoot);
		let targetId: string;
		if (existing) {
			targetId = existing.id;
			for (const agent of agents) {
				result.movedToExisting.push({ agent: agent.name, team: existing.name });
			}
		} else {
			const name =
				agents.length === 1
					? agents[0].name
					: basename(repoRoot) || project.name;
			const created = localDb
				.insert(projects)
				.values({
					mainRepoPath: repoRoot,
					name,
					color: project.color,
					tabOrder: nextTabOrder(),
				})
				.returning()
				.get();
			targetId = created.id;
			result.createdTeams.push({ id: created.id, name, repoPath: repoRoot });
		}
		for (const agent of agents) {
			if (
				agent.folder &&
				pathKey(agent.folder) === key &&
				!hasMainWorkspace(targetId)
			) {
				becomeMainWorkspace(agent.workspaceId, targetId);
			} else {
				moveAgent(agent.workspaceId, targetId);
			}
		}
	}
	return result;
}
