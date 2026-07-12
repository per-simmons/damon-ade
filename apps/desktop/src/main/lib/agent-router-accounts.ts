import { classifyFallbackError } from "@superset/shared/agent-router";
import type {
	RouterProviderAccount,
	RouterProviderAccountAuthType,
	RouterProviderKeyId,
} from "@superset/shared/router-control-plane";
import {
	createRouterProviderAccountMetadata,
	deleteRouterProviderAccountMetadata,
	getRouterProviderAccounts,
	recordRouterProviderAccountFailure,
	recordRouterProviderAccountSuccess,
	selectRouterProviderAccounts,
	updateRouterProviderAccountMetadata,
} from "./agent-router-store";
import {
	clearProviderAccountKey,
	clearProviderAccountSecret,
	getProviderAccountKey,
	getProviderAccountSecret,
	getProviderKey,
	hasProviderAccountKey,
	hasProviderAccountSecret,
	setProviderAccountKey,
	setProviderAccountSecret,
} from "./provider-keys";

export interface RouterProviderCredential {
	id: string;
	name: string;
	provider: RouterProviderKeyId;
	authType: RouterProviderAccountAuthType;
	key: string;
	refreshToken: string | null;
	idToken: string | null;
	expiresAt: string | null;
	providerSpecificData: Record<string, unknown>;
	legacy: boolean;
}

export interface RouterProviderAccountView extends RouterProviderAccount {
	hasKey: boolean;
	hasRefreshToken: boolean;
	hasIdToken: boolean;
}

export function listRouterProviderAccountViews(
	provider?: RouterProviderKeyId,
): RouterProviderAccountView[] {
	return getRouterProviderAccounts(provider).map((account) => ({
		...account,
		hasKey: hasProviderAccountKey(account.provider, account.id),
		hasRefreshToken: hasProviderAccountSecret(
			account.provider,
			account.id,
			"refresh",
		),
		hasIdToken: hasProviderAccountSecret(account.provider, account.id, "id"),
	}));
}

export function createRouterProviderAccount({
	authType,
	email,
	expiresAt,
	idToken,
	key,
	name,
	provider,
	providerSpecificData,
	refreshToken,
}: {
	authType?: RouterProviderAccountAuthType;
	email?: string | null;
	expiresAt?: string | null;
	idToken?: string | null;
	key: string;
	name?: string;
	provider: RouterProviderKeyId;
	providerSpecificData?: Record<string, unknown>;
	refreshToken?: string | null;
}): RouterProviderAccountView[] {
	const account = createRouterProviderAccountMetadata({
		authType,
		email,
		expiresAt,
		name,
		provider,
		providerSpecificData,
	});
	try {
		setProviderAccountKey(provider, account.id, key);
		if (refreshToken?.trim()) {
			setProviderAccountSecret(provider, account.id, "refresh", refreshToken);
		}
		if (idToken?.trim()) {
			setProviderAccountSecret(provider, account.id, "id", idToken);
		}
	} catch (error) {
		clearProviderAccountKey(provider, account.id);
		deleteRouterProviderAccountMetadata(account.id);
		throw error;
	}
	return listRouterProviderAccountViews(provider);
}

