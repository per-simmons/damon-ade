/**
 * Cross-Mac workspace identity layer.
 *
 * Local workspace UUIDs are random per-Mac (see packages/local-db schema:
 * `workspaces.id` uses uuidv4). For cross-Mac sync of `app-state.json` we
 * need a stable, deterministic identifier so a tab referring to "the foo
 * project / main branch / worktree" resolves to the same workspace on
 * either machine.
 *
 * The canonical identifier is `sha256(mainRepoPath + ":" + branch + ":" + type)`.
 * On peer-state hydrate we resolve canonical -> local UUID via the workspaces
 * table; if the workspace doesn't exist yet locally and we have embedded
 * metadata, we can opt-in auto-create the local row.
 *
 * `local.db` itself is NEVER synced across Macs — only this hash bridges.
 */

import { createHash } from "node:crypto";
import type { WorkspaceType } from "@superset/local-db";
import { projects, type SelectWorkspace, workspaces } from "@superset/local-db";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";

export interface WorkspaceIdentityInput {
	mainRepoPath: string;
	branch: string;
	type: string;
}

export interface EmbeddedWorkspaceMeta extends WorkspaceIdentityInput {}

export interface ResolveLocalWorkspaceIdOptions {
	autoCreate?: boolean;
}

/**
 * Canonical cross-Mac workspace identifier.
 * Deterministic from project mainRepoPath + branch + type.
 */
export function canonicalizeWorkspace(input: WorkspaceIdentityInput): string {
	const payload = `${input.mainRepoPath}:${input.branch}:${input.type}`;
	return createHash("sha256").update(payload).digest("hex");
}

/**
 * Resolve a canonical workspace hash to a local workspaces.id UUID.
 *
 * Returns null if no matching local workspace exists and either
 *  - no embeddedMeta was supplied, or
 *  - options.autoCreate !== true.
 *
 * When autoCreate is true and embeddedMeta is provided, a workspaces row
 * (and project if necessary — but we don't fabricate projects here; we
 * require the project to exist) will be inserted using the embedded
 * metadata, and the new local UUID returned.
 *
 * NOTE: We intentionally do NOT create projects on the fly. If the peer
 * Mac references a project the local Mac doesn't know about, the resolve
 * fails and the caller decides how to handle it (typically: hide the tab
 * until the user opens that project locally once).
 */
export function resolveLocalWorkspaceId(
	canonical: string,
	embeddedMeta?: EmbeddedWorkspaceMeta,
	options?: ResolveLocalWorkspaceIdOptions,
): string | null {
	// Fast path: scan local workspaces, recomputing each canonical hash.
	// For ADE's scale (dozens of workspaces) this is fine; switching
	// to a precomputed index is a future micro-optimization.
	const local = findLocalWorkspaceByCanonical(canonical);
	if (local) return local.id;

	if (!embeddedMeta || !options?.autoCreate) return null;

	// Auto-create path: require an existing project with the matching
	// mainRepoPath. If none, bail — we do not invent projects.
	const matchingProject = localDb
		.select()
		.from(projects)
		.where(eq(projects.mainRepoPath, embeddedMeta.mainRepoPath))
		.get();

	if (!matchingProject) return null;

	const type = embeddedMeta.type as WorkspaceType;

	// Compute next tabOrder for the project.
	const siblingWorkspaces = localDb
		.select()
		.from(workspaces)
		.where(eq(workspaces.projectId, matchingProject.id))
		.all();
	const maxTabOrder = siblingWorkspaces.reduce(
		(max, w) => (w.tabOrder > max ? w.tabOrder : max),
		-1,
	);

	const inserted = localDb
		.insert(workspaces)
		.values({
			projectId: matchingProject.id,
			branch: embeddedMeta.branch,
			type,
			name: embeddedMeta.branch,
			tabOrder: maxTabOrder + 1,
			isUnnamed: true,
		})
		.returning()
		.get();

	return inserted?.id ?? null;
}

function findLocalWorkspaceByCanonical(
	canonical: string,
): SelectWorkspace | null {
	const all = localDb.select().from(workspaces).all();
	for (const ws of all) {
		const project = localDb
			.select()
			.from(projects)
			.where(eq(projects.id, ws.projectId))
			.get();
		if (!project) continue;
		const hash = canonicalizeWorkspace({
			mainRepoPath: project.mainRepoPath,
			branch: ws.branch,
			type: ws.type,
		});
		if (hash === canonical) return ws;
	}
	return null;
}

/**
 * Look up a local workspace's canonical hash + embedded metadata,
 * given its local UUID. Used at write-time to stamp the sync envelope.
 */
export function getCanonicalForLocalWorkspaceId(
	localWorkspaceId: string,
): { canonical: string; meta: EmbeddedWorkspaceMeta } | null {
	const ws = localDb
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, localWorkspaceId))
		.get();
	if (!ws) return null;
	const project = localDb
		.select()
		.from(projects)
		.where(eq(projects.id, ws.projectId))
		.get();
	if (!project) return null;
	const meta: EmbeddedWorkspaceMeta = {
		mainRepoPath: project.mainRepoPath,
		branch: ws.branch,
		type: ws.type,
	};
	return { canonical: canonicalizeWorkspace(meta), meta };
}
