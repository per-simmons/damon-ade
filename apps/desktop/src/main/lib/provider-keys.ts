import { settings } from "@superset/local-db";
import {
	ROUTER_PROVIDER_KEY_IDS,
	type RouterProviderKeyId,
} from "@superset/shared/router-control-plane";
import { safeStorage } from "electron";
import { localDb } from "./local-db";

/**
 * Local-first, single-user storage for provider API keys.
 *
 * Keys are encrypted with electron's safeStorage (OS keychain-backed) and the
 * resulting blob is persisted, base64-encoded, in the local sqlite settings row
 * (settings.providerApiKeys, keyed by provider id). Plaintext keys never touch
 * disk and are only ever decrypted in the main process — never returned to the
 * renderer. Injected into agent terminals via OPENROUTER_API_KEY (see
 * buildTerminalEnv), so the OpenRouter-routed runtimes (kimi/minimax/glm) work
 * without relying on the user's shell rc.
 */

export const PROVIDER_IDS = ROUTER_PROVIDER_KEY_IDS;
export type ProviderId = RouterProviderKeyId;

export function getProviderAccountKeyId(
	provider: ProviderId,
	accountId: string,
): string {
	return `${provider}::${accountId}`;
}

export function getProviderAccountSecretId(
	provider: ProviderId,
	accountId: string,
	secret: string,
): string {
	return `${provider}::${accountId}::${secret}`;
}

function readKeyMap(): Record<string, string> {
	const row = localDb.select().from(settings).get();
	return (row?.providerApiKeys ?? {}) as Record<string, string>;
}

function writeKeyMap(map: Record<string, string>): void {
	localDb
		.insert(settings)
		.values({ id: 1, providerApiKeys: map })
		.onConflictDoUpdate({
			target: settings.id,
			set: { providerApiKeys: map },
		})
		.run();
}

/** Encrypt and persist a provider key. Throws if the key is blank or storage is unavailable. */
export function setProviderKey(provider: ProviderId, key: string): void {
	const trimmed = key.trim();
	if (!trimmed) {
		throw new Error("Provider API key must not be empty");
	}
	if (!safeStorage.isEncryptionAvailable()) {
		throw new Error("Secure storage is not available on this system");
	}

	const encrypted = safeStorage.encryptString(trimmed).toString("base64");
	const map = readKeyMap();
	map[provider] = encrypted;
	writeKeyMap(map);
}

/** Remove a stored provider key, if present. */
export function clearProviderKey(provider: ProviderId): void {
	const map = readKeyMap();
	if (provider in map) {
		delete map[provider];
		writeKeyMap(map);
	}
}

/** Whether a key is stored for the provider (does not decrypt). */
export function hasProviderKey(provider: ProviderId): boolean {
	const map = readKeyMap();
	return (
		Boolean(map[provider]) ||
		Object.keys(map).some((key) => key.startsWith(`${provider}::`))
	);
}

/**
 * Decrypt and return the stored provider key, or null if none is stored or
 * decryption is unavailable/fails. Main-process only — never send this to the renderer.
 */
export function getProviderKey(provider: ProviderId): string | null {
	return decryptKeyBlob(readKeyMap()[provider]);
}

export function setProviderAccountKey(
	provider: ProviderId,
	accountId: string,
	key: string,
): void {
	setProviderAccountSecret(provider, accountId, "key", key);
}

export function clearProviderAccountKey(
	provider: ProviderId,
	accountId: string,
): void {
	const map = readKeyMap();
	const legacyKey = getProviderAccountKeyId(provider, accountId);
	const secretPrefix = `${legacyKey}::`;
	let changed = false;
	for (const key of Object.keys(map)) {
		if (key === legacyKey || key.startsWith(secretPrefix)) {
			delete map[key];
			changed = true;
		}
	}
	if (changed) writeKeyMap(map);
}

export function getProviderAccountKey(
	provider: ProviderId,
	accountId: string,
): string | null {
	return (
		getProviderAccountSecret(provider, accountId, "key") ??
		decryptKeyBlob(readKeyMap()[getProviderAccountKeyId(provider, accountId)])
	);
}

export function hasProviderAccountKey(
	provider: ProviderId,
	accountId: string,
): boolean {
	const map = readKeyMap();
	return Boolean(
		map[getProviderAccountKeyId(provider, accountId)] ||
			map[getProviderAccountSecretId(provider, accountId, "key")],
	);
}

export function setProviderAccountSecret(
	provider: ProviderId,
	accountId: string,
	secret: string,
	value: string,
): void {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error("Provider account secret must not be empty");
	}
	if (!safeStorage.isEncryptionAvailable()) {
		throw new Error("Secure storage is not available on this system");
	}

	const encrypted = safeStorage.encryptString(trimmed).toString("base64");
	const map = readKeyMap();
	map[getProviderAccountSecretId(provider, accountId, secret)] = encrypted;
	writeKeyMap(map);
}

export function clearProviderAccountSecret(
	provider: ProviderId,
	accountId: string,
	secret: string,
): void {
	const map = readKeyMap();
	const key = getProviderAccountSecretId(provider, accountId, secret);
	if (key in map) {
		delete map[key];
		writeKeyMap(map);
	}
}

export function getProviderAccountSecret(
	provider: ProviderId,
	accountId: string,
	secret: string,
): string | null {
	return decryptKeyBlob(
		readKeyMap()[getProviderAccountSecretId(provider, accountId, secret)],
	);
}

export function hasProviderAccountSecret(
	provider: ProviderId,
	accountId: string,
	secret: string,
): boolean {
	return Boolean(
		readKeyMap()[getProviderAccountSecretId(provider, accountId, secret)],
	);
}

function decryptKeyBlob(blob: string | undefined): string | null {
	if (!blob) return null;
	if (!safeStorage.isEncryptionAvailable()) return null;

	try {
		return safeStorage.decryptString(Buffer.from(blob, "base64"));
	} catch {
		return null;
	}
}

/** Presence-only status for every known provider (safe to return to the renderer). */
export function getProviderKeyStatus(): Record<ProviderId, boolean> {
	return Object.fromEntries(
		PROVIDER_IDS.map((id) => [id, hasProviderKey(id)]),
	) as Record<ProviderId, boolean>;
}
