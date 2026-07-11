/**
 * Local build: Mock auth client — no cloud auth.
 *
 * Provides the same API surface as better-auth/react's createAuthClient
 * but returns static mock data. No network requests are made.
 */
import { useMemo } from "react";
import { MOCK_ORG_ID } from "shared/constants";

const MOCK_USER_ID = "local-user";

const mockSession = {
	user: {
		id: MOCK_USER_ID,
		name: "Local User",
		email: "user@localhost",
		image: null,
		createdAt: new Date("2024-01-01"),
		updatedAt: new Date("2024-01-01"),
		emailVerified: true,
	},
	session: {
		id: "mock-session",
		userId: MOCK_USER_ID,
		expiresAt: new Date("2099-12-31"),
		token: "mock-token",
		// better-auth stores the active org on the session; keep it here so
		// callers reading session.session.activeOrganizationId resolve.
		activeOrganizationId: MOCK_ORG_ID,
	},
	activeOrganizationId: MOCK_ORG_ID,
};

let authToken: string | null = "mock-token";

export function setAuthToken(token: string | null) {
	authToken = token;
}

export function getAuthToken(): string | null {
	return authToken;
}

/**
 * Mock auth client matching better-auth's createAuthClient API surface.
 */
export const authClient = {
	useSession: () => {
		// Must be a real hook (call useMemo) so React hook count matches
		const data = useMemo(() => mockSession, []);
		return {
			data,
			isPending: false,
			error: null,
			refetch: async () => mockSession,
		};
	},
	signOut: async (_opts?: any) => {},
	signIn: {
		social: async (_opts: any) => ({ data: mockSession, error: null }),
	},
	organization: {
		getFullOrganization: async () => ({
			data: {
				id: MOCK_ORG_ID,
				name: "ADE",
				slug: "ade",
				members: [
					{
						id: MOCK_USER_ID,
						userId: MOCK_USER_ID,
						role: "owner",
						user: mockSession.user,
					},
				],
			},
			error: null,
		}),
		setActive: async (_opts: any) => ({ data: null, error: null }),
		create: async (_opts: any) => ({ data: null, error: null }),
	},
	subscription: {
		list: async () => ({ data: [], error: null }),
	},
	apiKey: {
		list: async () => ({ data: [], error: null }),
		create: async (_opts?: any) => ({ data: null, error: null }),
		delete: async (_opts?: any) => ({ data: null, error: null }),
	},
};
