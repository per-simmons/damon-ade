/**
 * Local build: Local collections replacing Electric SQL cloud sync.
 *
 * Uses @tanstack/react-db createCollection with a writable sync that
 * exposes begin/write/commit so CodeQueueProvider can push data through
 * the sync layer (persistent) instead of the optimistic layer (transient).
 */
import type {
	SelectAgentCommand,
	SelectChatSession,
	SelectDevicePresence,
	SelectIntegrationConnection,
	SelectInvitation,
	SelectMember,
	SelectOrganization,
	SelectProject,
	SelectSessionHost,
	SelectSubscription,
	SelectTask,
	SelectTaskStatus,
	SelectUser,
	SelectWorkspace,
} from "@superset/db/schema";
import type { Collection } from "@tanstack/react-db";
import { createCollection } from "@tanstack/react-db";
import { z } from "zod";

const apiKeyDisplaySchema = z.object({
	id: z.string(),
	name: z.string().nullable(),
	start: z.string().nullable(),
	createdAt: z.coerce.date(),
	lastRequest: z.coerce.date().nullable(),
});

type ApiKeyDisplay = z.infer<typeof apiKeyDisplaySchema>;

type IntegrationConnectionDisplay = Omit<
	SelectIntegrationConnection,
	"accessToken" | "refreshToken"
>;

interface OrgCollections {
	tasks: Collection<SelectTask>;
	taskStatuses: Collection<SelectTaskStatus>;
	projects: Collection<SelectProject>;
	workspaces: Collection<SelectWorkspace>;
	members: Collection<SelectMember>;
	users: Collection<SelectUser>;
	invitations: Collection<SelectInvitation>;
	agentCommands: Collection<SelectAgentCommand>;
	devicePresence: Collection<SelectDevicePresence>;
	integrationConnections: Collection<IntegrationConnectionDisplay>;
	subscriptions: Collection<SelectSubscription>;
	apiKeys: Collection<ApiKeyDisplay>;
	chatSessions: Collection<SelectChatSession>;
	sessionHosts: Collection<SelectSessionHost>;
}

// Per-org collections cache
const collectionsCache = new Map<string, OrgCollections>();

// --- Writable sync: captures begin/write/commit for external use ---

export interface SyncWriter {
	begin: () => void;
	write: (op: {
		type: "insert" | "update" | "delete";
		key?: string;
		value: any;
	}) => void;
	commit: () => void;
	truncate: () => void;
}

// Global registry of sync writers by collection id
const syncWriters = new Map<string, SyncWriter>();

export function getSyncWriter(collectionId: string): SyncWriter | undefined {
	return syncWriters.get(collectionId);
}

function writableSync(collectionId: string) {
	return {
		sync: ({ markReady, begin, write, commit, truncate }: any) => {
			// Capture the sync callbacks for external use
			syncWriters.set(collectionId, { begin, write, commit, truncate });
			// Mark collection as ready immediately
			markReady();
			return {
				cleanup: () => {
					syncWriters.delete(collectionId);
				},
			};
		},
	};
}

// Helper: create a local-only collection with writable sync
function createLocalCollection<T extends Record<string, unknown>>(
	id: string,
): Collection<T> {
	return createCollection<T>({
		id,
		getKey: (item: T) => (item as unknown as { id: string }).id,
		sync: writableSync(id),
		// Keep onInsert/onUpdate/onDelete for any direct mutation calls
		onInsert: async () => {},
		onUpdate: async () => {},
		onDelete: async () => {},
	} as any);
}

const organizationsCollection =
	createLocalCollection<SelectOrganization>("organizations");

function createOrgCollections(_organizationId: string): OrgCollections {
	const prefix = _organizationId;

	return {
		tasks: createLocalCollection<SelectTask>(`tasks-${prefix}`),
		taskStatuses: createLocalCollection<SelectTaskStatus>(
			`task_statuses-${prefix}`,
		),
		projects: createLocalCollection<SelectProject>(`projects-${prefix}`),
		workspaces: createLocalCollection<SelectWorkspace>(`workspaces-${prefix}`),
		members: createLocalCollection<SelectMember>(`members-${prefix}`),
		users: createLocalCollection<SelectUser>(`users-${prefix}`),
		invitations: createLocalCollection<SelectInvitation>(
			`invitations-${prefix}`,
		),
		agentCommands: createLocalCollection<SelectAgentCommand>(
			`agent_commands-${prefix}`,
		),
		devicePresence: createLocalCollection<SelectDevicePresence>(
			`device_presence-${prefix}`,
		),
		integrationConnections: createLocalCollection<IntegrationConnectionDisplay>(
			`integration_connections-${prefix}`,
		),
		subscriptions: createLocalCollection<SelectSubscription>(
			`subscriptions-${prefix}`,
		),
		apiKeys: createLocalCollection<ApiKeyDisplay>(`apikeys-${prefix}`),
		chatSessions: createLocalCollection<SelectChatSession>(
			`chat_sessions-${prefix}`,
		),
		sessionHosts: createLocalCollection<SelectSessionHost>(
			`session_hosts-${prefix}`,
		),
	};
}

/**
 * Preload collections - no-op in Local build (no Electric SQL).
 */
export async function preloadCollections(
	_organizationId: string,
	_options?: {
		includeChatCollections?: boolean;
	},
): Promise<void> {
	// No-op: no Electric SQL sync to wait for
}

/**
 * Get collections for an organization, creating them if needed.
 */
export function getCollections(organizationId: string) {
	if (!collectionsCache.has(organizationId)) {
		collectionsCache.set(organizationId, createOrgCollections(organizationId));
	}

	const orgCollections = collectionsCache.get(organizationId);
	if (!orgCollections) {
		throw new Error(`Collections not found for org: ${organizationId}`);
	}

	return {
		...orgCollections,
		organizations: organizationsCollection,
	};
}