export function updateRouterProviderAccount({
	id,
	authType,
	email,
	expiresAt,
	idToken,
	isActive,
	key,
	name,
	priority,
	providerSpecificData,
	refreshToken,
}: {
	id: string;
	authType?: RouterProviderAccountAuthType;
	email?: string | null;
	expiresAt?: string | null;
	idToken?: string | null;
	isActive?: boolean;
	key?: string;
	name?: string;
	priority?: number;
	providerSpecificData?: Record<string, unknown>;
	refreshToken?: string | null;
}): RouterProviderAccountView[] {
	const account = getRouterProviderAccounts().find(
		(candidate) => candidate.id === id,
	);
	if (!account) throw new Error("Provider account not found");

	if (key?.trim()) {
		setProviderAccountKey(account.provider, account.id, key);
	}
	if (refreshToken !== undefined) {
		if (refreshToken?.trim()) {
			setProviderAccountSecret(
				account.provider,
				account.id,
				"refresh",
				refreshToken,
			);
		} else {
			clearProviderAccountSecret(account.provider, account.id, "refresh");
		}
	}
	if (idToken !== undefined) {
		if (idToken?.trim()) {
			setProviderAccountSecret(account.provider, account.id, "id", idToken);
		} else {
			clearProviderAccountSecret(account.provider, account.id, "id");
		}
	}

	updateRouterProviderAccountMetadata(id, {
		authType,
		email,
		expiresAt,
		isActive,
		name,
		priority,
		providerSpecificData,
	});
	return listRouterProviderAccountViews(account.provider);
}

export function deleteRouterProviderAccount(
	id: string,
): RouterProviderAccountView[] {
	const account = getRouterProviderAccounts().find(
		(candidate) => candidate.id === id,
	);
	if (!account) return listRouterProviderAccountViews();
	clearProviderAccountKey(account.provider, account.id);
	deleteRouterProviderAccountMetadata(id);
	return listRouterProviderAccountViews(account.provider);
}

export function getProviderAccountCredentials(
	provider: RouterProviderKeyId,
): RouterProviderCredential[] {
	const credentials: RouterProviderCredential[] = [];
	for (const account of selectRouterProviderAccounts(provider)) {
		const key = getProviderAccountKey(provider, account.id);
		if (!key) continue;
		credentials.push({
			id: account.id,
			name: account.name,
			provider,
			authType: account.authType,
			key,
			refreshToken: getProviderAccountSecret(provider, account.id, "refresh"),
			idToken: getProviderAccountSecret(provider, account.id, "id"),
			expiresAt: account.expiresAt ?? null,
			providerSpecificData: account.providerSpecificData ?? {},
			legacy: false,
		});
	}

	if (credentials.length > 0) return credentials;

	const legacyKey = getProviderKey(provider);
	return legacyKey
		? [
				{
					id: provider,
					name: "Default key",
					provider,
					authType: "api-key",
					key: legacyKey,
					refreshToken: null,
					idToken: null,
					expiresAt: null,
					providerSpecificData: {},
					legacy: true,
				},
			]
		: [];
}

export function getProviderAccountCredentialById(
	provider: RouterProviderKeyId,
	accountId: string,
): RouterProviderCredential | null {
	const account = getRouterProviderAccounts(provider).find(
		(candidate) => candidate.id === accountId,
	);
	if (!account) return null;
	const key = getProviderAccountKey(provider, account.id);
	if (!key) return null;
	return {
		id: account.id,
		name: account.name,
		provider,
		authType: account.authType,
		key,
		refreshToken: getProviderAccountSecret(provider, account.id, "refresh"),
		idToken: getProviderAccountSecret(provider, account.id, "id"),
		expiresAt: account.expiresAt ?? null,
		providerSpecificData: account.providerSpecificData ?? {},
		legacy: false,
	};
}

export function markProviderAccountSuccess(
	credential: RouterProviderCredential,
): void {
	if (credential.legacy) return;
	recordRouterProviderAccountSuccess(credential.id);
}

export function markProviderAccountFailure({
	credential,
	status,
	text,
}: {
	credential: RouterProviderCredential;
	status?: number;
	text?: string;
}): void {
	if (credential.legacy) return;
	const account = getRouterProviderAccounts().find(
		(candidate) => candidate.id === credential.id,
	);
	const decision = classifyFallbackError({
		status,
		text,
		backoffLevel: account?.backoffLevel ?? 0,
	});
	recordRouterProviderAccountFailure({
		backoffLevel: decision.backoffLevel,
		cooldownMs: decision.cooldownMs,
		id: credential.id,
		message: text || `HTTP ${status ?? "unknown"}`,
		status,
	});
}
